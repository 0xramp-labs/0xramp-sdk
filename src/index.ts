/**
 * `@0xramp/sdk` — root entry. Re-exports the full v0 host surface:
 * `createRampClient`, pane bridge, PSP-v1 protocol, units.
 *
 * Subpath exports partition the surface (`/protocol`, `/session`, `/bridge`,
 * `/units`); prefer the narrowest import that covers your use.
 */

// Root surface: the client factory plus the bridge (used together).
export { createRampClient } from "./session/client.js";
export type {
  RampClient,
  RampClientConfig,
  RampSession,
  CreateSessionInput,
  SessionStatus,
  GetStatusOptions,
  AttachPaneBridgeOptions,
  SdkLogger,
  RampLocale,
} from "./session/client.js";
export { parseReturnUrl } from "./session/returnUrl.js";
export type { ParsedReturnUrl } from "./session/returnUrl.js";
export { PRODUCTION_API_BASE_URL } from "./session/environments.js";
export type { SdkEnvironment } from "./session/environments.js";

export {
  attachPaneBridge,
  type PaneBridge,
  type PaneBridgeHandlers,
  type PaneBridgeOptions,
  type PaneBridgeStats,
  type PaneTransport,
  type ZecSendOutcome,
  createZecSendStore,
  createMemoryZecSendStore,
  type ZecSendStore,
  type ZecSendStorage,
  type ZecSendRecord,
} from "./bridge/index.js";
export {
  assertAllowedPaneNavigation,
  isAllowedPaneNavigation,
  isAllowedPaneOrigin,
  ALLOWED_PANE_HOST_SUFFIXES,
} from "./bridge/index.js";

export * from "./protocol/index.js";
export * from "./units/index.js";
