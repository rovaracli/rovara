// Company setup recipes (SH29 wiring, switch `sp`), through the whole broker with live browser sessions: share from a project's approved setup, list, create, approve, revoke, scope. (The company locks are su-musts'.) Everything is browser-only and audited; with `sp` off none of it exists.
import { afterEach, describe, expect, it } from "vitest";
import { recipeOffersForProject } from "../../packages/broker/src/org/setup-recipe-offers.js";
import { recipeDepsOf, routeSetupRecipes } from "../../packages/broker/src/aws/developer-routes/setup-recipes.js";
import { dynamoSetupRecipeStore } from "../../packages/broker/src/org/setup-recipe-store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR, type Developer } from "../support/developer-task-broker.js";
import { NAME, command, draftBody, draftOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.SETUP_RECIPES_ENABLED; delete process.env.TEST_ENVIRONMENT_ENABLED; });
const PATH = "/v1/app/org/setup-recipes";
const SHARE = `/v1/app/projects/${NAME}/setup-recipe`;
const on = () => { process.env.SETUP_RECIPES_ENABLED = "1"; };
const cmd = (executable: string, args: string[] = [], cwd = "{repo}") => ({ cwd, executable, args, timeoutSeconds: 600 });
const recipeBody = (changes: Record<string, unknown> = {}) => ({
  schemaVersion: 1, label: "Python services", buildSystems: ["python"], toolchains: [{ tool: "python", version: "3.12" }], setupCommands: [cmd("uv", ["sync", "--frozen"])], updateCommands: [],
  checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }], approvedHosts: ["pypi.internal.example.com"],
  match: { markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"] }, ...changes,
});
async function bench(options: { maya?: "admin" | "member"; grant?: "viewer" | "contributor" | "maintainer" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya !== undefined) await t.person(MAYA, options.maya, options.grant);
  return { t, audit };
}
const events = (audit: ReturnType<typeof capturingAuditDeps>, prefix: string) => audit.recorded().filter((event) => event.action.startsWith(prefix));
const get = (t: Bench, who: Developer = OMAR) => t.web(who, "GET", PATH);
const post = (t: Bench, body: unknown, who: Developer = OMAR) => t.web(who, "POST", PATH, body);
interface RecipeRow { recipeId: string; revision: number; digest: string; status: string; label: string }
const list = async (t: Bench, who: Developer = OMAR) => (await get(t, who)).body as unknown as { recipes: RecipeRow[]; projects: string[] };
const offers = (t: Bench) => recipeOffersForProject({ store: dynamoSetupRecipeStore({ documentClient: t.db, tableName: "state", now: Date.now }) }, { orgId: TEST_ORG, project: NAME });

describe("behind sp", () => {
  it("every path is not found unless the switch is exactly 1, and nothing is stored", async () => {
    const { t } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) delete process.env.SETUP_RECIPES_ENABLED; else process.env.SETUP_RECIPES_ENABLED = value;
      expect((await get(t)).status, String(value)).toBe(404);
      expect((await post(t, { action: "create", body: recipeBody() })).status).toBe(404);
      expect((await t.web(OMAR, "POST", SHARE, {})).status).toBe(404);
    }
    expect(t.db.find((item) => String(item.sk).startsWith("SETUP_RECIPE"))).toEqual([]);
  });
});

describe("who may", () => {
  it("a token is refused for reads and writes; a member in a browser cannot list or write; nothing is stored or audited", async () => {
    const { t, audit } = await bench({ maya: "member" });
    on();
    for (const [method, body] of [["GET", undefined], ["POST", { action: "create", body: recipeBody() }]] as const) {
      const token = await t.dev(OMAR, method, PATH, body);
      expect(token.status).toBe(403);
      expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    }
    expect((await t.dev(OMAR, "POST", SHARE, {})).status).toBe(403);
    expect((await get(t, MAYA)).status).toBe(403);
    const member = await post(t, { action: "create", body: recipeBody() }, MAYA);
    expect(member.status).toBe(403);
    expect(t.db.find((item) => String(item.sk).startsWith("SETUP_RECIPE"))).toEqual([]);
    expect(events(audit, "setup_")).toEqual([]);
  });

  it("refuses a body that is not one of the actions, with field names only", async () => {
    const { t } = await bench();
    on();
    expect((await post(t, { action: "approve", recipeId: "nope" })).status).toBe(400);
    expect((await post(t, { action: "create", body: recipeBody(), extra: 1 })).status).toBe(400);
    expect((await post(t, { action: "shrug" })).status).toBe(400);
  });
});

