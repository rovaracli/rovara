// Plan 3 Task 21: write approvals and safe execution. A consequential call of an agent waits as one APPROVAL# record; a person who may decide it
// approves it on the confirmation page (Task 21a), and Rovara re-checks everything against live data, then runs exactly the stored arguments once
// through the connector call path (injected here as a fake with the ledger's replay), or ends the record `APPROVED_FAILED` with the reason.
// These tests call the functions directly; the decide routes are Task 21a's wiring (the route tests here use a stub of its guard).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INDEX_EXPIRY_ATTRIBUTE, agentXError, approvalKey, approverIndexKey, orgMemberKey, orgProjectCatalogKey, orgRemovedKey, projectMetaKey, projectRevisionKey,
  type ActionPolicy, type ConnectorResult, type GrantedTool, type OrgId, type OrgRole, type ToolFacts,
} from "@agentx/contracts";
import { describeAction } from "../../packages/contracts/src/action-class.js";
import type { AgentCaller } from "../../packages/broker/src/agents/access.js";
import {
  createPendingChange, createStepApproval, decideApproval, expireApprovals, getAnyApproval, listApprovalsFor, runApprovalSweep, registerApprovalSubjectHandler, registerApproverRule,
  type AnyApprovalRecord, type ApprovalDependencies, type StepApprovalRecord, type WriteApprovalRecord,
} from "../../packages/broker/src/agents/approvals.js";
import { routeApprovalRequest } from "../../packages/broker/src/agents/approval-routes.js";
import { memoryRunCache } from "../../packages/broker/src/agents/run-cache.js";
import { onMemberRemoved, onMembersMerged } from "../../packages/broker/src/agents/lifecycle.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import {
  WRITE_APPROVER_RULE, decideWrite, decideWriteApproval, deriveWriteRequestId, writeApproversFor,
  type ApprovedCall, type ClassifyContext, type DecideWriteInput, type WriteGateRuntime,
} from "../../packages/broker/src/agents/write-gate.js";
import { prepareAgentWrite } from "../../packages/broker/src/agents/write-class.js";
import type { ClassifyAgentWriteDependencies } from "../../packages/broker/src/agents/write-class.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { placeholderDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";

const T0 = Date.parse("2026-10-22T09:00:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const hex = (digit: string) => digit.repeat(64);
const ALICE = hex("a"); // the run's owner, a contributor on web
const OLD_ALICE = hex("b"); // Alice's duplicate
const BOB = hex("c"); // a maintainer of web by grant
const CARA = hex("d"); // a contributor of web
const DANA = hex("e"); // an org admin
const ERIN = hex("f"); // a member with no role on web
const XAVI = hex("9"); // org B's owner
const TASK = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const OWNER_KEY = "owner-key-alice";
const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
const OTHER_TEAM = "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11";
const CONNECTION = "con_aaaaaaaaaaaaaaaaaaaa";
const OTHER_CONNECTION = "con_bbbbbbbbbbbbbbbbbbbb";
const SCHEMA = "a".repeat(64);
const REQ = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WAIT_TEXT = "A person must approve this before it happens. Rovara has asked Alice and the project's maintainers. Carry on with the rest of your work; you'll hear the outcome.";
const TOO_MANY = "Too many actions are waiting for approval in this step. Finish with a report instead.";
const FORBIDDEN = "Only Alice or a project maintainer can decide this.";
const CHANGED = "The connector changed since this was asked, so Rovara didn't run it.";

interface GrantOptions extends Partial<Omit<ToolFacts, "connector" | "upstreamName" | "access">> { access?: "read" | "write"; connector?: string }
function grant(type: GrantedTool["type"], upstreamName: string, options: GrantOptions = {}): GrantedTool {
  const { access = "write", connector = type, ...rest } = options;
  const facts: ToolFacts = { connector, upstreamName, access, itemArguments: [], ...rest };
  return { connector, type, upstreamName, presentedName: `${connector}__${upstreamName}`, access, facts };
}
const GET_ISSUE = grant("linear", "get_issue", { access: "read", itemArguments: ["id"] });
const SAVE_ISSUE = grant("linear", "save_issue", { itemArguments: ["id"], resultItemArguments: ["id"] });
const CREATE_COMMENT = grant("linear", "create_comment");
const TOOLS = [GET_ISSUE, SAVE_ISSUE, CREATE_COMMENT];

const CLASSIFY: ClassifyContext = { rules: { alwaysAsk: [] }, autonomy: "run", allowMentions: false };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** The vendor behind the connector call path: the ledger answers a repeat of a request id with the recorded result and no second call. */
function fakeVendor() {
  const ledger = new Map<string, ConnectorResult>();
  const state = { vendorCalls: [] as ApprovedCall[], runs: 0, crashesAfterVendor: 0, neverFinishes: false, answer: undefined as undefined | Partial<ConnectorResult>, gate: undefined as Promise<void> | undefined, during: undefined as undefined | (() => void) };
  const run = async (call: ApprovedCall): Promise<ConnectorResult> => {
    state.runs += 1;
    await state.gate;
    const requestId = call.request.requestId;
    const recorded = ledger.get(requestId);
    if (recorded !== undefined) return { ...recorded, replayed: true };
    if (state.neverFinishes) { state.vendorCalls.push(call); throw new Error("the process died"); }
    state.vendorCalls.push(call);
    const result: ConnectorResult = { requestId, status: "SUCCEEDED", text: JSON.stringify({ id: "CHA-9", title: "made" }), truncated: false, replayed: false, ...state.answer };
    ledger.set(requestId, result);
    state.during?.();
    if (state.crashesAfterVendor > 0) { state.crashesAfterVendor -= 1; throw new Error("the process died"); }
    return result;
  };
  return { state, run, ledger };
}

const linearConnector = (over: Record<string, unknown> = {}) => ({
  name: "linear", type: "linear", credentialRef: CONNECTION, scopes: [{ alias: "eng", teamId: TEAM }],
  tools: [{ name: "get_issue", access: "read" }, { name: "save_issue", access: "write" }, { name: "create_comment", access: "write" }], ...over,
});

function world(options: { audit?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const audit = options.audit === true ? capturingAuditDeps() : undefined;
  audit?.attach(db);
  const clock = { now: T0 };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const members = new FakeProjectMembers();
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: "state", now: () => clock.now });
  const store = new AgentStore({ documentClient: db, tableName: "state", now: () => clock.now });
  const vendor = fakeVendor();
  const handled: Array<{ kind: string; status: string; approvalId: string }> = [];
  const live = { policy: undefined as ActionPolicy | undefined, grantRefusal: undefined as string | undefined, authorityRefusal: false, authorityChecks: [] as Array<{ ownerKey: string; project: string }> };

  const runtime: WriteGateRuntime = {
    classify: { documentClient: db, tableName: "state", now: () => clock.now, labelListers: {}, runCache: () => memoryRunCache() } as unknown as ClassifyAgentWriteDependencies,
    runConnector: vendor.run,
    regrant: async ({ record }) => {
      if (live.grantRefusal !== undefined) return { refused: live.grantRefusal };
      const tool = TOOLS.find((candidate) => candidate.upstreamName === record.tool)!;
      return { tool, classify: { ...CLASSIFY, ...(live.policy === undefined ? {} : { projectPolicy: live.policy }) } };
    },
    recordedResult: async ({ requestId }) => vendor.ledger.get(requestId),
    requireRunAuthority: async ({ ownerKey, project }) => {
      live.authorityChecks.push({ ownerKey, project });
      if (live.authorityRefusal) throw agentXError("NOT_FOUND", "project not found");
    },
  };
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: db, tableName: "state", signInStore, now: () => clock.now, confirmOrigin: "https://cell.example.com",
    log: (event, fields) => logs.push({ event, fields }), writeGate: runtime, ...(audit === undefined ? {} : { audit: audit.audit }),
  };
  registerApprovalSubjectHandler("agent_run", async (_deps, record) => { handled.push({ kind: record.kind, status: record.status, approvalId: record.approvalId }); });

  const member = (orgId: OrgId, developerId: string, role: OrgRole) => {
    db.set({ ...orgMemberKey(orgId, developerId), entityType: "ORG_MEMBER", orgId, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    members.setOrgRole(orgId, developerId, role);
  };
  for (const [who, role] of [[ALICE, "member"], [BOB, "member"], [CARA, "member"], [DANA, "admin"], [ERIN, "member"]] as const) member(ORG_A, who, role);
  member(ORG_B, XAVI, "owner");
  members.addProject(ORG_A, "web");
  members.grant(ORG_A, "web", ALICE, "contributor");
  members.grant(ORG_A, "web", BOB, "maintainer");
  members.grant(ORG_A, "web", CARA, "contributor");
  db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 1 });
  db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: DANA });

  const revision = (n: number, connector: Record<string, unknown> | null = linearConnector(), orgId: OrgId = ORG_A) => {
    const command = { cwd: "repo/web", executable: "npm", args: ["ci"], timeoutSeconds: 900 };
    db.set({
      ...projectRevisionKey(orgId, "web", n), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z",
      runtimeBinding: { deploymentMode: "ec2-ebs" },
      definition: {
        name: "web", revision: n,
        repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [command], readiness: [{ ...command, args: ["test"] }], orchestratorInstructions: "Delegate work.",
        ...(connector === null ? {} : { integrations: { connectors: [connector] } }),
      },
    });
  };
  revision(1);
  const task = (over: Record<string, unknown> = {}) => db.set({
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG_A, developerId: ALICE, developerName: "Alice", provider: "oidc", project: "web",
    workspaceId: WORKSPACE, ownerKey: OWNER_KEY, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z", ...over,
  });
  task();

  const caller = (developerId: string, orgRole: OrgRole = "member", orgId: OrgId = ORG_A): AgentCaller => ({ orgId, developerId, orgRole });
  const input = (over: Partial<DecideWriteInput> = {}): DecideWriteInput => ({
    orgId: ORG_A, taskId: TASK, operationId: OPERATION, stepId: "work", agentId: "agt_00000000000000000007", agentName: "Triage bot", tool: SAVE_ISSUE,
    call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s1" } },
    classify: CLASSIFY, run: { project: "web", owner: { developerId: ALICE, name: "Alice" } }, ...over,
  });
  /** A consequential call that is distinct for each `n`. */
  const ask = (n: number, over: Partial<DecideWriteInput> = {}) => decideWrite(deps, input({ call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: `s${String(n)}` } }, ...over }));
  const waiting = async (n = 1, over: Partial<DecideWriteInput> = {}): Promise<string> => {
    const decision = await ask(n, over);
    if (decision.outcome !== "wait") throw new Error(`expected wait, got ${JSON.stringify(decision)}`);
    return decision.approvalId;
  };
  const approve = (who: string, approvalId: string, requestId = REQ(900), orgRole: OrgRole = "member") => decideApproval(deps, caller(who, orgRole), approvalId, { requestId, decision: "APPROVE" });
  const decline = (who: string, approvalId: string, requestId = REQ(901)) => decideApproval(deps, caller(who), approvalId, { requestId, decision: "DECLINE" });
  const record = async (approvalId: string): Promise<AnyApprovalRecord> => (await getAnyApproval(deps, ORG_A, approvalId))!;
  const write = async (approvalId: string) => (await record(approvalId)) as WriteApprovalRecord;
  const sweep = (cursor?: string) => expireApprovals(deps, clock.now, cursor);
  const events = () => db.find((item) => String(item.sk).startsWith("EVENT#") && item.pk === `DEVTASK#${TASK}`);
  const open = () => db.find((item) => item.pk === "OPEN_APPROVALS");
  return { db, clock, logs, members, signInStore, store, vendor, handled, live, runtime, deps, member, revision, task, caller, input, ask, waiting, approve, decline, record, write, sweep, events, open, audit };
}
type World = ReturnType<typeof world>;

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

