// "How we work" (H5): the effective view. `GET /v1/app/projects/{p}/how-we-work` shows a project's process as stages with six rows each, every value marked with where it comes from
// (Rovara's built-in process, the company's guardrails or the project) and whether it is locked. Anyone who can see the project reads it; nothing is written.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_GUARDRAILS, E2E_DEFAULT_LIMITS, HOW_WE_WORK_REVIEWER_NOTE, HowWeWorkViewReaderSchema, HowWeWorkViewSchema, ROVARA_CODE_AGENT_ID, agentGuardrailsKey, agentXError, projectRevisionKey,
  type AgentId, type HowWeWorkView, type OrgRole, type RecipeOverlay,
} from "../../packages/contracts/src/index.js";
import { getProjectHowWeWork, HOW_WE_WORK_PATH, type HowWeWorkDependencies } from "../../packages/broker/src/playbook/routes.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { writeProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { BO, MAX, MIA, ORG_A, ORG_B, ZED, OLA } from "../support/agent-session-world.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { agentKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { TEST_ORG } from "../support/orgs.js";
import { randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
function deps(w: MergeWorld): HowWeWorkDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined || caller.orgId !== ORG_A) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
const view = (w: MergeWorld, who = MAX, project = "web") => getProjectHowWeWork(deps(w), w.caller(who), project);
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode }));
const stage = (v: HowWeWorkView, id: string) => v.stages.find((entry) => entry.id === id)!;

/** Rovara Code 2 has the plan check; the org adopts it before the process layer is made (the layer pins the org's version). */
async function adoptVersion2(w: MergeWorld) {
  await w.store.adoptBuiltinVersion({ orgId: ORG_A, agentId: ROVARA_CODE_AGENT_ID, version: 2, expectedPinnedVersion: await w.store.pinnedBuiltinVersion(ORG_A, ROVARA_CODE_AGENT_ID), by: MAX });
}
/** A published process layer of the project with `overlay`, and the playbook pointing at it. */
async function withProcessLayer(w: MergeWorld, overlay: RecipeOverlay, options: { legacy?: boolean } = {}): Promise<AgentId> {
  const layer = await w.store.create({
    orgId: ORG_A, name: "web process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, overlay: options.legacy === true ? {} : overlay, purpose: "process", createdBy: MAX,
  });
  // A layer saved before rule text was limited (H7): its draft is written straight into storage, as the earlier code stored it.
  if (options.legacy === true) await w.db.send(new UpdateCommand({ TableName: "state", Key: agentKey(ORG_A, layer.agentId, "DRAFT"), UpdateExpression: "SET overlay = :overlay", ExpressionAttributeValues: { ":overlay": overlay } }));
  await w.store.publish({ orgId: ORG_A, agentId: layer.agentId, expectedDraftRevision: layer.draftRevision, digest: "a".repeat(64), by: MAX });
  await writeProjectPlaybook(deps(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: 0, defaultProcess: { kind: "project_process", agentId: layer.agentId } });
  return layer.agentId;
}
const command = (executable: string, args: string[]) => ({ cwd: "repo/web", executable, args, timeoutSeconds: 600 });
function seedDefinition(w: MergeWorld, extra: Record<string, unknown> = {}) {
  w.db.set({
    ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {},
    definition: {
      name: "web", revision: 1,
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [command("npm", ["test"]), command("npm", ["run", "lint"])], orchestratorInstructions: "Delegate work.",
      ...extra,
    },
  });
}
const guardrails = (w: MergeWorld, change: Record<string, unknown>) => w.db.set({ ...agentGuardrailsKey(ORG_A), entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), ...change } });

/** Every Marked value of the view, with its place. */
function markedValues(v: HowWeWorkView): Array<{ where: string; source: string; locked: boolean; lockedBy?: string | undefined }> {
  const out: Array<{ where: string; source: string; locked: boolean; lockedBy?: string | undefined }> = [];
  const add = (where: string, entry: { source: string; locked: boolean; lockedBy?: string | undefined }) => out.push({ where, source: entry.source, locked: entry.locked, lockedBy: entry.lockedBy });
  for (const s of v.stages) {
    add(`${s.id}.model`, s.who.model); add(`${s.id}.thinking`, s.who.thinking); add(`${s.id}.differentCompanyFrom`, s.who.differentCompanyFrom); add(`${s.id}.tools`, s.may.tools);
    s.knows.instructions.forEach((entry, i) => add(`${s.id}.instructions.${String(i)}`, entry));
    for (const row of ["checked", "evidence", "approves"] as const) s[row].items.forEach((entry, i) => add(`${s.id}.${row}.${String(i)}`, entry));
  }
  v.rules.forEach((entry, i) => add(`rules.${String(i)}`, entry));
  return out;
}

