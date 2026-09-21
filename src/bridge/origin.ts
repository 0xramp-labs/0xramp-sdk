/**
 * Origin-lock helpers.
 *
 * The pane is first-party `0xramp.app` content. Hosts must:
 * 1. lock WebView navigation to 0xramp origins (this module's allowlist), and
 * 2. never obscure the origin (no wrapping in partner domains, no hiding).
 *
 * React Native WebView `postMessage` carries no origin — bridge messages are
 * only trusted while the navigation lock invariant holds. Platform recipes:
 * RN `onShouldStartLoadWithRequest` + frame blocking; Electron
 * `will-navigate` / `setWindowOpenHandler` + frame ancestry checks.
 */
import { OriginLockViolationError } from "../protocol/errors.js";

/** Allowed navigation hosts: the 0xramp origin and its subdomains (https only). */
export const ALLOWED_PANE_HOST_SUFFIXES: readonly string[] = ["0xramp.app"];

/** Check a URL against the 0xramp navigation allowlist (https, exact host or subdomain). */
export function isAllowedPaneNavigation(url: string, allowedSuffixes: readonly string[] = ALLOWED_PANE_HOST_SUFFIXES): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Check an Origin header / origin string against the allowlist. */
export function isAllowedPaneOrigin(origin: string, allowedSuffixes: readonly string[] = ALLOWED_PANE_HOST_SUFFIXES): boolean {
  return isAllowedPaneNavigation(origin, allowedSuffixes);
}

/** Guarded variant used by adapters that must hard-abort on drift. */
export function assertAllowedPaneNavigation(url: string, allowedSuffixes?: readonly string[]): void {
  if (!isAllowedPaneNavigation(url, allowedSuffixes)) {
    throw new OriginLockViolationError(`navigation to non-0xramp origin is not allowed: ${truncate(url)}`);
  }
}

function truncate(value: string): string {
  return value.length > 128 ? `${value.slice(0, 128)}…` : value;
}
