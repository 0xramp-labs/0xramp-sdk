/**
 * Ramp client — PSP-v1 channels 1 (session create), 4 (status), and the
 * host-side pane bridge factory (channel 3). Channel 5 parsing is included
 * for convenience.
 *
 * Security contract implemented here:
 * - status tickets are read-only bearer credentials and must be stored securely;
 * - logs are redacted by default (`sessionRef` hashed, tickets fully redacted);
 * - server responses are schema-validated before they reach host code;
 * - no keys, no signing, no money math.
 */
import {
  ApiError,
  ConfigError,
  NetworkUnavailableError,
  OriginLockViolationError,
  PartnerQuotaExceededError,
  PspError,
  SchemaViolationError,
} from "../protocol/errors.js";
import {
  parseCreateSessionRequest,
  parseCreateSessionResponse,
  parseSessionStatus,
  sessionRefSchema,
  statusTicketSchema,
} from "../protocol/schema.js";
import {
  redactSessionRef,
  redactStatusTicket,
  type CreateSessionRequestBody,
  type CreateSessionResponseBody,
  type RampAsset,
  type SessionDirection,
  type SessionStatusResponseBody,
} from "../protocol/types.js";
import {
  attachPaneBridge,
  type PaneBridge,
  type PaneBridgeHandlers,
  type PaneTransport,
} from "../bridge/bridge.js";
import { isAllowedPaneNavigation } from "../bridge/origin.js";
import type { ZecSendStore } from "../bridge/sendStore.js";
import { parseReturnUrl, type ParsedReturnUrl } from "./returnUrl.js";
import { PARTNER_SESSIONS_PATH, resolveApiBaseUrl, type SdkEnvironment } from "./environments.js";
export { parseReturnUrl };
export type { ParsedReturnUrl };

/** Cap on status tickets kept in memory (insertion-ordered eviction). */
const MAX_TRACKED_SESSIONS = 16;

/**
 * Redact the trailing sessionRef segment of a request path before it may
 * end up inside an error message (the redaction contract never surfaces
 * raw session refs, even to host code that logs errors).
 */
function redactedRequestPath(path: string): string {
  const prefix = `${PARTNER_SESSIONS_PATH}/`;
  if (path.startsWith(prefix)) {
    return `${PARTNER_SESSIONS_PATH}/${redactSessionRef(path.slice(prefix.length))}`;
  }
  return path;
}

/** Supported pane locales for the hosted ramp experience. */
export type RampLocale = "pt" | "en" | "es" | "hi" | "id";

export interface SdkLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface RampClientConfig {
  /** Deployment surface. Staging requires an explicit `apiBaseUrl`. */
  environment: SdkEnvironment;
  /** Public partner identifier, issued by 0xramp during onboarding. */
  partnerId: string;
  /** Override the API origin (mandatory for staging). Must be https, no path. */
  apiBaseUrl?: string;
  /** Explicit, exact HTTPS pane origins; custom API deployments default to their own origin. */
  paneOrigins?: readonly string[];
  /** Durable, wallet-scoped send journal, shared across bridge instances. */
  sendStore?: ZecSendStore;
  /** Network deadline; a failed create request must be reconciled, never retried automatically. */
  requestTimeoutMs?: number;
  /** Injectable fetch (defaults to globalThis.fetch). Provide in RN/Electron if needed. */
  fetch?: typeof fetch;
  /** Logger hook; receives redacted identifiers only. */
  logger?: SdkLogger;
  /** Preferred pane locale. */
  locale?: RampLocale;
}

export interface CreateSessionInput {
  direction: SessionDirection;
  asset: RampAsset;
  /** ISO 4217 code of a corridor 0xramp serves (server-authoritative). */
  fiat: string;
  /** Optional display-amount hint; the exact quote is always made inside 0xramp.app. */
  amountAsset?: string;
  /** BUY: transparent Zcash address where ZEC lands. */
  zecReceiver?: string;
  /** Optional deep-link back into the host app. Advisory; never trusted for money decisions. */
  returnUrl?: string;
  /** Optional host-side correlation id (echoed, never interpreted). */
  partnerSessionId?: string;
}