describe("a project with no process layer", () => {
  it("shows Rovara's own process: every value is Rovara's, and only the project's own settings are the project's", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const v = await view(w);
    expect(HowWeWorkViewSchema.safeParse(v).success).toBe(true);
    expect(v).toMatchObject({ project: "web", playbookRevision: 0, process: { kind: "builtin", agentId: ROVARA_CODE_AGENT_ID }, modelsEditable: false, rules: [] });
    expect(v.process.version).toBeUndefined();
    expect(v.stages.map((s) => s.id)).toEqual(["plan", "plan_critic", "build", "check", "review", "pull_request"]);
    // The project never saved code settings, so even those rows show the defaults as Rovara's.
    expect(markedValues(v).filter((entry) => entry.source !== "rovara")).toEqual([]);
    expect(stage(v, "pull_request").approves.items.slice(1)).toEqual([
      { value: "Self-approval: not allowed", source: "rovara", locked: false },
      { value: "Merge method: squash", source: "rovara", locked: false },
    ]);
    // Nothing is locked by the company.
    expect(markedValues(v).some((entry) => entry.lockedBy === "company")).toBe(false);
    for (const s of v.stages) {
      expect(s.who.model).toEqual({ value: null, source: "rovara", locked: false });
      expect(s.who.differentCompanyFrom).toEqual({ value: [], source: "rovara", locked: false });
    }
  });

  it("is the same for a version 1 recipe, which has no plan check", async () => {
    const w = mergeWorld();
    const v = await view(w);
    expect(v.stages.map((s) => s.id)).toEqual(["plan", "build", "check", "review", "pull_request"]);
  });

  it("shows Rovara's safety facts as locked by Rovara", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const v = await view(w);
    for (const id of ["plan", "plan_critic", "review"]) {
      expect(stage(v, id).may.readOnly).toBe(true);
      expect(stage(v, id).may.tools).toMatchObject({ value: ["read", "grep", "find", "ls"], source: "rovara", locked: true, lockedBy: "rovara" });
    }
    expect(stage(v, "build").may).toMatchObject({ readOnly: false, tools: { value: null, locked: false } });
    expect(stage(v, "plan").approves.items[0]).toMatchObject({ source: "rovara", locked: true, lockedBy: "rovara" });
    expect(stage(v, "pull_request").approves.items[0]).toMatchObject({ source: "rovara", locked: true, lockedBy: "rovara" });
    expect(stage(v, "pull_request").approves.items[0]!.value).toContain("a person merges");
    expect(stage(v, "review").checked.items.map((entry) => entry.value)).toEqual(["Code review", "Security review", "Findings go back to Build, up to 3 rounds"]);
    expect(stage(v, "pull_request").evidence.items.map((entry) => entry.value)).toEqual(["Plan summary", "What changed", "Tests", "Reviews", "Risk"]);
  });

  it("says on the reviewing stages (the plan check, the review, and the pull request feedback review) that project rules do not reach them, and on no other stage", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const v = await view(w);
    for (const s of v.stages) {
      if (s.kind === "plan_critic" || s.kind === "review" || s.kind === "pull_request") expect(s.knows.note).toBe("Project rules apply to Understand, Plan and Build. Reviewers only follow rules written for them.");
      else expect(s.knows.note).toBeUndefined();
    }
    expect(HOW_WE_WORK_REVIEWER_NOTE).toBe("Project rules apply to Understand, Plan and Build. Reviewers only follow rules written for them.");
  });
});

