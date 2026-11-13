// TE-B2 (honest CI states), the Cloud half: the mirror of Rovara Code's core change. "No CI" is never a silent pass and unreadable CI times out to "CI not readable" instead of `pending` forever, BEHIND the
// company gate `honestCi` (off = today's behaviour, byte for byte: "No CI" marks ready, unreadable checks stay pending). The gate and the project's mode come in through two optional dependencies.
import { afterEach, describe, expect, it } from "vitest";
import { mergeTrackingDecisionDigest, mergeTrackingKey } from "@rovara-code/contracts";
import { MERGE_NOT_READY_MESSAGES as M, MergeTrackingItemSchema, type MergeTrackingItem } from "../../packages/cloud-contracts/src/rovara-code.js";
import { CI_STATE_WORDS } from "../../packages/broker/src/rovara-code/ci-state-words.js";
import { mergeReadiness, type MergePullRequestFacts, type ReadinessInput } from "../../packages/broker/src/rovara-code/merge.js";
import {
  CI_UNREADABLE_AFTER_MS, DEFAULT_CI_MODE, NO_CI_GRACE_MS, ciAllowsReady, ciCountsAsPassing, readCi, unreadableSinceOf, trackPullRequest, trackingItemOf, type ProjectCiMode,
} from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { registerCodeMilestoneHandler } from "../../packages/broker/src/rovara-code/milestones.js";
import { mergeViewOf } from "../../packages/broker/src/rovara-code/merge.js";
import { mergeItemOf } from "../../packages/broker/src/decisions/merge-source.js";
import { nextFor } from "../../packages/mcp/src/tools.js";
import { plainState } from "../../packages/ui/src/screens/session/task-plain-state.js";
import { codeSettingsKey } from "@rovara-code/contracts";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { GH, HEAD_A as MERGE_HEAD, LOGIN, OLD_HEAD, mergeWorld } from "../support/rovara-code-merge-world.js";
import { statusOf } from "../../packages/broker/src/plugins/code-host/github/mapping.js";
import { HEAD_A, NOW, TASK_ID, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";
import { PRIYA } from "../support/agent-session-world.js";

const MODES: ProjectCiMode[] = ["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"];
const unregister: Array<() => void> = [];
afterEach(() => { while (unregister.length > 0) unregister.pop()!(); });
const itemOf = (w: TrackingWorld, number = 7) => w.db.get(mergeTrackingKey(TASK_ID, "payments", number)) as unknown as MergeTrackingItem & Record<string, unknown>;
const passing = [{ name: "test", status: "completed" as const, conclusion: "success" as const, required: false, url: "" }];
const read = (overrides: Parameters<typeof status>[0], input: Partial<Parameters<typeof readCi>[1]> & { honest?: boolean } = {}) =>
  readCi(statusOf(status(overrides)), { checksEverSeen: false, lastRovaraPushAt: undefined, now: NOW, honest: true, ...input });

describe("readCi with the gate on: unreadable checks", () => {
  it("is one named constant, the existing no-CI wait", () => {
    expect(CI_UNREADABLE_AFTER_MS).toBe(NO_CI_GRACE_MS);
  });
  it("starts the clock when the checks cannot be read, waits as pending, then reads 'not readable' and keeps the start", () => {
    expect(read({ checksUnavailable: true })).toMatchObject({ ci: "pending", unreadableSince: NOW, recheckAt: NOW + CI_UNREADABLE_AFTER_MS });
    expect(read({ checksUnavailable: true }, { unreadableSince: NOW - CI_UNREADABLE_AFTER_MS + 1 }).ci).toBe("pending");
    const since = NOW - CI_UNREADABLE_AFTER_MS;
    const late = read({ checksUnavailable: true }, { unreadableSince: since });
    expect(late).toMatchObject({ ci: "unreadable", unreadableSince: since });
    expect(late.recheckAt).toBeUndefined();
    expect(read({ checksUnavailable: true, checks: passing }, { unreadableSince: since }).ci).toBe("unreadable");
  });
  it("treats checks that exist but cannot be counted the same way", () => {
    const uncounted = { baseHasRequiredChecks: true, requiredChecks: [], checks: passing };
    expect(read(uncounted)).toMatchObject({ ci: "pending", unreadableSince: NOW });
    expect(read(uncounted, { unreadableSince: NOW - CI_UNREADABLE_AFTER_MS }).ci).toBe("unreadable");
  });
  it("carries no start once the checks read normally", () => {
    const readable = read({ checks: passing }, { unreadableSince: NOW - 10 * CI_UNREADABLE_AFTER_MS });
    expect(readable.ci).toBe("passing");
    expect(readable.unreadableSince).toBeUndefined();
  });
});

describe("readCi with the gate off is today's reading", () => {
  it("unreadable checks stay pending however long, and write no start", () => {
    const long = read({ checksUnavailable: true }, { honest: false, unreadableSince: NOW - 100 * CI_UNREADABLE_AFTER_MS });
    expect(long).toEqual(expect.objectContaining({ ci: "pending" }));
    expect(long.unreadableSince).toBeUndefined();
    expect(read({ baseHasRequiredChecks: true, requiredChecks: [], checks: passing }, { honest: false, unreadableSince: NOW - 100 * CI_UNREADABLE_AFTER_MS }).ci).toBe("pending");
    // And a call that never heard of the gate (outcome hooks, the press) reads as before.
    expect(readCi(statusOf(status({ checksUnavailable: true })), { checksEverSeen: false, lastRovaraPushAt: undefined, now: NOW }).ci).toBe("pending");
  });
});

describe("ciAllowsReady: the truth table", () => {
  it("gate on: passing is ready in every mode; pending and failing never; 'No CI' and unreadable only in sandbox_only", () => {
    for (const mode of MODES) {
      expect(ciAllowsReady("passing", mode, true)).toBe(true);
      expect(ciAllowsReady("pending", mode, true)).toBe(false);
      expect(ciAllowsReady("failing", mode, true)).toBe(false);
      expect(ciAllowsReady("none", mode, true)).toBe(mode === "sandbox_only");
      expect(ciAllowsReady("unreadable", mode, true)).toBe(mode === "sandbox_only");
    }
  });
  it("gate off: today's rule in every mode (passing or none)", () => {
    for (const mode of MODES) {
      expect(ciAllowsReady("passing", mode, false)).toBe(true);
      expect(ciAllowsReady("none", mode, false)).toBe(true);
      expect(ciAllowsReady("pending", mode, false)).toBe(false);
      expect(ciAllowsReady("failing", mode, false)).toBe(false);
    }
  });
  it("the default mode is today's version 2 behaviour", () => {
    expect(DEFAULT_CI_MODE).toBe("their_ci_fix");
    expect(ciAllowsReady("none", DEFAULT_CI_MODE, true)).toBe(false);
  });
});

describe("mergeReadiness words for the new states", () => {
  const facts = (overrides: Partial<MergePullRequestFacts>): MergePullRequestFacts => ({
    repositoryId: "app", number: 1, headSha: HEAD_A, state: "open", draft: false, baseBranch: "main", ci: "passing", branch: "up_to_date", behindRequired: false, ...overrides,
  });
  const input = (pr: MergePullRequestFacts): ReadinessInput => ({
    pullRequests: [pr], approvals: new Map([["app#1", { approved: true as const, commitId: HEAD_A, by: { githubUserId: "1", login: "priya" }, approvers: [{ githubUserId: "1", login: "priya" }] }]]),
    workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["app#1", "main"]]), presser: { githubUserId: "2" }, allowSelfApproval: true, requesterName: "Priya",
  });
  it("says why a no-CI pull request is still a draft, and that unreadable CI is not readable, with the way out", () => {
    expect(mergeReadiness(input(facts({ draft: true, ci: "none" })))).toEqual({ ready: false, message: M.draftNoCi });
    expect(mergeReadiness(input(facts({ ci: "unreadable" })))).toEqual({ ready: false, message: M.ciNotReadable });
    expect(mergeReadiness(input(facts({ draft: true, ci: "unreadable" })))).toEqual({ ready: false, message: M.ciNotReadable });
    expect(M.draftNoCi).toContain(CI_STATE_WORDS.none);
    expect(M.ciNotReadable).toContain(CI_STATE_WORDS.unreadable);
    expect(M.ciNotReadable).toContain("grant checks read, or set this project to 'do not read CI'");
  });
  it("a person may still merge a pull request that has no CI; pending and failing still refuse", () => {
    expect(mergeReadiness(input(facts({ ci: "none" })))).toEqual({ ready: true });
    expect(mergeReadiness(input(facts({ ci: "pending" })))).toEqual({ ready: false, message: M.checks });
    expect(mergeReadiness(input(facts({ ci: "failing" })))).toEqual({ ready: false, message: M.checks });
  });
});

