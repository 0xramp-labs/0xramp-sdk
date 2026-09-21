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
});

describe("createRampClient", () => {
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
