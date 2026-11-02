// Company setup recipes and the host ask (SH30 wiring, switch `sp`), through the whole broker: what the run reports using is intersected with what the broker sent (SR-3), and the host ask only marks a host the company
// already approved through a recipe the project's setup used. A mark grants nothing.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionCardsViewSchema, projectPk, type DecisionCard, type TestEnvDraft } from "@agentx/contracts";
import { requestHostAsk } from "../../packages/broker/src/rovara-code/setup-host-ask.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { companyApprovedHostMarks } from "../../packages/broker/src/org/setup-recipe-host-marks.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { NAME, draftBody, draftOf, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

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
const marks = (t: Bench) => companyApprovedHostMarks({ documentClient: t.db, tableName: "state", now: () => Date.now() }, { orgId: TEST_ORG, project: NAME, cloud: true });

describe("host marks: a list, never a grant", () => {
  it("marks the hosts of a recipe the run was offered AND reported using, read again now", async () => {
    const t = await bench();
    const one = await createRecipe(t, "Python services", [HOST]);
    await t.drafted(citing(one));
    expect([...(await marks(t)).keys()]).toEqual([HOST]);
    expect((await marks(t)).get(HOST)).toMatchObject({ source: `recipe:${one.recipeId}@${String(one.revision)}`, staffApprovalRequired: true });
    // Revoked since: nothing.
    await t.web(OMAR, "POST", PATH, { action: "revoke", recipeId: one.recipeId, expectedRevision: one.revision });
    expect([...(await marks(t)).keys()]).toEqual([]);
  });

  it("a recipe the broker did not offer this run contributes nothing, even if the report names it and it is approved and in scope", async () => {
    const t = await bench();
    const offered = await createRecipe(t, "Python services", ["pypi.internal.example.com"]);
    let late: { recipeId: string; revision: number } | undefined;
    await t.drafted(citing(offered, { recipeId: "rcp_" + "9".repeat(20), revision: 1 }), { whileRunning: async () => { late = await createRecipe(t, "Added after dispatch", [HOST]); } });
    // `late` exists, is approved and in scope, but was not sent: the report cannot choose it. (Its source is added below to the stored draft the way a confused worker would.)
    const task = lastTask(t);
    const stored = t.db.get({ pk: projectPk(TEST_ORG, NAME), sk: `TESTENV#DRAFT#${task.taskId}` })!;
    const draft = stored.draft as TestEnvDraft;
    t.db.set({ ...stored, draft: { ...draft, valueSources: [...draft.valueSources, { field: "repos[0].setupCommands[2]", source: `recipe:${late!.recipeId}@${String(late!.revision)}` }] } });
    expect([...(await marks(t)).keys()]).toEqual(["pypi.internal.example.com"]);
  });

  it("no marks without sp, and none for a project whose setup used no recipe", async () => {
    const t = await bench();
    const one = await createRecipe(t, "Python services", [HOST]);
    await t.drafted(citing());
    expect([...(await marks(t)).keys()]).toEqual([]);
    await t.drafted(citing(one));
    delete process.env.SETUP_RECIPES_ENABLED;
    expect([...(await marks(t)).keys()]).toEqual([]);
  });

  it("the website card says the company already approved the host, and a host the recipe did not list gets no such line; pressing still decides", async () => {
    const t = await bench();
    await t.person(OMAR, "owner");
    const one = await createRecipe(t, "Python services", [HOST]);
    await t.drafted(citing(one));
    const TASK = randomUUID();
    t.db.set({ ...taskKey(TASK), entityType: "DEVTASK", taskId: TASK, orgId: TEST_ORG, project: NAME, purpose: "setup_agent", developerId: OMAR.developerId });
    for (const host of [HOST, "other.internal-build.io"]) {
      const asked = await requestHostAsk({ documentClient: t.db, tableName: "state", now: () => Date.now() }, { orgId: TEST_ORG, project: NAME, host, taskId: TASK, projectDomains: [] });
      expect(asked.outcome).toBe("created");
    }
    const reply = await t.dev(MAYA, "GET", "/v1/app/decisions");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const { requestId: _gateway, ...own } = reply.body; void _gateway;
    const cards = DecisionCardsViewSchema.parse(own).cards.filter((card: DecisionCard) => card.kind === "setup_host");
    const byHost = (host: string) => cards.find((card) => card.evidence.some((chip) => chip.label === "Website" && chip.value === host))!;
    expect(byHost(HOST).evidence.find((chip) => chip.label === "Your company")).toMatchObject({ value: "Approved in a company recipe; Rovara staff still approve it" });
    expect(byHost("other.internal-build.io").evidence.find((chip) => chip.label === "Your company")).toBeUndefined();
    // Nothing is approved by the mark: the ask is still open and the project's websites are unchanged.
    const ask = t.db.get({ pk: projectPk(TEST_ORG, NAME), sk: `SETUP_HOST_ASK#${HOST}` });
    expect(ask).toMatchObject({ state: "open" });
  });
});
