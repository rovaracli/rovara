// "How we work" H6: the project settings that changed with no audit record now leave one, in the same transaction as the write.
//   project.models_changed / project.checks_changed / project.e2e_policy_changed: a new project definition revision (registerProjectFor, the one writer).
//   project.model_selection_changed: the Slack project model selection (putProjectModel).
//   project.roster_changed: addToRoster / removeFromRoster (and the routes that call them).
// The comparison ("what changed") is `playbook/project-settings-audit.ts`; the writers only hand it the revision before and after.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditEventInputSchema, agentRequestKey, orgProjectCatalogKey, projectAgentKey, projectMetaKey, type AgentId, type AuditEventInput, type OrgId, type StoredProjectDefinition } from "@agentx/contracts";
import { projectDefinitionAuditEvents } from "../../packages/broker/src/playbook/project-settings-audit.js";
import { addToRoster, removeFromRoster } from "../../packages/broker/src/agents/roster.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { recipeDigest, type RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import { resolveAgent } from "../../packages/broker/src/agents/store.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { capturingAuditDeps, type AuditCapture } from "../support/audit-capture.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, loadSlackBroker, registerSlackProject, serviceCall } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

type Item = Record<string, unknown>;
type Entry = Record<string, { Item?: Item; Key?: Item } | undefined>;
const OPERATOR = { kind: "operator", id: "op_0123456789abcdef01234567" } as const;
const BASE = { orgId: TEST_ORG, actor: OPERATOR, occurredAt: "2026-10-27T10:00:00.000Z" };
const FAST = { provider: "amazon-bedrock", modelId: "fast-model", label: "Fast" };
const BALANCED = { provider: "amazon-bedrock", modelId: "default-model", label: "Balanced" };
const MODELS = { default: BALANCED, approved: [BALANCED, FAST] };
const CAPTURE = { screenshots: true, traces: false, video: false, downloads: true };
const cmd = (name: string) => ({ cwd: "repo/demo", executable: "npm", args: ["run", name], timeoutSeconds: 120 });

