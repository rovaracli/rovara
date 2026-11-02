// Company setup recipes in the setup flow (SH30 + SR-3, switch `sp`), through the whole broker: the offered recipes are sent with the setup draft and RECORDED on its operation (id and revision).
import { afterEach, describe, expect, it } from "vitest";
import { setupLocksKey, type TestEnvDraft } from "@agentx/contracts";
import { dynamoSetupLocksStore } from "../../packages/broker/src/rovara-code/setup-locks-store.js";
import { companyLocksReaderFor } from "../../packages/broker/src/org/setup-recipe-locks.js";
import type { CompanySetupLocks } from "../../packages/broker/src/org/setup-recipes.js";
import { TEST_ORG } from "../support/orgs.js";
import { createSetupRecipesNegotiationRecorder } from "../../packages/broker/src/aws/dispatcher.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { draftBody, draftOf, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

const SWITCHES = ["SETUP_RECIPES_ENABLED", "TEST_ENVIRONMENT_ENABLED", "SETUP_AGENT_ENABLED", "DECISION_CARDS_ENABLED"] as const;
afterEach(() => { for (const name of SWITCHES) delete process.env[name]; });
const allOn = () => { for (const name of SWITCHES) process.env[name] = "1"; };
const PATH = "/v1/app/org/setup-recipes";
const HOST = "artifactory.internal-build.io";
const cmd = (executable: string, args: string[] = []) => ({ cwd: "{repo}", executable, args, timeoutSeconds: 600 });
const recipeBody = (label: string, hosts: string[], image?: string, marker = "pyproject.toml") => ({
  schemaVersion: 1, label, ...(image === undefined ? {} : { devcontainerBaseImage: image }), buildSystems: ["python"], toolchains: [], setupCommands: [cmd("uv", ["sync", "--frozen"])], updateCommands: [],
  checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }], approvedHosts: hosts, match: { markerFiles: [marker], registryHosts: [] },
});

const auditOf = new WeakMap<Bench, ReturnType<typeof capturingAuditDeps>>();
async function bench() {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  audit.audit.documentClient = t.db as never;
  auditOf.set(t, audit);
  await t.person(MAYA, "admin");
  allOn();
  return t;
}
/** The company's locks, written the way su-musts' own store writes them (its audit item included). */
async function setLocks(t: Bench, locks: CompanySetupLocks): Promise<void> {
  const store = dynamoSetupLocksStore({ documentClient: t.db, tableName: "state", now: Date.now, audit: auditOf.get(t)!.audit });
  const at = new Date().toISOString();
  const written = await store.commitLocks({ orgId: TEST_ORG, revision: 1, locks, updatedBy: OMAR.developerId, updatedAt: at }, null,
    { action: "locks_changed", orgId: TEST_ORG, actor: OMAR.developerId, at, proof: "fresh_sign_in", revision: 1, previousDigest: "0".repeat(64), nextDigest: "1".repeat(64), loosened: false }, []);
  expect(written).toBe(true);
}
async function createRecipe(t: Bench, label: string, hosts: string[], image?: string, marker?: string): Promise<{ recipeId: string; revision: number }> {
  const made = await t.web(OMAR, "POST", PATH, { action: "create", body: recipeBody(label, hosts, image, marker) });
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

describe("an older worker (F7)", () => {
  it("the recorder forgets the operation's offered recipes and only those", async () => {
    const t = await bench();
    const one = await createRecipe(t, "Python services", [HOST]);
    await t.drafted(citing(one));
    const operation = setupOperation(t);
    expect(operation.setupRecipeOffers).toEqual([one]);
    const record = { workspaceId: lastTask(t).workspaceId, operationId: operation.id } as never;
    await createSetupRecipesNegotiationRecorder({ documentClient: t.db as never, tableName: "state" })(record);
    expect(setupOperation(t)).not.toHaveProperty("setupRecipeOffers");
    expect(setupOperation(t)).toMatchObject({ id: operation.id, workflowMode: "SETUP_DRAFT" });
    await createSetupRecipesNegotiationRecorder({ documentClient: t.db as never, tableName: "state" })(record);
  });
});

const PYTHON_312 = "mcr.microsoft.com/devcontainers/python:3.12";
const PYTHON_313 = "mcr.microsoft.com/devcontainers/python:3.13";

describe("the company's dev container lock reads through su-musts' store", () => {
  it("the reader is always there: a missing reader would mean 'no lock'", async () => {
    const t = await bench();
    const reader = companyLocksReaderFor({ documentClient: t.db, tableName: "state" });
    expect(typeof reader.getCompanySetupLocks).toBe("function");
    expect(await reader.getCompanySetupLocks(TEST_ORG)).toBeUndefined();
    await setLocks(t, { devcontainerImages: [PYTHON_312] });
    expect(await reader.getCompanySetupLocks(TEST_ORG)).toEqual({ devcontainerImages: [PYTHON_312] });
  });

  it("a devcontainerImages lock filters what a setup draft is offered, and what is recorded on the operation", async () => {
    const t = await bench();
    const allowed = await createRecipe(t, "Allowed image", [HOST], PYTHON_312);
    const blocked = await createRecipe(t, "Other image", [HOST], PYTHON_313, "go.mod");
    const plain = await createRecipe(t, "No image", [HOST], undefined, "Cargo.toml");
    await t.drafted(citing());
    expect((setupOperation(t).setupRecipeOffers as unknown[]).length).toBe(3);
    await setLocks(t, { devcontainerImages: [PYTHON_312] });
    await t.drafted(citing(allowed));
    const operation = setupOperation(t);
    const ids = (operation.setupRecipeOffers as Array<{ recipeId: string }>).map((offer) => offer.recipeId).sort();
    expect(ids).toEqual([allowed.recipeId, plain.recipeId].sort());
    expect(ids).not.toContain(blocked.recipeId);
    expect(payloadOf(t, operation.id).testEnvRecipes?.map((offer) => offer.recipeId).sort()).toEqual(ids);
  });

  it("offers nothing while the locks row cannot be read (never 'no lock')", async () => {
    const t = await bench();
    await createRecipe(t, "Allowed image", [HOST], PYTHON_312);
    await setLocks(t, { devcontainerImages: [PYTHON_312] });
    const row = t.db.get(setupLocksKey(TEST_ORG))!;
    t.db.set({ ...row, locks: { devcontainerImages: "not a list" } });
    await t.drafted(citing());
    expect(setupOperation(t)).not.toHaveProperty("setupRecipeOffers");
    expect(payloadOf(t, setupOperation(t).id)).not.toHaveProperty("testEnvRecipes");
  });
});

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

