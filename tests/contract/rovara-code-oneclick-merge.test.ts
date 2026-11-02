// Owner decision 2026-10-27 (approval merges): once a pull request is ready, one click in the web app merges it: a browser session with its CSRF token, one confirm dialog, no email-code sign-in.
// The merge is the same path the confirmation page uses (the claim, the head pin, the method fallback, the audit in the claim's transaction). The risk is shown, and a medium or high one is
// part of what the person saw. A token (the CLI, an AI tool) never merges: it gets the confirmation link, which only a browser decides.
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, MergeDoneReaderSchema, MergeViewSchema, NeedsConfirmationSchema } from "../../packages/contracts/src/index.js";
import { mergeReadiness, mergeViewOf, pressMerge, riskOfTask, type HumanApproval, type MergePullRequestFacts } from "../../packages/broker/src/rovara-code/merge.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { secondOpinionUnavailable, secondReviewAcknowledgement } from "../../packages/broker/src/rovara-code/second-review.js";
import { secondReviewMergeWait } from "../../packages/broker/src/rovara-code/second-review-store.js";
import { ARJUN, CELL, MAX, PRIYA } from "../support/agent-session-world.js";
import { GH, HEAD_A, HEAD_B, LOGIN, mergeWorld, pullStatus, type MergeWorld } from "../support/rovara-code-merge-world.js";

const DIGEST = "c".repeat(64);
const risk = (level: "low" | "medium" | "high", reasons = ["A reason in words."]) => ({ level, reasons, candidateDigest: DIGEST });
const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const browser = (w: MergeWorld, who: string = PRIYA) => ({ ...w.caller(who), browserSession: true as const });
const webPress = (w: MergeWorld, body: Record<string, unknown> = {}, who: string = PRIYA) => pressMerge(w.shareDeps, browser(w, who), w.sessionId, { requestId: w.requestId(), risk: "low", ...body }, w.deps);
const tokenPress = (w: MergeWorld, who: string = PRIYA, body: Record<string, unknown> = {}) => pressMerge(w.shareDeps, w.caller(who), w.sessionId, { requestId: w.requestId(), ...body }, w.deps);
const mergedOf = (w: MergeWorld) => w.github.mergeCalls.map((call) => `${String(call.number)}:${call.sha.slice(0, 1)}:${call.method}`);
async function ready(options: Parameters<typeof mergeWorld>[0] = {}, tracking: Parameters<MergeWorld["seedTracking"]>[0] = {}): Promise<MergeWorld> {
  const w = mergeWorld(options);
  await w.linkAll();
  w.seedTracking(tracking);
  return w;
}