describe("decideWrite", () => {
  it("lets a read and a safe call run, and writes nothing", async () => {
    const w = world();
    const before = w.db.commandNames().length;
    expect(await decideWrite(w.deps, w.input({ tool: GET_ISSUE, call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-1" } } }))).toEqual({ outcome: "run" });
    expect(await decideWrite(w.deps, w.input({ tool: CREATE_COMMENT, call: { scope: "eng", schemaHash: SCHEMA, arguments: { issueId: "1", body: "Looks fine." } } }))).toEqual({ outcome: "run" });
    expect(w.db.commandNames().slice(before).filter((name) => ["PutCommand", "UpdateCommand", "TransactWriteCommand"].includes(name))).toEqual([]);
  });

  it("makes a consequential call wait: the exact words, one PENDING record, one event, the indexes, and no vendor call", async () => {
    const w = world();
    const decision = await w.ask(1);
    expect(decision).toMatchObject({ outcome: "wait", answer: { status: "WAITING_FOR_APPROVAL", text: WAIT_TEXT } });
    const approvalId = (decision as { approvalId: string }).approvalId;
    expect(approvalId).toMatch(/^apr_[0-9a-z]{20}$/);
    const record = await w.write(approvalId);
    const args = { id: "ENG-12", stateId: "s1" };
    expect(record).toMatchObject({
      orgId: ORG_A, kind: "write", status: "PENDING", subject: { kind: "agent_run", taskId: TASK, stepId: "work" }, operationId: OPERATION,
      connector: "linear", tool: "save_issue", scope: "eng", schemaHash: SCHEMA, projectRevision: 1, credentialRef: CONNECTION, arguments: args,
      argumentsHash: sha(JSON.stringify(args)), class: "consequential", attempts: 0, summary: describeAction("linear__save_issue", args),
      approvers: { kind: "rule", rule: "write_approver" },
      project: "web", owner: { developerId: ALICE, name: "Alice" }, createdAt: "2026-10-22T09:00:00.000Z",
    });
    expect(Date.parse(record.expiresAt) - T0).toBe(7 * DAY);
    const summary = describeAction("linear__save_issue", args);
    expect(w.events()).toEqual([expect.objectContaining({
      orgId: ORG_A, kind: "status", text: `Triage bot wants to ${summary.charAt(0).toLowerCase()}${summary.slice(1)}. This needs approval from Alice or a project maintainer.`,
    })]);
    expect(w.open()).toHaveLength(1);
    // The owner and the maintainers are listed as candidates: Alice, Bob and the org admin Dana (a maintainer by role), not Cara or Erin.
    const approvers = (record.approvers as unknown as { candidates: string[] }).candidates;
    expect([...approvers].sort()).toEqual([ALICE, BOB, DANA].sort());
    for (const who of approvers) expect(w.db.get(approverIndexKey(ORG_A, who, approvalId as never))).toBeDefined();
    expect(w.vendor.state.vendorCalls).toEqual([]);
  });

  it("answers the same call again with the same id and writes nothing more", async () => {
    const w = world();
    const first = await w.waiting(1);
    const items = w.db.find(() => true).length;
    expect(await w.waiting(1)).toBe(first);
    expect(w.db.find(() => true)).toHaveLength(items);
    // The same arguments in another operation are another approval; another tool with the same arguments too.
    expect(await w.waiting(1, { operationId: "44444444-4444-4444-8444-444444444444" })).not.toBe(first);
  });

  it("refuses an 11th distinct approval in a step with the exact text, and a decided one frees a place", async () => {
    const w = world();
    const ids: string[] = [];
    for (let n = 1; n <= 10; n += 1) ids.push(await w.waiting(n));
    expect(await w.ask(11)).toEqual({ outcome: "refuse", reason: TOO_MANY });
    // A repeat of one of the ten is not a new approval.
    expect(await w.waiting(3)).toBe(ids[2]);
    // Another step has its own ten.
    expect((await w.ask(12, { stepId: "other" })).outcome).toBe("wait");
    await w.decline(BOB, ids[0]!);
    expect((await w.ask(11)).outcome).toBe("wait");
  });

  it("counts two racing asks against the limit once each", async () => {
    const w = world();
    for (let n = 1; n <= 9; n += 1) await w.waiting(n);
    const [a, b] = await Promise.all([w.ask(20), w.ask(21)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["refuse", "wait"]);
  });

  it("refuses a call a project deny rule matches, also for a read, and creates nothing", async () => {
    const w = world();
    const policy: ActionPolicy = { rules: [{ tool: "get_issue", connector: "linear", outcome: "deny" }] };
    const result = await decideWrite(w.deps, w.input({ tool: GET_ISSUE, call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-1" } }, classify: { ...CLASSIFY, projectPolicy: policy } }));
    expect(result.outcome).toBe("refuse");
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);
  });

  it("stores the prepared arguments: a mention is stripped before the approval is made, and kept only when the snapshot allows it", async () => {
    const w = world();
    const comment = grant("linear", "create_comment");
    const raw = { issueId: "1", body: "cc @alice /merge now" };
    const prepared = prepareAgentWrite(comment, raw, { allowMentions: false });
    expect(prepared.args["body"]).toBe("cc alice /merge now");
    const id = await w.waiting(1, { tool: comment, call: { scope: "eng", schemaHash: SCHEMA, arguments: prepared.args } });
    expect((await w.write(id)).arguments).toEqual({ issueId: "1", body: "cc alice /merge now" });
    await w.approve(BOB, id);
    // Approving runs exactly the stored (stripped) text, with nothing put back.
    expect(w.vendor.state.vendorCalls[0]!.request.arguments).toEqual({ issueId: "1", body: "cc alice /merge now" });
  });

  it("refuses to create an approval for a rule nobody registered, with CONFIG_INVALID", async () => {
    const w = world();
    const result = await code(w.ask(1, { approvers: { kind: "rule", rule: "nobody_registered", candidates: [] } }));
    expect(result).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);
  });

  it("refuses a GitHub call whose own owner and repo are not one of the project's repositories", async () => {
    const w = world();
    const issue = grant("github", "issue_write", { itemArguments: ["issue_number"], itemScopeArguments: ["owner", "repo"] });
    const call = (repo: string) => ({ scope: "web", schemaHash: SCHEMA, arguments: { owner: "acme", repo, issue_number: 4, title: "x" } });
    w.revision(2, { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "issue_write", access: "write" }] });
    w.deps.projectRepositories = async () => [{ name: "web", url: "https://github.com/acme/web.git", installationId: 77 }];
    const refused = await decideWrite(w.deps, w.input({ tool: issue, call: call("secret") }));
    expect(refused.outcome).toBe("refuse");
    // The right repository is not refused on that ground (it waits, as an issue edit of an item the run did not create does).
    expect((await decideWrite(w.deps, w.input({ tool: issue, call: call("web") }))).outcome).toBe("wait");
    // Fail closed: no way to list the repositories is a refusal.
    delete w.deps.projectRepositories;
    expect((await decideWrite(w.deps, w.input({ tool: issue, call: call("web") }))).outcome).toBe("refuse");
  });

  it("refuses a scope the connector does not have", async () => {
    const w = world();
    expect((await w.ask(1, { call: { scope: "ops", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s1" } } })).outcome).toBe("refuse");
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);
  });

  it("refuses a connector, scope or tool the project does not have now", async () => {
    const w = world();
    w.revision(2, linearConnector({ tools: [{ name: "get_issue", access: "read" }] }));
    expect((await w.ask(1)).outcome).toBe("refuse");
    w.revision(3, null);
    expect((await w.ask(2)).outcome).toBe("refuse");
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);
  });
});

describe("approving a write", () => {
  it("lets the owner approve: exactly the stored arguments run once under the derived request id, and the handler hears", async () => {
    const w = world({ audit: true });
    const id = await w.waiting(1);
    const outcome = await w.approve(ALICE, id);
    expect(outcome).toEqual({ status: "APPROVED_DONE" });
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
    const call = w.vendor.state.vendorCalls[0]!;
    expect(call.request).toEqual({ requestId: deriveWriteRequestId(id as never), scope: "eng", tool: "save_issue", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s1" } });
    expect(call).toMatchObject({ orgId: ORG_A, project: "web", taskId: TASK, workspaceId: WORKSPACE, ownerKey: OWNER_KEY, connector: "linear" });
    expect(call.definition.revision).toBe(1);
    const record = await w.write(id);
    expect(record).toMatchObject({ status: "APPROVED_DONE", decidedBy: ALICE, attempts: 1, result: { status: "SUCCEEDED" } });
    expect(record.decidedAt).toBe("2026-10-22T09:00:00.000Z");
    expect(w.handled).toEqual([{ kind: "write", status: "APPROVED_DONE", approvalId: id }]);
    // Nothing left to expire or retry.
    expect(w.open()).toHaveLength(0);
    const actions = w.audit!.recorded().map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["approval.decided", "write.executed"]));
  });

  it("is the same request id on every attempt and a valid UUID", () => {
    const first = deriveWriteRequestId("apr_aaaaaaaaaaaaaaaaaaaa");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deriveWriteRequestId("apr_aaaaaaaaaaaaaaaaaaaa")).toBe(first);
    expect(deriveWriteRequestId("apr_bbbbbbbbbbbbbbbbbbbb")).not.toBe(first);
  });

  it("lets a project maintainer and an org admin approve, and refuses a contributor with the exact words", async () => {
    const w = world();
    const a = await w.waiting(1);
    const b = await w.waiting(2);
    const c = await w.waiting(3);
    expect(await code(w.approve(CARA, a))).toEqual({ code: "FORBIDDEN", message: FORBIDDEN });
    expect(await code(w.approve(ERIN, a))).toEqual({ code: "FORBIDDEN", message: FORBIDDEN });
    expect((await w.record(a)).status).toBe("PENDING");
    expect((await w.approve(BOB, a)).status).toBe("APPROVED_DONE");
    expect((await w.approve(DANA, b, REQ(902), "admin")).status).toBe("APPROVED_DONE");
    expect((await w.approve(ALICE, c)).status).toBe("APPROVED_DONE");
    expect(w.vendor.state.vendorCalls).toHaveLength(3);
  });

  it("answers a second decision with APPROVAL_CLOSED and runs nothing again; a repeat of the same request id answers the stored outcome", async () => {
    const w = world();
    const id = await w.waiting(1);
    await w.approve(BOB, id, REQ(1));
    expect(await code(w.approve(BOB, id, REQ(2)))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(await code(w.decline(DANA, id, REQ(3)))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(await w.approve(BOB, id, REQ(1))).toEqual({ status: "APPROVED_DONE" });
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
    expect(w.handled).toHaveLength(1);
  });

  it("runs once when two people approve at the same moment", async () => {
    const w = world();
    const id = await w.waiting(1);
    const results = await Promise.allSettled([w.approve(BOB, id, REQ(1)), w.approve(ALICE, id, REQ(2))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
  });

  it("needs a new approval for changed arguments, and keeps the first one's arguments", async () => {
    const w = world();
    const a = await w.waiting(1);
    const b = await w.waiting(2);
    expect(b).not.toBe(a);
    await w.approve(BOB, a);
    expect(w.vendor.state.vendorCalls.map((call) => call.request.arguments)).toEqual([{ id: "ENG-12", stateId: "s1" }]);
  });

  it("records what a create made so a later change to it is the run's own", async () => {
    const w = world();
    const id = await w.waiting(1, { call: { scope: "eng", schemaHash: SCHEMA, arguments: { title: "A new thing" } } });
    expect((await w.write(id)).class).toBe("consequential");
    await w.approve(BOB, id);
    expect(w.db.find((item) => item.entityType === "AGENT_ITEM" && String(item.sk).includes("CHA-9"))).toHaveLength(1);
  });

  it("declines: nothing runs, the handler hears the decline, and the place in the step is freed", async () => {
    const w = world();
    const id = await w.waiting(1);
    expect(await w.decline(BOB, id)).toEqual({ status: "DECLINED" });
    expect(await w.record(id)).toMatchObject({ status: "DECLINED", decidedBy: BOB });
    expect(w.vendor.state.runs).toBe(0);
    expect(w.handled).toEqual([{ kind: "write", status: "DECLINED", approvalId: id }]);
    expect(await code(w.decline(BOB, id, REQ(7)))).toMatchObject({ code: "APPROVAL_CLOSED" });
  });

  it("does not know another org's approval", async () => {
    const w = world();
    const id = await w.waiting(1);
    expect(await getAnyApproval(w.deps, ORG_B, id as never)).toBeUndefined();
    const stranger = decideApproval(w.deps, w.caller(XAVI, "owner", ORG_B), id, { requestId: REQ(1), decision: "APPROVE" });
    expect(await code(stranger)).toMatchObject({ code: "NOT_FOUND" });
    expect((await w.record(id)).status).toBe("PENDING");
  });
});

describe("the re-checks at approval time", () => {
  const failedWith = async (w: World, id: string, text?: string) => {
    const record = await w.write(id);
    expect(record.status).toBe("APPROVED_FAILED");
    if (text !== undefined) expect(record.failure).toBe(text);
    expect(w.vendor.state.runs).toBe(0);
    expect(w.handled).toEqual([{ kind: "write", status: "APPROVED_FAILED", approvalId: id }]);
    return record;
  };

  it("ends APPROVED_FAILED when the task was cancelled, and runs nothing", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.set({ pk: taskPointerKey(WORKSPACE).pk, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK, developerId: ALICE, cancelledAt: "2026-10-22T09:30:00.000Z" });
    expect(await w.approve(BOB, id)).toEqual({ status: "APPROVED_FAILED" });
    await failedWith(w, id, "The task ended before this was approved, so Rovara didn't run it.");
  });

  it("ends APPROVED_FAILED when the run's agent state says the task is over", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.set({ pk: `DEVTASK#${TASK}`, sk: "AGENT_RUN", orgId: ORG_A, state: "CANCELLED" });
    await w.approve(BOB, id);
    await failedWith(w, id, "The task ended before this was approved, so Rovara didn't run it.");
  });

  it("ends the task creator_removed when its owner was removed, and runs nothing", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.delete(orgMemberKey(ORG_A, ALICE));
    w.db.set({ ...orgRemovedKey(ORG_A, ALICE), entityType: "ORG_REMOVED", orgId: ORG_A, developerId: ALICE });
    expect(await w.approve(BOB, id)).toEqual({ status: "APPROVED_FAILED" });
    const record = await failedWith(w, id);
    expect(record.failure).toContain("Alice is no longer a member");
    expect(w.db.get(taskKey(TASK))).toMatchObject({ outcome: "creator_removed" });
  });

  it("ends APPROVED_FAILED when the project is archived", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "archived" });
    await w.approve(BOB, id);
    await failedWith(w, id, "The project is archived, so Rovara didn't run it.");
  });

  it("reads the run owner's authority through requireProjectAuthority's seam, with the task's owner key", async () => {
    const w = world();
    const id = await w.waiting(1);
    await w.approve(BOB, id);
    expect(w.live.authorityChecks).toEqual([{ ownerKey: OWNER_KEY, project: "web" }]);
    const second = await w.waiting(2);
    w.live.authorityRefusal = true;
    await w.approve(BOB, second, REQ(5));
    expect(await w.write(second)).toMatchObject({ status: "APPROVED_FAILED", failure: "The person who started this no longer has access to the project, so Rovara didn't run it." });
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
  });

  it("ends APPROVED_FAILED when the project's tool approval was revoked, reading the current revision", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.revision(2, linearConnector({ tools: [{ name: "get_issue", access: "read" }, { name: "create_comment", access: "write" }] }));
    await w.approve(BOB, id);
    await failedWith(w, id, "The project no longer approves this tool, so Rovara didn't run it.");
  });

  it("ends APPROVED_FAILED when the tool was lowered to read-only", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.revision(2, linearConnector({ tools: [{ name: "get_issue", access: "read" }, { name: "save_issue", access: "read" }] }));
    await w.approve(BOB, id);
    await failedWith(w, id, "The project no longer approves this tool, so Rovara didn't run it.");
  });

  it("ends APPROVED_FAILED when the agent's grant is gone, with the reason it gives", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.live.grantRefusal = "The agent no longer has this tool, so Rovara didn't run it.";
    await w.approve(BOB, id);
    await failedWith(w, id, "The agent no longer has this tool, so Rovara didn't run it.");
  });

  it("lets the class rise to refused but never fall: a deny rule added since stops the run", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.live.policy = { rules: [{ tool: "save_issue", connector: "linear", outcome: "deny" }] };
    await w.approve(BOB, id);
    await failedWith(w, id, "A project rule no longer allows this, so Rovara didn't run it.");
  });

  it("does not let a lowered class cancel an approval: a rule that would now call it safe still runs what a person approved", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.live.policy = { rules: [{ tool: "save_issue", connector: "linear", outcome: "allow" }] };
    expect((await w.approve(BOB, id)).status).toBe("APPROVED_DONE");
  });

  it("ends APPROVED_FAILED with the exact words when the connector's credential or scope changed since it was asked", async () => {
    const credential = world();
    const a = await credential.waiting(1);
    credential.revision(2, linearConnector({ credentialRef: OTHER_CONNECTION }));
    await credential.approve(BOB, a);
    await failedWith(credential, a, CHANGED);

    const scope = world();
    const b = await scope.waiting(1);
    scope.revision(2, linearConnector({ scopes: [{ alias: "eng", teamId: OTHER_TEAM }] }));
    await scope.approve(BOB, b);
    await failedWith(scope, b, CHANGED);

    const renamed = world();
    const c = await renamed.waiting(1);
    renamed.revision(2, linearConnector({ scopes: [{ alias: "ops", teamId: TEAM }] }));
    await renamed.approve(BOB, c);
    await failedWith(renamed, c, CHANGED);

    const gone = world();
    const d = await gone.waiting(1);
    gone.revision(2, null);
    await gone.approve(BOB, d);
    await failedWith(gone, d, CHANGED);
  });

  it("is not blocked by an unrelated project revision, and runs under the current revision", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.revision(2, linearConnector());
    w.revision(3, linearConnector({ tools: [{ name: "get_issue", access: "read" }, { name: "save_issue", access: "write" }] }));
    expect((await w.approve(BOB, id)).status).toBe("APPROVED_DONE");
    expect(w.vendor.state.vendorCalls[0]!.definition.revision).toBe(3);
    // The record keeps the revision it was asked under, for display.
    expect((await w.write(id)).projectRevision).toBe(1);
  });

  it("fails closed when the project's revision can't be read", async () => {
    const w = world();
    const id = await w.waiting(1);
    const send = w.db.send.bind(w.db);
    w.db.send = async (command) => {
      if (JSON.stringify((command as { input?: unknown }).input ?? {}).includes('"REV#"')) throw Object.assign(new Error("down"), { name: "ServiceUnavailable" });
      return send(command);
    };
    await w.approve(BOB, id).catch(() => undefined);
    expect(w.vendor.state.runs).toBe(0);
    expect(["EXECUTING", "APPROVED_FAILED"]).toContain((await w.record(id)).status);
  });

  it("runs after the workspace is reaped, through the context rebuilt from the task record", async () => {
    const w = world();
    const id = await w.waiting(1);
    // No workspace record exists at all; the task record names the workspace and the owner key.
    expect(w.db.find((item) => String(item.pk).startsWith("WORKSPACE#") && item.sk === "META")).toHaveLength(0);
    expect((await w.approve(BOB, id)).status).toBe("APPROVED_DONE");
    expect(w.vendor.state.vendorCalls[0]).toMatchObject({ workspaceId: WORKSPACE, ownerKey: OWNER_KEY });
  });

  it("ends APPROVED_FAILED when the vendor refuses, with a capped, cleaned reason", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.answer = { status: "FAILED", text: `Entity not found‮${"x".repeat(1000)}` };
    await w.approve(BOB, id);
    const record = await w.write(id);
    expect(record.status).toBe("APPROVED_FAILED");
    expect(record.failure!.length).toBeLessThanOrEqual(400);
    expect(record.failure).not.toContain("‮");
  });
});