/** A world whose draft pull request has no checks and no workflow files. */
function noCiWorld(options: { honest?: boolean; mode?: ProjectCiMode } = {}) {
  const w = world({ deps: { ...(options.honest === undefined ? {} : { honestCi: async () => options.honest! }), ...(options.mode === undefined ? {} : { ciMode: () => options.mode! }) } });
  w.github.statuses.set(7, status({ checks: [], headHasWorkflowFiles: false }));
  return w;
}
const heardMilestones = () => { const heard: string[] = []; unregister.push(registerCodeMilestoneHandler({ name: "honest_ci_test", on: async (_deps, milestone) => { heard.push(`${milestone.kind}:${milestone.text}`); } })); return heard; };

describe("tracking a pull request with no CI", () => {
  it("gate on, default mode: waits the grace (pending), then reads 'none' and leaves the draft", async () => {
    const w = noCiWorld({ honest: true });
    const heard = heardMilestones();
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "pending" });
    w.setNow(NOW + NO_CI_GRACE_MS);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "none", draft: true });
    expect(w.github.calls.filter((call) => call.startsWith("ready"))).toEqual([]);
    expect(heard).toEqual([]);
  });
  it("gate on, any mode but sandbox_only: the draft stays", async () => {
    for (const mode of MODES.filter((mode) => mode !== "sandbox_only")) {
      const w = noCiWorld({ honest: true, mode });
      await trackPullRequest(w.deps, TASK_ID);
      w.setNow(NOW + NO_CI_GRACE_MS);
      await trackPullRequest(w.deps, TASK_ID);
      expect(w.github.calls.filter((call) => call.startsWith("ready")), mode).toEqual([]);
    }
  });
  it("gate on, sandbox_only: marked ready, and the milestone says 'No CI on this repository'", async () => {
    const w = noCiWorld({ honest: true, mode: "sandbox_only" });
    const heard = heardMilestones();
    await trackPullRequest(w.deps, TASK_ID);
    w.setNow(NOW + NO_CI_GRACE_MS);
    await trackPullRequest(w.deps, TASK_ID);
    expect(w.github.calls).toContain("ready:7");
    expect(heard).toEqual([`pr_ready:Rovara marked payments pull request 7 ready for review. ${CI_STATE_WORDS.none}.`]);
  });
  it("gate OFF (or never wired): today's behaviour, 'No CI' marks the draft ready, in every mode, with today's words", async () => {
    for (const honest of [undefined, false]) {
      const w = noCiWorld(honest === undefined ? {} : { honest });
      const heard = heardMilestones();
      await trackPullRequest(w.deps, TASK_ID);
      w.setNow(NOW + NO_CI_GRACE_MS);
      await trackPullRequest(w.deps, TASK_ID);
      expect(w.github.calls).toContain("ready:7");
      expect(heard).toEqual(["pr_ready:Rovara marked payments pull request 7 ready for review."]);
      unregister.pop()!();
    }
  });
  it("a gate that cannot be read counts as off (fail to today's behaviour, never to the new one)", async () => {
    const w = world({ deps: { honestCi: async () => { throw new Error("gate row unreadable"); } } });
    w.github.statuses.set(7, status({ checks: [], headHasWorkflowFiles: false }));
    await trackPullRequest(w.deps, TASK_ID);
    w.setNow(NOW + NO_CI_GRACE_MS);
    await trackPullRequest(w.deps, TASK_ID);
    expect(w.github.calls).toContain("ready:7");
  });
});

