// Design review stage, DR7 slice B: the guards of the dispatch and of the plan check's other ends, one by one, each with a case that fails without it. The whole round trip is in tests/contract/design-review-e2e.test.ts.
import { describe, expect, it, vi } from "vitest";
import { DESIGN_REVIEW_ROUNDS_MAX, DesignReviewBindingSchema, agentXError, designReviewDisagreements, type ModelSelection, type OrgId, type WorkflowArtifact, type WorkflowProgram } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema, closePlanCritique, createWorkflowSnapshot, decideWorkflow, enableDesignReview, resolveDesignReview, startDesignReview, submitDesignReview, submitWorkflowArtifact, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { designAnswersCommitItems, designAnswersHandler } from "../../packages/broker/src/design-review/answers.js";
import { DESIGN_REVIEW_DEFAULT_SETTING } from "@rovara-code/contracts";
import { markEffective } from "../../packages/broker/src/design-review/effective-setting.js";
import { designReviewCapability } from "../../packages/broker/src/design-review/capability.js";
import { closeEndedCheck, closeUnstartedCheck, resumeBlockedCheck } from "../../packages/broker/src/design-review/check-ends.js";
import { designReviewEnabled } from "../../packages/broker/src/design-review/switch.js";
import { ownDesignFindings, withOwnFindings } from "../../packages/broker/src/design-review/own-findings.js";
import { designSourcesOf, originOf, pinsOf, requirementIdsOf } from "../../packages/broker/src/design-review/round-inputs.js";
import { applyPlannerResolve } from "../../packages/broker/src/design-review/resolve-answer.js";
import { designResolvePrompt } from "../../packages/broker/src/design-review/resolve-run.js";
import { estimateDesignReviewUsd } from "../../packages/broker/src/design-review/estimate.js";
import { DesignReviewRoundStop, prepareDesignReviewRound, slotOf, type RoundInputs } from "../../packages/broker/src/design-review/round-start.js";
import type { DesignReviewRoundPorts, RoundSourceReaders } from "../../packages/broker/src/design-review/round-ports.js";
import type { PacketReaders } from "../../packages/broker/src/design-review/packet.js";
import { designReviewKeyIds, putSlotKey } from "../../packages/broker/src/design-review/slot-keys.js";
import { chatgptPlanUse } from "../../packages/broker/src/design-review/chatgpt-plan.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = "2026-11-03T12:00:00.000Z";
const LATER = "2026-11-03T12:05:00.000Z";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OWNER = "a".repeat(64);
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const hex = (n: number): string => n.toString(16).padStart(64, "0");

