import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 8: gates. A chain gate is a Plan 3 approval record (`chain_gate`), opened with the attempt that waits on it and decided only on Plan 3's confirmation page
// (R66): a browser session whose interactive sign-in is at most 10 minutes old, for someone one of the gate's rules matches AT THE MOMENT THEY DECIDE (R68). The run
// moves only through `onChainGateDecided`, once, with the decision and its event in one transaction; nothing in a report, a branch, an event or a trigger can pass a gate.
// Task 6's and Task 7's guarantees hold on every path here: one end, one next step, gapless events, a state change and its event are one transaction.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStepApproval, expireApprovals, registerApprovalSubjectHandler, registerApproverRule } from "../../packages/broker/src/agents/approvals.js";
import { registerChainRunner } from "../../packages/broker/src/chains/index.js";
import { ChainStore } from "../../packages/broker/src/chains/store.js";
import { projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { GATE_DEFAULT_TIMEOUT_HOURS, type ChainDefinitionInput } from "../../packages/contracts/src/chains.js";
import { openChainRunKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { createAgentXMcpServer, type ControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { agentXError } from "@agentx/contracts";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { ARJUN, CARL, CELL, DANA, MAX, ORG_A, PRIYA, STRANGER, VIV, callerOf, disposeGateWorlds, setupGateWorld, type GateWorld } from "../support/chain-gate-world.js";

const gates = () => import("../../packages/broker/src/chains/gates.js");
const runner = () => import("../../packages/broker/src/chains/runner.js");

afterEach(() => disposeGateWorlds());

/** What a refused call said: its code and its words without the code. */
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const HOUR = 3_600_000;
const FORBIDDEN_TEXT = 'Only the person who started this run or a maintainer of web can approve "Approve the fix".';
const confirmUrl = (approvalId: string) => `${CELL}/v1/app/approve/${approvalId}`;
const TRIGGER_ID = "ctr_aaaaaaaaaaaaaaaaaaaa";
const EVENT_STARTED = { kind: "event", triggerId: TRIGGER_ID, eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", title: "Refund errors" };

type Step = ChainDefinitionInput["steps"][number];
const agentStep = (id: string, name: string, agentId: string, next: unknown): Step => ({ kind: "agent", id, name, agent: { agentId, version: "current" }, next }) as Step;
/** look -> a gate with `approvers` -> act. */
const gated = (approvers: unknown[], extra: Record<string, unknown> = {}): ChainDefinitionInput => ({
  start: "look", limits: { maxRunUsd: 30 },
  steps: [
    agentStep("look", "Look into it", "root-cause-analyst", { kind: "go", to: "approve" }),
    { kind: "gate", id: "approve", name: "Approve it", prompt: "Go ahead?", approvers, onApprove: { to: "act" }, onReject: { to: "$end" }, ...extra } as Step,
    agentStep("act", "Act on it", "code-reviewer", { kind: "end" }),
  ],
});
/** A design that loops: look -> gate -> (sent back) look again, at most `bound` times. */
const looping = (bound: number): ChainDefinitionInput => ({
  start: "look", limits: { maxRunUsd: 30 },
  steps: [
    agentStep("look", "Look into it", "root-cause-analyst", { kind: "go", to: "approve" }),
    { kind: "gate", id: "approve", name: "Approve it", prompt: "Go ahead?", approvers: [{ kind: "starter" }, { kind: "project_maintainers" }], onApprove: { to: "$end" }, onReject: { to: "look", maxTraversals: bound } },
  ],
});
const startAsEvent = async (w: GateWorld, chainId: string, owner: string = PRIYA) => {
  const { startChainRun } = await runner();
  return startChainRun(w.deps, { system: "event", owner: { developerId: owner } }, {
    orgId: ORG_A, chainId, project: "web", origin: "event", startedBy: EVENT_STARTED, trigger: { eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", subject: { kind: "alert", title: "Refund errors" } }, requestId: randomUUID(),
  } as never);
};
const waitingGate = (w: GateWorld, runId: string) => w.attempts(runId).filter((attempt) => attempt.kind === "gate").at(-1)!;

// ---- opening a gate

describe("opening a gate", () => {
  it("makes one approval for the attempt and the attempt waits on it: the subject, the prompt, the people the rules name now and 72 hours", async () => {
    const w = setupGateWorld();
    const { run, gate, approvalId } = await w.runAtGate();
    const record = await w.stepApproval(approvalId);
    expect(record).toMatchObject({ orgId: ORG_A, kind: "step", status: "PENDING", prompt: "Should Rovara Code fix this?", subject: { kind: "chain_gate", chainRunId: run.runId, seq: 2 }, project: "web" });
    expect(record.approvers).toMatchObject({ kind: "rule", rule: "chain_gate" });
    // The starter, then the project's maintainers (an org admin is one): who sees it listed. Who may decide is read when they decide.
    expect(new Set((record.approvers as { candidates: readonly string[] }).candidates)).toEqual(new Set([PRIYA, MAX, DANA]));
    expect(record.expiresAt).toBe(new Date(w.clock.now + GATE_DEFAULT_TIMEOUT_HOURS * HOUR).toISOString());
    expect(gate).toMatchObject({ seq: 2, kind: "gate", status: "waiting", approvalId, stepId: "approve_fix" });
    expect(w.run(run.runId)).toMatchObject({ status: "waiting", currentSeq: 2 });
    // The approval is the one Plan 3 lists and indexes.
    expect(w.db.find((item) => String(item.pk).includes("APPROVER#") || String(item.sk).includes(approvalId)).length).toBeGreaterThan(0);
  });

  it("says who it waits for and the gate's name in the gate_waiting event, with no link and no ticket in it (review I-1: the log is read by people who may not decide)", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const waiting = w.events(run.runId).filter((event) => event.type === "gate_waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ stepSeq: 2, text: `Waiting for the person who started this run or a maintainer of web to approve "Approve the fix".` });
    expect(waiting[0]!.text).not.toMatch(/ticket|https?:|approve\/|apr_/i);
    expect(waiting[0]!.text).not.toContain(approvalId);
  });

  it("takes the timeout from the gate's own hours", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate(PRIYA, gated([{ kind: "project_maintainers" }], { timeoutHours: 6 }));
    expect((await w.approval(approvalId)).expiresAt).toBe(new Date(w.clock.now + 6 * HOUR).toISOString());
  });

  it("moves the run's open item to the gate's time when that is earlier, in the same transaction as the attempt", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(gated([{ kind: "project_maintainers" }], { timeoutHours: 1 }));
    const run = await w.start(chain.chainId);
    // The sweep had set the next look far ahead; the gate must be looked at when it expires.
    const meta = w.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === run.runId)[0]!;
    const later = new Date(w.clock.now + 48 * HOUR).toISOString();
    const was = openChainRunKey(String(meta.dueAt), ORG_A, run.runId);
    w.db.delete(was.pk, was.sk);
    w.db.set({ ...openChainRunKey(later, ORG_A, run.runId), entityType: "OPEN_CHAIN_RUN", orgId: ORG_A, runId: run.runId });
    w.db.set({ ...meta, dueAt: later });
    await w.endLatest();
    const expiresAt = new Date(w.clock.now + HOUR).toISOString();
    expect(w.run(run.runId)!.dueAt).toBe(expiresAt);
    expect(w.openItems().map((item) => String(item.sk))).toEqual([openChainRunKey(expiresAt, ORG_A, run.runId).sk]);
  });

  it("leaves the open item where it is when it is already earlier than the gate's time", async () => {
    const w = setupGateWorld();
    const { run } = await w.runAtGate();
    expect(w.run(run.runId)!.dueAt).toBe(new Date(START_DUE(w)).toISOString());
  });

  it("opens the approval once even when the gate is entered twice or the first try died half way", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId);
    // The process dies on the transaction that writes the gate's attempt: the approval exists, the attempt does not.
    w.beforeTransaction("gate_waiting", () => { throw new Error("the process died"); });
    await expect(w.endLatest({ branch: "fix" })).rejects.toThrow("the process died");
    expect(w.attempts(run.runId)).toHaveLength(1);
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    await advanceChainRun(w.deps, ORG_A, run.runId);
    const gate = waitingGate(w, run.runId);
    expect(gate).toMatchObject({ seq: 2, status: "waiting" });
    const approvals = w.db.find((item) => item.entityType === "APPROVAL" && (item.subject as { kind?: string } | undefined)?.kind === "chain_gate");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.approvalId).toBe(gate.approvalId);
    expect(w.events(run.runId).filter((event) => event.type === "gate_waiting")).toHaveLength(1);
  });

  it("is not a step run: the step count is unchanged", async () => {
    const w = setupGateWorld();
    const { run } = await w.runAtGate();
    expect(w.run(run.runId)!.stepRuns).toBe(1);
  });
});