describe("tracking a pull request whose checks cannot be read", () => {
  const unreadable = () => status({ checksUnavailable: true });
  it("gate on: pending with the start written, 'not readable' after the wait, the draft stays; clears when the checks read again", async () => {
    const w = world({ deps: { honestCi: async () => true } });
    w.github.statuses.set(7, unreadable());
    await trackPullRequest(w.deps, TASK_ID);
    const first = itemOf(w);
    expect(first).toMatchObject({ ci: "pending", ciUnreadableSince: new Date(NOW).toISOString() });
    w.setNow(NOW + CI_UNREADABLE_AFTER_MS - 1);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).ci).toBe("pending");
    w.setNow(NOW + CI_UNREADABLE_AFTER_MS);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "unreadable", ciUnreadableSince: first.ciUnreadableSince });
    expect(w.github.calls.filter((call) => call.startsWith("ready"))).toEqual([]);
    w.github.statuses.set(7, status({ checks: passing }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).ci).toBe("passing");
    expect(itemOf(w)).not.toHaveProperty("ciUnreadableSince");
    expect(w.github.calls).toContain("ready:7");
  });
  it("gate on: a brief failure that recovers never reaches 'not readable'", async () => {
    const w = world({ deps: { honestCi: async () => true } });
    let at = NOW;
    for (let round = 0; round < 4; round += 1) {
      w.setNow(at);
      w.github.statuses.set(7, unreadable());
      await trackPullRequest(w.deps, TASK_ID);
      at += CI_UNREADABLE_AFTER_MS - 1_000;
      w.setNow(at);
      w.github.statuses.set(7, status({ checks: passing }));
      await trackPullRequest(w.deps, TASK_ID);
      expect(itemOf(w).ci).toBe("passing");
      at += CI_UNREADABLE_AFTER_MS;
    }
  });
  it("gate on: a new head starts the wait over", async () => {
    const w = world({ deps: { honestCi: async () => true } });
    w.github.statuses.set(7, unreadable());
    await trackPullRequest(w.deps, TASK_ID);
    w.setNow(NOW + 2 * CI_UNREADABLE_AFTER_MS);
    const HEAD_C = "c".repeat(40);
    w.github.statuses.set(7, status({ checksUnavailable: true, headSha: HEAD_C }));
    await trackPullRequest({ ...w.deps, recordedHead: async () => HEAD_C }, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "pending", ciUnreadableSince: new Date(NOW + 2 * CI_UNREADABLE_AFTER_MS).toISOString() });
  });
  it("gate on, sandbox_only: marked ready even though the checks are not readable, and the milestone says so", async () => {
    const w = world({ deps: { honestCi: async () => true, ciMode: () => "sandbox_only" } });
    const heard = heardMilestones();
    w.github.statuses.set(7, unreadable());
    await trackPullRequest(w.deps, TASK_ID);
    expect(w.github.calls.filter((call) => call.startsWith("ready"))).toEqual([]);
    w.setNow(NOW + CI_UNREADABLE_AFTER_MS);
    await trackPullRequest(w.deps, TASK_ID);
    expect(w.github.calls).toContain("ready:7");
    expect(heard).toEqual([`pr_ready:Rovara marked payments pull request 7 ready for review. ${CI_STATE_WORDS.unreadable}.`]);
  });
  it("gate OFF: pending forever, exactly as today, and nothing new is written on the row", async () => {
    const w = world({ deps: { honestCi: async () => false } });
    w.github.statuses.set(7, unreadable());
    await trackPullRequest(w.deps, TASK_ID);
    w.setNow(NOW + 50 * CI_UNREADABLE_AFTER_MS);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).ci).toBe("pending");
    expect(itemOf(w)).not.toHaveProperty("ciUnreadableSince");
  });
});

