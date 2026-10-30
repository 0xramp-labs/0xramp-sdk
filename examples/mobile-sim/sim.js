/**
 * 0xramp mobile-sim — wallet-app controller for the browser phone harness
 * (`examples/mobile-sim/sim.html`).
 *
 * Plays a Zingo-like wallet hosting the 0xramp pane in both v0 hosting
 * shapes: "webview" (iframe pane + postMessage bridge, mirroring
 * `examples/react-native-host/host.ts`) and "browser" (bridge-less popup,
 * mirroring `examples/web-host/host.js`), plus an OS deep-link router for
 * the registered pilot scheme (`zingo://0xramp`): advisory return links and
 * the DRAFT zec-send handoff/resume codec (`parseZecSendHandoffUrl` /
 * `buildZecSendResumeUrl` — unfrozen; pane-side conformance not claimed).
 *
 * Sandbox data is synthetic only. In live mode the simulated wallet never
 * fakes a broadcast: it declines sends, and status stays authoritative.
 */

/** @typedef {import("@0xramp/sdk").RampClient} RampClient */
/** @typedef {import("@0xramp/sdk").RampSession} RampSession */
/** @typedef {import("@0xramp/sdk").CreateSessionInput} CreateSessionInput */
/** @typedef {import("@0xramp/sdk").PaneBridge} PaneBridge */
/** @typedef {import("@0xramp/sdk").PaneTransport} PaneTransport */
/** @typedef {import("@0xramp/sdk").ZecSendOutcome} ZecSendOutcome */
/** @typedef {import("@0xramp/sdk").ZecSendRequestPayload} ZecSendRequestPayload */
/** @typedef {import("@0xramp/sdk").ParsedZecSendHandoff} ParsedZecSendHandoff */

/**
 * Client facade: the SDK client plus the draft handoff codec the router uses.
 * @typedef {RampClient & {
 *   parseZecSendHandoffUrl(url: string, expected: { sessionRef: string }): ParsedZecSendHandoff;
 *   buildZecSendResumeUrl(baseUrl: string, evidence: { txid?: string; txids?: string[] }): string;
 * }} SimClient
 */

/** @typedef {{ read(): Promise<string | null>; write(value: string | null): Promise<void>; }} SessionStorage */

/** @typedef {{ close?: () => void }} PaneHandle */

/**
 * @typedef {object} SimHostState
 * @property {string} message
 * @property {boolean} active
 * @property {boolean} blocked
 * @property {{ url: string; sessionRef: string } | null} pane
 * @property {string | null} resumeUrl Advisory wallet → pane resume link (DRAFT codec), when built.
 */

/**
 * @param {object} options
 * @param {SimClient} options.client
 * @param {SessionStorage} options.storage
 * @param {import("@0xramp/sdk").ZecSendStore} options.sendStore
 * @param {PaneTransport} options.transport WebView-mode bridge transport; unused in browser mode.
 * @param {(request: ZecSendRequestPayload, context: { signal: AbortSignal }) => Promise<ZecSendOutcome> | ZecSendOutcome} options.wallet
 * @param {(url: string) => PaneHandle | null} options.openPane Must validate with `client.isAllowedPaneUrl` semantics; the controller re-checks.
 * @param {"webview" | "browser"} options.paneMode
 * @param {string} options.returnUrl Registered pilot return scheme, e.g. "zingo://0xramp".
 * @param {(state: SimHostState) => void} options.onState
 */
