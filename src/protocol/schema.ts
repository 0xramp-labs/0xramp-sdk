/**
 * PSP-v1 schema validation (zod) — the fail-closed gate for every wire shape.
 *
 * Every bridge envelope is validated here before handler dispatch, and every
 * hosted-API response is validated before it reaches host code. Unknown
 * envelope versions, schema violations, and malformed amounts never reach
 * application handlers.
 *
 * The golden wire vectors in `fixtures/psp-v1/` are validated against these
 * schemas in CI; the pane side of 0xramp.app validates against the same set.
 */
import { z } from "zod";

import {
  PspError,
  SchemaViolationError,
  UnsupportedProtocolVersionError,
} from "./errors.js";
import {
  PSP_MESSAGE_TYPES,
  PSP_VERSION,
  type ClosePayload,
  type CreateSessionRequestBody,
  type CreateSessionResponseBody,
  type HostToPaneMessage,
  type PaneToHostMessage,
  type PspEnvelope,
  type PspMessageType,
  type ReadyPayload,
  type ResultPayload,
  type SessionLifecycle,
  type SessionStatusResponseBody,
  type ZecSendCancelPayload,
  type ZecSendRequestPayload,
  type ZecSendResultPayload,
  type ZecSendPendingPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Primitive formats
// ---------------------------------------------------------------------------

/**
 * Canonical decimal string: no sign, no leading zeros (except a single `0`),
 * no bare `.`, no exponent, no floats. Fraction digits optional.
 * Examples: `"0"`, `"0.05"`, `"12.5"`; rejected: `".5"`, `"05"`, `"1e3"`, `"-1"`.
 */
export const canonicalDecimalSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, "must be a canonical decimal string (no sign, exponent, or leading zeros)");

/** Canonical integer string (used for `amountZat` and other unit counts). */
export const canonicalIntegerSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a canonical integer string");

/** Opaque, header-safe server-issued session reference. */
export const sessionRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, "malformed sessionRef");

/** Opaque, header-safe server-issued status ticket. Bearer data — never log raw. */
export const statusTicketSchema = z
  .string()
  .regex(/^[A-Za-z0-9._~+/=-]{8,512}$/, "malformed statusTicket");

/** Correlation id pairing a `zec-send-request` with exactly one reply. */
export const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, "malformed requestId");

/** Zcash transaction id (64 hex chars). */
export const zecTxidSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "malformed ZEC txid");

/**
 * Syntactic transparent-Zcash-address check (t1/t3 mainnet, tm testnet).
 * Base58 charset only; no checksum validation host-side. Shielded/unified
 * addresses are rejected — ZEC delivery is transparent-address only in v0.
 */
export const transparentZcashAddressSchema = z
  .string()
  .regex(/^t(1|3|m)[1-9A-HJ-NP-Za-km-z]{25,89}$/, "not a transparent Zcash address (t-addr)");

export const fiatCurrencySchema = z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code");

/** Display strings are receipt-only; they are never parsed for money math. */
export const displayAmountSchema = z.string().min(1).max(64);

const httpsUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");

const isoTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO 8601 timestamp");

// ---------------------------------------------------------------------------
// Envelope + message schemas
// ---------------------------------------------------------------------------

const envelopeMeta = {
  v: z.literal(PSP_VERSION),
  sessionRef: sessionRefSchema,
} as const;

const readyPayloadSchema = z.object({
  sessionRef: sessionRefSchema,
  resolvedParams: z.record(z.string(), z.unknown()),
  statusTicket: statusTicketSchema.optional(),
}) satisfies z.ZodType<ReadyPayload>;

const zecSendRequestPayloadSchema = z.object({
  requestId: requestIdSchema,
  address: transparentZcashAddressSchema,
  amountZat: canonicalIntegerSchema,
  memo: z.string().max(512).optional(),
}) satisfies z.ZodType<ZecSendRequestPayload>;

const resultPayloadSchema = z.object({
  outcome: z.enum(["settled", "failed", "expired", "cancelled"]),
  zecTxid: zecTxidSchema.optional(),
  fiat: z
    .object({
      currency: fiatCurrencySchema,
      amountDisplay: displayAmountSchema,
    })
    .optional(),
  ts: z.number().int().nonnegative(),
}) satisfies z.ZodType<ResultPayload>;

const closePayloadSchema = z.object({
  reason: z.string().max(256),
}) satisfies z.ZodType<ClosePayload>;

const zecSendResultPayloadSchema = z.object({
  requestId: requestIdSchema,
  txid: zecTxidSchema,
  txids: z.array(zecTxidSchema).min(1).max(32).optional(),
}).refine((payload) => payload.txids === undefined || payload.txids.includes(payload.txid), {
  message: "txids must include the deposit txid",
}) satisfies z.ZodType<ZecSendResultPayload>;

const zecSendCancelPayloadSchema = z.object({
  requestId: requestIdSchema,
  reason: z.string().max(256),
}) satisfies z.ZodType<ZecSendCancelPayload>;

const zecSendPendingPayloadSchema = z.object({
  requestId: requestIdSchema,
  reason: z.enum(["in-progress", "broadcast-unknown", "multiple-transactions", "storage-unavailable"]),
  txids: z.array(zecTxidSchema).min(1).max(32).optional(),
}) satisfies z.ZodType<ZecSendPendingPayload>;

