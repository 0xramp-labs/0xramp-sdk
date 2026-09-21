/**
 * Golden fixture parity — the core conformance gate (PSP-v1).
 *
 * Every fixture in `fixtures/psp-v1/` must validate against the SDK schemas.
 * The pane side of 0xramp.app runs the same set; a release ships only when
 * both sides pass. Fixtures are synthetic — no real addresses, tickets, or PII.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseCreateSessionRequest,
  parseCreateSessionResponse,
  parseHostToPaneMessage,
  parsePaneToHostMessage,
  parseSessionStatus,
  type ParseResult,
} from "./schema.js";
import { parseReturnUrl } from "../session/returnUrl.js";

interface FixtureFile {
  kind: string;
  name: string;
  data: unknown;
}

const FIXTURES_DIR = new URL("../../fixtures/psp-v1/", import.meta.url).pathname;

function loadFixtures(): { file: string; fixture: FixtureFile }[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json");
  files.sort();
  return files.map((file) => ({
    file,
    fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as FixtureFile,
  }));
}

function unwrap<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.error.message}`);
  return result.value;
}

describe("PSP-v1 golden fixture parity", () => {
  const fixtures = loadFixtures();

  it("discovers the full fixture set", () => {
    const names = fixtures.map((f) => f.file);
    expect(names).toContain("bridge.psp-ready.json");
    expect(names).toContain("bridge.psp-zec-send-request.json");
    expect(names).toContain("bridge.psp-zec-send-result.json");
    expect(names).toContain("bridge.psp-zec-send-cancel.json");
    expect(names).toContain("bridge.psp-result.json");
    expect(names).toContain("bridge.psp-close.json");
    expect(names).toContain("api.create-session-request.json");
    expect(names).toContain("api.create-session-response.json");
    expect(names).toContain("api.session-status-response.json");
    expect(names).toContain("return-url.canonical.json");
  });

  for (const { file, fixture } of loadFixtures()) {
    it(`validates ${file} (${fixture.kind})`, () => {
      switch (fixture.kind) {
        case "bridge.pane-to-host": {
          const msg = unwrap(parsePaneToHostMessage(fixture.data));
          expect(msg.v).toBe(1);
          break;
        }
        case "bridge.host-to-pane": {
          const msg = unwrap(parseHostToPaneMessage(fixture.data));
          expect(msg.v).toBe(1);
          break;
        }
        case "api.request": {
          const body = unwrap(parseCreateSessionRequest(fixture.data));
          expect(body.partnerId.length).toBeGreaterThan(0);
          break;
        }
        case "api.response": {
          if ("sessionUrl" in (fixture.data as object)) {
            const res = unwrap(parseCreateSessionResponse(fixture.data));
            expect(res.sessionUrl.startsWith("https://")).toBe(true);
          } else {
            const status = unwrap(parseSessionStatus(fixture.data));
            expect(typeof status.terminal).toBe("boolean");
          }
          break;
        }
        case "return-url": {
          const vector = fixture.data as { url: string; expected: Record<string, unknown> };
          const parsed = parseReturnUrl(vector.url);
          expect(parsed.sessionRef).toBe(vector.expected["sessionRef"]);
          expect(parsed.outcome).toBe(vector.expected["outcome"]);
          expect(parsed.claimsTerminal).toBe(vector.expected["claimsTerminal"]);
          break;
        }
        default:
          throw new Error(`unknown fixture kind: ${fixture.kind}`);
      }
    });
  }
});
