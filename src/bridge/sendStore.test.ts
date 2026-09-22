import { describe, expect, it } from "vitest";
import { createZecSendStore, sendReply } from "./sendStore.js";

const session = "sessGOLDEN00000001";
const request = { requestId: "reqGOLDEN00000001", address: "t1FakeAddrForFixtures9zqqqqqqqqqqqqq", amountZat: "5000000" };
const result = sendReply(session, request.requestId, { txid: "a".repeat(64) });
function storage() {
  const values = new Map<string, string>();
  return { values, get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); } };
}

describe("durable send journal", () => {
  it("atomically claims once across stores sharing an adapter", async () => {
    const adapter = storage();
    const records = await Promise.all([createZecSendStore(adapter).claim(session, request), createZecSendStore(adapter).claim(session, request)]);
    expect(records.filter(record => record === undefined)).toHaveLength(1);
    expect(records.find(record => record !== undefined)).toEqual({ request });
  });

  it("recovers unresolved records after recreating the storage adapter", async () => {
    const adapter = storage();
    await createZecSendStore(adapter).claim(session, request);
    expect(await createZecSendStore({ get: adapter.get, set: adapter.set }).claim(session, request)).toEqual({ request });
  });

  it("refuses changed payment details under an existing request id", async () => {
    const store = createZecSendStore(storage());
    await store.claim(session, request);
    await expect(store.claim(session, { ...request, amountZat: "6000000" })).rejects.toMatchObject({ code: "SchemaViolation" });
  });

  it("refuses corrupt and foreign-session records", async () => {
    const adapter = storage(); const store = createZecSendStore(adapter);
    await store.claim(session, request);
    const key = [...adapter.values.keys()][0]!;
    adapter.values.set(key, "corrupt");
    await expect(store.claim(session, request)).rejects.toMatchObject({ code: "SchemaViolation" });
    adapter.values.set(key, JSON.stringify({ request, reply: { ...result, sessionRef: "sessOTHER000000009" } }));
    await expect(store.claim(session, request)).rejects.toMatchObject({ code: "SchemaViolation" });
  });

  it("allows verified recovery from pending but keeps terminal outcomes immutable", async () => {
    const store = createZecSendStore(storage()); await store.claim(session, request);
    await store.complete(session, request, sendReply(session, request.requestId, { pending: true }));
    await store.complete(session, request, result);
    await store.complete(session, request, result);
    await expect(store.complete(session, request, sendReply(session, request.requestId, { cancel: true }))).rejects.toMatchObject({ code: "SchemaViolation" });
    expect((await store.claim(session, request))?.reply).toEqual(result);
  });

  it("requires a persisted claim before completing", async () => {
    await expect(createZecSendStore(storage()).complete(session, request, result)).rejects.toMatchObject({ code: "ConfigError" });
  });
});
