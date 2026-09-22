import { z } from "zod";

import { ConfigError, SchemaViolationError } from "../protocol/errors.js";
import { parseHostToPaneMessage, parsePaneToHostMessage, requestIdSchema, sessionRefSchema, zecTxidSchema } from "../protocol/schema.js";
import type { HostToPaneMessage, ZecSendRequestPayload } from "../protocol/types.js";

export type ZecSendOutcome =
  | { txid: string; txids?: string[] }
  | { txids: string[] }
  | { cancel: true; reason?: string }
  | { pending: true; txids?: string[] };

export interface ZecSendRecord {
  request: ZecSendRequestPayload;
  reply?: HostToPaneMessage;
}

/** `claim` must atomically persist an unresolved record before returning undefined. */
export interface ZecSendStore {
  claim(sessionRef: string, request: ZecSendRequestPayload): Promise<ZecSendRecord | undefined>;
  complete(sessionRef: string, request: ZecSendRequestPayload, reply: HostToPaneMessage): Promise<void>;
}

/** Use secure storage scoped to one wallet; reuse one adapter for that namespace. */
export interface ZecSendStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

function sameRequest(left: ZecSendRequestPayload, right: ZecSendRequestPayload): boolean {
  return left.requestId === right.requestId && left.address === right.address && left.amountZat === right.amountZat && left.memo === right.memo;
}

function keyFor(sessionRef: string, requestId: string): string {
  if (!sessionRefSchema.safeParse(sessionRef).success || !requestIdSchema.safeParse(requestId).success) {
    throw new SchemaViolationError("invalid send-store key");
  }
  return `psp.v1.${sessionRef}.${requestId}`;
}

export function readSendRecord(raw: string, sessionRef: string, request: ZecSendRequestPayload): ZecSendRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SchemaViolationError("send-store record is not valid JSON"); }
  if (typeof value !== "object" || value === null || !("request" in value)) {
    throw new SchemaViolationError("invalid send-store record");
  }
  const parsed = parsePaneToHostMessage({ v: 1, type: "psp/zec-send-request", sessionRef, payload: value.request });
  if (!parsed.ok || parsed.value.type !== "psp/zec-send-request" || !sameRequest(parsed.value.payload, request)) {
    throw new SchemaViolationError("send-store request mismatch");
  }
  if (!("reply" in value)) return { request: parsed.value.payload };
  const reply = parseHostToPaneMessage(value.reply);
  if (!reply.ok || reply.value.sessionRef !== sessionRef || reply.value.payload.requestId !== request.requestId) {
    throw new SchemaViolationError("send-store reply mismatch");
  }
  return { request: parsed.value.payload, reply: reply.value };
}

const storageQueues = new WeakMap<ZecSendStorage, Promise<unknown>>();

/** Serializes claims sharing a storage object; multi-process storage requires atomic transactions. */
export function createZecSendStore(storage: ZecSendStorage): ZecSendStore {
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = (storageQueues.get(storage) ?? Promise.resolve()).then(run);
    storageQueues.set(storage, next.catch(() => undefined));
    return next;
  }
  return {
    claim: (sessionRef, request) => serial(async () => {
      const key = keyFor(sessionRef, request.requestId);
      const raw = await storage.get(key);
      if (raw !== null) return readSendRecord(raw, sessionRef, request);
      await storage.set(key, JSON.stringify({ request }));
      return undefined;
    }),
    complete: (sessionRef, request, reply) => serial(async () => {
      const key = keyFor(sessionRef, request.requestId);
      const raw = await storage.get(key);
      if (raw === null) throw new ConfigError("cannot complete an unclaimed send request");
      const previous = readSendRecord(raw, sessionRef, request);
      const next = readSendRecord(JSON.stringify({ request, reply }), sessionRef, request);
      if (previous.reply !== undefined && previous.reply.type !== "psp/zec-send-pending") {
        if (JSON.stringify(previous.reply) !== JSON.stringify(next.reply)) throw new SchemaViolationError("send outcome already recorded");
        return;
      }
      await storage.set(key, JSON.stringify(next));
    }),
  };
}

/** Sandbox/testing only; records are lost when this store's process ends. */
export function createMemoryZecSendStore(): ZecSendStore {
  const records = new Map<string, string>();
  return createZecSendStore({ get: async key => records.get(key) ?? null, set: async (key, value) => { records.set(key, value); } });
}

const outcomeSchema = z.union([
  z.object({ txid: zecTxidSchema, txids: z.array(zecTxidSchema).min(1).max(32).optional() }).strict(),
  z.object({ txids: z.array(zecTxidSchema).min(1).max(32) }).strict(),
  z.object({ cancel: z.literal(true), reason: z.string().max(256).optional() }).strict(),
  z.object({ pending: z.literal(true), txids: z.array(zecTxidSchema).min(1).max(32).optional() }).strict(),
]);

export function sendReply(sessionRef: string, requestId: string, outcome: unknown): HostToPaneMessage {
  const parsed = outcomeSchema.safeParse(outcome);
  const envelope = { v: 1 as const, sessionRef };
  if (!parsed.success) return { ...envelope, type: "psp/zec-send-pending", payload: { requestId, reason: "broadcast-unknown" } };
  const value = parsed.data;
  if ("cancel" in value) return { ...envelope, type: "psp/zec-send-cancel", payload: { requestId, reason: value.reason ?? "user declined" } };
  if ("pending" in value) return { ...envelope, type: "psp/zec-send-pending", payload: { requestId, reason: "broadcast-unknown", ...(value.txids ? { txids: value.txids } : {}) } };
  if ("txid" in value && (value.txids === undefined || value.txids.includes(value.txid))) {
    return { ...envelope, type: "psp/zec-send-result", payload: { requestId, txid: value.txid, ...(value.txids ? { txids: value.txids } : {}) } };
  }
  if (!("txid" in value) && value.txids.length === 1 && value.txids[0] !== undefined) {
    return { ...envelope, type: "psp/zec-send-result", payload: { requestId, txid: value.txids[0] } };
  }
  return { ...envelope, type: "psp/zec-send-pending", payload: { requestId, reason: "multiple-transactions", ...(value.txids ? { txids: value.txids } : {}) } };
}