describe("the project's own settings", () => {
  it("come from the project definition and the code settings, and are the project's", async () => {
    const w = mergeWorld({ allowSelfApproval: true, mergeMethod: "merge" });
    await adoptVersion2(w);
    seedDefinition(w, {
      models: { default: { provider: "anthropic", modelId: "claude-sonnet-x", thinkingLevel: "medium" }, approved: [{ provider: "anthropic", modelId: "claude-sonnet-x" }] },
      developerTasks: { optionalWorkflowChecks: [{ id: "e2e-smoke", label: "Smoke test", command: command("npm", ["run", "smoke"]) }] },
      e2e: {
        schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
        capture: { screenshots: true, traces: false, video: false, downloads: true },
        limits: E2E_DEFAULT_LIMITS,
      },
    });
    const v = await view(w);
    // V3: the view decides no model; the stage models come from the resolver's own read (one path), so no stage reports the project's model here.
    for (const id of ["plan", "build", "review", "plan_critic"]) {
      expect(stage(v, id).who.model).toEqual({ value: null, source: "rovara", locked: false });
      expect(stage(v, id).who.thinking).toEqual({ value: null, source: "rovara", locked: false });
    }
    expect(stage(v, "check").checked.items).toEqual([
      { value: "Required: npm test", source: "project", locked: false },
      { value: "Required: npm run lint", source: "project", locked: false },
      { value: "Optional: Smoke test", source: "project", locked: false },
    ]);
    expect(stage(v, "check").evidence.items).toEqual([
      { value: "Screenshots: on", source: "project", locked: false },
      { value: "Traces: off", source: "project", locked: false },
      { value: "Video: off", source: "project", locked: false },
      { value: "Downloads: on", source: "project", locked: false },
    ]);
    const approves = stage(v, "pull_request").approves.items;
    expect(approves[0]).toMatchObject({ source: "rovara", locked: true, lockedBy: "rovara" });
    expect(approves.slice(1)).toEqual([
      { value: "Self-approval: allowed", source: "project", locked: false },
      { value: "Merge method: merge", source: "project", locked: false },
    ]);
  });
});

describe("code settings", () => {
  it("are the project's once saved, and the defaults (Rovara's) until then", async () => {
    const w = mergeWorld();
    const rows = async () => stage(await view(w), "pull_request").approves.items.slice(1);
    expect(await rows()).toEqual([{ value: "Self-approval: not allowed", source: "rovara", locked: false }, { value: "Merge method: squash", source: "rovara", locked: false }]);
    // Saved with the same values as the defaults: still the project's choice.
    w.settings({ allowSelfApproval: false, mergeMethod: "squash" });
    expect(await rows()).toEqual([{ value: "Self-approval: not allowed", source: "project", locked: false }, { value: "Merge method: squash", source: "project", locked: false }]);
    w.settings({ codeReviewers: ["acme/reviewers"] });
    expect((await rows()).at(-1)).toEqual({ value: "Reviewers asked: acme/reviewers", source: "project", locked: false });
  });

  it("are the defaults, as Rovara's, when the saved item cannot be read", async () => {
    const w = mergeWorld();
    w.settings({ mergeMethod: "rebase" as never });
    expect((await view(w)).stages.at(-1)!.approves.items.slice(1).map((entry) => entry.source)).toEqual(["rovara", "rovara"]);
  });

  it("keep every line inside the contract's limit, however long the reviewers list is", async () => {
    const w = mergeWorld();
    const reviewers = Array.from({ length: 10 }, (_, i) => `org${String(i)}/${"r".repeat(100)}`);
    w.settings({ codeReviewers: reviewers });
    const v = await view(w);
    const asked = stage(v, "pull_request").approves.items.at(-1)!.value;
    expect(asked.startsWith("Reviewers asked: org0/")).toBe(true);
    expect(Array.from(asked).length).toBeLessThanOrEqual(400);
    expect(HowWeWorkViewSchema.safeParse(v).success).toBe(true);
  });

  it("build a view that parses from oversized inputs of every kind", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    w.settings({ allowSelfApproval: true, codeReviewers: Array.from({ length: 10 }, (_, i) => `org${String(i)}/${"r".repeat(100)}`) });
    const long = "\u{1F600}".repeat(300);
    seedDefinition(w, {
      readiness: Array.from({ length: 64 }, (_, i) => command("npm", ["run", `${long}${String(i)}`])),
      models: { default: { provider: "p".repeat(128), modelId: "m".repeat(256), thinkingLevel: "high" }, approved: [{ provider: "p".repeat(128), modelId: "m".repeat(256) }] },
      developerTasks: { optionalWorkflowChecks: Array.from({ length: 16 }, (_, i) => ({ id: `check-${String(i)}`, label: "L".repeat(80), command: command("npm", [long]) })) },
    });
    await withProcessLayer(w, { instructions: "R".repeat(8192), steps: { build: { instructions: "B".repeat(8192) } } }, { legacy: true });
    const v = await view(w);
    const parsed = HowWeWorkViewSchema.safeParse(v);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues.slice(0, 2))).toBe(true);
    // The positive control: the oversized inputs did reach the view, clipped.
    expect(stage(v, "check").checked.items).toHaveLength(80);
    expect(Array.from(stage(v, "check").checked.items[0]!.value).length).toBeLessThanOrEqual(400);
    expect(stage(v, "build").knows.instructions.some((entry) => entry.value.length === 8192)).toBe(true);
  });
});