describe("a row written by the code before this lane", () => {
  it("still reads, keeps its digest, and is rewritten without the new field", async () => {
    const w = world({ deps: { honestCi: async () => true } });
    const stamp = new Date(NOW).toISOString();
    const fields = {
      orgId: TEST_ORG, taskId: TASK_ID, repositoryId: "payments", number: 7, headSha: HEAD_A, draft: false, state: "open" as const, baseBranch: "main", ci: "pending" as const,
      ciBasis: "all_checks" as const, checksEverSeen: true, failingChecks: [], review: "approved" as const, branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-25", count: 0 },
    };
    const stored = { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: stamp };
    w.db.set({ ...mergeTrackingKey(TASK_ID, "payments", 7), entityType: "MERGE_TRACKING", ...stored });
    expect(MergeTrackingItemSchema.safeParse(stored).success).toBe(true);
    expect(trackingItemOf(itemOf(w), TEST_ORG, TASK_ID)).toMatchObject({ ci: "pending", version: 1 });
    expect(mergeTrackingDecisionDigest({ ...fields })).toBe(stored.decisionDigest);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).ci).toBe("passing");
    expect(itemOf(w)).not.toHaveProperty("ciUnreadableSince");
  });
});

describe("the words are one set everywhere a person reads them", () => {
  it("the web page, the CLI and the merge refusals carry the same two sentences as the broker", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["packages/ui/src/screens/session/MergeSection.tsx", "packages/cli/src/developer/sessions.ts"]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toContain(CI_STATE_WORDS.none);
      expect(text, file).toContain(CI_STATE_WORDS.unreadable);
    }
  });
});

