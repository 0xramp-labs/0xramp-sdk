import { ConfigError, PspError, SchemaViolationError, UnsupportedProtocolVersionError } from "../protocol/errors.js";
import { hasUnknownEnvelopeVersion, parseHostToPaneMessage, parsePaneToHostMessage, sessionRefSchema } from "../protocol/schema.js";
import { redactSessionRef, type ClosePayload, type HostToPaneMessage, type PaneToHostMessage, type ReadyPayload, type ResultPayload, type ZecSendPendingPayload, type ZecSendRequestPayload } from "../protocol/types.js";
import { readSendRecord, sendReply, type ZecSendOutcome, type ZecSendStore } from "./sendStore.js";
import type { PaneTransport } from "./transport.js";

export type { PaneTransport } from "./transport.js";
export type { ZecSendOutcome } from "./sendStore.js";

export interface PaneBridgeHandlers {
  onReady?(payload: ReadyPayload): void;
  /** Return cancel only when no broadcast occurred; throws require reconciliation. */
  onZecSendRequest?(payload: ZecSendRequestPayload, context: { signal: AbortSignal }): Promise<ZecSendOutcome> | ZecSendOutcome;
  onSendRecoveryRequired?(payload: ZecSendPendingPayload): void;
  /** Advisory only; reconcile through the ticketed status API. */
  onResult?(payload: ResultPayload): void;
  onClose?(payload: ClosePayload): void;
  onProtocolError?(error: PspError, raw: unknown): void;
}

