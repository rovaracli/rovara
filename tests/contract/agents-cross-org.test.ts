// Plan 3 Task 36: the isolation suite. Org A has an agent (v2), a skill, a connection, a company AI source, spend requests of every kind, a held start, write and step
// approvals, runs, a ledger and counters. A member and an owner of org B, who each have a project called `web` of their own, ask for every one of them by id and by
// the routes the CLI and the MCP tools use. Each answer is the one a missing id gets, nothing is written (no write command reaches the table and no item changes), and the
// secrets fake is not called. A control of the same call by A's own people shows the object is there, so no refusal is only a bad fixture.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, agentRunsKey, approvalKey, builtinSettingsKey, openApprovalKey, orgProjectCatalogKey, projectAgentKey, projectMemberKey, projectMetaKey, projectRevisionKey, sourceAlias, type OrgId } from "@rovara-code/contracts";
import { defaultSpendPolicy, ledgerKey, openSpendRequestDueKey, spendCounterKey } from "@agentx/cloud-contracts";
import { decideSpendRequest, escalateOwnerRequests } from "../../packages/broker/src/spend/requests.js";
import { approvalTaskEventKey, createStepApproval, createWriteApprovalRecord, decideApproval, getAnyApproval, runApprovalSweep, type ApprovalDependencies, type WriteApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { decideWriteApproval } from "../../packages/broker/src/agents/write-gate.js";
import { startAgentRun } from "../../packages/broker/src/agents/runs.js";
import { agentUsageCounter } from "../../packages/broker/src/spend/payer.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { checkEndpointUrl } from "../../packages/broker/src/connections/endpoint-check.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { githubConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, decideProofOf } from "../../packages/broker/src/developer/decide-session.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { resolveAgent } from "../../packages/broker/src/agents/store.js";
import { recipeDigest } from "@rovara-code/contracts";
import { MAYA, OMAR, bearerFor, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { CHARTERARC_TEAM_ID, linearViaFake, startFakeLinearMcp } from "../support/fake-linear-mcp.js";
import { call as callBroker } from "../support/slack-broker.js";
import { ADA, BEN, CARL, CELL, CODING, DEB, ORG_B, PREPARED, TRIAGE, month, person, setup, sha, type Reply } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";

// ---- the people. Org A: Ada owns it, Deb administers, Ben maintains payments, Carl contributes, Maya makes agents. Org B: Omar is a member who maintains B's `web`
// and `payments`; Beth owns B. Both are the strongest caller B has: only the org line stands between them and A's objects.
const BETH = person("6", "Beth Owner");
const B_PEOPLE = [OMAR, BETH];
const orgResolver: OrgResolver = async (subject) => (B_PEOPLE.some((who) => who.developerId === subject.developerId) ? ORG_B : TEST_ORG);

const ENV = "staging";
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const LINEAR_KEY = "lin_api_ISOLATIONSUITEKEY0123456789";
const SOURCE_KEY = "sk-ant-isolation-suite-vendor-key-0123456789";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const SKILL_MARKER = "A-ONLY-SKILL-BODY-MARKER";
const skillFile = (name: string, body = `# Steps\n\n${SKILL_MARKER}\n`) => `---\nname: ${name}\ndescription: Use when triaging A's tickets.\n---\n${body}`;
const READ_TOOLS = [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }];

/** Ids of the right shape that no org has: what a missing object looks like. */
const MISSING = {
  agent: "agt_zzzzzzzzzzzzzzzzzzzz", skill: "skl_zzzzzzzzzzzzzzzzzzzz", connection: "con_zzzzzzzzzzzzzzzzzzzz", source: "src_zzzzzzzzzzzzzzzzzzzz",
  spend: "spr_zzzzzzzzzzzzzzzzzzzz", approval: "apr_zzzzzzzzzzzzzzzzzzzz",
};

beforeAll(async () => { await (await import("../support/slack-broker.js")).loadSlackBroker(); });

// ---- the table's fingerprint: every item of every table the fake holds, in key order, so "nothing changed" is checked on the data and not only on the command names

type Item = Record<string, unknown>;
const stable = (_key: string, value: unknown): unknown => (value instanceof Set ? { set: [...value].sort() } : value);
const WRITE_COMMANDS = /^(Put|Update|Delete|TransactWrite|BatchWrite)Command$/;

/** A seeded project the way registration writes it: revision 1, its catalog entry and its META. */
function seedProject(db: { set(item: Item): void }, orgId: OrgId, name: string, creator: string): void {
  const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name, revision: 1,
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [command("npm", ["ci"], 900)], readiness: [command("npm", ["test"], 1800)], orchestratorInstructions: "Delegate work.",
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: creator });
}