export function createSimWalletHost({
  client, storage, sendStore, transport, wallet, openPane, paneMode, returnUrl, onState,
}) {
  /** @type {RampSession | undefined} */
  let session;
  /** @type {PaneBridge | undefined} */
  let bridge;
  /** @type {PaneHandle | null} */
  let pane = null;
  let disposed = false;
  let initialized;
  let operation = Promise.resolve();
  /** @type {Promise<void> | undefined} */
  let statusRequest;
  const controller = new AbortController();
  const scheme = (() => { try { return new URL(returnUrl).protocol; } catch { return null; } })();
  /** @type {SimHostState} */
  let state = { message: "Loading saved session", active: false, blocked: true, pane: null, resumeUrl: null };

  function update(patch) {
    state = { ...state, ...patch };
    if (!disposed) onState(state);
  }
  function closePane() {
    bridge?.close(); bridge = undefined;
    try { pane?.close?.(); } catch { /* pane already gone */ }
    pane = null;
    update({ pane: null, message: "Pane closed. The session remains available for reconciliation." });
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
  function attachBridge() {
    return client.attachPaneBridge({
      sessionRef: session.sessionRef, transport,
      sendStore,
      onZecSendRequest: wallet,
      onReady: () => update({ message: "Pane ready" }),
      onResult: () => { void refreshStatus(); },
      onSendRecoveryRequired: (payload) => update({ message: `Send needs reconciliation (${payload.reason}). Do not send again.` }),
      onClose: closePane,
      onProtocolError: () => { closePane(); update({ message: "Bridge refused a message. Check status before resuming." }); },
    });
  }
  function open() {
    if (disposed || session === undefined || state.blocked) return;
    if (state.pane !== null) return; // Resume while open must not replace an in-flight pane.
    if (!client.isAllowedPaneUrl(session.sessionUrl)) {
      update({ blocked: true, message: "Pane origin refused. Reconcile with 0xramp before continuing." });
      return;
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      update({ message: "Session URL expired. Check status; a new session requires reconciliation." });
      return;
    }
    closePane();
    if (paneMode === "webview") bridge = attachBridge();
    pane = openPane(session.sessionUrl);
    update({
      pane: { url: session.sessionUrl, sessionRef: session.sessionRef },
      message: paneMode === "webview" ? "Opening 0xramp in the WebView (pane)" : "Opening 0xramp in the system browser (pane)",
    });
  }
  function replyFor(sessionRef, requestId, outcome) {
    if (outcome !== null && typeof outcome === "object" && "txid" in outcome && typeof outcome.txid === "string") {
      return { v: 1, type: "psp/zec-send-result", sessionRef, payload: { requestId, txid: outcome.txid } };
    }
    return { v: 1, type: "psp/zec-send-cancel", sessionRef, payload: { requestId, reason: (outcome && typeof outcome === "object" && "reason" in outcome && typeof outcome.reason === "string") ? outcome.reason : "user declined" } };
  }
  /** Deep-link handoff (DRAFT codec) — claim/journal semantics identical to the bridge path. */
  async function runHandoff(request) {
    const current = session;
    if (current === undefined) return;
    let previous;
    try {
      previous = await sendStore.claim(current.sessionRef, request);
    } catch {
      update({ message: "Handoff could not be journaled. Reconcile before proceeding." });
      return;
    }
    if (previous !== undefined) {
      const recorded = previous.reply !== undefined ? previous.reply.type : "in-progress";
      update({ message: `Handoff replayed for request ${request.requestId} — recorded outcome: ${recorded}. Never send again.` });
      return;
    }
    let outcome;
    try {
      outcome = await wallet(request, { signal: controller.signal });
    } catch {
      update({ message: "Wallet send failed with an unresolved state. Reconcile with wallet history; do not send again." });
      return;
    }
    const reply = replyFor(current.sessionRef, request.requestId, outcome);
    try {
      await sendStore.complete(current.sessionRef, request, reply);
    } catch {
      update({ message: "Send outcome could not be persisted. Reconcile before retrying." });
      return;
    }
    if (reply.type === "psp/zec-send-result") {
      const resumeUrl = client.buildZecSendResumeUrl(current.sessionUrl, { txid: reply.payload.txid });
      update({ resumeUrl, message: `Send recorded (advisory txid). Resume link ready: ${resumeUrl}` });
    } else {
      update({ message: `Send declined (${reply.payload.reason}) — nothing broadcast. The pane reconciles via status.` });
    }
  }
  return {
    initialize,
    refreshStatus,
    closePane,
    sessionRef() { return session?.sessionRef ?? null; },
    /** OS routing: only the app's own registered scheme is delivered by the system. */
    handleDeepLink(url) {
      let target;
      try { target = new URL(url); } catch { update({ message: "Deep-link dropped: unparseable." }); return false; }
      if (scheme === null || target.protocol !== scheme) {
        update({ message: `Deep-link ignored: ${target.protocol || "unknown"} is not this app's registered scheme.` });
        return false;
      }
      if (target.searchParams.has("requestId")) {
        if (session === undefined) { update({ message: "Handoff ignored: no active session." }); return false; }
        try {
          const handoff = client.parseZecSendHandoffUrl(url, { sessionRef: session.sessionRef });
          void runHandoff(handoff);
          return true;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "InvalidLink";
          update({ message: `Handoff refused (${code}). The wallet stays safe; nothing was sent.` });
          return false;
        }
      }
      try {
        const parsed = client.parseReturnUrl(url);
        if (session !== undefined && parsed.sessionRef === session.sessionRef) { void refreshStatus(); return true; }
        update({ message: "Return link does not match the active session. Status is the receipt, not the link." });
        return false;
      } catch {
        update({ message: "Return link dropped: malformed (advisory anyway — status stays authoritative)." });
        return false;
      }
    },
    /** @param {CreateSessionInput} input @returns {Promise<void>} */
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
    dispose() { disposed = true; controller.abort(); closePane(); },
  };
}

/**
 * Sandbox client facade: synthetic session + scripted status against the
 * sandbox pane, with the real bridge and codecs attached. No 0xramp access.
 *
 * @param {object} options
 * @param {Pick<import("@0xramp/sdk").RampClient, "attachPaneBridge" | "parseReturnUrl"> &
 *   { parseZecSendHandoffUrl: SimClient["parseZecSendHandoffUrl"]; buildZecSendResumeUrl: SimClient["buildZecSendResumeUrl"] }} options.sdk
 * @param {string} options.sandboxPaneUrl
 * @param {string} [options.sessionRef]
 */
export function createSandboxClient({ sdk, sandboxPaneUrl, sessionRef = "sessSIMDEMO0000001" }) {
  const url = new URL(sandboxPaneUrl);
  url.searchParams.set("sessionRef", sessionRef);
  const paneOrigin = url.origin;
  const session = {
    sessionUrl: url.toString(),
    sessionRef,
    statusTicket: "sandbox-ticket-not-real",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  let statusCalls = 0;
  const outcomes = ["created", "user-active", "settled"];
  return {
    createSession: async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return session; },
    restoreSession: (saved) => saved,
    isAllowedPaneUrl: (value) => { try { return new URL(value).origin === paneOrigin; } catch { return false; } },
    getStatus: async () => {
      const outcome = outcomes[Math.min(statusCalls++, outcomes.length - 1)];
      return { outcome, terminal: outcome === "settled", updatedAt: new Date().toISOString() };
    },
    attachPaneBridge: (options) => {
      const { transport, sessionRef: ref = sessionRef, sendStore, ...handlers } = options;
      return sdk.attachPaneBridge({
        transport, handlers,
        ...(ref !== undefined ? { sessionRef: ref } : {}),
        ...(sendStore !== undefined ? { sendStore } : {}),
      });
    },
    parseReturnUrl: (value) => sdk.parseReturnUrl(value),
    parseZecSendHandoffUrl: (value, expected) => sdk.parseZecSendHandoffUrl(value, expected),
    buildZecSendResumeUrl: (base, evidence) => sdk.buildZecSendResumeUrl(base, evidence),
  };
}
