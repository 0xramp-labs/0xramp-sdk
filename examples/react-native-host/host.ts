/** Platform-independent lifecycle used by App.tsx and the opt-in partner simulation. */
import type { CreateSessionInput, PaneBridge, PaneBridgeHandlers, PaneTransport, RampClient, RampSession } from "@0xramp/sdk";

export interface SessionStorage {
  read(): Promise<string | null>;
  write(value: string | null): Promise<void>;
}
export interface HostState {
  message: string;
  active: boolean;
  blocked: boolean;
  pane: { url: string; sessionRef: string; generation: number } | null;
}
interface HostOptions {
  client: RampClient;
  storage: SessionStorage;
  transport: PaneTransport;
  wallet: NonNullable<PaneBridgeHandlers["onZecSendRequest"]>;
  onState(state: HostState): void;
}

export function createPartnerHost({ client, storage, transport, wallet, onState }: HostOptions) {
  let session: RampSession | undefined;
  let bridge: PaneBridge | undefined;
  let disposed = false;
  let generation = 0;
  let initialized: Promise<void> | undefined;
  let operation: Promise<void> = Promise.resolve();
  let statusRequest: Promise<void> | undefined;
  let state: HostState = { message: "Loading saved session", active: false, blocked: true, pane: null };

  function update(patch: Partial<HostState>) {
    state = { ...state, ...patch };
    if (!disposed) onState(state);
  }
  function close() {
    generation += 1;
    bridge?.close(); bridge = undefined;
    update({ pane: null, message: "Pane closed. The session remains available for reconciliation." });
  }
  function initialize(): Promise<void> {
    initialized ??= (async () => {
      try {
        const raw = await storage.read();
        if (raw === null) { update({ blocked: false, message: "Ready" }); return; }
        const record: unknown = JSON.parse(raw);
        if (typeof record !== "object" || record === null || !("state" in record)) throw new Error("invalid record");
        if (record.state === "creating") {
          update({ active: true, blocked: true, message: "Previous session creation is unresolved. Reconcile with 0xramp before starting again." });
          return;
        }
        if (record.state !== "active" || !("session" in record)) throw new Error("invalid record");
        session = client.restoreSession(record.session as RampSession);
        update({ active: true, blocked: false, message: "Saved session available. Check status or resume." });
      } catch {
        update({ blocked: true, message: "Saved session could not be read safely. Restore secure storage before proceeding." });
      }
    })();
    return initialized;
  }
  function exclusive(run: () => Promise<void>) {
    const next = operation.then(async () => { await initialize(); if (!disposed) await run(); });
    operation = next.catch(() => {});
    return next;
  }
  async function refreshStatus(): Promise<void> {
    await initialize();
    if (disposed || session === undefined) return;
    if (statusRequest !== undefined) return statusRequest;
    const current = session;
    statusRequest = (async () => {
      try {
        const status = await client.getStatus(current.sessionRef);
        if (disposed || session !== current) return;
        if (status.outcome === "expired") {
          // Expiry is reversible in PSP-v1; late deposits still need recovery.
          close();
          update({ blocked: true, message: "Session expired. Reconcile late deposits before starting again." });
        } else if (status.terminal) {
          // Retain send-journal records; only the session pointer is cleared.
          close();
          update({ blocked: true });
          await storage.write(null);
          session = undefined;
          update({ active: false, blocked: false, message: `Authoritative status: ${status.outcome}` });
        } else update({ message: `Authoritative status: ${status.outcome}` });
      } catch {
        update({ message: "Status unavailable. Keep the saved session; do not send again." });
      }
    })().finally(() => { statusRequest = undefined; });
    return statusRequest;
  }
  function open(expectedGeneration: number) {
    if (disposed || generation !== expectedGeneration || session === undefined || state.blocked) return;
    if (state.pane !== null) return; // Resume while open must not replace an in-flight bridge.
    if (!client.isAllowedPaneUrl(session.sessionUrl)) throw new Error("origin refused");
    if (Date.parse(session.expiresAt) <= Date.now()) {
      update({ message: "Session URL expired. Check status; a new session requires reconciliation." });
      return;
    }
    bridge?.close();
    bridge = client.attachPaneBridge({
      sessionRef: session.sessionRef, transport,
      onZecSendRequest: wallet,
      onReady: () => update({ message: "Pane ready" }),
      onResult: () => { void refreshStatus(); },
      onSendRecoveryRequired: () => { update({ message: "Send needs reconciliation with wallet history. Do not send again." }); },
      onClose: close,
      onProtocolError: () => { close(); update({ message: "Bridge refused a message. Check status before resuming." }); },
    });
    update({ pane: { url: session.sessionUrl, sessionRef: session.sessionRef, generation }, message: "Opening 0xramp" });
  }
  return {
    initialize, close, refreshStatus,
    start(input: CreateSessionInput) {
      const expectedGeneration = generation;
      return exclusive(async () => {
        if (session !== undefined || state.active || state.blocked) return;
        if (!input.partnerSessionId) throw new Error("partnerSessionId is required for creation recovery");
        update({ active: true, blocked: true, message: "Creating session" });
        try {
          // A timeout may follow a successful POST. Persist intent before sending it.
          await storage.write(JSON.stringify({ state: "creating", partnerSessionId: input.partnerSessionId }));
          session = await client.createSession(input);
          await storage.write(JSON.stringify({ state: "active", session }));
          update({ blocked: false, message: "Session saved" });
          open(expectedGeneration);
        } catch {
          update({ blocked: true, message: "Session creation or storage is unresolved. Reconcile before retrying." });
        }
      });
    },
    resume() {
      const expectedGeneration = generation;
      return exclusive(async () => { await refreshStatus(); open(expectedGeneration); });
    },
    handleReturn(url: string) {
      // App owns scheme/host routing. Link claims never set the session outcome.
      try {
        const target = new URL(url);
        if (target.protocol !== "ramp-example:" || target.hostname !== "ramp") return;
        const parsed = client.parseReturnUrl(url);
        if (session !== undefined && parsed.sessionRef === session.sessionRef) void refreshStatus();
      } catch { /* malformed/unrelated link */ }
    },
    dispose() { disposed = true; close(); },
  };
}