/** A stored definition with only what these tests vary. */
const definition = (revision: number, parts: Record<string, unknown> = {}): StoredProjectDefinition => (({
  name: "payments", revision, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: `Delegate work (revision ${String(revision)}).`, ...parts,
}));
const e2eWith = (capture: Record<string, boolean>, limits = 1) => ({ schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", capture, limits: { runs: limits } });
const events = (before: StoredProjectDefinition | undefined, after: StoredProjectDefinition): AuditEventInput[] => projectDefinitionAuditEvents({ ...BASE, before, after: after });
const byAction = (list: AuditEventInput[], action: string) => list.filter((event) => event.action === action);

describe("what changed between two revisions of a project definition", () => {
  it("records the models when the approved list grows, with the count after the change and the default unmoved", () => {
    const list = events(definition(1, { models: { default: BALANCED, approved: [BALANCED] } }), definition(2, { models: MODELS }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ action: "project.models_changed", orgId: TEST_ORG, actor: OPERATOR, target: { kind: "project", name: "payments" }, facts: { revision: 2, approvedCount: 2, defaultChanged: false } });
  });

  it("says the default moved when only the default did", () => {
    const list = events(definition(1, { models: MODELS }), definition(2, { models: { default: FAST, approved: [BALANCED, FAST] } }));
    expect(list.map((event) => [event.action, event.facts])).toEqual([["project.models_changed", { revision: 2, approvedCount: 2, defaultChanged: true }]]);
  });

  it("does not record a reorder of the approved models, or a model check's result stored beside them", () => {
    const reordered = { default: BALANCED, approved: [FAST, BALANCED] };
    expect(events(definition(1, { models: MODELS }), definition(2, { models: reordered }))).toEqual([]);
    const checked = { default: BALANCED, approved: [{ ...BALANCED, lastCheck: { status: "ok" } }, FAST] };
    expect(events(definition(1, { models: MODELS }), definition(2, { models: checked }))).toEqual([]);
  });

  it("records a changed label or thinking level as a change of the approved models", () => {
    expect(byAction(events(definition(1, { models: MODELS }), definition(2, { models: { default: BALANCED, approved: [BALANCED, { ...FAST, label: "Quick" }] } })), "project.models_changed")).toHaveLength(1);
    expect(byAction(events(definition(1, { models: MODELS }), definition(2, { models: { default: BALANCED, approved: [BALANCED, { ...FAST, thinkingLevel: "low" }] } })), "project.models_changed")).toHaveLength(1);
  });

  it("records the checks when a required (readiness) check is added, with the counts of required and optional checks after", () => {
    const optional = [{ id: "lint", label: "Lint", command: cmd("lint") }];
    const list = events(
      definition(1, { readiness: [cmd("test")], developerTasks: { optionalWorkflowChecks: optional } }),
      definition(2, { readiness: [cmd("test"), cmd("build")], developerTasks: { optionalWorkflowChecks: optional } }),
    );
    expect(list.map((event) => [event.action, event.facts])).toEqual([["project.checks_changed", { revision: 2, requiredCount: 2, optionalCount: 1 }]]);
  });

  it("records the checks when an optional check is added or removed", () => {
    const optional = [{ id: "lint", label: "Lint", command: cmd("lint") }];
    expect(events(definition(1), definition(2, { developerTasks: { optionalWorkflowChecks: optional } })).map((event) => event.facts)).toEqual([{ revision: 2, requiredCount: 0, optionalCount: 1 }]);
    expect(events(definition(2, { developerTasks: { optionalWorkflowChecks: optional } }), definition(3)).map((event) => event.facts)).toEqual([{ revision: 3, requiredCount: 0, optionalCount: 0 }]);
  });

  it("does not record the checks for a change to setup commands or to the other developer-task settings", () => {
    expect(events(definition(1, { setup: [cmd("install")] }), definition(2, { setup: [cmd("install"), cmd("seed")] }))).toEqual([]);
    expect(events(definition(1, { developerTasks: { enabled: true } }), definition(2, { developerTasks: { enabled: false } }))).toEqual([]);
  });

  it("records the capture policy when a flag flips, with the flags after the change, and not for other E2E settings", () => {
    const list = events(definition(1, { e2e: e2eWith({ ...CAPTURE, traces: true }) }), definition(2, { e2e: e2eWith(CAPTURE) }));
    expect(list.map((event) => [event.action, event.facts])).toEqual([["project.e2e_policy_changed", { revision: 2, ...CAPTURE }]]);
    expect(events(definition(1, { e2e: e2eWith(CAPTURE, 1) }), definition(2, { e2e: e2eWith(CAPTURE, 2) }))).toEqual([]);
  });

  it("reads a removed E2E policy as every capture off, and a never-configured one as no change", () => {
    expect(events(definition(1, { e2e: e2eWith(CAPTURE) }), definition(2)).map((event) => event.facts)).toEqual([{ revision: 2, screenshots: false, traces: false, video: false, downloads: false }]);
    expect(events(definition(1), definition(2))).toEqual([]);
  });

  it("records every area that changed in one revision, all with the one occurrence of the revision and different event ids", () => {
    const list = events(definition(1), definition(2, { models: MODELS, readiness: [cmd("test")], e2e: e2eWith(CAPTURE) }));
    expect(list.map((event) => event.action).sort()).toEqual(["project.checks_changed", "project.e2e_policy_changed", "project.models_changed"]);
    expect(new Set(list.map((event) => event.eventId)).size).toBe(3);
    expect(list.every((event) => AuditEventInputSchema.safeParse(event).success)).toBe(true);
    // The same revision again gives the same ids, so a retry of the write records nothing new.
    expect(events(definition(1), definition(2, { models: MODELS, readiness: [cmd("test")], e2e: e2eWith(CAPTURE) })).map((event) => event.eventId).sort()).toEqual(list.map((event) => event.eventId).sort());
  });

  it("records a project's first revision only for what it configures", () => {
    expect(events(undefined, definition(1))).toEqual([]);
    expect(events(undefined, definition(1, { models: MODELS, readiness: [cmd("test")] })).map((event) => event.action).sort()).toEqual(["project.checks_changed", "project.models_changed"]);
  });

  it("carries counts, flags and the revision only: no model, label, command or instruction text", () => {
    const list = events(definition(1), definition(2, { models: MODELS, readiness: [cmd("secret-script")], e2e: e2eWith(CAPTURE) }));
    const text = JSON.stringify(list);
    for (const word of ["fast-model", "Balanced", "secret-script", "Delegate work"]) expect(text).not.toContain(word);
  });
});

// ---- the project definition revision: through the admin registration route, with the Audit Ledger's outbox

const world = () => {
  const cap = capturingAuditDeps();
  const { db, handler } = createBroker({ extra: { audit: cap.audit } });
  cap.attach(db);
  return { cap, db, handler };
};
const isPending = (entry: Entry): boolean => { const pk = entry.Put?.Item?.pk; return typeof pk === "string" && pk.startsWith("AUDIT_PENDING#"); };
const pendingActions = (entries: Entry[]): string[] => entries.filter(isPending).map((entry) => (entry.Put!.Item as unknown as { event: AuditEventInput }).event.action).sort();
const factsOf = (cap: AuditCapture, action: Parameters<AuditCapture["recordedBy"]>[0]) => cap.recordedBy(action).map((event) => event.facts);
const failAuditItems = (db: FakeDynamoDb) => db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_PENDING#"), error: { name: "InternalServerError" } });
const revisionItems = (db: FakeDynamoDb) => db.find((item) => item.entityType === "PROJECT");

describe("a project definition revision registered through the admin route", () => {
  it("records the models and the checks it changes, in the transaction that stores the revision", async () => {
    const { cap, db, handler } = world();
    await registerSlackProject(handler, { bind: false, models: MODELS, readiness: [cmd("test")] });
    expect(factsOf(cap, "project.models_changed")).toEqual([{ revision: 1, approvedCount: 2, defaultChanged: true }]);
    expect(factsOf(cap, "project.checks_changed")).toEqual([{ revision: 1, requiredCount: 1, optionalCount: 0 }]);
    expect(cap.recordedBy("project.e2e_policy_changed")).toEqual([]);
    expect(cap.recorded()[0]).toMatchObject({ actor: { kind: "operator" }, target: { kind: "project", name: "payments" } });
    const holding = (db.transactions() as unknown as Entry[][]).filter((entries) => entries.some((entry) => entry.Put?.Item?.entityType === "PROJECT"));
    expect(holding).toHaveLength(1);
    expect(pendingActions(holding[0]!)).toEqual(["project.checks_changed", "project.models_changed", "spending.policy_seeded"]);
  });

  it("records only the area a later revision changed, and nothing for a revision that changes none", async () => {
    const { cap, handler } = world();
    await registerSlackProject(handler, { bind: false, models: MODELS, readiness: [cmd("test")] });
    await registerSlackProject(handler, { bind: false, revision: 2, models: { default: BALANCED, approved: [BALANCED] }, readiness: [cmd("test")] });
    expect(factsOf(cap, "project.models_changed")).toEqual([{ revision: 1, approvedCount: 2, defaultChanged: true }, { revision: 2, approvedCount: 1, defaultChanged: false }]);
    expect(factsOf(cap, "project.checks_changed")).toHaveLength(1);
    await registerSlackProject(handler, { bind: false, revision: 3, models: { default: BALANCED, approved: [BALANCED] }, readiness: [cmd("test")] });
    // M47 adds one independent company-policy bootstrap event; these three events concern project revisions.
    expect(cap.recordedBy("spending.policy_seeded")).toHaveLength(2);
    expect(cap.recorded().filter(event => event.target.kind === "project")).toHaveLength(4);
    await registerSlackProject(handler, { bind: false, revision: 4, models: { default: BALANCED, approved: [BALANCED] }, readiness: [cmd("test"), cmd("build")] });
    expect(factsOf(cap, "project.checks_changed")).toEqual([{ revision: 1, requiredCount: 1, optionalCount: 0 }, { revision: 4, requiredCount: 2, optionalCount: 0 }]);
  });

  it("records nothing more when the same revision is registered again", async () => {
    const { cap, handler } = world();
    await registerSlackProject(handler, { bind: false, models: MODELS });
    await registerSlackProject(handler, { bind: false, models: MODELS });
    expect(cap.recordedBy("project.models_changed")).toHaveLength(1);
  });

  it("is blocked when the audit item cannot be written: no revision is stored", async () => {
    const { cap, db, handler } = world();
    await registerSlackProject(handler, { bind: false, models: MODELS });
    failAuditItems(db);
    await expect(registerSlackProject(handler, { bind: false, revision: 2, models: { default: BALANCED, approved: [BALANCED] } })).rejects.toThrow();
    expect(revisionItems(db)).toHaveLength(1);
    expect(cap.recordedBy("project.models_changed")).toHaveLength(1);
  });
});

// ---- the Slack project model selection

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const slackUser = "U0123456789";

describe("the project model selection (putProjectModel)", () => {
  const selecting = async () => {
    const w = world();
    await registerSlackProject(w.handler, { models: MODELS });
    await ensureWorkspace(w.handler, thread, slackUser);
    return w;
  };
  const select = (handler: ReturnType<typeof world>["handler"], model = FAST) => serviceCall(handler, thread, slackUser, "PUT", "/v1/service/project/model", { provider: model.provider, modelId: model.modelId });

  it("records the selection once, from Slack, in the transaction that stores it", async () => {
    const { cap, db, handler } = await selecting();
    const before = cap.recorded().length;
    expect((await select(handler)).status).toBe(200);
    const made = cap.recordedBy("project.model_selection_changed");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ action: "project.model_selection_changed", target: { kind: "project", name: "payments" }, facts: { surface: "slack", cleared: false } });
    expect(cap.recorded().length).toBe(before + 1);
    const holding = (db.transactions() as unknown as Entry[][]).filter((entries) => entries.some((entry) => entry.Put?.Item?.entityType === "PROJECT_MODEL_SELECTION"));
    expect(holding).toHaveLength(1);
    expect(pendingActions(holding[0]!)).toEqual(["project.model_selection_changed"]);
  });

  it("records nothing when the selection already is that model, and again when it moves", async () => {
    const { cap, handler } = await selecting();
    await select(handler);
    await select(handler);
    expect(cap.recordedBy("project.model_selection_changed")).toHaveLength(1);
    await select(handler, BALANCED);
    expect(cap.recordedBy("project.model_selection_changed")).toHaveLength(2);
  });

  it("records nothing for a model that is not approved, and is blocked when the audit item cannot be written", async () => {
    const { cap, db, handler } = await selecting();
    expect((await serviceCall(handler, thread, slackUser, "PUT", "/v1/service/project/model", { provider: "other", modelId: "unapproved" })).status).toBe(400);
    expect(cap.recordedBy("project.model_selection_changed")).toEqual([]);
    failAuditItems(db);
    expect((await select(handler)).status).toBeGreaterThanOrEqual(500);
    expect(db.find((item) => item.entityType === "PROJECT_MODEL_SELECTION")).toEqual([]);
    expect(cap.recordedBy("project.model_selection_changed")).toEqual([]);
  });
});