describe("a process layer", () => {
  it("shows an instruction written on a review stage as the project's, and keeps project-wide rules off the reviewing stages", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const agentId = await withProcessLayer(w, { instructions: "PROJECT-WIDE-RULE", steps: { review: { instructions: "REVIEW-RULE" }, plan_critic: { instructions: "CRITIC-RULE" }, build: { instructions: "BUILD-RULE" } } });
    const v = await view(w);
    expect(v.process).toEqual({ kind: "project_process", agentId, version: 1, draftRevision: 1 });
    expect(v.playbookRevision).toBe(1);
    const texts = (id: string) => stage(v, id).knows.instructions.map((entry) => entry.value);
    // Written on the stage itself: the project's.
    expect(stage(v, "review").knows.instructions).toContainEqual({ value: "REVIEW-RULE", source: "project", locked: false });
    expect(stage(v, "plan_critic").knows.instructions).toContainEqual({ value: "CRITIC-RULE", source: "project", locked: false });
    // The project-wide rule reaches Plan and Build, never the reviewing stages.
    expect(texts("plan")).toContain("PROJECT-WIDE-RULE");
    expect(texts("build")).toEqual(expect.arrayContaining(["PROJECT-WIDE-RULE", "BUILD-RULE"]));
    expect(texts("review")).not.toContain("PROJECT-WIDE-RULE");
    expect(texts("plan_critic")).not.toContain("PROJECT-WIDE-RULE");
    expect(texts("review")).not.toContain("BUILD-RULE");
    expect(texts("pull_request")).not.toContain("PROJECT-WIDE-RULE");
    // It is listed as a project-wide rule, and the reviewing stages carry the note.
    expect(v.rules).toEqual([{ value: "PROJECT-WIDE-RULE", source: "project", locked: false }]);
    expect(stage(v, "review").knows.note).toBe(HOW_WE_WORK_REVIEWER_NOTE);
    expect(stage(v, "plan_critic").knows.note).toBe(HOW_WE_WORK_REVIEWER_NOTE);
    expect(stage(v, "pull_request").knows.note).toBe(HOW_WE_WORK_REVIEWER_NOTE);
    expect(stage(v, "build").knows.note).toBeUndefined();
  });

  it("shows tools set on a stage as the project's and decides no model (a model set on a stage is the resolver's to report, not this view's)", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    await withProcessLayer(w, { steps: { build: { model: { provider: "openai", modelId: "gpt-x" }, thinkingLevel: "high", tools: ["read", "edit"] }, review: { differentCompanyFrom: "build" } } });
    const v = await view(w);
    expect(stage(v, "build").who.model).toEqual({ value: null, source: "rovara", locked: false });
    expect(stage(v, "build").who.thinking).toEqual({ value: null, source: "rovara", locked: false });
    expect(stage(v, "build").may.tools).toEqual({ value: ["read", "edit"], source: "project", locked: false });
    expect(stage(v, "review").who.differentCompanyFrom).toEqual({ value: ["build"], source: "project", locked: false });
    expect(stage(v, "plan").who.model).toEqual({ value: null, source: "rovara", locked: false });
    expect(stage(v, "check").who.thinking).toEqual({ value: null, source: "rovara", locked: false });
  });

  it("says which version the layer has when the project runs the built-in with a published layer (final review I3)", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const layer = await w.store.create({ orgId: ORG_A, name: "web process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, purpose: "process", createdBy: MAX });
    await w.store.publish({ orgId: ORG_A, agentId: layer.agentId, expectedDraftRevision: layer.draftRevision, digest: "a".repeat(64), by: MAX });
    // The maintainer set the project back to the built-in (or the first version's playbook write never happened).
    await writeProjectPlaybook(deps(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: 0, defaultProcess: { kind: "builtin" } });
    const v = await view(w);
    expect(v.process).toEqual({ kind: "builtin", agentId: ROVARA_CODE_AGENT_ID, draftLayer: { agentId: layer.agentId, draftRevision: layer.draftRevision, currentVersion: 1 } });
    expect(HowWeWorkViewSchema.parse(v)).toEqual(v);
    // An archived layer's version can't be chosen, so it is not offered.
    await w.store.archive(ORG_A, layer.agentId, MAX);
    expect((await view(w)).process.draftLayer).not.toHaveProperty("currentVersion");
  });

  it("falls back to Rovara's process when the layer is only a draft, and refuses a pointer that no longer holds", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const layer = await w.store.create({ orgId: ORG_A, name: "web process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, purpose: "process", createdBy: MAX });
    expect((await view(w)).process).toEqual({ kind: "builtin", agentId: ROVARA_CODE_AGENT_ID, draftLayer: { agentId: layer.agentId, draftRevision: layer.draftRevision } });
    await w.store.publish({ orgId: ORG_A, agentId: layer.agentId, expectedDraftRevision: layer.draftRevision, digest: "a".repeat(64), by: MAX });
    await writeProjectPlaybook(deps(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: 0, defaultProcess: { kind: "project_process", agentId: layer.agentId } });
    await w.store.archive(ORG_A, layer.agentId, MAX);
    expect(await failure(view(w))).toEqual({ code: "PROCESS_UNAVAILABLE", status: 400 });
  });
});