describe("a crash after the claim, and the sweep that finishes it", () => {
  it("leaves the record EXECUTING, answers a new decision APPROVAL_CLOSED, and completes it from the ledger six minutes later with one vendor call", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.crashesAfterVendor = 1;
    await w.approve(BOB, id).catch(() => undefined);
    expect(await w.record(id)).toMatchObject({ status: "EXECUTING", attempts: 1 });
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
    expect(await code(w.approve(DANA, id, REQ(2), "admin"))).toMatchObject({ code: "APPROVAL_CLOSED" });
    // Too early: the claim is only a minute old.
    w.clock.now += MINUTE;
    await w.sweep();
    expect((await w.record(id)).status).toBe("EXECUTING");
    w.clock.now += 5 * MINUTE;
    await w.sweep();
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_DONE", attempts: 2, result: { status: "SUCCEEDED", replayed: true } });
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
    expect(w.handled).toEqual([{ kind: "write", status: "APPROVED_DONE", approvalId: id }]);
    // A second sweep does nothing.
    const before = w.db.commandNames().length;
    w.clock.now += 10 * MINUTE;
    await w.sweep();
    // The retry found the call in the ledger and reported it; it did not go back to the connector path.
    expect(w.vendor.state.runs).toBe(1);
    expect(w.db.commandNames().slice(before).filter((name) => ["UpdateCommand", "PutCommand", "TransactWriteCommand"].includes(name))).toEqual([]);
    expect(w.handled).toHaveLength(1);
  });

  it("re-runs the checks on the retry: a task cancelled since fails it", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.neverFinishes = true;
    await w.approve(BOB, id).catch(() => undefined);
    w.db.set({ pk: `DEVTASK#${TASK}`, sk: "AGENT_RUN", orgId: ORG_A, state: "CANCELLED" });
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(await w.write(id)).toMatchObject({ status: "APPROVED_FAILED" });
  });

  it("ends APPROVED_FAILED after five attempts with the exact words", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.neverFinishes = true;
    await w.approve(BOB, id).catch(() => undefined);
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      w.clock.now += 6 * MINUTE;
      await w.sweep();
      expect(await w.record(id), `attempt ${String(attempt)}`).toMatchObject({ status: "EXECUTING", attempts: attempt });
    }
    // The fifth attempt that leaves it unconfirmed ends it at once.
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_FAILED", attempts: 5, failure: "Rovara couldn't confirm that this ran. Check linear before asking again." });
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(w.handled).toEqual([{ kind: "write", status: "APPROVED_FAILED", approvalId: id }]);
    expect(w.vendor.state.runs).toBe(5);
  });

  it("reports a call the ledger already recorded as done on a retry, even if the task was cancelled since", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.crashesAfterVendor = 1;
    await w.approve(BOB, id).catch(() => undefined);
    w.db.set({ pk: `DEVTASK#${TASK}`, sk: "AGENT_RUN", orgId: ORG_A, state: "CANCELLED" });
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_DONE", result: { status: "SUCCEEDED", replayed: true } });
    expect(w.vendor.state.runs).toBe(1);
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
  });

  it("does not take a ledger entry that is not a success for a call that ran, and does not say it did not run", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.neverFinishes = true;
    await w.approve(BOB, id).catch(() => undefined);
    w.vendor.ledger.set(deriveWriteRequestId(id), { requestId: deriveWriteRequestId(id), status: "IN_PROGRESS", text: "", truncated: false, replayed: false });
    w.db.set({ pk: `DEVTASK#${TASK}`, sk: "AGENT_RUN", orgId: ORG_A, state: "CANCELLED" });
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_FAILED", failure: "Rovara couldn't confirm that this ran. Check linear before asking again." });
  });

  it("still re-checks a first attempt, whatever the ledger holds", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.ledger.set(deriveWriteRequestId(id), { requestId: deriveWriteRequestId(id), status: "SUCCEEDED", text: "{}", truncated: false, replayed: false });
    w.db.set({ pk: `DEVTASK#${TASK}`, sk: "AGENT_RUN", orgId: ORG_A, state: "CANCELLED" });
    await w.approve(BOB, id);
    expect((await w.record(id)).status).toBe("APPROVED_FAILED");
  });

  it("ends a record that already used its attempts without driving it again", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.neverFinishes = true;
    await w.approve(BOB, id).catch(() => undefined);
    // The process died on its fifth attempt before it could say so.
    w.db.set({ ...w.db.get(approvalKey(ORG_A, id))!, attempts: 5 });
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_FAILED", failure: "Rovara couldn't confirm that this ran. Check linear before asking again." });
    expect(w.vendor.state.runs).toBe(1);
  });

  it("lets only one of two sweeps take a stuck record", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.crashesAfterVendor = 1;
    await w.approve(BOB, id).catch(() => undefined);
    w.clock.now += 6 * MINUTE;
    await Promise.all([w.sweep(), w.sweep()]);
    expect(w.handled).toHaveLength(1);
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
    expect((await w.record(id)).status).toBe("APPROVED_DONE");
  });

  it("never expires an EXECUTING record", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.neverFinishes = true;
    await w.approve(BOB, id).catch(() => undefined);
    w.clock.now += 8 * DAY;
    await w.sweep();
    expect((await w.record(id)).status).not.toBe("EXPIRED");
  });

  it("calls the handler again on a sweep when the process died between the final status and the handler", async () => {
    const w = world();
    const id = await w.waiting(1);
    let fail = true;
    registerApprovalSubjectHandler("agent_run", async (_deps, record) => {
      if (fail) throw new Error("dead before the handler");
      w.handled.push({ kind: record.kind, status: record.status, approvalId: record.approvalId });
    });
    await w.approve(BOB, id).catch(() => undefined);
    expect((await w.record(id)).status).toBe("APPROVED_DONE");
    expect(w.handled).toEqual([]);
    fail = false;
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(w.handled).toEqual([{ kind: "write", status: "APPROVED_DONE", approvalId: id }]);
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
    expect(w.open()).toHaveLength(0);
  });
});

describe("expireApprovals", () => {
  it("expires a seven-day-old approval, calls its handler once, frees the step and leaves nothing open", async () => {
    const w = world({ audit: true });
    const id = await w.waiting(1);
    w.clock.now += 6 * DAY;
    await w.sweep();
    expect((await w.record(id)).status).toBe("PENDING");
    w.clock.now += 2 * DAY;
    await w.sweep();
    expect(await w.record(id)).toMatchObject({ status: "EXPIRED" });
    expect(w.handled).toEqual([{ kind: "write", status: "EXPIRED", approvalId: id }]);
    expect(w.open()).toHaveLength(0);
    await w.sweep();
    expect(w.handled).toHaveLength(1);
    expect(w.vendor.state.runs).toBe(0);
    expect(w.audit!.recorded().map((event) => event.action)).toContain("approval.expired");
    expect(await code(w.approve(BOB, id))).toMatchObject({ code: "APPROVAL_CLOSED" });
    // The step has room again.
    for (let n = 1; n <= 10; n += 1) await w.waiting(n + 100);
  });

  it("does not expire one a person decided at the last moment", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.clock.now += 7 * DAY - MINUTE;
    await w.approve(BOB, id);
    w.clock.now += 2 * MINUTE;
    await w.sweep();
    expect((await w.record(id)).status).toBe("APPROVED_DONE");
  });

  it("pages with a cursor and stops at its deadline", async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) await w.waiting(n);
    w.clock.now += 8 * DAY;
    const first = await expireApprovals(w.deps, w.clock.now, undefined, { limit: 2 });
    expect(first.next).toBeDefined();
    const second = await expireApprovals(w.deps, w.clock.now, first.next, { limit: 2 });
    expect(second.next).toBeUndefined();
    expect(w.db.find((item) => item.entityType === "APPROVAL" && item.status === "EXPIRED")).toHaveLength(3);
    const late = world();
    await late.waiting(1);
    late.clock.now += 8 * DAY;
    const stopped = await expireApprovals(late.deps, late.clock.now, undefined, { deadline: late.clock.now - 1 });
    expect(stopped.stopped).toBe(true);
    expect((await late.record((late.db.find((item) => item.entityType === "APPROVAL")[0] as { approvalId: string }).approvalId)).status).toBe("PENDING");
  });
});

describe("who may decide, read live", () => {
  it("refuses a maintainer demoted to contributor after the approval was asked, and lets one added afterwards approve", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.members.grant(ORG_A, "web", BOB, "contributor");
    expect(await code(w.approve(BOB, id))).toEqual({ code: "FORBIDDEN", message: FORBIDDEN });
    // ERIN was not a candidate when it was asked and is a maintainer now.
    w.members.grant(ORG_A, "web", ERIN, "maintainer");
    expect((await w.approve(ERIN, id)).status).toBe("APPROVED_DONE");
  });

  it("refuses the run's owner once they no longer hold start_tasks, and lets a maintainer in their place", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.members.grant(ORG_A, "web", ALICE, "viewer");
    expect(await code(w.approve(ALICE, id))).toEqual({ code: "FORBIDDEN", message: FORBIDDEN });
    expect((await w.approve(BOB, id)).status).toBe("APPROVED_DONE");
  });

  it("lets a stub chain_autonomous_writer rule decide: the trigger's creator is allowed and a stranger is refused", async () => {
    const w = world();
    registerApproverRule("chain_autonomous_writer", async (_deps, _record, who) => who.developerId === CARA);
    const id = await w.waiting(1, { approvers: { kind: "rule", rule: "chain_autonomous_writer", candidates: [CARA] } });
    expect(await code(w.approve(ERIN, id))).toMatchObject({ code: "FORBIDDEN" });
    expect(await code(w.approve(BOB, id, REQ(3)))).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.approve(CARA, id, REQ(4))).status).toBe("APPROVED_DONE");
  });

  it("refuses a decision when the record names a rule nobody registered", async () => {
    const w = world();
    const id = await w.waiting(1);
    const stored = w.db.get(approvalKey(ORG_A, id))!;
    w.db.set({ ...stored, approvers: { kind: "rule", rule: "gone", candidates: [BOB] } });
    expect(await code(w.approve(BOB, id))).toMatchObject({ code: "FORBIDDEN" });
    expect(w.vendor.state.runs).toBe(0);
  });

  it("checks an id list against the people named, with start_tasks held now", async () => {
    const w = world();
    const id = await w.waiting(1, { approvers: { kind: "ids", ids: [CARA, BOB] } });
    expect(await code(w.approve(DANA, id, REQ(1), "admin"))).toMatchObject({ code: "FORBIDDEN" });
    w.members.grant(ORG_A, "web", CARA, "viewer");
    expect(await code(w.approve(CARA, id, REQ(2)))).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.approve(BOB, id, REQ(3))).status).toBe("APPROVED_DONE");
  });

  it("reads the org role live: a member removed from the org can't decide", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.delete(orgMemberKey(ORG_A, BOB));
    expect(await code(w.approve(BOB, id))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists the owner and every approve_writes holder as candidates, once each, resolved to survivors", async () => {
    const w = world();
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    const listed = await writeApproversFor(w.deps, { orgId: ORG_A, project: "web", owner: { developerId: OLD_ALICE } });
    expect([...listed].sort()).toEqual([ALICE, BOB, DANA].sort());
    expect(WRITE_APPROVER_RULE).toBe("write_approver");
  });
});

