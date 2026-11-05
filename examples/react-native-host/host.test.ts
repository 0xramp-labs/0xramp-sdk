import { describe, expect, it, vi } from "vitest";
import { createMemoryZecSendStore, createRampClient, type HostToPaneMessage, type PaneBridgeHandlers } from "@0xramp/sdk";
import { createPartnerHost, type HostState } from "./host.js";

const ref = "sessGOLDEN00000001";
const paneFragment = "#paneToken=paneGOLDEN00000000000000000000000000000001";
const session = { sessionRef: ref, sessionUrl: `https://0xramp.app/partner/example?sessionRef=${ref}${paneFragment}`, statusTicket: "v1.GOLDENFIXTUREwJk9mQ2sTvX7bN4rLp", expiresAt: "2099-01-01T00:00:00Z" };
const input = { direction: "sell" as const, asset: "ZEC" as const, fiat: "BRL", partnerSessionId: "example-correlation" };
const request = { v: 1, type: "psp/zec-send-request", sessionRef: ref, payload: { requestId: "reqGOLDEN00000001", address: "t1FakeAddrForFixtures9zqqqqqqqqqqqqq", amountZat: "5000000" } };
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function harness() {
  let saved: string | null = null;
  let listener: ((raw: unknown) => void) | undefined;
  let state: HostState | undefined;
  let outcome = "created";
  let terminal = false;
  let nextSession = session;
  const sent: HostToPaneMessage[] = [];
  const fetchMock = vi.fn(async (_url, init) => json(init.method === "POST" ? nextSession : { outcome, terminal, updatedAt: "2026-09-22T12:00:00Z" }));
  const store = createMemoryZecSendStore();
  const wallet = vi.fn<NonNullable<PaneBridgeHandlers["onZecSendRequest"]>>(() => ({ txid: "a".repeat(64) }));
  const transport = { post: (message: HostToPaneMessage) => sent.push(message), subscribe: (handler: (raw: unknown) => void) => { listener = handler; return () => { if (listener === handler) listener = undefined; }; } };
  const storage = { read: async () => saved, write: async (value: string | null) => { saved = value; } };
  const resumes: string[] = [];
  const make = () => createPartnerHost({ client: createRampClient({ environment: "production", partnerId: "example", fetch: fetchMock as unknown as typeof fetch, sendStore: store }), transport, storage, wallet, sendStore: store, onResumeLink: url => { resumes.push(url); }, onState: value => { state = value; } });
  return { make, wallet, fetchMock, sent, storage, store, resumes: () => resumes, state: () => state!, saved: () => saved, listening: () => listener !== undefined, emit: (raw: unknown) => listener?.(raw), status: (value: string, done: boolean) => { outcome = value; terminal = done; }, next: (value: typeof session) => { nextSession = value; } };
}

