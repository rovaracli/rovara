// Task 1 of the agents plan: what an unchanged Rovara Code does, recorded before anything changes. Each scenario below
// is recorded by tests/support/golden-recorder.ts and compared with its fixture in tests/fixtures/rovara-code-golden.
// Fixtures are written only with UPDATE_GOLDEN=1, and SHA256SUMS (made with `shasum -a 256`) pins them: a later task never
// re-records, and a change it means to make is listed in `deliberate` with the plan's item number.
import { createHash } from "node:crypto";
import type * as NodeCrypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENTS } from "../../packages/contracts/src/agent-templates.js";
import { recipeDigest } from "../../packages/contracts/src/agent-recipe.js";
import { GOLDEN_FIXTURE_DIRECTORY, GOLDEN_SCENARIOS, expectGolden, recordGolden, updatingGolden, type GoldenScenario } from "../support/golden-recorder.js";
import { loadSlackBroker } from "../support/slack-broker.js";

// Every id the broker and the worker make comes from randomUUID; the recorder seeds a sequence per scenario.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  const { goldenUuid } = await import("../support/golden-ids.js");
  return { ...actual, randomUUID: goldenUuid, default: { ...actual, randomUUID: goldenUuid } };
});

// The hash of SHA256SUMS itself, so the list of fixture hashes cannot be edited in the same breath as a fixture. A change
// to this value is a re-record: it needs the per-path attribution and the Opus review that PF4 requires of a Plan 2 merge.
const SHA256SUMS_SHA256 = "3b29f748b9fb372ece9eecd541b80cb97feac4047d09d77cdc39c58cb95667e7";

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

// Plan 3 Task 15: with the agents switched on, a start that names no agent runs Rovara Code at the org's pinned version and records it. The only
// differences from the fixtures are change 5's paths: the task's `agent`, `origin`, `payer`, `place` and `startedBy`, the `tags` of each model key minted, and the RECIPE item beside the task.
/** The paths of the `tags` on every model proxy key the record shows minting (a mint call has a `purpose` and a `refId`), with the tags. */
function mintTagPaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && "purpose" in here && "refId" in here && "tags" in here) found.push({ path: `${path}.tags`, value: here.tags });
  for (const [key, child] of Object.entries(here)) found.push(...mintTagPaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}

/**
 * Plan 3 Task 31: with agents set up a minted key is recorded on the operation as well as the task (change 3), so the operation as the record shows it ends with
 * the ids of its keys. Every operation in the record that has them, with the path of its `modelKeyIds`.
 */
function operationKeyPaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && here.entityType === "OPERATION" && Array.isArray(here.modelKeyIds)) found.push({ path: `${path}.modelKeyIds`, value: here.modelKeyIds });
  for (const [key, child] of Object.entries(here)) found.push(...operationKeyPaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}

/**
 * Plan 3 Task 26: with agents set up every key is scoped to the model its operation runs on (change 2: the key's `models`), and the operation records the route
 * it was built with (change 5: records gain fields). Rovara's default model is served by Rovara itself under its own catalog id, so the invocation carries no
 * `modelRoute`. The paths of the `models` on every key the record shows minting, and of the `modelRoute` on every operation that has one.
 */
function mintModelPaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && "purpose" in here && "refId" in here && "tags" in here && "models" in here) found.push({ path: `${path}.models`, value: here.models });
  for (const [key, child] of Object.entries(here)) found.push(...mintModelPaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}
function operationRoutePaths(record: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (record === null || typeof record !== "object") return [];
  const here = record as Record<string, unknown>;
  const found: Array<{ path: string; value: unknown }> = [];
  if (!Array.isArray(record) && here.entityType === "OPERATION" && "modelRoute" in here) found.push({ path: `${path}.modelRoute`, value: here.modelRoute });
  for (const [key, child] of Object.entries(here)) found.push(...operationRoutePaths(child, Array.isArray(record) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`));
  return found;
}
const ROVARA_DEFAULT = "us.anthropic.claude-sonnet-4-6";

describe("Rovara Code with agents switched on", () => {
  const STARTS: GoldenScenario[] = [
    "plan-quick", "plan-full-requirements", "plan-review-decision", "implement", "checks", "review", "task-no-workflow", "task-no-workflow-no-proxy", "shared-task", "plan-ready-quick",
  ];
  const latest = BUILTIN_AGENTS["rovara-code"].versions.at(-1)!;

  for (const scenario of STARTS) {
    it(`${scenario} differs from its golden fixture only by the task's agent, origin, payer, place, the keys' tags, the operation's key ids and the RECIPE item`, async () => {
      if (updatingGolden()) return;
      const record = await recordGolden(scenario, { brokerExtra: { agents: {} } });
      const items = record.taskItems as Array<Record<string, unknown>>;
      const recipe = items.filter((item) => item.sk === "RECIPE");
      expect(recipe).toHaveLength(1);
      expect(recipe[0]).toMatchObject({ digest: recipeDigest(latest.recipe), recipe: latest.recipe });
      const kept = items.filter((item) => item.sk !== "RECIPE");
      const meta = kept.findIndex((item) => item.sk === "META");
      // Plan 3 Task 29: the task records its payer and place, and every key minted for it carries the tags that say so (change 5: records gain fields).
      const payer = { kind: "member", developerId: (kept[meta] as { developerId: string }).developerId };
      const tagged = mintTagPaths(record);
      for (const { value } of tagged) {
        expect(value).toMatchObject({ agentId: "rovara-code", project: "payments", payerKind: "member", payerId: payer.developerId, source: "rovara", origin: "cli" });
      }
      expectGolden(scenario, { ...record, taskItems: kept }, [
        { path: `taskItems[${String(meta)}].agent`, expected: { agentId: "rovara-code", name: "Rovara Code", version: latest.version, builtin: true, digest: recipeDigest(latest.recipe) }, change: 5 },
        { path: `taskItems[${String(meta)}].origin`, expected: "cli", change: 5 },
        { path: `taskItems[${String(meta)}].payer`, expected: payer, change: 5 },
        { path: `taskItems[${String(meta)}].place`, expected: { project: "payments" }, change: 5 },
        { path: `taskItems[${String(meta)}].startedBy`, expected: { developerId: payer.developerId }, change: 5 },
        ...tagged.map(({ path, value }) => ({ path, expected: value, change: 5 as const })),
        ...operationKeyPaths(record).map(({ path, value }) => ({ path, expected: value, change: 3 as const })),
        // Task 26, change 2: with the default order (Rovara only) a key may call Rovara's default model and nothing else, and it says so by value.
        ...mintModelPaths(record).map(({ path }) => ({ path, expected: [ROVARA_DEFAULT], change: 2 as const })),
        // Change 5: the operation says where its model comes from. The invocation is unchanged: it carries no `modelRoute`.
        ...operationRoutePaths(record).map(({ path }) => ({ path, expected: { sourceId: "rovara", alias: ROVARA_DEFAULT, model: { provider: "amazon-bedrock", modelId: ROVARA_DEFAULT } }, change: 5 as const })),
      ]);
      for (const sent of [record.invocation, record.forWorker] as Array<{ payload?: Record<string, unknown> } | null>) expect(sent?.payload ?? {}).not.toHaveProperty("modelRoute");
    }, 120_000);
  }
});