describe("the dr switch", () => {
  it("is on only when it is exactly 1", () => {
    expect(designReviewEnabled({ DESIGN_REVIEW_ENABLED: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", " 1", "1 ", "01", "yes"]) expect(designReviewEnabled(value === undefined ? {} : { DESIGN_REVIEW_ENABLED: value }), String(value)).toBe(false);
  });
});

describe("the capability of a design-review operation", () => {
  const everything = { modelPolicy: { stage: "plan_check" }, chatGptToken: true, candidateExport: true, groundingSource: true, workflowE2E: true, e2eModelBudget: true, feedbackBundles: true, feedbackApproval: true, modelAccess: true, agentSkills: true, agentTools: true, contextTools: true, setupAgent: true, nightlyResult: true, pullRequest: true, savedEnvBuild: true };
  const binding = DesignReviewBindingSchema.parse({ version: 1, round: 1, reviewers: [{ role: "critic", keySlot: "r1-critic", packetDigest: hex(1), model: { provider: "p", modelId: "m" } }] });

  it("is the packet and a model key by slot, and nothing else of the plan check's powers (an allowlist)", () => {
    expect(designReviewCapability(binding, everything)).toEqual({ modelAccess: true, designReviewPacket: true });
    expect(designReviewCapability(binding, { ...everything, modelAccess: false })).toEqual({ modelAccess: false, designReviewPacket: true });
  });

  it("leaves the options of an operation with no binding exactly as they were", () => {
    expect(designReviewCapability(undefined, everything)).toBe(everything);
  });
});

describe("the readings of a task and its documents", () => {
  it("finds the approved requirement ids, once each, in order; a document without R<n> ids has none", () => {
    expect(requirementIdsOf("# Requirements\n\nR2: second\n- R1: first\n**R3** third\nR1: again\nNot R9 here\n")).toEqual(["R2", "R1", "R3"]);
    expect(requirementIdsOf("1. A payment is retried.\n2. Never charged twice.")).toEqual([]);
  });

  it("turns section 8 into source names only: a repository defaults to the project's only one, an unreadable MCP ref is left out", () => {
    const design = (sources: unknown[]) => `# Design\n\n\`\`\`rovara-design-meta\n${JSON.stringify({ touches: [], repositories: [], services: [], sources })}\n\`\`\`\n`;
    const sources = [{ kind: "repo_file", ref: "src/a.ts" }, { kind: "repo_file", ref: "src/b.ts", repo: "other" }, { kind: "meta_repo_file", ref: "steering/rules.md" }, { kind: "mcp_item", ref: "tracker:ABC-1" }, { kind: "mcp_item", ref: "not-a-ref" }];
    expect(designSourcesOf(design(sources), ["demo"])).toEqual([
      { kind: "repo_file", repo: "demo", path: "src/a.ts" }, { kind: "repo_file", repo: "other", path: "src/b.ts" }, { kind: "meta_repo_file", path: "steering/rules.md" }, { kind: "mcp_item", sourceId: "tracker", itemRef: "ABC-1" },
    ]);
    // Two repositories and no name: not guessed.
    expect(designSourcesOf(design([{ kind: "repo_file", ref: "src/a.ts" }]), ["a", "b"])).toEqual([]);
    // A design with no readable block has no reading list.
    expect(designSourcesOf("# Design\nno block", ["demo"])).toEqual([]);
  });

  it("takes the pins from the task's prepared base", () => {
    expect(pinsOf([{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }])).toEqual({ demo: "e".repeat(40) });
    expect(pinsOf(undefined)).toEqual({});
  });

  it("withholds every source of the tracker a task came from (the item is not recorded), and nothing for other origins", () => {
    const sources = [{ sourceId: "lin", system: "linear" }, { sourceId: "jira1", system: "jira" }, { sourceId: "docs", system: "notion" }, { sourceId: "mystery" }];
    expect(originOf("linear", sources)).toEqual([{ sourceId: "lin", itemRef: "" }, { sourceId: "mystery", itemRef: "" }]);
    expect(originOf("jira", sources)).toEqual([{ sourceId: "jira1", itemRef: "" }, { sourceId: "mystery", itemRef: "" }]);
    expect(originOf("app", sources)).toEqual([]);
    expect(originOf(undefined, sources)).toEqual([]);
  });
});

describe("the broker's own findings and a reviewer that says the same (N6)", () => {
  it("folds a reviewer finding with an own finding's fingerprint into it: one finding, not a round the move would refuse", () => {
    const own = ownDesignFindings({ design: "## 3. Proposed design\nnothing", requirementIds: ["R1"] });
    expect(own).toHaveLength(1);
    const copy = { id: "m1", severity: "major" as const, section: "§3" as const, text: own[0]!.text, citations: [{ kind: "design" as const, section: "§3" as const }], fromReviewers: ["critic" as const], rawIds: ["critic-1"], fingerprint: own[0]!.fingerprint };
    const other = { ...copy, id: "m2", text: "Something else entirely.", fingerprint: hex(77) };
    const merged = withOwnFindings([copy, other], own);
    expect(merged.findings.map((finding) => finding.id)).toEqual([own[0]!.id, "m2"]);
    expect(new Set(merged.findings.map((finding) => finding.fingerprint)).size).toBe(merged.findings.length);
  });
});

// ---- the plan check's other ends

const PROGRAM: WorkflowProgram = { steps: [{ id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" }, { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" }] };
const artifact = (type: "requirements" | "design" | "plan", version = 1): WorkflowArtifact => ({ id: `a-${type}-${version}`, type, version, sha256: hex(version * 10 + (type === "design" ? 2 : type === "plan" ? 3 : 1)), producer: "agentx-worker-untrusted", objectKey: `k/${type}-${version}.md`, createdAt: NOW, format: "markdown" });
const running = (workflow: WorkflowSnapshot): WorkflowSnapshot => ({ ...workflow, revision: workflow.revision + 1, state: "RUNNING" });
const ready = (workflow: WorkflowSnapshot): WorkflowSnapshot => ({ ...workflow, state: "READY" });

function designSubmitted(): WorkflowSnapshot {
  let workflow = ready(createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW, path: "QUICK", definitionVersion: "1.1.0", program: PROGRAM }));
  workflow = enableDesignReview(workflow, { expectedRevision: workflow.revision, start: { decidedBy: "auto", reasons: ["new_api"], tier: "standard", capUsd: 10 }, now: NOW });
  workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("requirements"), now: NOW });
  workflow = decideWorkflow(workflow, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: workflow.revision, decision: "APPROVE", reason: "ok", artifactDigest: artifact("requirements").sha256 }, { actorId: OWNER, role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [] });
  return submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("design"), now: NOW });
}
const planChecked = (): WorkflowSnapshot => {
  const quick = ready(createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW, path: "QUICK", definitionVersion: "1.1.0", program: PROGRAM }));
  return submitWorkflowArtifact(running(quick), { expectedRevision: quick.revision + 1, artifact: artifact("plan"), now: NOW });
};

describe("the plan check's other ends, for a plan check and for a design review", () => {
  it("a plan check that cannot start, or whose run was lost or stopped, closes as it always did (the same snapshot closePlanCritique makes)", async () => {
    const check = planChecked();
    expect(check).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
    const expected = closePlanCritique(check, { expectedRevision: check.revision, status: "done", now: LATER });
    expect(closeUnstartedCheck(check, LATER)).toEqual(expected);
    expect(await closeEndedCheck({ documentClient: new FakeDynamoDb(), tableName: "state" }, check, { id: "op" }, LATER)).toEqual(expected);
  });

  it("a design review that cannot start is not run for want of a model, and the plan check's move (which refuses it) is not made", () => {
    const review = designSubmitted();
    expect(() => closePlanCritique(review, { expectedRevision: review.revision, status: "done", now: LATER })).toThrow();
    // B-m6: a start given up says so (it did not run); only a caller that knows no model can serve it says "no model source".
    expect(closeUnstartedCheck(review, LATER)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "worker_failed" } });
    expect(closeUnstartedCheck(review, LATER, "no_model_source")).toMatchObject({ designReview: { status: "not_run", notRunReason: "no_model_source" } });
  });

  it("a design review whose run was lost or stopped is not run, charges each key it asked for its whole budget, and the stored packets go", async () => {
    const db = new FakeDynamoDb();
    const table = { documentClient: db, tableName: "state" };
    const binding = DesignReviewBindingSchema.parse({ version: 1, round: 1, reviewers: [{ role: "critic", keySlot: "r1-critic", packetDigest: hex(1), model: { provider: "p", modelId: "m" } }, { role: "codebase", keySlot: "r1-codebase", packetDigest: hex(2), model: { provider: "p", modelId: "m" } }] });
    const operation = { id: "33333333-3333-4333-8333-333333333333", orgId: ORG, designReview: binding };
    // Only the critic's slot asked for a key (budget 0.6); a packet is stored for each.
    await putSlotKey(table, { orgId: ORG, operationId: operation.id, slot: "r1-critic", purpose: "reviewer", round: 1, keyId: hex(9), expiresAt: 1, budgetUsd: 0.6, alias: "m", nowMs: 1_000 });
    db.set({ pk: `ORG#${ORG}#DESIGN_REVIEW#${operation.id}`, sk: "PACKET#R1#r1-critic#HEAD", entityType: "DESIGN_REVIEW_PACKET" });
    const running1 = running(startDesignReview(designSubmitted(), { expectedRevision: designSubmitted().revision, estimateUsd: 1, now: NOW }));
    void running1;
    const started = startDesignReview(designSubmitted(), { expectedRevision: designSubmitted().revision, estimateUsd: 1, now: NOW });
    const next = await closeEndedCheck(table, started, operation, LATER);
    expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "worker_failed", spentUsd: 0.6 } });
    expect(db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET")).toEqual([]);
    expect((await designReviewKeyIds(table, operation as never)).bySlot.get("r1-critic")).toBe(hex(9));
  });

  it("a blocked design review resumes by its own move; a blocked plan check is not touched by it", async () => {
    const started = startDesignReview(designSubmitted(), { expectedRevision: designSubmitted().revision, estimateUsd: 1, now: NOW });
    const blocked = WorkflowSnapshotSchema.parse({ ...started, revision: started.revision + 1, state: "BLOCKED", blockReason: "Rovara could not verify the base rule files, so the step did not run." });
    const resumed = await resumeBlockedCheck({ documentClient: new FakeDynamoDb(), tableName: "state" }, "ws-1", blocked, LATER);
    // READY again, the cap checked again when it starts, nothing spent by a round that never ran, and the block's reason cleared.
    expect(resumed).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating", spentUsd: 0 } });
    expect(resumed).not.toHaveProperty("blockReason");
  });
});

