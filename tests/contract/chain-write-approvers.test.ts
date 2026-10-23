// Plan 4 Task 8 (R64, R68, the human's rule, Decisions item 7): a write an agent makes in an autonomous run of a project-owned chain waits for the person who owns
// the trigger now, or for anyone who holds `approve_writes` on the project now. Who that is is read when someone decides, never stored: the rule `chain_autonomous_writer`
// follows the trigger's CURRENT `createdBy`, where Plan 3's `write_approver` follows the run's fixed owner. A run selects it through Plan 3's selector registry, and
// a selector that fails never leaves a write without approvers. Plan 3's behaviour (one decided approval runs once; the argument hash and the re-checks) is unchanged.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrantedTool, OrgId, ToolFacts } from "@agentx/contracts";
import { projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { approvalsWriteGate, registerWriteApproverSelector, type AgentWriteGateInput } from "../../packages/broker/src/agents/agent-tools-routes.js";
import { approvalTaskEventKey, getApproverRule, type WriteApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { WRITE_APPROVER_RULE, writeApproversFor, type ApprovedCall } from "../../packages/broker/src/agents/write-gate.js";
import { memoryRunCache } from "../../packages/broker/src/agents/run-cache.js";
import type { ClassifyAgentWriteDependencies } from "../../packages/broker/src/agents/write-class.js";
import { registerChainRunner } from "../../packages/broker/src/chains/index.js";
import type { ChainDefinitionInput } from "../../packages/contracts/src/chains.js";
import { ARJUN, CARL, CELL, DANA, MAX, ORG_A, PRIYA, VIV, callerOf, disposeGateWorlds, setupGateWorld, type GateWorld } from "../support/chain-gate-world.js";

const runner = () => import("../../packages/broker/src/chains/runner.js");
const writers = () => import("../../packages/broker/src/chains/write-approvers.js");

afterEach(() => { disposeGateWorlds(); vi.useRealTimers(); });

const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const TRIGGER_ID = "ctr_aaaaaaaaaaaaaaaaaaaa";
const OTHER_TRIGGER_ID = "ctr_bbbbbbbbbbbbbbbbbbbb";
const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
const CONNECTION = "con_aaaaaaaaaaaaaaaaaaaa";
const SCHEMA = "a".repeat(64);
const WRITER_RULE = "chain_autonomous_writer";
const facts: ToolFacts = { connector: "linear", upstreamName: "save_issue", access: "write", itemArguments: ["id"] };
const SAVE_ISSUE: GrantedTool = { connector: "linear", type: "linear", upstreamName: "save_issue", presentedName: "linear__save_issue", access: "write", facts };

const ONE_STEP: ChainDefinitionInput = {
  start: "look", limits: { maxRunUsd: 30 },
  steps: [{ kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }],
};
const PROJECT_OWNED = { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } } as const;
const EVENT = (triggerId = TRIGGER_ID) => ({ kind: "event", triggerId, eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", title: "Refund errors" });
const SCHEDULE = (triggerId = TRIGGER_ID) => ({ kind: "schedule", triggerId, scheduledAt: "2026-10-22T09:00:00.000Z" });

/** The chain world with Plan 3's write gate over a project that has a Linear connector, and a store of triggers the way Task 18's will answer. */
function setup() {
  const w = setupGateWorld();
  const triggers = new Map<string, { createdBy: string }>([[TRIGGER_ID, { createdBy: PRIYA }]]);
  const vendor = { runs: 0, calls: [] as ApprovedCall[] };
  w.db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: DANA });
  w.db.set({
    ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: { deploymentMode: "ec2-ebs" },
    definition: {
      name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [{ cwd: "repo/web", executable: "npm", args: ["ci"], timeoutSeconds: 900 }], readiness: [{ cwd: "repo/web", executable: "npm", args: ["test"], timeoutSeconds: 900 }], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [{ name: "linear", type: "linear", credentialRef: CONNECTION, scopes: [{ alias: "eng", teamId: TEAM }], tools: [{ name: "save_issue", access: "write" }] }] },
    },
  });
  Object.assign(w.deps, {
    triggers: { get: async (orgId: OrgId, triggerId: string) => (orgId === ORG_A ? triggers.get(triggerId) : undefined) },
    writeGate: {
      classify: { documentClient: w.db, tableName: "T", now: () => w.clock.now, labelListers: {}, runCache: () => memoryRunCache() } as unknown as ClassifyAgentWriteDependencies,
      runConnector: async (call: ApprovedCall) => { vendor.runs += 1; vendor.calls.push(call); return { requestId: call.request.requestId, status: "SUCCEEDED" as const, text: JSON.stringify({ id: "CHA-9" }), truncated: false, replayed: false }; },
      regrant: async () => ({ tool: SAVE_ISSUE, classify: { rules: { alwaysAsk: [] }, autonomy: "run" as const, allowMentions: false } }),
      recordedResult: async () => undefined,
      requireRunAuthority: async () => undefined,
    },
  });
  const startAsSystem = async (chainId: string, startedBy: unknown, owner: string = PRIYA) => {
    const { startChainRun } = await runner();
    const kind = (startedBy as { kind: "event" | "schedule" }).kind;
    return startChainRun(w.deps, { system: kind, owner: { developerId: owner } }, {
      orgId: ORG_A, chainId, project: "web", origin: kind, startedBy, requestId: randomUUID(),
      ...(kind === "event" ? { trigger: { eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", subject: { kind: "alert", title: "Refund errors" } } } : {}),
    } as never);
  };
  /** The task of the run's latest step, patched to look like a started workspace task. */
  const taskOfRun = (runId: string) => {
    const taskId = w.attempts(runId).at(-1)!.taskId!;
    const item = w.db.find((entry) => entry.entityType === "DEVELOPER_TASK" && entry.taskId === taskId)[0]!;
    w.db.set({ ...item, developerName: "Priya", provider: "oidc", workspaceId: `ws-${taskId}`, ownerKey: "owner-key-priya", createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z" });
    return { taskId, chain: w.taskOf(taskId).request.chain, ownerId: w.taskOf(taskId).request.owner.developerId };
  };
  let counter = 0;
  /** What the agent-tools route hands the write gate for a Linear write by this task's step. */
  const gateInput = (task: { taskId: string; chain: { chainRunId: string; stepId: string } | undefined; ownerId: string }, over: Partial<AgentWriteGateInput> = {}): AgentWriteGateInput => {
    counter += 1;
    return {
      orgId: ORG_A, taskId: task.taskId, operationId: `op-${String(counter)}`, project: "web", agent: { id: "root-cause-analyst", name: "Root-cause analyst" }, stepId: "work",
      owner: { developerId: task.ownerId, name: "Priya" }, requestId: randomUUID(), connector: "linear", scope: "eng", schemaHash: SCHEMA, tool: SAVE_ISSUE, args: { id: `ENG-${String(counter)}`, stateId: "s1" },
      strippedMentions: [], recipe: { autonomy: "run", approvals: { alwaysAsk: [] }, allowMentions: false },
      classifyInput: { projectPolicy: undefined, guardrails: undefined } as never,
      classify: async () => ({ class: "consequential", reason: "a change", ignoredRules: [] }),
      ...(task.chain === undefined ? {} : { chain: task.chain }),
      ...over,
    } as AgentWriteGateInput;
  };
  const ask = async (input: AgentWriteGateInput) => {
    const decision = await approvalsWriteGate(w.deps)(input);
    if (decision.decision !== "wait" || decision.approvalId === undefined) throw new Error(`expected a wait, got ${JSON.stringify(decision)}`);
    return (await w.approval(decision.approvalId)) as WriteApprovalRecord;
  };
  /** An event-started run of a project-owned chain, and an approval for a write its step makes. */
  const autonomousWrite = async (startedBy: unknown = EVENT()) => {
    const chain = await w.publish(ONE_STEP, PROJECT_OWNED);
    const run = await startAsSystem(chain.chainId, startedBy);
    const task = taskOfRun(run.runId);
    const record = await ask(gateInput(task));
    return { chain, run, task, record, approvalId: record.approvalId };
  };
  const confirmLink = (who: string, approvalId: string) => w.route(callerOf(who), "POST", `/v1/app/approvals/${approvalId}/confirm-link`, {}).then((value) => value, (error: { code: string }) => ({ code: error.code }));
  const tickets = () => w.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"));
  return { ...w, triggers, vendor, startAsSystem, taskOfRun, gateInput, ask, autonomousWrite, confirmLink, tickets };
}
type World = ReturnType<typeof setup>;

// ---- what a run selects

describe("selecting the rule", () => {
  it("stores `chain_autonomous_writer` with the creator and every approve_writes holder as candidates, for an event-started step of a project-owned chain", async () => {
    const w = setup();
    const { record } = await w.autonomousWrite();
    expect(record.approvers).toEqual({ kind: "rule", rule: WRITER_RULE, candidates: [PRIYA, DANA, MAX] });
    expect(record.approvers).toMatchObject({ candidates: await writeApproversFor(w.deps, { orgId: ORG_A, project: "web", owner: { developerId: PRIYA } }) });
    expect(record).toMatchObject({ kind: "write", status: "PENDING", owner: { developerId: PRIYA, name: "Priya" } });
  });

  it("does the same for a schedule-started run", async () => {
    const w = setup();
    const { record } = await w.autonomousWrite(SCHEDULE());
    expect(record.approvers).toEqual({ kind: "rule", rule: WRITER_RULE, candidates: [PRIYA, DANA, MAX] });
  });

  it("leaves a person-started run to Plan 3's `write_approver`, by value", async () => {
    const w = setup();
    const chain = await w.publish(ONE_STEP, PROJECT_OWNED);
    const run = await w.start(chain.chainId, CARL);
    const task = w.taskOfRun(run.runId);
    const record = await w.ask(w.gateInput(task));
    expect(record.approvers).toEqual({ kind: "rule", rule: WRITE_APPROVER_RULE, candidates: await writeApproversFor(w.deps, { orgId: ORG_A, project: "web", owner: { developerId: CARL } }) });
  });

  it("leaves a member-owned chain's event-started run to `write_approver` (its owner is the member), by value", async () => {
    const w = setup();
    const chain = await w.publish(ONE_STEP);
    const run = await w.startAsSystem(chain.chainId, EVENT());
    const record = await w.ask(w.gateInput(w.taskOfRun(run.runId)));
    expect(record.approvers).toEqual({ kind: "rule", rule: WRITE_APPROVER_RULE, candidates: await writeApproversFor(w.deps, { orgId: ORG_A, project: "web", owner: { developerId: PRIYA } }) });
  });

  it("leaves a plain agent run, which has no chain, to `write_approver`", async () => {
    const w = setup();
    const record = await w.ask(w.gateInput({ taskId: "plain-task-1", chain: undefined, ownerId: PRIYA }));
    expect(record.approvers).toMatchObject({ kind: "rule", rule: WRITE_APPROVER_RULE });
  });

  it("answers only when all three hold: a chain run that is missing leaves the default", async () => {
    const w = setup();
    const { chainWriteApprovers } = await writers();
    const task = { taskId: "task-x", chain: { chainRunId: "crn_aaaaaaaaaaaaaaaaaaaa", stepId: "look" } };
    expect(await chainWriteApprovers(w.deps, task, { orgId: ORG_A, project: "web", owner: { developerId: PRIYA, name: "Priya" } })).toBeUndefined();
    expect(await chainWriteApprovers(w.deps, { taskId: "t" }, { orgId: ORG_A, project: "web", owner: { developerId: PRIYA, name: "Priya" } })).toBeUndefined();
  });

  it("names the creator in the approval's task event (the run's owner when it started)", async () => {
    const w = setup();
    const { task, approvalId } = await w.autonomousWrite();
    const item = w.db.get(approvalTaskEventKey(task.taskId, (await w.approval(approvalId)).createdAt, approvalId));
    expect(item).toMatchObject({ text: expect.stringContaining("This needs approval from Priya or a project maintainer.") as string });
  });
});

// ---- who may decide it now

describe("who may decide an autonomous write, read when they decide (R68, N5)", () => {
  const pageDecide = async (w: World, who: string, approvalId: string) => (await w.decideAs(who, approvalId)).statusCode;

  it("lets the trigger's creator decide while they hold start_tasks, and a maintainer, and refuses a contributor who is not the creator", async () => {
    const w = setup();
    const a = await w.autonomousWrite();
    expect(await pageDecide(w, PRIYA, a.approvalId)).toBe(200);
    expect(w.vendor.runs).toBe(1);
    const b = await w.ask(w.gateInput(a.task));
    expect(await pageDecide(w, CARL, b.approvalId)).toBe(403);
    expect(await refusal(w.decideRoute(CARL, b.approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await pageDecide(w, MAX, b.approvalId)).toBe(200);
    expect(w.vendor.runs).toBe(2);
    const c = await w.ask(w.gateInput(a.task));
    expect(await pageDecide(w, DANA, c.approvalId)).toBe(200);
  });

  it("gets a maintainer added after the approval was created a ticket, and they decide it on the page", async () => {
    const w = setup();
    const { approvalId } = await w.autonomousWrite();
    expect((await w.approval(approvalId) as WriteApprovalRecord).approvers).toMatchObject({ candidates: expect.not.arrayContaining([ARJUN]) as string[] });
    w.projectMembers.grant(ORG_A, "web", ARJUN, "maintainer");
    const asked = await w.confirmLink(ARJUN, approvalId);
    expect(asked).toMatchObject({ ticketed: true, confirmUrl: expect.stringContaining(`${CELL}/v1/app/approve/${approvalId}?ticket=`) as string });
    expect(await pageDecide(w, ARJUN, approvalId)).toBe(200);
    expect(w.vendor.runs).toBe(1);
  });

  it("refuses a maintainer demoted to contributor after, and a maintainer removed from the project: no ticket, 403 on the page, nothing runs", async () => {
    const w = setup();
    const { approvalId } = await w.autonomousWrite();
    w.projectMembers.grant(ORG_A, "web", MAX, "contributor");
    expect(await pageDecide(w, MAX, approvalId)).toBe(403);
    expect(await refusal(w.decideRoute(MAX, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await w.confirmLink(MAX, approvalId)).not.toMatchObject({ ticketed: true });
    w.projectMembers.revoke(ORG_A, "web", MAX);
    expect(await pageDecide(w, MAX, approvalId)).toBe(403);
    expect(await refusal(w.decideRoute(MAX, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(w.tickets()).toEqual([]);
    expect(w.vendor.runs).toBe(0);
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
  });

  it("refuses the trigger's creator once they have left the organization", async () => {
    const w = setup();
    const { approvalId } = await w.autonomousWrite();
    w.db.find((item) => item.entityType === "ORG_MEMBER" && item.developerId === PRIYA).forEach((item) => w.db.delete(String(item.pk), String(item.sk)));
    expect([403, 404]).toContain(await pageDecide(w, PRIYA, approvalId));
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) as string });
    expect((await w.confirmLink(PRIYA, approvalId))).not.toMatchObject({ ticketed: true });
    expect(w.vendor.runs).toBe(0);
  });

  it("refuses the creator demoted to viewer (no start_tasks) unless they are still a maintainer", async () => {
    const w = setup();
    const { approvalId } = await w.autonomousWrite();
    w.projectMembers.grant(ORG_A, "web", PRIYA, "viewer");
    expect(await pageDecide(w, PRIYA, approvalId)).toBe(403);
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await w.confirmLink(PRIYA, approvalId)).not.toMatchObject({ ticketed: true });
    w.projectMembers.grant(ORG_A, "web", PRIYA, "maintainer");
    expect(await pageDecide(w, PRIYA, approvalId)).toBe(200);
  });

  it("follows the trigger when its createdBy is moved: the new creator gets a ticket and decides an approval made before the move; the old one is refused", async () => {
    const w = setup();
    const { approvalId } = await w.autonomousWrite();
    w.projectMembers.grant(ORG_A, "web", ARJUN, "contributor");
    w.triggers.set(TRIGGER_ID, { createdBy: ARJUN });
    expect((await w.approval(approvalId) as WriteApprovalRecord).approvers).toMatchObject({ candidates: expect.not.arrayContaining([ARJUN]) as string[] });
    expect(await w.confirmLink(PRIYA, approvalId)).not.toMatchObject({ ticketed: true });
    expect(await pageDecide(w, PRIYA, approvalId)).toBe(403);
    expect(await w.confirmLink(ARJUN, approvalId)).toMatchObject({ ticketed: true });
    expect(await pageDecide(w, ARJUN, approvalId)).toBe(200);
    expect(w.vendor.runs).toBe(1);
  });

  it("makes (a) false and keeps (b) when the trigger, the run or the task is missing", async () => {
    const w = setup();
    const { approvalId, run } = await w.autonomousWrite();
    w.triggers.delete(TRIGGER_ID);
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    // The run is gone: still no creator, and a maintainer still decides.
    const meta = w.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === run.runId)[0]!;
    w.db.delete(String(meta.pk), String(meta.sk));
    expect(await refusal(w.decideRoute(CARL, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await pageDecide(w, MAX, approvalId)).toBe(200);
  });

  it("makes (a) false for a run an event did not start: a person-started run's task never reaches the creator", async () => {
    const w = setup();
    const { chain, task } = await w.autonomousWrite();
    // The same rule on an approval of a person-started run: the trigger's creator is no one's creator here.
    const person = await w.start(chain.chainId, CARL);
    const personTask = w.taskOfRun(person.runId);
    const { writerEligible } = await writers();
    const forced = await w.ask(w.gateInput(personTask));
    const record = { ...forced, approvers: { kind: "rule" as const, rule: WRITER_RULE, candidates: [] } };
    expect(await writerEligible(w.deps, record, callerOf(PRIYA))).toBe(false);
    expect(await writerEligible(w.deps, record, callerOf(MAX))).toBe(true);
    void task;
  });

  it("refuses a caller from another organization and a record that is not a write", async () => {
    const w = setup();
    const { record } = await w.autonomousWrite();
    const { writerEligible } = await writers();
    expect(await writerEligible(w.deps, record, callerOf(PRIYA, "org_bbbbbbbbbbbbbbbbbbbb" as OrgId))).toBe(false);
    const step = (await w.runAtGate()).approvalId;
    expect(await writerEligible(w.deps, await w.approval(step), callerOf(MAX))).toBe(false);
  });

  it("reads every answer live: nothing is cached between two decisions", async () => {
    const w = setup();
    const a = await w.autonomousWrite();
    const b = await w.ask(w.gateInput(a.task));
    w.projectMembers.grant(ORG_A, "web", VIV, "maintainer");
    expect(await pageDecide(w, VIV, a.approvalId)).toBe(200);
    w.projectMembers.grant(ORG_A, "web", VIV, "viewer");
    expect(await pageDecide(w, VIV, b.approvalId)).toBe(403);
  });
});

describe("Plan 3's behaviour is unchanged", () => {
  it("runs a decided approval once: a second decision gets APPROVAL_CLOSED and the vendor is called once, with the stored arguments", async () => {
    const w = setup();
    const { approvalId, record } = await w.autonomousWrite();
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
    expect(await refusal(w.decideRoute(MAX, approvalId))).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(w.vendor.runs).toBe(1);
    expect(w.vendor.calls[0]!.request.arguments).toEqual(record.arguments);
    expect(await w.approval(approvalId)).toMatchObject({ status: "APPROVED_DONE", decidedBy: PRIYA, argumentsHash: record.argumentsHash });
  });

  it("makes one approval for one call: the same call asked again answers the first", async () => {
    const w = setup();
    const { task, record } = await w.autonomousWrite();
    const again = await approvalsWriteGate(w.deps)(w.gateInput(task, { operationId: record.operationId, args: record.arguments }));
    expect(again).toMatchObject({ decision: "wait", approvalId: record.approvalId });
  });
});

// ---- a selector that fails never leaves a write without approvers

describe("selectors (M3)", () => {
  const input = (w: World, task: ReturnType<World["taskOfRun"]>) => w.gateInput(task);
  const defaultSpec = async (w: World) => ({ kind: "rule", rule: WRITE_APPROVER_RULE, candidates: await writeApproversFor(w.deps, { orgId: ORG_A, project: "web", owner: { developerId: PRIYA } }) });
  const running = async (w: World) => {
    const chain = await w.publish(ONE_STEP, PROJECT_OWNED);
    return w.taskOfRun((await w.startAsSystem(chain.chainId, EVENT())).runId);
  };

  it("lets the first selector that answers with a rule win: a later one can't override it", async () => {
    const w = setup();
    const task = await running(w);
    const off = registerWriteApproverSelector(async () => ({ kind: "rule", rule: WRITE_APPROVER_RULE, candidates: [CARL] }));
    const record = await w.ask(input(w, task));
    off();
    // The chain selector registered first (at broker start), so it answered.
    expect(record.approvers).toMatchObject({ kind: "rule", rule: WRITER_RULE });
  });

  it("asks selectors in registration order with the task and the run", async () => {
    const w = setup();
    const task = await running(w);
    const seen: unknown[] = [];
    const first = registerWriteApproverSelector(async (_deps, selected, run) => { seen.push(["first", selected.taskId, selected.chain?.chainRunId, run]); return undefined; });
    const second = registerWriteApproverSelector(async () => { seen.push(["second"]); return undefined; });
    await w.ask(input(w, task));
    first(); second();
    expect(seen).toEqual([["first", task.taskId, task.chain!.chainRunId, { orgId: ORG_A, project: "web", owner: { developerId: PRIYA, name: "Priya" } }], ["second"]]);
  });

  it("falls back to `write_approver` with the default candidates when a selector throws, logs it with the task id, and the write still waits", async () => {
    const w = setup();
    const task = await running(w);
    // The failing selector comes first: take the chain selector off, put the failing one in front of it again.
    disposeGateWorlds();
    const offFailing = registerWriteApproverSelector(async () => { throw new Error("the lookup broke"); });
    const offChain = registerChainRunner(() => w.deps);
    const record = await w.ask(input(w, task));
    offFailing(); offChain();
    expect(record.approvers).toEqual(await defaultSpec(w));
    expect(record.status).toBe("PENDING");
    expect(w.logs.filter((line) => line.event === "write_approver_selector.failed")).toMatchObject([{ fields: { taskId: task.taskId } }]);
  });

  it("falls back the same way when a selector answers `{ kind: \"ids\", ids: [] }` or anything that is not a rule", async () => {
    for (const answer of [{ kind: "ids", ids: [] }, { kind: "ids", ids: [CARL] }, "yes", { kind: "rule", rule: 7, candidates: [] }, { kind: "rule", rule: WRITER_RULE, candidates: "all" }, null] as unknown[]) {
      const w = setup();
      const task = await running(w);
      disposeGateWorlds();
      const offBad = registerWriteApproverSelector((async () => answer) as never);
      const offChain = registerChainRunner(() => w.deps);
      const record = await w.ask(input(w, task));
      offBad(); offChain();
      expect(record.approvers, JSON.stringify(answer)).toEqual(await defaultSpec(w));
      expect(w.logs.filter((line) => line.event === "write_approver_selector.failed"), JSON.stringify(answer)).toHaveLength(1);
    }
  });

  it("gives up on a selector that takes more than a second, with the same fallback", async () => {
    const w = setup();
    const task = await running(w);
    disposeGateWorlds();
    const offSlow = registerWriteApproverSelector(() => new Promise(() => undefined));
    const offChain = registerChainRunner(() => w.deps);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const asked = w.ask(input(w, task));
    await vi.advanceTimersByTimeAsync(999);
    expect(w.logs.filter((line) => line.event === "write_approver_selector.failed")).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    const record = await asked;
    offSlow(); offChain();
    expect(record.approvers).toEqual(await defaultSpec(w));
    expect(w.logs.filter((line) => line.event === "write_approver_selector.failed")).toMatchObject([{ fields: { taskId: task.taskId } }]);
  });

  it("never falls back to no approver: a selector that names a rule nobody registered makes Plan 3 refuse the write", async () => {
    const w = setup();
    const task = await running(w);
    disposeGateWorlds();
    const off = registerWriteApproverSelector(async () => ({ kind: "rule", rule: "nobody_registered_this", candidates: [PRIYA] }));
    await expect(approvalsWriteGate(w.deps)(input(w, task))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    off();
    expect(w.db.find((item) => item.entityType === "APPROVAL" && item.kind === "write")).toEqual([]);
  });

  it("stops asking a selector once it is unregistered", async () => {
    const w = setup();
    const task = await running(w);
    disposeGateWorlds();
    let asked = 0;
    const off = registerWriteApproverSelector(async () => { asked += 1; return undefined; });
    off();
    const record = await w.ask(input(w, task));
    expect(asked).toBe(0);
    expect(record.approvers).toEqual(await defaultSpec(w));
    expect(w.logs.filter((line) => line.event === "write_approver_selector.failed")).toEqual([]);
  });
});

describe("registration at broker start", () => {
  it("registers the rule and the selector together, so the selector can never name a rule nobody registered", async () => {
    const w = setup();
    disposeGateWorlds();
    const off = registerChainRunner(() => w.deps);
    expect(getApproverRule(WRITER_RULE)).toBeTypeOf("function");
    expect(getApproverRule("chain_gate")).toBeTypeOf("function");
    const { record } = await w.autonomousWrite();
    expect(record.approvers).toMatchObject({ kind: "rule", rule: WRITER_RULE });
    expect(getApproverRule((record.approvers as { rule: string }).rule)).toBeTypeOf("function");
    off();
  });

  it("takes the selector off again when the runner is unregistered: the write then waits on Plan 3's default", async () => {
    const w = setup();
    const chain = await w.publish(ONE_STEP, PROJECT_OWNED);
    const task = w.taskOfRun((await w.startAsSystem(chain.chainId, EVENT())).runId);
    disposeGateWorlds();
    const record = await w.ask(w.gateInput(task));
    expect(record.approvers).toMatchObject({ kind: "rule", rule: WRITE_APPROVER_RULE });
  });
});

void OTHER_TRIGGER_ID;