/** The first dueAt a run gets: five minutes after it started (Task 6). */
const START_DUE = (w: GateWorld) => w.db.find((item) => item.entityType === "OPEN_CHAIN_RUN").map((item) => Date.parse(String(item.sk).slice(0, 24)))[0]!;

// ---- who may decide

describe("who may decide a gate (checked when they decide)", () => {
  it("refuses a contributor who did not start the run with Plan 3's FORBIDDEN and the exact words, on the API and on the page", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    expect(await refusal(w.decideRoute(CARL, approvalId))).toEqual({ code: "FORBIDDEN", message: FORBIDDEN_TEXT });
    const page = await w.decideAs(CARL, approvalId);
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain("Only the person who started this run or a maintainer of web can decide this.");
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
    expect(w.attempts(run.runId).at(-1)).toMatchObject({ status: "waiting" });
    expect(w.starts).toHaveLength(1);
  });

  it("lets the starter approve, and the run goes on to the fix with exactly one gate_decided event naming them", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const done = await w.decideAs(PRIYA, approvalId);
    expect(done.statusCode, done.body).toBe(200);
    expect(await w.approval(approvalId)).toMatchObject({ status: "APPROVED", decidedBy: PRIYA, handlerDone: true });
    expect(w.attempts(run.runId).map((attempt) => [attempt.seq, attempt.stepId, attempt.status])).toEqual([[1, "investigate", "succeeded"], [2, "approve_fix", "succeeded"], [3, "fix", "running"]]);
    expect(w.attempts(run.runId)[1]).toMatchObject({ decision: "approved", approvalId });
    expect(w.starts.map((start) => start.agent.agentId)).toEqual(["root-cause-analyst", "rovara-code"]);
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 3 });
    expect(w.decidedEvents(run.runId)).toMatchObject([{ stepSeq: 2, text: 'Priya approved "Approve the fix"' }]);
  });

  it("lets a maintainer approve, and an org admin, who is a maintainer of every project", async () => {
    for (const who of [MAX, DANA]) {
      const w = setupGateWorld();
      const { run, approvalId } = await w.runAtGate();
      expect((await w.decideAs(who, approvalId)).statusCode).toBe(200);
      expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
    }
  });

  it("lets the starter decide only when a rule names them: with `project_maintainers` alone, the person who started the run is refused", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate(PRIYA, gated([{ kind: "project_maintainers" }]));
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toEqual({ code: "FORBIDDEN", message: 'Only a maintainer of web can approve "Approve it".' });
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(403);
    expect((await w.decideAs(MAX, approvalId)).statusCode).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
  });

  it("refuses a viewer, a member with no role on the project, and a viewer who started the run", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    for (const who of [VIV, ARJUN]) expect(await refusal(w.decideRoute(who, approvalId)), who).toMatchObject({ code: "FORBIDDEN" });
    // The starter, demoted to viewer since: a rule match is not enough without `start_tasks`.
    w.projectMembers.grant(ORG_A, "web", PRIYA, "viewer");
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
  });

  it("reads the role at the moment of the decision: a maintainer demoted after the gate opened is refused, and one added after it opened may decide", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.projectMembers.grant(ORG_A, "web", MAX, "viewer");
    expect(await refusal(w.decideRoute(MAX, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    // Arjun was no candidate when the gate opened.
    expect((await w.stepApproval(approvalId)).approvers).toMatchObject({ candidates: expect.not.arrayContaining([ARJUN]) as string[] });
    w.projectMembers.grant(ORG_A, "web", ARJUN, "maintainer");
    expect((await w.decideAs(ARJUN, approvalId)).statusCode).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
  });

  it("refuses a person who left the organization, and gives another organization's member 404", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    w.db.find((item) => item.entityType === "ORG_MEMBER" && item.developerId === PRIYA).forEach((item) => w.db.delete(String(item.pk), String(item.sk)));
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "NOT_FOUND" });
    const other = await w.session(STRANGER, approvalId, { orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect((await w.page(approvalId, { cookie: other })).statusCode).toBe(404);
    expect((await w.decide(approvalId, other)).statusCode).toBe(404);
    await expect(w.route(w.stranger(), "GET", `/v1/app/approvals/${approvalId}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
  });

  it("matches the gate's own rules: `chain_owner` is the chain's member owner or a maintainer of its owning project, `members` the people listed", async () => {
    // A chain owned by Priya: only she (and nobody else who holds start_tasks) matches chain_owner.
    const own = setupGateWorld();
    const mine = await own.runAtGate(PRIYA, gated([{ kind: "chain_owner" }]));
    expect(await refusal(own.decideRoute(CARL, mine.approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(own.decideRoute(MAX, mine.approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect((await own.decideAs(PRIYA, mine.approvalId)).statusCode).toBe(200);
    // A chain a project owns: its maintainers.
    const owned = setupGateWorld();
    const chain = await owned.publish(gated([{ kind: "chain_owner" }]), { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } });
    const run = await owned.start(chain.chainId, CARL);
    await owned.endLatest();
    const approvalId = waitingGate(owned, run.runId).approvalId!;
    expect(await refusal(owned.decideRoute(CARL, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect((await owned.decideAs(MAX, approvalId)).statusCode).toBe(200);
    // The people listed, if they still hold start_tasks.
    const listed = setupGateWorld();
    const named = await listed.runAtGate(PRIYA, gated([{ kind: "members", developerIds: [CARL, VIV] }]));
    expect(await refusal(listed.decideRoute(PRIYA, named.approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(listed.decideRoute(VIV, named.approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect((await listed.decideAs(CARL, named.approvalId)).statusCode).toBe(200);
  });

  it("reads the chain's owner when someone decides, not the owner the run started with: after setOwner the old owner is refused and the new owner decides (R68)", async () => {
    const w = setupGateWorld();
    const { chain, approvalId } = await w.runAtGate(PRIYA, gated([{ kind: "chain_owner" }]));
    expect(chain.owner).toEqual({ kind: "member", developerId: PRIYA });
    fixtureActor(w.db, ORG_A, CARL); // S1 (0.5.4): the new owner's member row and pointer are held in the owner change's transaction
    await w.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: CARL }, MAX, undefined, undefined, { actor: fixtureActor(w.db, ORG_A, MAX) });
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(403);
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
    expect((await w.decideAs(CARL, approvalId)).statusCode).toBe(200);
    expect(await w.approval(approvalId)).toMatchObject({ status: "APPROVED", decidedBy: CARL });
  });

  it("follows a move to a project too: the old member owner is refused and the new project's maintainer decides", async () => {
    const w = setupGateWorld();
    const { chain, approvalId } = await w.runAtGate(PRIYA, gated([{ kind: "chain_owner" }]));
    // S1 (0.5.4): the new accountable maintainer is held to a real grant row in the owner change's transaction.
    w.db.set({ ...projectMemberKey(ORG_A, MAX, "web"), entityType: "MEMBERSHIP", role: "developer", projectRole: "maintainer" });
    await w.chains.setOwner(ORG_A, chain.chainId, { kind: "project", project: "web" }, MAX, { developerId: MAX }, undefined, { actor: fixtureActor(w.db, ORG_A, MAX) });
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(w.decideRoute(CARL, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.decideAs(MAX, approvalId)).statusCode).toBe(200);
  });

  it("can't decide a gate whose chain is gone, whoever asks and whichever rule names them", async () => {
    const w = setupGateWorld();
    const { chain, approvalId } = await w.runAtGate(PRIYA, gated([{ kind: "chain_owner" }, { kind: "starter" }, { kind: "project_maintainers" }]));
    expect((await w.stepApproval(approvalId)).status).toBe("PENDING");
    const get = vi.spyOn(w.chains, "get").mockImplementation(async (orgId, chainId) => (chainId === chain.chainId ? undefined : ChainStore.prototype.get.call(w.chains, orgId, chainId)));
    for (const who of [PRIYA, MAX, DANA]) expect(await refusal(w.decideRoute(who, approvalId)), who).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.decideAs(MAX, approvalId)).statusCode).toBe(403);
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
    get.mockRestore();
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
  });

  it("lists a gate for the chain's owner now, and for the old owner never again, when the gate is opened after the owner moved", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(gated([{ kind: "chain_owner" }]));
    const run = await w.start(chain.chainId, PRIYA);
    fixtureActor(w.db, ORG_A, CARL); // S1 (0.5.4): the new owner's member row and pointer are held in the owner change's transaction
    await w.chains.setOwner(ORG_A, chain.chainId, { kind: "member", developerId: CARL }, MAX, undefined, undefined, { actor: fixtureActor(w.db, ORG_A, MAX) });
    await w.endLatest();
    const gate = w.attempts(run.runId).find((attempt) => attempt.kind === "gate")!;
    expect((await w.stepApproval(gate.approvalId!)).approvers).toMatchObject({ candidates: [CARL] });
  });

  it("names the rules in the refusal: the starter, a maintainer, the chain's owner or the people listed, joined with commas and `or`", async () => {
    const { approverWords } = await gates();
    const context = { project: "web", chainName: "Fix flow", memberNames: new Map([[CARL, "Carl"], [VIV, "Viv"], [MAX, "Max"]]) };
    expect(approverWords([{ kind: "starter" }], context)).toBe("the person who started this run");
    expect(approverWords([{ kind: "project_maintainers" }], context)).toBe("a maintainer of web");
    expect(approverWords([{ kind: "chain_owner" }], context)).toBe("Fix flow's owner");
    expect(approverWords([{ kind: "members", developerIds: [CARL] }], context)).toBe("Carl");
    expect(approverWords([{ kind: "starter" }, { kind: "project_maintainers" }], context)).toBe("the person who started this run or a maintainer of web");
    expect(approverWords([{ kind: "starter" }, { kind: "chain_owner" }, { kind: "members", developerIds: [CARL, VIV] }], context)).toBe("the person who started this run, Fix flow's owner, Carl or Viv");
  });

  it("fails closed when the chain store is not there at all", async () => {
    const { gateEligible } = await gates();
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    const record = await w.approval(approvalId);
    expect(await gateEligible(w.deps, record, callerOf(PRIYA))).toBe(true);
    expect(await gateEligible({ ...w.deps, chains: undefined } as never, record, callerOf(PRIYA))).toBe(false);
  });

  it("fails closed when the gate can't be read: a missing chain version, an attempt that is not this approval's", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const version = w.db.find((item) => item.entityType === "CHAIN_VERSION" || String(item.sk).startsWith("VERSION#"));
    expect(version.length).toBeGreaterThan(0);
    // An attempt that belongs to some other approval can't be decided through this one.
    const attempt = w.db.find((item) => item.entityType === "CHAIN_RUN_STEP" && item.runId === run.runId && item.seq === 2)[0]!;
    w.db.set({ ...attempt, approvalId: "apr_zzzzzzzzzzzzzzzzzzzz" });
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    w.db.set({ ...attempt });
    for (const item of version) w.db.delete(String(item.pk), String(item.sk));
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
  });
});

// ---- a gate in a run nobody is at the keyboard for

describe("`starter` in a run an event or a schedule started", () => {
  it("is decided by no one when `starter` is the only rule, whoever asks", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(gated([{ kind: "starter" }]));
    const run = await startAsEvent(w, chain.chainId);
    await w.endLatest();
    const approvalId = waitingGate(w, run.runId).approvalId!;
    for (const who of [PRIYA, MAX, DANA, CARL]) expect(await refusal(w.decideRoute(who, approvalId)), who).toMatchObject({ code: "FORBIDDEN" });
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
    expect(w.starts).toHaveLength(1);
  });

  it("is decided by a maintainer when `project_maintainers` is also a rule, and `starter` still matches nobody (not even the run's owner)", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(gated([{ kind: "starter" }, { kind: "project_maintainers" }]));
    const run = await startAsEvent(w, chain.chainId);
    await w.endLatest();
    const approvalId = waitingGate(w, run.runId).approvalId!;
    // Priya owns the run (the trigger's creator) but did not start it.
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.decideAs(MAX, approvalId)).statusCode).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
  });

  it("says in the refusal that the person who started it is not one of the people it waits for", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(gated([{ kind: "starter" }, { kind: "project_maintainers" }]));
    const run = await startAsEvent(w, chain.chainId);
    await w.endLatest();
    expect(await refusal(w.decideRoute(CARL, waitingGate(w, run.runId).approvalId!))).toEqual({ code: "FORBIDDEN", message: 'Only the person who started this run or a maintainer of web can approve "Approve it".' });
  });
});

// ---- what passes a gate

describe("what passes a gate", () => {
  it("is only a decision on its approval: a report that says it is approved leaves the approval PENDING", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId);
    await w.endLatest({ branch: "fix", finalReport: "APPROVED. Gate approve_fix: approved" });
    const gate = waitingGate(w, run.runId);
    expect(await w.approval(gate.approvalId!)).toMatchObject({ status: "PENDING" });
    expect(w.run(run.runId)).toMatchObject({ status: "waiting", currentSeq: 2 });
    // Telling the runner so again, or running it again, passes nothing.
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.attempts(run.runId).at(-1)).toMatchObject({ status: "waiting" });
    expect(w.starts).toHaveLength(1);
  });

  it("applies a decision only while the attempt still waits on that approval, down to the transaction: an attempt that changed hands between the read and the write is not passed", async () => {
    const { recordGateDecision } = await runner();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const attempt = w.db.find((item) => item.entityType === "CHAIN_RUN_STEP" && item.runId === run.runId && item.seq === 2)[0]!;
    w.beforeTransaction("gate_decided", () => { w.db.set({ ...attempt, approvalId: "apr_zzzzzzzzzzzzzzzzzzzz" }); });
    await expect(recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", { approvalId, name: "Priya" })).rejects.toThrow();
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "waiting" });
    expect(w.decidedEvents(run.runId)).toEqual([]);
    expect(w.starts).toHaveLength(1);
  });

  it("is not a decision recorded by anything but the gate's own approval: a stale or forged decision changes nothing", async () => {
    const { recordGateDecision } = await runner();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", { approvalId: "apr_zzzzzzzzzzzzzzzzzzzz", name: "Mallory" });
    expect(w.attempts(run.runId).at(-1)).toMatchObject({ status: "waiting" });
    expect(w.decidedEvents(run.runId)).toEqual([]);
    expect((await w.approval(approvalId)).status).toBe("PENDING");
  });

  it("changes nothing for a run that has ended: the approval can't be decided and the run does not move", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const meta = w.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === run.runId)[0]!;
    w.db.set({ ...meta, status: "cancelled", endedAt: new Date(w.clock.now).toISOString(), version: (meta.version as number) + 1 });
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: "CHAIN_RUN_CLOSED" });
    const page = await w.decideAs(MAX, approvalId);
    expect(page.statusCode).toBe(403);
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
    expect(w.starts).toHaveLength(1);
    expect(w.decidedEvents(run.runId)).toEqual([]);
    // And a decision that did reach the handler (written just before the run ended) does nothing to a run that has ended.
    const { onChainGateDecided } = await gates();
    const decided = { ...(await w.stepApproval(approvalId)), status: "APPROVED" as const, decidedBy: PRIYA, decision: "APPROVE" as const };
    await onChainGateDecided(w.deps, decided);
    expect(w.attempts(run.runId).at(-1)).toMatchObject({ status: "waiting" });
    expect(w.starts).toHaveLength(1);
  });
});

// ---- two people, one decision

describe("a gate is decided once (R18)", () => {
  it("lets one of two maintainers who decide at once win, answers the other with APPROVAL_CLOSED, and records one gate_decided event", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const results = await Promise.allSettled([w.decideRoute(MAX, approvalId, "APPROVE"), w.decideRoute(DANA, approvalId, "DECLINE")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "APPROVAL_CLOSED" });
    expect(w.decidedEvents(run.runId)).toHaveLength(1);
    const record = await w.stepApproval(approvalId);
    expect(w.attempts(run.runId)[1]).toMatchObject({ decision: record.decision === "APPROVE" ? "approved" : "declined" });
    expect(w.starts).toHaveLength(record.decision === "APPROVE" ? 2 : 1);
  });

  it("answers a second decision, and the opposite one arriving late, with APPROVAL_CLOSED and changes nothing", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    expect((await w.decideAs(MAX, approvalId)).statusCode).toBe(200);
    const before = JSON.stringify([w.run(run.runId), w.attempts(run.runId), w.events(run.runId)]);
    for (const [who, decision] of [[MAX, "APPROVE"], [PRIYA, "DECLINE"], [DANA, "APPROVE"]] as const) {
      expect(await refusal(w.decideRoute(who, approvalId, decision)), who).toMatchObject({ code: "APPROVAL_CLOSED" });
    }
    expect(JSON.stringify([w.run(run.runId), w.attempts(run.runId), w.events(run.runId)])).toBe(before);
    expect(w.starts).toHaveLength(2);
  });

  it("spends the decide session: the same session can't decide again", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    const cookie = await w.session(PRIYA, approvalId);
    expect((await w.decide(approvalId, cookie)).statusCode).toBe(200);
    expect((await w.decide(approvalId, cookie)).statusCode).toBe(401);
    expect(w.starts).toHaveLength(2);
  });

  it("applies a decision once however often its handler is told: twice advances once", async () => {
    const { onChainGateDecided } = await gates();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
    const record = await w.stepApproval(approvalId);
    await onChainGateDecided(w.deps, record);
    await Promise.all([onChainGateDecided(w.deps, record), onChainGateDecided(w.deps, record)]);
    expect(w.starts).toHaveLength(2);
    expect(w.decidedEvents(run.runId)).toHaveLength(1);
    expect(w.attempts(run.runId)).toHaveLength(3);
    expect(w.events(run.runId).map((event) => event.seq)).toEqual(w.events(run.runId).map((_, index) => index + 1));
  });

  it("leaves a loop's earlier attempt alone: deciding the first attempt's approval again changes nothing in the run at attempt 3 of the gate", async () => {
    const { onChainGateDecided } = await gates();
    const w = setupGateWorld();
    const chain = await w.publish(looping(3));
    const run = await w.start(chain.chainId);
    const approvals: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      await w.endLatest();
      const gate = waitingGate(w, run.runId);
      approvals.push(gate.approvalId!);
      expect(gate).toMatchObject({ attempt: round + 1, status: "waiting" });
      if (round < 2) expect((await w.decideAs(PRIYA, gate.approvalId!, "decline")).statusCode).toBe(200);
    }
    expect(new Set(approvals).size).toBe(3);
    expect(w.attempts(run.runId).map((attempt) => attempt.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const before = JSON.stringify([w.run(run.runId), w.attempts(run.runId), w.events(run.runId)]);
    // The first attempt's approval was declined: another decision on it is refused, and telling the runner of it again does nothing to the gate's third attempt.
    expect(await refusal(w.decideRoute(PRIYA, approvals[0]!, "APPROVE"))).toMatchObject({ code: "APPROVAL_CLOSED" });
    await onChainGateDecided(w.deps, { ...(await w.stepApproval(approvals[0]!)), status: "APPROVED", decidedBy: PRIYA, decision: "APPROVE" });
    await onChainGateDecided(w.deps, { ...(await w.stepApproval(approvals[1]!)), status: "APPROVED", decidedBy: PRIYA, decision: "APPROVE" });
    expect(JSON.stringify([w.run(run.runId), w.attempts(run.runId), w.events(run.runId)])).toBe(before);
    expect(waitingGate(w, run.runId)).toMatchObject({ seq: 6, status: "waiting", approvalId: approvals[2] });
    // Its own approval decides it.
    expect((await w.decideAs(MAX, approvals[2]!)).statusCode).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
  });
});

// ---- the decision

describe("the decision", () => {
  it("takes onReject on a decline: the default is the end, the run succeeds and the event says it was sent back", async () => {
    const w = setupGateWorld();
    const { chain, run, approvalId } = await w.runAtGate();
    expect((await w.decideAs(PRIYA, approvalId, "decline")).statusCode).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "declined" });
    expect(w.decidedEvents(run.runId)).toMatchObject([{ text: 'Priya sent "Approve the fix" back' }]);
    expect(w.starts).toHaveLength(1);
    expect(w.events(run.runId).map((event) => event.type)).toEqual(["started", "step_started", "step_ended", "branch", "gate_waiting", "gate_decided", "ended"]);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
    expect(w.openItems()).toEqual([]);
  });

  it("writes the attempt, the run and the event in one transaction: a failed transaction leaves none of them", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.beforeTransaction("gate_decided", () => { throw new Error("the table is down"); });
    const decided = await w.decideAs(PRIYA, approvalId);
    expect(decided.statusCode).toBe(200);
    // The decision itself was written (Plan 3's claim); the run did not move, and nothing of it was half written.
    expect(await w.approval(approvalId)).toMatchObject({ status: "APPROVED", handlerDone: false });
    expect(w.attempts(run.runId).at(-1)).toMatchObject({ status: "waiting" });
    expect(w.decidedEvents(run.runId)).toEqual([]);
    expect(w.run(run.runId)).toMatchObject({ status: "waiting", currentSeq: 2 });
    expect(w.events(run.runId).map((event) => event.seq)).toEqual(w.events(run.runId).map((_, index) => index + 1));
  });

  it("is never lost: a decision written just before the broker stopped is applied by the approvals sweep, once", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.beforeTransaction("gate_decided", () => { throw new Error("the process died"); });
    await w.decideAs(PRIYA, approvalId);
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
    // The handler's lease runs out; the sweep tells it again.
    w.clock.now += 10 * 60_000;
    const report = await expireApprovals(w.deps, w.clock.now);
    expect(report.handled).toBe(1);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3, status: "running" });
    expect(w.decidedEvents(run.runId)).toHaveLength(1);
    w.clock.now += 10 * 60_000;
    expect((await expireApprovals(w.deps, w.clock.now)).handled).toBe(0);
    expect(w.starts).toHaveLength(2);
  });

  it("retries a handler that could not reach the runner instead of dropping the decision", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const { onChainGateDecided } = await gates();
    const record = { ...(await w.stepApproval(approvalId)), status: "APPROVED" as const, decidedBy: PRIYA, decision: "APPROVE" as const };
    // A deployment whose handler has no runner dependencies tells its caller so (the sweep tries again), and writes nothing.
    const bare = { documentClient: w.deps.documentClient, tableName: "T", now: w.deps.now, signInStore: w.deps.signInStore, projectMembers: w.deps.projectMembers, store: w.deps.store, confirmOrigin: CELL };
    disposeGateWorlds();
    await expect(onChainGateDecided(bare as never, record)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.attempts(run.runId).at(-1)).toMatchObject({ status: "waiting" });
  });

  it("ends the run `timed_out` when no one decides in time, with the exact words, and only through the approval's expiry", async () => {
    const w = setupGateWorld();
    const { chain, run, approvalId } = await w.runAtGate();
    w.clock.now += 73 * HOUR;
    const report = await expireApprovals(w.deps, w.clock.now);
    expect(report).toMatchObject({ expired: 1, handled: 1 });
    expect(await w.approval(approvalId)).toMatchObject({ status: "EXPIRED" });
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { seq: 2, reason: "gate_timeout", message: 'No one approved "Approve the fix" within 72 hours, so the chain stopped.' } });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "timed_out" });
    expect(w.decidedEvents(run.runId)).toEqual([]);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
    expect(w.starts).toHaveLength(1);
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toMatchObject({ code: expect.stringMatching(/APPROVAL_CLOSED|FORBIDDEN/) as string });
  });

  it("does not end a run that was decided in time just because the sweep reached it late", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.beforeTransaction("gate_decided", () => { throw new Error("the process died"); });
    await w.decideAs(PRIYA, approvalId);
    w.clock.now += 100 * HOUR;
    await expireApprovals(w.deps, w.clock.now);
    expect(w.run(run.runId)!.status).not.toBe("timed_out");
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
  });
});

// ---- tickets and the page (R66, R68, N5)

describe("the confirmation page and its tickets", () => {
  it("lists the gate for a maintainer who is a candidate and not for a viewer", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    const listed = await w.route(callerOf(MAX), "GET", "/v1/app/approvals?status=PENDING") as { approvals: Array<{ approvalId: string; kind: string; confirmUrl: string; prompt: string }> };
    expect(listed.approvals).toMatchObject([{ approvalId, kind: "step", confirmUrl: confirmUrl(approvalId), prompt: "Should Rovara Code fix this?" }]);
    expect(((await w.route(callerOf(VIV), "GET", "/v1/app/approvals?status=PENDING")) as { approvals: unknown[] }).approvals).toEqual([]);
  });

  it("gives a maintainer demoted after the gate opened no ticket, and a maintainer added after it opened one, who then decides on the page", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.projectMembers.grant(ORG_A, "web", MAX, "viewer");
    const refused = await w.route(callerOf(MAX), "POST", `/v1/app/approvals/${approvalId}/confirm-link`, {}).then((value) => value, (error: { code: string }) => ({ code: error.code }));
    expect(refused).not.toHaveProperty("ticketed", true);
    expect(w.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
    w.projectMembers.grant(ORG_A, "web", ARJUN, "maintainer");
    const asked = await w.route(callerOf(ARJUN), "POST", `/v1/app/approvals/${approvalId}/confirm-link`, {});
    expect(asked).toMatchObject({ ticketed: true, confirmUrl: expect.stringMatching(new RegExp(`^${confirmUrl(approvalId)}\\?ticket=[A-Za-z0-9_-]{43}$`)) as string });
    expect((await w.decideAs(ARJUN, approvalId)).statusCode).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
  });

  it("sends a CLI or MCP token to the page with REAUTH_REQUIRED and a link, decides nothing, and refuses an unknown or task capability token with 401", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const refused = await w.tokenDecide(PRIYA, approvalId, "Bearer priya").then(() => undefined, (error: { code: string; statusCode: number; details?: { confirmUrl?: string } }) => error);
    expect(refused).toMatchObject({ code: "REAUTH_REQUIRED", statusCode: 401 });
    expect(refused?.details?.confirmUrl).toMatch(new RegExp(`^${confirmUrl(approvalId)}\\?ticket=`));
    const capability = await w.tokenDecide(PRIYA, approvalId, "Bearer task-capability-abc").then(() => undefined, (error: { code: string; statusCode: number }) => error);
    expect(capability).toMatchObject({ statusCode: 401 });
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
    expect(w.attempts(run.runId).at(-1)).toMatchObject({ status: "waiting" });
  });

  it("decides on the page only for a sign-in at most 10 minutes old: 11 minutes is sent to sign in again and decides nothing, 5 minutes decides", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const stale = await w.decideAs(PRIYA, approvalId, "approve", { agoSeconds: 11 * 60 });
    expect(stale.statusCode).not.toBe(200);
    expect(await w.approval(approvalId)).toMatchObject({ status: "PENDING" });
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
    const fresh = await w.decideAs(PRIYA, approvalId, "approve", { agoSeconds: 5 * 60 });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
  });

  it("shows the gate's prompt on the page and keeps the decision with the person who made it", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    const shown = await w.page(approvalId, { cookie: await w.session(MAX, approvalId) });
    expect(shown.statusCode).toBe(200);
    expect(shown.body).toContain("Should Rovara Code fix this?");
    expect((await w.decideAs(MAX, approvalId)).statusCode).toBe(200);
    expect(await w.approval(approvalId)).toMatchObject({ decidedBy: MAX, decisionProof: { kind: "fresh_sign_in", method: "email_code" } });
  });

  it("shows a decided gate to the person who decided it, not a refusal", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
    const again = await w.page(approvalId, { cookie: await w.session(PRIYA, approvalId) });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain("already decided by Priya");
  });
});

// ---- no decide tool, no ticket of Plan 4's

describe("Plan 4 adds no way to decide a gate (R66)", () => {
  const tools = async (client: Partial<ControlPlaneClient>) => {
    const context = (): ToolContext => ({
      client: client as ControlPlaneClient, clientName: "claude-code", serverVersion: "0.4.0", adminSignedIn: async () => false,
      compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
    });
    const server = createAgentXMcpServer({ version: "0.4.0", context });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "claude-code", version: "1.0.0" });
    await mcp.connect(clientSide);
    return mcp;
  };

  it("has no MCP tool that decides an approval, and agentx_list_approvals returns the gate with the page's link", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    const listed = (await w.route(callerOf(MAX), "GET", "/v1/app/approvals?status=PENDING")) as { approvals: Array<{ approvalId: string }> };
    const one = (await w.route(callerOf(MAX), "GET", `/v1/app/approvals/${approvalId}`)) as { approval: Record<string, unknown> };
    const mcp = await tools({ listApprovals: async () => listed.approvals as never, getApproval: async () => one.approval as never });
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const name of names) expect(name, name).not.toMatch(/(approve|decline|deny|reject)/);
    expect(names.filter((name) => /gate|decide/i.test(name) && !/workflow|pr_feedback/.test(name))).toEqual([]);
    const result = await mcp.callTool({ name: "agentx_list_approvals", arguments: {} });
    const approvals = (result as { structuredContent?: { approvals: Array<{ approval_id: string; kind: string; summary: string; confirm_url: string }> } }).structuredContent!.approvals;
    expect(approvals).toMatchObject([{ approval_id: approvalId, kind: "step", summary: "Should Rovara Code fix this?", confirm_url: confirmUrl(approvalId) }]);
  });

  it("shows the gate's bare link on a read and mints nothing", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    const read = (await w.route(callerOf(MAX), "GET", `/v1/app/approvals/${approvalId}`)) as { approval: { confirmUrl: string } };
    expect(read.approval.confirmUrl).toBe(confirmUrl(approvalId));
    expect(w.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
  });
});

// ---- the rule reads the gate as it is stored, and fails closed on anything that does not fit

describe("the gate's rule reads what is stored and fails closed on anything that does not fit", () => {
  const stored = (w: GateWorld, runId: string) => ({
    run: w.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === runId)[0]!,
    attempt: w.db.find((item) => item.entityType === "CHAIN_RUN_STEP" && item.runId === runId && item.seq === 2)[0]!,
  });
  const eligible = async (w: GateWorld, approvalId: string, who: string = PRIYA, orgId = ORG_A) => {
    const { gateEligible } = await gates();
    return gateEligible(w.deps, await w.approval(approvalId), callerOf(who, orgId));
  };

  it("answers true for the starter on the gate it was opened for (the baseline of the cases below)", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    expect(await eligible(w, approvalId)).toBe(true);
    expect(await eligible(w, approvalId, CARL)).toBe(false);
  });

  it("refuses, without throwing, when the run, the attempt or the design is gone", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const { run: meta, attempt } = stored(w, run.runId);
    w.db.delete(String(attempt.pk), String(attempt.sk));
    expect(await eligible(w, approvalId)).toBe(false);
    w.db.set(attempt);
    w.db.delete(String(meta.pk), String(meta.sk));
    expect(await eligible(w, approvalId)).toBe(false);
  });

  it("refuses an attempt that is not a gate, or whose step the design does not have as a gate", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const { attempt } = stored(w, run.runId);
    w.db.set({ ...attempt, kind: "agent" });
    expect(await eligible(w, approvalId)).toBe(false);
    w.db.set({ ...attempt, stepId: "investigate" });
    expect(await eligible(w, approvalId)).toBe(false);
    w.db.set({ ...attempt, stepId: "no_such_step" });
    expect(await eligible(w, approvalId)).toBe(false);
  });

  it("refuses a record that is not a gate's: a step approval of another subject that names the rule", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    const { gateEligible } = await gates();
    const record = { ...(await w.stepApproval(approvalId)), subject: { kind: "agent_run" as const, taskId: "task-1", stepId: "work" } };
    expect(await gateEligible(w.deps, record, callerOf(PRIYA))).toBe(false);
  });

  it("can't be decided while pending unless the gate is the run's live, waiting gate on this approval", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const { run: meta, attempt } = stored(w, run.runId);
    w.db.set({ ...meta, currentSeq: 3 });
    expect(await eligible(w, approvalId)).toBe(false);
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toEqual({ code: "APPROVAL_CLOSED", message: '"Approve the fix" is not waiting for approval any more.' });
    w.db.set(meta);
    w.db.set({ ...attempt, status: "succeeded" });
    expect(await eligible(w, approvalId)).toBe(false);
    w.db.set(attempt);
    expect(await eligible(w, approvalId)).toBe(true);
    w.db.set({ ...meta, status: "cancelled" });
    expect(await refusal(w.decideRoute(PRIYA, approvalId))).toEqual({ code: "CHAIN_RUN_CLOSED", message: 'This run has ended, so "Approve the fix" can\'t be approved.' });
  });

  it("answers a decided gate by who, whether or not the run is still at it", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
    expect(await eligible(w, approvalId, PRIYA)).toBe(true);
    expect(await eligible(w, approvalId, MAX)).toBe(true);
    expect(await eligible(w, approvalId, CARL)).toBe(false);
  });

  it("never takes a caller of another organization, even with the id of a member of this one", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    expect(await eligible(w, approvalId, PRIYA, "org_bbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });

  it("refuses a caller who is no member of the organization even when a rule names them", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate(PRIYA, gated([{ kind: "members", developerIds: [CARL] }]));
    w.db.find((item) => item.entityType === "ORG_MEMBER" && item.developerId === CARL).forEach((item) => w.db.delete(String(item.pk), String(item.sk)));
    w.projectMembers.grant(ORG_A, "web", CARL, "contributor");
    expect(await eligible(w, approvalId, CARL)).toBe(false);
  });

  it("reads the project's roles for the run's own project, not another", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    w.projectMembers.grant(ORG_A, "api", ARJUN, "maintainer");
    expect(await eligible(w, approvalId, ARJUN)).toBe(false);
  });
});

describe("the words of a gate, more", () => {
  it("lets any listed person decide, not only the first", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate(PRIYA, gated([{ kind: "members", developerIds: [VIV, CARL] }]));
    expect((await w.decideAs(CARL, approvalId)).statusCode).toBe(200);
  });

  it("says a person nobody can name is a teammate, and a person once", async () => {
    const { approverWords } = await gates();
    const context = { project: "web", chainName: "Fix flow", memberNames: new Map([[CARL, "Carl"]]) };
    expect(approverWords([{ kind: "members", developerIds: [VIV] }], context)).toBe("a teammate");
    expect(approverWords([{ kind: "members", developerIds: [CARL] }, { kind: "members", developerIds: [CARL] }], context)).toBe("Carl");
    expect(approverWords([{ kind: "starter" }, { kind: "starter" }], context)).toBe("the person who started this run");
    expect(approverWords([], context)).toBe("");
  });

  it("answers someone who may not decide an approval that was already decided with who may, not with `not waiting`", async () => {
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
    expect(await refusal(w.decideRoute(CARL, approvalId))).toEqual({ code: "FORBIDDEN", message: FORBIDDEN_TEXT });
  });

  it("opens a gate whose people can't be named: a record with no usable name makes them teammates", async () => {
    const { openGateApproval } = await gates();
    const w = setupGateWorld();
    const { chain, run } = await w.runAtGate(PRIYA, gated([{ kind: "members", developerIds: [CARL] }]));
    const version = (await w.chains.getVersion(ORG_A, chain.chainId, 1))!;
    const gate = version.definition.steps.find((step) => step.kind === "gate")!;
    const nameless = { ...w.deps, signInStore: { getDeveloper: async (id: string) => ({ developerId: id, displayName: 7 }) } };
    const opened = await openGateApproval(nameless as never, w.run(run.runId)!, gate, 9);
    expect(opened.record.owner).toEqual({ developerId: PRIYA, name: "a teammate" });
    expect(opened.waitingText).toContain("Waiting for a teammate to approve");
  });
});

describe("the words of a gate", () => {
  it("show a person's name safely: no direction mark, no marker for one, and the rest as text", async () => {
    const w = setupGateWorld();
    w.db.set({ pk: `DEVELOPER#${CARL}`, sk: "META", developerId: CARL, displayName: "Carl\u202E<b>Evil</b>", revoked: false });
    const chain = await w.publish(gated([{ kind: "members", developerIds: [CARL] }]));
    const run = await w.start(chain.chainId);
    await w.endLatest();
    const text = w.events(run.runId).find((event) => event.type === "gate_waiting")!.text;
    expect(text).not.toContain("\u202E");
    expect(text).not.toContain("U+202E");
    expect(text).toContain("Waiting for Carl <b>Evil</b> to approve");
  });

  // S3-L3 (names): a person whose stored name is only an address reads as their placeholder, never "[email removed]"; a name with an address in it keeps the rest.
  it.each([
    ["only an address", `carl${String.fromCharCode(64)}example.test`, /Waiting for Member [0-9a-f]{8} to approve/u],
    ["a name and an address", `Carl Reyes carl${String.fromCharCode(64)}example.test`, /Waiting for Carl Reyes to approve/u],
  ])("show a person's name safely when it holds an address: %s", async (_why, displayName, expected) => {
    const w = setupGateWorld();
    w.db.set({ pk: `DEVELOPER#${CARL}`, sk: "META", developerId: CARL, displayName, revoked: false });
    const chain = await w.publish(gated([{ kind: "members", developerIds: [CARL] }]));
    const run = await w.start(chain.chainId);
    await w.endLatest();
    const text = w.events(run.runId).find((event) => event.type === "gate_waiting")!.text;
    expect(text).toMatch(expected);
    expect(text).not.toContain("[email removed]");
    expect(text).not.toContain("example.test");
  });

  it("say `a teammate` for a listed person nobody can name", async () => {
    const w = setupGateWorld();
    w.db.delete(`DEVELOPER#${VIV}`, "META");
    const chain = await w.publish(gated([{ kind: "members", developerIds: [VIV] }]));
    const run = await w.start(chain.chainId);
    await w.endLatest();
    expect(w.events(run.runId).find((event) => event.type === "gate_waiting")!.text).toContain("Waiting for a teammate to approve");
  });

  it("are cut to the event's limit, and the cut leaves the closing words of the sentence", async () => {
    const w = setupGateWorld();
    const ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((digit) => digit.repeat(64));
    ids.forEach((id, index) => w.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: `${String(index)}${"n".repeat(79)}`, revoked: false }));
    const chain = await w.publish(gated([{ kind: "members", developerIds: ids }]));
    const run = await w.start(chain.chainId);
    await w.endLatest();
    const text = w.events(run.runId).find((event) => event.type === "gate_waiting")!.text;
    expect(text).toMatch(/ to approve "[^"]+"\.$/);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toContain("…");
  });
});

