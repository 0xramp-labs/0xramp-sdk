/**
 * `@0xramp/sdk/session` — partner session client: `createRampClient`
 * (channels 1 & 4 + bridge factory), environment resolution, and return
 * deep-link parsing (channel 5, advisory).
 */
export {
  createRampClient,
  type AttachPaneBridgeOptions,
  type CreateSessionInput,
  type GetStatusOptions,
  type RampClient,
  type RampClientConfig,
  type RampLocale,
  type RampSession,
  type SessionStatus,
  type SdkLogger,
} from "./client.js";
export {
  PARTNER_SESSIONS_PATH,
  PRODUCTION_API_BASE_URL,
  resolveApiBaseUrl,
  type ResolvedEnvironment,
  type SdkEnvironment,
} from "./environments.js";
export { parseReturnUrl, type ParsedReturnUrl } from "./returnUrl.js";
