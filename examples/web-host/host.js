/**
 * Platform-independent popup-mode lifecycle for a web host.
 *
 * Popup mode is bridge-less (partner guide §9): create → open → return link →
 * authoritative status. There is no pane bridge and no wallet callback here —
 * the SDK never signs, and in this mode the host is not in the signing path.
 * Contract mirrors examples/react-native-host/host.ts so the two references
 * stay reviewable side by side.
 */

/** @typedef {import("@0xramp/sdk").RampClient} RampClient */
/** @typedef {import("@0xramp/sdk").RampSession} RampSession */
/** @typedef {import("@0xramp/sdk").CreateSessionInput} CreateSessionInput */

/**
 * @typedef {object} SessionStorage
 * @property {() => Promise<string | null>} read
 * @property {(value: string | null) => Promise<void>} write
 */

/**
 * @typedef {object} PaneHandle
 * @property {() => void} [close]
 */

/**
 * @typedef {object} HostState
 * @property {string} message
 * @property {boolean} active
 * @property {boolean} blocked
 * @property {boolean} popupOpen
 */

/**
 * @param {object} options
 * @param {RampClient} options.client
 * @param {SessionStorage} options.storage
 * @param {(url: string) => PaneHandle | null} options.openPane Must validate
 *        the URL with `client.isAllowedPaneUrl` semantics before opening; the
 *        controller re-checks via the client as belt-and-braces.
 * @param {(url: string) => boolean} options.ownsReturnUrl The host owns
 *        returnUrl routing (guide §9); the controller never guesses.
 * @param {(state: HostState) => void} options.onState
 */
export function createWebPartnerHost({ client, storage, openPane, ownsReturnUrl, onState }) {
  /** @type {RampSession | undefined} */
  let session;
  /** @type {PaneHandle | null} */
  let pane = null;
  let disposed = false;
  let initialized;
  let operation = Promise.resolve();
  /** @type {Promise<void> | undefined} */
  let statusRequest;
  /** @type {HostState} */
  let state = { message: "Loading saved session", active: false, blocked: true, popupOpen: false };

  function update(patch) {
    state = { ...state, ...patch };
    if (!disposed) onState(state);
  }
  function closePane() {
    try { pane?.close?.(); } catch { /* popup already gone */ }
    pane = null;
    if (state.popupOpen) update({ popupOpen: false });
  }
  function initialize() {
    initialized ??= (async () => {
      try {
        const raw = await storage.read();
        if (raw === null) { update({ blocked: false, message: "Ready" }); return; }
        const record = JSON.parse(raw);
        if (typeof record !== "object" || record === null || !("state" in record)) throw new Error("invalid record");
        if (record.state === "creating") {
          update({ active: true, blocked: true, message: "Previous session creation is unresolved. Reconcile with 0xramp before starting again." });
          return;
        }
        if (record.state !== "active" || !("session" in record)) throw new Error("invalid record");
        session = client.restoreSession(record.session);
        update({ active: true, blocked: false, message: "Saved session available. Check status or resume." });
      } catch {
        update({ blocked: true, message: "Saved session could not be read safely. Restore secure storage before proceeding." });
      }
    })();
    return initialized;
  }
  function exclusive(run) {
    const next = operation.then(async () => { await initialize(); if (!disposed) await run(); });
    operation = next.catch(() => {});
    return next;
  }
  async function refreshStatus() {
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
          closePane();
          update({ blocked: true, message: "Session expired. Reconcile late deposits before starting again." });
        } else if (status.terminal) {
          closePane();
          update({ blocked: true });
          await storage.write(null);
          session = undefined;
          update({ active: false, blocked: false, message: `Authoritative status: ${status.outcome}` });
        } else {
          update({ message: `Authoritative status: ${status.outcome}` });
        }
      } catch {
        update({ message: "Status unavailable. Keep the saved session; do not send again." });
      }
    })().finally(() => { statusRequest = undefined; });
    return statusRequest;
  }
  function open() {
    if (disposed || session === undefined || state.blocked) return;
    if (state.popupOpen) return; // Resume while open must not replace the in-flight popup.
    if (!client.isAllowedPaneUrl(session.sessionUrl)) {
      update({ blocked: true, message: "Pane origin refused. Reconcile with 0xramp before continuing." });
      return;
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      update({ message: "Session URL expired. Check status; a new session requires reconciliation." });
      return;
    }
    closePane();
    pane = openPane(session.sessionUrl);
    update({ popupOpen: pane !== null, message: "0xramp opened in a popup. Return link or status check resumes." });
  }
  return {
    initialize,
    refreshStatus,
    /** Call when the user closes the popup themselves. */
    onPopupClosed() {
      if (state.popupOpen) update({ popupOpen: false, message: "Popup closed by user. Check status before starting again." });
    },
    /**
     * Advisory only: link claims never set the session outcome. The host owns
     * returnUrl routing; this must be called only for URLs the host routed.
     * @param {string} url
     */
    handleReturn(url) {
      if (!ownsReturnUrl(url)) return;
      let parsed;
      try { parsed = client.parseReturnUrl(url); } catch { return; }
      if (session !== undefined && parsed.sessionRef === session.sessionRef) void refreshStatus();
    },
    /**
     * @param {CreateSessionInput} input
     * @returns {Promise<void>}
     */
    start(input) {
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
          open();
        } catch {
          // The POST is unresolved server-side; keep the intent for reconciliation.
          update({ blocked: true, message: "Session creation or storage is unresolved. Reconcile before retrying." });
        }
      });
    },
    resume() {
      return exclusive(async () => { await refreshStatus(); open(); });
    },
    dispose() {
      disposed = true;
      closePane();
    },
  };
}