describe("a merged member", () => {
  it("lets the survivor decide a write approval and a step approval addressed to the duplicate, before any sweep", async () => {
    const w = world();
    // An approval whose owner and candidates are the duplicate; the duplicate has since been merged into Alice.
    const id = await w.waiting(1, { run: { project: "web", owner: { developerId: OLD_ALICE, name: "Alice" } } });
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    w.db.delete(orgMemberKey(ORG_A, OLD_ALICE));
    expect((await w.approve(ALICE, id)).status).toBe("APPROVED_DONE");

    registerApproverRule("by_ids", async () => false);
    const step = await createStepApproval(w.deps, {
      orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go on?", approvers: { kind: "ids", ids: [OLD_ALICE] }, project: "web", owner: { developerId: OLD_ALICE, name: "Alice" },
    });
    expect((await decideApproval(w.deps, w.caller(ALICE), step.approvalId, { requestId: REQ(8), decision: "APPROVE" })).status).toBe("APPROVED");
  });

  it("moves the duplicate to the survivor in the approvers, the candidates, the index items and the run owner of pending approvals, repeatably", async () => {
    const w = world();
    const write = await w.waiting(1, { run: { project: "web", owner: { developerId: OLD_ALICE, name: "Alice" } }, approvers: { kind: "rule", rule: "write_approver", candidates: [OLD_ALICE, BOB] } });
    registerApproverRule("t_rule", async () => true);
    const step = await createStepApproval(w.deps, { orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go?", approvers: { kind: "ids", ids: [OLD_ALICE, CARA] }, project: "web", owner: { developerId: OLD_ALICE, name: "Alice" } });
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    w.db.delete(orgMemberKey(ORG_A, OLD_ALICE));
    const lifecycle = { ...w.deps, log: w.deps.log! };
    await onMembersMerged(lifecycle, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    const moved = await w.write(write);
    expect(moved.owner.developerId).toBe(ALICE);
    expect((moved.approvers as unknown as { candidates: string[] }).candidates.sort()).toEqual([ALICE, BOB].sort());
    expect(w.db.get(approverIndexKey(ORG_A, OLD_ALICE, write as never))).toBeUndefined();
    expect(w.db.get(approverIndexKey(ORG_A, ALICE, write as never))).toBeDefined();
    const movedStep = (await w.record(step.approvalId)) as StepApprovalRecord;
    expect((movedStep.approvers as unknown as { ids: string[] }).ids.sort()).toEqual([ALICE, CARA].sort());
    expect(w.db.get(approverIndexKey(ORG_A, ALICE, step.approvalId))).toBeDefined();
    // Repeating changes nothing.
    const snapshot = structuredClone([...w.db.items.entries()]);
    await onMembersMerged(lifecycle, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect(structuredClone([...w.db.items.entries()])).toEqual(snapshot);
  });

  it("does not move a decided approval, nor another org's", async () => {
    const w = world();
    const id = await w.waiting(1, { run: { project: "web", owner: { developerId: OLD_ALICE, name: "Alice" } } });
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    await w.approve(BOB, id);
    const before = structuredClone(w.db.get(approvalKey(ORG_A, id as never)));
    await onMembersMerged({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect(w.db.get(approvalKey(ORG_A, id as never))).toEqual(before);
  });

  it("re-routes a removed person's approvals to the successor and drops them from the candidates and the index", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.delete(orgMemberKey(ORG_A, CARA));
    w.db.set({ ...orgMemberKey(ORG_A, DANA), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: DANA, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    // Bob (a candidate and a maintainer) leaves; Dana is the org's first owner and takes over.
    w.db.delete(orgMemberKey(ORG_A, BOB));
    await onMemberRemoved({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, developerId: BOB, by: DANA });
    const moved = await w.write(id);
    expect((moved.approvers as unknown as { candidates: string[] }).candidates).not.toContain(BOB);
    expect(w.db.get(approverIndexKey(ORG_A, BOB, id as never))).toBeUndefined();
    const owned = world();
    const mine = await owned.waiting(1, { approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: [ALICE, BOB] } });
    owned.db.set({ ...orgMemberKey(ORG_A, DANA), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: DANA, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    owned.db.delete(orgMemberKey(ORG_A, ALICE));
    await onMemberRemoved({ ...owned.deps, log: owned.deps.log! }, { orgId: ORG_A, developerId: ALICE, by: DANA });
    expect((await owned.write(mine)).owner.developerId).toBe(DANA);
    // The removed run owner is re-routed to the successor in the candidates too, and the successor is listed.
    expect(((await owned.write(mine)).approvers as unknown as { candidates: string[] }).candidates.sort()).toEqual([BOB, DANA].sort());
    expect(owned.db.get(approverIndexKey(ORG_A, DANA, mine as never))).toBeDefined();
  });

  it("stops between items when its time has run out, leaving the rest for the next run", async () => {
    const w = world();
    await w.waiting(1, { run: { project: "web", owner: { developerId: OLD_ALICE, name: "Alice" } } });
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    const deadline = w.clock.now - 1;
    await expect(onMembersMerged({ ...w.deps, log: w.deps.log!, deadline }, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE })).rejects.toThrow();
  });
});

describe("step approvals", () => {
  const stepInput = (over: Record<string, unknown> = {}) => ({
    orgId: ORG_A, subject: { kind: "test_subject", taskId: TASK, stepId: "gate" } as never, prompt: "Ship it?",
    approvers: { kind: "rule" as const, rule: "t_step", candidates: [ALICE, BOB] }, ...over,
  });

  it("lists a step approval for its candidates, calls the registered rule at decision time, and calls the subject handler once on APPROVE", async () => {
    const w = world();
    const calls: string[] = [];
    registerApproverRule("t_step", async (_deps, _record, who) => { calls.push(who.developerId); return who.developerId !== ERIN; });
    const seen: Array<{ status: string }> = [];
    registerApprovalSubjectHandler("test_subject" as never, async (_deps, record) => { seen.push({ status: record.status }); });
    const step = await createStepApproval(w.deps, stepInput());
    expect(step).toMatchObject({ kind: "step", status: "PENDING", prompt: "Ship it?", approvers: { kind: "rule", rule: "t_step", candidates: [ALICE, BOB] } });
    for (const who of [ALICE, BOB]) expect((await listApprovalsFor(w.deps, w.caller(who), "PENDING")).map((record) => record.approvalId)).toEqual([step.approvalId]);
    expect(await listApprovalsFor(w.deps, w.caller(CARA), "PENDING")).toEqual([]);
    // c is not a candidate and the rule refuses them; the rule is called at decision time.
    expect(await code(decideApproval(w.deps, w.caller(ERIN), step.approvalId, { requestId: REQ(1), decision: "APPROVE" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toEqual([ERIN]);
    expect(await decideApproval(w.deps, w.caller(BOB), step.approvalId, { requestId: REQ(2), decision: "APPROVE" })).toEqual({ status: "APPROVED" });
    expect(seen).toEqual([{ status: "APPROVED" }]);
    expect(await code(decideApproval(w.deps, w.caller(BOB), step.approvalId, { requestId: REQ(3), decision: "APPROVE" }))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(await listApprovalsFor(w.deps, w.caller(ALICE), "PENDING")).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("honours a custom expiresAt and calls the handler once on expiry", async () => {
    const w = world();
    registerApproverRule("t_step", async () => true);
    const seen: string[] = [];
    registerApprovalSubjectHandler("test_subject" as never, async (_deps, record) => { seen.push(record.status); });
    const step = await createStepApproval(w.deps, stepInput({ expiresAt: "2026-10-22T10:00:00.000Z" }));
    expect(step.expiresAt).toBe("2026-10-22T10:00:00.000Z");
    w.clock.now = Date.parse("2026-10-22T10:00:01.000Z");
    await w.sweep();
    await w.sweep();
    expect(seen).toEqual(["EXPIRED"]);
    expect((await w.record(step.approvalId)).status).toBe("EXPIRED");
  });

  it("answers a repeat of the same subject with the same record, and refuses a rule nobody registered", async () => {
    const w = world();
    registerApproverRule("t_step", async () => true);
    const first = await createStepApproval(w.deps, stepInput());
    expect((await createStepApproval(w.deps, stepInput())).approvalId).toBe(first.approvalId);
    expect(await code(createStepApproval(w.deps, stepInput({ approvers: { kind: "rule", rule: "nobody", candidates: [] } })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(createStepApproval(w.deps, stepInput({ prompt: "" })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(createStepApproval(w.deps, stepInput({ prompt: "x".repeat(301) })))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("declines a step approval and tells the handler", async () => {
    const w = world();
    registerApproverRule("t_step", async () => true);
    const seen: string[] = [];
    registerApprovalSubjectHandler("test_subject" as never, async (_deps, record) => { seen.push(record.status); });
    const step = await createStepApproval(w.deps, stepInput());
    expect(await decideApproval(w.deps, w.caller(BOB), step.approvalId, { requestId: REQ(1), decision: "DECLINE" })).toEqual({ status: "DECLINED" });
    expect(seen).toEqual(["DECLINED"]);
  });
});

describe("what is checked before anything is stored", () => {
  it("refuses a call the connector path would not accept, and stores nothing", async () => {
    const w = world();
    for (const call of [
      { scope: "eng", schemaHash: "nope", arguments: { id: "ENG-12", stateId: "s1" } },
      { scope: "Not A Scope!", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s1" } },
      { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "x".repeat(70_000) } },
    ]) {
      expect(await code(decideWrite(w.deps, w.input({ call })))).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(await code(decideWrite(w.deps, w.input({ stepId: "Bad Step" })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(decideWrite(w.deps, w.input({ taskId: "../x" })))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);
  });

  it("fails closed when the deployment has no write gate", async () => {
    const w = world();
    delete w.deps.writeGate;
    expect(await code(w.ask(1))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("makes the record, the open item, the event and up to 88 approver items in one transaction", async () => {
    const w = world();
    const many = Array.from({ length: 120 }, (_, index) => index.toString(16).padStart(64, "0"));
    const id = await w.waiting(1, { approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: many } });
    expect(w.db.find((item) => item.entityType === "APPROVER_INDEX")).toHaveLength(88);
    expect(((await w.write(id)).approvers as unknown as { candidates: string[] }).candidates).toHaveLength(120);
    const transactions = w.db.commandNames().filter((name) => name === "TransactWriteCommand");
    expect(transactions.length).toBeGreaterThan(0);
  });

  it("writes the record, the index items, the counter and the event together or not at all", async () => {
    const w = world();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" }, times: 1 });
    await expect(w.ask(1)).rejects.toThrow();
    expect(w.db.find((item) => String(item.pk).includes("STEP_APPROVALS") || item.pk === "OPEN_APPROVALS" || item.entityType === "APPROVAL" || item.entityType === "TASK_EVENT")).toEqual([]);
    expect((await w.ask(1)).outcome).toBe("wait");
  });
});

describe("the audit trail", () => {
  it("records the decision with the decider, the proof and the class, the execution with its status, and the expiry", async () => {
    const w = world({ audit: true });
    const id = await w.waiting(1);
    const proof = { kind: "fresh_sign_in", method: "email_code", authTime: "2026-10-22T08:58:00.000Z", sessionRef: "e".repeat(64) } as const;
    await decideApproval(w.deps, { ...w.caller(BOB), decideProof: proof }, id, { requestId: REQ(1), decision: "APPROVE" });
    const decided = w.audit!.recordedBy("approval.decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ actor: { kind: "member", id: BOB }, target: { kind: "approval", id }, proof, facts: { kind: "write", decision: "APPROVE", subjectKind: "agent_run", class: "consequential" } });
    expect(w.audit!.recordedBy("write.executed")).toMatchObject([{ actor: { kind: "system" }, facts: { connectorType: "linear", tool: "save_issue", status: "APPROVED_DONE" } }]);
    const second = await w.waiting(2);
    w.clock.now += 8 * DAY;
    await w.sweep();
    expect(w.audit!.recordedBy("approval.expired")).toMatchObject([{ target: { id: second }, facts: { kind: "write", subjectKind: "agent_run" } }]);
  });

  it("leaves the audit items pending when the queue is down, from the same transactions as the decision and the execution", async () => {
    const w = world({ audit: true });
    const id = await w.waiting(1);
    w.audit!.queueDown();
    await w.approve(BOB, id);
    expect(w.audit!.pending().map((event) => event.action).sort()).toEqual(["approval.decided", "write.executed"]);
    const second = await w.waiting(2);
    w.clock.now += 8 * DAY;
    await w.sweep();
    expect(second).toBeDefined();
    expect(w.audit!.pending().map((event) => event.action)).toContain("approval.expired");
  });

  it("puts the audit items in the same transaction as the decision", async () => {
    const w = world({ audit: true });
    const id = await w.waiting(1);
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" }, times: 1 });
    await expect(w.approve(BOB, id)).rejects.toThrow();
    expect(w.audit!.recordedBy("approval.decided")).toEqual([]);
    expect((await w.record(id)).status).toBe("PENDING");
  });
});

describe("a decision racing an expiry", () => {
  it("lets exactly one of them win", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.clock.now += 7 * DAY + MINUTE;
    const [decided, swept] = await Promise.allSettled([w.approve(BOB, id), w.sweep()]);
    expect(swept.status).toBe("fulfilled");
    const status = (await w.record(id)).status;
    expect(["APPROVED_DONE", "EXPIRED"]).toContain(status);
    expect(w.vendor.state.vendorCalls).toHaveLength(status === "APPROVED_DONE" ? 1 : 0);
    expect(w.handled).toHaveLength(1);
    if (status === "EXPIRED") expect(decided.status).toBe("rejected");
  });
});

describe("a decision after the approval's time (re-check N1)", () => {
  it("refuses APPROVAL_CLOSED at expiresAt + 1 ms, calls no vendor, and lets the later sweep mark it EXPIRED", async () => {
    const w = world();
    const id = await w.waiting(1);
    const expiresAt = Date.parse((await w.record(id)).expiresAt);
    w.clock.now = expiresAt + 1;
    expect(await code(w.approve(BOB, id))).toEqual({ code: "APPROVAL_CLOSED", message: "this request has expired" });
    expect(w.vendor.state.runs).toBe(0);
    expect(await w.record(id)).toMatchObject({ status: "PENDING" });
    // A decline is a decision too, and is refused the same way.
    expect(await code(w.decline(BOB, id))).toMatchObject({ code: "APPROVAL_CLOSED" });
    await w.sweep();
    expect(await w.record(id)).toMatchObject({ status: "EXPIRED" });
    expect(w.vendor.state.runs).toBe(0);
  });

  it("treats the moment of expiresAt itself as expired", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.clock.now = Date.parse((await w.record(id)).expiresAt);
    expect(await code(w.approve(BOB, id))).toEqual({ code: "APPROVAL_CLOSED", message: "this request has expired" });
    expect(w.vendor.state.runs).toBe(0);
  });

  it("still accepts a decision at the last moment (now equal to expiresAt minus 1 ms)", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.clock.now = Date.parse((await w.record(id)).expiresAt) - 1;
    expect((await w.approve(BOB, id)).status).toBe("APPROVED_DONE");
  });

  it("makes the claim itself conditional on the time: a record read before expiry loses to the clock at the claim", async () => {
    const w = world();
    const id = await w.waiting(1);
    const stale = await w.record(id);
    // The decision read the record while it was open, and the clock passed expiresAt before the claim was made.
    const { runApprovalDecision } = await import("../../packages/broker/src/agents/approvals.js");
    const late = { ...w.deps, now: () => Date.parse(stale.expiresAt) + 1 };
    // The in-memory check would catch this too, so read the time only once: the early read says open, the claim says closed.
    let reads = 0;
    const flipping = { ...late, now: () => (reads++ === 0 ? Date.parse(stale.expiresAt) - 1000 : Date.parse(stale.expiresAt) + 1) };
    await expect(runApprovalDecision(flipping, w.caller(BOB), stale, { requestId: REQ(950), decision: "APPROVE" })).rejects.toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(w.vendor.state.runs).toBe(0);
    expect(await w.record(id)).toMatchObject({ status: "PENDING" });
  });
});

describe("the index the sweep reads", () => {
  it("drops an item that does not agree with its own key, and one whose record is gone", async () => {
    const w = world();
    const past = "2026-10-22T08:00:00.000Z";
    w.db.set({ pk: "OPEN_APPROVALS", sk: `${past}#${ORG_A}#apr_zzzzzzzzzzzzzzzzzzzz`, orgId: ORG_B, approvalId: "apr_zzzzzzzzzzzzzzzzzzzz" });
    w.db.set({ pk: "OPEN_APPROVALS", sk: `${past}#${ORG_A}#apr_yyyyyyyyyyyyyyyyyyyy`, orgId: ORG_A, approvalId: "apr_yyyyyyyyyyyyyyyyyyyy" });
    w.db.set({ pk: "OPEN_APPROVALS", sk: "garbage", orgId: ORG_A });
    await w.sweep();
    expect(w.open()).toEqual([]);
  });

  it("never reads another org's record through an item that names it", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.clock.now += 8 * DAY;
    const item = w.open()[0]!;
    w.db.delete({ pk: item.pk as string, sk: item.sk as string });
    w.db.set({ ...item, sk: String(item.sk).replace(ORG_A, ORG_B), orgId: ORG_B });
    await w.sweep();
    expect((await w.record(id)).status).toBe("PENDING");
  });
});

describe("a change approval is decided the same way", () => {
  const change = async (w: World, over: Record<string, unknown> = {}) => createPendingChange(w.deps, {
    orgId: ORG_A, requestId: REQ(70), requestedBy: ALICE, changes: ["Raises something"], approvers: { kind: "ids", ids: [BOB] },
    subject: { kind: "agent_publish", agentId: "agt_00000000000000000001", draftRevision: 1, digest: "d".repeat(64) }, ...over,
  } as never);

  it("claims it, hands the handler the record with who decided it and how, and ends it APPROVED_DONE", async () => {
    const w = world();
    const seen: Array<{ decidedBy?: string | undefined; status: string; proof?: unknown }> = [];
    registerApprovalSubjectHandler("agent_publish", async (_deps, record, decision) => { seen.push({ decidedBy: record.decidedBy, status: record.status, proof: decision?.proof }); });
    const record = await change(w);
    const proof = { kind: "button", via: "slack" } as const;
    expect(await decideApproval(w.deps, { ...w.caller(BOB), decideProof: proof }, record.approvalId, { requestId: REQ(1), decision: "APPROVE" })).toEqual({ status: "APPROVED_DONE" });
    expect(seen).toEqual([{ decidedBy: BOB, status: "EXECUTING", proof }]);
    expect(await getAnyApproval(w.deps, ORG_A, record.approvalId)).toMatchObject({ status: "APPROVED_DONE", decidedBy: BOB });
    expect(await code(decideApproval(w.deps, w.caller(BOB), record.approvalId, { requestId: REQ(2), decision: "APPROVE" }))).toMatchObject({ code: "APPROVAL_CLOSED" });
  });

  it("ends it APPROVED_FAILED with the handler's words when it can no longer be applied, without the error code", async () => {
    const w = world();
    registerApprovalSubjectHandler("agent_publish", async () => { throw agentXError("AGENT_REVISION_CONFLICT", "The draft changed after this was asked. Publish again."); });
    const record = await change(w);
    expect(await decideApproval(w.deps, w.caller(BOB), record.approvalId, { requestId: REQ(1), decision: "APPROVE" })).toEqual({ status: "APPROVED_FAILED" });
    expect(await getAnyApproval(w.deps, ORG_A, record.approvalId)).toMatchObject({ status: "APPROVED_FAILED", failure: "The draft changed after this was asked. Publish again." });
  });

  it("leaves it EXECUTING when the handler dies, and the sweep applies it", async () => {
    const w = world();
    let dies = true;
    const applied: string[] = [];
    registerApprovalSubjectHandler("agent_publish", async (_deps, record) => { if (dies) throw new Error("down"); applied.push(record.approvalId); });
    const record = await change(w);
    expect(await decideApproval(w.deps, w.caller(BOB), record.approvalId, { requestId: REQ(1), decision: "APPROVE" })).toEqual({ status: "EXECUTING" });
    dies = false;
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(applied).toEqual([record.approvalId]);
    expect((await getAnyApproval(w.deps, ORG_A, record.approvalId))?.status).toBe("APPROVED_DONE");
  });

  it("declines without calling the handler, and expires without calling it", async () => {
    const w = world();
    const called: string[] = [];
    registerApprovalSubjectHandler("agent_publish", async (_deps, record) => { called.push(record.approvalId); });
    const a = await change(w);
    expect(await decideApproval(w.deps, w.caller(BOB), a.approvalId, { requestId: REQ(1), decision: "DECLINE" })).toEqual({ status: "DECLINED" });
    const b = await change(w, { requestId: REQ(71) });
    w.clock.now += 8 * DAY;
    await w.sweep();
    expect((await getAnyApproval(w.deps, ORG_A, b.approvalId))?.status).toBe("EXPIRED");
    expect(called).toEqual([]);
    expect(w.open()).toEqual([]);
  });

  it("lists it for the people it names, in the same list as the writes", async () => {
    const w = world();
    registerApprovalSubjectHandler("agent_publish", async () => undefined);
    const record = await change(w);
    const id = await w.waiting(1);
    expect((await listApprovalsFor(w.deps, w.caller(BOB), "PENDING")).map((entry) => entry.approvalId).sort()).toEqual([id, record.approvalId].sort());
  });
});

describe("the step approval's creation", () => {
  it("refuses a subject kind nothing is registered to continue", async () => {
    const w = world();
    registerApproverRule("t_step", async () => true);
    expect(await code(createStepApproval(w.deps, { orgId: ORG_A, subject: { kind: "never_registered", taskId: TASK, stepId: "x" } as never, prompt: "Go?", approvers: { kind: "rule", rule: "t_step", candidates: [] } }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("evaluates write_approver on a step from its task when the creator named no run", async () => {
    const w = world();
    const step = await createStepApproval(w.deps, {
      orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go?", approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: await writeApproversFor(w.deps, { orgId: ORG_A, project: "web", owner: { developerId: ALICE } }) },
    });
    expect(await code(decideApproval(w.deps, w.caller(CARA), step.approvalId, { requestId: REQ(1), decision: "APPROVE" }))).toMatchObject({ code: "FORBIDDEN" });
    expect((await decideApproval(w.deps, w.caller(BOB), step.approvalId, { requestId: REQ(2), decision: "APPROVE" })).status).toBe("APPROVED");
    expect(w.handled).toEqual([{ kind: "step", status: "APPROVED", approvalId: step.approvalId }]);
  });
});

describe("races and leftovers the guards are for", () => {
  it("answers another person's repeat of a request id as closed, not as the stored outcome", async () => {
    const w = world();
    const id = await w.waiting(1);
    await w.approve(BOB, id, REQ(1));
    expect(await code(w.approve(DANA, id, REQ(1), "admin"))).toMatchObject({ code: "APPROVAL_CLOSED" });
  });

  it("does not let a driver that lost its claim end the record", async () => {
    const w = world();
    const id = await w.waiting(1);
    // While the first driver is at the vendor, another worker claims the retry (a newer executingAt).
    w.vendor.state.during = () => {
      const stored = w.db.get(approvalKey(ORG_A, id))!;
      w.db.set({ ...stored, executingAt: new Date(w.clock.now + 7 * MINUTE).toISOString(), attempts: 2 });
    };
    expect(await w.approve(BOB, id)).toEqual({ status: "EXECUTING" });
    expect(await w.record(id)).toMatchObject({ status: "EXECUTING", attempts: 2 });
    expect(w.handled).toEqual([]);
  });

  it("lets only one of two sweeps reach the vendor for a stuck record", async () => {
    const w = world();
    // Without the ledger probe a retry goes through the connector path, where the request id replays the recorded result.
    w.runtime.recordedResult = async () => undefined;
    const id = await w.waiting(1);
    w.vendor.state.crashesAfterVendor = 1;
    await w.approve(BOB, id).catch(() => undefined);
    let release: () => void = () => undefined;
    w.vendor.state.gate = new Promise<void>((resolve) => { release = resolve; });
    w.clock.now += 6 * MINUTE;
    const sweeps = Promise.all([w.sweep(), w.sweep()]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await sweeps;
    // The first attempt, and one retry.
    expect(w.vendor.state.runs).toBe(2);
    expect(w.handled).toHaveLength(1);
  });

  it("does not drive a record again for a due item left by an earlier claim", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.neverFinishes = true;
    await w.approve(BOB, id).catch(() => undefined);
    // A newer claim (4 minutes in) than the item that is due at 5.
    const stored = w.db.get(approvalKey(ORG_A, id))!;
    w.db.set({ ...stored, executingAt: new Date(w.clock.now + 4 * MINUTE).toISOString() });
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(w.vendor.state.runs).toBe(1);
    expect(w.open().map((item) => item.sk)).toEqual([]);
  });

  it("drops a due item of a pending record that is not its own expiry, and expires nothing early", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.set({ pk: "OPEN_APPROVALS", sk: `2026-10-22T08:00:00.000Z#${ORG_A}#${id}`, orgId: ORG_A, approvalId: id });
    await w.sweep();
    expect((await w.record(id)).status).toBe("PENDING");
    expect(w.open().map((item) => item.sk)).toEqual([expect.stringContaining((await w.write(id)).expiresAt)]);
  });

  it("marks a record handled once its handler has heard, and drops every due item", async () => {
    const w = world();
    const id = await w.waiting(1);
    await w.approve(BOB, id);
    expect(await w.record(id)).toMatchObject({ handlerDone: true });
    expect(w.open()).toEqual([]);
  });

  it("leaves nothing in the open index once a stuck record has been completed by the sweep", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.crashesAfterVendor = 1;
    await w.approve(BOB, id).catch(() => undefined);
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect((await w.record(id)).status).toBe("APPROVED_DONE");
    expect(w.open()).toEqual([]);
  });

  it("reads a stored record whose org field disagrees with its key as missing", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.set({ ...w.db.get(approvalKey(ORG_A, id))!, orgId: ORG_B });
    expect(await getAnyApproval(w.deps, ORG_A, id as never)).toBeUndefined();
  });

  it("reads the run of a step from its own org's task only", async () => {
    const w = world();
    w.db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG_B, developerId: XAVI, developerName: "Xavi", project: "web", workspaceId: WORKSPACE, ownerKey: "k" });
    const step = await createStepApproval(w.deps, {
      orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go?", approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: [BOB] },
    });
    expect(await code(decideApproval(w.deps, w.caller(BOB), step.approvalId, { requestId: REQ(1), decision: "APPROVE" }))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not list a successor who is not named after a removal", async () => {
    const w = world();
    const HANK = hex("8");
    w.db.set({ ...orgMemberKey(ORG_A, HANK), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: HANK, role: "owner", joinedAt: "2026-09-01T00:00:00.000Z" });
    const id = await w.waiting(1);
    w.db.delete(orgMemberKey(ORG_A, BOB));
    await onMemberRemoved({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, developerId: BOB, by: HANK });
    expect(w.db.get(approverIndexKey(ORG_A, HANK, id as never))).toBeUndefined();
    expect(w.db.get(approverIndexKey(ORG_A, BOB, id as never))).toBeUndefined();
  });

  it("refuses to decide a write when the deployment has no write gate, and claims nothing", async () => {
    const w = world();
    const id = await w.waiting(1);
    delete w.deps.writeGate;
    expect(await code(w.approve(BOB, id))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await w.record(id)).status).toBe("PENDING");
    // Saying no needs no connector path.
    expect(await w.decline(BOB, id)).toEqual({ status: "DECLINED" });
  });

  it("answers a repeat of a decided call as decided even after the project dropped the connector", async () => {
    const w = world();
    const id = await w.waiting(1);
    await w.approve(BOB, id);
    w.revision(2, null);
    expect(await w.ask(1)).toEqual({ outcome: "refuse", reason: "A person already decided this action. Carry on with the rest of your work." });
    expect(id).toBeDefined();
  });

  it("leaves the record EXECUTING when the connector's answer is unknown, and finishes it from the ledger's later answer", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.answer = { status: "UNKNOWN" };
    expect(await w.approve(BOB, id)).toEqual({ status: "EXECUTING" });
    expect((await w.record(id)).status).toBe("EXECUTING");
    expect(w.handled).toEqual([]);
    w.vendor.ledger.set(deriveWriteRequestId(id), { requestId: deriveWriteRequestId(id), status: "SUCCEEDED", text: "{}", truncated: false, replayed: false });
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect((await w.record(id)).status).toBe("APPROVED_DONE");
  });

  it("reads the task of the record's own org only", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.task({ orgId: ORG_B });
    await w.approve(BOB, id);
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_FAILED", failure: "The task ended before this was approved, so Rovara didn't run it." });
  });
});

describe("fix round 1: what a finished approval leaves behind", () => {
  const approverItems = (w: World, id: string) => w.db.find((item) => item.entityType === "APPROVER_INDEX" && item.approvalId === id);

  it("I1: deletes every approver item in the transaction that ends PENDING (approve, decline, expire), and keeps the others'", async () => {
    const w = world();
    const [a, b, c, keep] = [await w.waiting(1), await w.waiting(2), await w.waiting(3), await w.waiting(4)];
    expect(approverItems(w, a)).toHaveLength(3);
    await w.approve(BOB, a);
    expect(approverItems(w, a)).toEqual([]);
    await w.decline(BOB, b);
    expect(approverItems(w, b)).toEqual([]);
    // Only the first three expire.
    const stored = w.db.get(approvalKey(ORG_A, keep))!;
    w.db.set({ ...stored, expiresAt: "2026-10-30T09:00:00.000Z" });
    w.clock.now = Date.parse("2026-10-29T09:30:00.000Z");
    await w.sweep();
    expect(approverItems(w, c)).toEqual([]);
    expect(approverItems(w, keep)).toHaveLength(3);
  });

  it("I1: does the same for a step approval, and for an approval that fails", async () => {
    const w = world();
    registerApproverRule("t_step", async () => true);
    const step = await createStepApproval(w.deps, { orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go?", approvers: { kind: "rule", rule: "t_step", candidates: [ALICE, BOB] } });
    expect(approverItems(w, step.approvalId)).toHaveLength(2);
    await decideApproval(w.deps, w.caller(BOB), step.approvalId, { requestId: REQ(1), decision: "APPROVE" });
    expect(approverItems(w, step.approvalId)).toEqual([]);
    const failing = await w.waiting(1);
    w.live.grantRefusal = "No.";
    await w.approve(BOB, failing);
    expect(approverItems(w, failing)).toEqual([]);
  });

  it("I1: gives the approver items the index TTL, a day after the approval would have expired, and the step counter too", async () => {
    const w = world();
    const id = await w.waiting(1);
    const expires = Math.floor(Date.parse((await w.write(id)).expiresAt) / 1000);
    for (const item of approverItems(w, id)) expect(item[INDEX_EXPIRY_ATTRIBUTE]).toBe(expires + 86_400);
    const counter = w.db.find((item) => String(item.pk).includes("STEP_APPROVALS"))[0]!;
    expect(counter[INDEX_EXPIRY_ATTRIBUTE]).toBe(expires + 86_400);
  });

  it("I1: still lists a new pending approval after many were decided", async () => {
    const w = world();
    for (let n = 1; n <= 30; n += 1) await w.decline(BOB, await w.waiting(n, { operationId: `4444444${String(n).padStart(1, "0")}-4444-4444-8444-444444444444`.slice(0, 36) }), REQ(100 + n));
    const fresh = await w.waiting(99);
    expect((await listApprovalsFor(w.deps, w.caller(BOB), "PENDING")).map((record) => record.approvalId)).toEqual([fresh]);
    expect(w.db.find((item) => item.entityType === "APPROVER_INDEX")).toHaveLength(3);
  });

  it("I2: moves a failing handler's due item forward with backoff, and gives up after eight tries", async () => {
    const w = world();
    let calls = 0;
    registerApprovalSubjectHandler("agent_run", async () => { calls += 1; throw new Error("down"); });
    const id = await w.waiting(1);
    await w.approve(BOB, id);
    expect(calls).toBe(1);
    expect(w.open().map((item) => item.sk)).toEqual([expect.stringContaining("2026-10-22T09:05:00.000Z")]);
    // Not yet due: nothing is called.
    w.clock.now += 3 * MINUTE;
    await w.sweep();
    expect(calls).toBe(1);
    const expected = [10, 20, 40, 80, 160, 320, 360];
    for (let call = 2; call <= 8; call += 1) {
      w.clock.now = Date.parse((await w.write(id)).handlerDueAt!) + 1000;
      const before = w.clock.now;
      await w.sweep();
      expect(calls, `call ${String(call)}`).toBe(call);
      if (call < 8) {
        const due = Date.parse((await w.write(id)).handlerDueAt!);
        // The next try waits twice as long as the last (doubling, capped at six hours); the item moved with it.
        expect(Math.round((due - before) / MINUTE), `delay after call ${String(call)}`).toBe(expected[call - 2]);
        expect(w.open().map((item) => item.sk)).toEqual([expect.stringContaining(new Date(due).toISOString())]);
      }
    }
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_DONE", handlerDone: true });
    expect(w.logs.map((entry) => entry.event)).toContain("approval.handler_gave_up");
    expect(w.open()).toEqual([]);
    w.clock.now += 2 * DAY;
    await w.sweep();
    expect(calls).toBe(8);
  });

  it("I2: a failing handler no longer holds the head of the index: a later expiry is still reached", async () => {
    const w = world();
    registerApprovalSubjectHandler("agent_run", async () => { throw new Error("down"); });
    for (let n = 1; n <= 12; n += 1) await w.approve(BOB, await w.waiting(n, { operationId: `5555555${String(n % 10)}-5555-4555-8555-555555555555` }), REQ(200 + n));
    const late = await w.waiting(50, { operationId: "66666666-6666-4666-8666-666666666666" });
    const stored = w.db.get(approvalKey(ORG_A, late))!;
    w.db.set({ ...stored, expiresAt: "2026-10-22T09:30:00.000Z" });
    w.db.set({ pk: "OPEN_APPROVALS", sk: `2026-10-22T09:30:00.000Z#${ORG_A}#${late}`, orgId: ORG_A, approvalId: late });
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    // Every failing one moved forward with backoff: none of them is due again, so none holds the head of the index.
    const times = w.open().map((item) => String(item.sk).slice(0, 24)).sort();
    expect(times).toHaveLength(14);
    expect(times.filter((at) => Date.parse(at) <= w.clock.now)).toEqual([]);
    w.clock.now = Date.parse("2026-10-22T09:31:00.000Z");
    await w.sweep();
    expect((await w.record(late)).status).toBe("EXPIRED");
  });

  it("I2: saves where a sweep that ran out of time stopped, starts there next time, and clears it at the end of the index", async () => {
    const w = world();
    const ids: string[] = [];
    for (let n = 1; n <= 4; n += 1) ids.push(await w.waiting(n));
    w.clock.now += 8 * DAY;
    const base = w.clock.now;
    let reads = 0;
    w.deps.now = () => base + (reads++) * 40;
    const starts: Array<unknown> = [];
    const send = w.db.send.bind(w.db);
    w.db.send = async (command) => {
      const input = (command as { input?: { ExclusiveStartKey?: { pk?: string; sk?: string }; ExpressionAttributeValues?: Record<string, unknown> } }).input;
      if (input?.ExpressionAttributeValues?.[":pk"] === "OPEN_APPROVALS") starts.push(input.ExclusiveStartKey?.sk);
      return send(command);
    };
    const first = await runApprovalSweep(w.deps, { budgetMs: 600, pageSize: 1 });
    expect(first.complete).toBe(false);
    const saved = w.db.get({ pk: "SWEEP_CURSOR#approvals", sk: "META" });
    expect(saved).toBeDefined();
    const remaining = async () => (await Promise.all(ids.map((id) => w.record(id)))).filter((record) => record.status === "PENDING").length;
    const left = await remaining();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(4);
    starts.length = 0;
    for (let run = 0; run < 8 && (await remaining()) > 0; run += 1) await runApprovalSweep(w.deps, { budgetMs: 600, pageSize: 1 });
    // The next run began at the saved cursor, not at the head of the index.
    expect(starts[0]).toBe((saved as { cursor?: string }).cursor);
    expect(await remaining()).toBe(0);
    w.deps.now = () => base + 10_000_000;
    await runApprovalSweep(w.deps, { budgetMs: 100_000 });
    expect(w.db.get({ pk: "SWEEP_CURSOR#approvals", sk: "META" })).toBeUndefined();
  });

  it("I2: does not call a handler for a stale due item that is earlier than the record's own backed-off time", async () => {
    const w = world();
    let calls = 0;
    registerApprovalSubjectHandler("agent_run", async () => { calls += 1; throw new Error("down"); });
    const id = await w.waiting(1);
    await w.approve(BOB, id);
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(calls).toBe(2);
    // The lease on it is old by now, and the record still waits (it is due at 09:16); an old item left from before is due at once.
    w.clock.now += 6 * MINUTE;
    w.db.set({ pk: "OPEN_APPROVALS", sk: `2026-10-22T09:00:00.000Z#${ORG_A}#${id}`, orgId: ORG_A, approvalId: id });
    await w.sweep();
    expect(calls).toBe(2);
    expect(w.open().map((item) => item.sk)).toEqual([expect.stringContaining((await w.write(id)).handlerDueAt!)]);
  });

  it("I2: goes round from the head of the index after a saved cursor, so what sorted before it is not left", async () => {
    const w = world();
    const ids = [await w.waiting(1), await w.waiting(2), await w.waiting(3)];
    w.clock.now += 8 * DAY;
    const last = w.open().map((item) => String(item.sk)).sort().at(-1)!;
    w.db.set({ pk: "SWEEP_CURSOR#approvals", sk: "META", entityType: "SWEEP_CURSOR", cursor: last, at: "2026-10-22T09:00:00.000Z" });
    const run = await runApprovalSweep(w.deps, { budgetMs: 100_000 });
    expect(run.complete).toBe(true);
    for (const id of ids) expect((await w.record(id)).status).toBe("EXPIRED");
    expect(w.db.get({ pk: "SWEEP_CURSOR#approvals", sk: "META" })).toBeUndefined();
  });

  it("I3: writes an approval.requested audit item with the record, the index items and the event, and none for a repeat", async () => {
    const w = world({ audit: true });
    w.audit!.queueDown();
    const id = await w.waiting(1);
    await w.waiting(1);
    const pending = w.audit!.pending();
    expect(pending.map((event) => event.action)).toEqual(["approval.requested"]);
    expect(pending[0]).toMatchObject({ actor: { kind: "system" }, related: [ALICE], target: { kind: "approval", id }, facts: { kind: "write", subjectKind: "agent_run", class: "consequential", connectorType: "linear", tool: "save_issue", argumentsHash: (await w.write(id)).argumentsHash } });
    registerApproverRule("t_step", async () => true);
    await createStepApproval(w.deps, { orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go?", approvers: { kind: "rule", rule: "t_step", candidates: [ALICE] } });
    expect(w.audit!.pending().filter((event) => event.action === "approval.requested").map((event) => event.facts)).toEqual([expect.objectContaining({ kind: "write" }), { kind: "step", subjectKind: "agent_run" }]);
  });

  it("I3: leaves no audit item when the creating transaction fails, and stays under 100 items with the most candidates", async () => {
    const w = world({ audit: true });
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" }, times: 1 });
    await expect(w.ask(1)).rejects.toThrow();
    expect(w.audit!.pending()).toEqual([]);
    const many = Array.from({ length: 200 }, (_, index) => index.toString(16).padStart(64, "0"));
    const sizes: number[] = [];
    const send = w.db.send.bind(w.db);
    w.db.send = async (command) => {
      const items = (command as { input?: { TransactItems?: unknown[] } }).input?.TransactItems;
      if (items !== undefined) sizes.push(items.length);
      return send(command);
    };
    const id = await w.waiting(2, { approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: many } });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    // The decision that follows, which deletes the approver items, fits too.
    await w.decline(BOB, id).catch(() => undefined);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  });

  it("M-f: logs when the candidates are cut to the cap", async () => {
    const w = world();
    const many = Array.from({ length: 120 }, (_, index) => index.toString(16).padStart(64, "0"));
    await w.waiting(1, { approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: many } });
    expect(w.logs.filter((entry) => entry.event === "approval.candidates_capped")).toMatchObject([{ fields: { orgId: ORG_A, listed: 88, named: 120 } }]);
  });
});

describe("fix round 1: the movers' audit trail", () => {
  it("I4: audits a merge as approval.rerouted in the same transaction as the move, and stamps the record", async () => {
    const w = world({ audit: true });
    const id = await w.waiting(1, { run: { project: "web", owner: { developerId: OLD_ALICE, name: "Alice" } }, approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: [OLD_ALICE, BOB] } });
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    w.db.delete(orgMemberKey(ORG_A, OLD_ALICE));
    w.audit!.queueDown();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" }, times: 1 });
    await expect(onMembersMerged({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE })).rejects.toThrow();
    expect(w.audit!.pending().filter((event) => event.action === "approval.rerouted")).toEqual([]);
    expect(await w.write(id)).toMatchObject({ owner: { developerId: OLD_ALICE } });
    await onMembersMerged({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    const events = w.audit!.pending().filter((event) => event.action === "approval.rerouted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "system" }, target: { kind: "approval", id }, related: [OLD_ALICE, ALICE], facts: { kind: "write", mode: "merged" } });
    const moved = await w.write(id) as WriteApprovalRecord & { movedBy?: string; movedAt?: string };
    expect(moved).toMatchObject({ movedBy: "system", movedAt: "2026-10-22T09:00:00.000Z" });
    // Repeating audits nothing more.
    await onMembersMerged({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect(w.audit!.pending().filter((event) => event.action === "approval.rerouted")).toHaveLength(1);
  });

  it("I4: audits a removal's re-route with the mode removed and the successor", async () => {
    const w = world({ audit: true });
    const HANK = hex("8");
    w.db.set({ ...orgMemberKey(ORG_A, HANK), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: HANK, role: "owner", joinedAt: "2026-09-01T00:00:00.000Z" });
    const id = await w.waiting(1);
    w.db.delete(orgMemberKey(ORG_A, BOB));
    w.audit!.queueDown();
    await onMemberRemoved({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, developerId: BOB, by: HANK });
    expect(w.audit!.pending().filter((event) => event.action === "approval.rerouted")).toMatchObject([{ target: { id }, related: [BOB, HANK], facts: { kind: "write", mode: "removed" } }]);
  });

  it("I4: audits nothing when only a stale index item moves", async () => {
    const w = world({ audit: true });
    const id = await w.waiting(1);
    w.db.set({ ...approverIndexKey(ORG_A, OLD_ALICE, id), entityType: "APPROVER_INDEX", approvalId: id, expiresAt: (await w.write(id)).expiresAt });
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    w.audit!.queueDown();
    await onMembersMerged({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect(w.audit!.pending().filter((event) => event.action === "approval.rerouted")).toEqual([]);
    expect(w.db.get(approverIndexKey(ORG_A, OLD_ALICE, id as never))).toBeUndefined();
  });

  it("M-c: lists the run owner too, so the mover finds an approval that names them only as the owner", async () => {
    const w = world();
    const id = await w.waiting(1, { run: { project: "web", owner: { developerId: OLD_ALICE, name: "Alice" } }, approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: [BOB] } });
    expect(w.db.get(approverIndexKey(ORG_A, OLD_ALICE, id as never))).toBeDefined();
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    w.db.delete(orgMemberKey(ORG_A, OLD_ALICE));
    await onMembersMerged({ ...w.deps, log: w.deps.log! }, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    expect((await w.write(id)).owner.developerId).toBe(ALICE);
    expect(w.db.get(approverIndexKey(ORG_A, ALICE, id as never))).toBeDefined();
    expect(w.db.get(approverIndexKey(ORG_A, OLD_ALICE, id as never))).toBeUndefined();
  });
});

describe("fix round 1: fail closed and who sees what", () => {
  it("I5: refuses a listed id when the run can't be determined, whatever role they hold", async () => {
    const w = world();
    registerApproverRule("t_x", async () => true);
    w.db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG_B, developerId: XAVI, developerName: "Xavi", project: "web", workspaceId: WORKSPACE, ownerKey: "k" });
    // A stored step approval that names ids and has no project or owner, on a task of another org.
    const step = await createStepApproval(w.deps, { orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go?", approvers: { kind: "rule", rule: "t_x", candidates: [ERIN] }, project: "web", owner: { developerId: ALICE, name: "Alice" } });
    const stored = w.db.get(approvalKey(ORG_A, step.approvalId))!;
    const bare: Record<string, unknown> = { ...stored };
    delete bare["project"];
    delete bare["owner"];
    w.db.set({ ...bare, approvers: { kind: "ids", ids: [ERIN] } });
    expect(await code(decideApproval(w.deps, w.caller(ERIN), step.approvalId, { requestId: REQ(1), decision: "APPROVE" }))).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.record(step.approvalId)).status).toBe("PENDING");
  });

  it("I5: a step with an id list must say its project and owner; one with a rule need not", async () => {
    const w = world();
    registerApproverRule("t_x", async () => true);
    const subject = { kind: "agent_run", taskId: TASK, stepId: "gate" } as const;
    expect(await code(createStepApproval(w.deps, { orgId: ORG_A, subject, prompt: "Go?", approvers: { kind: "ids", ids: [BOB] } }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(createStepApproval(w.deps, { orgId: ORG_A, subject, prompt: "Go?", approvers: { kind: "ids", ids: [BOB] }, project: "web" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await createStepApproval(w.deps, { orgId: ORG_A, subject, prompt: "Go?", approvers: { kind: "ids", ids: [BOB] }, project: "web", owner: { developerId: ALICE, name: "Alice" } })).kind).toBe("step");
    expect((await createStepApproval(w.deps, { orgId: ORG_A, subject: { ...subject, stepId: "gate2" }, prompt: "Go?", approvers: { kind: "rule", rule: "t_x", candidates: [] } })).kind).toBe("step");
  });

  it("M-a: a call on another scope is another approval", async () => {
    const w = world();
    w.revision(2, linearConnector({ scopes: [{ alias: "eng", teamId: TEAM }, { alias: "ops", teamId: OTHER_TEAM }] }));
    const call = (scope: string) => ({ scope, schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s1" } });
    const a = await w.waiting(1, { call: call("eng") });
    const b = await w.waiting(1, { call: call("ops") });
    expect(b).not.toBe(a);
    expect((await w.write(b)).scope).toBe("ops");
  });

  it("M-b: shows the arguments to a candidate only while they may decide or can view the task", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.runtime.canViewTask = async () => false;
    const request = (who: AgentCaller) => routeApprovalRequest(w.deps, who, { method: "GET", path: `/v1/app/approvals/${id}`, headers: {}, requestId: "r", query: {} } as never, new URL(`https://cell.example.com/v1/app/approvals/${id}`));
    expect(((await request(w.caller(BOB))) as { approval: Record<string, unknown> }).approval["arguments"]).toBeDefined();
    // Bob is still named in the candidates, and is a contributor now.
    w.members.grant(ORG_A, "web", BOB, "contributor");
    expect(await code(request(w.caller(BOB)))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("M-e: keeps the open item of a record that is there but can't be read, and drops one whose record is gone", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.set({ ...w.db.get(approvalKey(ORG_A, id))!, status: "WEIRD" });
    w.clock.now += 8 * DAY;
    const report = await w.sweep();
    expect(report.failed).toBe(1);
    expect(w.open()).toHaveLength(1);
    expect(w.logs.map((entry) => entry.event)).toContain("approval.record_unreadable");
    w.db.delete(approvalKey(ORG_A, id));
    await w.sweep();
    expect(w.open()).toEqual([]);
  });
});

describe("the routes", () => {
  const request = (method: string, path: string, body?: unknown) => ({ method, path, headers: {}, body: body === undefined ? undefined : JSON.stringify(body), requestId: "r1", query: {} }) as never;
  const route = (w: World, who: AgentCaller, method: string, path: string, body?: unknown) =>
    routeApprovalRequest(w.deps, who, request(method, path, body), new URL(`https://cell.example.com${path}`));

  it("lists the pending approvals the caller is asked about, with the summary and not the arguments", async () => {
    const w = world();
    const id = await w.waiting(1);
    const listed = await route(w, w.caller(BOB), "GET", "/v1/app/approvals?status=PENDING") as { approvals: Array<Record<string, unknown>> };
    expect(listed.approvals).toHaveLength(1);
    expect(listed.approvals[0]).toMatchObject({ approvalId: id, kind: "write", status: "PENDING", summary: describeAction("linear__save_issue", { id: "ENG-12", stateId: "s1" }) });
    expect(listed.approvals[0]).not.toHaveProperty("arguments");
    expect(((await route(w, w.caller(ERIN), "GET", "/v1/app/approvals?status=PENDING")) as { approvals: unknown[] }).approvals).toEqual([]);
    expect(((await route(w, w.caller(XAVI, "owner", ORG_B), "GET", "/v1/app/approvals?status=PENDING")) as { approvals: unknown[] }).approvals).toEqual([]);
    await w.approve(BOB, id);
    expect(((await route(w, w.caller(BOB), "GET", "/v1/app/approvals?status=PENDING")) as { approvals: unknown[] }).approvals).toEqual([]);
  });

  it("shows the full stored arguments to an approver and to a task viewer, and answers 404 to anyone else and to another org", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.runtime.canViewTask = async (who) => who.developerId === CARA;
    const shown = await route(w, w.caller(BOB), "GET", `/v1/app/approvals/${id}`) as { approval: Record<string, unknown> };
    expect(shown.approval).toMatchObject({ approvalId: id, status: "PENDING", arguments: { id: "ENG-12", stateId: "s1" }, tool: "save_issue" });
    expect(shown.approval).not.toHaveProperty("credentialRef");
    expect(((await route(w, w.caller(CARA), "GET", `/v1/app/approvals/${id}`)) as { approval: Record<string, unknown> }).approval["arguments"]).toEqual({ id: "ENG-12", stateId: "s1" });
    for (const stranger of [w.caller(ERIN), w.caller(XAVI, "owner", ORG_B)]) {
      expect(await code(route(w, stranger, "GET", `/v1/app/approvals/${id}`)), stranger.developerId).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await code(route(w, w.caller(BOB), "GET", "/v1/app/approvals/apr_zzzzzzzzzzzzzzzzzzzz"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(route(w, w.caller(BOB), "GET", "/v1/app/approvals/not-an-id"))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("decides both kinds only behind the presence guard, and fails closed without one", async () => {
    const w = world();
    const id = await w.waiting(1);
    // No guard wired (Task 21a): the route is not there.
    expect(await code(route(w, w.caller(BOB), "POST", `/v1/app/approvals/${id}/decide`, { requestId: REQ(1), decision: "APPROVE" }))).toMatchObject({ code: "NOT_FOUND" });
    expect((await w.record(id)).status).toBe("PENDING");
    let finished = 0;
    // A guard on the write gate's runtime is not one: only `ApprovalDependencies.requireDecide` is read (fix round 1, m2).
    (w.runtime as unknown as { requireDecide: unknown }).requireDecide = async () => ({ orgId: ORG_A, developerId: CARA, proof: { kind: "none" }, finish: async () => undefined, release: async () => undefined });
    expect(await code(route(w, w.caller(BOB), "POST", `/v1/app/approvals/${id}/decide`, { requestId: REQ(1), decision: "APPROVE" }))).toMatchObject({ code: "NOT_FOUND" });
    w.deps.requireDecide = async (_request, approvalId) => {
      if (approvalId !== id) throw agentXError("NOT_FOUND", "approval not found");
      return { orgId: ORG_A, developerId: BOB, proof: { kind: "none" } as never, finish: async () => { finished += 1; }, release: async () => { finished += 100; } };
    };
    const decided = await route(w, w.caller(CARA), "POST", `/v1/app/approvals/${id}/decide`, { requestId: REQ(2), decision: "APPROVE" });
    // The decider is the guard's session member (Bob), not the token's caller (Cara).
    expect(decided).toEqual({ status: "APPROVED_DONE" });
    expect(await w.record(id)).toMatchObject({ decidedBy: BOB });
    expect(finished).toBe(1);
    expect(await code(route(w, w.caller(BOB), "POST", `/v1/app/approvals/${id}/decide`, { requestId: REQ(3), decision: "MAYBE" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(route(w, w.caller(BOB), "POST", `/v1/app/approvals/${id}/decide`, { requestId: "no", decision: "APPROVE" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(route(w, w.caller(BOB), "POST", `/v1/app/approvals/${id}/decide`, { requestId: REQ(4), decision: "APPROVE", extra: 1 }))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("driving write approvals without the driver", () => {
  it("decideWriteApproval is the same function the generic decide dispatches to", async () => {
    const w = world();
    const id = await w.waiting(1);
    expect(await decideWriteApproval(w.deps, w.caller(BOB), id as never, { requestId: REQ(1), decision: "APPROVE" })).toEqual({ status: "APPROVED_DONE" });
  });
});

describe("the wiring fix round", () => {
  const safeNow = { class: "safe" as const, reason: "the lookup that held it now succeeds", ignoredRules: [] };
  const readNow = { class: "read" as const, reason: "a read", ignoredRules: [] };

  it("answers from a write approval that already exists, whatever the class is now (F1)", async () => {
    const w = world();
    const id = await w.waiting(1);
    for (const classification of [safeNow, readNow]) {
      const again = await decideWrite(w.deps, w.input({ call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s1" } }, classification }));
      expect(again).toMatchObject({ outcome: "wait", approvalId: id });
    }
    // Once decided, the same call is not run again either.
    await w.approve(BOB, id);
    expect(await decideWrite(w.deps, w.input({ call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s1" } }, classification: safeNow }))).toMatchObject({ outcome: "refuse" });
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
  });

  it("still lets a safe call with no approval run at once", async () => {
    const w = world();
    expect(await decideWrite(w.deps, w.input({ classification: safeNow }))).toEqual({ outcome: "run" });
  });

  it("still refuses what a project rule denies when an approval exists", async () => {
    const w = world();
    await w.waiting(1);
    const denied = { class: "consequential" as const, reason: "x", ignoredRules: [], denied: { rule: 1, reason: "closed" } };
    expect(await decideWrite(w.deps, w.input({ call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s1" } }, classification: denied }))).toMatchObject({ outcome: "refuse" });
  });

  it("re-classifies on the arguments the server binds, not only the stored call (minor 1)", async () => {
    const w = world();
    const id = await w.waiting(1);
    const original = w.runtime.regrant.bind(w.runtime);
    w.runtime.regrant = async (input) => {
      const regranted = await original(input);
      if ("refused" in regranted) return regranted;
      return { ...regranted, classifyArgs: { ...(input.record.arguments), owner: "acme" }, classify: { ...regranted.classify, projectPolicy: { rules: [{ tool: "save_issue", connector: "linear", whenArguments: ["owner"], outcome: "deny", reason: "closed" }] } } };
    };
    await w.approve(BOB, id);
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_FAILED", failure: "A project rule no longer allows this, so Rovara didn't run it." });
    expect(w.vendor.state.vendorCalls).toEqual([]);
  });

  it("ends a retry whose ledger record is in doubt as 'couldn't confirm', not 'didn't run' (minor 2)", async () => {
    for (const status of ["IN_PROGRESS", "UNKNOWN"] as const) {
      const w = world();
      const id = await w.waiting(1);
      w.vendor.state.neverFinishes = true;
      await w.approve(BOB, id).catch(() => undefined);
      w.runtime.recordedResult = async ({ requestId }) => ({ requestId, status, text: "unknown", truncated: false, replayed: false });
      // The task ended while the outcome was in doubt.
      w.task({ closedAt: "2026-10-22T09:30:00.000Z" });
      w.clock.now += 6 * MINUTE;
      await w.sweep();
      const ended = await w.write(id);
      expect(ended.status).toBe("APPROVED_FAILED");
      expect(ended.failure).toContain("couldn't confirm");
      expect(ended.failure).not.toContain("didn't run");
    }
  });

  it("leaves a stuck write for the next run when too little of the function's time is left to send it (budgets)", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.vendor.state.neverFinishes = true;
    await w.approve(BOB, id).catch(() => undefined);
    const calls = w.vendor.state.runs;
    w.clock.now += 6 * MINUTE;
    const late = await runApprovalSweep(w.deps, { budgetMs: 100_000, redriveUntil: w.clock.now - 1 });
    expect(late.redriven).toBe(0);
    expect(w.vendor.state.runs).toBe(calls);
    expect(await w.record(id)).toMatchObject({ status: "EXECUTING", attempts: 1 });
    w.vendor.state.neverFinishes = false;
    const early = await runApprovalSweep(w.deps, { budgetMs: 100_000, redriveUntil: w.clock.now + 5_000 });
    expect(early.redriven).toBe(1);
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_DONE" });
  });

  it("claims the call's request id in the transaction that makes the approval, and replays when the id is already claimed (N1)", async () => {
    const w = world();
    const claim = (requestId: string) => (approvalId: string) => ({
      Put: { TableName: "state", Item: { pk: "WORKSPACE#ws", sk: `CONNECTOR#linear#${requestId}`, approvalId }, ConditionExpression: "attribute_not_exists(pk)" },
    });
    const held = await decideWrite(w.deps, w.input({ claimRequest: claim(REQ(7)) }));
    expect(held.outcome).toBe("wait");
    expect(w.db.get("WORKSPACE#ws", `CONNECTOR#linear#${REQ(7)}`)).toMatchObject({ approvalId: (held as { approvalId: string }).approvalId });
    // Another call with the same request id finds it claimed: no approval is made, and the caller replays what the claim holds.
    const before = w.db.find((item) => item.entityType === "APPROVAL").length;
    const other = await decideWrite(w.deps, w.input({ call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s2" } }, claimRequest: claim(REQ(7)) }));
    expect(other).toEqual({ outcome: "replay" });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(before);
    expect(w.db.find((item) => item.entityType === "OPEN_APPROVAL")).toHaveLength(before);
  });

  it("makes no approval for an operation that has already ended, and one for an operation that still runs (Task 22 review, M2)", async () => {
    const w = world();
    const operationKey = { pk: "WORKSPACE#ws", sk: `OPERATION#${OPERATION}` };
    const guard = () => ({ ConditionCheck: { TableName: "state", Key: operationKey, ConditionExpression: "#status = :running", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":running": "RUNNING" } } });
    w.db.set({ ...operationKey, entityType: "OPERATION", status: "SUCCEEDED" });
    expect(await decideWrite(w.deps, w.input({ operationGuard: guard() }))).toMatchObject({ outcome: "refuse" });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    expect(w.db.find((item) => item.entityType === "OPEN_APPROVAL")).toEqual([]);
    expect(w.db.find((item) => String(item.pk).startsWith("ORG#") && String(item.pk).includes("STEP_APPROVALS#"))).toEqual([]);
    w.db.set({ ...operationKey, entityType: "OPERATION", status: "RUNNING" });
    expect((await decideWrite(w.deps, w.input({ operationGuard: guard() }))).outcome).toBe("wait");
    // With a request id claimed in the same transaction, the guard still decides and the claim is not left behind.
    w.db.set({ ...operationKey, entityType: "OPERATION", status: "SUCCEEDED" });
    const claim = (approvalId: string) => ({ Put: { TableName: "state", Item: { pk: "WORKSPACE#ws", sk: `CONNECTOR#linear#${REQ(8)}`, approvalId }, ConditionExpression: "attribute_not_exists(pk)" } });
    expect(await decideWrite(w.deps, w.input({ call: { scope: "eng", schemaHash: SCHEMA, arguments: { id: "ENG-12", stateId: "s9" } }, claimRequest: claim, operationGuard: guard() }))).toMatchObject({ outcome: "refuse" });
    expect(w.db.get("WORKSPACE#ws", `CONNECTOR#linear#${REQ(8)}`)).toBeUndefined();
  });
});


describe("after a take-over (Plan 5 Task 12a)", () => {
  const SINCE = "2026-10-22T08:30:00.000Z";
  const taken = (developerId: string, name: string) => ({ currentOwner: { developerId, name, provider: "oidc", since: SINCE } });

  it("an approval asked before the take-over is the taker's to decide: the creator is refused naming the taker, and the call is run as the taker's request", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.task(taken(CARA, "Cara"));
    expect(await code(w.approve(ALICE, id))).toEqual({ code: "FORBIDDEN", message: "Only Cara or a project maintainer can decide this." });
    expect((await w.write(id)).status).toBe("PENDING");
    expect(await w.approve(CARA, id)).toEqual({ status: "APPROVED_DONE" });
    // The run's owner reaches the connector as the requester, and what the record stored stays as history.
    expect(w.vendor.state.vendorCalls[0]).toMatchObject({ requestedBy: CARA, ownerKey: OWNER_KEY });
    expect((await w.write(id)).owner).toEqual({ developerId: ALICE, name: "Alice" });
  });

  it("keeps the owner the member movers wrote on the record when nobody took the task over: the stored owner is the owner until a take-over", async () => {
    const w = world();
    const id = await w.waiting(1);
    // A merge moved the approval's owner from Alice to Cara; the task still names Alice as its creator and nobody took it over.
    const stored = w.db.get(approvalKey(ORG_A, id))!;
    w.db.set({ ...stored, owner: { developerId: CARA, name: "Cara" } });
    expect(await code(w.approve(ALICE, id))).toEqual({ code: "FORBIDDEN", message: "Only Cara or a project maintainer can decide this." });
    expect(await w.approve(CARA, id)).toEqual({ status: "APPROVED_DONE" });
  });

  it("a maintainer may still decide it, as before", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.task(taken(CARA, "Cara"));
    expect(await w.approve(BOB, id)).toEqual({ status: "APPROVED_DONE" });
    expect(w.vendor.state.vendorCalls[0]).toMatchObject({ requestedBy: CARA });
  });

  it("is shown to the taker as the owner of the run: they can see the approval, and the creator who handed it over cannot", async () => {
    const w = world();
    const id = await w.waiting(1);
    const get = (who: AgentCaller) => routeApprovalRequest(w.deps, who, { method: "GET", path: `/v1/app/approvals/${id}`, headers: {}, requestId: "r1", query: {} } as never, new URL(`https://cell.example.com/v1/app/approvals/${id}`));
    // Before: the stored owner, Alice, sees it and Cara (a contributor) does not.
    expect(await get(w.caller(ALICE))).toMatchObject({ approval: { approvalId: id } });
    expect(await code(get(w.caller(CARA)))).toMatchObject({ code: "NOT_FOUND" });
    w.task(taken(CARA, "Cara"));
    expect(await get(w.caller(CARA))).toMatchObject({ approval: { approvalId: id } });
    expect(await code(get(w.caller(ALICE)))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps running an approved write after the creator who handed the task over was removed, and ends the task naming the taker when the taker was removed", async () => {
    const creatorGone = world();
    const first = await creatorGone.waiting(1);
    creatorGone.task(taken(CARA, "Cara"));
    creatorGone.db.delete(orgMemberKey(ORG_A, ALICE));
    creatorGone.db.set({ ...orgRemovedKey(ORG_A, ALICE), entityType: "ORG_REMOVED", orgId: ORG_A, developerId: ALICE });
    expect(await creatorGone.approve(BOB, first)).toEqual({ status: "APPROVED_DONE" });
    expect(creatorGone.db.get(taskKey(TASK))?.outcome).toBeUndefined();

    const takerGone = world();
    const second = await takerGone.waiting(1);
    takerGone.task(taken(CARA, "Cara"));
    takerGone.db.delete(orgMemberKey(ORG_A, CARA));
    takerGone.db.set({ ...orgRemovedKey(ORG_A, CARA), entityType: "ORG_REMOVED", orgId: ORG_A, developerId: CARA });
    expect(await takerGone.approve(BOB, second)).toEqual({ status: "APPROVED_FAILED" });
    expect((await takerGone.write(second)).failure).toContain("Cara is no longer a member");
    expect(takerGone.db.get(taskKey(TASK))).toMatchObject({ outcome: "creator_removed" });
    expect(takerGone.vendor.state.vendorCalls).toEqual([]);
  });

  it("a taker with no recorded name still decides by id: the page names them with the fixed label, and the creator is refused naming no one by name (ruling on 12a question 1)", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.task({ currentOwner: { developerId: CARA, provider: "oidc", since: SINCE } });
    expect(await code(w.approve(ALICE, id))).toEqual({ code: "FORBIDDEN", message: "Only a member or a project maintainer can decide this." });
    expect((await w.write(id)).status).toBe("PENDING");
    expect(await w.approve(CARA, id)).toEqual({ status: "APPROVED_DONE" });
    expect(w.vendor.state.vendorCalls[0]).toMatchObject({ requestedBy: CARA });
  });

  it("fences a decision on the owner it was judged under: a take-over that commits between the check and the claim refuses the creator and leaves the approval pending (12a review M-4)", async () => {
    const w = world();
    const id = await w.waiting(1);
    let flipped = false;
    const racing = { ...w.deps, documentClient: { async send(command: unknown) {
      if (!flipped && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { flipped = true; w.task(taken(CARA, "Cara")); }
      return w.db.send(command as never);
    } } };
    expect(await code(decideApproval(racing, w.caller(ALICE), id, { requestId: REQ(910), decision: "APPROVE" }))).toEqual({ code: "FORBIDDEN", message: "Only Cara or a project maintainer can decide this." });
    expect(flipped).toBe(true);
    expect((await w.write(id)).status).toBe("PENDING");
    expect(w.vendor.state.vendorCalls).toEqual([]);
  });

  it("lets a maintainer's decision stand through that race: it is judged again under the new owner and then applies as the taker's request (12a review M-4)", async () => {
    const w = world();
    const id = await w.waiting(1);
    let flipped = false;
    const racing = { ...w.deps, documentClient: { async send(command: unknown) {
      if (!flipped && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { flipped = true; w.task(taken(CARA, "Cara")); }
      return w.db.send(command as never);
    } } };
    expect(await decideApproval(racing, w.caller(BOB), id, { requestId: REQ(911), decision: "APPROVE" })).toEqual({ status: "APPROVED_DONE" });
    expect(flipped).toBe(true);
    expect(w.vendor.state.vendorCalls[0]).toMatchObject({ requestedBy: CARA });
  });

  it("answers a retryable code, not a refusal, when the task can't be read while judging who may decide, and decides nothing (12a review M-5)", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk?: string } | undefined)?.pk === `DEVTASK#${TASK}`, error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    expect(await code(w.approve(ALICE, id))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await w.write(id)).status).toBe("PENDING");
    // The read comes back: the same person decides, and it runs once.
    expect(await w.approve(ALICE, id)).toEqual({ status: "APPROVED_DONE" });
    expect(w.vendor.state.vendorCalls).toHaveLength(1);
  });

  it("gives up after a few owner changes in a row, with a retryable fault, leaving the approval pending", async () => {
    const w = world();
    const id = await w.waiting(1);
    let flips = 0;
    const racing = { ...w.deps, documentClient: { async send(command: unknown) {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { flips += 1; w.task(taken(flips % 2 === 0 ? CARA : DANA, "Someone")); }
      return w.db.send(command as never);
    } } };
    expect(await code(decideApproval(racing, w.caller(BOB), id, { requestId: REQ(912), decision: "APPROVE" }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(flips).toBe(4);
    expect((await w.write(id)).status).toBe("PENDING");
  });

  it("a task whose taker can't be read decides nothing: nobody may decide, the creator who handed it over is not named, and nothing runs", async () => {
    const w = world();
    const id = await w.waiting(1);
    w.task({ currentOwner: { developerId: CARA } });
    for (const who of [ALICE, BOB]) {
      expect(await code(w.approve(who, id))).toEqual({ code: "FORBIDDEN", message: "Only the task owner or a project maintainer can decide this." });
    }
    expect((await w.write(id)).status).toBe("PENDING");
    expect(w.vendor.state.vendorCalls).toEqual([]);
  });
});

describe("S3 (L3): a run owner whose name is only an address", () => {
  it("is named by their placeholder, not \"[email removed]\", in the stored approval, the timeline event and the waiting answer", async () => {
    const w = world();
    const address = `alice${String.fromCharCode(64)}example.test`;
    const decision = await decideWrite(w.deps, w.input({ run: { project: "web", owner: { developerId: ALICE, name: address } } }));
    expect(decision).toMatchObject({ outcome: "wait" });
    const placeholder = placeholderDisplayName(ALICE);
    const record = await w.write((decision as { approvalId: string }).approvalId);
    expect(record.owner.name).toBe(placeholder);
    const [event] = w.events() as Array<{ text: string }>;
    expect(event!.text).toContain(`approval from ${placeholder} or a project maintainer`);
    expect(event!.text).not.toContain("[email removed]");
    expect(JSON.stringify(decision)).toContain(placeholder);
    expect(JSON.stringify(decision)).not.toContain("[email removed]");
  });
});

describe("S3 (H3): the write's event on the task's timeline", () => {
  it("carries no address from the call's values, while the stored approval keeps the exact summary the approver is shown", async () => {
    const w = world();
    const to = `omar${String.fromCharCode(64)}example.test`;
    const args = { id: "ENG-12", comment: `Please tell ${to} about it` };
    const decision = await decideWrite(w.deps, w.input({ call: { scope: "eng", schemaHash: SCHEMA, arguments: args } }));
    const approvalId = (decision as { approvalId: string }).approvalId;
    const record = await w.write(approvalId);
    expect(record.summary).toContain(to);
    const [event] = w.events() as Array<{ text: string }>;
    expect(event!.text).not.toContain(to);
    expect(event!.text).toContain("[email removed]");
  });
});