describe("the handler", () => {
  it("tries again when the run moved while the decision was written, and passes the gate without the sweep", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.beforeTransaction("gate_decided", () => w.touchRun(run.runId));
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
    expect(await w.approval(approvalId)).toMatchObject({ status: "APPROVED", handlerDone: true });
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
    expect(w.decidedEvents(run.runId)).toHaveLength(1);
  });

  it("gives up after three tries and leaves the decision for the sweep, which then applies it", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.beforeTransaction("gate_decided", () => w.touchRun(run.runId), 3);
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
    expect(await w.approval(approvalId)).toMatchObject({ status: "APPROVED", handlerDone: false });
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 2 });
    w.clock.now += 10 * 60_000;
    expect((await expireApprovals(w.deps, w.clock.now)).handled).toBe(1);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
  });

  it("finds the runner through the provider the broker sets, when the approvals' own dependencies have none, and stops when it is taken off", async () => {
    const { onChainGateDecided, registerChainGates } = await gates();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    disposeGateWorlds();
    const bare = { documentClient: w.deps.documentClient, tableName: "T", now: w.deps.now, signInStore: w.deps.signInStore, projectMembers: w.deps.projectMembers, store: w.deps.store, confirmOrigin: CELL };
    const decided = { ...(await w.stepApproval(approvalId)), status: "APPROVED" as const, decidedBy: PRIYA, decision: "APPROVE" as const };
    const first = registerChainGates(() => w.deps);
    const second = registerChainGates(() => w.deps);
    first();
    // Taking an older registration off leaves the newer one.
    await onChainGateDecided(bare, decided);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
    second();
    await expect(onChainGateDecided(bare as never, decided)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("needs both the chain store and the run starter in the dependencies it is handed, or refuses before changing anything", async () => {
    const { onChainGateDecided } = await gates();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    disposeGateWorlds();
    const decided = { ...(await w.stepApproval(approvalId)), status: "APPROVED" as const, decidedBy: PRIYA, decision: "APPROVE" as const };
    await expect(onChainGateDecided({ ...w.deps, chainRuns: undefined } as never, decided)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "waiting" });
  });

  it("names who decided from the approval, and `a teammate` when it names no one", async () => {
    const { onChainGateDecided } = await gates();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const { decidedBy: _unused, ...rest } = { ...(await w.stepApproval(approvalId)), status: "DECLINED" as const, decision: "DECLINE" as const, decidedBy: PRIYA };
    void _unused;
    await onChainGateDecided(w.deps, rest);
    expect(w.decidedEvents(run.runId)).toMatchObject([{ text: 'a teammate sent "Approve the fix" back' }]);
  });

  it("ignores an approval that is neither decided nor expired", async () => {
    const { onChainGateDecided } = await gates();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    await onChainGateDecided(w.deps, await w.stepApproval(approvalId));
    await onChainGateDecided(w.deps, { ...(await w.stepApproval(approvalId)), status: "EXECUTING" as never });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "waiting" });
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
  });

  it("ends only the gate it is told about when its approval expires, and says one hour in the singular", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate(PRIYA, gated([{ kind: "project_maintainers" }], { timeoutHours: 1 }));
    w.clock.now += 2 * HOUR;
    await expireApprovals(w.deps, w.clock.now);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out", failure: { message: 'No one approved "Approve it" within 1 hour, so the chain stopped.' } });
    expect(await w.approval(approvalId)).toMatchObject({ status: "EXPIRED" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "timed_out" });
  });

  it("uses the gate's own hours when it names them", async () => {
    const w = setupGateWorld();
    const { run } = await w.runAtGate(PRIYA, gated([{ kind: "project_maintainers" }], { timeoutHours: 6 }));
    w.clock.now += 7 * HOUR;
    await expireApprovals(w.deps, w.clock.now);
    expect(w.run(run.runId)!.failure).toMatchObject({ message: 'No one approved "Approve it" within 6 hours, so the chain stopped.' });
  });

  it("is not ended by an expired approval that no live gate waits on (an older attempt, or a run that moved on)", async () => {
    const { onChainGateDecided } = await gates();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    await onChainGateDecided(w.deps, { ...(await w.stepApproval(approvalId)), approvalId: "apr_zzzzzzzzzzzzzzzzzzzz", status: "EXPIRED" as const });
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
    const meta = w.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === run.runId)[0]!;
    w.db.set({ ...meta, currentSeq: 3 });
    await onChainGateDecided(w.deps, { ...(await w.stepApproval(approvalId)), status: "EXPIRED" as const });
    expect(w.run(run.runId)).toMatchObject({ status: "waiting" });
  });
});