describe("an admin writes, scopes and revokes a recipe", () => {
  it("creates an approved recipe with a fresh sign-in, shows what it runs, audits ids only, and offers it to the company's projects", async () => {
    const { t, audit } = await bench();
    on();
    const made = await post(t, { action: "create", body: recipeBody() });
    expect(made, JSON.stringify(made.body)).toMatchObject({ status: 200, body: { status: "done" } });
    const [recipe] = (await list(t)).recipes;
    expect(recipe).toMatchObject({ status: "approved", revision: 1, label: "Python services", setup: [{ line: "{repo}: uv sync --frozen", timeoutSeconds: 600 }], approvedHosts: ["pypi.internal.example.com"], scope: { kind: "company" }, createdByYou: true });
    expect((await offers(t)).map((offer) => offer.recipeId)).toEqual([recipe!.recipeId]);
    const [event] = events(audit, "setup_recipe.created");
    expect(event).toMatchObject({ actor: { id: OMAR.developerId }, facts: { recipeId: recipe!.recipeId, revision: 1, authority: "fresh_sign_in" } });
    expect(JSON.stringify(event)).not.toContain("pypi.internal");
  });

  it("refuses a recipe without a fresh sign-in (asked to sign in again) and stores nothing", async () => {
    const { t, audit } = await bench();
    on();
    for (const minutes of [11, undefined]) {
      t.ageSignIn(OMAR, minutes);
      const stale = await post(t, { action: "create", body: recipeBody() });
      expect(stale.status, JSON.stringify(stale.body)).toBe(403);
      expect(JSON.stringify(stale.body)).toContain("REAUTH_REQUIRED");
    }
    t.ageSignIn(OMAR, 9);
    expect((await list(t)).recipes).toEqual([]);
    expect(events(audit, "setup_recipe.")).toEqual([]);
    expect((await post(t, { action: "create", body: recipeBody() })).status).toBe(200);
  });

  it("refuses a recipe that holds a secret, a refused host, or a repository's name", async () => {
    const { t } = await bench();
    on();
    const token = ["g", "hp_"].join("") + "a".repeat(36);
    for (const changes of [
      { setupCommands: [cmd("pip", ["install", "--index-url", `https://user:${token}@pypi.internal.example.com/simple`])] },
      { approvedHosts: ["raw.githubusercontent.com"] },
      { label: "web setup" },
    ]) expect((await post(t, { action: "create", body: recipeBody(changes) })).status).toBe(400);
    expect((await list(t)).recipes).toEqual([]);
  });

  it("sets 'offer only to these projects', then revokes: an offer follows the scope and the status, and each change is audited with its revision", async () => {
    const { t, audit } = await bench();
    on();
    await post(t, { action: "create", body: recipeBody() });
    const [created] = (await list(t)).recipes;
    const scoped = await post(t, { action: "scope", recipeId: created!.recipeId, expectedRevision: 1, scope: { kind: "projects", projects: ["billing"] } });
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(await offers(t)).toEqual([]);
    expect((await post(t, { action: "scope", recipeId: created!.recipeId, expectedRevision: 1, scope: { kind: "company" } })).status).toBe(409);
    expect((await post(t, { action: "scope", recipeId: created!.recipeId, expectedRevision: 2, scope: { kind: "projects", projects: [NAME] } })).status).toBe(200);
    expect((await offers(t)).map((offer) => offer.recipeId)).toEqual([created!.recipeId]);
    expect((await post(t, { action: "revoke", recipeId: created!.recipeId, expectedRevision: 3 })).status).toBe(200);
    expect(await offers(t)).toEqual([]);
    // Revoked is history: out of the live list, kept by id in its own partition.
    expect((await list(t)).recipes).toEqual([]);
    expect(await dynamoSetupRecipeStore({ documentClient: t.db, tableName: "state", now: Date.now }).getRecipe(TEST_ORG, created!.recipeId)).toMatchObject({ status: "revoked", revision: 4 });
    expect(events(audit, "setup_recipe.").map((event) => `${event.action}@${String(event.facts?.revision)}`)).toEqual(["setup_recipe.created@1", "setup_recipe.scope_changed@2", "setup_recipe.scope_changed@3", "setup_recipe.revoked@4"]);
  });
});