/** The whole isolation world. Everything of org A is made through the same routes and helpers the product's own tests use. */
async function world() {
  const fake = new FakeOrgSecrets({ env: ENV, now: Date.now });
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: Date.now });
  const fakeLinear = await startFakeLinearMcp();
  const { type: linearType } = linearViaFake(fakeLinear);
  const holder: { db?: { send(command: unknown): Promise<unknown> } } = {};
  const checkEndpoint = vi.fn(async (url: string) => { await checkEndpointUrl(url, async () => ["52.1.2.3"]); });
  const t = await setup({
    decide: true, orgResolver,
    agents: { modelSources: { launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] }, checkEndpoint } },
    extra: {
      cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" },
      checkRepositoryAccess: vi.fn(async () => undefined),
      connectorTypes: { github: githubConnectorType, linear: linearType },
      orgConnections: { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now },
      connectionChecks: {
        checkEndpoint, listMcpTools: vi.fn(async () => [{ name: "a" }]),
        fetch: vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id: "lin-user-1" } } }), { status: 200 })),
      },
    },
  });
  holder.db = t.db;
  const { db } = t;
  // Every command the table gets, with the tables it touches, so a write can be told from a read and a refused turn's own journal line from anything else.
  const sent: Array<{ name: string; tables: string[]; items: Item[] }> = [];
  const original = db.send.bind(db) as (command: unknown) => Promise<unknown>;
  (db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
    const { name } = (command as { constructor: { name: string } }).constructor;
    const input = (command as { input: { TableName?: string; Item?: Item; TransactItems?: Array<Record<string, { TableName?: string; Item?: Item }>> } }).input;
    const parts = input.TransactItems?.flatMap((entry) => Object.values(entry)) ?? [input];
    sent.push({ name, tables: parts.map((part) => String(part.TableName)), items: parts.flatMap((part) => (part.Item === undefined ? [] : [part.Item])) });
    return original(command);
  };

  // Beth, org B's owner, is signed in and in B; Omar was put in B by the resolver and stays a member.
  for (const who of [BETH]) {
    db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await t.orgOf(who);
    seedMembership(db, who.developerId, { orgId: ORG_B, role: "owner" });
  }
  // Both orgs have projects `web` and `payments` of their own. A's `payments` is the one the harness registered.
  seedProject(db, TEST_ORG, "web", DEB.developerId);
  seedProject(db, ORG_B, "web", BETH.developerId);
  seedProject(db, ORG_B, "payments", BETH.developerId);
  const grant = (orgId: OrgId, who: Developer, project: string, projectRole: "maintainer" | "contributor") =>
    db.set({ ...projectMemberKey(orgId, who.developerId, project), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: project, grantId: randomUUID(), role: "developer", projectRole, grantedAt: "2026-10-01T00:00:00.000Z" });
  for (const project of ["web", "payments"]) grant(ORG_B, OMAR, project, "maintainer");
  for (const who of [MAYA, BEN]) grant(TEST_ORG, who, "web", "maintainer");

  const api = t.api;
  const created = async (reply: Promise<Reply>, status = 201): Promise<Record<string, unknown>> => {
    const answered = await reply;
    expect(answered.status, JSON.stringify(answered.body)).toBe(status);
    return answered.body;
  };

  // ---- A's agent X: two published versions, on both rosters of A, shared with Ben at `use`.
  const X = await t.agentOf(TRIAGE, { name: "Atlas ticket looker" });
  await t.publishNext(X, { ...TRIAGE, instructions: "Summarise the open tickets, newest first." });
  db.set({ ...projectAgentKey(TEST_ORG, "web", X), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project: "web", agentId: X, addedBy: MAYA.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
  // Shared with Ben at `use`, and with A's project `payments`, so a project's list of A's holds X.
  const shares = await api(MAYA, "PUT", `/v1/app/agents/${X}/shares`, { shares: [
    { principal: { kind: "member", developerId: BEN.developerId }, level: "use" }, { principal: { kind: "project", project: "payments" }, level: "use" },
  ] });
  expect(shares.status, JSON.stringify(shares.body)).toBe(200);
  // ---- A's skill S, connection C and company AI source.
  const S = ((await created(api(MAYA, "POST", "/v1/app/skills", { content: skillFile("a-skill") }))).skill as { skillId: string; currentDigest: string }).skillId;
  const C = ((await created(api(DEB, "POST", "/v1/app/connections", { connection: { type: "linear", label: "A Linear", access: "read" }, secret: { apiKey: LINEAR_KEY } }))).connection as { connectionId: string }).connectionId;
  const SRC = String((await created(api(DEB, "POST", "/v1/app/org/model-sources", { source: { kind: "anthropic", label: "A Anthropic", models: [{ catalog: SONNET }] }, apiKey: SOURCE_KEY }))).sourceId);
  expect((await api(DEB, "PUT", "/v1/app/org/model-sources-order", { order: [SRC, "rovara"] })).status).toBe(200);

  // ---- A's runs: T is a run of X, U a run of the built-in ticket-triage.
  // (Nobody may hold more than three open workspaces, so the runs are spread over A's people.)
  const T = await t.runOf(X, { who: BEN });
  const U = await t.runOf("ticket-triage", { who: CARL });

  // ---- A's spend requests, one of every kind.
  const run = await t.plainTask();
  await t.set(run.taskId, "SET budgetUsd = :limit", { ":limit": 14 });
  await t.pauseAndEnd(run);
  const runLimit = t.requestOf(run.taskId, "run_limit")[0]!;

  const maxAgent = await t.agentOf(TRIAGE, { name: "Atlas max looker" });
  expect((await t.setBudget(MAYA, maxAgent, { maxPerRunUsd: 4 })).status).toBe(200);
  await t.shareWith(maxAgent, BEN);
  const maxRun = await t.runOf(maxAgent, { who: BEN });
  await t.set(maxRun.taskId, "SET budgetUsd = :limit", { ":limit": 25 });
  await t.pauseAndEnd(maxRun, { kind: "max_per_run", taskId: maxRun.taskId });
  const maxPerRun = t.requestOf(maxRun.taskId, "max_per_run")[0]!;

  const coder = await t.agentOf(CODING, { name: "Atlas coder" });
  await t.shareWith(coder, CARL);
  const planRun = await t.runOf(coder, { who: CARL });
  await t.set(planRun.taskId, "SET budgetUsd = :limit", { ":limit": 6 });
  await t.pauseAndEnd(planRun, { kind: "planning", taskId: planRun.taskId });
  const planning = t.requestOf(planRun.taskId, "planning")[0]!;

  const monthRun = await t.plainTask();
  await t.pauseAndEnd(monthRun, { kind: "member", developerId: MAYA.developerId });
  const monthly = t.requests().find((record) => record.kind === "month")!;

  await t.budgeted(50);
  await t.budgeted(50);
  const capped = await t.agentOf();
  const cap = await t.setBudget(MAYA, capped, { monthlyUsd: 1 });
  expect(cap.status, JSON.stringify(cap.body)).toBe(202);
  const ownerCap = t.requests().find((record) => record.kind === "owner_cap")!;

  // ---- A's held start: a run that began with a run limit of 0, whose approval committed but whose dispatch failed.
  const started = await startAgentRun(t.starter(), {
    requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Fix the retry bug" }, origin: "app",
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, runLimitUsd: 0,
  });
  const heldRequest = t.requestOf(started.taskId)[0]!;
  const deps0 = t.deps();
  const failing = { ...deps0, spendRequests: { ...deps0.spendRequests!, resumeTask: () => Promise.reject(new Error("no free workspace")) } };
  await decideSpendRequest(failing, t.caller(MAYA), heldRequest.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
  const held = db.find((item) => item.entityType === "SPEND_HELD_START");
  expect(held).toHaveLength(1);

  // ---- A's approvals: a write approval P and a step approval Q of run T, and a change approval waiting on an admin.
  const approvalDeps = t.deps() as ApprovalDependencies;
  const operationOfT = String((db.get(`WORKSPACE#${T.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const createdAt = new Date().toISOString();
  const P = `apr_${"p".repeat(20)}`;
  const writeRecord: WriteApprovalRecord = {
    orgId: TEST_ORG, approvalId: P, kind: "write", subject: { kind: "agent_run", taskId: T.taskId, stepId: "investigate" }, operationId: operationOfT,
    connector: "linear", connectorType: "linear", tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64),
    arguments: { title: "A-ONLY-WRITE-ARGUMENT" }, argumentsHash: "c".repeat(64), summary: "create the issue A-ONLY-WRITE-ARGUMENT", class: "consequential",
    approvers: { kind: "ids", ids: [BEN.developerId] }, status: "PENDING", project: "payments", owner: { developerId: BEN.developerId, name: BEN.name },
    attempts: 0, createdAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const writeEvent = { Put: { TableName: "state", Item: { ...approvalTaskEventKey(T.taskId, createdAt, P), entityType: "TASK_EVENT", orgId: TEST_ORG, kind: "status", text: "Agent wants to create the issue.", at: createdAt } } };
  expect(await createWriteApprovalRecord(approvalDeps, writeRecord, [writeEvent], 8)).toBe("created");
  const stepRecord = await createStepApproval(approvalDeps, {
    orgId: TEST_ORG, subject: { kind: "agent_run", taskId: T.taskId, stepId: "report" }, prompt: "Send the A-ONLY-STEP report to customers?",
    approvers: { kind: "ids", ids: [BEN.developerId] }, project: "payments", owner: { developerId: BEN.developerId, name: BEN.name },
  });
  const Q = stepRecord.approvalId;
  // A less-safe change of A's agent waits as a change approval (publishing a raise of autonomy, which the guardrails allow once an admin has said so).
  db.set({
    ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: DEB.developerId, updatedAt: "2026-10-21T00:00:00.000Z",
    guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "run" },
  });
  const changeId = await (async () => {
    const draft = await api(MAYA, "GET", `/v1/app/agents/${X}/draft`);
    const revision = (draft.body.draft as { revision: number }).revision;
    const edited = await api(MAYA, "PUT", `/v1/app/agents/${X}/draft`, { expectedRevision: revision, overlay: { ...TRIAGE, autonomy: "run" } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const published = await api(MAYA, "POST", `/v1/app/agents/${X}/publish`, { expectedRevision: revision + 1 });
    expect(published.status, JSON.stringify(published.body)).toBe(202);
    const url = String(published.body.confirmUrl);
    return url.slice(url.lastIndexOf("/") + 1).split("?")[0]!;
  })();

  // ---- A's money: a ledger line and the counters the spend routes read.
  const thisMonth = month();
  const at = new Date().toISOString();
  db.set({ ...ledgerKey(TEST_ORG, thisMonth, at, "c".repeat(64), 1), entityType: "SPEND_LEDGER", orgId: TEST_ORG, at, usd: 12.34, settledUsd: 12.34, finalized: true, model: "A-ONLY-MODEL", taskId: T.taskId, agentId: X, project: "payments", payerKind: "member", payerId: MAYA.developerId, source: SRC, origin: "app" });
  db.set({ ...spendCounterKey(TEST_ORG, thisMonth, "ORG"), entityType: "SPEND_COUNTER", spentUsd: 12.34, committedUsd: 3 });
  db.set({ ...spendCounterKey(TEST_ORG, thisMonth, "PROJECT#payments"), entityType: "SPEND_COUNTER", spentUsd: 12.34, committedUsd: 3 });
  // A's built-in ticket-triage has A's own budget and A's run U's spend; B's ticket-triage is another thing with the same id.
  const triage = await api(DEB, "PUT", "/v1/app/agents/ticket-triage/budget", { monthlyUsd: 25, maxPerRunUsd: 6 });
  expect(triage.status, JSON.stringify(triage.body)).toBe(200);
  db.set({ ...spendCounterKey(TEST_ORG, thisMonth, agentUsageCounter("ticket-triage")), entityType: "SPEND_COUNTER", spentUsd: 5.55 });
  db.set({ ...agentRunsKey(TEST_ORG, thisMonth, "ticket-triage", U.taskId), entityType: "AGENT_RUN_COST", orgId: TEST_ORG, taskId: U.taskId, project: "payments", origin: "app", usd: 5.55, lastAt: at });

  // A's spend policy is not the default: a multiplier of 3 and a testing allowance of $77.
  const policy = await api(DEB, "PUT", "/v1/app/org/spend-policy", { runLimitMultiplier: 3, testingAllowanceUsd: 77 });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  // ---- B's own things, so B's answers are B's and not merely empty.
  const BX = ((await created(api(OMAR, "POST", "/v1/app/agents", { name: "B looker", overlay: TRIAGE }))).agent as { agentId: string }).agentId;
  const BS = ((await created(api(BETH, "POST", "/v1/app/skills", { content: skillFile("b-skill", "# B\n\nB-ONLY\n") }))).skill as { skillId: string }).skillId;
  const BC = ((await created(api(BETH, "POST", "/v1/app/connections", { connection: { type: "linear", label: "B Linear", access: "read" }, secret: { apiKey: "lin_api_BEEBEEBEEBEE0123456789" } }))).connection as { connectionId: string }).connectionId;

  {
    const draft = (await t.store.getDraft(ORG_B, BX))!;
    await t.store.saveDraft({ orgId: ORG_B, agentId: BX, overlay: TRIAGE, expectedRevision: draft.revision, by: OMAR.developerId });
    const agent = (await t.store.get(ORG_B, BX))!;
    await t.store.publish({ orgId: ORG_B, agentId: BX, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(t.store, ORG_B, BX, "draft")), by: OMAR.developerId });
  }
  // B's run of B's agent, on B's `payments`, whose preparation has finished: its agent step is the active operation.
  for (const project of ["web", "payments"]) db.set({ ...projectAgentKey(ORG_B, project, BX), entityType: "PROJECT_AGENT", orgId: ORG_B, project, agentId: BX, addedBy: OMAR.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
  const bStarted = await api(OMAR, "POST", `/v1/app/agents/${BX}/runs`, { project: "payments", input: { text: "Look at B's ticket" } });
  expect(bStarted.status, JSON.stringify(bStarted.body)).toBe(202);
  const bTaskId = (bStarted.body.task as { taskId: string }).taskId;
  const bWorkspaceId = t.meta(bTaskId).workspaceId;
  await t.finish(bWorkspaceId, t.operations(bWorkspaceId).find((operation) => operation.kind === "prepare")!.id, "SUCCEEDED", PREPARED);
  const bDraftRevision = (await t.store.getDraft(ORG_B, BX))!.revision;
  const bRun = { taskId: bTaskId, workspaceId: bWorkspaceId, operationId: t.activeOf(bWorkspaceId) };

  /**
   * Every item of every table, in key order, except the turn journal (a refused AI-tool turn leaves its own journal line, checked apart). `sessions`: the confirmation
   * page's own session and ticket items are left out too (it claims a session to decide, and gives it back). `requestItems`: so are org B's own request items
   * (R18), which a no-op change records.
   */
  const stateFingerprint = (sessions = false, requestItems = false): string => JSON.stringify(
    db.find((item) => !(/^TASK#/.test(String(item.pk)) && /^TURN#/.test(String(item.sk)))
      && (sessions !== true || !/^DECIDE_(SESSION|TICKET|STATE)#|^DECIDE_RATE#/.test(String(item.pk)))
      && (requestItems !== true || !(item.entityType === "AGENT_REQUEST" && String(item.pk).includes(ORG_B)))).map((item) => [item.pk, item.sk, item]).sort((a, b) => `${String(a[0])}|${String(a[1])}`.localeCompare(`${String(b[0])}|${String(b[1])}`)),
    stable,
  );
  const ids = {
    X, S, C, SRC, T: T.taskId, U: U.taskId, P, Q, changeId, runLimit: runLimit.spendRequestId, maxPerRun: maxPerRun.spendRequestId, planning: planning.spendRequestId,
    month: monthly.spendRequestId, ownerCap: ownerCap.spendRequestId, held: heldRequest.spendRequestId, BX, BS, BC,
    /** A person of A's. */
    maya: MAYA.developerId,
  };
  /** The same ids with every object of A replaced by one of the right shape that no org has. */
  const twin: typeof ids = {
    ...ids, X: MISSING.agent, S: MISSING.skill, C: MISSING.connection, SRC: MISSING.source, T: randomUUID(), U: randomUUID(), P: MISSING.approval, Q: MISSING.approval, changeId: MISSING.approval,
    runLimit: MISSING.spend, maxPerRun: MISSING.spend, planning: MISSING.spend, month: MISSING.spend, ownerCap: MISSING.spend, held: MISSING.spend, maya: "a".repeat(64),
  };
  return {
    ...t, fake, fakeLinear, twin, secrets, api, ids, bRun, bDraftRevision, sent, stateFingerprint, tasks: { T, U, run, maxRun, planRun, monthRun, held: started }, requestsOf: { runLimit, maxPerRun, planning, monthly, ownerCap, heldRequest },
  };
}
type World = Awaited<ReturnType<typeof world>>;

// ---- what one refusal must show

type Ids = World["ids"];
interface Expected { status: number; code: string }

/** Everything of org A that a reply to org B must never hold, in any encoding a reply uses (the ids, the names, the markers, A's people, A's org, A's figures). */
function needlesOf(w: World): string[] {
  return [
    ...Object.entries(w.ids).filter(([key]) => !["BX", "BS", "BC"].includes(key)).map(([, value]) => value),
    w.tasks.T.workspaceId, w.tasks.U.workspaceId, w.tasks.run.workspaceId,
    "Atlas", "A Linear", "A Anthropic", "a-skill", SKILL_MARKER, "A-ONLY", LINEAR_KEY, SOURCE_KEY, TEST_ORG,
    ...[MAYA, BEN, CARL, ADA, DEB].flatMap((who) => [who.developerId, who.name]),
  ];
}

/** A reply with every id of A's that it echoes read as its twin, so an answer that repeats what the caller typed compares with the one for an id no org has. */
/** A's figures: no number of a B answer equals one (a timestamp's digits are not a number). */
const A_FIGURES = [12.34, 5.55, 77];
const numbersIn = (value: unknown): number[] => (typeof value === "number" ? [value] : Array.isArray(value) ? value.flatMap(numbersIn) : typeof value === "object" && value !== null ? Object.values(value).flatMap(numbersIn) : []);
const holdsFigureOfA = (value: unknown): boolean => numbersIn(value).some((number) => A_FIGURES.includes(number));

const bodyOf = (w: World, reply: Reply) => {
  let text = JSON.stringify(reply.body);
  for (const key of Object.keys(w.ids) as Array<keyof Ids>) text = text.split(w.ids[key]).join(w.twin[key]);
  return { status: reply.status, body: JSON.parse(text) as unknown };
};

/**
 * Runs `request` and holds it to what every cross-org refusal owes: the answer is `expected`; nothing is written (no write command reached the table and no item
 * of any table changed, so a session or a counter is not written either); the secrets fake was not called; and the answer holds nothing of org A. Answers the
 * reply, so a caller can compare it with the same request for an id that does not exist.
 */
async function refused(w: World, label: string, request: () => Promise<Reply>, expected: Expected, options: { sessions?: boolean; requestItem?: boolean; who?: Developer; supplied?: string } = {}): Promise<Reply> {
  const commands = w.db.commandNames().length;
  const sentBefore = w.sent.length;
  const secrets = w.fake.calls.length;
  const linearCalls = w.fakeLinear.calls.length;
  const before = w.stateFingerprint(options.sessions === true, options.requestItem === true);
  const reply = await request();
  expect({ label, status: reply.status, code: (reply.body.error as { code?: string } | undefined)?.code ?? "" }, label).toEqual({ label, ...expected });
  const wrote = w.db.commandNames().slice(commands).filter((name) => WRITE_COMMANDS.test(name));
  // The one write a refusal may make is the journal line of the refused AI-tool turn, in the turns table, in the caller's own name (no org's object, no A id).
  const journal = w.sent.slice(sentBefore).filter((command) => WRITE_COMMANDS.test(command.name));
  // A no-op change (taking an id off a roster it is not on) records the caller's own request item, and nothing else (R18).
  const requestOnly = (command: (typeof journal)[number]) => options.requestItem === true && command.items.length > 0 && command.items.every((item) => item.entityType === "AGENT_REQUEST" && String(item.pk).includes(ORG_B));
  // The confirmation page claims the caller's decide session to decide, and gives it back: the one other write, to the sign-in table, as an update of that session.
  const sessionOnly = (command: (typeof journal)[number]) => options.sessions === true && command.name === "UpdateCommand" && command.tables.every((table) => table === "signin");
  expect(journal.filter((command) => !requestOnly(command) && !sessionOnly(command) && command.tables.some((table) => table !== "turns")), `${label}: the table was written`).toEqual([]);
  expect(wrote.length, `${label}: the table was written`).toBe(journal.length);
  for (const line of journal.filter((command) => !requestOnly(command) && !sessionOnly(command)).flatMap((command) => command.items)) {
    expect(line, `${label}: a journal line`).toMatchObject({ phase: "refused", outcome: "refused", ...(options.who === undefined ? {} : { developer: { developerId: options.who.developerId } }) });
  }
  expect(w.stateFingerprint(options.sessions === true, options.requestItem === true) === before, `${label}: an item changed`).toBe(true);
  expect(w.fake.calls.length, `${label}: the secrets fake was called`).toBe(secrets);
  expect(w.fakeLinear.calls.length, `${label}: the vendor was called`).toBe(linearCalls);
  const text = JSON.stringify([reply.body, journal.flatMap((command) => command.items)]);
  expect(holdsFigureOfA([reply.body, journal.flatMap((command) => command.items)]), `${label}: the answer holds a figure of A's`).toBe(false);
  // What the request itself carried (an id B typed) may come back in a refusal's words; nothing else of A may.
  for (const needle of needlesOf(w).filter((value) => options.supplied?.includes(value) !== true)) expect(text.includes(needle), `${label}: the answer holds ${needle.length > 12 ? `${needle.slice(0, 12)}...` : needle}`).toBe(false);
  return reply;
}

interface Case {
  name: string;
  /** The request, for A's ids or for their twins. */
  request: (ids: Ids, who: Developer, w: World) => [method: string, path: string, body?: Record<string, unknown>];
  status: number;
  code: string;
  /** An org owner's or admin's route: B's plain member is refused for the role first, as an A member is. */
  adminOnly?: boolean;
  /** A change that is a no-op for B records B's own request item (R18) and nothing else; the answer is still the one a missing id gets. */
  requestItem?: boolean;
}

/** Each case, as each person of B, for A's ids and for ids no org has: refused as specified, and the two answers are the same. */
async function runCases(w: World, cases: Case[]): Promise<void> {
  for (const who of B_PEOPLE) {
    for (const entry of cases) {
      const expected: Expected = entry.adminOnly === true && who === OMAR ? { status: 403, code: "FORBIDDEN" } : { status: entry.status, code: entry.code };
      const [method, path, body] = entry.request(w.ids, who, w);
      const theirs = await refused(w, `${who.name}: ${entry.name}`, () => w.api(who, method, path, body), expected, { who, requestItem: entry.requestItem === true, supplied: JSON.stringify([path, body]) });
      const [methodTwin, pathTwin, bodyTwin] = entry.request(w.twin, who, w);
      const absent = await refused(w, `${who.name}: ${entry.name} (an id no org has)`, () => w.api(who, methodTwin, pathTwin, bodyTwin), expected, { who, requestItem: entry.requestItem === true, supplied: JSON.stringify([pathTwin, bodyTwin]) });
      expect(bodyOf(w, theirs), `${who.name}: ${entry.name}: another org's object must answer as a missing one does`).toEqual(bodyOf(w, absent));
    }
  }
}

/** The same call by A's own person, for a read: the object is there, so a refusal above is the org line and not a bad fixture. */
async function control(w: World, who: Developer, path: string, status = 200): Promise<Reply> {
  const reply = await w.api(who, "GET", path);
  expect(reply.status, `${who.name} reads ${path}: ${JSON.stringify(reply.body)}`).toBe(status);
  return reply;
}

const NOT_FOUND = { status: 404, code: "NOT_FOUND" } as const;
const NO_AGENT = NOT_FOUND;
const share = (who: Developer) => ({ shares: [{ principal: { kind: "member", developerId: who.developerId }, level: "use" }] });

const isTurnLine = (item: Item): boolean => /^TASK#/.test(String(item.pk)) && /^TURN#/.test(String(item.sk));
/** A journal line of one of A's people. */
const isOfA = (item: Item): boolean => [MAYA, BEN, CARL, ADA, DEB].some((who) => (item.developer as { developerId?: string } | undefined)?.developerId === who.developerId);
/**
 * Org A's own items (everything that names A's org), in key order: what B's activity must leave exactly as it was. The refused turns' journal is not A's, and the
 * decide sessions the tests open (one names A's org for a B person, on purpose) are the tests' own.
 */
const aState = (w: World): string => JSON.stringify(
  w.db.find((item) => !/^DECIDE_/.test(String(item.pk)) && (isTurnLine(item) ? isOfA(item) : JSON.stringify(item, stable).includes(TEST_ORG))).map((item) => [item.pk, item.sk, item])
    .sort((a, b) => `${String(a[0])}|${String(a[1])}`.localeCompare(`${String(b[0])}|${String(b[1])}`)),
  stable,
);
let aBefore = "";
let shared: World;
beforeAll(async () => {
  const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try { shared = await world(); } finally { quiet.mockRestore(); }
}, 60_000);

describe("the controls: org A's own people reach every object the suite asks B for", () => {
  it("reads A's agent, skill, connection, spend requests, approvals, runs and spend", async () => {
    const { ids } = shared;
    for (const path of [
      `/v1/app/agents/${ids.X}`, `/v1/app/agents/${ids.X}/versions/1`, `/v1/app/agents/${ids.X}/diff?from=1&to=2`, `/v1/app/agents/${ids.X}/draft`, `/v1/app/agents/${ids.X}/spend`,
      `/v1/app/agents/${ids.X}/shares`, `/v1/app/agents/${ids.X}/versions`, "/v1/app/projects/web/agents", "/v1/app/projects/payments/agents",
      `/v1/app/skills/${ids.S}`, "/v1/app/skills", "/v1/app/org/model-sources", "/v1/app/projects/web/connectors",
    ]) await control(shared, MAYA, path);
    expect(((await control(shared, MAYA, "/v1/app/agents?project=payments")).body.agents as Array<{ agentId: string }>).map((agent) => agent.agentId)).toContain(ids.X);
    await control(shared, DEB, `/v1/app/connections/${ids.C}`);
    await control(shared, DEB, "/v1/app/org/spend");
    await control(shared, DEB, "/v1/app/org/spend/ledger");
    await control(shared, DEB, "/v1/app/org/agent-guardrails");
    expect(((await control(shared, DEB, "/v1/app/org/spend-policy")).body as { policy: { testingAllowanceUsd: number } }).policy.testingAllowanceUsd).toBe(77);
    // A spend request is read by someone who may decide it or who asked for it.
    await control(shared, BEN, `/v1/app/spend-requests/${ids.runLimit}`);
    await control(shared, MAYA, `/v1/app/spend-requests/${ids.maxPerRun}`);
    await control(shared, DEB, `/v1/app/spend-requests/${ids.month}`);
    await control(shared, DEB, `/v1/app/spend-requests/${ids.ownerCap}`);
    await control(shared, CARL, `/v1/app/spend-requests/${ids.planning}`);
    await control(shared, MAYA, `/v1/app/spend-requests/${ids.held}`);
    // The approvals: the write and step approvals are read by their approver, the change by an admin.
    for (const id of [ids.P, ids.Q]) await control(shared, BEN, `/v1/app/approvals/${id}`);
    await control(shared, DEB, `/v1/app/approvals/${ids.changeId}`);
    for (const id of [ids.T, ids.U]) await control(shared, id === ids.T ? BEN : CARL, `/v1/dev/tasks/${id}`);
    expect(shared.ids.SRC).toMatch(/^src_/);
    aBefore = aState(shared);
  });
});

describe("org B's member and owner ask for org A's agent X", () => {
  it("refuses every agent route for X, by id, extends, roster, run and task start, as it refuses an agent no org has", async () => {
    await runCases(shared, [
      { name: "GET agent", request: ({ X }) => ["GET", `/v1/app/agents/${X}`], ...NO_AGENT },
      { name: "GET version 1", request: ({ X }) => ["GET", `/v1/app/agents/${X}/versions/1`], ...NO_AGENT },
      { name: "GET versions", request: ({ X }) => ["GET", `/v1/app/agents/${X}/versions`], ...NO_AGENT },
      { name: "GET diff", request: ({ X }) => ["GET", `/v1/app/agents/${X}/diff?from=1&to=2`], ...NO_AGENT },
      { name: "GET draft", request: ({ X }) => ["GET", `/v1/app/agents/${X}/draft`], ...NO_AGENT },
      { name: "GET spend", request: ({ X }) => ["GET", `/v1/app/agents/${X}/spend`], ...NO_AGENT },
      { name: "GET shares", request: ({ X }) => ["GET", `/v1/app/agents/${X}/shares`], ...NO_AGENT },
      { name: "PATCH agent", request: ({ X }) => ["PATCH", `/v1/app/agents/${X}`, { name: "Mine now" }], ...NO_AGENT },
      { name: "PUT draft", request: ({ X }) => ["PUT", `/v1/app/agents/${X}/draft`, { expectedRevision: 1, overlay: TRIAGE }], ...NO_AGENT },
      { name: "POST publish", request: ({ X }) => ["POST", `/v1/app/agents/${X}/publish`, { expectedRevision: 1 }], ...NO_AGENT },
      { name: "POST rollback", request: ({ X }) => ["POST", `/v1/app/agents/${X}/rollback`, { version: 1 }], ...NO_AGENT },
      { name: "POST archive", request: ({ X }) => ["POST", `/v1/app/agents/${X}/archive`, {}], ...NO_AGENT },
      { name: "POST unarchive", request: ({ X }) => ["POST", `/v1/app/agents/${X}/unarchive`, {}], ...NO_AGENT },
      { name: "PUT shares naming a B principal", request: ({ X }, who) => ["PUT", `/v1/app/agents/${X}/shares`, share(who)], ...NO_AGENT },
      { name: "PUT owner", request: ({ X }, who) => ["PUT", `/v1/app/agents/${X}/owner`, { owner: { kind: "member", developerId: who.developerId } }], ...NO_AGENT },
      { name: "PUT accountable", request: ({ X }, who) => ["PUT", `/v1/app/agents/${X}/accountable`, { accountable: { developerId: who.developerId } }], ...NO_AGENT },
      { name: "PUT budget", request: ({ X }) => ["PUT", `/v1/app/agents/${X}/budget`, { monthlyUsd: 5 }], ...NO_AGENT },
      { name: "POST update-base", request: ({ X }) => ["POST", `/v1/app/agents/${X}/update-base`, { expectedRevision: 1 }], ...NO_AGENT },
      { name: "POST adopt", request: ({ X }) => ["POST", `/v1/app/agents/${X}/adopt`, { version: 1 }], status: 400, code: "CONFIG_INVALID" },
      { name: "POST runs on B's payments", request: ({ X }) => ["POST", `/v1/app/agents/${X}/runs`, { project: "payments", input: { text: "Look" } }], ...NO_AGENT },
      { name: "POST runs on B's web, as the owner's draft", request: ({ X }) => ["POST", `/v1/app/agents/${X}/runs`, { project: "web", version: "draft", input: { text: "Look" } }], ...NO_AGENT },
      { name: "POST agents extends X", request: ({ X }) => ["POST", "/v1/app/agents", { name: "Child of A", extends: X }], ...NO_AGENT },
      { name: "PUT draft of B's own agent, extends X", request: ({ X, BX }, _who, w) => ["PUT", `/v1/app/agents/${BX}/draft`, { expectedRevision: w.bDraftRevision, overlay: TRIAGE, extends: X }], ...NO_AGENT },
      { name: "PUT B's web roster with X", request: ({ X }) => ["PUT", `/v1/app/projects/web/agents/${X}`, {}], ...NO_AGENT },
      { name: "PUT B's payments roster with X", request: ({ X }) => ["PUT", `/v1/app/projects/payments/agents/${X}`, {}], ...NO_AGENT },
      // Taking an agent off a roster is allowed for any id (a maintainer can always remove one): for an id that is not on B's roster it is a no-op, the same for X as for no agent.
      { name: "DELETE X from B's web roster", request: ({ X }) => ["DELETE", `/v1/app/projects/web/agents/${X}`, {}], status: 200, code: "", requestItem: true },
      { name: "task start naming X", request: ({ X }) => ["POST", "/v1/dev/tasks", { project: "payments", instructions: "Look", agent: { agentId: X }, input: { text: "Look" }, client: "test-client" }], ...NO_AGENT },
      { name: "task start naming X's draft", request: ({ X }) => ["POST", "/v1/dev/tasks", { project: "payments", instructions: "Look", agent: { agentId: X, version: "draft" }, input: { text: "Look" }, client: "test-client" }], ...NO_AGENT },
    ]);
  });
});

describe("org B's agents name nobody of org A's", () => {
  it("refuses A's person as an owner, an accountable person or a share on B's agent, and as the owner of a new one, as it refuses a person no org has", async () => {
    const invalid = { status: 400, code: "CONFIG_INVALID" } as const;
    await runCases(shared, [
      { name: "PUT shares naming A's person", request: ({ BX, maya }) => ["PUT", `/v1/app/agents/${BX}/shares`, { shares: [{ principal: { kind: "member", developerId: maya }, level: "use" }] }], ...invalid },
      { name: "PUT owner naming A's person", request: ({ BX, maya }) => ["PUT", `/v1/app/agents/${BX}/owner`, { owner: { kind: "member", developerId: maya } }], adminOnly: true, ...invalid },
      { name: "PUT accountable naming A's person", request: ({ BX, maya }) => ["PUT", `/v1/app/agents/${BX}/accountable`, { accountable: { developerId: maya } }], ...invalid },
      { name: "POST agents owned by A's person", request: ({ maya }) => ["POST", "/v1/app/agents", { name: "Owned by a stranger", owner: { kind: "member", developerId: maya } }], adminOnly: true, ...invalid },
      { name: "PUT shares naming a project of A's that B has no project of", request: ({ BX }) => ["PUT", `/v1/app/agents/${BX}/shares`, { shares: [{ principal: { kind: "project", project: "billing" }, level: "use" }] }], ...invalid },
    ]);
  });
});

describe("org B's member and owner ask for org A's skill, connection and company AI source", () => {
  it("refuses A's skill by id, and a draft or a new agent that adds it, as a skill no org has", async () => {
    await runCases(shared, [
      { name: "GET skill", request: ({ S }) => ["GET", `/v1/app/skills/${S}`], ...NOT_FOUND },
      { name: "PUT skill content", request: ({ S }) => ["PUT", `/v1/app/skills/${S}/content`, { content: skillFile("b-edit"), expectedDigest: "a".repeat(64) }], ...NOT_FOUND },
      { name: "POST agents adding S", request: ({ S }) => ["POST", "/v1/app/agents", { name: "Skillful", overlay: { ...TRIAGE, skills: { add: [{ skillId: S }] } } }], status: 400, code: "CONFIG_INVALID" },
      { name: "PUT draft adding S", request: ({ S, BX }, _who, w) => ["PUT", `/v1/app/agents/${BX}/draft`, { expectedRevision: w.bDraftRevision, overlay: { ...TRIAGE, skills: { add: [{ skillId: S }] } } }], status: 400, code: "CONFIG_INVALID" },
    ]);
    // The refusal of a draft and of a new agent is the one a skill that does not exist gets, in the plan's words.
    const draft = await shared.api(OMAR, "PUT", `/v1/app/agents/${shared.ids.BX}/draft`, { expectedRevision: shared.bDraftRevision, overlay: { ...TRIAGE, skills: { add: [{ skillId: shared.ids.S }] } } });
    expect(draft.body.error).toEqual({ code: "CONFIG_INVALID", message: "skills: unknown skill" });
    const made = await shared.api(OMAR, "POST", "/v1/app/agents", { name: "Skillful", overlay: { ...TRIAGE, skills: { add: [{ skillId: shared.ids.S }] } } });
    expect(made.body.error).toEqual({ code: "CONFIG_INVALID", message: "skills: unknown skill" });
  });

  it("refuses A's connection by id, and a connector of B's web that names it, as a connection no org has", async () => {
    const connector = (credentialRef: string) => ({ name: "linear", type: "linear", credentialRef, scopes: [{ alias: "charterarc", teamId: CHARTERARC_TEAM_ID }], tools: READ_TOOLS });
    await runCases(shared, [
      { name: "GET connection", request: ({ C }) => ["GET", `/v1/app/connections/${C}`], ...NOT_FOUND },
      { name: "PUT connection", request: ({ C }) => ["PUT", `/v1/app/connections/${C}`, { connection: { type: "linear", label: "Mine", access: "read" } }], adminOnly: true, ...NOT_FOUND },
      { name: "DELETE connection", request: ({ C }) => ["DELETE", `/v1/app/connections/${C}`, {}], adminOnly: true, ...NOT_FOUND },
      { name: "POST connection check", request: ({ C }) => ["POST", `/v1/app/connections/${C}/check`, {}], adminOnly: true, ...NOT_FOUND },
      { name: "PUT B's web connector naming C", request: ({ C }) => ["PUT", "/v1/app/projects/web/connectors/linear", { expectedRevision: 1, connector: connector(C) }], status: 400, code: "CONFIG_INVALID" },
      { name: "PUT B's payments connector naming C", request: ({ C }) => ["PUT", "/v1/app/projects/payments/connectors/linear", { expectedRevision: 1, connector: connector(C) }], status: 400, code: "CONFIG_INVALID" },
    ]);
  });

  it("refuses A's company AI source in B's order, change, removal and check, and in B's project's source order", async () => {
    await runCases(shared, [
      { name: "PUT model-sources-order naming src_a", request: ({ SRC }) => ["PUT", "/v1/app/org/model-sources-order", { order: [SRC] }], adminOnly: true, status: 400, code: "CONFIG_INVALID" },
      { name: "PUT model-sources-order naming src_a and rovara", request: ({ SRC }) => ["PUT", "/v1/app/org/model-sources-order", { order: [SRC, "rovara"] }], adminOnly: true, status: 400, code: "CONFIG_INVALID" },
      { name: "PUT model source", request: ({ SRC }) => ["PUT", `/v1/app/org/model-sources/${SRC}`, { source: { kind: "anthropic", label: "Mine", models: [{ catalog: SONNET }] } }], adminOnly: true, ...NOT_FOUND },
      { name: "DELETE model source", request: ({ SRC }) => ["DELETE", `/v1/app/org/model-sources/${SRC}`, {}], adminOnly: true, ...NOT_FOUND },
      { name: "POST model source check", request: ({ SRC }) => ["POST", `/v1/app/org/model-sources/${SRC}/check`, {}], adminOnly: true, ...NOT_FOUND },
      { name: "PUT B's web AI settings with src_a in the source order", request: ({ SRC }) => ["PUT", "/v1/app/projects/web/ai", { sourceOrder: [SRC] }], adminOnly: true, status: 400, code: "CONFIG_INVALID" },
    ]);
    // The proxy was never asked to touch A's source, and A's source and order are as A left them.
    expect(shared.access.removeSource).not.toHaveBeenCalled();
    expect(shared.access.checkSource).not.toHaveBeenCalled();
  });
});

describe("org B's member and owner ask for org A's spend requests, approvals and runs", () => {
  const spendKinds = ["runLimit", "maxPerRun", "planning", "month", "ownerCap", "held"] as const;

  it("refuses A's spend request of every kind (run limit, max per run, planning, month, owner cap and a held start's) to read, to link and to decide", async () => {
    const cases: Case[] = spendKinds.flatMap((kind): Case[] => [
      { name: `GET ${kind} spend request`, request: (ids) => ["GET", `/v1/app/spend-requests/${ids[kind]}`], status: 404, code: "NOT_FOUND" },
      { name: `POST ${kind} confirm-link`, request: (ids) => ["POST", `/v1/app/spend-requests/${ids[kind]}/confirm-link`, {}], status: 404, code: "NOT_FOUND" },
      // A token is sent to the confirmation page after the request is looked at for the caller's org: for an id of another org that look finds nothing, and no ticket is minted.
      { name: `POST ${kind} decide with a token`, request: (ids) => ["POST", `/v1/app/spend-requests/${ids[kind]}/decide`, { decision: "APPROVE" }], status: 404, code: "NOT_FOUND" },
    ]);
    await runCases(shared, cases);
  });

  it("refuses A's write approval, step approval and change approval to read, to link and to decide", async () => {
    const cases: Case[] = (["P", "Q", "changeId"] as const).flatMap((key): Case[] => [
      { name: `GET approval ${key}`, request: (ids) => ["GET", `/v1/app/approvals/${ids[key]}`], status: 404, code: "NOT_FOUND" },
      { name: `POST approval ${key} confirm-link`, request: (ids) => ["POST", `/v1/app/approvals/${ids[key]}/confirm-link`, {}], status: 404, code: "NOT_FOUND" },
      { name: `POST approval ${key} decide with a token`, request: (ids) => ["POST", `/v1/app/approvals/${ids[key]}/decide`, { decision: "APPROVE" }], status: 404, code: "NOT_FOUND" },
    ]);
    await runCases(shared, cases);
  });

  it("refuses A's runs T and U to read, follow, stop, continue and continue as a task, as runs no org has", async () => {
    const notFound = { status: 404, code: "TASK_NOT_FOUND" } as const;
    const cases: Case[] = (["T", "U"] as const).flatMap((key): Case[] => [
      { name: `GET task ${key}`, request: (ids) => ["GET", `/v1/dev/tasks/${ids[key]}`], ...notFound },
      { name: `GET task ${key} events`, request: (ids) => ["GET", `/v1/dev/tasks/${ids[key]}/events`], ...notFound },
      { name: `POST task ${key} cancel`, request: (ids) => ["POST", `/v1/dev/tasks/${ids[key]}/cancel`, {}], ...notFound },
      { name: `POST task ${key} continue`, request: (ids) => ["POST", `/v1/dev/tasks/${ids[key]}/continue`, { instructions: "more" }], ...notFound },
      { name: `POST task ${key} close`, request: (ids) => ["POST", `/v1/dev/tasks/${ids[key]}/close`, {}], ...notFound },
      { name: `POST task ${key} workflow retry`, request: (ids) => ["POST", `/v1/dev/tasks/${ids[key]}/workflow/retry`, { expectedRevision: 1, instructions: "Go on." }], ...notFound },
      { name: `POST task ${key} workflow send-back`, request: (ids) => ["POST", `/v1/dev/tasks/${ids[key]}/workflow/send-back`, { expectedRevision: 1, instructions: "Go on." }], ...notFound },
      { name: `POST task ${key} workflow decision`, request: (ids) => ["POST", `/v1/dev/tasks/${ids[key]}/workflow/decision`, { expectedRevision: 1, decision: "APPROVE", reason: "Approved", artifactDigest: "a".repeat(64) }], ...notFound },
      { name: `POST task ${key} continue-as-task`, request: (ids) => ["POST", `/v1/app/tasks/${ids[key]}/continue-as-task`, {}], ...notFound },
    ]);
    await runCases(shared, cases);
  });

  it("refuses a request for more month budget on A's agent, and on another member's own budget, as it refuses ones that do not exist", async () => {
    await runCases(shared, [
      { name: "ask a month for A's agent", request: ({ X }) => ["POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "agent", agentId: X }, amountUsd: 5, reason: "More please" }], ...NOT_FOUND },
      { name: "ask a month on Maya's own budget", request: (ids, _who, w) => ["POST", "/v1/app/spend-requests", { kind: "month", scope: { kind: "member", developerId: ids === w.ids ? MAYA.developerId : "a".repeat(64) }, amountUsd: 5, reason: "More please" }], status: 403, code: "FORBIDDEN" },
    ]);
  });
});

describe("org B's lists, counts and money hold only org B's", () => {
  /** What a list of B's may hold: every row is B's own. A list that is empty for B is empty, and says nothing of A. */
  it("lists B's own agents, roster, skills, connections, sources, approvals, spend requests and tasks, and none of A's", async () => {
    const w = shared;
    // A list of tasks brings the caller's own task index up to date (B's run was started a moment ago); it does that once, before anything is held to a write.
    for (const who of B_PEOPLE) await w.api(who, "GET", "/v1/dev/tasks");
    for (const who of B_PEOPLE) {
      const read = async (path: string): Promise<Reply> => {
        const reply = await refusedFree(w, `${who.name} GET ${path}`, () => w.api(who, "GET", path), who);
        expect(reply.status, `${who.name} GET ${path}: ${JSON.stringify(reply.body)}`).toBe(200);
        return reply;
      };
      const agents = (reply: Reply) => (reply.body.agents as Array<{ agentId: string; builtin: boolean }>).filter((agent) => !agent.builtin).map((agent) => agent.agentId);
      expect(agents(await read("/v1/app/agents"))).toEqual([w.ids.BX]);
      expect(agents(await read("/v1/app/agents?scope=mine"))).toEqual(who === OMAR ? [w.ids.BX] : []);
      expect(agents(await read("/v1/app/agents?scope=shared"))).toEqual([]);
      // A project's list is the agents the project owns or has been given: B's `payments` and `web` are B's own, whatever A's projects of those names hold.
      expect(agents(await read("/v1/app/agents?project=payments"))).toEqual([]);
      expect(agents(await read("/v1/app/agents?project=web"))).toEqual([]);
      // A roster holds the built-ins, which every project has, and the agents added to it.
      expect(agents(await read("/v1/app/projects/payments/agents"))).toEqual([w.ids.BX]);
      expect(agents(await read("/v1/app/projects/web/agents"))).toEqual([w.ids.BX]);
      expect((await read("/v1/app/skills")).body.skills).toEqual([expect.objectContaining({ skillId: w.ids.BS })]);
      expect((await read("/v1/app/connections")).body.connections).toEqual([expect.objectContaining({ connectionId: w.ids.BC })]);
      expect((await read("/v1/app/projects/web/connectors")).body.connectors).toEqual([]);
      const sources = await read("/v1/app/org/model-sources");
      expect(sources.body.sources).toEqual([]);
      expect(sources.body.order).toEqual(["rovara"]);
      expect((await read("/v1/app/approvals")).body.approvals).toEqual([]);
      expect((await read("/v1/app/approvals?status=PENDING")).body.approvals).toEqual([]);
      expect((await read("/v1/app/spend-requests")).body.spendRequests).toEqual([]);
      const tasks = (await read("/v1/dev/tasks")).body.tasks as Array<{ taskId: string }>;
      expect(tasks.map((task) => task.taskId)).toEqual(who === OMAR ? [w.bRun.taskId] : []);
      // The people B sees are B's, and B's guardrails and spend policy are B's own (A raised its autonomy ceiling and set its own budgets).
      const members = (await read("/v1/app/org/members")).body.members as Array<{ developerId: string }>;
      expect(members.map((member) => member.developerId).sort()).toEqual([BETH.developerId, OMAR.developerId].sort());
      if (who === BETH) {
        const policy = (await read("/v1/app/org/spend-policy")).body as { policy?: Record<string, number>; revision?: number };
        expect(policy.policy).toEqual(defaultSpendPolicy());
      }
      const guardrails = await read("/v1/app/org/agent-guardrails");
      expect((guardrails.body.guardrails as { maxAutonomy: string }).maxAutonomy).toBe("prepare");
      expect(guardrails.body.revision).toBe(0);
    }
  });

  it("answers B's own spend as B's: nothing of A's counters, ledger, projects, agents or members, by month, by cursor or by project name", async () => {
    const w = shared;
    const owner = (path: string, extra: Case["adminOnly"] = undefined) => ({ path, extra });
    void owner;
    const thisMonth = month();
    const aLine = w.db.find((item) => String(item.pk).startsWith(`ORG#${TEST_ORG}#LEDGER#`))[0]!;
    const cursor = Buffer.from(JSON.stringify({ sk: aLine.sk })).toString("base64url");
    // The company's spend and ledger are an owner's or admin's: B's owner reads B's own (empty); B's member is refused for the role, as A's member is.
    for (const path of [`/v1/app/org/spend?month=${thisMonth}`, "/v1/app/org/spend", `/v1/app/org/spend/ledger?month=${thisMonth}`, `/v1/app/org/spend/ledger?month=${thisMonth}&cursor=${cursor}`, "/v1/app/org/spend-policy"]) {
      const member = await refusedFree(w, `Omar GET ${path}`, () => w.api(OMAR, "GET", path), OMAR);
      expect(member.status, path).toBe(403);
      expect(member.body.error).toMatchObject({ code: "FORBIDDEN" });
      const mine = await refusedFree(w, `Beth GET ${path}`, () => w.api(BETH, "GET", path), BETH);
      expect(mine.status, `${path}: ${JSON.stringify(mine.body)}`).toBe(200);
    }
    const spend = (await w.api(BETH, "GET", `/v1/app/org/spend?month=${thisMonth}`)).body;
    expect(spend).toMatchObject({ totalUsd: 0, committedUsd: 0, byProject: [], byMember: [], byAgent: [], bySource: [], byModel: [] });
    const ledger = (await w.api(BETH, "GET", `/v1/app/org/spend/ledger?month=${thisMonth}&cursor=${cursor}`)).body;
    expect(ledger).toEqual({ month: thisMonth, lines: [] });
    // A cursor is a position in the caller's own month: it names no key of another org's.
    expect((await w.api(BETH, "GET", `/v1/app/org/spend/ledger?month=${thisMonth}`)).body).toEqual({ month: thisMonth, lines: [] });
    // B's figures: its own budget, and the project spend of the project of the same name, which is B's.
    const budget = (await refusedFree(w, "Omar GET budget", () => w.api(OMAR, "GET", "/v1/app/budget"), OMAR)).body;
    expect(budget).toMatchObject({ org: { spentUsd: 0, committedUsd: 0 }, member: { spentUsd: 0 } });
    for (const project of ["payments", "web"]) {
      const figures = (await refusedFree(w, `Omar GET ${project} spend`, () => w.api(OMAR, "GET", `/v1/app/projects/${project}/spend`), OMAR)).body;
      expect(figures, project).toMatchObject({ project, spentUsd: 0, committedUsd: 0 });
    }
    expect((await refusedFree(w, "Omar GET payments ai", () => w.api(OMAR, "GET", "/v1/app/projects/payments/ai"), OMAR)).status).toBe(200);
  });
});

/** A read that is not a refusal, held to the other half of what a refusal owes: it writes nothing, calls no secret, and its answer holds nothing of A's. */
async function refusedFree(w: World, label: string, request: () => Promise<Reply>, who: Developer): Promise<Reply> {
  const commands = w.db.commandNames().length;
  const secrets = w.fake.calls.length;
  const before = w.stateFingerprint();
  const reply = await request();
  expect(w.db.commandNames().slice(commands).filter((name) => WRITE_COMMANDS.test(name)), `${label}: the table was written`).toEqual([]);
  expect(w.stateFingerprint() === before, `${label}: an item changed`).toBe(true);
  expect(w.fake.calls.length, `${label}: the secrets fake was called`).toBe(secrets);
  const text = JSON.stringify(reply.body);
  expect(holdsFigureOfA(reply.body), `${label} (${who.name}): the answer holds a figure of A's`).toBe(false);
  for (const needle of needlesOf(w)) expect(text.includes(needle), `${label} (${who.name}): the answer holds ${needle.length > 12 ? `${needle.slice(0, 12)}...` : needle}`).toBe(false);
  return reply;
}

describe("org B tries to decide org A's requests and approvals", () => {
  const decidable = ["runLimit", "maxPerRun", "planning", "month", "ownerCap", "held", "P", "Q", "changeId"] as const;
  /** A fresh sign-in on the confirmation page for `who`, as `orgId` has it, opened for `approvalId`. */
  async function sessionFor(w: World, who: Developer, orgId: OrgId, approvalId: string): Promise<{ cookie: string; proof: ReturnType<typeof decideProofOf> }> {
    const store = new DecideStore({ documentClient: w.db, tableName: "signin", now: Date.now });
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    await store.putSession(cookie, { orgId, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    return { cookie, proof: decideProofOf(cookie, { signedInAt, method: "email_code" }) };
  }
  const page = async (w: World, method: "GET" | "POST", approvalId: string, cookie: string, decision = "approve"): Promise<Reply> => {
    const response = await w.handler({
      version: "2.0", rawPath: `/v1/app/approve/${approvalId}`, rawQueryString: "",
      headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, ...(method === "POST" ? { origin: CELL, "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body: new URLSearchParams({ decision, csrf: csrfTokenFor(cookie) }).toString() } : {}),
      requestContext: { requestId: randomUUID(), http: { method } },
    });
    return { status: response.statusCode, body: { html: response.body } };
  };
  /** A function that refuses by throwing, as the route's error answer: the same shape as a reply. */
  const thrown = async (run: () => Promise<unknown>): Promise<Reply> => {
    try {
      await run();
      return { status: 200, body: {} };
    } catch (error) {
      const { code, statusCode, message } = error as { code: string; statusCode: number; message: string };
      return { status: statusCode, body: { error: { code, message: message.replace(`${code}: `, "") } } };
    }
  };

  it("shows B a 404 page for A's id and decides nothing, with B's own session, B's person under A's org, and the page's own form", async () => {
    const w = shared;
    for (const who of B_PEOPLE) {
      for (const key of decidable) {
        const id = w.ids[key];
        const twinId = w.twin[key];
        for (const [name, orgId] of [["its own session", ORG_B], ["a session that names A's org for a B person", TEST_ORG]] as const) {
          const answers: Reply[] = [];
          for (const target of [id, twinId]) {
            for (const method of ["GET", "POST"] as const) {
              const { cookie } = await sessionFor(w, who, orgId, target);
              answers.push(await refused(w, `${who.name} ${method} the page for ${key} (${name})`, () => page(w, method, target, cookie), { status: 404, code: "" }, { sessions: true, supplied: target }));
            }
          }
          expect(bodyOf(w, answers[0]!), `${who.name} ${key} page`).toEqual(bodyOf(w, answers[2]!));
          expect(bodyOf(w, answers[1]!), `${who.name} ${key} decide`).toEqual(bodyOf(w, answers[3]!));
        }
      }
    }
  });

  it("refuses the decision functions the routes and the page call, for B's person as B's member or owner, as an approval no org has", async () => {
    const w = shared;
    for (const who of B_PEOPLE) {
      const orgRole = who === BETH ? "owner" : "member";
      for (const key of decidable) {
        const answers: Reply[] = [];
        for (const target of [w.ids[key], w.twin[key]]) {
          const { proof } = await sessionFor(w, who, ORG_B, target);
          const caller = { orgId: ORG_B, developerId: who.developerId, orgRole, decideProof: proof } as const;
          const deps = w.deps();
          const body = { requestId: randomUUID(), decision: key === "P" || key === "Q" || key === "changeId" ? "APPROVE" : "APPROVE" };
          const run = target.startsWith("spr_") ? () => decideSpendRequest(deps, caller, target, body)
            : key === "P" ? () => decideWriteApproval(deps, caller, target, body) : () => decideApproval(deps, caller, target, body);
          answers.push(await refused(w, `${who.name} decides ${key} as B's ${orgRole}`, () => thrown(run), { status: 404, code: "NOT_FOUND" }, { sessions: true, supplied: target }));
        }
        expect(bodyOf(w, answers[0]!), `${who.name} decides ${key}`).toEqual(bodyOf(w, answers[1]!));
      }
    }
    // A's requests are all still pending, and A's held start is still there: nothing of the above reached them.
    for (const record of w.db.find((item) => item.entityType === "SPEND_REQUEST" && item.orgId === TEST_ORG)) expect(record.status, String(record.spendRequestId)).toBe(record.spendRequestId === w.ids.held ? "APPROVED" : "PENDING");
    for (const id of [w.ids.P, w.ids.Q, w.ids.changeId]) expect((await getAnyApproval(w.deps(), TEST_ORG, id as never))?.status, id).toBe("PENDING");
    expect(w.db.find((item) => item.entityType === "SPEND_HELD_START")).toHaveLength(1);
  });

  it("holds B to the same no-leak answer by every page of the confirmation: a ticket B was never given, and a cookie that does not exist", async () => {
    const w = shared;
    for (const who of B_PEOPLE) {
      for (const key of decidable) {
        const bogus = await refused(w, `${who.name} opens ${key} with no session`, async () => {
          const response = await w.handler({ version: "2.0", rawPath: `/v1/app/approve/${w.ids[key]}`, rawQueryString: "", headers: {}, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
          return { status: response.statusCode, body: { location: (response as { headers?: Record<string, string> }).headers?.location ?? "" } };
        }, { status: 302, code: "" }, { sessions: true, supplied: w.ids[key] });
        // The redirect is to the sign-in's identify step: it does not say whether the id exists.
        expect(bodyOf(w, bogus).body, key).toEqual({ location: `/v1/auth/decide/identify?return=/v1/app/approve/${w.twin[key]}` });
      }
    }
  });
});

describe("the internal routes serve the operation's own org and nothing else", () => {
  const SIGNING = { callbackSigningKey: "c".repeat(64) };
  const stepOf = (w: World, workspaceId: string) => {
    const operationId = w.activeOf(workspaceId);
    const operation = w.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown> & { fence: number; id: string };
    return { workspaceId, operationId, fence: operation.fence };
  };
  /** The capabilities of a step that read skills, call tools and ask for a model key, for the claims named (which a test may mix). */
  const capability = (claims: { workspaceId: string; operationId: string; fence: number }) =>
    issueCapability(SIGNING, claims.workspaceId, claims.operationId, claims.fence, { agentSkills: true, agentTools: true, modelAccess: true });
  const internal = async (w: World, method: "GET" | "POST", path: string, token: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await callBroker(w.handler, { method, path, headers: { "x-agentx-callback-capability": token }, ...(body === undefined ? {} : { body }) });
    return { status: reply.status, body: reply.body };
  };
  const skillsOf = (w: World, token: string) => internal(w, "GET", "/v1/internal/agent-skills", token);
  const toolsOf = (w: World, token: string) => internal(w, "GET", "/v1/internal/agent-tools", token);
  const mintOf = (w: World, token: string) => internal(w, "GET", "/v1/internal/model-access", token);

  it("serves each org's own step its own: B's capability for B's step reads B's, and A's reads A's", async () => {
    const w = await worldQuiet();
    const a = stepOf(w, w.tasks.T.workspaceId);
    const b = stepOf(w, w.bRun.workspaceId);
    for (const [name, step] of [["A's step", a], ["B's step", b]] as const) {
      const token = capability(step);
      expect((await skillsOf(w, token)), `${name} skills`).toMatchObject({ status: 200, body: { skills: [] } });
      expect((await toolsOf(w, token)).status, `${name} tools`).toBe(200);
    }
  });

  it("refuses a capability that mixes A's workspace and B's operation, or B's workspace and A's operation, on every internal route", async () => {
    const w = await worldQuiet();
    const a = stepOf(w, w.tasks.T.workspaceId);
    const b = stepOf(w, w.bRun.workspaceId);
    const mixes = [["A's workspace with B's operation", { workspaceId: a.workspaceId, operationId: b.operationId, fence: b.fence }], ["B's workspace with A's operation", { workspaceId: b.workspaceId, operationId: a.operationId, fence: a.fence }]] as const;
    for (const [name, claims] of mixes) {
      const token = capability(claims);
      for (const [route, ask] of [["agent-skills", skillsOf], ["agent-tools", toolsOf], ["model-access", mintOf]] as const) {
        const answer = await refused(w, `${name}: ${route}`, () => ask(w, token), { status: 404, code: "NOT_FOUND" });
        expect(JSON.stringify(answer.body), name).not.toContain("workspace");
      }
      const called = await refused(w, `${name}: agent-tools call`, () => internal(w, "POST", "/v1/internal/agent-tools/call", token, { requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "get_issue", schemaHash: "b".repeat(64), arguments: {} }), { status: 404, code: "NOT_FOUND" });
      expect(called.status).toBe(404);
    }
    expect(w.access.mintKey).not.toHaveBeenCalled();
  });

  it("refuses, with 404 and no content, an operation whose org is not its task's, in either direction, on both routes", async () => {
    const w = await worldQuiet();
    const a = stepOf(w, w.tasks.T.workspaceId);
    const token = capability(a);
    // A's skill is pinned by the step's snapshot, so a leak would serve its content.
    const digest = String((w.db.get(`ORG#${TEST_ORG}#SKILL#${w.ids.S}`, "META") as { currentDigest: string }).currentDigest);
    const snapshot = w.db.get(`DEVTASK#${w.ids.T}`, "RECIPE") as Record<string, unknown> & { recipe: Record<string, unknown> };
    w.db.set({ ...snapshot, recipe: { ...snapshot.recipe, skills: [{ skillId: w.ids.S, name: "a-skill", description: "Use when triaging A's tickets.", digest }] } });
    expect(await skillsOf(w, token)).toMatchObject({ status: 200 });
    const operation = w.db.get(`WORKSPACE#${a.workspaceId}`, `OPERATION#${a.operationId}`) as Record<string, unknown>;
    const task = w.db.get(`DEVTASK#${w.ids.T}`, "META") as Record<string, unknown>;
    // The operation says B, its task says A.
    w.db.set({ ...operation, orgId: ORG_B });
    for (const [route, ask] of [["agent-skills", skillsOf], ["agent-tools", toolsOf]] as const) await refused(w, `operation of B, task of A: ${route}`, () => ask(w, token), { status: 404, code: "NOT_FOUND" });
    // The task says B, its operation says A.
    w.db.set({ ...operation, orgId: TEST_ORG });
    w.db.set({ ...task, orgId: ORG_B });
    for (const [route, ask] of [["agent-skills", skillsOf], ["agent-tools", toolsOf]] as const) await refused(w, `operation of A, task of B: ${route}`, () => ask(w, token), { status: 404, code: "NOT_FOUND" });
    // The snapshot says B while the operation and the task say A: it serves nothing.
    w.db.set({ ...task, orgId: TEST_ORG });
    w.db.set({ ...(w.db.get(`DEVTASK#${w.ids.T}`, "RECIPE") as Record<string, unknown>), orgId: ORG_B });
    await refused(w, "snapshot of B, operation and task of A: agent-skills", () => skillsOf(w, token), { status: 404, code: "NOT_FOUND" });
  });

  it("serves none of A's skills to a B step whose snapshot pins one, by id and digest", async () => {
    const w = await worldQuiet();
    const b = stepOf(w, w.bRun.workspaceId);
    const token = capability(b);
    const digest = String((w.db.get(`ORG#${TEST_ORG}#SKILL#${w.ids.S}`, "META") as { currentDigest: string }).currentDigest);
    const snapshot = w.db.get(`DEVTASK#${w.bRun.taskId}`, "RECIPE") as Record<string, unknown> & { recipe: Record<string, unknown> };
    w.db.set({ ...snapshot, recipe: { ...snapshot.recipe, skills: [{ skillId: w.ids.S, name: "a-skill", description: "Use when triaging A's tickets.", digest }] } });
    const answer = await refused(w, "B's snapshot pinning A's skill", () => skillsOf(w, token), { status: 503, code: "RUNTIME_UNAVAILABLE" });
    expect(JSON.stringify(answer.body)).not.toContain(SKILL_MARKER);
  });

  /** B's step is granted Linear read; B's `payments` has a Linear connector that names `credentialRef`. */
  function grantLinear(w: World, credentialRef: string): void {
    const recipeItem = w.db.get(`DEVTASK#${w.bRun.taskId}`, "RECIPE") as Record<string, unknown> & { recipe: Record<string, unknown> };
    const recipe = { ...recipeItem.recipe, tools: [{ connector: { type: "linear" }, access: "read" }] };
    const digest = recipeDigest(recipe as never);
    w.db.set({ ...recipeItem, recipe, digest });
    const task = w.db.get(`DEVTASK#${w.bRun.taskId}`, "META") as Record<string, unknown> & { agent: Record<string, unknown> };
    w.db.set({ ...task, agent: { ...task.agent, digest } });
    const revision = w.db.get(projectRevisionKey(ORG_B, "payments", 1)) as Record<string, unknown> & { definition: Record<string, unknown> };
    w.db.set({ ...revision, definition: { ...revision.definition, integrations: { connectors: [{ name: "linear", type: "linear", credentialRef, scopes: [{ alias: "charterarc", teamId: CHARTERARC_TEAM_ID }], tools: READ_TOOLS }] } } });
  }

  it("lists B's own Linear tools through B's own connection, and none through a connector that names A's connection, without reading a secret", async () => {
    const w = await worldQuiet();
    const token = capability(stepOf(w, w.bRun.workspaceId));
    grantLinear(w, w.ids.BC);
    const own = await toolsOf(w, token);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect((own.body.catalogs as Array<{ connector: string }>).map((catalog) => catalog.connector)).toEqual(["linear"]);
    const reads = w.fake.calls.length;
    expect(reads).toBeGreaterThan(0);
    // The same step and project, the connector now naming A's connection: the connector is not connected for B (its credential is not in B's org), so the step is
    // offered nothing, the secrets fake is not called and the vendor is not reached.
    grantLinear(w, w.ids.C);
    const refusal = await refused(w, "B's connector naming A's connection: list", () => toolsOf(w, token), { status: 200, code: "" }, { supplied: w.ids.C });
    expect(refusal.body.catalogs).toEqual([]);
    await refused(w, "B's connector naming A's connection: call", () => internal(w, "POST", "/v1/internal/agent-tools/call", token, {
      requestId: randomUUID(), connector: "linear", scope: "charterarc", tool: "get_issue", schemaHash: "b".repeat(64), arguments: { id: "ENG-1" },
    }), { status: 403, code: "AGENT_TOOL_NOT_GRANTED" }, { supplied: w.ids.C });
  });

  it("mints B's key for B's aliases only, and refuses one routed to A's company source", async () => {
    const w = await worldQuiet();
    // A's own step is routed to A's source, so A's key carries A's alias: the control that an alias of A's exists to be leaked.
    const aliasOfA = sourceAlias(TEST_ORG, w.ids.SRC, SONNET);
    w.access.setOrgSpent(ORG_B, 0);
    w.access.setMemberSpent(ORG_B, OMAR.developerId, 0);
    const a = stepOf(w, w.tasks.T.workspaceId);
    const aOperation = w.db.get(`WORKSPACE#${a.workspaceId}`, `OPERATION#${a.operationId}`) as { modelRoute?: { alias: string } };
    expect(aOperation.modelRoute?.alias, "A's step is routed to A's source").toBe(aliasOfA);
    const aKey = await mintOf(w, capability(a));
    expect(aKey.status, JSON.stringify(aKey.body)).toBe(200);
    expect(w.access.mintKey.mock.calls.at(-1)![0]).toMatchObject({ orgId: TEST_ORG, models: [aliasOfA] });
    // B's step is not routed to A's source, and its key names B's own models: Rovara's catalog, no alias of any org's.
    const b = stepOf(w, w.bRun.workspaceId);
    const bOperation = w.db.get(`WORKSPACE#${b.workspaceId}`, `OPERATION#${b.operationId}`) as { modelRoute?: { sourceId: string } };
    expect(bOperation.modelRoute?.sourceId).toBe("rovara");
    const bKey = await mintOf(w, capability(b));
    expect(bKey.status, JSON.stringify(bKey.body)).toBe(200);
    const minted = w.access.mintKey.mock.calls.at(-1)![0];
    expect(minted).toMatchObject({ orgId: ORG_B });
    expect(minted.models).toBeDefined();
    for (const model of minted.models ?? []) {
      expect(model, "a model of B's key").not.toContain(TEST_ORG);
      expect(model, "a model of B's key").not.toContain(w.ids.SRC);
    }
    expect(JSON.stringify(minted)).not.toContain(w.ids.SRC);
    expect(JSON.stringify(minted)).not.toContain(TEST_ORG);
    // B's step carrying a route to A's source (a record that says so) gets no key: the route is checked against B's own live sources, which do not have it.
    w.db.set({ ...(w.db.get(`WORKSPACE#${b.workspaceId}`, `OPERATION#${b.operationId}`) as Record<string, unknown>), modelRoute: aOperation.modelRoute });
    const mints = w.access.mintKey.mock.calls.length;
    const planted = await mintOf(w, capability(b));
    expect(planted.status, JSON.stringify(planted.body)).toBeGreaterThanOrEqual(400);
    expect(w.access.mintKey.mock.calls.length, "no key for a route B does not have").toBe(mints);
    expect(JSON.stringify(planted.body)).not.toContain(aliasOfA);
  });
});

/** The world, built without the broker's own log lines. */
async function worldQuiet(): Promise<World> {
  const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try { return await world(); } finally { quiet.mockRestore(); }
}

describe("org B's own settings of a built-in agent are B's", () => {
  it("shows B's ticket-triage with B's settings and none of A's budget, spend or runs", async () => {
    const w = shared;
    // A's: a monthly budget of $25, a max per run of $6, $5.55 spent by run U.
    const a = (await control(w, DEB, "/v1/app/agents/ticket-triage")).body;
    expect(a).toMatchObject({ agent: { monthlyBudgetUsd: 25, maxPerRunUsd: 6 } });
    const aSpend = (await control(w, DEB, "/v1/app/agents/ticket-triage/spend")).body;
    expect(aSpend).toMatchObject({ totalUsd: 5.55, recentRuns: [expect.objectContaining({ taskId: w.ids.U })] });
    for (const who of B_PEOPLE) {
      const mine = await refusedFree(w, `${who.name} GET ticket-triage`, () => w.api(who, "GET", "/v1/app/agents/ticket-triage"), who);
      expect(mine.status).toBe(200);
      expect((mine.body.agent as Record<string, unknown>).monthlyBudgetUsd).toBeUndefined();
      expect((mine.body.agent as Record<string, unknown>).maxPerRunUsd).toBeUndefined();
      const spend = await refusedFree(w, `${who.name} GET ticket-triage spend`, () => w.api(who, "GET", "/v1/app/agents/ticket-triage/spend"), who);
      expect(spend.status).toBe(200);
      expect(spend.body).toMatchObject({ totalUsd: 0, recentRuns: [] });
      expect(spend.body).not.toHaveProperty("budget");
    }
  });

  it("keeps A's settings of ticket-triage when B sets its own", async () => {
    const w = await worldQuiet();
    const before = aState(w);
    const set = await w.api(BETH, "PUT", "/v1/app/agents/ticket-triage/budget", { monthlyUsd: 7, maxPerRunUsd: 2 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ agent: { monthlyBudgetUsd: 7, maxPerRunUsd: 2 } });
    expect(aState(w), "A's items").toBe(before);
    expect((await w.api(DEB, "GET", "/v1/app/agents/ticket-triage")).body).toMatchObject({ agent: { monthlyBudgetUsd: 25, maxPerRunUsd: 6 } });
    // B's own settings are under B's org.
    expect(w.db.get(builtinSettingsKey(ORG_B, "ticket-triage"))).toMatchObject({ monthlyBudgetUsd: 7 });
    expect(w.db.get(builtinSettingsKey(TEST_ORG, "ticket-triage"))).toMatchObject({ monthlyBudgetUsd: 25 });
  });
});

describe("the settlement run keeps an item to its own org", () => {
  const HELD = "HELD_SPEND_STARTS";
  const plant = (w: World, sk: string, item: Record<string, unknown>) => w.db.set({ pk: HELD, sk, entityType: "SPEND_HELD_START", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...item });
  const taskState = (w: World, taskId: string) => JSON.stringify(w.db.find((item) => item.pk === `DEVTASK#${taskId}` || (item.pk === `WORKSPACE#${(w.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId}`)), stable);
  const outboxCount = (w: World) => w.db.find((item) => item.entityType === "OUTBOX").length;

  it("resumes nothing of A's from a held start, a month resume or a plan's run-limit start that names org B, and nothing of B's from one that names org A", async () => {
    const w = await worldQuiet();
    const aTask = w.tasks.held.taskId;
    const bTask = w.bRun.taskId;
    // A's real held start is set aside (the control below puts it back), so what the sweep does is what the planted items make it do.
    const real = w.db.find((item) => item.entityType === "SPEND_HELD_START");
    expect(real).toHaveLength(1);
    for (const item of real) w.db.delete({ pk: String(item.pk), sk: String(item.sk) });
    const at = new Date().toISOString();
    const kinds: Array<[string, Record<string, unknown>]> = [
      ["a first dispatch", { resetRunWindow: true }], ["a month's resume", { resume: "month" }], ["a plan's run-limit start", { resume: "implement", runLimitUsd: 20 }],
    ];
    for (const [index, [, extra]] of kinds.entries()) {
      plant(w, `${at}#${ORG_B}#${aTask}#${String(index)}`, { orgId: ORG_B, taskId: aTask, spendRequestId: w.ids.held, ...extra });
      plant(w, `${at}#${TEST_ORG}#${bTask}#${String(index)}`, { orgId: TEST_ORG, taskId: bTask, spendRequestId: w.ids.held, ...extra });
    }
    // A request's and an approval's due items that name org B and an id of A's.
    const past = new Date(Date.now() - 86_400_000).toISOString();
    w.db.set({ ...openSpendRequestDueKey(past, ORG_B, w.ids.runLimit), entityType: "SPEND_REQUEST_DUE", orgId: ORG_B, spendRequestId: w.ids.runLimit, dueAt: past });
    w.db.set({ ...openApprovalKey(past, ORG_B, w.ids.P), entityType: "OPEN_APPROVAL", orgId: ORG_B, approvalId: w.ids.P });
    const requestsBefore = JSON.stringify(w.requests(), stable);
    const approvalsBefore = JSON.stringify([w.ids.P, w.ids.Q, w.ids.changeId].map((id) => w.db.get(approvalKey(TEST_ORG, id as never))), stable);
    const aBeforeTask = taskState(w, aTask);
    const bBeforeTask = taskState(w, bTask);
    const outbox = outboxCount(w);
    const report = await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 });
    expect(report).toMatchObject({ heldStarts: 0 });
    await runApprovalSweep(w.deps(), { budgetMs: 5_000 });
    expect(JSON.stringify(w.requests(), stable), "A's spend requests").toBe(requestsBefore);
    expect(JSON.stringify([w.ids.P, w.ids.Q, w.ids.changeId].map((id) => w.db.get(approvalKey(TEST_ORG, id as never))), stable), "A's approvals").toBe(approvalsBefore);
    expect(w.db.get(openSpendRequestDueKey(past, ORG_B, w.ids.runLimit)), "the planted due item is dropped").toBeUndefined();
    expect(w.db.get(openApprovalKey(past, ORG_B, w.ids.P as never)), "the planted open approval is dropped").toBeUndefined();
    expect(taskState(w, aTask), "A's held task").toBe(aBeforeTask);
    expect(taskState(w, bTask), "B's task").toBe(bBeforeTask);
    expect(outboxCount(w), "no operation was dispatched").toBe(outbox);
    expect((w.db.get(`DEVTASK#${aTask}`, "META") as { budgetPause?: { firstDispatch?: unknown } }).budgetPause?.firstDispatch).toBeDefined();
    // The control: A's own held start, under A's org, is the one the sweep dispatches.
    const [item] = real;
    w.db.set(item!);
    expect(await escalateOwnerRequests(w.deps(), { budgetMs: 5_000 })).toMatchObject({ heldStarts: 1 });
    expect((w.db.get(`DEVTASK#${aTask}`, "META") as { budgetPause?: unknown }).budgetPause).toBeUndefined();
    expect(outboxCount(w)).toBe(outbox + 1);
    expect(taskState(w, bTask), "B's task, after A's own resume").toBe(bBeforeTask);
  });
});

describe("a request id used in two orgs is two requests", () => {
  it("answers B's create of an agent, a skill and a connection with B's own, not what A's same request id stored, and leaves A's as they were", async () => {
    const w = await worldQuiet();
    // One request id per route (one id may not be two requests of one caller), each used by A and then by B.
    const ids = { "/v1/app/agents": randomUUID(), "/v1/app/skills": randomUUID(), "/v1/app/connections": randomUUID() };
    const post = (who: Developer, path: keyof typeof ids, body: Record<string, unknown>) => w.dev(who, "POST", path, { requestId: ids[path], ...body });
    const agentBody = { name: "Shared name", overlay: TRIAGE };
    const skillBody = { content: skillFile("same-id-skill", "# Same id\n") };
    const connectionBody = { connection: { type: "linear", label: "Same id", access: "read" }, secret: { apiKey: "lin_api_SAMEREQUESTIDKEY0123456789" } };
    const a = { agent: await post(MAYA, "/v1/app/agents", agentBody), skill: await post(MAYA, "/v1/app/skills", skillBody), connection: await post(DEB, "/v1/app/connections", connectionBody) };
    for (const reply of Object.values(a)) expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const before = aState(w);
    const secretCallsBefore = w.fake.calls.length;
    const b = { agent: await post(OMAR, "/v1/app/agents", agentBody), skill: await post(BETH, "/v1/app/skills", skillBody), connection: await post(BETH, "/v1/app/connections", connectionBody) };
    for (const [name, reply] of Object.entries(b)) expect(reply.status, `${name}: ${JSON.stringify(reply.body)}`).toBe(201);
    const idOf = (reply: { body: Record<string, unknown> }, key: "agent" | "skill" | "connection") => String((reply.body[key] as Record<string, string>)[`${key}Id`]);
    for (const key of ["agent", "skill", "connection"] as const) expect(idOf(b[key], key), `${key}: B got its own`).not.toBe(idOf(a[key], key));
    expect(aState(w), "A's items").toBe(before);
    // B's secret went to B's org only.
    const calls = w.fake.calls.slice(secretCallsBefore);
    expect(calls.length).toBeGreaterThan(0);
    for (const entry of calls) expect(entry.sessionOrg === undefined || entry.sessionOrg === ORG_B, JSON.stringify(entry)).toBe(true);
    // And A reading its own request again by the same id still gets A's answer.
    const again = await post(MAYA, "/v1/app/agents", agentBody);
    expect(idOf(again, "agent")).toBe(idOf(a.agent, "agent"));
  });
});

describe("two orgs add a company AI source with one request id", () => {
  it("gives each its own source, its own credential and its own aliases in the proxy, and registers nothing of A's for B", async () => {
    const w = await worldQuiet();
    const requestId = randomUUID();
    const body = { requestId, source: { kind: "anthropic", label: "Same label", models: [{ catalog: SONNET }] }, apiKey: SOURCE_KEY };
    const before = aState(w);
    const calls = w.access.upsertSource.mock.calls.length;
    const added = await w.dev(DEB, "POST", "/v1/app/org/model-sources", body);
    const addedByB = await w.dev(BETH, "POST", "/v1/app/org/model-sources", body);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(addedByB.status, JSON.stringify(addedByB.body)).toBe(201);
    expect(addedByB.body.sourceId).not.toBe(added.body.sourceId);
    // The proxy was told of one source per org, each under its own org.
    const told = w.access.upsertSource.mock.calls.slice(calls).map(([input]) => ({ orgId: input.orgId, sourceId: input.source.sourceId }));
    expect(told).toEqual([{ orgId: TEST_ORG, sourceId: added.body.sourceId }, { orgId: ORG_B, sourceId: addedByB.body.sourceId }]);
    // B's list holds B's source only; A's list holds its two.
    const listed = async (who: Developer) => ((await w.api(who, "GET", "/v1/app/org/model-sources")).body.sources as Array<{ sourceId: string }>).map((source) => source.sourceId);
    expect(await listed(BETH)).toEqual([String(addedByB.body.sourceId)]);
    expect((await listed(DEB)).sort()).toEqual([w.ids.SRC, String(added.body.sourceId)].sort());
    // A's records are as they were, apart from the source A itself just added.
    expect(aState(w)).not.toBe(before);
    expect(JSON.stringify(w.db.find((item) => String(item.pk).includes(ORG_B)), stable)).not.toContain(String(added.body.sourceId));
  });
});

describe("a person who moves to org B and repeats a request id of org A's", () => {
  it("makes a new request in B, and is not answered with what A stored, nor does the repeat touch A's agent or skill", async () => {
    const w = await worldQuiet();
    const ids = { "/v1/app/agents": randomUUID(), "/v1/app/skills": randomUUID() };
    const bodies = { "/v1/app/agents": { name: "Moving agent", overlay: TRIAGE }, "/v1/app/skills": { content: skillFile("moving-skill", "# Moving\n") } } as const;
    const inA = async (path: keyof typeof ids) => w.dev(MAYA, "POST", path, { requestId: ids[path], ...bodies[path] });
    const made = { agent: await inA("/v1/app/agents"), skill: await inA("/v1/app/skills") };
    expect(made.agent.status).toBe(201);
    expect(made.skill.status).toBe(201);
    // Maya's membership moves to B (the same developer, now in another org), and she signs in there.
    seedMembership(w.db, MAYA.developerId, { orgId: ORG_B, role: "member" });
    const before = aState(w);
    const inB = async (path: keyof typeof ids) => {
      const response = await w.handler({
        version: "2.0", rawPath: path, rawQueryString: "", headers: { authorization: await bearerFor(MAYA, { orgId: ORG_B, role: "member" }) },
        body: JSON.stringify({ requestId: ids[path], ...bodies[path] }), requestContext: { requestId: randomUUID(), http: { method: "POST" } },
      });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, Record<string, string>> };
    };
    const moved = { agent: await inB("/v1/app/agents"), skill: await inB("/v1/app/skills") };
    expect(moved.agent.status, JSON.stringify(moved.agent.body)).toBe(201);
    expect(moved.skill.status, JSON.stringify(moved.skill.body)).toBe(201);
    expect(moved.agent.body.agent!.agentId).not.toBe((made.agent.body.agent as { agentId: string }).agentId);
    expect(moved.skill.body.skill!.skillId).not.toBe((made.skill.body.skill as { skillId: string }).skillId);
    // The new ones are B's, under B's keys, and A's are as they were (the journal of the moved person's turns apart).
    expect(w.db.get(`ORG#${ORG_B}#AGENT#${moved.agent.body.agent!.agentId}`, "META")).toMatchObject({ orgId: ORG_B });
    expect(aState(w), "A's items").toBe(before);
  });
});

describe("after all of the above, org A is as it was", () => {
  it("has every item of its own exactly as the controls left it, and a stranger's turn journal holds nothing of A's", async () => {
    expect(aState(shared)).toBe(aBefore);
    const lines = shared.db.find((item) => isTurnLine(item) && !isOfA(item));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const needle of needlesOf(shared)) expect(JSON.stringify(line).includes(needle), `a journal line holds ${needle.slice(0, 12)}`).toBe(false);
    }
  });
});