// ---- review fixes (M1, M2, L1, L3, L4, gate-off identity)

describe("M1: a pull request that was never a draft", () => {
  const reviewers = (w: TrackingWorld) => w.db.set({ ...codeSettingsKey(TEST_ORG, "web"), allowSelfApproval: false, mergeMethod: "squash", codeReviewers: ["alice"], revision: 1 });
  async function track(deps: Parameters<typeof world>[0], draft: boolean) {
    const w = world(deps);
    reviewers(w);
    w.github.statuses.set(7, status({ draft, checks: [], headHasWorkflowFiles: false }));
    await trackPullRequest(w.deps, TASK_ID);
    w.setNow(NOW + NO_CI_GRACE_MS);
    await trackPullRequest(w.deps, TASK_ID);
    return w;
  }
  it("gate on, default mode: a non-draft no-CI pull request still gets its reviewers and readyAt; a draft gets none", async () => {
    const open = await track({ deps: { honestCi: async () => true } }, false);
    expect(itemOf(open)).toMatchObject({ ci: "none", draft: false });
    expect(open.github.calls).toContain("reviewers:7:alice");
    expect(itemOf(open)).toHaveProperty("readyAt");
    const draft = await track({ deps: { honestCi: async () => true } }, true);
    expect(draft.github.calls.filter((call) => call.startsWith("reviewers"))).toEqual([]);
  });
  it("gate off: a non-draft no-CI pull request gets its reviewers, as today", async () => {
    expect((await track({}, false)).github.calls).toContain("reviewers:7:alice");
  });
  it("the task page says 'Ready to merge' only when the CI passed; a ready pull request with no CI is labelled so", () => {
    const task = (ci: string) => ({ merge: { ready: true }, mergeTracking: [{ state: "open", ci, review: "approved" }] }) as never;
    expect(plainState({ state: "ready_to_merge" }, task("passing")).label).toBe("Ready to merge");
    expect(plainState({ state: "ready_to_merge" }, task("none")).label).not.toBe("Ready to merge");
    expect(plainState({ state: "ready_to_merge" }, task("none")).label).toMatch(/no CI/iu);
  });
});

describe("M2: the MCP words", () => {
  const task = (ci: string[] | undefined) => ({
    workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 3 }, merge: { ready: true }, ...(ci === undefined ? {} : { mergeTracking: ci.map((value) => ({ ci: value })) }),
  }) as never;
  it("says its checks passed only when every tracked pull request's checks passed; no CI is said as no CI", () => {
    expect(nextFor(task(["passing"]))).toContain("its checks passed");
    const none = nextFor(task(["passing", "none"]));
    expect(none).not.toContain("checks passed");
    expect(none).toContain(CI_STATE_WORDS.none);
    expect(nextFor(task(undefined))).not.toContain("checks passed");
  });
});