export interface RampSession {
  /** Load this URL in your WebView with navigation locked to 0xramp origins. */
  sessionUrl: string;
  sessionRef: string;
  /** Bearer for the read-only status endpoint. Treat as sensitive; never log raw. */
  statusTicket: string;
  /** ISO 8601 expiry of the session create offer. */
  expiresAt: string;
}

export interface SessionStatus {
  outcome: SessionStatusResponseBody["outcome"];
  terminal: boolean;
  zecTxids?: string[];
  fiat?: SessionStatusResponseBody["fiat"];
  updatedAt: string;
}

export interface GetStatusOptions {
  /** Explicit ticket (defaults to the one stored by `createSession`). */
  statusTicket?: string;
}

/** Options for `client.attachPaneBridge` — handlers plus your transport. */
export interface AttachPaneBridgeOptions extends PaneBridgeHandlers {
  /** Where bridge messages flow (postMessage/IPC adapter — see examples). */
  transport: PaneTransport;
  /**
   * Session to bind the bridge to. Defaults to the most recently created
   * session of this client. When unknown (standalone bridge usage), the
   * bridge binds to the first `psp/ready` it accepts and enforces the
   * match strictly from then on.
   */
  sessionRef?: string;
  sendStore?: ZecSendStore;
}

export interface RampClient {
  /** Channel 1 — open a ramp session (variant B: ticketed, stateful). */
  createSession(input: CreateSessionInput): Promise<RampSession>;
  /** Validate and restore a session from the host's secure storage. */
  restoreSession(session: RampSession): RampSession;
  /** The same exact origin policy used for create/restore; use for every WebView load. */
  isAllowedPaneUrl(url: string): boolean;
  /** Channel 4 — authoritative, read-only, ticketed status. */
  getStatus(sessionRef: string, options?: GetStatusOptions): Promise<SessionStatus>;
  /** Channel 3 — attach the host-side pane bridge to your transport. */
  attachPaneBridge(options: AttachPaneBridgeOptions): PaneBridge;
  /** Channel 5 — parse a return deep-link. Advisory only. */
  parseReturnUrl(url: string): ParsedReturnUrl;
}

interface StoredSession {
  statusTicket: string;
}