describe("share as company recipe", () => {
  /** Omar approves the project's environment; Maya is a maintainer of the project. */
  async function withApprovedSetup() {
    const made = await bench({ maya: "member", grant: "maintainer" });
    await withSwitch("1", async () => { await made.t.approveFirst(draftOf(draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("uv", ["sync"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("pytest", ["-q"], 1800), kind: "test" }] }] }))); });
    on();
    return made;
  }
  const share = (t: Bench, body: Record<string, unknown> = {}, who: Developer = MAYA) => t.web(who, "POST", SHARE, {
    repositoryId: "web", label: "Python services", buildSystems: ["python"], toolchains: [{ tool: "python", version: "3.12" }], markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"], ...body,
  });

  it("a maintainer's share is stored as proposed and offered to nobody; the admin approves exactly what they saw, and then it is offered", async () => {
    const { t, audit } = await withApprovedSetup();
    // The project's own allowed websites: only a host among them can be shared.
    const rows = t.db.find((item) => item.entityType === "PROJECT" && (item.definition as { name?: string }).name === NAME) as Array<{ definition: { revision: number } }>;
    const row = rows.sort((a, b) => b.definition.revision - a.definition.revision)[0]!;
    t.db.set({ ...row, definition: { ...row.definition, network: { allowedDomains: ["pypi.internal.example.com"] } } });
    const shared = await share(t, { approvedHosts: ["pypi.internal.example.com", "other.example.com"] });
    expect(shared, JSON.stringify(shared.body)).toMatchObject({ status: 200, body: { status: "proposed", revision: 1 } });
    expect(await offers(t)).toEqual([]);
    const [recipe] = (await list(t)).recipes;
    expect(recipe).toMatchObject({ status: "proposed", fromProject: true, approvedHosts: ["pypi.internal.example.com"], setup: [{ line: "{repo}: uv sync", timeoutSeconds: 900 }], createdByYou: false });
    expect(JSON.stringify(recipe)).not.toContain("repo/web");
    expect(events(audit, "setup_recipe.proposed")[0]).toMatchObject({ actor: { id: MAYA.developerId }, facts: { authority: "project_maintainer" } });
    // The same share twice answers the first one.
    expect((await share(t, { approvedHosts: ["pypi.internal.example.com", "other.example.com"] })).body).toMatchObject({ recipeId: recipe!.recipeId });
    expect((await list(t)).recipes).toHaveLength(1);
    // A different digest, or revision, is stale.
    expect((await post(t, { action: "approve", recipeId: recipe!.recipeId, expectedRevision: 1, expectedDigest: "0".repeat(64) })).status).toBe(409);
    expect((await post(t, { action: "approve", recipeId: recipe!.recipeId, expectedRevision: 1, expectedDigest: recipe!.digest })).status).toBe(200);
    expect((await offers(t)).map((offer) => offer.recipeId)).toEqual([recipe!.recipeId]);
    expect((await list(t)).recipes[0]).toMatchObject({ status: "approved", revision: 2 });
    expect(events(audit, "setup_recipe.approved")[0]).toMatchObject({ actor: { id: OMAR.developerId }, facts: { revision: 2, authority: "fresh_sign_in" } });
  });

  it("is refused for a viewer and a contributor, and for a project with no approved environment; nothing is stored", async () => {
    const viewer = await bench({ maya: "member", grant: "viewer" });
    on();
    expect((await share(viewer.t)).status).toBe(403);
    const none = await bench({ maya: "member", grant: "maintainer" });
    const noEnv = await share(none.t);
    expect(noEnv.status).toBe(400);
    expect(JSON.stringify(noEnv.body)).toContain("no approved test environment");
    expect(none.t.db.find((item) => String(item.sk).startsWith("SETUP_RECIPE"))).toEqual([]);
  });

  it("refuses a share that names the repository, or a repository the project does not have", async () => {
    const { t } = await withApprovedSetup();
    expect((await share(t, { label: "acme web setup" })).status).toBe(400);
    expect((await share(t, { repositoryId: "other" })).status).toBe(400);
    expect((await list(t)).recipes).toEqual([]);
  });
});

