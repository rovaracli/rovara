// Setup and test health SH16: the three new environment codes, every code's class, the Fix setup mapping of an ask, and the limits that must not move.
import { describe, expect, it } from "vitest";
import {
  AUTO_FIX_CODES, AUTO_FIX_CODE_CLASS, AUTO_FIX_DEFAULT_CAP_USD, AUTO_FIX_BASELINE_REQUEST_LIMIT, AUTO_FIX_ENVIRONMENT_CODES, WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX,
  WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX, WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX,
  WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_AUTO_ACTION_LIMIT, WORKFLOW_AUTO_RETRY_LIMIT, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE,
  WORKFLOW_AUTO_SEND_BACK_LIMIT, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WorkflowDecisionRecordSchema, WorkflowSnapshotSchema, autoFixAskCard, autoFixDecision,
  classifyBlockedWorkflow, createCandidateManifest, createWorkflowSnapshot, wholeTaskSpendUsd,
  type AutoFixAskReason, type AutoFixBudget, type AutoFixCode, type AutoFixFacts, type WorkflowDecision, type WorkflowSnapshot,
} from "@agentx/contracts";
import { autoFixCodeSentence } from "../../packages/broker/src/developer/autofix-messages.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const NOW = "2026-11-01T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const roundId = "11111111-1111-4111-8111-111111111111";
const groupRunId = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (char: string): string => char.repeat(64);
type Over = Record<string, unknown>;

const budget = (over: Partial<AutoFixBudget> = {}): AutoFixBudget => ({ enabled: true, dayBudgetHasRoom: true, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(2), roundEstimateUsd: 2, capUsd: 15 }, ...over });
const approval = (n: number): WorkflowDecision => WorkflowDecisionRecordSchema.parse({ requestId: uuid(n), workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "approved", artifactDigest: hex("b"), at: NOW });
const automatic = (n: number, source: "AUTO_FIX" | "AUTO_RETRY", stage: "VERIFY" | "REVIEW" = "VERIFY"): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "automatic", source, at: NOW, auto: { stage, candidateDigest: candidate.digest },
});
const blocked = (stage: "VERIFY" | "REVIEW", reason: string | undefined, over: Over = {}): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId, now: NOW }), revision: 7, stage, state: "BLOCKED", ...(reason === undefined ? {} : { blockReason: reason }), candidate, decisions: [approval(1)], ...over,
});
const e2eProgress = (over: Over = {}): Over => ({ contractDigest: hex("c"), policyDigest: hex("d"), bundleDigest: hex("e"), executionPlanDigest: hex("f"), required: true, currentRoundId: roundId, currentGroupRunIds: [groupRunId], resultRefs: [], ...over });
const incomplete = (...entries: string[]): string => `${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (${entries.join("; ")})`;
const verifyE2e = (reason: string, over: Over = {}) => blocked("VERIFY", reason, { e2e: e2eProgress(), ...over });
const results = (rows: Over[]): Over => ({ verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: rows } });
const review = (role: "CRITIC" | "SECURITY", status: string, findings: Over[] = [], over: Over = {}): Over => ({
  operationId: uuid(role === "CRITIC" ? 90 : 91), candidateDigest: candidate.digest, role, provider: "p", version: "1", status, findings, readOnly: true, recordedAt: NOW, ...over,
});
const decide = (workflow: WorkflowSnapshot, facts: AutoFixFacts = {}, over: Partial<AutoFixBudget> = {}) => autoFixDecision(workflow, facts, budget(over));
const classOf = (workflow: WorkflowSnapshot, facts: AutoFixFacts = {}) => classifyBlockedWorkflow(workflow, facts);

