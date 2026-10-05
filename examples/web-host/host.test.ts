/** Opt-in tests for the popup-mode web host controller (no browser install). */
import { describe, expect, it, vi } from "vitest";
import { createWebPartnerHost } from "./host.js";
import type { CreateSessionInput, ParsedReturnUrl, RampClient, RampSession, SessionStatus } from "@0xramp/sdk";

const SESSION: RampSession = {
  sessionUrl: "https://pane.example/partner/demo?sessionRef=sessTEST00000001",
  sessionRef: "sessTEST00000001",
  statusTicket: "ticket-test-0001",
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
};
const INPUT: CreateSessionInput = {
  direction: "sell", asset: "ZEC", fiat: "BRL",
  returnUrl: "https://host.example/ramp?0xramp-return=1",
  partnerSessionId: "partner-session-1",
};

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return { outcome: "user-active", terminal: false, updatedAt: new Date().toISOString(), ...overrides };
}

interface Fixture {
  host: ReturnType<typeof createWebPartnerHost>;
  storage: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
  openPane: ReturnType<typeof vi.fn>;
  paneClose: ReturnType<typeof vi.fn>;
  states: string[];
  getStatus: ReturnType<typeof vi.fn>;
}

function makeFixture(
  clientOverrides: Partial<RampClient> = {},
  { paneHandle }: { paneHandle?: { close?: () => void } | null } = {},
): Fixture {
  const storage = {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
  };
  const paneClose = vi.fn();
  const openPane = vi.fn().mockReturnValue(paneHandle === undefined ? { close: paneClose } : paneHandle);
  const getStatus = (clientOverrides.getStatus ?? vi.fn().mockResolvedValue(makeStatus())) as ReturnType<typeof vi.fn>;
  const states: string[] = [];
  const client = {
    createSession: vi.fn().mockResolvedValue(SESSION),
    restoreSession: (s: RampSession) => s,
    isAllowedPaneUrl: () => true,
    getStatus,
    attachPaneBridge: vi.fn(),
    parseReturnUrl: (url: string): ParsedReturnUrl => {
      const params = new URL(url).searchParams;
      const ref = params.get("sessionRef");
      const outcome = params.get("outcome");
      return {
        sessionRef: ref,
        outcome: outcome === "settled" || outcome === "failed" || outcome === "expired" || outcome === "cancelled" ? outcome : null,
        claimsTerminal: ref !== null,
        params,
      };
    },
    ...clientOverrides,
  } as unknown as RampClient;
  const host = createWebPartnerHost({
    client,
    storage,
    openPane: openPane as (url: string) => { close?: () => void } | null,
    ownsReturnUrl: (url: string) => url.includes("0xramp-return=1"),
    onState: (s) => { states.push(s.message); },
  });
  return { host, storage, openPane, paneClose, states, getStatus };
}

describe("web-host popup controller", () => {
  it("persists the creation intent before the create POST resolves, then the session", async () => {
    let resolveCreate: (session: RampSession) => void = () => {};
    const pending = new Promise<RampSession>((resolve) => { resolveCreate = resolve; });
    const createSession = vi.fn().mockReturnValue(pending);
    const { host, storage, openPane } = makeFixture({ createSession });

    const done = host.start(INPUT);
    await vi.waitFor(() =>
      expect(storage.write).toHaveBeenCalledWith(JSON.stringify({ state: "creating", partnerSessionId: INPUT.partnerSessionId })),
    );
    expect(openPane).not.toHaveBeenCalled();
    resolveCreate(SESSION);
    await done;
    expect(storage.write).toHaveBeenLastCalledWith(JSON.stringify({ state: "active", session: SESSION }));
    expect(openPane).toHaveBeenCalledWith(SESSION.sessionUrl);
  });

  it("refuses to open a popup when the pane origin policy fails", async () => {
    const { host, openPane } = makeFixture({ isAllowedPaneUrl: () => false });
    await host.start(INPUT);
    expect(openPane).not.toHaveBeenCalled();
  });

  it("blocks after a failed create, keeps the creating intent, and never opens a popup", async () => {
    const { host, storage, openPane } = makeFixture({ createSession: vi.fn().mockRejectedValue(new Error("network")) });
    await host.start(INPUT);
    expect(openPane).not.toHaveBeenCalled();
    expect(storage.write).toHaveBeenLastCalledWith(JSON.stringify({ state: "creating", partnerSessionId: INPUT.partnerSessionId }));
  });

  it("ignores return links from other sessions (no status refresh)", async () => {
    const getStatus = vi.fn().mockResolvedValue(makeStatus());
    const { host } = makeFixture({ getStatus } as unknown as Partial<RampClient>);
    await host.start(INPUT);
    getStatus.mockClear();
    host.handleReturn(`https://host.example/ramp?0xramp-return=1&sessionRef=sessOTHER0000002&outcome=settled`);
    await vi.waitFor(() => expect(getStatus).not.toHaveBeenCalled());
  });

  it("refreshes authoritative status on a matching return link and clears a terminal session", async () => {
    const getStatus = vi.fn().mockResolvedValue(makeStatus({ outcome: "settled", terminal: true }));
    const { host, storage, paneClose } = makeFixture({ getStatus } as unknown as Partial<RampClient>);
    await host.start(INPUT);
    host.handleReturn(`https://host.example/ramp?0xramp-return=1&sessionRef=${SESSION.sessionRef}&outcome=settled`);
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledWith(SESSION.sessionRef));
    await vi.waitFor(() => expect(storage.write).toHaveBeenLastCalledWith(null));
    expect(paneClose).toHaveBeenCalled();
  });

  it("keeps the session on an expired (reversible) status and closes the popup", async () => {
    const getStatus = vi.fn().mockResolvedValue(makeStatus({ outcome: "expired", terminal: false }));
    const { host, storage, paneClose } = makeFixture({ getStatus } as unknown as Partial<RampClient>);
    await host.start(INPUT);
    await host.refreshStatus();
    expect(paneClose).toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenLastCalledWith(null);
  });

  it("does not replace an open popup on resume while one is already open", async () => {
    const { host, openPane } = makeFixture();
    await host.start(INPUT);
    expect(openPane).toHaveBeenCalledTimes(1);
    await host.resume();
    expect(openPane).toHaveBeenCalledTimes(1);
  });
});