describe("one click from the web app", () => {
  it("merges a ready pull request at once: no pending change, no confirmation page, the checked head and the project's method", async () => {
    const w = await ready({ mergeMethod: "squash" });
    const reply = await webPress(w);
    expect(reply.status).toBe(200);
    expect(MergeDoneReaderSchema.parse(reply.body)).toEqual({ status: "MERGED", pullRequests: [{ repositoryId: "payments", number: 7 }] });
    expect(mergedOf(w)).toEqual(["7:a:squash"]);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);
    expect(w.trackingOf({ repositoryId: "payments", number: 7 })?.mergeClaim).toEqual({ headSha: HEAD_A, by: PRIYA, at: new Date(w.clock.now).toISOString() });
  });

  it("merges every pull request of a task in repository order, each with its own head", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    w.github.statuses.set(8, pullStatus(8, { headSha: HEAD_B, reviews: [{ githubUserId: GH.arjun, login: LOGIN.arjun, userType: "User", state: "APPROVED", commitId: HEAD_B, submittedAt: "2026-10-22T08:40:00.000Z" }] }));
    w.setPullRequests(w.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, url: `https://github.com/acme/${pr.repositoryId}/pull/${String(pr.number)}`, headSha: pr.number === 8 ? HEAD_B : HEAD_A, candidateDigest: DIGEST, required: true, state: "OPEN" })));
    w.seedTracking((pr) => (pr.number === 8 ? { headSha: HEAD_B, approval: { githubUserId: GH.arjun, login: LOGIN.arjun, commitId: HEAD_B } } : {}));
    expect((await webPress(w)).status).toBe(200);
    expect(mergedOf(w)).toEqual(["8:b:squash", "7:a:squash"]);
  });

  it("records who pressed in the claim's own transaction, with no approval to point at", async () => {
    const w = await ready();
    await webPress(w);
    const [event] = w.audit.recordedBy("pull_request.merge_requested");
    expect(event).toMatchObject({ action: "pull_request.merge_requested", actor: { kind: "member", id: PRIYA }, facts: { number: 7, method: "squash" } });
    expect(event?.related).toBeUndefined();
    const claimTransaction = w.db.transactions().find((items) => items.some((entry) => JSON.stringify(entry).includes("mergeClaim")))!;
    expect(JSON.stringify(claimTransaction)).toContain("AUDIT_PENDING");
  });

  it("refuses with the exact words when the pull request is not ready, and merges nothing", async () => {
    const red = await ready({}, { ci: "failing", failingChecks: ["test"] });
    expect(await codeOf(webPress(red))).toEqual({ code: "MERGE_NOT_READY", message: M.checks });
    const none = await ready({}, { review: "requested", approval: undefined });
    expect(await codeOf(webPress(none))).toEqual({ code: "MERGE_NOT_READY", message: M.needsOtherApproval("Priya") });
    const draft = await ready({}, { draft: true });
    expect(await codeOf(webPress(draft))).toEqual({ code: "MERGE_NOT_READY", message: M.draft });
    for (const w of [red, none, draft]) expect(w.github.mergeCalls).toEqual([]);
  });

  it("waits for the owner's acknowledgement while an `on` second review that did not run is open, in the press and in the view; nothing is merged (SR-1)", async () => {
    process.env.SECOND_REVIEW_ENABLED = "1";
    try {
      const w = await ready();
      const opinion = secondOpinionUnavailable({ mode: "on", company: "openai" }, "no-answer");
      const digest = DIGEST;
      const row = () => w.db.get(taskKey(w.taskId))!;
      w.db.set({ ...row(), workflow: { ...(row().workflow as object), candidate: { digest } } });
      w.db.set({ ...row(), secondOpinion: { candidateDigest: digest, opinion, recordedAt: new Date(w.clock.now).toISOString() } });
      const words = secondReviewMergeWait(row())!;
      expect(words).toContain("Second review did not run");
      expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: words });
      expect(await codeOf(tokenPress(w))).toEqual({ code: "MERGE_NOT_READY", message: words });
      expect(await mergeViewOf(w.deps, row() as never, [w.trackingOf({ repositoryId: "payments", number: 7 })!], PRIYA)).toMatchObject({ ready: false, message: words });
      expect(w.github.mergeCalls).toEqual([]);
      const ack = secondReviewAcknowledgement(opinion, digest);
      if (!ack.required) throw new Error("expected an ask");
      w.db.set({ ...row(), secondReviewAcknowledged: [ack.key] });
      expect((await webPress(w)).status).toBe(200);
      expect(mergedOf(w)).toHaveLength(1);
    } finally {
      delete process.env.SECOND_REVIEW_ENABLED;
    }
  });

  it("re-reads GitHub: a head that moved after tracking last looked, or checks that went red since, stop the merge", async () => {
    const moved = await ready();
    moved.github.statuses.set(7, pullStatus(7, { headSha: HEAD_B }));
    expect(await codeOf(webPress(moved))).toEqual({ code: "MERGE_NOT_READY", message: M.changedAfterConfirm });
    const red = await ready();
    red.github.statuses.set(7, pullStatus(7, { checks: [{ name: "test", status: "completed", conclusion: "failure", required: false, url: "https://example.test/1" }] }));
    expect(await codeOf(webPress(red))).toEqual({ code: "MERGE_NOT_READY", message: M.checks });
    expect(moved.github.mergeCalls).toEqual([]);
    expect(red.github.mergeCalls).toEqual([]);
  });

  it("does not count the requester's own approval while self-approval is off, and does when the org turned it on", async () => {
    const own = { approval: { githubUserId: GH.priya, login: LOGIN.priya, commitId: HEAD_A } };
    const off = await ready({}, own);
    off.github.statuses.set(7, pullStatus(7, { reviews: [{ githubUserId: GH.priya, login: LOGIN.priya, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: "2026-10-22T08:40:00.000Z" }] }));
    expect(await codeOf(webPress(off))).toEqual({ code: "MERGE_NOT_READY", message: M.needsOtherApproval("Priya") });
    const on = await ready({ allowSelfApproval: true }, own);
    on.github.statuses.set(7, pullStatus(7, { reviews: [{ githubUserId: GH.priya, login: LOGIN.priya, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: "2026-10-22T08:40:00.000Z" }] }));
    expect((await webPress(on)).status).toBe(200);
  });

  it("keeps the separation of duties: the only approver cannot press, and a presser needs a linked GitHub account", async () => {
    const w = await ready({}, { approval: { githubUserId: GH.max, login: LOGIN.max, commitId: HEAD_A } });
    w.github.statuses.set(7, pullStatus(7, { reviews: [{ githubUserId: GH.max, login: LOGIN.max, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: "2026-10-22T08:40:00.000Z" }] }));
    expect(await codeOf(webPress(w, {}, MAX))).toEqual({ code: "MERGE_NOT_READY", message: M.presserApproved });
    const unlinked = await ready({ linked: ["arjun", "max", "ola"] });
    expect(await codeOf(webPress(unlinked))).toEqual({ code: "MERGE_NOT_READY", message: M.linkGithub });
    expect(w.github.mergeCalls).toEqual([]);
    expect(unlinked.github.mergeCalls).toEqual([]);
  });

  it("lets only the session's owner, a maintainer or an org admin press, as the confirmation flow does", async () => {
    const w = await ready();
    expect(await codeOf(webPress(w, {}, ARJUN))).toMatchObject({ code: "FORBIDDEN" });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("makes one GitHub merge call when two presses race: the claim is atomic", async () => {
    const w = await ready();
    let nested: unknown;
    w.github.onMerge = async () => {
      w.github.onMerge = undefined;
      nested = await webPress(w).then(() => "merged", (error: { code?: string }) => error.code);
    };
    expect((await webPress(w)).status).toBe(200);
    expect(w.github.mergeCalls).toHaveLength(1);
    expect(nested).toBe("RUNTIME_UNAVAILABLE");
    expect(w.audit.recordedBy("pull_request.merge_requested")).toHaveLength(1);
  });

  it("answers a repeated press after the merge as merged, and calls GitHub no more", async () => {
    const w = await ready();
    const requestId = w.requestId();
    await webPress(w, { requestId });
    // The pull request is merged; tracking has not seen it yet, so the repeat is judged from GitHub and finds nothing left to merge.
    const again = await codeOf(webPress(w, { requestId }));
    expect(w.github.mergeCalls).toHaveLength(1);
    expect(again === undefined || again.code === "MERGE_NOT_READY").toBe(true);
  });

  it("shows GitHub's own reason when GitHub refuses (branch protection, a required check, a ruleset)", async () => {
    const w = await ready();
    w.github.results.set(7, { outcome: "refused", reason: "not_mergeable", githubMessage: "Required status check \"build\" is expected." });
    const failure = await codeOf(webPress(w));
    expect(failure?.code).toBe("MERGE_NOT_READY");
    expect(failure?.message).toContain("Required status check \"build\" is expected.");
    expect(failure?.message).toContain("payments didn't merge");
  });

  it("stops a half-merged pair with GitHub's reason for the second", async () => {
    const w = await ready({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "billing", number: 8 }] });
    w.github.results.set(7, { outcome: "refused", reason: "forbidden", githubMessage: "Repository rule violations found" });
    const failure = await codeOf(webPress(w));
    expect(failure?.message).toContain("billing merged, but payments didn't");
    expect(failure?.message).toContain("Repository rule violations found");
  });
});

