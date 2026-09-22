/**
 * Client behavior tests against a mocked fetch: happy paths, error mapping,
 * ticket handling, and log redaction. No live rails, ever.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