describe("company locks are not this lane's (F1)", () => {
  it("has no lock actions and writes or reads no locks row of its own", async () => {
    const { t } = await bench({ maya: "admin" });
    on();
    for (const body of [{ action: "locks_set", locks: { setupAgentOff: true }, expectedRevision: null }, { action: "locks_approve", expectedRevision: 1, expectedDigest: "1".repeat(64) }]) expect((await post(t, body)).status).toBe(400);
    const state = await get(t);
    expect(state.status).toBe(200);
    expect(state.body).not.toHaveProperty("locks");
    expect(t.db.find((item) => String(item.sk) === "SETUP_LOCKS" || String(item.sk).includes("LOCKS"))).toEqual([]);
  });
});

describe("what the admin sees before approving (F2, F4)", () => {
  const full = recipeBody({
    updateCommands: [cmd("uv", ["lock", "--check"])],
    checks: [
      { id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test", selectArgs: ["-k", "{tests}"], reportPath: "{repo}/reports/junit.xml", coveragePath: "{repo}/reports/coverage.xml" },
      { id: "scan", label: "Security scan", command: cmd("semgrep", ["scan", "--sarif"], "{repo}/tools"), kind: "security", sarifPath: "{repo}/reports/scan.sarif" },
    ],
  });
  type Full = { setup: Array<{ line: string }>; update: Array<{ line: string; timeoutSeconds: number }>; checks: Array<Record<string, unknown>>; replaces: Array<{ recipeId: string; label: string }>; proposedBy: string; sourceProject?: string };
  const only = async (t: Bench, label: string) => (await list(t)).recipes.find((entry) => entry.label === label) as unknown as Full;

  it("shows every executable and path field of the body the approval pins: the update commands, each check's select arguments, report, coverage and SARIF paths", async () => {
    const { t } = await bench();
    on();
    expect((await post(t, { action: "create", body: { ...full, label: "Full" } })).status).toBe(200);
    const view = await only(t, "Full");
    expect(view.update).toEqual([{ line: "{repo}: uv lock --check", timeoutSeconds: 600 }]);
    expect(view.checks).toEqual([
      { id: "unit", label: "Unit tests", kind: "test", command: { line: "{repo}: pytest -q", timeoutSeconds: 600 }, selectArgs: ["-k", "{tests}"], reportPath: "{repo}/reports/junit.xml", coveragePath: "{repo}/reports/coverage.xml" },
      { id: "scan", label: "Security scan", kind: "security", command: { line: "{repo}/tools: semgrep scan --sarif", timeoutSeconds: 600 }, sarifPath: "{repo}/reports/scan.sarif" },
    ]);
  });

  it("names who proposed a shared recipe and from which project, and warns which approved recipe an approval would replace", async () => {
    const { t } = await bench({ maya: "member", grant: "maintainer" });
    await withSwitch("1", async () => { await t.approveFirst(draftOf(draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("uv", ["sync"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("pytest", ["-q"], 1800), kind: "test" }] }] }))); });
    on();
    expect((await post(t, { action: "create", body: { ...recipeBody(), label: "Existing" } })).status).toBe(200);
    const shared = await t.web(MAYA, "POST", SHARE, { repositoryId: "web", label: "Newer", buildSystems: ["python"], toolchains: [], markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const proposed = await only(t, "Newer");
    expect(proposed.sourceProject).toBe(NAME);
    expect(proposed.proposedBy).toBe("Maya Chen");
    expect(proposed.replaces).toEqual([{ recipeId: (await list(t)).recipes.find((entry) => entry.label === "Existing")!.recipeId, label: "Existing" }]);
    // A recipe with another fingerprint replaces nothing, and an approved one shows no warning.
    expect((await only(t, "Existing")).replaces).toEqual([]);
  });
});