describe("the risk a press has seen", () => {
  it("merges a low risk pull request with no ceremony, and a medium one when the press names the level the person saw", async () => {
    for (const level of ["low", "medium"] as const) {
      const w = await ready();
      w.setWorkflow({ risk: risk(level, ["This PR changes CI configuration."]) });
      expect((await webPress(w, { risk: level })).status, level).toBe(200);
      expect(w.github.mergeCalls, level).toHaveLength(1);
    }
  });

  it("never merges a HIGH risk pull request on a click: a browser press gets the confirmation page (fresh sign-in) and nothing is merged", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("high", ["This PR changes CI configuration."]) });
    const reply = await webPress(w, { risk: "high" });
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED" });
    expect(w.github.mergeCalls).toEqual([]);
    expect(w.db.find((item) => item.entityType === "APPROVAL").length).toBe(1);
    // A press that did not see the risk is still refused first, as before.
    const unseen = await ready();
    unseen.setWorkflow({ risk: risk("high") });
    expect(await codeOf(webPress(unseen, { risk: "medium" }))).toEqual({ code: "MERGE_NOT_READY", message: M.riskChanged("high") });
  });

  it("refuses a medium or high risk press that did not see the risk, or saw another level, and merges nothing", async () => {
    for (const [actual, seen] of [["medium", "low"], ["high", "medium"], ["high", undefined], ["medium", undefined]] as const) {
      const w = await ready();
      w.setWorkflow({ risk: risk(actual) });
      const body: Record<string, unknown> = { requestId: w.requestId() };
      if (seen !== undefined) body.risk = seen;
      expect(await codeOf(pressMerge(w.shareDeps, browser(w), w.sessionId, body, w.deps)), `${actual}/${String(seen)}`).toEqual({ code: "MERGE_NOT_READY", message: M.riskChanged(actual) });
      expect(w.github.mergeCalls).toEqual([]);
    }
  });

  it("a low press that saw nothing is still fine, but one that names a level that is not one is refused", async () => {
    const w = await ready();
    expect((await pressMerge(w.shareDeps, browser(w), w.sessionId, { requestId: w.requestId() }, w.deps)).status).toBe(200);
    const other = await ready();
    expect(await codeOf(pressMerge(other.shareDeps, browser(other), other.sessionId, { requestId: other.requestId(), risk: "severe" }, other.deps))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("riskOfTask: the recorded risk, or medium when none is recorded, the code changed since, or someone else pushed", () => {
    const base: Record<string, unknown> = { definitionVersion: "1.1.0" };
    const of = (extra: Record<string, unknown>, items: Array<{ headByRovara: boolean }>) => riskOfTask({ ...base, ...extra } as never, items);
    expect(of({ risk: risk("low") }, [{ headByRovara: true }])).toEqual({ level: "low", reasons: ["A reason in words."] });
    expect(of({ risk: risk("high") }, [{ headByRovara: true }])).toEqual({ level: "high", reasons: ["A reason in words."] });
    expect(of({}, [{ headByRovara: true }])).toMatchObject({ level: "medium", reasons: [expect.stringContaining("hasn't judged")] });
    expect(of({ risk: risk("low"), candidate: { digest: "d".repeat(64) } }, [{ headByRovara: true }])).toMatchObject({ level: "medium", reasons: [expect.stringContaining("earlier code")] });
    expect(of({ risk: risk("low") }, [{ headByRovara: false }])).toMatchObject({ level: "medium", reasons: [expect.stringContaining("Someone else pushed"), "A reason in words."] });
    expect(of({ risk: risk("high") }, [{ headByRovara: false }]).level).toBe("high");
  });

  it("the task view carries the risk, in a shape the contract allows", async () => {
    const w = await ready();
    w.setWorkflow({ risk: risk("high", ["Changes CI configuration (.circleci/config.yml), which decides what is checked before a merge."]) });
    const task = w.db.get(taskKey(w.taskId))! as never;
    const view = await mergeViewOf(w.deps, task, [w.trackingOf({ repositoryId: "payments", number: 7 })!], PRIYA);
    expect(view).toEqual({ ready: true, risk: { level: "high", reasons: ["Changes CI configuration (.circleci/config.yml), which decides what is checked before a merge."] } });
    expect(MergeViewSchema.safeParse(view).success).toBe(true);
    const notReady = await ready({}, { ci: "failing", failingChecks: ["test"] });
    expect(await mergeViewOf(notReady.deps, notReady.db.get(taskKey(notReady.taskId))! as never, [notReady.trackingOf({ repositoryId: "payments", number: 7 })!], PRIYA)).toMatchObject({ ready: false, message: M.checks, risk: { level: "low" } });
  });
});

describe("code owners", () => {
  it("needs an approval from a code owner of the changed paths before the pull request is ready", async () => {
    const w = await ready();
    w.github.codeOwners = "/src/ @max-gh\n";
    w.github.changedPaths.set(7, ["src/index.ts"]);
    expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: M.needsCodeOwner("@max-gh") });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("merges once a code owner has approved too", async () => {
    const w = await ready();
    w.github.codeOwners = "/src/ @max-gh\n";
    w.github.statuses.set(7, pullStatus(7, { reviews: [
      { githubUserId: GH.arjun, login: LOGIN.arjun, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: "2026-10-22T08:40:00.000Z" },
      { githubUserId: GH.max, login: LOGIN.max, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: "2026-10-22T08:41:00.000Z" },
    ] }));
    expect((await webPress(w)).status).toBe(200);
  });

  it("an owner's approval of earlier code does not count (the approval has to be on the head)", async () => {
    const w = await ready();
    w.github.codeOwners = "/src/ @max-gh\n";
    w.github.statuses.set(7, pullStatus(7, { reviews: [
      { githubUserId: GH.arjun, login: LOGIN.arjun, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: "2026-10-22T08:40:00.000Z" },
      { githubUserId: GH.max, login: LOGIN.max, userType: "User", state: "APPROVED", commitId: HEAD_B, submittedAt: "2026-10-22T08:41:00.000Z" },
    ] }));
    expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: M.needsCodeOwner("@max-gh") });
  });

  it("needs no code owner when the file covers none of the changed paths, or there is no file", async () => {
    const elsewhere = await ready();
    elsewhere.github.codeOwners = "/docs/ @max-gh\n";
    expect((await webPress(elsewhere)).status).toBe(200);
    const none = await ready();
    expect((await webPress(none)).status).toBe(200);
  });

  it("a team owner is settled by a member of the team; a team that cannot be read fails closed", async () => {
    const member = await ready();
    member.github.codeOwners = "/src/ @acme/payments\n";
    member.github.teams.set("acme/payments", [LOGIN.arjun]);
    expect((await webPress(member)).status).toBe(200);
    const outsider = await ready();
    outsider.github.codeOwners = "/src/ @acme/payments\n";
    outsider.github.teams.set("acme/payments", [LOGIN.max]);
    expect(await codeOf(webPress(outsider))).toEqual({ code: "MERGE_NOT_READY", message: M.needsCodeOwner("@acme/payments") });
    const unreadable = await ready();
    unreadable.github.codeOwners = "/src/ @acme/payments\n";
    expect(await codeOf(webPress(unreadable))).toEqual({ code: "MERGE_NOT_READY", message: M.codeOwnersUnreadable });
  });

  it("fails closed when the CODEOWNERS file cannot be read", async () => {
    const w = await ready();
    w.github.codeOwners = new Error("boom");
    expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: M.codeOwnersUnreadable });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("fails closed when GitHub's list of changed paths is cut short", async () => {
    const w = await ready();
    w.github.codeOwners = "/docs/ @max-gh\n";
    w.github.listPullRequestFiles = async (_url: string, _number: number, options: { page: number }) => ({ files: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 0 }], nextPage: options.page + 1 });
    expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: M.codeOwnersUnreadable });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("applies to the confirmation page's merge too: the same gate on the same path", async () => {
    const w = await ready();
    w.github.codeOwners = "/src/ @max-gh\n";
    const reply = await tokenPress(w);
    const body = NeedsConfirmationSchema.parse(reply.body);
    const cookie = await w.browser(PRIYA, w.approvalIdOf(body.confirmUrl));
    await w.decide(w.approvalIdOf(body.confirmUrl), cookie);
    expect(w.github.mergeCalls).toEqual([]);
    expect((await w.approvalOf(body.confirmUrl)).status).toBe("APPROVED_FAILED");
  });
});