describe("the people a gate is listed for, and how a merged person counts", () => {
  const OLD_PRIYA = "9".repeat(64);
  const candidatesOfGate = async (w: GateWorld, approvalId: string) => new Set((await w.stepApproval(approvalId)).approvers.kind === "rule" ? ((await w.stepApproval(approvalId)).approvers as { candidates: readonly string[] }).candidates : []);

  it("lists the chain's member owner for `chain_owner`, the owning project's maintainers for a project-owned chain, and every person a `members` rule names", async () => {
    const own = setupGateWorld();
    expect(await candidatesOfGate(own, (await own.runAtGate(PRIYA, gated([{ kind: "chain_owner" }]))).approvalId)).toEqual(new Set([PRIYA]));
    const owned = setupGateWorld();
    const chain = await owned.publish(gated([{ kind: "chain_owner" }]), { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } });
    const run = await owned.start(chain.chainId, CARL);
    await owned.endLatest();
    expect(await candidatesOfGate(owned, waitingGate(owned, run.runId).approvalId!)).toEqual(new Set([MAX, DANA]));
    const listed = setupGateWorld();
    expect(await candidatesOfGate(listed, (await listed.runAtGate(PRIYA, gated([{ kind: "members", developerIds: [CARL, VIV, ARJUN] }]))).approvalId)).toEqual(new Set([CARL, VIV, ARJUN]));
  });

  it("lists nobody for `starter` alone in a run an event started", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(gated([{ kind: "starter" }]));
    const run = await startAsEvent(w, chain.chainId);
    await w.endLatest();
    expect(await candidatesOfGate(w, waitingGate(w, run.runId).approvalId!)).toEqual(new Set());
  });

  it("takes a chain owned by another project for `chain_owner`: that project's maintainers decide, not the run's", async () => {
    const w = setupGateWorld();
    w.projectMembers.grant(ORG_A, "api", ARJUN, "maintainer");
    w.projectMembers.grant(ORG_A, "web", ARJUN, "contributor");
    w.projectMembers.grant(ORG_A, "api", PRIYA, "contributor");
    const chain = await w.publish(gated([{ kind: "chain_owner" }]), { owner: { kind: "project", project: "api" }, accountable: { developerId: ARJUN } });
    const run = await w.start(chain.chainId, PRIYA);
    await w.endLatest();
    const approvalId = waitingGate(w, run.runId).approvalId!;
    expect(await refusal(w.decideRoute(MAX, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.decideAs(ARJUN, approvalId)).statusCode).toBe(200);
  });

  it("counts a person merged into another as the same person, for the starter, the caller and the list", async () => {
    const { gateEligible } = await gates();
    const w = setupGateWorld();
    w.db.set({ pk: `DEVELOPER#${OLD_PRIYA}`, sk: "META", developerId: OLD_PRIYA, mergedInto: PRIYA });
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId, PRIYA);
    const meta = w.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === run.runId)[0]!;
    // The run was started under the duplicate's id, before the merge.
    w.db.set({ ...meta, startedBy: { kind: "member", developerId: OLD_PRIYA } });
    await w.endLatest({ branch: "fix" });
    const gate = waitingGate(w, run.runId);
    expect(await candidatesOfGate(w, gate.approvalId!)).toEqual(new Set([PRIYA, MAX, DANA]));
    const record = await w.approval(gate.approvalId!);
    expect(await gateEligible(w.deps, record, callerOf(PRIYA))).toBe(true);
    // And the duplicate's id, as a caller, is the survivor: their role and their start.
    expect(await gateEligible(w.deps, record, callerOf(OLD_PRIYA))).toBe(true);
    expect(await gateEligible(w.deps, record, callerOf(CARL))).toBe(false);
  });
});