const readyMessageSchema = z.object({
  ...envelopeMeta,
  type: z.literal("psp/ready"),
  payload: readyPayloadSchema,
});
const zecSendRequestMessageSchema = z.object({
  ...envelopeMeta,
  type: z.literal("psp/zec-send-request"),
  payload: zecSendRequestPayloadSchema,
});
const resultMessageSchema = z.object({
  ...envelopeMeta,
  type: z.literal("psp/result"),
  payload: resultPayloadSchema,
});
const closeMessageSchema = z.object({
  ...envelopeMeta,
  type: z.literal("psp/close"),
  payload: closePayloadSchema,
});
const zecSendResultMessageSchema = z.object({
  ...envelopeMeta,
  type: z.literal("psp/zec-send-result"),
  payload: zecSendResultPayloadSchema,
});
const zecSendCancelMessageSchema = z.object({
  ...envelopeMeta,
  type: z.literal("psp/zec-send-cancel"),
  payload: zecSendCancelPayloadSchema,
});
const zecSendPendingMessageSchema = z.object({
  ...envelopeMeta,
  type: z.literal("psp/zec-send-pending"),
  payload: zecSendPendingPayloadSchema,
});

/** Full catalog of pane → host messages (v0, complete). */
export const paneToHostMessageSchema = z.discriminatedUnion("type", [
  readyMessageSchema,
  zecSendRequestMessageSchema,
  resultMessageSchema,
  closeMessageSchema,
]) satisfies z.ZodType<PaneToHostMessage>;

/** Full catalog of host → pane messages (v0, complete). */
export const hostToPaneMessageSchema = z.discriminatedUnion("type", [
  zecSendResultMessageSchema,
  zecSendCancelMessageSchema,
  zecSendPendingMessageSchema,
]) satisfies z.ZodType<HostToPaneMessage>;

/** Generic envelope check (type/catalog validation happens per direction). */
export const pspEnvelopeSchema = z.object({
  v: z.literal(PSP_VERSION),
  type: z.enum(PSP_MESSAGE_TYPES),
  sessionRef: sessionRefSchema,
  payload: z.unknown(),
}) satisfies z.ZodType<PspEnvelope>;

// ---------------------------------------------------------------------------
// Hosted-API channel schemas
// ---------------------------------------------------------------------------

export const createSessionRequestSchema = z.object({
  partnerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "malformed partnerId"),
  direction: z.enum(["sell", "buy"]),
  asset: z.literal("ZEC"),
  fiat: fiatCurrencySchema,
  amount: canonicalDecimalSchema.optional(),
  zecReceiver: transparentZcashAddressSchema.optional(),
  returnUrl: z.string().min(1).max(2048).optional(),
  partnerSessionId: z.string().min(1).max(128).optional(),
  locale: z.enum(["pt", "en", "es", "hi", "id"]).optional(),
}) satisfies z.ZodType<CreateSessionRequestBody>;

export const createSessionResponseSchema = z.object({
  sessionUrl: httpsUrlSchema,
  sessionRef: sessionRefSchema,
  statusTicket: statusTicketSchema,
  expiresAt: isoTimestampSchema,
}) satisfies z.ZodType<CreateSessionResponseBody>;

export const sessionStatusResponseSchema = z.object({
  outcome: z.enum([
    "created",
    "opened",
    "user-active",
    "settled",
    "failed",
    "expired",
    "cancelled",
  ] as const satisfies readonly SessionLifecycle[]),
  zecTxids: z.array(zecTxidSchema).optional(),
  fiat: z
    .object({
      currency: fiatCurrencySchema,
      amountDisplay: displayAmountSchema,
    })
    .optional(),
  updatedAt: isoTimestampSchema,
  terminal: z.boolean(),
}) satisfies z.ZodType<SessionStatusResponseBody>;

// ---------------------------------------------------------------------------
// Parse helpers (fail-closed, redaction-safe errors)
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: PspError };

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Rejects envelopes whose `v` is present but not the supported version.
 * Returns `false` when `v` is present-but-unknown (raise
 * `UnsupportedProtocolVersion`); `true` when version checking should
 * continue (including "v missing", which schema validation rejects).
 */
export function hasUnknownEnvelopeVersion(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  if (!("v" in raw)) return false;
  return (raw as { v?: unknown }).v !== PSP_VERSION;
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, versionChecked: boolean): ParseResult<T> {
  if (!versionChecked && hasUnknownEnvelopeVersion(raw)) {
    return { ok: false, error: new UnsupportedProtocolVersionError() };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: new SchemaViolationError(formatIssues(result.error)) };
}

/** Validate and parse any bridge envelope (generic). */
export function parseEnvelope(raw: unknown): ParseResult<PspEnvelope> {
  return parseWith(pspEnvelopeSchema, raw, false);
}

/** Validate and parse a pane → host message against the v0 catalog. */
export function parsePaneToHostMessage(raw: unknown): ParseResult<PaneToHostMessage> {
  return parseWith(paneToHostMessageSchema, raw, false);
}

/** Validate and parse a host → pane message against the v0 catalog. */
export function parseHostToPaneMessage(raw: unknown): ParseResult<HostToPaneMessage> {
  return parseWith(hostToPaneMessageSchema, raw, false);
}

/** Validate a hosted-API session-create response. */
export function parseCreateSessionResponse(raw: unknown): ParseResult<CreateSessionResponseBody> {
  return parseWith(createSessionResponseSchema, raw, true);
}

/** Validate a hosted-API session-status response. */
export function parseSessionStatus(raw: unknown): ParseResult<SessionStatusResponseBody> {
  return parseWith(sessionStatusResponseSchema, raw, true);
}

/** Validate a session-create request body before it leaves the SDK. */
export function parseCreateSessionRequest(raw: unknown): ParseResult<CreateSessionRequestBody> {
  return parseWith(createSessionRequestSchema, raw, true);
}

/** Narrow a validated pane → host message by type. */
export function isPspMessageType(value: string): value is PspMessageType {
  return (PSP_MESSAGE_TYPES as readonly string[]).includes(value);
}
