/** Opt-in tests for the mobile-sim wallet controller (no browser install). */
import { describe, expect, it, vi } from "vitest";
import {
  attachPaneBridge,
  buildZecSendResumeUrl,
  createMemoryZecSendStore,
  parseReturnUrl,
  parseZecSendHandoffUrl,
} from "@0xramp/sdk";
import { createSandboxClient, createSimWalletHost } from "./sim.js";

type HostParams = Parameters<typeof createSimWalletHost>[0];
type SimClient = HostParams["client"];
type HostState = Parameters<HostParams["onState"]>[0];

const REF = "sessSIMDEMO0000001";
const ADDRESS = "t1FakeAddrForFixtures9zqqqqqqqqqqqqq";
const TXID = "ab".repeat(32);
const SESSION_URL = `http://127.0.0.1:8084/sandbox/sandbox-pane.html?sessionRef=${REF}`;
const INPUT = { direction: "sell", asset: "ZEC", fiat: "BRL", partnerSessionId: "partner-session-1" } as const;

const SDK_DEPS = { attachPaneBridge, parseReturnUrl, parseZecSendHandoffUrl, buildZecSendResumeUrl };

function collectStates() {
  const states: HostState[] = [];
  return states;
}
function makeTransport() {
  const posted: unknown[] = [];
  let handler: ((raw: unknown) => void) | undefined;
  return {
    posted,
    transport: {
      post: (message: unknown) => { posted.push(message); },
      subscribe: (h: (raw: unknown) => void) => { handler = h; return () => { handler = undefined; }; },
    },
    deliver: (envelope: unknown) => handler?.(JSON.stringify(envelope)),
  };
}