describe("what a decision does to a run that moves under it", () => {
  it("finishes a decision whose next step could not start: the sweep's second telling starts it, once", async () => {
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    w.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "socket hang up"));
    expect((await w.decideAs(PRIYA, approvalId)).statusCode).toBe(200);
    expect(await w.approval(approvalId)).toMatchObject({ status: "APPROVED", handlerDone: false });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "approved" });
    expect(w.tasks.size).toBe(1);
    w.clock.now += 10 * 60_000;
    expect((await expireApprovals(w.deps, w.clock.now)).handled).toBe(1);
    expect(w.tasks.size).toBe(2);
    expect(w.attempts(run.runId)[2]).toMatchObject({ stepId: "fix", status: "running" });
    expect(w.decidedEvents(run.runId)).toHaveLength(1);
  });

  it("ends a gate whose approval expired before its attempt existed, as soon as the attempt does", async () => {
    const w = setupGateWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await w.start(chain.chainId);
    w.beforeTransaction("gate_waiting", () => { throw new Error("the process died"); });
    await expect(w.endLatest({ branch: "fix" })).rejects.toThrow("the process died");
    w.clock.now += 73 * HOUR;
    await expireApprovals(w.deps, w.clock.now);
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 1 });
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out" });
    expect(w.run(run.runId)!.failure).toMatchObject({ message: 'No one approved "Approve the fix" within 72 hours, so the chain stopped.' });
  });

  it("tries again when the run moved while an expiry was written", async () => {
    const w = setupGateWorld();
    const { run } = await w.runAtGate();
    w.beforeTransaction('"timed_out"', () => w.touchRun(run.runId));
    w.clock.now += 73 * HOUR;
    await expireApprovals(w.deps, w.clock.now);
    expect(w.run(run.runId)).toMatchObject({ status: "timed_out" });
  });

  it("does nothing for a run, an attempt or an approval that does not fit", async () => {
    const { recordGateDecision } = await runner();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const by = { approvalId, name: "Priya" };
    await recordGateDecision(w.deps, ORG_A, "crn_zzzzzzzzzzzzzzzzzzzz", 2, "approved", by);
    const attempt = w.db.find((item) => item.entityType === "CHAIN_RUN_STEP" && item.runId === run.runId && item.seq === 2)[0]!;
    w.db.set({ ...attempt, kind: "agent" });
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", by);
    w.db.delete(String(attempt.pk), String(attempt.sk));
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", by);
    expect(w.decidedEvents(run.runId)).toEqual([]);
    expect(w.starts).toHaveLength(1);
  });

  it("does not pass a gate whose attempt left `waiting` between the read and the write", async () => {
    const { recordGateDecision } = await runner();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    const attempt = w.db.find((item) => item.entityType === "CHAIN_RUN_STEP" && item.runId === run.runId && item.seq === 2)[0]!;
    w.beforeTransaction("gate_decided", () => { w.db.set({ ...attempt, status: "cancelled" }); });
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", { approvalId, name: "Priya" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "cancelled" });
    expect(w.decidedEvents(run.runId)).toEqual([]);
  });

  it("ignores a record that is not a chain gate's, without needing the chain runner", async () => {
    const { onChainGateDecided } = await gates();
    const w = setupGateWorld();
    const { approvalId } = await w.runAtGate();
    disposeGateWorlds();
    const bare = { documentClient: w.deps.documentClient, tableName: "T", now: w.deps.now };
    await expect(onChainGateDecided(bare as never, { ...(await w.stepApproval(approvalId)), subject: { kind: "agent_run", taskId: "t", stepId: "s" }, status: "APPROVED" })).resolves.toBeUndefined();
  });
});