describe("a damaged recipe row (F9)", () => {
  it("is listed by id and can be removed with revoke, which frees its place", async () => {
    const { t, audit } = await bench();
    on();
    await post(t, { action: "create", body: recipeBody() });
    const [made] = (await list(t)).recipes;
    const key = { pk: `ORG#${TEST_ORG}`, sk: `SETUP_RECIPE#${made!.recipeId}` };
    const row = t.db.find((item) => String(item.sk) === key.sk)[0]!;
    t.db.set({ ...row, body: 12 });
    const damaged = (await get(t)).body as unknown as { recipes: RecipeRow[]; unreadable: string[] };
    expect(damaged.recipes).toEqual([]);
    expect(damaged.unreadable).toEqual([made!.recipeId]);
    expect((await post(t, { action: "revoke", recipeId: made!.recipeId, expectedRevision: 1 })).status).toBe(200);
    expect(((await get(t)).body as unknown as { unreadable: string[] }).unreadable).toEqual([]);
    expect(events(audit, "setup_recipe.revoked")).toHaveLength(1);
    // Removing it again, or a recipe that never existed, is not found.
    expect((await post(t, { action: "revoke", recipeId: made!.recipeId, expectedRevision: 1 })).status).toBe(404);
    expect((await post(t, { action: "revoke", recipeId: "rcp_" + "7".repeat(20), expectedRevision: 1 })).status).toBe(404);
  });
});

describe("one clock", () => {
  it("the stored session's freshness and the approval evidence read the same clock", async () => {
    const { t } = await bench({ maya: "admin" });
    on();
    // A clock far from the wall: the session (signed in 'now' on the wall clock) is not fresh at it, and the evidence is stamped with it.
    const later = Date.now() + 3 * 3_600_000;
    const deps = recipeDepsOf({ documentClient: t.db, tableName: "state", developer: { signInTableName: "state" }, now: () => later, audit: undefined } as never,
      { orgId: TEST_ORG, developerId: OMAR.developerId, sessionId: "unused", orgRole: "owner" } as never);
    const evidence = await deps.approvalEvidence({ orgId: TEST_ORG, proposerId: OMAR.developerId, approverId: MAYA.developerId });
    expect(evidence.decisionInput.nowMs).toBe(later);
    expect(deps.now().getTime()).toBe(later);
    const sessionId = (t.db.find((item) => String(item.pk).startsWith("SESSION#") && item.developerId === OMAR.developerId)[0] as { sessionId: string }).sessionId;
    const session = await deps.readSession(sessionId);
    expect(session?.developerId).toBe(OMAR.developerId);
  });
});

describe("the route itself", () => {
  it("refuses a caller that is not a browser session even if the entry file let it through", async () => {
    const { t } = await bench();
    on();
    const deps = { documentClient: t.db, tableName: "state", developer: { signInTableName: "state" }, now: () => Date.now() } as never;
    const caller = { orgId: TEST_ORG, developerId: OMAR.developerId, sessionId: "s", orgRole: "owner" } as never;
    for (const method of ["GET", "POST"]) {
      await expect(routeSetupRecipes(deps, caller, { method, headers: {}, body: "{}" } as never, new URL("https://x.test" + PATH))).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(routeSetupRecipes(deps, caller, { method: "POST", headers: {}, body: "{}" } as never, new URL("https://x.test" + SHARE))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
