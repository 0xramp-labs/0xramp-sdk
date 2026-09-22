/**
 * Environment → API base mapping.
 *
 * The SDK ships exactly one built-in base URL: the public production origin.
 * Staging (and any sandbox/custom deployment) is issued by 0xramp during
 * partner onboarding and must be passed explicitly via `apiBaseUrl` — the
 * SDK never invents endpoint lists.
 */
import { ConfigError } from "../protocol/errors.js";

export type SdkEnvironment = "production" | "staging";

export const PRODUCTION_API_BASE_URL = "https://0xramp.app";

/** Partner session surface (PSP-v1 channels 1 & 4). */
export const PARTNER_SESSIONS_PATH = "/api/partner/v0/sessions";

export interface ResolvedEnvironment {
  apiBaseUrl: string;
}

export function resolveApiBaseUrl(
  environment: SdkEnvironment,
  apiBaseUrlOverride?: string,
): ResolvedEnvironment {
  if (apiBaseUrlOverride !== undefined) {
    return { apiBaseUrl: normalizeBaseUrl(apiBaseUrlOverride) };
  }
  if (environment === "production") {
    return { apiBaseUrl: PRODUCTION_API_BASE_URL };
  }
  throw new ConfigError(
    'environment "staging" requires an explicit apiBaseUrl (issued by 0xramp during onboarding)',
  );
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("apiBaseUrl is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("apiBaseUrl must use https");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ConfigError("apiBaseUrl must be an origin without credentials, query, or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError("apiBaseUrl must not include a path");
  }
  return url.origin;
}