describe("readiness with a code owner", () => {
  const facts: MergePullRequestFacts = { repositoryId: "payments", number: 7, headSha: HEAD_A, state: "open", draft: false, baseBranch: "main", ci: "passing", branch: "up_to_date", behindRequired: false };
  const approved: HumanApproval = { approved: true, by: { githubUserId: GH.arjun, login: LOGIN.arjun }, commitId: HEAD_A, approvers: [{ githubUserId: GH.arjun, login: LOGIN.arjun }] };
  const input = (codeOwners: Parameters<typeof mergeReadiness>[0]["codeOwners"]) => ({
    pullRequests: [facts], approvals: new Map([["payments#7", approved]]), workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" }, recordedBases: new Map([["payments#7", "main"]]),
    presser: { githubUserId: GH.priya }, allowSelfApproval: false, requesterName: "Priya", codeOwners,
  });
  it("is not ready until the code owner approved, and says who", () => {
    expect(mergeReadiness(input(new Map([["payments#7", { ok: false as const, owners: "@max-gh" }]])))).toEqual({ ready: false, message: M.needsCodeOwner("@max-gh") });
    expect(mergeReadiness(input(new Map([["payments#7", { ok: false as const, unreadable: true as const }]])))).toEqual({ ready: false, message: M.codeOwnersUnreadable });
    expect(mergeReadiness(input(new Map([["payments#7", { ok: true as const }]])))).toEqual({ ready: true });
    expect(mergeReadiness(input(undefined))).toEqual({ ready: true });
  });
  it("names the repository when a task has several pull requests", () => {
    const two = { ...input(new Map([["billing#8", { ok: false as const, owners: "@max-gh" }]])), pullRequests: [facts, { ...facts, repositoryId: "billing", number: 8 }], approvals: new Map([["payments#7", approved], ["billing#8", approved]]), recordedBases: new Map([["payments#7", "main"], ["billing#8", "main"]]) };
    expect(mergeReadiness(two)).toEqual({ ready: false, message: M.repository("billing", M.needsCodeOwner("@max-gh")) });
  });
});

