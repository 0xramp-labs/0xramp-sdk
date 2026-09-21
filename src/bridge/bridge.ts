/**
 * Host-side pane bridge (PSP-v1 channel 3).
 *
 * The pane drives; the host handles. Fail-closed posture:
 * - every envelope is schema-validated before handler dispatch;
 * - unknown envelope `v` → `UnsupportedProtocolVersion`, session refused (listeners detached);
 * - `sessionRef` mismatch → message dropped and counted, never dispatched;
 * - wrong-direction messages → schema violation, dropped;
 * - `requestId` is single-use; replays are dropped;
 * - schema violations never crash the host — they surface via `onProtocolError`/logger.
 */
import {
  PspError,
  SchemaViolationError,
  UnsupportedProtocolVersionError,
} from "../protocol/errors.js";
import {
  hasUnknownEnvelopeVersion,
  parseHostToPaneMessage,
  parsePaneToHostMessage,
} from "../protocol/schema.js";
import {
  redactSessionRef,
  type ClosePayload,
  type PaneToHostMessage,
  type ReadyPayload,
  type ResultPayload,
  type ZecSendRequestPayload,
} from "../protocol/types.js";
import type { PaneTransport } from "./transport.js";

export type { PaneTransport } from "./transport.js";

/** Outcome of a host handling `psp/zec-send-request`. */
export type ZecSendOutcome = { txid: string } | { cancel: true; reason?: string };

export interface PaneBridgeHandlers {
  /** Pane boot handshake — confirms the session actually loaded. */
  onReady?(payload: ReadyPayload): void;
  /**
   * SELL only: confirm with the user in YOUR wallet UI, sign with YOUR wallet
   * core, broadcast, then return `{ txid }` — or `{ cancel: true, reason }`
   * if the user declined. Throwing answers the pane with a generic cancel.
   */
  onZecSendRequest?(payload: ZecSendRequestPayload): Promise<ZecSendOutcome> | ZecSendOutcome;
  /** Advisory terminal feedback. Never authoritative on its own. */
  onResult?(payload: ResultPayload): void;
  /** User finished/closed — tear down the pane gracefully. */
  onClose?(payload: ClosePayload): void;
  /** Protocol-level failures (version, schema, session mismatch). Optional. */
  onProtocolError?(error: PspError, raw: unknown): void;
}

export interface PaneBridgeOptions {
  transport: PaneTransport;
  handlers: PaneBridgeHandlers;
  /**
   * Session this bridge is bound to. When omitted, the bridge binds to the
   * sessionRef of the first accepted pane → host message and enforces the
   * match strictly from then on.
   */
  sessionRef?: string;
  /** Logger hook; receives redacted identifiers only. */
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
  /** Reply to a `zec-send-request` with a successful broadcast. */
  sendZecSendResult(requestId: string, txid: string): void;
  /** Reply to a `zec-send-request` with a user decline (or host-side refusal). */
  sendZecSendCancel(requestId: string, reason: string): void;
  /** Detach listeners. The pane stays open; the SDK stops listening. */
  close(): void;
  /** Dropped/verified counters — useful in host diagnostics. */
  getStats(): PaneBridgeStats;
}

interface JsonParseResult {
  ok: true;
  value: unknown;
}

function coerceRaw(raw: unknown): { ok: true; value: unknown } | { ok: false; error: PspError } {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      const result: JsonParseResult = { ok: true, value: parsed };
      return result;
    } catch {
      return { ok: false, error: new SchemaViolationError("bridge message was not valid JSON") };
    }
  }
  if (typeof raw === "object" && raw !== null) {
    return { ok: true, value: raw };
  }
  return { ok: false, error: new SchemaViolationError("bridge message was neither JSON text nor an object") };
}

