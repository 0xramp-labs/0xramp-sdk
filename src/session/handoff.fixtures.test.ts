/**
 * Draft-vector gate for the browser-hosted handoff codec.
 *
 * Loads `fixtures/psp-v1/draft/` — deliberately a subdirectory, invisible to
 * the frozen fixture parity loader (`src/protocol/fixtures.test.ts` reads
 * only top-level `*.json`). These vectors are UNFROZEN, excluded from the
 * PSP-v1 `0.1.0` conformance set, and claim no pane-side conformance; see
 * `fixtures/psp-v1/draft/README.md`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PspError } from "../protocol/errors.js";
import {
  buildZecSendResumeUrl,
  parseZecSendHandoffUrl,
  type ZecSendResumeEvidence,
} from "./handoff.js";

interface DraftFixture {
  kind: string;
  name: string;
  data: {
    url: string;
    parse?: { sessionRef: string };
    evidence?: ZecSendResumeEvidence;
    expected: Record<string, unknown> | string;
  };
}

const DRAFT_DIR = fileURLToPath(new URL("../../fixtures/psp-v1/draft/", import.meta.url));

function loadDraftFixtures(): { file: string; fixture: DraftFixture }[] {
  return readdirSync(DRAFT_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      fixture: JSON.parse(readFileSync(join(DRAFT_DIR, file), "utf8")) as DraftFixture,
    }));
}

function expectErrorCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PspError);
    expect((error as PspError).code).toBe(code);
    return;
  }
  throw new Error(`expected the draft vector to fail closed with code ${code}`);
}

describe("PSP-v1 draft handoff vectors (unfrozen)", () => {
  const fixtures = loadDraftFixtures();

  it("discovers the draft vector set", () => {
    const names = fixtures.map((f) => f.file);
    expect(names).toContain("handoff.canonical.json");
    expect(names).toContain("handoff.memo-scheme.json");
    expect(names).toContain("handoff.negative-amount.json");
    expect(names).toContain("handoff.negative-mismatch.json");
    expect(names).toContain("resume.canonical.json");
    expect(names).toContain("resume.negative-hex.json");
  });

  for (const { file, fixture } of fixtures) {
    it(`validates ${file} (${fixture.kind})`, () => {
      const { url, parse, evidence, expected } = fixture.data;
      const expectedError =
        typeof expected === "object" && expected !== null && "error" in expected
          ? (expected as { error: string }).error
          : undefined;

      if (fixture.kind === "draft.zec-send-handoff") {
        if (expectedError !== undefined) {
          expectErrorCode(() => parseZecSendHandoffUrl(url, parse), expectedError);
        } else {
          expect(parseZecSendHandoffUrl(url, parse)).toEqual(expected);
        }
        return;
      }
      if (fixture.kind === "draft.zec-send-resume") {
        if (expectedError !== undefined) {
          expectErrorCode(() => buildZecSendResumeUrl(url, evidence ?? {}), expectedError);
        } else {
          expect(typeof expected).toBe("string");
          expect(buildZecSendResumeUrl(url, evidence ?? {})).toBe(expected);
        }
        return;
      }
      throw new Error(`unknown draft fixture kind: ${fixture.kind}`);
    });
  }
});
