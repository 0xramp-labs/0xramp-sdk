/**
 * Bridge behavior tests: dispatch, session binding, single-use requestId,
 * replay/mismatch drops, unknown-version refusal, transport coercion.
 */
import { describe, expect, it, vi } from "vitest";

import { attachPaneBridge as attach, type PaneBridgeHandlers, type PaneBridgeOptions, type PaneTransport } from "./bridge.js";
import { createMemoryZecSendStore, createZecSendStore, type ZecSendStore, type ZecSendOutcome } from "./sendStore.js";

function attachPaneBridge(options: PaneBridgeOptions) {
  return attach({ sendStore: createMemoryZecSendStore(), ...options });
}

function makeTransport() {
  const sent: unknown[] = [];
  const listeners = new Set<(raw: unknown) => void>();
  const transport: PaneTransport = {
    post: (message) => {
      sent.push(message);
    },
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  return {
    transport,
    sent,
    emit: (raw: unknown) => listeners.forEach((l) => l(raw)),
    listenerCount: () => listeners.size,
  };
}

/** Flush all pending microtasks (promise chains) before the next macrotask. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SESSION = "sessGOLDEN00000001";
const REQ = "reqGOLDEN00000001";
const TXID = "0".repeat(64);

function readyEnvelope(sessionRef: string = SESSION) {
  return {
    v: 1,
    type: "psp/ready",
    sessionRef,
    payload: { sessionRef, resolvedParams: {} },
  };
}

function sendRequestEnvelope(sessionRef: string = SESSION, requestId: string = REQ) {
  return {
    v: 1,
    type: "psp/zec-send-request",
    sessionRef,
    payload: { requestId, address: "t1FakeAddrForFixtures9zqqqqqqqqqqqqq", amountZat: "5000000" },
  };
}

describe("attachPaneBridge", () => {
  it("binds on first accepted message and dispatches ready", () => {
    const t = makeTransport();
    const onReady = vi.fn();
    const bridge = attachPaneBridge({ transport: t.transport, handlers: { onReady } });
    t.emit(readyEnvelope());
    expect(onReady).toHaveBeenCalledOnce();
    expect(bridge.getStats().dispatched).toBe(1);
  });

  it("enforces pre-bound sessionRef strictly", () => {
    const t = makeTransport();
    const onReady = vi.fn();
    const onProtocolError = vi.fn();
    attachPaneBridge({
      transport: t.transport,
      sessionRef: SESSION,
      handlers: { onReady, onProtocolError },
    });
    t.emit(readyEnvelope("sessOTHER000000009"));
    expect(onReady).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledOnce();
    expect(onProtocolError.mock.calls[0]?.[0]?.code).toBe("SessionMismatch");
  });

  it("answers zec-send-request with zec-send-result", async () => {
    const t = makeTransport();
    const handlers: PaneBridgeHandlers = {
      onZecSendRequest: () => ({ txid: TXID }),
    };
    attachPaneBridge({ transport: t.transport, handlers, sessionRef: SESSION });
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      v: 1,
      type: "psp/zec-send-result",
      sessionRef: SESSION,
      payload: { requestId: REQ, txid: TXID },
    });
  });

  it("answers declined sends with zec-send-cancel", async () => {
    const t = makeTransport();
    attachPaneBridge({
      transport: t.transport,
      handlers: { onZecSendRequest: () => ({ cancel: true, reason: "user declined" }) },
      sessionRef: SESSION,
    });
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    expect(t.sent[0]).toMatchObject({
      type: "psp/zec-send-cancel",
      payload: { requestId: REQ, reason: "user declined" },
    });
  });

  it("requires reconciliation when a wallet handler throws without proving no broadcast", async () => {
    const t = makeTransport();
    const logger = { error: vi.fn() };
    attachPaneBridge({
      transport: t.transport,
      handlers: {
        onZecSendRequest: () => {
          throw new Error("secret internals");
        },
      },
      sessionRef: SESSION,
      logger,
    });
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    expect(t.sent[0]).toMatchObject({
      type: "psp/zec-send-pending",
      payload: { reason: "broadcast-unknown" },
    });
    expect(JSON.stringify(t.sent[0])).not.toContain("secret internals");
  });

  it("drops replayed requestIds", async () => {
    const t = makeTransport();
    const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    const bridge = attachPaneBridge({ transport: t.transport, handlers: { onZecSendRequest }, sessionRef: SESSION });
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    expect(onZecSendRequest).toHaveBeenCalledOnce();
    expect(bridge.getStats().dropped).toBe(1);
    expect(bridge.getStats().schemaViolations).toBe(1);
  });

  it("drops a replayed requestId even after the first request completed", async () => {
    const t = makeTransport();
    const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    const bridge = attachPaneBridge({ transport: t.transport, handlers: { onZecSendRequest }, sessionRef: SESSION });
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    expect(t.sent).toHaveLength(1); // first reply sent
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    expect(onZecSendRequest).toHaveBeenCalledOnce();
    expect(t.sent).toHaveLength(1); // no second reply
    expect(bridge.getStats().dropped).toBe(1);
    expect(bridge.getStats().schemaViolations).toBe(1);
  });

  it("refuses a non-ready message on an unbound bridge, then binds on psp/ready", async () => {
    const t = makeTransport();
    const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    const onProtocolError = vi.fn();
    attachPaneBridge({ transport: t.transport, handlers: { onZecSendRequest, onProtocolError } });
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    expect(onZecSendRequest).not.toHaveBeenCalled();
    expect(t.sent).toHaveLength(0);
    expect(onProtocolError.mock.calls[0]?.[0]?.code).toBe("SessionMismatch");
    t.emit(readyEnvelope());
    t.emit(sendRequestEnvelope());
    await flushMicrotasks();
    expect(onZecSendRequest).toHaveBeenCalledOnce();
    expect(t.sent).toHaveLength(1);
  });

  it("refuses the session on unknown envelope version (detaches listeners)", () => {
    const t = makeTransport();
    const onProtocolError = vi.fn();
    const bridge = attachPaneBridge({
      transport: t.transport,
      handlers: { onProtocolError },
      sessionRef: SESSION,
    });
    t.emit({ ...readyEnvelope(), v: 99 });
    expect(onProtocolError).toHaveBeenCalledOnce();
    expect(onProtocolError.mock.calls[0]?.[0]?.code).toBe("UnsupportedProtocolVersion");
    t.emit(readyEnvelope());
    expect(bridge.getStats().received).toBe(1);
    expect(bridge.getStats().dispatched).toBe(0);
  });

  it("coerces string transports (React Native style)", () => {
    const t = makeTransport();
    const onReady = vi.fn();
    attachPaneBridge({ transport: t.transport, handlers: { onReady } });
    t.emit(JSON.stringify(readyEnvelope()));
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("drops non-JSON garbage without dispatching", () => {
    const t = makeTransport();
    const onProtocolError = vi.fn();
    attachPaneBridge({
      transport: t.transport,
      handlers: { onProtocolError },
      sessionRef: SESSION,
    });
    t.emit("not json at all {{{");
    expect(onProtocolError).toHaveBeenCalledOnce();
    expect(onProtocolError.mock.calls[0]?.[0]?.code).toBe("SchemaViolation");
  });

  it("close() detaches listeners", () => {
    const t = makeTransport();
    const onReady = vi.fn();
    const bridge = attachPaneBridge({ transport: t.transport, handlers: { onReady } });
    expect(t.listenerCount()).toBe(1);
    bridge.close();
    expect(t.listenerCount()).toBe(0);
    t.emit(readyEnvelope());
    expect(onReady).not.toHaveBeenCalled();
  });

  it("refuses a wallet handler without an explicit journal", () => {
    expect(() => attach({ transport: makeTransport().transport, handlers: { onZecSendRequest: () => ({ txid: TXID }) } })).toThrow(/sendStore/);
  });

  it("does not start a queued wallet callback after closing", async () => {
    const t = makeTransport();
    const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    const bridge = attachPaneBridge({ transport: t.transport, sessionRef: SESSION, handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope());
    bridge.close();
    await flushMicrotasks();
    expect(onZecSendRequest).not.toHaveBeenCalled();
    expect(t.sent).toHaveLength(0);
  });

  it("checks closure after persisting a claim and before invoking the wallet", async () => {
    const t = makeTransport();
    let finishClaim: (() => void) | undefined;
    const store = createMemoryZecSendStore();
    const sendStore: ZecSendStore = {
      claim: async (session, request) => { await new Promise<void>(resolve => { finishClaim = resolve; }); return store.claim(session, request); },
      complete: store.complete,
    };
    const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    const bridge = attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore, handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks(); bridge.close(); finishClaim?.(); await flushMicrotasks();
    expect(onZecSendRequest).not.toHaveBeenCalled();
    expect((await store.claim(SESSION, sendRequestEnvelope().payload))?.reply?.type).toBe("psp/zec-send-cancel");
  });

  it("closes before a close handler can dispatch another send", async () => {
    const t = makeTransport(); const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, handlers: { onZecSendRequest, onClose: () => t.emit(sendRequestEnvelope()) } });
    t.emit({ v: 1, type: "psp/close", sessionRef: SESSION, payload: { reason: "user closed" } });
    await flushMicrotasks(); expect(onZecSendRequest).not.toHaveBeenCalled(); expect(t.listenerCount()).toBe(0);
  });

  it("keeps the bridge unbound after a mismatched ready payload", async () => {
    const t = makeTransport(); const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    attachPaneBridge({ transport: t.transport, handlers: { onZecSendRequest } });
    t.emit({ ...readyEnvelope("sessOTHER000000009"), payload: { sessionRef: SESSION, resolvedParams: {} } });
    t.emit(readyEnvelope()); t.emit(sendRequestEnvelope()); await flushMicrotasks();
    expect(onZecSendRequest).toHaveBeenCalledOnce();
  });

  it("returns the recorded result after bridge and store recreation without another send", async () => {
    const saved = new Map<string, string>();
    const storage = { get: async (key: string) => saved.get(key) ?? null, set: async (key: string, value: string) => { saved.set(key, value); } };
    const t = makeTransport(); const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    const first = attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: createZecSendStore(storage), handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks(); first.close();
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: createZecSendStore(storage), handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks();
    expect(onZecSendRequest).toHaveBeenCalledOnce(); expect(t.sent).toHaveLength(2); expect(t.sent[1]).toEqual(t.sent[0]);
  });

  it("persists a result that arrives after close and recovers it without resending", async () => {
    const t = makeTransport(); const store = createMemoryZecSendStore();
    let resolveSend: ((outcome: { txid: string }) => void) | undefined;
    let signal: AbortSignal | undefined;
    const onZecSendRequest = vi.fn((_request, context) => { signal = context.signal as AbortSignal; return new Promise<{ txid: string }>(resolve => { resolveSend = resolve; }); });
    const bridge = attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks(); bridge.close();
    expect(signal?.aborted).toBe(true); resolveSend?.({ txid: TXID }); await flushMicrotasks(); expect(t.sent).toHaveLength(0);
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks(); expect(onZecSendRequest).toHaveBeenCalledOnce();
    expect(t.sent[0]).toMatchObject({ type: "psp/zec-send-result", payload: { txid: TXID } });
  });

  it("requires recovery when the durable store already contains an unresolved claim", async () => {
    const store = createMemoryZecSendStore(); await store.claim(SESSION, sendRequestEnvelope().payload);
    const t = makeTransport(); const onZecSendRequest = vi.fn(() => ({ txid: TXID })); const onSendRecoveryRequired = vi.fn();
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: { onZecSendRequest, onSendRecoveryRequired } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks(); expect(onZecSendRequest).not.toHaveBeenCalled();
    expect(t.sent[0]).toMatchObject({ type: "psp/zec-send-pending", payload: { reason: "in-progress" } });
    expect(onSendRecoveryRequired).toHaveBeenCalledOnce();
  });

  it("never calls the wallet when claiming durable storage fails", async () => {
    const t = makeTransport(); const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: { claim: async () => { throw new Error("disk unavailable"); }, complete: async () => {} }, handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks(); expect(onZecSendRequest).not.toHaveBeenCalled();
    expect(t.sent[0]).toMatchObject({ type: "psp/zec-send-pending", payload: { reason: "storage-unavailable" } });
  });

  it("does not convert a lost reply after broadcast into a cancel", async () => {
    const t = makeTransport(); t.transport.post = () => { throw new Error("connection lost"); };
    const store = createMemoryZecSendStore(); const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks();
    expect((await store.claim(SESSION, sendRequestEnvelope().payload))?.reply?.type).toBe("psp/zec-send-result");
    expect(onZecSendRequest).toHaveBeenCalledOnce();
  });

  it.each([
    [{ txids: [TXID] }, "psp/zec-send-result"],
    [{ txids: [TXID, "a".repeat(64)] }, "psp/zec-send-pending"],
    [{ txid: `${TXID}, ${"a".repeat(64)}` }, "psp/zec-send-pending"],
    [{ txid: TXID, txids: ["a".repeat(64), TXID] }, "psp/zec-send-result"],
  ] as const)("responds explicitly to wallet output %j", async (outcome, type) => {
    const t = makeTransport();
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, handlers: { onZecSendRequest: () => structuredClone(outcome) as ZecSendOutcome } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks(); expect(t.sent).toHaveLength(1); expect(t.sent[0]).toMatchObject({ type });
  });

  it("replays a recorded result even without a wallet callback", async () => {
    const store = createMemoryZecSendStore(); const request = sendRequestEnvelope().payload;
    await store.claim(SESSION, request);
    await store.complete(SESSION, request, { v: 1, type: "psp/zec-send-result", sessionRef: SESSION, payload: { requestId: REQ, txid: TXID } });
    const t = makeTransport();
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: {} });
    t.emit(sendRequestEnvelope()); await flushMicrotasks();
    expect(t.sent[0]).toMatchObject({ type: "psp/zec-send-result" });
  });

  it("does not infer cancellation when neither wallet nor journal is configured", async () => {
    const t = makeTransport();
    attach({ transport: t.transport, sessionRef: SESSION, handlers: {} });
    t.emit(sendRequestEnvelope()); await flushMicrotasks();
    expect(t.sent[0]).toMatchObject({ type: "psp/zec-send-pending" });
  });

  it("revalidates records returned by a custom journal", async () => {
    const t = makeTransport(); const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    const store: ZecSendStore = {
      claim: async () => ({ request: sendRequestEnvelope().payload, reply: { v: 1, type: "psp/zec-send-result", sessionRef: "sessOTHER000000009", payload: { requestId: REQ, txid: TXID } } }),
      complete: async () => {},
    };
    attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: { onZecSendRequest } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks();
    expect(onZecSendRequest).not.toHaveBeenCalled();
    expect(t.sent[0]).toMatchObject({ type: "psp/zec-send-pending", sessionRef: SESSION });
  });

  it("does not post after a recovery hook closes the bridge", async () => {
    const t = makeTransport(); const store = createMemoryZecSendStore();
    await store.claim(SESSION, sendRequestEnvelope().payload);
    const bridge = attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: { onSendRecoveryRequired: () => bridge.close() } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks(); expect(t.sent).toHaveLength(0);
  });

  it("does not downgrade a terminal result during conflicting manual completions", async () => {
    const t = makeTransport(); const store = createMemoryZecSendStore();
    await store.claim(SESSION, sendRequestEnvelope().payload);
    const bridge = attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: {} });
    t.emit(sendRequestEnvelope()); await flushMicrotasks();
    const outcomes = await Promise.allSettled([bridge.sendZecSendResult(REQ, TXID), bridge.sendZecSendCancel(REQ, "declined")]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]).toMatchObject({ type: "psp/zec-send-result" });
  });

  it("reports a failed manual persistence attempt and retains broadcast evidence", async () => {
    const t = makeTransport(); const store: ZecSendStore = {
      claim: async () => ({ request: sendRequestEnvelope().payload }),
      complete: async () => { throw new Error("disk unavailable"); },
    };
    const bridge = attachPaneBridge({ transport: t.transport, sessionRef: SESSION, sendStore: store, handlers: {} });
    t.emit(sendRequestEnvelope()); await flushMicrotasks();
    await expect(bridge.sendZecSendResult(REQ, TXID)).rejects.toMatchObject({ code: "ConfigError" });
    expect(t.sent[1]).toMatchObject({ type: "psp/zec-send-pending", payload: { reason: "storage-unavailable", txids: [TXID] } });
  });

  it("refuses a manual cancellation after a recorded broadcast", async () => {
    const t = makeTransport();
    const bridge = attachPaneBridge({ transport: t.transport, sessionRef: SESSION, handlers: { onZecSendRequest: () => ({ txid: TXID }) } });
    t.emit(sendRequestEnvelope()); await flushMicrotasks();
    await expect(bridge.sendZecSendCancel(REQ, "declined")).rejects.toMatchObject({ code: "SchemaViolation" });
    expect(t.sent).toHaveLength(1); expect(t.sent[0]).toMatchObject({ type: "psp/zec-send-result" });
  });
});