describe("simulated partner integration", () => {
  it("attaches before rendering and binds the second session after authoritative completion", async () => {
    const h = harness(); const host = h.make();
    await host.start(input); expect(h.listening()).toBe(true); expect(h.state().pane?.sessionRef).toBe(ref);
    h.emit(JSON.stringify(request)); await flush(); expect(h.wallet).toHaveBeenCalledOnce();
    h.status("settled", true); await host.refreshStatus(); expect(h.listening()).toBe(false);
    const nextRef = "sessGOLDEN00000002";
    h.next({ ...session, sessionRef: nextRef, sessionUrl: `https://0xramp.app/partner/example?sessionRef=${nextRef}` }); h.status("created", false);
    await host.start({ ...input, partnerSessionId: "example-next" });
    h.emit({ ...request, sessionRef: nextRef }); await flush();
    expect(h.wallet).toHaveBeenCalledTimes(2); expect(h.sent[1]?.sessionRef).toBe(nextRef);
    host.dispose();
  });

  it("restores a saved session and recorded broadcast after app restart without another send", async () => {
    const h = harness(); const first = h.make(); await first.start(input);
    h.emit(request); await flush(); first.dispose();
    const second = h.make(); await second.initialize(); await second.resume(); h.emit(JSON.stringify(request)); await flush();
    expect(h.wallet).toHaveBeenCalledOnce(); expect(h.sent[1]).toEqual(h.sent[0]);
    expect(h.fetchMock.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    second.dispose();
  });

  it("keeps the saved session after close and removes bridge listeners", async () => {
    const h = harness(); const host = h.make(); await host.start(input);
    h.emit({ v: 1, type: "psp/close", sessionRef: ref, payload: { reason: "user closed" } });
    expect(h.listening()).toBe(false); expect(h.state().pane).toBeNull(); expect(h.saved()).not.toBeNull();
    h.emit(request); await flush(); expect(h.wallet).not.toHaveBeenCalled(); host.dispose();
  });

  it("does not trust advisory settlement or a forged return link", async () => {
    const h = harness(); const host = h.make(); await host.start(input);
    h.emit({ v: 1, type: "psp/result", sessionRef: ref, payload: { outcome: "settled", ts: Date.now() } }); await flush();
    expect(h.state().active).toBe(true); expect(h.state().message).toBe("Authoritative status: created");
    const count = h.fetchMock.mock.calls.length;
    host.handleReturn(`attacker://ramp?sessionRef=${ref}&outcome=settled`); await flush(); expect(h.fetchMock).toHaveBeenCalledTimes(count);
    host.handleReturn(`ramp-example://ramp?sessionRef=${ref}&outcome=settled`); await flush();
    expect(h.fetchMock).toHaveBeenCalledTimes(count + 1); expect(h.state().active).toBe(true); host.dispose();
  });

  it("routes a handoff link on the registered scheme through the shared journal once and prepares the resume link", async () => {
    const h = harness(); const host = h.make(); await host.start(input);
    const query = `sessionRef=${ref}&requestId=reqGOLDEN00000002&address=t1FakeAddrForFixtures9zqqqqqqqqqqqqq&amountZat=5000000`;
    host.handleReturn(`ramp-example://ramp?${query}`); await flush();
    expect(h.wallet).toHaveBeenCalledOnce();
    expect(h.wallet.mock.calls[0]![0]).toEqual({ requestId: "reqGOLDEN00000002", address: "t1FakeAddrForFixtures9zqqqqqqqqqqqqq", amountZat: "5000000" });
    const resume = `https://0xramp.app/partner/example?sessionRef=${ref}&txid=${"a".repeat(64)}${paneFragment}`;
    expect(h.resumes()).toEqual([resume]);
    // A repeated link never reaches the wallet again; recorded evidence is handed back as is.
    host.handleReturn(`ramp-example://ramp?${query}`); await flush();
    expect(h.wallet).toHaveBeenCalledOnce(); expect(h.resumes()).toEqual([resume, resume]); expect(h.state().message).toContain("Never send again");
    host.handleReturn(`ramp-example://ramp?${query.replace(ref, "sessOTHER0000000001")}`); await flush();
    host.handleReturn(`attacker://ramp?${query}`); await flush();
    expect(h.wallet).toHaveBeenCalledOnce(); expect(h.state().active).toBe(true); host.dispose();
  });
  it("journals a declined handoff without a resume link and never asks the wallet again", async () => {
    const h = harness(); h.wallet.mockImplementationOnce(() => ({ cancel: true, reason: "user declined" }));
    const host = h.make(); await host.start(input);
    const link = `ramp-example://ramp?sessionRef=${ref}&requestId=reqGOLDEN00000003&address=t1FakeAddrForFixtures9zqqqqqqqqqqqqq&amountZat=5000000`;
    host.handleReturn(link); await flush();
    expect(h.wallet).toHaveBeenCalledOnce(); expect(h.resumes()).toHaveLength(0);
    host.handleReturn(link); await flush(); expect(h.wallet).toHaveBeenCalledOnce(); host.dispose();
  });
  const handoffRequest = (id: string) => ({ requestId: id, address: "t1FakeAddrForFixtures9zqqqqqqqqqqqqq", amountZat: "5000000" });
  const handoffLink = (id: string) => `ramp-example://ramp?sessionRef=${ref}&requestId=${id}&address=t1FakeAddrForFixtures9zqqqqqqqqqqqqq&amountZat=5000000`;
  it("hands several broadcast transactions back as evidence instead of dropping them", async () => {
    const h = harness(); const [a, b] = ["a".repeat(64), "b".repeat(64)];
    h.wallet.mockImplementationOnce(() => ({ txids: [a, b] }));
    const host = h.make(); await host.start(input);
    host.handleReturn(handoffLink("reqGOLDEN00000004")); await flush();
    expect(h.resumes()).toEqual([`https://0xramp.app/partner/example?sessionRef=${ref}&txids=${a}%2C${b}${paneFragment}`]);
    const recorded = await h.store.claim(ref, handoffRequest("reqGOLDEN00000004"));
    expect(recorded?.reply).toMatchObject({ type: "psp/zec-send-pending", payload: { reason: "multiple-transactions", txids: [a, b] } });
    host.dispose();
  });
  it.each([
    ["an inconsistent outcome", { txid: "a".repeat(64), txids: ["b".repeat(64)] }, "multiple-transactions"],
    ["an unresolved send with one ID", { pending: true as const, txids: ["a".repeat(64)] }, "broadcast-unknown"],
  ])("journals %s as pending and does not let the pane read it as the deposit", async (_name, outcome, reason) => {
    const h = harness(); h.wallet.mockImplementationOnce(() => outcome);
    const host = h.make(); await host.start(input);
    host.handleReturn(handoffLink("reqGOLDEN00000005")); await flush();
    const recorded = await h.store.claim(ref, handoffRequest("reqGOLDEN00000005"));
    expect(recorded?.reply).toMatchObject({ type: "psp/zec-send-pending", payload: { reason } });
    expect(h.resumes()).toHaveLength(0);
    host.dispose();
  });
  it("records a throwing wallet as an unknown broadcast and never asks it again", async () => {
    const h = harness(); h.wallet.mockImplementationOnce(() => { throw new Error("wallet core failed after signing"); });
    const host = h.make(); await host.start(input);
    host.handleReturn(handoffLink("reqGOLDEN00000006")); await flush();
    const recorded = await h.store.claim(ref, handoffRequest("reqGOLDEN00000006"));
    expect(recorded?.reply).toMatchObject({ type: "psp/zec-send-pending", payload: { reason: "broadcast-unknown" } });
    expect(h.resumes()).toHaveLength(0);
    host.handleReturn(handoffLink("reqGOLDEN00000006")); await flush(); expect(h.wallet).toHaveBeenCalledOnce();
    host.dispose();
  });
  it("refuses a handoff link while the session is held for reconciliation", async () => {
    const h = harness(); const host = h.make(); await host.start(input);
    h.status("expired", false); await host.refreshStatus();
    expect(h.state().blocked).toBe(true);
    host.handleReturn(handoffLink("reqGOLDEN00000007")); await flush();
    expect(h.wallet).not.toHaveBeenCalled(); expect(h.state().message).toContain("Handoff ignored");
    host.dispose();
  });
  it("reads status before a restored session reaches the wallet", async () => {
    const h = harness(); await h.storage.write(JSON.stringify({ state: "active", session }));
    h.status("expired", false);
    const host = h.make(); await host.initialize();
    expect(h.state().blocked).toBe(false);
    host.handleReturn(handoffLink("reqGOLDEN00000008")); await flush();
    expect(h.wallet).not.toHaveBeenCalled(); expect(h.state().message).toContain("Handoff refused");
    host.dispose();
  });
  it("refuses a handoff when status cannot be read", async () => {
    const h = harness(); const host = h.make(); await host.start(input);
    h.fetchMock.mockRejectedValueOnce(new Error("offline"));
    host.handleReturn(handoffLink("reqGOLDEN00000009")); await flush();
    expect(h.wallet).not.toHaveBeenCalled(); expect(h.state().message).toContain("Handoff refused");
    host.dispose();
  });
  it("re-checks after the claim, records that the wallet was not asked, and never asks it", async () => {
    const h = harness();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const claim = h.store.claim.bind(h.store);
    h.store.claim = async (sessionRef, request) => { const previous = await claim(sessionRef, request); await gate; return previous; };
    const host = h.make(); await host.start(input);
    host.handleReturn(handoffLink("reqGOLDEN00000010")); await flush();
    h.status("expired", false); await host.refreshStatus();
    release(); await flush();
    expect(h.wallet).not.toHaveBeenCalled();
    h.store.claim = claim;
    const recorded = await h.store.claim(ref, handoffRequest("reqGOLDEN00000010"));
    expect(recorded?.reply).toMatchObject({ type: "psp/zec-send-cancel", payload: { reason: "wallet confirmation not started" } });
    host.dispose();
  });
  it("aborts an open wallet sheet on terminal status, but not when the pane closes or the status is reversible", async () => {
    const h = harness(); let signal: AbortSignal | undefined;
    h.wallet.mockImplementation((_request, context) => { signal = context.signal; return new Promise(() => {}); });
    const host = h.make(); await host.start(input);
    host.handleReturn(handoffLink("reqGOLDEN00000011")); await flush();
    expect(signal?.aborted).toBe(false);
    host.close(); expect(signal?.aborted).toBe(false);
    h.status("expired", false); await host.refreshStatus(); expect(signal?.aborted).toBe(false);
    h.status("failed", true); await host.refreshStatus(); expect(signal?.aborted).toBe(true);
    host.dispose();
  });
  it("still hands evidence back when the journal cannot record the outcome", async () => {
    const h = harness();
    const complete = h.store.complete.bind(h.store);
    h.store.complete = async () => { throw new Error("storage unavailable"); };
    const host = h.make(); await host.start(input);
    host.handleReturn(handoffLink("reqGOLDEN00000012")); await flush();
    expect(h.resumes()).toHaveLength(1); expect(h.state().message).toContain("could not be persisted");
    h.store.complete = complete; host.dispose();
  });
  it("persists uncertain creation and refuses duplicate POSTs across restarts", async () => {
    const h = harness(); h.fetchMock.mockRejectedValue(new Error("response lost"));
    const first = h.make(); await Promise.all([first.start(input), first.start(input)]); first.dispose();
    const second = h.make(); await second.start(input);
    expect(h.fetchMock).toHaveBeenCalledOnce(); expect(h.state().blocked).toBe(true); expect(h.state().pane).toBeNull();
    expect(JSON.parse(h.saved()!)).toEqual({ state: "creating", partnerSessionId: input.partnerSessionId }); second.dispose();
  });

  it("does not open a late create response after the user closes", async () => {
    const h = harness(); let resolve: ((value: Response) => void) | undefined;
    h.fetchMock.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    const host = h.make(); const starting = host.start(input); await flush(); host.close();
    resolve?.(json(session)); await starting;
    expect(h.state().pane).toBeNull(); expect(h.listening()).toBe(false); expect(h.saved()).not.toBeNull(); host.dispose();
  });

  it("does not POST when intent storage is unavailable", async () => {
    const h = harness(); h.storage.write = async () => { throw new Error("disk unavailable"); };
    const host = h.make(); await host.start(input); expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.state().blocked).toBe(true); host.dispose();
  });

  it("keeps an ambiguous multi-transaction send pending and never repeats it on resume", async () => {
    const h = harness(); h.wallet.mockReturnValue({ txids: ["a".repeat(64), "b".repeat(64)] });
    const host = h.make(); await host.start(input); h.emit(request); await flush(); host.close();
    await host.resume(); h.emit(request); await flush(); expect(h.wallet).toHaveBeenCalledOnce();
    expect(h.sent[1]).toMatchObject({ type: "psp/zec-send-pending", payload: { reason: "multiple-transactions" } }); host.dispose();
  });

  it("keeps expired sessions for late-deposit reconciliation even if reported terminal", async () => {
    const h = harness(); const host = h.make(); await host.start(input);
    h.status("expired", true); await host.refreshStatus(); await host.start(input);
    expect(h.saved()).not.toBeNull(); expect(h.state().blocked).toBe(true); expect(h.state().pane).toBeNull();
    expect(h.fetchMock.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1); host.dispose();
  });

  it("stops signing before waiting for terminal session cleanup", async () => {
    const h = harness(); const host = h.make(); await host.start(input);
    let finish: (() => void) | undefined;
    h.storage.write = () => new Promise<void>(resolve => { finish = resolve; });
    h.status("settled", true); const refresh = host.refreshStatus(); await flush();
    h.emit(request); await flush(); expect(h.wallet).not.toHaveBeenCalled(); expect(h.listening()).toBe(false);
    finish?.(); await refresh; host.dispose();
  });

  it("resuming an open pane preserves the in-flight callback and reply channel", async () => {
    const h = harness(); const host = h.make(); let finish: ((value: { txid: string }) => void) | undefined;
    let signal: AbortSignal | undefined;
    h.wallet.mockImplementation((_request, context) => { signal = context.signal; return new Promise(resolve => { finish = resolve; }); });
    await host.start(input); h.emit(request); await flush();
    await host.resume(); expect(signal?.aborted).toBe(false);
    finish?.({ txid: "a".repeat(64) }); await flush(); expect(h.sent[0]?.type).toBe("psp/zec-send-result"); host.dispose();
  });
});