// ---- the roster

const ROSTER_ORG: OrgId = TEST_ORG;
const AGENT = "agt_aaaaaaaaaaaaaaaaaaaaaaaa" as AgentId;
const OTHER = "agt_bbbbbbbbbbbbbbbbbbbbbbbb" as AgentId;

function rosterDeps(audit: AuditCapture | undefined) {
  const db = new FakeDynamoDb();
  audit?.attach(db);
  const deps = { documentClient: db, tableName: "state", now: () => Date.parse("2026-10-27T10:00:00.000Z"), ...(audit === undefined ? {} : { audit: audit.audit }) } as unknown as Parameters<typeof addToRoster>[0];
  return { db, deps };
}
const mark = (requestId: string) => ({ orgId: ROSTER_ORG, developerId: "d".repeat(64), requestId, fingerprint: "fp" });

describe("the roster writers", () => {
  it("record one event for an agent added, in the transaction that puts the entry and the request's item", async () => {
    const cap = capturingAuditDeps();
    const { db, deps } = rosterDeps(cap);
    await addToRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "m".repeat(64), request: mark("req-add-1") });
    const made = cap.recordedBy("project.roster_changed");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ target: { kind: "project", name: "web" }, actor: { kind: "member", id: "m".repeat(64) }, facts: { added: 1, removed: 0 } });
    const holding = (db.transactions() as unknown as Entry[][]).filter((entries) => entries.some((entry) => entry.Put?.Item?.entityType === "PROJECT_AGENT"));
    expect(holding).toHaveLength(1);
    expect(pendingActions(holding[0]!)).toEqual(["project.roster_changed"]);
    expect(holding[0]!.some((entry) => entry.Put?.Item?.entityType === "AGENT_REQUEST")).toBe(true);
  });

  it("record one event for an agent removed, by the person who removed it", async () => {
    const cap = capturingAuditDeps();
    const { deps } = rosterDeps(cap);
    await addToRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "m".repeat(64) });
    expect(await removeFromRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "n".repeat(64), request: mark("req-remove-1") })).toBe(true);
    const made = cap.recordedBy("project.roster_changed");
    expect(made.map((event) => event.facts)).toEqual([{ added: 1, removed: 0 }, { added: 0, removed: 1 }]);
    expect(made[1]!.actor).toEqual({ kind: "member", id: "n".repeat(64) });
  });

  it("record nothing when the agent was already on the roster, or was not on it to remove", async () => {
    const cap = capturingAuditDeps();
    const { deps } = rosterDeps(cap);
    await addToRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "m".repeat(64) });
    await addToRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "n".repeat(64), request: mark("req-again") });
    expect(await removeFromRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: OTHER, by: "n".repeat(64), request: mark("req-none") })).toBe(false);
    expect(cap.recordedBy("project.roster_changed")).toHaveLength(1);
  });

  it("are blocked when the audit item cannot be written: the roster is left as it was", async () => {
    const cap = capturingAuditDeps();
    const { db, deps } = rosterDeps(cap);
    failAuditItems(db);
    await expect(addToRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "m".repeat(64) })).rejects.toThrow();
    expect(db.get(projectAgentKey(ROSTER_ORG, "web", AGENT))).toBeUndefined();
    await addToRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "m".repeat(64) });
    failAuditItems(db);
    await expect(removeFromRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "m".repeat(64) })).rejects.toThrow();
    expect(db.get(projectAgentKey(ROSTER_ORG, "web", AGENT))).toBeDefined();
  });

  it("write as before on an install with no ledger", async () => {
    const { db, deps } = rosterDeps(undefined);
    await addToRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "m".repeat(64) });
    expect(db.get(projectAgentKey(ROSTER_ORG, "web", AGENT))).toBeDefined();
    expect(await removeFromRoster(deps, { orgId: ROSTER_ORG, project: "web", agentId: AGENT, by: "m".repeat(64) })).toBe(true);
  });
});