describe("the company's guardrails", () => {
  it("lock the review stage's different-company rule as the company's when cross-company review is required", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    guardrails(w, { requireCrossCompanyReview: true });
    const v = await view(w);
    expect(stage(v, "review").who.differentCompanyFrom).toEqual({ value: ["build"], source: "company", locked: true, lockedBy: "company" });
    // The rule is for review steps; the plan check and the other stages are unchanged.
    for (const id of ["plan", "plan_critic", "build", "check", "pull_request"]) expect(stage(v, id).who.differentCompanyFrom).toEqual({ value: [], source: "rovara", locked: false });
  });

  it("add the step's own named stage to the locked list, and leave the rule off by default", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    await withProcessLayer(w, { steps: { review: { differentCompanyFrom: "plan" } } });
    guardrails(w, { requireCrossCompanyReview: true });
    expect(stage(await view(w), "review").who.differentCompanyFrom).toEqual({ value: ["plan", "build"], source: "company", locked: true, lockedBy: "company" });
    guardrails(w, { requireCrossCompanyReview: false });
    expect(stage(await view(w), "review").who.differentCompanyFrom).toEqual({ value: ["plan"], source: "project", locked: false });
  });
});

describe("who can read it", () => {
  it("lets a viewer read it, and writes nothing", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const writes: unknown[] = [];
    const stop = w.db.onWrite((change) => writes.push(change));
    const v = await view(w, MIA);
    stop();
    expect(v.project).toBe("web");
    expect(writes).toEqual([]);
  });

  it("answers the project not found for someone with no role, and for another org", async () => {
    const w = mergeWorld();
    expect(await failure(view(w, ZED))).toEqual({ code: "PROJECT_NOT_FOUND", status: 404 });
    expect(await failure(getProjectHowWeWork(deps(w), w.caller(BO, ORG_B), "web"))).toEqual({ code: "PROJECT_NOT_FOUND", status: 404 });
  });

  it("has its own path", () => {
    expect(HOW_WE_WORK_PATH.exec("/v1/app/projects/web/how-we-work")?.[1]).toBe("web");
    expect(HOW_WE_WORK_PATH.exec("/v1/app/projects/web/playbook")).toBeNull();
  });
});

describe("the route against the real broker", () => {
  it("serves GET /v1/app/projects/{p}/how-we-work to a contributor, answers 404 for a project that is not theirs, and has no write verb", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    h.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor", grantedAt: new Date().toISOString() });
    const read = await h.dev(MAYA, "GET", "/v1/app/projects/payments/how-we-work");
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const parsed = HowWeWorkViewReaderSchema.safeParse(read.body);
    expect(parsed.success).toBe(true);
    expect(read.body).toMatchObject({ project: "payments", playbookRevision: 0, process: { kind: "builtin" }, modelsEditable: false });
    expect((await h.dev(MAYA, "GET", "/v1/app/projects/nothing-here/how-we-work")).status).toBe(404);
    expect((await h.dev(MAYA, "PUT", "/v1/app/projects/payments/how-we-work", {})).status).toBeGreaterThanOrEqual(400);
  });
});