describe("registration at broker start", () => {
  it("lets the broker's provider reach the runner for a decision, and takes it away again", async () => {
    const { onChainGateDecided } = await gates();
    const w = setupGateWorld();
    const { run, approvalId } = await w.runAtGate();
    disposeGateWorlds();
    const bare = { documentClient: w.deps.documentClient, tableName: "T", now: w.deps.now, signInStore: w.deps.signInStore, projectMembers: w.deps.projectMembers, store: w.deps.store, confirmOrigin: CELL };
    const decided = { ...(await w.stepApproval(approvalId)), status: "APPROVED" as const, decidedBy: PRIYA, decision: "APPROVE" as const };
    const off = registerChainRunner(() => w.deps);
    await onChainGateDecided(bare, decided);
    expect(w.run(run.runId)).toMatchObject({ currentSeq: 3 });
    off();
    await expect(onChainGateDecided(bare as never, decided)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("a rule's words are Plan 3's to show", () => {
  it("falls back to the generic words when a rule's own wording fails, and to the people it names when it has none", async () => {
    const { registerApproverRefusal } = await import("../../packages/broker/src/agents/approvals.js");
    const w = setupGateWorld();
    registerApprovalSubjectHandler("agent_run", async () => undefined);
    registerApproverRule("test_rule_no_words", async () => false);
    registerApproverRule("test_rule_bad_words", async () => false);
    registerApproverRefusal("test_rule_bad_words", async () => { throw new Error("the lookup broke"); });
    for (const rule of ["test_rule_no_words", "test_rule_bad_words"]) {
      const record = await createStepApproval(w.deps, {
        orgId: ORG_A, subject: { kind: "agent_run", taskId: `task-${rule}`, stepId: "gate" }, prompt: "Go on?", approvers: { kind: "rule", rule, candidates: [MAX] }, project: "web", owner: { developerId: PRIYA, name: "Priya" },
      });
      expect(await refusal(w.decideRoute(MAX, record.approvalId)), rule).toEqual({ code: "FORBIDDEN", message: "You can't decide this." });
      const page = await w.page(record.approvalId, { cookie: await w.session(MAX, record.approvalId) });
      expect(page.statusCode, rule).toBe(403);
      expect(page.body, rule).toContain("Only the people it was asked of can decide this.");
    }
  });
});
