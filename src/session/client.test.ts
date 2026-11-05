/**
 * Client behavior tests against a mocked fetch: happy paths, error mapping,
 * ticket handling, and log redaction. No live rails, ever.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZecSendHandoffRefusedError } from "../protocol/errors.js";
import { createRampClient, type RampClientConfig } from "./client.js";

const SESSION_RESPONSE = {
  sessionUrl: "https://0xramp.app/partner/zingo?sessionRef=sessGOLDEN00000001",
  sessionRef: "sessGOLDEN00000001",
  statusTicket: "v1.GOLDENFIXTUREwJk9mQ2sTvX7bN4rLp",
  expiresAt: "2026-09-21T12:00:00Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeConfig(fetchMock: ReturnType<typeof vi.fn>, overrides: Partial<RampClientConfig> = {}): RampClientConfig {
  return {
    environment: "production",
    partnerId: "zingo",
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("verifyZecSendHandoff (the wallet's check before its confirmation sheet)", () => {
  const ref = SESSION_RESPONSE.sessionRef;
  const request = { requestId: "reqGOLDEN00000001", address: "t1FakeAddrForFixtures9zqqqqqqqqqqqqq", amountZat: "5000000" };
  const link = `zingo://0xramp?sessionRef=${ref}&requestId=${request.requestId}&address=${request.address}&amountZat=${request.amountZat}`;
  const deadline = "2099-01-01T00:00:00Z";
  async function client(record: unknown, status = 200) {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST" ? jsonResponse(201, SESSION_RESPONSE) : jsonResponse(status, record));
    const ramp = createRampClient(makeConfig(fetchMock as unknown as ReturnType<typeof vi.fn>));
    await ramp.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" });
    return { ramp, fetchMock };
  }
  const reasonOf = async (run: Promise<unknown>) => run.then(() => "resolved", (error: ZecSendHandoffRefusedError) => error.code === "HandoffRefused" ? error.reason : error.code);

  it("reads the recorded request with the status ticket and returns the link's request when they match", async () => {
    const { ramp, fetchMock } = await client({ request, deadline, state: "sendable" });
    await expect(ramp.verifyZecSendHandoff(link, { sessionRef: ref })).resolves.toEqual({ sessionRef: ref, request, deadline });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(`https://0xramp.app/api/partner/v0/sessions/${ref}/send-request`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`PartnerTicket v1.${SESSION_RESPONSE.statusTicket}`);
  });
  it.each([
    ["a forged address", link.replace(request.address, "t1ForgedAddrForFixtures9zqqqqqqqqqqqq"), { request, deadline, state: "sendable" }, "mismatch"],
    ["a forged amount", link.replace("amountZat=5000000", "amountZat=5000001"), { request, deadline, state: "sendable" }, "mismatch"],
    ["a forged request id", link.replace(request.requestId, "reqFORGED000000001"), { request, deadline, state: "sendable" }, "mismatch"],
    ["a memo the request does not carry", `${link}&memo=pay%20me`, { request, deadline, state: "sendable" }, "mismatch"],
    ["a session with no recorded request", link, { request: null }, "not-recorded"],
    ["a request already answered", link, { request, deadline, state: "answered" }, "answered"],
    ["a request the server calls past its deadline", link, { request, deadline, state: "past-deadline" }, "past-deadline"],
    ["a route that no longer accepts the deposit", link, { request, deadline, state: "closed" }, "closed"],
    ["a state this SDK does not know", link, { request, deadline, state: "something-new" }, "closed"],
  ])("refuses %s", async (_name, url, record, reason) => {
    const { ramp } = await client(record);
    expect(await reasonOf(ramp.verifyZecSendHandoff(url, { sessionRef: ref }))).toBe(reason);
  });
  it("fails closed when the record cannot be read or trusted, and never treats that as a match", async () => {
    expect(await reasonOf((await client({}, 401)).ramp.verifyZecSendHandoff(link, { sessionRef: ref }))).toBe("ApiError");
    expect(await reasonOf((await client({ request: { ...request, amountZat: "1.5" }, deadline, state: "sendable" })).ramp.verifyZecSendHandoff(link, { sessionRef: ref }))).toBe("SchemaViolation");
    expect(await reasonOf((await client({ request, deadline: "soon", state: "sendable" })).ramp.verifyZecSendHandoff(link, { sessionRef: ref }))).toBe("SchemaViolation");
    expect(await reasonOf((await client({ request, deadline })).ramp.verifyZecSendHandoff(link, { sessionRef: ref }))).toBe("SchemaViolation");
    expect(await reasonOf((await client({})).ramp.verifyZecSendHandoff(link, { sessionRef: ref }))).toBe("SchemaViolation");
    const offline = await client({ request: null });
    offline.fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await reasonOf(offline.ramp.verifyZecSendHandoff(link, { sessionRef: ref }))).toBe("NetworkUnavailable");
  });
  it("binds the link to the expected session before any network read", async () => {
    const { ramp, fetchMock } = await client({ request: null });
    const calls = fetchMock.mock.calls.length;
    expect(await reasonOf(ramp.verifyZecSendHandoff(link, { sessionRef: "sessOTHER000000001" }))).toBe("SessionMismatch");
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
  it("needs the session's ticket, and keeps the ticket and the session out of errors and logs", async () => {
    const ramp = createRampClient(makeConfig(vi.fn()));
    expect(await reasonOf(ramp.verifyZecSendHandoff(link, { sessionRef: ref }))).toBe("ConfigError");
    const logs: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST" ? jsonResponse(201, SESSION_RESPONSE) : jsonResponse(500, {}));
    const logged = createRampClient(makeConfig(fetchMock as unknown as ReturnType<typeof vi.fn>, { logger: { debug: (...args: unknown[]) => logs.push(args), info: (...args: unknown[]) => logs.push(args) } as RampClientConfig["logger"] }));
    await logged.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" });
    const error = await logged.verifyZecSendHandoff(link, { sessionRef: ref }).catch((cause: Error) => cause);
    expect((error as Error).message).not.toContain(ref);
    expect(JSON.stringify(logs)).not.toContain(SESSION_RESPONSE.statusTicket);
    expect(JSON.stringify(logs)).not.toContain(request.address);
  });
  it("accepts an explicit ticket for a restored wallet", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { request, deadline, state: "sendable" }));
    const ramp = createRampClient(makeConfig(fetchMock as unknown as ReturnType<typeof vi.fn>));
    await expect(ramp.verifyZecSendHandoff(link, { sessionRef: ref }, { statusTicket: SESSION_RESPONSE.statusTicket })).resolves.toMatchObject({ request });
  });
});

describe("createRampClient", () => {
  it("carries an optional recovery key only in the header and never retries automatically", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, SESSION_RESPONSE));
    const client = createRampClient(makeConfig(fetchMock));
    const input = { direction: "sell" as const, asset: "ZEC" as const, fiat: "BRL", idempotencyKey: "a".repeat(43) };
    await client.createSession(input);
    expect(fetchMock.mock.calls[0]![1].headers["idempotency-key"]).toBe(input.idempotencyKey);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty("idempotencyKey");
    fetchMock.mockRejectedValueOnce(new Error("response lost"));
    await expect(client.createSession(input)).rejects.toThrow("could not reach");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(client.createSession({ ...input, idempotencyKey: "guessable" })).rejects.toThrow("idempotencyKey");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("createSession returnUrl scheme validation (fail early)", () => {
    const createWithReturnUrl = (fetchMock: ReturnType<typeof vi.fn>, returnUrl: string) =>
      createRampClient(makeConfig(fetchMock)).createSession({
        direction: "sell",
        asset: "ZEC",
        fiat: "BRL",
        returnUrl,
      });

    it("accepts letter-first custom schemes and forwards them in the POST body", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SESSION_RESPONSE));
      await createWithReturnUrl(fetchMock, "mywallet://ramp");
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)["returnUrl"]).toBe("mywallet://ramp");
    });

    it("accepts https return URLs (universal/app links)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SESSION_RESPONSE));
      await expect(createWithReturnUrl(fetchMock, "https://wallet.example/ramp?x=1")).resolves.toMatchObject({
        sessionRef: SESSION_RESPONSE.sessionRef,
      });
    });

    it("accepts schemes without // (consistent with parseReturnUrl)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SESSION_RESPONSE));
      await expect(createWithReturnUrl(fetchMock, "zingo:ramp?sessionRef=sessGOLDEN00000001")).resolves.toBeDefined();
    });

    it.each(["0xrampzingolibrn://ramp", "ramp?x", ""])(
      "rejects an invalid returnUrl scheme (%s) with ConfigError before any POST",
      async returnUrl => {
        const fetchMock = vi.fn();
        await expect(createWithReturnUrl(fetchMock, returnUrl)).rejects.toMatchObject({ code: "ConfigError" });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("still enforces the 2048-character bound after the scheme check", async () => {
      const fetchMock = vi.fn();
      await expect(
        createWithReturnUrl(fetchMock, `mywallet://ramp?x=${"a".repeat(2048)}`),
      ).rejects.toMatchObject({ code: "SchemaViolation" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("locks a custom deployment to the exact origin, including its port", () => {
    const client = createRampClient(makeConfig(vi.fn(), { environment: "staging", apiBaseUrl: "https://partner.hosting.example" }));
    expect(client.isAllowedPaneUrl("https://partner.hosting.example/session")).toBe(true);
    for (const url of ["https://other.hosting.example/session", "https://sub.partner.hosting.example/", "https://partner.hosting.example:8443/", "https://user@partner.hosting.example/"]) {
      expect(client.isAllowedPaneUrl(url)).toBe(false);
    }
  });

  it("supports separately issued exact pane origins without trusting sibling tenants", () => {
    const client = createRampClient(makeConfig(vi.fn(), { apiBaseUrl: "https://api.hosting.example", paneOrigins: ["https://pane.hosting.example"] }));
    expect(client.isAllowedPaneUrl("https://pane.hosting.example/session")).toBe(true);
    expect(client.isAllowedPaneUrl("https://api.hosting.example/session")).toBe(false);
    expect(client.isAllowedPaneUrl("https://other.hosting.example/session")).toBe(false);
  });

  it.each(["https://user:pass@api.example", "https://api.example/?token=example", "https://api.example/#fragment"])("rejects unsafe API configuration %s", apiBaseUrl => {
    expect(() => createRampClient(makeConfig(vi.fn(), { apiBaseUrl }))).toThrow();
  });

  it("restores tickets without creating a new session and refuses unsafe restored URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { outcome: "created", terminal: false, updatedAt: "2026-09-21T12:00:00Z" }));
    const client = createRampClient(makeConfig(fetchMock));
    expect(client.restoreSession(SESSION_RESPONSE)).toEqual(SESSION_RESPONSE);
    expect(fetchMock).not.toHaveBeenCalled();
    await client.getStatus(SESSION_RESPONSE.sessionRef);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: `PartnerTicket v1.${SESSION_RESPONSE.statusTicket}` } });
    expect(() => client.restoreSession({ ...SESSION_RESPONSE, sessionUrl: "https://evil.example/" })).toThrow();
  });

  it.each(["headers", "body"])("bounds waiting for response %s and never retries a POST", async phase => {
    vi.useFakeTimers();
    const forever = new Promise<never>(() => {});
    const fetchMock = vi.fn().mockImplementation(() => phase === "headers" ? forever : Promise.resolve({ ok: true, status: 200, json: () => forever }));
    const client = createRampClient(makeConfig(fetchMock, { requestTimeoutMs: 50 }));
    const request = client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" });
    const expectation = expect(request).rejects.toMatchObject({ code: "NetworkUnavailable" });
    await vi.advanceTimersByTimeAsync(50); await expectation;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it("rejects malformed partnerId at construction", () => {
    expect(() => createRampClient(makeConfig(vi.fn(), { partnerId: "bad id!" }))).toThrow();
  });

  it("requires explicit apiBaseUrl for staging", () => {
    expect(() => createRampClient(makeConfig(vi.fn(), { environment: "staging" }))).toThrow(/staging/);
  });

  it("rejects non-https apiBaseUrl", () => {
    expect(() =>
      createRampClient(makeConfig(vi.fn(), { environment: "staging", apiBaseUrl: "http://localhost:8080" })),
    ).toThrow(/https/);
  });

  it("creates a session and stores the status ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SESSION_RESPONSE));
    const client = createRampClient(makeConfig(fetchMock));
    const session = await client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" });
    expect(session.sessionRef).toBe(SESSION_RESPONSE.sessionRef);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://0xramp.app/api/partner/v0/sessions");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["partnerId"]).toBe("zingo");
    expect(body["direction"]).toBe("sell");
    expect(body["asset"]).toBe("ZEC");
  });

  it("refuses a sessionUrl outside the pane origin allowlist (fail closed)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ...SESSION_RESPONSE, sessionUrl: "https://evil.example/partner/zingo" }),
    );
    const client = createRampClient(makeConfig(fetchMock));
    await expect(
      client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" }),
    ).rejects.toMatchObject({ code: "OriginLockViolation" });
  });

  it("accepts a sessionUrl on a subdomain of the API origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ...SESSION_RESPONSE,
        sessionUrl: "https://partner.0xramp.app/partner/zingo?sessionRef=sessGOLDEN00000001",
      }),
    );
    const client = createRampClient(makeConfig(fetchMock));
    await expect(
      client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" }),
    ).resolves.toMatchObject({ sessionRef: SESSION_RESPONSE.sessionRef });
  });

  it("redacts the sessionRef in ApiError messages for status calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SESSION_RESPONSE));
    const client = createRampClient(makeConfig(fetchMock));
    await client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" });
    fetchMock.mockResolvedValue(jsonResponse(404, {}));
    const err = await client.getStatus(SESSION_RESPONSE.sessionRef).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("ApiError");
    expect((err as Error).message).not.toContain(SESSION_RESPONSE.sessionRef);
  });

  it("getStatus uses the stored ticket via PartnerTicket auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SESSION_RESPONSE));
    const client = createRampClient(makeConfig(fetchMock));
    await client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" });
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        outcome: "settled",
        updatedAt: "2026-09-21T12:00:00Z",
        terminal: true,
        zecTxids: ["0".repeat(64)],
      }),
    );
    const status = await client.getStatus(SESSION_RESPONSE.sessionRef);
    expect(status.terminal).toBe(true);
    expect(status.outcome).toBe("settled");
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`PartnerTicket v1.${SESSION_RESPONSE.statusTicket}`);
  });

  it("getStatus without a ticket fails with ConfigError", async () => {
    const client = createRampClient(makeConfig(vi.fn()));
    await expect(client.getStatus("sessGOLDEN00000001")).rejects.toMatchObject({ code: "ConfigError" });
  });

  it("maps 429 to PartnerQuotaExceeded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    const client = createRampClient(makeConfig(fetchMock));
    await expect(
      client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" }),
    ).rejects.toMatchObject({ code: "PartnerQuotaExceeded" });
  });

  it("maps non-2xx to ApiError with status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, {}));
    const client = createRampClient(makeConfig(fetchMock));
    await expect(
      client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" }),
    ).rejects.toMatchObject({ code: "ApiError", status: 503 });
  });

  it("maps fetch failures to NetworkUnavailable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
    const client = createRampClient(makeConfig(fetchMock));
    await expect(
      client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" }),
    ).rejects.toMatchObject({ code: "NetworkUnavailable" });
  });

  it("rejects schema-violating API responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ...SESSION_RESPONSE, sessionRef: "too short" }));
    const client = createRampClient(makeConfig(fetchMock));
    await expect(
      client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" }),
    ).rejects.toMatchObject({ code: "SchemaViolation" });
  });

  it("redacts session refs and tickets in logs", async () => {
    const info = vi.fn();
    const debug = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SESSION_RESPONSE));
    const client = createRampClient(makeConfig(fetchMock, { logger: { info, debug } }));
    await client.createSession({ direction: "sell", asset: "ZEC", fiat: "BRL" });
    const logged = JSON.stringify(info.mock.calls) + JSON.stringify(debug.mock.calls);
    expect(logged).not.toContain(SESSION_RESPONSE.sessionRef);
    expect(logged).not.toContain(SESSION_RESPONSE.statusTicket);
    expect(info).toHaveBeenCalledOnce();
  });
});