describe("L1: an approval of an earlier head carries over a clean sync only on passing CI (no CI only in sandbox_only, gate on)", () => {
  it("the predicate", () => {
    for (const mode of MODES) {
      expect(ciCountsAsPassing("passing", mode, true)).toBe(true);
      expect(ciCountsAsPassing("none", mode, true)).toBe(mode === "sandbox_only");
      expect(ciCountsAsPassing("unreadable", mode, true)).toBe(false);
      expect(ciCountsAsPassing("none", mode, false)).toBe(true);
      expect(ciCountsAsPassing("pending", mode, false)).toBe(false);
    }
  });
  it("through the merge view: gate off counts it (today), gate on counts it only in sandbox_only", async () => {
    const w = mergeWorld();
    await w.linkAll();
    w.seedTracking({ ci: "none", approval: { githubUserId: GH.max, login: LOGIN.max, commitId: OLD_HEAD } });
    const stored = w.db.get(taskKey(w.taskId))! as { workflow: { pullRequests: Array<Record<string, unknown>> } };
    w.db.set({ ...stored, workflow: { ...stored.workflow, pullRequests: stored.workflow.pullRequests.map((entry) => ({ ...entry, syncedFrom: OLD_HEAD })) } });
    const task = w.db.get(taskKey(w.taskId))! as never;
    const items = [w.trackingOf({ repositoryId: "payments", number: 7 })!];
    const view = (deps: Record<string, unknown>) => mergeViewOf({ ...w.deps, ...deps }, task, items, PRIYA);
    expect(await view({})).toMatchObject({ ready: true });
    expect(await view({ honestCi: async () => true })).toMatchObject({ ready: false, message: M.staleApproval });
    expect(await view({ honestCi: async () => true, ciMode: () => "their_ci_fix" })).toMatchObject({ ready: false, message: M.staleApproval });
    expect(await view({ honestCi: async () => true, ciMode: () => "sandbox_only" })).toMatchObject({ ready: true });
    void MERGE_HEAD;
  });
});

describe("L3: the unreadable wait is kept for the head it was seen on only", () => {
  it("one rule for tracking and the press", () => {
    const since = "2026-11-09T09:00:00.000Z";
    expect(unreadableSinceOf({ headSha: HEAD_A, ciUnreadableSince: since }, HEAD_A)).toBe(Date.parse(since));
    expect(unreadableSinceOf({ headSha: "b".repeat(40), ciUnreadableSince: since }, HEAD_A)).toBeUndefined();
    expect(unreadableSinceOf({ headSha: HEAD_A }, HEAD_A)).toBeUndefined();
    expect(unreadableSinceOf(undefined, HEAD_A)).toBeUndefined();
  });
});

describe("L4 and gate-off identity: the merge card does not fold 'no CI' into 'passing'", () => {
  const items = (ci: string[]) => ci.map((value, index) => ({ repositoryId: `r${String(index)}`, number: 1, state: "open", draft: false, ci: value, headSha: HEAD_A, baseBranch: "main" })) as never;
  const task = { taskId: TASK_ID, orgId: TEST_ORG, project: "web", title: "t" } as never;
  const workflowFor = (count: number) => ({
    definitionVersion: "1.1.0", stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 1, updatedAt: "2026-10-25T11:00:00.000Z",
    pullRequests: Array.from({ length: count }, (_, index) => ({ repositoryId: `r${String(index)}`, number: 1, required: true, state: "OPEN", url: "https://github.com/a/b/pull/1", headSha: HEAD_A, candidateDigest: "c".repeat(64) })),
  }) as never;
  const cardCi = (ci: string[], honest: boolean) => (mergeItemOf(task, workflowFor(ci.length), items(ci), "ses_aaaaaaaaaaaaaaaaaaaa", "2026-10-25T12:00:00.000Z", honest) as { ci: string; contentVersion: string }).ci;
  it("gate on: failing, then not readable, then still running, then no CI, then passing", () => {
    expect(cardCi(["passing", "none"], true)).toBe("none");
    expect(cardCi(["none", "unreadable"], true)).toBe("unreadable");
    expect(cardCi(["none", "pending"], true)).toBe("pending");
    expect(cardCi(["none", "failing"], true)).toBe("failing");
    expect(cardCi(["passing"], true)).toBe("passing");
  });
  it("gate off: today's aggregation (no CI reads as passing) and the same contentVersion as before this lane", () => {
    expect(cardCi(["none"], false)).toBe("passing");
    const before = mergeItemOf(task, workflowFor(1), items(["none"]), "ses_aaaaaaaaaaaaaaaaaaaa", "2026-10-25T12:00:00.000Z") as { contentVersion: string };
    const off = mergeItemOf(task, workflowFor(1), items(["none"]), "ses_aaaaaaaaaaaaaaaaaaaa", "2026-10-25T12:00:00.000Z", false) as { contentVersion: string };
    const on = mergeItemOf(task, workflowFor(1), items(["none"]), "ses_aaaaaaaaaaaaaaaaaaaa", "2026-10-25T12:00:00.000Z", true) as { contentVersion: string };
    expect(off.contentVersion).toBe(before.contentVersion);
    expect(on.contentVersion).not.toBe(off.contentVersion);
  });
});