/** A real blocked workflow (or the facts) that yields each code, so the class table is checked against the classifier and not against itself. `pull-request-open` is added below. */
const SOURCES: Record<Exclude<AutoFixCode, "pull-request-open">, () => [WorkflowSnapshot, AutoFixFacts?]> = {
  "build-failed": () => [verifyE2e(incomplete("g1: build-failed"))], "app-exited": () => [verifyE2e(incomplete("g1: app-exited"))], "app-unhealthy": () => [verifyE2e(incomplete("g1: app-unhealthy"))],
  "seed-failed": () => [verifyE2e(incomplete("g1: seed-failed"))],
  "e2e-assertion-failed": () => [verifyE2e("one or more admitted E2E groups failed", { e2e: e2eProgress({ failedRound: { status: "FAILED", candidateDigest: candidate.digest, roundId, groupRunIds: [groupRunId], admissionSha256: hex("7"), evidenceSha256: hex("8") } }) })],
  "check-failed": () => [blocked("VERIFY", undefined, results([{ checkId: "c", status: "FAILED" }])), { checkOriginal: { c: "passed" } }],
  "review-findings": () => [blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FINDINGS", [{ text: "bug", origin: "INTRODUCED" }]), review("SECURITY", "PASS")] })],
  "regression-found": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.regressionFound)],
  "round-refused": () => [verifyE2e(`${WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX}the build source is unusable.`)],
  "deadline-exceeded": () => [verifyE2e(incomplete("g1: deadline-exceeded"))], "executor-failed": () => [verifyE2e(incomplete("g1: executor-failed"))],
  "executor-result-mismatch": () => [verifyE2e(incomplete("g1: executor-result-mismatch"))], "mock-unavailable": () => [verifyE2e(incomplete("g1: mock-unavailable"))],
  "model-channel-unavailable": () => [verifyE2e(incomplete("g1: model-channel-unavailable"))], cancelled: () => [verifyE2e(incomplete("g1: cancelled"))],
  "evidence too large": () => [verifyE2e(incomplete("g1: evidence too large"))],
  "check-runner-failed": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed)],
  "check-not-started": () => [blocked("VERIFY", undefined, results([{ checkId: "c", status: "FAILED", neverStarted: true }]))],
  "review-not-run": () => [blocked("REVIEW", WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE)],
  "review-run-failed": () => [blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FAILED", [], { failureReason: "TIMEOUT" }), review("SECURITY", "PASS")] })],
  "provider-outage": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), { providerOutage: true }], "runner-busy": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), { runnerBusy: true }],
  "setup-failed-in-task": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), { setupFailedInTask: true }],
  "host-blocked": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), { hostBlocked: true }],
  "build-host-offline": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), { buildHostOffline: true }],
  "runtime-renewed": () => [verifyE2e(`${WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX}the test machine was renewed`)],
  "runtime-expired": () => [verifyE2e(incomplete("g1: runtime-expired"))], "runtime-environment-drifted": () => [verifyE2e(incomplete("g1: runtime-environment-drifted"))],
  "model-environment-unsafe": () => [verifyE2e(incomplete("g1: model-environment-unsafe"))], "login-failed": () => [verifyE2e(incomplete("g1: login-failed"))],
  "model-route-changed-reapprove": () => [verifyE2e(incomplete("g1: model-route-changed-reapprove"))], "agent-route-not-approved": () => [verifyE2e(incomplete("g1: agent-route-not-approved"))],
  "model-route-not-tested": () => [verifyE2e(incomplete("g1: model-route-not-tested"))],
  "runtime-unusable": () => [verifyE2e(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}no runtime`)],
  "selection-changed": () => [verifyE2e(`${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}selection`)], "accounts-changed": () => [verifyE2e(`${WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX}accounts`)],
  "plan-not-approvable": () => [verifyE2e(`${WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX}why`)], "history-rewritten": () => [verifyE2e(WORKFLOW_HISTORY_REWRITTEN_MESSAGE)],
  "cancelled-by-owner": () => [verifyE2e(incomplete("g1: cancelled")), { ownerCancelled: true }],
  "check-broken": () => [blocked("VERIFY", undefined, results([{ checkId: "c", status: "FAILED", broken: true }]))],
  "fails-on-original-code": () => [blocked("VERIFY", undefined, results([{ checkId: "c", status: "FAILED" }])), { checkOriginal: { c: "failed" } }],
  "review-unusable": () => [blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FAILED", [], { failureReason: "CANDIDATE_CHANGED" }), review("SECURITY", "PASS")] })],
  "rule-files-unverified": () => [blocked("REVIEW", WORKFLOW_BLOCK_REASONS.ruleFilesUnverified)],
  "setup-changed-files": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.setupChangedFiles)], "leftover-processes": () => [blocked("VERIFY", WORKFLOW_BLOCK_REASONS.leftoverProcesses)],
  "unknown-group-code": () => [verifyE2e(incomplete("g1: brand-new-code"))], unreadable: () => [blocked("VERIFY", "a block reason nobody has ever seen")],
  "dispatch-exhausted": () => [blocked("VERIFY", "x"), { blockCause: "dispatch-exhausted" }], "run-lost": () => [blocked("VERIFY", "x"), { blockCause: "run-lost" }], "owner-stopped": () => [blocked("VERIFY", "x"), { blockCause: "owner-stopped" }],
  "e2e-evidence-unknown": () => [verifyE2e(`${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (evidence floor unmet)`)],
  "check-result-unknown": () => [blocked("VERIFY", undefined, results([{ checkId: "c", status: "UNKNOWN" }]))],
  "check-failed-cause-unknown": () => [blocked("VERIFY", undefined, results([{ checkId: "c", status: "FAILED" }]))],
};

describe("every code's class (design 4.2)", () => {
  it("places every code once, and the table has no other", () => {
    expect(Object.keys(AUTO_FIX_CODE_CLASS).sort()).toEqual([...AUTO_FIX_CODES].sort());
    expect(new Set(AUTO_FIX_CODES).size).toBe(AUTO_FIX_CODES.length);
  });

  it("keeps the table equal to what the classifier really says for each code", () => {
    for (const [name, make] of Object.entries(SOURCES)) {
      const [workflow, facts] = make();
      const entry = classOf(workflow, facts).find((signal) => signal.code === name);
      expect(entry, `${name} is produced`).toBeDefined();
      expect(entry?.class, `${name} class`).toBe(AUTO_FIX_CODE_CLASS[name as AutoFixCode]);
    }
  });

  it("classes an open pull request as a person's, beside whatever else blocked", () => {
    const withPullRequest = WorkflowSnapshotSchema.parse({ ...verifyE2e(incomplete("g1: build-failed")), pullRequests: [{
      repositoryId: "app", number: 4, url: "https://github.com/o/r/pull/4", required: true, candidateDigest: candidate.digest, state: "OPEN", headSha: "6".repeat(40), observedAt: NOW,
    }] });
    expect(classOf(withPullRequest).find((signal) => signal.code === "pull-request-open")?.class).toBe(AUTO_FIX_CODE_CLASS["pull-request-open"]);
    expect(AUTO_FIX_CODE_CLASS["pull-request-open"]).toBe("person");
  });

  it("lists the codes by class as the design says", () => {
    const by = (kind: string) => AUTO_FIX_CODES.filter((entry) => AUTO_FIX_CODE_CLASS[entry] === kind);
    expect(by("code")).toEqual(["build-failed", "app-exited", "app-unhealthy", "seed-failed", "e2e-assertion-failed", "check-failed", "review-findings", "regression-found", "round-refused"]);
    for (const entry of ["setup-failed-in-task", "host-blocked", "build-host-offline"] as const) expect(AUTO_FIX_CODE_CLASS[entry]).toBe("transient");
  });
});

describe("the three new environment codes", () => {
  const NEW = [["setup-failed-in-task", { setupFailedInTask: true }], ["host-blocked", { hostBlocked: true }], ["build-host-offline", { buildHostOffline: true }]] as const;
  const base = () => blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed);

  it("retries once, like any infrastructure fault, and records the code", () => {
    for (const [name, facts] of NEW) expect(decide(base(), facts)).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["check-runner-failed", name] });
  });

  it("asks after the one retry, naming the retry limit", () => {
    for (const [name, facts] of NEW) {
      const used = blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed, { decisions: [approval(1), automatic(2, "AUTO_RETRY")] });
      expect(decide(used, facts)).toEqual({ action: "ASK", reason: "retry-limit", codes: ["check-runner-failed", name] });
    }
  });

  it("are not a code fault: they never send back alone, and code still wins when mixed", () => {
    for (const [, facts] of NEW) {
      expect(decide(verifyE2e(incomplete("g1: executor-failed")), facts).action).toBe("RETRY");
      expect(decide(verifyE2e(incomplete("g1: build-failed")), facts)).toMatchObject({ action: "SEND_BACK" });
      expect(decide(verifyE2e(incomplete("g1: login-failed")), facts)).toMatchObject({ action: "ASK", reason: "needs-a-person" });
    }
  });

  it("are off unless the fact is exactly true, and a block with nothing else stays unreadable", () => {
    for (const falsy of [false, undefined, "true", 1, null] as const) {
      expect(classOf(base(), { setupFailedInTask: falsy as never, hostBlocked: falsy as never, buildHostOffline: falsy as never }).map((entry) => entry.code)).toEqual(["check-runner-failed"]);
    }
    expect(classOf(blocked("VERIFY", "x"), { hostBlocked: true }).map((entry) => entry.code)).toEqual(["host-blocked"]);
  });

  it("have a sentence for the card", () => {
    for (const [name] of NEW) expect(autoFixCodeSentence(name)).toMatch(/^[A-Z].+\.$/u);
    for (const entry of AUTO_FIX_CODES) expect(autoFixCodeSentence(entry).length).toBeGreaterThan(10);
  });
});

describe("limits do not move", () => {
  it("keeps every existing limit exactly", () => {
    expect([WORKFLOW_AUTO_SEND_BACK_LIMIT, WORKFLOW_AUTO_RETRY_LIMIT, WORKFLOW_AUTO_ACTION_LIMIT, AUTO_FIX_DEFAULT_CAP_USD, AUTO_FIX_BASELINE_REQUEST_LIMIT]).toEqual([2, 1, 6, 15, 1]);
  });

  it("still sends back twice, retries once, stops at 6 actions, 100 decisions and the spend cap", () => {
    const buildFailed = (decisions: WorkflowDecision[]) => verifyE2e(incomplete("g1: build-failed"), { decisions });
    expect(decide(buildFailed([approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX")]))).toMatchObject({ action: "ASK", reason: "send-back-limit" });
    const six = [approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX"), approval(4), automatic(5, "AUTO_FIX"), automatic(6, "AUTO_FIX"), approval(7), automatic(8, "AUTO_RETRY", "REVIEW"), automatic(9, "AUTO_RETRY", "REVIEW")];
    expect(decide(buildFailed(six))).toMatchObject({ action: "ASK", reason: "total-limit" });
    expect(decide(buildFailed([approval(1)]), {}, { spend: { spentUsd: wholeTaskSpendUsd(14), roundEstimateUsd: 2, capUsd: 15 } })).toMatchObject({ action: "ASK", reason: "spend-cap" });
    expect(decide(buildFailed([approval(1)]), { hostBlocked: true }, { dayBudgetHasRoom: false })).toMatchObject({ action: "ASK", reason: "day-budget" });
    const retryHost = (decisions: WorkflowDecision[]) => blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed, { decisions });
    expect(decide(retryHost([approval(1)]), { hostBlocked: true }, { spend: { spentUsd: wholeTaskSpendUsd(14), roundEstimateUsd: 2, capUsd: 15 } })).toMatchObject({ action: "ASK", reason: "spend-cap" });
    expect(decide(retryHost([approval(1)]), { hostBlocked: true }, { enabled: false })).toEqual({ action: "NONE" });
  });
});

describe("autoFixAskCard: Fix setup instead of the generic ask", () => {
  const card = (reason: AutoFixAskReason, codes: AutoFixCode[], stage: "VERIFY" | "REVIEW" = "VERIFY") => autoFixAskCard({ reason, codes }, stage);

  it("is Fix setup for every environment code alone, whichever the reason (a person's fault, the used retry, the original-code failure)", () => {
    for (const entry of AUTO_FIX_ENVIRONMENT_CODES) {
      expect(card("needs-a-person", [entry]), entry).toBe("fix_setup");
      expect(card("retry-limit", [entry]), entry).toBe("fix_setup");
    }
    expect(card("original-code-also-fails", ["fails-on-original-code"])).toBe("fix_setup");
  });

  it("keeps the generic ask, naming the limit, for every limit reason even with environment codes only (review fix 2)", () => {
    expect(card("spend-cap", ["runner-busy"])).toBe("ask");
    for (const reason of ["spend-cap", "day-budget", "total-limit", "history-full", "send-back-limit"] as const) {
      for (const entry of AUTO_FIX_ENVIRONMENT_CODES) expect(card(reason, [entry]), `${reason} ${entry}`).toBe("ask");
    }
  });

  it("is the generic ask when a fault the code caused is in the ask: code still wins", () => {
    expect(card("needs-a-person", ["build-failed", "login-failed"])).toBe("ask");
    expect(card("send-back-limit", ["build-failed"])).toBe("ask");
    expect(card("retry-limit", ["check-failed", "executor-failed"])).toBe("ask");
  });

  it("is the generic ask for anything that is not the environment: reviews, the owner's stop, AI navigation, unclear faults, unreadable blocks", () => {
    for (const entry of AUTO_FIX_CODES.filter((name) => !(AUTO_FIX_ENVIRONMENT_CODES as readonly string[]).includes(name))) expect(card("needs-a-person", [entry]), entry).toBe("ask");
    expect(card("owner-stopped", ["executor-failed"])).toBe("ask");
    expect(card("unclear-fault", ["executor-failed"])).toBe("ask");
    expect(card("inputs-missing", ["executor-failed"])).toBe("ask");
    expect(card("needs-a-person", ["login-failed", "model-route-not-tested"])).toBe("ask");
    expect(card("needs-a-person", [])).toBe("ask");
  });

  it("ignores an open pull request beside environment codes, but not alone", () => {
    expect(card("needs-a-person", ["login-failed", "pull-request-open"])).toBe("fix_setup");
    expect(card("needs-a-person", ["pull-request-open"])).toBe("ask");
  });

  it("at a blocked REVIEW the tests already passed: only the workspace that could not be cleaned is the environment", () => {
    expect(card("needs-a-person", ["leftover-processes"], "REVIEW")).toBe("fix_setup");
    for (const entry of ["provider-outage", "runner-busy", "executor-failed", "host-blocked", "login-failed"] as const) expect(card("needs-a-person", [entry], "REVIEW"), entry).toBe("ask");
  });

  it("gives the card for the asks the policy really produces", () => {
    const person = decide(verifyE2e(incomplete("g1: login-failed")));
    expect(person).toMatchObject({ action: "ASK" });
    if (person.action === "ASK") expect(autoFixAskCard(person, "VERIFY")).toBe("fix_setup");
    const mixed = decide(verifyE2e(incomplete("g1: build-failed", "g2: login-failed")));
    if (mixed.action === "ASK") expect(autoFixAskCard(mixed, "VERIFY")).toBe("ask");
    const original = decide(blocked("VERIFY", undefined, results([{ checkId: "c", status: "FAILED" }])), { checkOriginal: { c: "failed" } });
    expect(original).toMatchObject({ action: "ASK", reason: "original-code-also-fails" });
    if (original.action === "ASK") expect(autoFixAskCard(original, "VERIFY")).toBe("fix_setup");
  });
});