describe("the merge claim after GitHub says no", () => {
  const claimOf = (w: MergeWorld) => w.trackingOf({ repositoryId: "payments", number: 7 })?.mergeClaim;

  it("is released at once when GitHub refuses, so the next press does not wait for the claim to age", async () => {
    const w = await ready();
    w.github.results.set(7, { outcome: "refused", reason: "not_mergeable", githubMessage: "Required status check \"build\" is expected." });
    expect((await codeOf(webPress(w)))?.code).toBe("MERGE_NOT_READY");
    expect(claimOf(w)).toBeUndefined();
    w.github.results.delete(7);
    expect((await webPress(w)).status).toBe(200);
    expect(w.github.mergeCalls).toHaveLength(2);
  });

  it("is released when the head moved under the press, and for a refusal in the confirmation path too", async () => {
    const moved = await ready();
    moved.github.results.set(7, { outcome: "refused", reason: "head_changed" });
    await codeOf(webPress(moved));
    expect(claimOf(moved)).toBeUndefined();
    const confirm = await ready();
    confirm.github.results.set(7, { outcome: "refused", reason: "forbidden" });
    const body = NeedsConfirmationSchema.parse((await tokenPress(confirm)).body);
    await confirm.decide(confirm.approvalIdOf(body.confirmUrl), await confirm.browser(PRIYA, confirm.approvalIdOf(body.confirmUrl)));
    expect(claimOf(confirm)).toBeUndefined();
  });

  it("is kept when the outcome is unknown (GitHub failed or timed out): the next run reads the pull request and finds out", async () => {
    const w = await ready();
    w.github.results.set(7, new Error("GitHub is down"));
    await codeOf(webPress(w));
    expect(claimOf(w)).toMatchObject({ by: PRIYA, headSha: HEAD_A });
  });

  it("never removes a claim somebody else took in the meantime", async () => {
    const w = await ready();
    w.github.results.set(7, { outcome: "refused", reason: "not_mergeable" });
    w.github.onMerge = async () => {
      w.db.set({ ...w.trackingOf({ repositoryId: "payments", number: 7 })!, mergeClaim: { headSha: HEAD_A, by: ARJUN, at: new Date(w.clock.now + 1000).toISOString() } });
    };
    await codeOf(webPress(w));
    expect(claimOf(w)).toMatchObject({ by: ARJUN });
  });

  it("is kept after a merge (a retry after a crash finds the pull request merged)", async () => {
    const w = await ready();
    await webPress(w);
    expect(claimOf(w)).toMatchObject({ by: PRIYA });
  });
});

