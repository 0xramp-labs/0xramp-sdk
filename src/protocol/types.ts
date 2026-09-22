/**
 * PSP-v1 wire types (Partner Session Protocol, version 1).
 *
 * This module is the single source of truth for the host-side view of the
 * protocol. It must stay DOM-free and React-free so it remains trivially
 * portable (and, eventually, mechanically translatable to other languages).
 *
 * Money values are canonical decimal strings or integer-unit strings —
 * never JS numbers. `amountZat` is integer zatoshi (10⁻⁸ ZEC); fiat/USDC
 * legs use 6-decimal units.
 */

/** Envelope version negotiated by this SDK. Unknown values fail closed. */
export const PSP_VERSION = 1 as const;
export type PspVersion = typeof PSP_VERSION;

/** Ramp direction. SELL: user sends ZEC, receives fiat. BUY: user pays fiat, receives ZEC. */
export type SessionDirection = "sell" | "buy";

/** Assets served in v0. */
export const PSP_ASSETS = ["ZEC"] as const;
export type RampAsset = (typeof PSP_ASSETS)[number];

/** Full session lifecycle as surfaced by the SDK (mapped 1:1 from the server projection). */
export type SessionLifecycle =
  | "created"
  | "opened"
  | "user-active"
  | "settled"
  | "failed"
  | "expired"
  | "cancelled";

/** Terminal outcomes. `expired` is a reversible projection — never act on it irreversibly. */
export type SessionOutcome = Extract<SessionLifecycle, "settled" | "failed" | "expired" | "cancelled">;

export const TERMINAL_OUTCOMES: readonly SessionOutcome[] = ["settled", "failed", "expired", "cancelled"];

/** Bridge message type identifiers. Additive-only after PSP-v1 freeze. */
export const PSP_MESSAGE_TYPES = [
  "psp/ready",
  "psp/zec-send-request",
  "psp/zec-send-result",
  "psp/zec-send-cancel",
  "psp/zec-send-pending",
  "psp/result",
  "psp/close",
] as const;
export type PspMessageType = (typeof PSP_MESSAGE_TYPES)[number];

/** Messages the pane sends to the host. */
export const PANE_TO_HOST_TYPES: readonly PspMessageType[] = [
  "psp/ready",
  "psp/zec-send-request",
  "psp/result",
  "psp/close",
];

/** Messages the host sends to the pane. */
export const HOST_TO_PANE_TYPES: readonly PspMessageType[] = [
  "psp/zec-send-result",
  "psp/zec-send-cancel",
  "psp/zec-send-pending",
];

// ---------------------------------------------------------------------------
// Validated message unions (output of schema parsing)
// ---------------------------------------------------------------------------

export type PaneToHostMessage =
  | PspEnvelope<"psp/ready", ReadyPayload>
  | PspEnvelope<"psp/zec-send-request", ZecSendRequestPayload>
  | PspEnvelope<"psp/result", ResultPayload>
  | PspEnvelope<"psp/close", ClosePayload>;

export type HostToPaneMessage =
  | PspEnvelope<"psp/zec-send-result", ZecSendResultPayload>
  | PspEnvelope<"psp/zec-send-cancel", ZecSendCancelPayload>
  | PspEnvelope<"psp/zec-send-pending", ZecSendPendingPayload>;

/** Wire envelope. `payload` is typed per message. */
export interface PspEnvelope<T extends PspMessageType = PspMessageType, P = unknown> {
  v: PspVersion;
  type: T;
  sessionRef: string;
  payload: P;
}

// ---------------------------------------------------------------------------
// Pane → host payloads
// ---------------------------------------------------------------------------

/** `psp/ready` — pane boot handshake; confirms the session actually loaded. */
export interface ReadyPayload {
  sessionRef: string;
  resolvedParams: Record<string, unknown>;
  statusTicket?: string;
}

/** `psp/zec-send-request` — SELL only; exact amount from the 1Click deposit route. */
export interface ZecSendRequestPayload {
  requestId: string;
  /** Transparent Zcash address (t-addr). Shielded addresses are rejected by schema. */
  address: string;
  /** Integer zatoshi (10⁻⁸ ZEC) as a string. */
  amountZat: string;
  memo?: string;
}

/** `psp/result` — advisory terminal feedback. Never authoritative on its own. */
export interface ResultPayload {
  outcome: SessionOutcome;
  zecTxid?: string;
  fiat?: {
    currency: string;
    /** Display string from the server; for receipts only, never for math. */
    amountDisplay: string;
  };
  /** Epoch milliseconds. */
  ts: number;
}

/** `psp/close` — user finished/closed; the host may tear down the pane. */
export interface ClosePayload {
  reason: string;
}

// ---------------------------------------------------------------------------
// Host → pane payloads
// ---------------------------------------------------------------------------

/** `psp/zec-send-result` — reply to a send request after wallet confirm + broadcast. */
export interface ZecSendResultPayload {
  requestId: string;
  /** Transaction containing the requested deposit, identified by the wallet. */
  txid: string;
  /** All transactions produced by the send, including `txid`. */
  txids?: string[];
}

/** `psp/zec-send-cancel` — user declined in the native confirm sheet. */
export interface ZecSendCancelPayload {
  requestId: string;
  reason: string;
}

/** A send needs reconciliation; the pane must not request another deposit. */
export interface ZecSendPendingPayload {
  requestId: string;
  reason: "in-progress" | "broadcast-unknown" | "multiple-transactions" | "storage-unavailable";
  txids?: string[];
}

// ---------------------------------------------------------------------------
// Session channels (1 & 4) shapes
// ---------------------------------------------------------------------------

/** `POST /api/partner/v0/sessions` request body (channel 1). */
export interface CreateSessionRequestBody {
  partnerId: string;
  direction: SessionDirection;
  asset: RampAsset;
  fiat: string;
  amount?: string;
  zecReceiver?: string;
  returnUrl?: string;
  partnerSessionId?: string;
  locale?: string;
}

/** `POST /api/partner/v0/sessions` response body (channel 1). */
export interface CreateSessionResponseBody {
  sessionUrl: string;
  sessionRef: string;
  statusTicket: string;
  /** ISO 8601 timestamp. */
  expiresAt: string;
}

/** `GET /api/partner/v0/sessions/{sessionRef}` response body (channel 4). Read-only projection. */
export interface SessionStatusResponseBody {
  outcome: SessionLifecycle;
  zecTxids?: string[];
  fiat?: {
    currency: string;
    amountDisplay: string;
  };
  /** ISO 8601 timestamp. */
  updatedAt: string;
  terminal: boolean;
}

// ---------------------------------------------------------------------------
// Redaction helpers (logging contract)
// ---------------------------------------------------------------------------

/**
 * FNV-1a over the UTF-8 bytes of `value`, hex-encoded. Used to hash session
 * references for logging without exposing the raw bearer-ish identifier.
 */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Redact a session reference for logs: `h<hash>:<len>` — never the raw value. */
export function redactSessionRef(sessionRef: string): string {
  return `h${stableHash(sessionRef)}:${sessionRef.length}`;
}

/** Redact a status ticket for logs: always fully redacted. */
export function redactStatusTicket(_statusTicket: string): string {
  return "<redacted:statusTicket>";
}
