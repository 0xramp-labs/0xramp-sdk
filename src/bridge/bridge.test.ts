/**
 * Bridge behavior tests: dispatch, session binding, single-use requestId,
 * replay/mismatch drops, unknown-version refusal, transport coercion.
 */
import { describe, expect, it, vi } from "vitest";

import { attachPaneBridge, type PaneBridgeHandlers, type PaneTransport } from "./bridge.js";

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
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
    expect(t.sent[0]).toMatchObject({
      type: "psp/zec-send-cancel",
      payload: { requestId: REQ, reason: "user declined" },
    });
  });

  it("converts handler throws into generic cancel (no internals leaked)", async () => {
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.sent[0]).toMatchObject({
      type: "psp/zec-send-cancel",
      payload: { reason: "wallet error" },
    });
    expect(JSON.stringify(t.sent[0])).not.toContain("secret internals");
  });

  it("drops replayed requestIds", async () => {
    const t = makeTransport();
    const onZecSendRequest = vi.fn(() => ({ txid: TXID }));
    const bridge = attachPaneBridge({ transport: t.transport, handlers: { onZecSendRequest }, sessionRef: SESSION });
    t.emit(sendRequestEnvelope());
    await Promise.resolve();
    t.emit(sendRequestEnvelope());
    await Promise.resolve();
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
});