// ---- the roster routes: the person is the caller, once per request

const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const MAX = person("2", "Max");
const SAFE: RecipeOverlay = { instructions: "Summarise the open tickets.", sequence: [{ id: "work", name: "work", kind: "agent", workspace: "none" }] };

describe("the roster routes", () => {
  async function routeWorld() {
    const members = new FakeProjectMembers();
    const cap = capturingAuditDeps();
    const h = await createDeveloperTaskBroker({
      orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? ("org_bbbbbbbbbbbbbbbbbbbb") : TEST_ORG),
      register: false, brokerExtra: { agents: { projectMembers: members } }, audit: cap,
    });
    h.db.set({ pk: `SESSION#${MAX.sessionId}`, sk: "META", sessionId: MAX.sessionId, developerId: MAX.developerId, amr: MAX.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${MAX.developerId}`, sk: "META", developerId: MAX.developerId, provider: MAX.provider, displayName: MAX.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(MAX);
    seedMembership(h.db, MAX.developerId, { orgId: TEST_ORG, role: "member" });
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
    h.db.set({ ...projectMetaKey(TEST_ORG, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-01-01T00:00:00.000Z", createdBy: MAX.developerId });
    members.grant(TEST_ORG, "web", MAX.developerId, "maintainer");
    const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
    const created = await h.dev(MAX, "POST", "/v1/app/agents", { requestId: randomUUID(), name: `Agent ${randomUUID().slice(0, 8)}`, overlay: SAFE });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: AgentId }).agentId;
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay: SAFE, expectedRevision: draft.revision, by: MAX.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    const deps = { store, projectMembers: members, documentClient: h.db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com", signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }) } as ApprovalDependencies;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: MAX.developerId });
    return { h, cap, agentId, deps };
  }

  it("record the added and the removed agent against the maintainer who called, once each, and nothing for a repeated request", async () => {
    const { h, cap, agentId } = await routeWorld();
    const path = `/v1/app/projects/web/agents/${agentId}`;
    const add = { requestId: randomUUID() };
    expect((await h.dev(MAX, "PUT", path, add)).status).toBe(200);
    expect((await h.dev(MAX, "PUT", path, add)).status).toBe(200);
    expect(h.db.get(agentRequestKey(TEST_ORG, MAX.developerId, add.requestId))).toBeDefined();
    const remove = { requestId: randomUUID() };
    expect((await h.dev(MAX, "DELETE", path, remove)).body).toMatchObject({ removed: true });
    expect((await h.dev(MAX, "DELETE", path, remove)).status).toBe(200);
    const made = cap.recordedBy("project.roster_changed");
    expect(made.map((event) => event.facts)).toEqual([{ added: 1, removed: 0 }, { added: 0, removed: 1 }]);
    expect(made.every((event) => event.actor.kind === "member" && event.actor.id === MAX.developerId && "name" in event.target && event.target.name === "web")).toBe(true);
  });
});