export function createRampClient(config: RampClientConfig): RampClient {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.partnerId)) {
    throw new PspError("ConfigError", "partnerId is malformed (expected 1–64 chars of [A-Za-z0-9_-])");
  }
  const { apiBaseUrl } = resolveApiBaseUrl(config.environment, config.apiBaseUrl);
  const timeoutMs = config.requestTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ConfigError("requestTimeoutMs must be an integer between 1 and 300000");
  }
  const configuredOrigins = config.paneOrigins ?? (config.apiBaseUrl === undefined ? undefined : [apiBaseUrl]);
  const paneOrigins = configuredOrigins?.map(origin => {
    let url: URL;
    try { url = new URL(origin); } catch { throw new ConfigError("invalid pane origin"); }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new ConfigError("paneOrigins must contain exact HTTPS origins");
    }
    return url.origin;
  });
  if (paneOrigins?.length === 0) throw new ConfigError("paneOrigins must not be empty");
  function isAllowedPaneUrl(value: string): boolean {
    if (paneOrigins === undefined) return isAllowedPaneNavigation(value);
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "" && paneOrigins.includes(url.origin);
    } catch { return false; }
  }
  const fetchImpl: typeof fetch | undefined =
    config.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchImpl !== "function") {
    throw new ConfigError("fetch is not available in this runtime — provide one via config.fetch");
  }
  const doFetch = fetchImpl.bind(globalThis);
  const logger = config.logger;
  const sessions = new Map<string, StoredSession>();
  let lastCreatedSessionRef: string | undefined;

  function rememberSession(raw: RampSession): RampSession {
    const parsed = parseCreateSessionResponse(raw);
    if (!parsed.ok) throw parsed.error;
    const session = parsed.value;
    if (!isAllowedPaneUrl(session.sessionUrl)) throw new OriginLockViolationError("session page is outside the configured pane origins");
    sessions.set(session.sessionRef, { statusTicket: session.statusTicket });
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    lastCreatedSessionRef = session.sessionRef;
    return session;
  }

  async function request<T>(
    path: string,
    init: RequestInit & { authTicket?: string },
    parse: (body: unknown) => { ok: true; value: T } | { ok: false; error: PspError },
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (init.authTicket !== undefined) {
      headers["authorization"] = `PartnerTicket v1.${init.authTicket}`;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new NetworkUnavailableError("hosted API request timed out; reconcile before retrying")); }, timeoutMs);
    });
    async function perform(): Promise<T> {
      const response = await doFetch(`${apiBaseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 429) throw new PartnerQuotaExceededError();
      if (!response.ok) throw new ApiError(response.status, `hosted API returned ${response.status} for ${redactedRequestPath(path)}`);
      let body: unknown;
      try { body = await response.json(); } catch { throw new SchemaViolationError("hosted API response was not valid JSON"); }
      const parsed = parse(body);
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    }
    try { return await Promise.race([perform(), deadline]); } catch (cause) {
      if (cause instanceof PspError) throw cause;
      throw new NetworkUnavailableError("could not reach the 0xramp hosted API; reconcile before retrying");
    } finally { clearTimeout(timer); }
  }

  return {
    async createSession(input: CreateSessionInput): Promise<RampSession> {
      const body: CreateSessionRequestBody = {
        partnerId: config.partnerId,
        direction: input.direction,
        asset: input.asset,
        fiat: input.fiat,
        ...(input.amountAsset !== undefined ? { amount: input.amountAsset } : {}),
        ...(input.zecReceiver !== undefined ? { zecReceiver: input.zecReceiver } : {}),
        ...(input.returnUrl !== undefined ? { returnUrl: input.returnUrl } : {}),
        ...(input.partnerSessionId !== undefined ? { partnerSessionId: input.partnerSessionId } : {}),
        ...(config.locale !== undefined ? { locale: config.locale } : {}),
      };
      const checked = parseCreateSessionRequest(body);
      if (!checked.ok) {
        throw checked.error;
      }
      const res = await request<CreateSessionResponseBody>(
        PARTNER_SESSIONS_PATH,
        { method: "POST", body: JSON.stringify(checked.value) },
        parseCreateSessionResponse,
      );
      rememberSession(res);
      logger?.info?.("partner session created", {
        sessionRef: redactSessionRef(res.sessionRef),
        expiresAt: res.expiresAt,
      });
      return res;
    },

    restoreSession: rememberSession,
    isAllowedPaneUrl,

    async getStatus(sessionRef: string, options?: GetStatusOptions): Promise<SessionStatus> {
      const ticket = options?.statusTicket ?? sessions.get(sessionRef)?.statusTicket;
      if (ticket === undefined) {
        throw new PspError(
          "ConfigError",
          "no status ticket available for this sessionRef — pass one via options.statusTicket",
        );
      }
      if (!sessionRefSchema.safeParse(sessionRef).success || !statusTicketSchema.safeParse(ticket).success) {
        throw new ConfigError("invalid session reference or status ticket");
      }
      const res = await request<SessionStatusResponseBody>(
        `${PARTNER_SESSIONS_PATH}/${encodeURIComponent(sessionRef)}`,
        { method: "GET", authTicket: ticket },
        parseSessionStatus,
      );
      logger?.debug?.("partner session status", {
        sessionRef: redactSessionRef(sessionRef),
        ticket: redactStatusTicket(ticket),
        outcome: res.outcome,
        terminal: res.terminal,
      });
      return {
        outcome: res.outcome,
        terminal: res.terminal,
        ...(res.zecTxids !== undefined ? { zecTxids: res.zecTxids } : {}),
        ...(res.fiat !== undefined ? { fiat: res.fiat } : {}),
        updatedAt: res.updatedAt,
      };
    },

    attachPaneBridge(options: AttachPaneBridgeOptions): PaneBridge {
      const { transport, sessionRef = lastCreatedSessionRef, sendStore = config.sendStore, ...handlers } = options;
      if (options.sessionRef === undefined && sessionRef !== undefined) {
        logger?.debug?.("no sessionRef given — binding the bridge to the most recently created session", {
          sessionRef: redactSessionRef(sessionRef),
        });
      }
      return attachPaneBridge({
        transport,
        handlers,
        ...(sessionRef !== undefined ? { sessionRef } : {}),
        logger,
        ...(sendStore !== undefined ? { sendStore } : {}),
      });
    },

    parseReturnUrl(url: string): ParsedReturnUrl {
      return parseReturnUrl(url);
    },
  };
}
