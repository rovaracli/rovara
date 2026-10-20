// Task 1 of the agents plan: what an unchanged Rovara Code does, recorded before anything changes. Each scenario below
// is recorded by tests/support/golden-recorder.ts and compared with its fixture in tests/fixtures/rovara-code-golden.
// Fixtures are written only with UPDATE_GOLDEN=1, and SHA256SUMS (made with `shasum -a 256`) pins them: a later task never
// re-records, and a change it means to make is listed in `deliberate` with the plan's item number.
import { createHash } from "node:crypto";
import type * as NodeCrypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GOLDEN_FIXTURE_DIRECTORY, GOLDEN_SCENARIOS, expectGolden, recordGolden, updatingGolden } from "../support/golden-recorder.js";
import { loadSlackBroker } from "../support/slack-broker.js";

// Every id the broker and the worker make comes from randomUUID; the recorder seeds a sequence per scenario.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  const { goldenUuid } = await import("../support/golden-ids.js");
  return { ...actual, randomUUID: goldenUuid, default: { ...actual, randomUUID: goldenUuid } };
});

// The hash of SHA256SUMS itself, so the list of fixture hashes cannot be edited in the same breath as a fixture. A change
// to this value is a re-record: it needs the per-path attribution and the Opus review that PF4 requires of a Plan 2 merge.
const SHA256SUMS_SHA256 = "b006ba1c6be019c8527a175b8afec654d9921f23d0df48609892fdd8a1397737";

beforeAll(async () => { await loadSlackBroker(); });

describe("Rovara Code before agents", () => {
  for (const scenario of GOLDEN_SCENARIOS) {
    it(`${scenario} matches its golden fixture`, async () => {
      expectGolden(scenario, await recordGolden(scenario));
    }, 120_000);
  }

  it("expectGolden accepts a changed path only when it is listed with its exact new value", () => {
    if (updatingGolden()) return;
    const stored = JSON.parse(readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, "implement.json"), "utf8")) as { invocation: { payload: Record<string, unknown> }; modelAccess: { mintKeyCalls: Array<Record<string, unknown>> } };
    const changed = structuredClone(stored);
    changed.modelAccess.mintKeyCalls[0] = { ...changed.modelAccess.mintKeyCalls[0], maxBudgetUsd: 6, models: ["alias"] };
    const listed = [
      { path: "modelAccess.mintKeyCalls[0].maxBudgetUsd", expected: 6, change: 1 as const },
      { path: "modelAccess.mintKeyCalls[0].models", expected: ["alias"], change: 2 as const },
    ];
    expect(() => expectGolden("implement", stored)).not.toThrow();
    expect(() => expectGolden("implement", changed)).toThrow();
    expect(() => expectGolden("implement", changed, listed)).not.toThrow();
    expect(() => expectGolden("implement", changed, [{ ...listed[0]!, expected: 7 }, listed[1]!])).toThrow();
    expect(() => expectGolden("implement", changed, [listed[0]!])).toThrow();
    // A listed path that should be absent fails when the record has it, and an unlisted change elsewhere still fails.
    expect(() => expectGolden("implement", stored, [{ path: "invocation.payload.prompt", expected: undefined, change: 5 }])).toThrow();
    const other = structuredClone(stored);
    other.invocation.payload.prompt = "Something else";
    expect(() => expectGolden("implement", other, listed)).toThrow();
  });

  it("fixture files match the SHA-256 values committed in Task 1", () => {
    if (updatingGolden()) return;
    expect(createHash("sha256").update(readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, "SHA256SUMS"))).digest("hex"), "SHA256SUMS").toBe(SHA256SUMS_SHA256);
    const sums = readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => {
      const [sha256, path] = line.split(/\s+/);
      return [basename(path ?? ""), sha256] as const;
    });
    const files = readdirSync(GOLDEN_FIXTURE_DIRECTORY).filter((name) => name.endsWith(".json")).sort();
    expect(sums.map(([name]) => name).sort()).toEqual(files);
    expect(files).toEqual(GOLDEN_SCENARIOS.map((scenario) => `${scenario}.json`).sort());
    for (const [name, sha256] of sums) {
      expect(createHash("sha256").update(readFileSync(join(GOLDEN_FIXTURE_DIRECTORY, name))).digest("hex"), name).toBe(sha256);
    }
  });
});