describe("no machine merges", () => {
  it("a token press never merges: it gets the confirmation link and GitHub is not called", async () => {
    const w = await ready();
    const reply = await tokenPress(w);
    expect(reply.status).toBe(202);
    NeedsConfirmationSchema.parse(reply.body);
    expect(w.github.mergeCalls).toEqual([]);
    expect(w.github.calls.filter((call) => call.startsWith("merge"))).toEqual([]);
  });

  it("a token cannot claim to be a browser: the body takes no such field, and the flag is not the body's", async () => {
    const w = await ready();
    expect(await codeOf(tokenPress(w, PRIYA, { browserSession: true }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await codeOf(tokenPress(w, PRIYA, { risk: "low", confirmed: true }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("a token press with a risk level is still only a confirmation link", async () => {
    const w = await ready();
    expect((await tokenPress(w, PRIYA, { risk: "low" })).status).toBe(202);
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("the confirmation page still demands the fresh sign-in, and a token cannot decide", async () => {
    const w = await ready();
    const reply = await tokenPress(w);
    const body = NeedsConfirmationSchema.parse(reply.body);
    const approvalId = w.approvalIdOf(body.confirmUrl);
    await expect(w.kind.decide({ orgId: w.orgId, developerId: PRIYA, approvalId }, "approve", { kind: "none" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.github.mergeCalls).toEqual([]);
  });

  it("over the route: a caller the web boundary vouched for merges; the same call with a token answers 202", async () => {
    const w = await ready();
    const route = (caller: unknown) => routeAgentSessionRequest(
      { ...w.shareDeps, origin: CELL, approvals: w.deps } as never, caller as never,
      { method: "POST", path: `/v1/app/sessions/${w.sessionId}/merge`, headers: {}, requestId: "r", body: JSON.stringify({ requestId: w.requestId(), risk: "low" }) }, new URL(`${CELL}/v1/app/sessions/${w.sessionId}/merge`),
    );
    expect(await route(w.caller(PRIYA))).toMatchObject({ statusCode: 202, body: { status: "NEEDS_CONFIRMATION" } });
    expect(w.github.mergeCalls).toEqual([]);
    expect(await route(browser(w))).toMatchObject({ statusCode: 200, body: { status: "MERGED" } });
    expect(w.github.mergeCalls).toHaveLength(1);
  });
});