export function attachPaneBridge(options: PaneBridgeOptions): PaneBridge {
  const { transport, handlers, logger } = options;
  let boundSessionRef = options.sessionRef;
  let closed = false;

  const stats: PaneBridgeStats = {
    received: 0,
    dispatched: 0,
    dropped: 0,
    sessionMismatches: 0,
    schemaViolations: 0,
  };

  const pendingReplies = new Set<string>();

  function fail(error: PspError, raw: unknown): void {
    stats.dropped += 1;
    if (error.code === "SchemaViolation") stats.schemaViolations += 1;
    logger?.warn?.("bridge message rejected", { code: error.code, reason: error.message });
    handlers.onProtocolError?.(error, raw);
  }

  function sendHostToPane(type: "psp/zec-send-result", payload: { requestId: string; txid: string }): void;
  function sendHostToPane(type: "psp/zec-send-cancel", payload: { requestId: string; reason: string }): void;
  function sendHostToPane(type: string, payload: Record<string, string>): void {
    if (boundSessionRef === undefined) {
      logger?.warn?.("cannot reply before bridge binding (no pspr/ready yet)");
      return;
    }
    const envelope = { v: 1, type, sessionRef: boundSessionRef, payload };
    const parsed = parseHostToPaneMessage(envelope);
    if (!parsed.ok) {
      fail(parsed.error, envelope);
      return;
    }
    transport.post(parsed.value);
  }

  function dispatch(message: PaneToHostMessage): void {
    if (boundSessionRef !== undefined && message.sessionRef !== boundSessionRef) {
      stats.sessionMismatches += 1;
      fail(new PspError("SessionMismatch", "bridge message sessionRef does not match the bound session"), message);
      return;
    }
    if (boundSessionRef === undefined) {
      boundSessionRef = message.sessionRef;
      logger?.debug?.("bridge bound to session", { sessionRef: redactSessionRef(boundSessionRef) });
    }

    switch (message.type) {
      case "psp/ready": {
        if (message.payload.sessionRef !== message.sessionRef) {
          stats.sessionMismatches += 1;
          fail(new PspError("SessionMismatch", "psp/ready payload sessionRef mismatch"), message);
          return;
        }
        stats.dispatched += 1;
        handlers.onReady?.(message.payload);
        return;
      }
      case "psp/zec-send-request": {
        if (pendingReplies.has(message.payload.requestId)) {
          fail(new SchemaViolationError("replayed requestId"), message);
          return;
        }
        pendingReplies.add(message.payload.requestId);
        stats.dispatched += 1;
        const requestId = message.payload.requestId;
        const address = message.payload.address;
        const amountZat = message.payload.amountZat;
        void Promise.resolve()
          .then(() => handlers.onZecSendRequest?.({ requestId, address, amountZat, ...(message.payload.memo !== undefined ? { memo: message.payload.memo } : {}) }))
          .then((outcome) => {
            if (outcome === undefined) {
              sendZecSendCancel(requestId, "no handler attached");
              return;
            }
            if ("cancel" in outcome) {
              sendZecSendCancel(requestId, outcome.reason ?? "user declined");
              return;
            }
            sendZecSendResult(requestId, outcome.txid);
          })
          .catch((cause: unknown) => {
            logger?.error?.("onZecSendRequest handler failed", {
              requestId,
              cause: cause instanceof Error ? cause.name : "unknown",
            });
            sendZecSendCancel(requestId, "wallet error");
          })
          .finally(() => {
            pendingReplies.delete(requestId);
          });
        return;
      }
      case "psp/result": {
        stats.dispatched += 1;
        handlers.onResult?.(message.payload);
        return;
      }
      case "psp/close": {
        stats.dispatched += 1;
        handlers.onClose?.(message.payload);
        return;
      }
    }
  }

  function sendZecSendResult(requestId: string, txid: string): void {
    sendHostToPane("psp/zec-send-result", { requestId, txid });
  }

  function sendZecSendCancel(requestId: string, reason: string): void {
    sendHostToPane("psp/zec-send-cancel", { requestId, reason });
  }

  const unsubscribe = transport.subscribe((raw) => {
    if (closed) return;
    stats.received += 1;

    const coerced = coerceRaw(raw);
    if (!coerced.ok) {
      fail(coerced.error, raw);
      return;
    }
    if (hasUnknownEnvelopeVersion(coerced.value)) {
      // Unknown version → refuse the whole session (fail closed, no degrade).
      const error = new UnsupportedProtocolVersionError();
      stats.dropped += 1;
      logger?.error?.("unsupported PSP envelope version — refusing session");
      handlers.onProtocolError?.(error, coerced.value);
      close();
      return;
    }
    const parsed = parsePaneToHostMessage(coerced.value);
    if (!parsed.ok) {
      fail(parsed.error, coerced.value);
      return;
    }
    dispatch(parsed.value);
  });

  function close(): void {
    if (closed) return;
    closed = true;
    unsubscribe();
  }

  return {
    sendZecSendResult,
    sendZecSendCancel,
    close,
    getStats: () => ({ ...stats }),
  };
}