// ---- the planner's answer

describe("the planner's answer to a round's findings", () => {
  const finding = (id: string, severity: "blocker" | "major" | "nit", text: string, sources: unknown[] = []) => ({ id, severity, section: "§3", text, citations: [{ kind: "design", section: "§3" }, ...sources], fromReviewers: ["critic"], rawIds: [`critic-${id}`], rawFindings: [{ rawId: `critic-${id}`, role: "critic", severity, text }], fingerprint: hex(Number(id.replace(/\D/gu, "")) + 100) });
  const run = (role: string, items: unknown[] = []) => ({ role, promptId: `design-review-${role}`, promptVersion: 2, promptDigest: hex(7), model: { provider: "p", modelId: "m" }, sourceId: "rovara", sessionId: `s-${role}`, modelKeyId: hex(20), packetDigest: hex(8), packet: items, filesRead: [], verified: true, inputProof: "digest_only", tokensIn: 1, tokensOut: 1, costUsd: 0.1, startedAt: NOW, endedAt: LATER });
  const SOURCE = { kind: "mcp_item", ref: "tracker:ABC-1", commitOrFetchedAt: "2026-11-03T10:00:00.000Z", digest: hex(55), bytes: 10 };
  /** A planner step standing at PLAN/RUNNING with round 1 recorded: one blocker and one major. */
  function planning(): WorkflowSnapshot {
    const started = startDesignReview(designSubmitted(), { expectedRevision: designSubmitted().revision, estimateUsd: 1, now: NOW });
    const round = submitDesignReview(started, { expectedRevision: started.revision, designDigest: artifact("design").sha256, reviewers: [run("critic", [SOURCE])], findings: [finding("1", "blocker", "Retries have no limit."), finding("2", "major", "No rollback is described.")], now: LATER });
    return running(round);
  }
  const block = (value: unknown): string => `The revised design.\n\n\`\`\`rovara-design-resolve\n${JSON.stringify(value)}\n\`\`\`\n`;
  const pins = { demo: "e".repeat(40) };
  const fixed = (id: string) => ({ findingId: id, action: "fixed", note: "Changed §3." });
  const contested = (id: string, evidence: unknown[]) => ({ findingId: id, action: "contested", note: "Already bounded.", evidence });

  it("records the resolutions and sends a changed design to round 2, priced afresh", () => {
    const next = applyPlannerResolve({ workflow: planning(), answer: block({ resolutions: [fixed("1"), fixed("2")] }), revisedDesign: artifact("design", 2), pins, now: LATER });
    expect(next).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY", designReview: { status: "estimating" } });
    expect(next.designReview!.rounds[0]!.resolutions.map((resolution) => [resolution.findingId, resolution.action, resolution.settled])).toEqual([["1", "fixed", false], ["2", "fixed", false]]);
  });

  it("opens the question card first when the planner asks and the round has not asked: the resolutions wait for the answers", () => {
    const questions = [{ id: "q1", unclear: "Which limit?", evidence: [{ kind: "design", section: "§3" }], options: [{ id: "a", label: "Three", consequence: "Most clear." }, { id: "b", label: "Five", consequence: "Slower." }], recommended: "a", why: "Fewer waits." }];
    const next = applyPlannerResolve({ workflow: planning(), answer: block({ resolutions: [{ findingId: "1", action: "asked", note: "A team rule.", questionId: "q1" }, fixed("2")], questions }), pins, now: LATER });
    expect(next).toMatchObject({ stage: "PLAN", state: "WAITING", designReview: { status: "waiting_answers" } });
    expect(next.designReview!.rounds[0]!.resolutions).toEqual([]);
  });

  describe("the question card's answer handler", () => {
    const questions = [{ id: "q1", unclear: "Which limit?", evidence: [{ kind: "design", section: "§3" }], options: [{ id: "a", label: "Three", consequence: "Most clear." }, { id: "b", label: "Five", consequence: "Slower." }], recommended: "a", why: "Fewer." }];
    const waiting = (): WorkflowSnapshot => applyPlannerResolve({ workflow: planning(), answer: block({ resolutions: [{ findingId: "1", action: "asked", note: "A team rule.", questionId: "q1" }, fixed("2")], questions }), pins: { demo: "e".repeat(40) }, now: LATER });
    const P = { priya: "b".repeat(64), arjun: "c".repeat(64), max: "e".repeat(64), own: "f".repeat(64), stranger: "d".repeat(64) } as const;
    const people = { complete: true, membershipVersion: 1, ownerIds: [P.own], eligibleIds: [P.own, P.max], lastEligibleLossAtMs: null } as never;
    const rig = (over: { workflow?: WorkflowSnapshot; notApproverIds?: string[]; members?: string[] } = {}) => {
      const commits: unknown[] = [];
      const handler = designAnswersHandler({
        context: async () => ({ taskId: TASK_ID, requesterId: P.priya, workflow: over.workflow ?? waiting(), setting: markEffective(DESIGN_REVIEW_DEFAULT_SETTING), edition: undefined, touches: [],
          directory: { people, projectMemberIds: over.members ?? [P.own, P.max, P.priya, P.arjun], notApproverIds: over.notApproverIds ?? [] } }),
        commit: async (_caller, write) => { commits.push(write); return "done"; }, now: () => Date.parse(LATER),
      });
      return { handler, commits };
    };
    const ask = (handler: ReturnType<typeof rig>["handler"], who: string, answers: unknown[] = [{ questionId: "q1", optionId: "a" }]) => handler({ developerId: who }, { taskId: TASK_ID, requestId: "r-1", answers });

    it("lets the requester answer, and commits the answers for the planner to run again; nobody else, no Auditor and no outsider can", async () => {
      const ok = rig();
      await expect(ask(ok.handler, P.priya)).resolves.toEqual({ kind: "done" });
      expect(ok.commits).toHaveLength(1);
      for (const who of [P.arjun, P.max, P.stranger]) {
        const other = rig();
        await expect(ask(other.handler, who), who).rejects.toThrow();
        expect(other.commits, who).toEqual([]);
      }
      const auditor = rig({ notApproverIds: [P.priya] });
      await expect(ask(auditor.handler, P.priya)).rejects.toThrow();
    });

    it("is gone, not refused, for a task that is not waiting for answers; and a bad answer is the request's fault, committed to nothing", async () => {
      const notWaiting = rig({ workflow: planning() });
      await expect(ask(notWaiting.handler, P.priya)).rejects.toThrow("no longer waiting");
      const bad = rig();
      await expect(ask(bad.handler, P.priya, [{ questionId: "q1", optionId: "zzz" }])).rejects.toThrow();
      await expect(ask(bad.handler, P.priya, [])).rejects.toThrow();
      expect(bad.commits).toEqual([]);
    });

    it("builds the answer and the planner's next run as one transaction: the contract move and a CRITIC_REPLAN row at the NEW revision", () => {
      const before = waiting();
      const commit = designAnswersCommitItems({ tableName: "state", taskId: TASK_ID, workflow: before, answers: [{ questionId: "q1", optionId: "a" }], actorId: P.priya, now: NOW });
      expect(commit.workflow).toMatchObject({ stage: "PLAN", state: "READY", designReview: { status: "resolving" } });
      expect(commit.items).toHaveLength(2);
      expect(commit.items[1]).toMatchObject({ Put: { Item: { kind: "CRITIC_REPLAN", workflowRevision: commit.workflow.revision, taskId: TASK_ID } } });
    });
  });

  it("checks a contest's evidence against what the round's reviewers were given: a source that was in the packet counts, one that was not is dropped and a contest left with only sources is refused (the design goes as reviewed)", () => {
    const real = { kind: "source", ref: SOURCE.ref, digest: SOURCE.digest };
    const invented = { kind: "source", ref: SOURCE.ref, digest: hex(56) };
    // A design citation holds the contest.
    const ok = applyPlannerResolve({ workflow: planning(), answer: block({ resolutions: [contested("1", [{ kind: "design", section: "§4" }, real]), fixed("2")] }), revisedDesign: artifact("design", 2), pins, now: LATER });
    expect(ok.designReview!.rounds[0]!.resolutions.find((resolution) => resolution.findingId === "1")).toMatchObject({ action: "contested", settled: true });
    // A real source alone is not enough (reader rule), and an invented digest is dropped: refused either way.
    for (const evidence of [[real], [invented, real]]) {
      expect(applyPlannerResolve({ workflow: planning(), answer: block({ resolutions: [contested("1", evidence), fixed("2")] }), revisedDesign: artifact("design", 2), pins, now: LATER }), JSON.stringify(evidence)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    }
  });

  it("checks a code citation against the BROKER's pins: one at a commit the broker did not pin is dropped, so a contest resting on it is refused", () => {
    const code = (commit: string) => ({ kind: "code", repo: "demo", path: "src/a.ts", startLine: 1, endLine: 2, anchor: "x", commit });
    const contestWith = (commit: string) => applyPlannerResolve({ workflow: planning(), answer: block({ resolutions: [contested("1", [code(commit)]), fixed("2")] }), revisedDesign: artifact("design", 2), pins, now: LATER });
    expect(contestWith("e".repeat(40)).designReview!.rounds[0]!.resolutions[0]).toMatchObject({ action: "contested" });
    expect(contestWith("d".repeat(40))).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "done" } });
  });

  describe("B2-m1: the last round does not ask, and a planner that asks anyway keeps its fixes", () => {
    /** The planner's step of round 2 (the last round): round 1's fixes were reviewed again and found a major, a nit and another major. */
    function planningLast(): WorkflowSnapshot {
      const second = applyPlannerResolve({ workflow: planning(), answer: block({ resolutions: [fixed("1"), fixed("2")] }), revisedDesign: artifact("design", 2), pins, now: LATER });
      const started = startDesignReview(second, { expectedRevision: second.revision, estimateUsd: 1, now: NOW });
      const round = submitDesignReview(started, { expectedRevision: started.revision, designDigest: artifact("design", 2).sha256, reviewers: [{ ...run("critic", [SOURCE]), sessionId: "s-critic-2", modelKeyId: hex(21) }], now: LATER,
        findings: [finding("3", "major", "The wait grows without a limit."), finding("4", "nit", "A name is unclear."), finding("5", "major", "Who owns the rollback?")] });
      return running(round);
    }
    const question = { id: "q1", unclear: "Who owns the rollback?", evidence: [{ kind: "design", section: "§5" }], options: [{ id: "a", label: "The team", consequence: "Quick." }, { id: "b", label: "Operations", consequence: "Slower." }], recommended: "a", why: "Closer to the code." };

    it("keeps the fix, leaves the asked and declined findings open as unresolved, and opens no question card (before the fix the whole answer was thrown away)", () => {
      const next = applyPlannerResolve({
        workflow: planningLast(), pins, now: LATER, revisedDesign: artifact("design", 3),
        answer: block({ resolutions: [fixed("3"), { findingId: "4", action: "declined", note: "Cosmetic." }, { findingId: "5", action: "asked", note: "A team rule.", questionId: "q1" }], questions: [question] }),
      });
      expect(next).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
      const last = next.designReview!.rounds[1]!;
      expect(last.resolutions.map((resolution) => [resolution.findingId, resolution.action])).toEqual([["3", "fixed"]]);
      expect(last.questions).toBeUndefined();
      expect(next.artifacts.filter((entry) => entry.type === "design").at(-1)!.version).toBe(3);
      // The major that was asked about is shown for the person as unresolved; the fixed one is an unchecked fix.
      expect(designReviewDisagreements(next.designReview).map((entry) => [entry.findingId, entry.kind])).toEqual([["3", "unchecked_fix"], ["5", "unresolved"]]);
    });

    it("positive control: round 1 still opens its question card, and a last round that only fixes and contests is unchanged", () => {
      const asked = applyPlannerResolve({ workflow: planning(), pins, now: LATER, answer: block({ resolutions: [{ findingId: "1", action: "asked", note: "A team rule.", questionId: "q1" }, fixed("2")], questions: [question] }) });
      expect(asked).toMatchObject({ stage: "PLAN", state: "WAITING", designReview: { status: "waiting_answers" } });
      const plain = applyPlannerResolve({ workflow: planningLast(), pins, now: LATER, revisedDesign: artifact("design", 3), answer: block({ resolutions: [fixed("3"), { findingId: "4", action: "fixed", note: "Renamed." }, { findingId: "5", action: "fixed", note: "Named the owner." }] }) });
      expect(plain.designReview!.rounds[1]!.resolutions.map((resolution) => resolution.action)).toEqual(["fixed", "fixed", "fixed"]);
    });

    it("the move itself leaves a finding open only in the last round", () => {
      expect(() => resolveDesignReview(planning(), { expectedRevision: planning().revision, leaveOpen: ["1"], resolutions: [{ findingId: "2", action: "fixed", note: "x", settled: false }], artifact: artifact("design", 2), now: LATER })).toThrow(/last round/);
      expect(() => resolveDesignReview(planningLast(), { expectedRevision: planningLast().revision, leaveOpen: ["nope"], resolutions: [], now: LATER })).toThrow(/open finding/);
    });

    it("tells the planner in its prompt: the last round may not ask or decline, a round already answered asks nothing new, and round 1 says nothing of the kind", () => {
      const design = { ref: "design-v1", revision: "abc", text: "# Design" };
      const lastRound = planningLast().designReview!.rounds[1]!;
      expect(designResolvePrompt({ design, round: lastRound })).toContain("NO QUESTIONS NOW: this is the last round");
      const round1 = planning().designReview!.rounds[0]!;
      expect(designResolvePrompt({ design, round: round1 })).not.toContain("NO QUESTIONS NOW");
      expect(designResolvePrompt({ design, round: round1 })).not.toContain("NO NEW QUESTIONS");
      const answered = { ...round1, questions: [question], answers: { by: { actorId: OWNER }, at: LATER, answers: [{ questionId: "q1", optionId: "a" }] } } as typeof round1;
      expect(designResolvePrompt({ design, round: answered })).toContain("NO NEW QUESTIONS NOW");
    });
  });

  it("sends the design on as reviewed, findings unresolved, when the answer cannot be read, misses a finding, or the move refuses it", () => {
    const unresolved = (answer: string, revisedDesign?: WorkflowArtifact) => applyPlannerResolve({ workflow: planning(), answer, ...(revisedDesign === undefined ? {} : { revisedDesign }), pins, now: LATER });
    for (const answer of ["I fixed everything.", block({ resolutions: [fixed("1")] }), block({ resolutions: [fixed("1"), fixed("2"), fixed("3")] })]) {
      expect(unresolved(answer), answer).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
    }
    // A fix with no changed design document is refused by the move, which makes it the planner's revision failing.
    expect(unresolved(block({ resolutions: [fixed("1"), fixed("2")] }))).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "done" } });
    expect(unresolved(block({ resolutions: [fixed("1"), fixed("2")] })).designReview!.rounds[0]!.resolutions).toEqual([]);
  });
});