export interface PaneBridgeOptions {
  transport: PaneTransport;
  handlers: PaneBridgeHandlers;
  sessionRef?: string;
  /** Required for a signing callback; persist and namespace records per wallet. */
  sendStore?: ZecSendStore;
  logger?: {
    debug?(message: string, meta?: Record<string, unknown>): void;
    info?(message: string, meta?: Record<string, unknown>): void;
    warn?(message: string, meta?: Record<string, unknown>): void;
    error?(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface PaneBridgeStats {
  received: number;
  dispatched: number;
  dropped: number;
  sessionMismatches: number;
  schemaViolations: number;
}

export interface PaneBridge {
  /** Persist a verified outcome for an accepted request before replying. */
  sendZecSendResult(requestId: string, txid: string): Promise<void>;
  /** Use only when the wallet confirmed that nothing was broadcast. */
  sendZecSendCancel(requestId: string, reason: string): Promise<void>;
  /** Stops new callbacks and signals cancellation; broadcasts still need reconciliation. */
  close(): void;
  getStats(): PaneBridgeStats;
}

export function attachPaneBridge(options: PaneBridgeOptions): PaneBridge {
  const { transport, handlers, logger, sendStore } = options;
  if (handlers.onZecSendRequest !== undefined && sendStore === undefined) {
    throw new ConfigError("onZecSendRequest requires a sendStore; use durable wallet-scoped storage for live sends");
  }
  if (options.sessionRef !== undefined && !sessionRefSchema.safeParse(options.sessionRef).success) {
    throw new ConfigError("malformed bridge sessionRef");
  }
  let boundSessionRef = options.sessionRef;
  let closed = false;
  let unsubscribe = () => {};
  const controller = new AbortController();
  const handled = new Set<string>();
  const requests = new Map<string, ZecSendRequestPayload>();
  const replied = new Map<string, HostToPaneMessage>();
  const stats: PaneBridgeStats = { received: 0, dispatched: 0, dropped: 0, sessionMismatches: 0, schemaViolations: 0 };

  function fail(error: PspError, raw: unknown): void {
    stats.dropped += 1;
    if (error.code === "SchemaViolation") stats.schemaViolations += 1;
    logger?.warn?.("bridge message rejected", { code: error.code });
    handlers.onProtocolError?.(error, raw);
  }

  function post(reply: HostToPaneMessage): void {
    if (closed) return;
    if (reply.type === "psp/zec-send-pending") handlers.onSendRecoveryRequired?.(reply.payload);
    if (closed) return;
    try { transport.post(reply); } catch {
      fail(new PspError("NetworkUnavailable", "bridge reply delivery failed; reconcile the stored send"), undefined);
    }
  }

  function pending(sessionRef: string, requestId: string, reason: ZecSendPendingPayload["reason"]): HostToPaneMessage {
    return { v: 1, type: "psp/zec-send-pending", sessionRef, payload: { requestId, reason } };
  }

  async function complete(request: ZecSendRequestPayload, reply: HostToPaneMessage): Promise<void> {
    const parsed = parseHostToPaneMessage(reply);
    if (!parsed.ok) throw parsed.error;
    const previous = replied.get(request.requestId);
    if (previous !== undefined && previous.type !== "psp/zec-send-pending") {
      if (JSON.stringify(previous) === JSON.stringify(parsed.value)) return;
      throw new SchemaViolationError("a terminal send outcome is already recorded");
    }
    if (sendStore === undefined) throw new ConfigError("cannot record a send without a sendStore");
    try {
      await sendStore.complete(reply.sessionRef, request, parsed.value);
    } catch {
      const recorded = replied.get(request.requestId);
      if (recorded !== undefined && recorded.type !== "psp/zec-send-pending") {
        throw new ConfigError("a terminal send outcome is already recorded");
      }
      const txids = reply.type === "psp/zec-send-result" ? reply.payload.txids ?? [reply.payload.txid]
        : reply.type === "psp/zec-send-pending" ? reply.payload.txids : undefined;
      post({ v: 1, type: "psp/zec-send-pending", sessionRef: reply.sessionRef, payload: { requestId: request.requestId, reason: "storage-unavailable", ...(txids ? { txids } : {}) } });
      throw new ConfigError("send outcome could not be persisted; reconcile before retrying");
    }
    replied.set(request.requestId, parsed.value);
    post(parsed.value);
  }

  async function handleSend(sessionRef: string, request: ZecSendRequestPayload): Promise<void> {
    if (closed) return;
    if (sendStore === undefined) {
      post(pending(sessionRef, request.requestId, "storage-unavailable"));
      return;
    }
    try {
      const previous = await sendStore.claim(sessionRef, request);
      if (previous !== undefined) {
        const stored = readSendRecord(JSON.stringify(previous), sessionRef, request);
        if (stored.reply !== undefined) replied.set(request.requestId, stored.reply);
        post(stored.reply ?? pending(sessionRef, request.requestId, "in-progress"));
        return;
      }
    } catch (error) {
      if (error instanceof SchemaViolationError) fail(error, undefined);
      post(pending(sessionRef, request.requestId, "storage-unavailable"));
      return;
    }
    if (closed || handlers.onZecSendRequest === undefined) {
      await complete(request, { v: 1, type: "psp/zec-send-cancel", sessionRef, payload: { requestId: request.requestId, reason: "wallet confirmation not started" } });
      return;
    }
    let reply: HostToPaneMessage;
    try {
      const outcome = await handlers.onZecSendRequest(request, { signal: controller.signal });
      reply = sendReply(sessionRef, request.requestId, outcome);
    } catch {
      reply = pending(sessionRef, request.requestId, "broadcast-unknown");
    }
    await complete(request, reply);
  }

  function dispatch(message: PaneToHostMessage): void {
    if ((boundSessionRef !== undefined && message.sessionRef !== boundSessionRef)
      || (boundSessionRef === undefined && message.type !== "psp/ready")
      || (message.type === "psp/ready" && message.payload.sessionRef !== message.sessionRef)) {
      stats.sessionMismatches += 1;
      fail(new PspError("SessionMismatch", "bridge session binding mismatch"), undefined);
      return;
    }
    if (boundSessionRef === undefined) {
      boundSessionRef = message.sessionRef;
      logger?.debug?.("bridge bound to session", { sessionRef: redactSessionRef(boundSessionRef) });
    }
    switch (message.type) {
      case "psp/ready":
        stats.dispatched += 1;
        handlers.onReady?.(message.payload);
        return;
      case "psp/zec-send-request":
        if (handled.has(message.payload.requestId)) {
          fail(new SchemaViolationError("replayed requestId"), undefined);
          return;
        }
        handled.add(message.payload.requestId);
        requests.set(message.payload.requestId, message.payload);
        stats.dispatched += 1;
        void Promise.resolve().then(() => handleSend(message.sessionRef, message.payload)).catch(() => {
          fail(new PspError("ConfigError", "host callback failed"), undefined);
        });
        return;
      case "psp/result":
        stats.dispatched += 1;
        handlers.onResult?.(message.payload);
        return;
      case "psp/close":
        stats.dispatched += 1;
        close();
        handlers.onClose?.(message.payload);
        return;
    }
  }

  async function manualReply(requestId: string, outcome: ZecSendOutcome): Promise<void> {
    const request = requests.get(requestId);
    if (boundSessionRef === undefined || request === undefined) throw new ConfigError("cannot reply to an unknown send request");
    await complete(request, sendReply(boundSessionRef, requestId, outcome));
  }

  const detach = transport.subscribe((raw) => {
    if (closed) return;
    stats.received += 1;
    let value: unknown = raw;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch {
        fail(new SchemaViolationError("bridge message was not valid JSON"), undefined);
        return;
      }
    }
    if (hasUnknownEnvelopeVersion(value)) {
      close();
      fail(new UnsupportedProtocolVersionError(), undefined);
      return;
    }
    const parsed = parsePaneToHostMessage(value);
    if (!parsed.ok) { fail(parsed.error, undefined); return; }
    dispatch(parsed.value);
  });
  unsubscribe = detach;
  if (closed) unsubscribe();

  function close(): void {
    if (closed) return;
    closed = true;
    controller.abort();
    unsubscribe();
  }

  return {
    sendZecSendResult: (requestId, txid) => manualReply(requestId, { txid }),
    sendZecSendCancel: (requestId, reason) => manualReply(requestId, { cancel: true, reason }),
    close,
    getStats: () => ({ ...stats }),
  };
}