describe("the contract", () => {
  it("is strict and bounded", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const good = await view(w);
    expect(HowWeWorkViewSchema.safeParse(good).success).toBe(true);
    // The reader keeps a gateway's requestId; the strict schema does not.
    expect(HowWeWorkViewReaderSchema.safeParse({ ...good, requestId: "r" }).success).toBe(true);
    expect(HowWeWorkViewSchema.safeParse({ ...good, requestId: "r" }).success).toBe(false);
    const edit = (change: (copy: HowWeWorkView) => void) => { const copy = structuredClone(good); change(copy); return HowWeWorkViewSchema.safeParse(copy).success; };
    expect(edit((c) => { c.stages[0]!.checked.items = Array.from({ length: 81 }, () => ({ value: "x", source: "rovara", locked: false })); })).toBe(false);
    expect(edit((c) => { c.stages[0]!.checked.items = [{ value: "x".repeat(401), source: "rovara", locked: false }]; })).toBe(false);
    expect(edit((c) => { c.stages[0]!.knows.instructions = [{ value: "x".repeat(8193), source: "project", locked: false }]; })).toBe(false);
    expect(edit((c) => { c.stages[0]!.knows.instructions = [{ value: "x".repeat(8192), source: "project", locked: false }]; })).toBe(true);
    expect(edit((c) => { c.stages[0]!.knows.instructions = Array.from({ length: 17 }, () => ({ value: "x", source: "project" as const, locked: false })); })).toBe(false);
    expect(edit((c) => { c.stages[0]!.knows.note = "x".repeat(201); })).toBe(false);
    expect(edit((c) => { c.stages[0]!.may.tools = { value: Array.from({ length: 41 }, () => "read"), source: "rovara", locked: false }; })).toBe(false);
    expect(edit((c) => { c.stages[0]!.who.model = { value: "m".repeat(401), source: "rovara", locked: false }; })).toBe(false);
    expect(edit((c) => { c.stages = Array.from({ length: 13 }, () => structuredClone(good.stages[0]!)); })).toBe(false);
    expect(edit((c) => { c.rules = Array.from({ length: 17 }, () => ({ value: "x", source: "project" as const, locked: false })); })).toBe(false);
    expect(edit((c) => { (c as unknown as { modelsEditable: boolean }).modelsEditable = true; })).toBe(false);
    expect(edit((c) => { c.stages[0]!.who.model = { value: null, source: "nobody" as "rovara", locked: false }; })).toBe(false);
    // `lockedBy` is there exactly when the value is locked.
    expect(edit((c) => { c.stages[0]!.who.model = { value: null, source: "rovara", locked: true }; })).toBe(false);
    expect(edit((c) => { c.stages[0]!.who.model = { value: null, source: "rovara", locked: false, lockedBy: "rovara" }; })).toBe(false);
    expect(edit((c) => { (c.stages[0]!.who.model as Record<string, unknown>)["extra"] = 1; })).toBe(false);
  });
});

describe("a process layer that is not the project's default yet", () => {
  it("is named in the view as the draft layer, so a saved first draft can be found again", async () => {
    const w = mergeWorld();
    const made = await postProjectProcess(deps(w), w.caller(MAX), "web");
    const v = await view(w);
    expect(v.process).toEqual({ kind: "builtin", agentId: ROVARA_CODE_AGENT_ID, draftLayer: { agentId: made.agentId, draftRevision: made.draftRevision } });
    expect(HowWeWorkViewSchema.safeParse(v).success).toBe(true);
  });

  it("does not create a layer when there is none, even for a viewer's read", async () => {
    const w = mergeWorld();
    const v = await view(w, MIA);
    expect(v.process).toEqual({ kind: "builtin", agentId: ROVARA_CODE_AGENT_ID });
    expect((await w.store.list(ORG_A)).filter((agent) => agent.purpose === "process")).toEqual([]);
  });

  it("is left out once the layer is the project's default (its own draft revision is shown instead)", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    await withProcessLayer(w, { instructions: "RULE" });
    expect((await view(w)).process).not.toHaveProperty("draftLayer");
  });
});