// ---- the preparation of a round

describe("the preparation of a round", () => {
  const MODEL: ModelSelection = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
  const resolved = { operationId: "44444444-4444-4444-8444-444444444444", model: MODEL, modelRoute: undefined, sourceId: "rovara" };
  const PRICE = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };

  function ports(over: Partial<DesignReviewRoundPorts> = {}, extra: { readers?: Partial<PacketReaders>; origin?: RoundSourceReaders["origin"] } = {}) {
    const db = new FakeDynamoDb();
    const spies = {
      repo: vi.fn<PacketReaders["readRepoFile"]>(async ({ repo, path }) => `// ${repo}/${path}\n`),
      meta: vi.fn<PacketReaders["readMetaFile"]>(async ({ path }) => `# ${path}\n`),
      mcp: vi.fn<PacketReaders["fetchMcpItem"]>(async () => ({ ok: true as const, text: "<source-result>ABC-1</source-result>", fetchedAt: "2026-11-03T10:00:00.000Z" })),
    };
    const readers: PacketReaders = { readRepoFile: spies.repo, readMetaFile: spies.meta, fetchMcpItem: spies.mcp, ...extra.readers };
    const sourceReaders = vi.fn(async (): Promise<RoundSourceReaders> => ({ readers, repositoryNames: ["demo"], origin: extra.origin ?? [] }));
    const value: DesignReviewRoundPorts = {
      table: { documentClient: db, tableName: "state" }, now: () => Date.parse(NOW), proxy: () => ({ ok: true }), price: () => PRICE, capCeilingUsd: async () => undefined, taskRoomUsd: async () => 5,
      sourceReaders, ...over,
    };
    return { db, value, spies, sourceReaders };
  }
  const DESIGN_WITH_SOURCES = `# Design\n## 3. Proposed design\nR1.\n\n\`\`\`rovara-design-meta\n${JSON.stringify({ touches: [], repositories: [], services: [], sources: [{ kind: "repo_file", ref: "src/a.ts" }, { kind: "meta_repo_file", ref: "steering/rules.md" }, { kind: "mcp_item", ref: "tracker:ABC-1" }] })}\n\`\`\`\n`;
  function inputs(portsValue: DesignReviewRoundPorts, over: { workflow?: WorkflowSnapshot; design?: string; capUsd?: number } = {}): RoundInputs {
    const base = over.workflow ?? startReady();
    const workflow = over.capUsd === undefined ? base : WorkflowSnapshotSchema.parse({ ...base, designReview: { ...base.designReview!, capUsd: over.capUsd } });
    return {
      task: { taskId: TASK_ID, orgId: ORG, requestText: "Retry timed-out payments.", knowledgeCommit: "b".repeat(40), preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } as never,
      workflow, ports: portsValue,
      design: { ref: "design-v1", revision: "abc", text: over.design ?? DESIGN_WITH_SOURCES, sha256: artifact("design").sha256 }, requirements: { ref: "requirements-v1", revision: "abc", text: "R1: retry." },
    };
  }
  const startReady = (): WorkflowSnapshot => designSubmitted();
  const stopOf = async (call: Promise<unknown>) => { try { await call; } catch (error) { expect(error).toBeInstanceOf(DesignReviewRoundStop); return (error as DesignReviewRoundStop).stop; } throw new Error("the round was prepared"); };

  it("prepares a round: packets built by the broker with the task's pins, one binding with the registry's merge prompt, budgets allocated and packets stored under the operation", async () => {
    const p = ports();
    const prepared = await prepareDesignReviewRound(inputs(p.value), resolved);
    const binding = prepared.binding;
    expect(binding.reviewers.map((entry) => [entry.role, entry.keySlot])).toEqual([["comprehension", "r1-comprehension"], ["critic", "r1-critic"], ["codebase", "r1-codebase"]]);
    expect(binding.baseCommits).toEqual({ demo: "e".repeat(40) });
    expect(binding.merge).toMatchObject({ keySlot: "r1-merge", prompt: { id: "design-review-merge" } });
    // Read at the pinned commit, from the meta repository at the knowledge commit, and through the MCP reader.
    expect(p.spies.repo).toHaveBeenCalledWith(expect.objectContaining({ repo: "demo", path: "src/a.ts", commit: "e".repeat(40) }));
    expect(p.spies.meta).toHaveBeenCalledWith(expect.objectContaining({ path: "steering/rules.md", commit: "b".repeat(40) }));
    expect(p.spies.mcp).toHaveBeenCalledWith({ sourceId: "tracker", itemRef: "ABC-1" });
    // One read per source for the whole round, however many reviewers: they are all given the same bytes.
    expect(p.spies.repo.mock.calls).toHaveLength(1);
    expect(p.spies.mcp.mock.calls).toHaveLength(1);
    expect(p.db.find((item) => item.entityType === "DESIGN_REVIEW_ALLOCATION")).toHaveLength(1);
    expect(p.db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET" && String(item.sk).endsWith("#HEAD")).map((item) => item.keySlot).sort()).toEqual(["r1-codebase", "r1-comprehension", "r1-critic"]);
    expect(prepared.estimateUsd!).toBeGreaterThan(0);
    expect(slotOf(2, "zoom_out")).toBe("r2-zoom_out");
  });

  it("FU3: the cache discount is for Rovara's own route only: the same Bedrock model through a customer's own source is estimated at full input price", async () => {
    const bedrock = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5" };
    const cachePrice = () => ({ inputUsdPerMTok: 1.1, outputUsdPerMTok: 5.5, cacheReadUsdPerMTok: 0.11, cacheWriteUsdPerMTok: 1.375 });
    const estimateVia = async (sourceId: string) => (await prepareDesignReviewRound(inputs(ports({ price: cachePrice, taskRoomUsd: async () => 1_000 }).value, { capUsd: 100 }), { ...resolved, model: bedrock, sourceId })).estimateUsd!;
    const own = await estimateVia("customer-bedrock");
    const rovara = await estimateVia("rovara");
    expect(rovara).toBeLessThan(own);
    // The same model on Rovara's route with no cache price is the customer-route figure: the discount is the only difference.
    const noCache = (await prepareDesignReviewRound(inputs(ports({ price: () => ({ inputUsdPerMTok: 1.1, outputUsdPerMTok: 5.5 }), taskRoomUsd: async () => 1_000 }).value, { capUsd: 100 }), { ...resolved, model: bedrock })).estimateUsd!;
    expect(own).toBeCloseTo(noCache, 6);
  });

  it("B2-M1: the review's room is held back for BOTH planner runs of a round that may ask (3 for two rounds), not one per round: the reviewers' ceilings add up to the cap less that", async () => {
    const p = ports({ taskRoomUsd: async () => 100 });
    await prepareDesignReviewRound(inputs(p.value, { capUsd: 10 }), resolved);
    const allocation = p.db.find((item) => item.entityType === "DESIGN_REVIEW_ALLOCATION")[0]!;
    const planner = estimateDesignReviewUsd({ tier: "standard", models: { reviewer: MODEL, merge: MODEL, planner: MODEL }, price: () => ({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 }), packetTokens: 1_000 });
    if (planner.kind !== "priced") throw new Error("priced");
    const oneRun = planner.breakdown.plannerUsd / 3;
    expect(allocation.totalUsd as number).toBeLessThanOrEqual(10 - 3 * oneRun + 1e-6);
    expect(allocation.totalUsd as number).toBeGreaterThan(10 - 3 * oneRun - 1e-3);
  });

  it("no proxy: not run before anything is read, built, stored or allocated", async () => {
    const p = ports({ proxy: () => ({ ok: false, notRunReason: "no_verified_model" }) });
    expect(await stopOf(prepareDesignReviewRound(inputs(p.value), resolved))).toEqual({ kind: "not_run", reason: "no_verified_model" });
    expect(p.sourceReaders).not.toHaveBeenCalled();
    expect(p.db.find(() => true)).toEqual([]);
  });

  it("no model, or only a person's ChatGPT plan, serves a reviewer: not run for want of a model source, nothing built", async () => {
    for (const model of [{ ...resolved, model: undefined }, { ...resolved, sourceId: undefined }, { ...resolved, sourceId: "personal-chatgpt" }]) {
      const p = ports();
      expect(await stopOf(prepareDesignReviewRound(inputs(p.value), model))).toEqual({ kind: "not_run", reason: "no_model_source" });
      expect(p.sourceReaders).not.toHaveBeenCalled();
    }
  });

  it("an estimate over the cap holds for the person's spend decision, and nothing is stored or allocated; a price the catalog lacks holds as unavailable", async () => {
    const over = ports();
    const stop = await stopOf(prepareDesignReviewRound(inputs(over.value, { capUsd: 0.5 }), resolved));
    expect(stop).toMatchObject({ kind: "hold" });
    expect((stop as { estimateUsd?: number }).estimateUsd).toBeGreaterThan(0.5);
    const unpriced = ports({ price: () => undefined });
    expect(await stopOf(prepareDesignReviewRound(inputs(unpriced.value), resolved))).toEqual({ kind: "hold", estimateUsd: undefined });
    for (const p of [over, unpriced]) expect(p.db.find(() => true)).toEqual([]);
  });

  it("B-m7: an estimate over the cap on the size of the design and the requirements alone holds BEFORE any source is read, so a hold wastes no read and logs no fetch under an operation that never exists", async () => {
    const p = ports();
    expect(await stopOf(prepareDesignReviewRound(inputs(p.value, { capUsd: 0.5, design: `${DESIGN_WITH_SOURCES}\n${"x".repeat(200_000)}\n` }), resolved))).toMatchObject({ kind: "hold" });
    expect(p.sourceReaders).not.toHaveBeenCalled();
    expect(p.spies.repo).not.toHaveBeenCalled();
    expect(p.spies.mcp).not.toHaveBeenCalled();
    // Positive control: with room, the same inputs do read their sources.
    const ok = ports();
    await prepareDesignReviewRound(inputs(ok.value), resolved);
    expect(ok.spies.repo).toHaveBeenCalled();
  });

  it("B-m2: the task's own run limit is a gate of its own: room for less than a round is not run for the TASK's limit, though the review cap has room, and nothing is stored; enough room runs", async () => {
    for (const room of [0, 0.0001]) {
      const p = ports({ taskRoomUsd: async () => room });
      expect(await stopOf(prepareDesignReviewRound(inputs(p.value), resolved)), String(room)).toEqual({ kind: "not_run", reason: "task_limit" });
      expect(p.db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET" || item.entityType === "DESIGN_REVIEW_ALLOCATION")).toEqual([]);
    }
    await expect(prepareDesignReviewRound(inputs(ports({ taskRoomUsd: async () => 5 }).value), resolved)).resolves.toBeDefined();
  });

  it("an unpriced run a person approved goes on past \"cost unavailable\"; the same inputs without the approval hold; an estimate over the cap is never lifted by an approval", async () => {
    const unpriced = () => ports({ price: () => undefined });
    expect(await stopOf(prepareDesignReviewRound(inputs(unpriced().value), resolved))).toEqual({ kind: "hold", estimateUsd: undefined });
    const prepared = await prepareDesignReviewRound({ ...inputs(unpriced().value), costApprovedBy: "person-1" }, resolved);
    expect(prepared.estimateUsd).toBeUndefined();
    expect(prepared.binding.reviewers).toHaveLength(3);
    const over = ports();
    expect(await stopOf(prepareDesignReviewRound({ ...inputs(over.value, { capUsd: 0.5, design: `${DESIGN_WITH_SOURCES}\n${"x".repeat(200_000)}\n` }), costApprovedBy: "person-1" }, resolved))).toMatchObject({ kind: "hold" });
  });

  it("prices the REAL packet: a bigger packet costs more, and round 2 prices one round, not two", async () => {
    const small = await prepareDesignReviewRound(inputs(ports().value, { design: "# Design\n## 3. Proposed design\nR1.\n" }), resolved);
    // A 200 KB design is about 50k tokens: at the calibrated turn factors (FU3) that is over the default cap, so this round has a high cap and the task has room.
    const big = await prepareDesignReviewRound(inputs(ports({ taskRoomUsd: async () => 1_000 }).value, { capUsd: 100, design: `# Design\n## 3. Proposed design\nR1.\n${"x".repeat(200_000)}\n` }), resolved);
    expect(big.estimateUsd!).toBeGreaterThan(small.estimateUsd!);
    // Round 2: the review has one round recorded; the estimate is for the one round still to run.
    const round2 = await prepareDesignReviewRound(inputs(ports().value, { design: "# Design\n## 3. Proposed design\nR1.\n", workflow: roundTwoWorkflow() }), resolved);
    expect(round2.estimateUsd!).toBeLessThan(small.estimateUsd!);
    expect(round2.binding.round).toBe(2);
    expect(round2.binding.reviewers.map((entry) => entry.keySlot)).toEqual(["r2-comprehension", "r2-critic", "r2-codebase"]);
    expect(DESIGN_REVIEW_ROUNDS_MAX).toBe(2);
  });

  function roundTwoWorkflow(): WorkflowSnapshot {
    const started = startDesignReview(designSubmitted(), { expectedRevision: designSubmitted().revision, estimateUsd: 1, now: NOW });
    const run = { role: "critic", promptId: "p", promptVersion: 1, promptDigest: hex(7), model: { provider: "p", modelId: "m" }, sourceId: "rovara", sessionId: "s", modelKeyId: hex(20), packetDigest: hex(8), packet: [], filesRead: [], verified: true, inputProof: "digest_only", tokensIn: 1, tokensOut: 1, costUsd: 0.1, startedAt: NOW, endedAt: LATER };
    const finding = { id: "1", severity: "blocker", section: "§3", text: "Retries have no limit.", citations: [{ kind: "design", section: "§3" }], fromReviewers: ["critic"], rawIds: ["critic-1"], rawFindings: [{ rawId: "critic-1", role: "critic", severity: "blocker", text: "Retries have no limit." }], fingerprint: hex(1) };
    const round1 = submitDesignReview(started, { expectedRevision: started.revision, designDigest: artifact("design").sha256, reviewers: [run], findings: [finding], now: LATER });
    const resolved2 = applyPlannerResolve({ workflow: running(round1), answer: `x\n\n\`\`\`rovara-design-resolve\n${JSON.stringify({ resolutions: [{ findingId: "1", action: "fixed", note: "Changed §3." }] })}\n\`\`\`\n`, revisedDesign: artifact("design", 2), pins: {}, now: LATER });
    expect(resolved2).toMatchObject({ stage: "PLAN_CRITIQUE", state: "READY" });
    return resolved2;
  }

  it("the budgets are held under what the task has left: a task with no room for the round is not run for the TASK's limit (not the review cap), and nothing is stored", async () => {
    const p = ports({ taskRoomUsd: async () => 0 });
    expect(await stopOf(prepareDesignReviewRound(inputs(p.value), resolved))).toEqual({ kind: "not_run", reason: "task_limit" });
    expect(p.db.find((item) => item.entityType === "DESIGN_REVIEW_PACKET")).toEqual([]);
  });

  it("a packet that cannot be built stops the round (inputs unverified); a store that fails after the budgets leaves the review not run, never a half-dispatched round", async () => {
    const p = ports();
    expect(await stopOf(prepareDesignReviewRound(inputs(p.value, { design: "" }), resolved))).toMatchObject({ kind: "not_run" });
    const failing = ports();
    failing.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("DESIGN_REVIEW_PACKET"), error: { name: "InternalServerError" } });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await stopOf(prepareDesignReviewRound(inputs(failing.value), resolved))).toEqual({ kind: "not_run", reason: "worker_failed" });
  });

  it("passes the task's origin to the readers and to the builder: an item of the tracker the task came from is left out of the packet", async () => {
    const p = ports({}, { origin: [{ sourceId: "tracker", itemRef: "" }] });
    const prepared = await prepareDesignReviewRound(inputs(p.value), resolved);
    expect(p.spies.mcp).not.toHaveBeenCalled();
    expect(prepared.binding.reviewers).toHaveLength(3);
  });

  it("no cap on the record stops the review at the cap before anything is read", async () => {
    const p = ports();
    const workflow = WorkflowSnapshotSchema.parse({ ...startReady(), designReview: { ...startReady().designReview!, capUsd: undefined } });
    expect(await stopOf(prepareDesignReviewRound(inputs(p.value, { workflow }), resolved))).toEqual({ kind: "at_cap" });
    expect(p.sourceReaders).not.toHaveBeenCalled();
    void agentXError;
  });
});

describe("B-m5: a design review never runs on a person's ChatGPT plan, however the stage is governed", () => {
  // Every input the operation builder can have, exhaustively: the plan is used only when it is not a design review.
  it("keeps the plan for no design review round, whether the task's selection or a governed stage's personal source asked for it, and keeps today's answer for every other step", () => {
    for (const dropChatgpt of [false, true]) for (const agentRun of [false, true]) for (const governedPersonal of [false, true]) {
      const review = chatgptPlanUse({ dropChatgpt, agentRun, designReview: true, governedPersonal });
      expect(review, JSON.stringify({ dropChatgpt, agentRun, governedPersonal })).toEqual({ selection: false, governed: false });
      const other = chatgptPlanUse({ dropChatgpt, agentRun, designReview: false, governedPersonal });
      expect(other).toEqual({ selection: !dropChatgpt && !agentRun, governed: governedPersonal });
    }
  });
});
