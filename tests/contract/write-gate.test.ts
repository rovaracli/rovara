// Plan 3 Task 21: write approvals and safe execution. A consequential call of an agent waits as one APPROVAL# record; a person who may decide it
// approves it on the confirmation page (Task 21a), and Rovara re-checks everything against live data, then runs exactly the stored arguments once
// through the connector call path (injected here as a fake with the ledger's replay), or ends the record `APPROVED_FAILED` with the reason.
// These tests call the functions directly; the decide routes are Task 21a's wiring (the route tests here use a stub of its guard).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agentXError, approvalKey, approverIndexKey, orgMemberKey, orgProjectCatalogKey, orgRemovedKey, projectMetaKey, projectRevisionKey,
  type ActionPolicy, type ConnectorResult, type GrantedTool, type OrgId, type OrgRole, type ToolFacts,
} from "@agentx/contracts";
import { describeAction } from "../../packages/contracts/src/action-class.js";
import type { AgentCaller } from "../../packages/broker/src/agents/access.js";
import {
  createStepApproval, decideApproval, expireApprovals, getAnyApproval, listApprovalsFor, registerApprovalSubjectHandler, registerApproverRule,
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
  const state = { vendorCalls: [] as ApprovedCall[], runs: 0, crashesAfterVendor: 0, neverFinishes: false, answer: undefined as undefined | Partial<ConnectorResult> };
  const run = async (call: ApprovedCall): Promise<ConnectorResult> => {
    state.runs += 1;
    const requestId = call.request.requestId;
    const recorded = ledger.get(requestId);
    if (recorded !== undefined) return { ...recorded, replayed: true };
    if (state.neverFinishes) { state.vendorCalls.push(call); throw new Error("the process died"); }
    state.vendorCalls.push(call);
    const result: ConnectorResult = { requestId, status: "SUCCEEDED", text: JSON.stringify({ id: "CHA-9", title: "made" }), truncated: false, replayed: false, ...state.answer };
    ledger.set(requestId, result);
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
    orgId: ORG_A, taskId: TASK, operationId: OPERATION, stepId: "work", agentName: "Triage bot", tool: SAVE_ISSUE,
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
  const record = async (approvalId: string): Promise<AnyApprovalRecord> => (await getAnyApproval(deps, ORG_A, approvalId as never))!;
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
    const approvers = (record.approvers as { candidates: string[] }).candidates;
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
    expect((await w.ask(11, { stepId: "other" })).outcome).toBe("wait");
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
    const first = deriveWriteRequestId("apr_aaaaaaaaaaaaaaaaaaaa" as never);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deriveWriteRequestId("apr_aaaaaaaaaaaaaaaaaaaa" as never)).toBe(first);
    expect(deriveWriteRequestId("apr_bbbbbbbbbbbbbbbbbbbb" as never)).not.toBe(first);
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
    const record = await failedWith(w);
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
    expect(w.vendor.state.runs).toBe(2);
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
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      w.clock.now += 6 * MINUTE;
      await w.sweep();
      expect(await w.record(id), `attempt ${String(attempt)}`).toMatchObject({ attempts: attempt });
    }
    w.clock.now += 6 * MINUTE;
    await w.sweep();
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_FAILED", failure: "Rovara couldn't confirm that this ran. Check linear before asking again." });
    expect(w.handled).toEqual([{ kind: "write", status: "APPROVED_FAILED", approvalId: id }]);
    expect(w.vendor.state.runs).toBe(5);
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
    const stored = w.db.get(approvalKey(ORG_A, id as never))!;
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
      orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go on?", approvers: { kind: "ids", ids: [OLD_ALICE] }, project: "web",
    });
    expect((await decideApproval(w.deps, w.caller(ALICE), step.approvalId, { requestId: REQ(8), decision: "APPROVE" })).status).toBe("APPROVED");
  });

  it("moves the duplicate to the survivor in the approvers, the candidates, the index items and the run owner of pending approvals, repeatably", async () => {
    const w = world();
    const write = await w.waiting(1, { run: { project: "web", owner: { developerId: OLD_ALICE, name: "Alice" } }, approvers: { kind: "rule", rule: "write_approver", candidates: [OLD_ALICE, BOB] } });
    registerApproverRule("t_rule", async () => true);
    const step = await createStepApproval(w.deps, { orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go?", approvers: { kind: "ids", ids: [OLD_ALICE, CARA] } });
    w.db.set({ pk: `DEVELOPER#${OLD_ALICE}`, sk: "META", developerId: OLD_ALICE, mergedInto: ALICE });
    w.db.delete(orgMemberKey(ORG_A, OLD_ALICE));
    const lifecycle = { ...w.deps, log: w.deps.log! };
    await onMembersMerged(lifecycle, { orgId: ORG_A, survivorId: ALICE, duplicateId: OLD_ALICE });
    const moved = await w.write(write);
    expect(moved.owner.developerId).toBe(ALICE);
    expect((moved.approvers as { candidates: string[] }).candidates.sort()).toEqual([ALICE, BOB].sort());
    expect(w.db.get(approverIndexKey(ORG_A, OLD_ALICE, write as never))).toBeUndefined();
    expect(w.db.get(approverIndexKey(ORG_A, ALICE, write as never))).toBeDefined();
    const movedStep = (await w.record(step.approvalId)) as StepApprovalRecord;
    expect((movedStep.approvers as { ids: string[] }).ids.sort()).toEqual([ALICE, CARA].sort());
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
    expect((moved.approvers as { candidates: string[] }).candidates).not.toContain(BOB);
    expect(w.db.get(approverIndexKey(ORG_A, BOB, id as never))).toBeUndefined();
    const owned = world();
    const mine = await owned.waiting(1);
    owned.db.set({ ...orgMemberKey(ORG_A, DANA), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: DANA, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    owned.db.delete(orgMemberKey(ORG_A, ALICE));
    await onMemberRemoved({ ...owned.deps, log: owned.deps.log! }, { orgId: ORG_A, developerId: ALICE, by: DANA });
    expect((await owned.write(mine)).owner.developerId).toBe(DANA);
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
    w.runtime.requireDecide = async (_request, approvalId) => {
      if (approvalId !== id) throw agentXError("NOT_FOUND", "approval not found");
      return { orgId: ORG_A, developerId: BOB, proof: { kind: "none" } as never, finish: async () => { finished += 1; } };
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