function manualClient(overrides: Record<string, unknown> = {}) {
  const session = {
    sessionUrl: SESSION_URL, sessionRef: REF, statusTicket: "ticket-test",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  const client = {
    createSession: vi.fn().mockResolvedValue(session),
    restoreSession: (saved: unknown) => saved,
    isAllowedPaneUrl: () => true,
    getStatus: vi.fn().mockResolvedValue({ outcome: "user-active", terminal: false, updatedAt: new Date().toISOString() }),
    attachPaneBridge: vi.fn(),
    parseReturnUrl,
    parseZecSendHandoffUrl,
    buildZecSendResumeUrl,
    ...overrides,
  };
  return { client: client as unknown as SimClient, session, getStatus: client.getStatus as ReturnType<typeof vi.fn> };
}

function makeFixture(
  { client, wallet, paneMode = "browser" }: {
    client: SimClient;
    wallet: HostParams["wallet"];
    paneMode?: "webview" | "browser";
  },
) {
  const { transport, posted, deliver } = makeTransport();
  const storage = { read: vi.fn().mockResolvedValue(null), write: vi.fn().mockResolvedValue(undefined) };
  const paneClose = vi.fn();
  const openPane = vi.fn().mockReturnValue({ close: paneClose });
  const states = collectStates();
  const host = createSimWalletHost({
    client, storage, sendStore: createMemoryZecSendStore(), transport,
    wallet, openPane: openPane as HostParams["openPane"], paneMode,
    returnUrl: "zingo://0xramp", onState: (s) => states.push(s as HostState),
  });
  return { host, storage, openPane, paneClose, posted, deliver, states, getStatus: (client as { getStatus: unknown }).getStatus as ReturnType<typeof vi.fn> };
}

const approveWallet = vi.fn().mockResolvedValue({ txid: TXID });

const handoffLink = (requestId: string, sessionRef = REF) =>
  `zingo://0xramp/send?sessionRef=${sessionRef}&requestId=${requestId}&address=${ADDRESS}&amountZat=5000000`;

describe("mobile-sim wallet controller", () => {
  it("persists the creation intent before the create POST resolves, then opens the pane", async () => {
    const base = manualClient();
    let resolveCreate: (session: typeof base.session) => void = () => {};
    const pending = new Promise<typeof base.session>((resolve) => { resolveCreate = resolve; });
    const { client } = manualClient({ createSession: vi.fn().mockReturnValue(pending) });
    const { host, storage, openPane } = makeFixture({ client, wallet: approveWallet });

    const done = host.start({ ...INPUT });
    await vi.waitFor(() =>
      expect(storage.write).toHaveBeenCalledWith(JSON.stringify({ state: "creating", partnerSessionId: INPUT.partnerSessionId })),
    );
    expect(openPane).not.toHaveBeenCalled();
    resolveCreate(base.session);
    await done;
    expect(storage.write).toHaveBeenLastCalledWith(JSON.stringify({ state: "active", session: base.session }));
    expect(openPane).toHaveBeenCalledWith(SESSION_URL);
  });

  it("refuses to open the pane when the origin policy fails and stays blocked", async () => {
    const { client } = manualClient({ isAllowedPaneUrl: () => false });
    const { host, openPane, states } = makeFixture({ client, wallet: approveWallet });
    await host.start({ ...INPUT });
    expect(openPane).not.toHaveBeenCalled();
    expect(states.at(-1)?.blocked).toBe(true);
  });

  it("keeps the creating intent and never opens the pane when the POST fails", async () => {
    const { client } = manualClient({ createSession: vi.fn().mockRejectedValue(new Error("network")) });
    const { host, storage, openPane } = makeFixture({ client, wallet: approveWallet });
    await host.start({ ...INPUT });
    expect(openPane).not.toHaveBeenCalled();
    expect(storage.write).toHaveBeenLastCalledWith(JSON.stringify({ state: "creating", partnerSessionId: INPUT.partnerSessionId }));
  });

  it("keeps the session on an expired (reversible) status and closes the pane", async () => {
    const { client } = manualClient({ getStatus: vi.fn().mockResolvedValue({ outcome: "expired", terminal: false, updatedAt: new Date().toISOString() }) });
    const { host, storage, paneClose } = makeFixture({ client, wallet: approveWallet });
    await host.start({ ...INPUT });
    await host.refreshStatus();
    expect(paneClose).toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenLastCalledWith(null);
  });

  it("reconciles a matching return deep-link through the authoritative status endpoint", async () => {
    const { client, getStatus } = manualClient();
    const { host } = makeFixture({ client, wallet: approveWallet });
    await host.start({ ...INPUT });
    expect(host.handleDeepLink(`zingo://0xramp?sessionRef=${REF}&outcome=settled`)).toBe(true);
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledWith(REF));
  });

  it("ignores return links from other sessions and foreign schemes", async () => {
    const { client, getStatus } = manualClient();
    const { host, states } = makeFixture({ client, wallet: approveWallet });
    await host.start({ ...INPUT });
    expect(host.handleDeepLink(`zingo://0xramp?sessionRef=sessOTHER0000000001&outcome=settled`)).toBe(false);
    expect(host.handleDeepLink(`zramp://send?sessionRef=${REF}&requestId=reqSIMOFF0000001&address=${ADDRESS}&amountZat=5000000`)).toBe(false);
    await vi.waitFor(() => expect(getStatus).not.toHaveBeenCalled());
    expect(states.at(-1)?.message).toContain("not this app's registered scheme");
  });

  it("runs the DRAFT handoff: wallet confirm → journal → resume link with advisory txid", async () => {
    const { client } = manualClient();
    const wallet = vi.fn().mockResolvedValue({ txid: TXID });
    const { host, states } = makeFixture({ client, wallet });
    await host.start({ ...INPUT });
    expect(host.handleDeepLink(handoffLink("reqSIMOFF0000001"))).toBe(true);
    await vi.waitFor(() => expect(wallet).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(states.at(-1)?.resumeUrl).toBeTruthy());
    const resume = new URL(states.at(-1)?.resumeUrl ?? "");
    expect(resume.searchParams.get("sessionRef")).toBe(REF);
    expect(resume.searchParams.get("txid")).toBe(TXID);
  });

  it("replays a repeated handoff from the journal without calling the wallet again", async () => {
    const { client } = manualClient();
    const wallet = vi.fn().mockResolvedValue({ txid: TXID });
    const { host, states } = makeFixture({ client, wallet });
    await host.start({ ...INPUT });
    host.handleDeepLink(handoffLink("reqSIMOFF0000001"));
    await vi.waitFor(() => expect(states.at(-1)?.resumeUrl).toBeTruthy());
    host.handleDeepLink(handoffLink("reqSIMOFF0000001"));
    await vi.waitFor(() => expect(states.at(-1)?.message).toContain("replayed"));
    expect(wallet).toHaveBeenCalledTimes(1);
  });

  it("refuses a handoff link from another session (SessionMismatch, wallet never called)", async () => {
    const { client } = manualClient();
    const wallet = vi.fn();
    const { host, states } = makeFixture({ client, wallet });
    await host.start({ ...INPUT });
    expect(host.handleDeepLink(handoffLink("reqSIMOFF0000001", "sessOTHER0000000001"))).toBe(false);
    expect(wallet).not.toHaveBeenCalled();
    expect(states.at(-1)?.message).toContain("SessionMismatch");
  });

  it("records a declined handoff without building a resume link", async () => {
    const { client } = manualClient();
    const wallet = vi.fn().mockResolvedValue({ cancel: true, reason: "user declined" });
    const { host, states } = makeFixture({ client, wallet });
    await host.start({ ...INPUT });
    expect(host.handleDeepLink(handoffLink("reqSIMOFF0000001"))).toBe(true);
    await vi.waitFor(() => expect(states.at(-1)?.message).toContain("declined (user declined)"));
    expect(states.at(-1)?.resumeUrl).toBeNull();
  });

  it("drives the real bridge in webview mode: send request → result with txid", async () => {
    const sandbox = createSandboxClient({ sdk: SDK_DEPS, sandboxPaneUrl: "http://127.0.0.1:8084/sandbox/sandbox-pane.html" });
    const client = sandbox as unknown as SimClient;
    const wallet = vi.fn().mockResolvedValue({ txid: TXID });
    const { host, posted, deliver, openPane } = makeFixture({ client, wallet, paneMode: "webview" });
    await host.start({ ...INPUT });
    expect(openPane).toHaveBeenCalledTimes(1);
    deliver({ v: 1, type: "psp/ready", sessionRef: REF, payload: { sessionRef: REF, resolvedParams: { sandbox: true, direction: "sell", fiat: "BRL", asset: "ZEC" } } });
    deliver({ v: 1, type: "psp/zec-send-request", sessionRef: REF, payload: { requestId: "reqSIMDEMO00000001", address: ADDRESS, amountZat: "5000000" } });
    await vi.waitFor(() =>
      expect(posted.at(-1)).toEqual({ v: 1, type: "psp/zec-send-result", sessionRef: REF, payload: { requestId: "reqSIMDEMO00000001", txid: TXID } }),
    );
    expect(wallet).toHaveBeenCalledTimes(1);
  });

  it("replays the recorded send outcome across bridge instances without re-signing", async () => {
    const sandbox = createSandboxClient({ sdk: SDK_DEPS, sandboxPaneUrl: "http://127.0.0.1:8084/sandbox/sandbox-pane.html" });
    const client = sandbox as unknown as SimClient;
    const wallet = vi.fn().mockResolvedValue({ txid: TXID });
    const { host, posted, deliver } = makeFixture({ client, wallet, paneMode: "webview" });
    await host.start({ ...INPUT });
    deliver({ v: 1, type: "psp/ready", sessionRef: REF, payload: { sessionRef: REF, resolvedParams: { sandbox: true, direction: "sell", fiat: "BRL", asset: "ZEC" } } });
    deliver({ v: 1, type: "psp/zec-send-request", sessionRef: REF, payload: { requestId: "reqSIMDEMO00000001", address: ADDRESS, amountZat: "5000000" } });
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    host.closePane();
    await host.resume();
    deliver({ v: 1, type: "psp/ready", sessionRef: REF, payload: { sessionRef: REF, resolvedParams: { sandbox: true, direction: "sell", fiat: "BRL", asset: "ZEC" } } });
    deliver({ v: 1, type: "psp/zec-send-request", sessionRef: REF, payload: { requestId: "reqSIMDEMO00000001", address: ADDRESS, amountZat: "5000000" } });
    await vi.waitFor(() =>
      expect(posted.at(-1)).toEqual({ v: 1, type: "psp/zec-send-result", sessionRef: REF, payload: { requestId: "reqSIMDEMO00000001", txid: TXID } }),
    );
    expect(wallet).toHaveBeenCalledTimes(1);
  });

  it("sandbox client: scripted status projection and strict pane origin", async () => {
    const sandbox = createSandboxClient({ sdk: SDK_DEPS, sandboxPaneUrl: "http://127.0.0.1:8084/sandbox/sandbox-pane.html" });
    expect(sandbox.isAllowedPaneUrl(SESSION_URL)).toBe(true);
    expect(sandbox.isAllowedPaneUrl("https://evil.example/partner/zingo")).toBe(false);
    expect((await sandbox.getStatus()).outcome).toBe("created");
    expect((await sandbox.getStatus()).outcome).toBe("user-active");
    const terminal = await sandbox.getStatus();
    expect(terminal.outcome).toBe("settled");
    expect(terminal.terminal).toBe(true);
    const session = await sandbox.createSession();
    expect(new URL(session.sessionUrl).searchParams.get("sessionRef")).toBe(REF);
  });
});
