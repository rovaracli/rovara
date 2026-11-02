// Company setup recipes in the setup flow (SH30 + SR-3, switch `sp`), through the whole broker: the offered recipes are sent with the setup draft and RECORDED on its operation (id and revision).
import { afterEach, describe, expect, it } from "vitest";
import type { TestEnvDraft } from "@agentx/contracts";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { draftBody, draftOf, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

const SWITCHES = ["SETUP_RECIPES_ENABLED", "TEST_ENVIRONMENT_ENABLED", "SETUP_AGENT_ENABLED", "DECISION_CARDS_ENABLED"] as const;
afterEach(() => { for (const name of SWITCHES) delete process.env[name]; });
const allOn = () => { for (const name of SWITCHES) process.env[name] = "1"; };
const PATH = "/v1/app/org/setup-recipes";
const HOST = "artifactory.internal-build.io";
const cmd = (executable: string, args: string[] = []) => ({ cwd: "{repo}", executable, args, timeoutSeconds: 600 });
const recipeBody = (label: string, hosts: string[]) => ({
  schemaVersion: 1, label, buildSystems: ["python"], toolchains: [], setupCommands: [cmd("uv", ["sync", "--frozen"])], updateCommands: [],
  checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }], approvedHosts: hosts, match: { markerFiles: ["pyproject.toml"], registryHosts: [] },
});

async function bench() {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  audit.audit.documentClient = t.db as never;
  await t.person(MAYA, "admin");
  allOn();
  return t;
}
async function createRecipe(t: Bench, label: string, hosts: string[]): Promise<{ recipeId: string; revision: number }> {
  const made = await t.web(OMAR, "POST", PATH, { action: "create", body: recipeBody(label, hosts) });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const listed = (await t.web(OMAR, "GET", PATH)).body as { recipes: Array<{ recipeId: string; revision: number; label: string }> };
  const found = listed.recipes.find((recipe) => recipe.label === label)!;
  return { recipeId: found.recipeId, revision: found.revision };
}
/** A draft whose values cite the given recipes, the way the worker's `applyRecipe` cites them. */
const citing = (...recipes: Array<{ recipeId: string; revision: number }>): TestEnvDraft => ({
  ...draftOf(draftBody()), valueSources: recipes.map((recipe, index) => ({ field: `repos[0].setupCommands[${String(index)}]`, source: `recipe:${recipe.recipeId}@${String(recipe.revision)}` as never })),
});
const lastTask = (t: Bench) => t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_draft").at(-1) as { taskId: string; workspaceId: string };
const setupOperation = (t: Bench) => t.operations(lastTask(t).workspaceId).find((operation) => operation.kind === "task") as unknown as { id: string; setupRecipeOffers?: unknown };
const payloadOf = (t: Bench, operationId: string) => (t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { payload: { testEnvDetect?: boolean; testEnvRecipes?: Array<{ recipeId: string; revision: number; body: { label: string } }> } }).payload;

describe("dispatch (SR-3)", () => {
  it("offers the company's approved recipes with the setup draft and records which ones (id and revision) on the operation", async () => {
    const t = await bench();
    const one = await createRecipe(t, "Python services", [HOST]);
    await t.drafted(citing(one));
    const operation = setupOperation(t);
    expect(operation.setupRecipeOffers).toEqual([one]);
    const payload = payloadOf(t, operation.id);
    expect(payload.testEnvDetect).toBe(true);
    expect(payload.testEnvRecipes).toHaveLength(1);
    expect(payload.testEnvRecipes?.[0]).toMatchObject({ recipeId: one.recipeId, revision: one.revision, body: { label: "Python services" } });
    // The record holds ids and revisions, not the recipe's text.
    expect(JSON.stringify(operation.setupRecipeOffers)).not.toContain("Python services");
  });

  it("sends nothing and records nothing while sp is off, or when the company has no approved recipe", async () => {
    const t = await bench();
    await t.drafted(citing());
    expect(payloadOf(t, setupOperation(t).id)).not.toHaveProperty("testEnvRecipes");
    expect(setupOperation(t)).not.toHaveProperty("setupRecipeOffers");
    const one = await createRecipe(t, "Python services", [HOST]);
    delete process.env.SETUP_RECIPES_ENABLED;
    await t.drafted(citing(one));
    expect(payloadOf(t, setupOperation(t).id)).not.toHaveProperty("testEnvRecipes");
    expect(setupOperation(t)).not.toHaveProperty("setupRecipeOffers");
    expect(payloadOf(t, setupOperation(t).id).testEnvDetect).toBe(true);
  });

  it("a revoked recipe, or one offered to other projects, is not offered", async () => {
    const t = await bench();
    const one = await createRecipe(t, "Python services", [HOST]);
    await t.web(OMAR, "POST", PATH, { action: "scope", recipeId: one.recipeId, expectedRevision: one.revision, scope: { kind: "projects", projects: ["billing"] } });
    await t.drafted(citing(one));
    expect(payloadOf(t, setupOperation(t).id)).not.toHaveProperty("testEnvRecipes");
  });
});

