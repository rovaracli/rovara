// Rovara Code (Plan 6 Task 14): merge tracking from GitHub, with a fake GitHub. The task follows its pull requests through tracking items that are written only when
// a decision-relevant fact changes; it marks a draft ready and asks for reviewers; it never merges.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeTrackingKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { TRACKING_REQUESTS_BASE, TRACKING_REQUESTS_PER_EXTRA_PR, type MergeTrackingItem } from "../../packages/contracts/src/rovara-code.js";
import {
  PUSH_WAS_MINE_MESSAGE, SOMEONE_ELSE_PUSHED_MESSAGE, nextMergeAction, readCi, reconcileTrackingTask, registerMergeActionDecider, trackPullRequest, trackTask,
  trackingRequestCap, type MergeActionRequest,
} from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { registerCodeMilestoneHandler } from "../../packages/broker/src/rovara-code/milestones.js";
import { DEFAULT_CODE_SETTINGS } from "../../packages/contracts/src/rovara-code.js";
import { codeSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { GithubMergeRateLimitError } from "../../packages/broker/src/github-app.js";
import { HEAD_A, HEAD_B, NOW, SESSION_ID, TASK_ID, sha, status, workflowOf, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

const trackingKey = (number = 7, repository = "payments") => mergeTrackingKey(TASK_ID, repository, number);
const itemOf = (w: TrackingWorld, number = 7, repository = "payments") => w.db.get(trackingKey(number, repository)) as unknown as MergeTrackingItem & Record<string, unknown>;
const passing = [{ name: "test", status: "completed" as const, conclusion: "success" as const, required: false, url: "" }];
const failing = [{ name: "test", status: "completed" as const, conclusion: "failure" as const, required: false, url: "" }];
const pendingCheck = [{ name: "test", status: "pending" as const, required: false, url: "" }];
const settingsWith = (w: TrackingWorld, codeReviewers: string[]) => w.db.set({ ...codeSettingsKey(TEST_ORG, "web"), allowSelfApproval: false, mergeMethod: "squash", codeReviewers, revision: 1 });
const unregister: Array<() => void> = [];
afterEach(() => { while (unregister.length > 0) unregister.pop()!(); });

describe("ready for review", () => {
  it("waits while checks are pending, then marks the draft ready, asks for reviewers once and says pr_ready once", async () => {
    const heard: string[] = [];
    unregister.push(registerCodeMilestoneHandler({ name: "tracking_test", on: async (_deps, milestone) => { heard.push(`${milestone.kind}:${milestone.text}`); } }));
    const w = world();
    settingsWith(w, ["alice", "acme/core"]);
    w.github.statuses.set(7, status({ checks: pendingCheck }));
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("changed");
    expect(w.github.calls.filter((call) => call.startsWith("ready") || call.startsWith("reviewers"))).toEqual([]);
    expect(itemOf(w)).toMatchObject({ ci: "pending", draft: true, version: 1 });
    expect(itemOf(w).readyAt).toBeUndefined();

    w.github.statuses.set(7, status({ checks: passing }));
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("changed");
    expect(w.github.calls.filter((call) => call.startsWith("ready") || call.startsWith("reviewers"))).toEqual(["ready:7", "reviewers:7:alice,acme/core"]);
    expect(itemOf(w)).toMatchObject({ ci: "passing", draft: false, readyAt: new Date(NOW).toISOString(), reviewersRequestedAt: new Date(NOW).toISOString() });
    expect(heard).toEqual(["pr_ready:Rovara marked payments pull request 7 ready for review."]);

    // Again: nothing more is asked of GitHub, nothing more is said.
    w.github.calls.length = 0;
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("unchanged");
    expect(w.github.calls.filter((call) => call.startsWith("ready") || call.startsWith("reviewers"))).toEqual([]);
    expect(heard).toHaveLength(1);
  });

  it("asks for no reviewers when GitHub already lists some, or when the project names none", async () => {
    const listed = world();
    settingsWith(listed, ["alice"]);
    listed.github.statuses.set(7, status({ requestedReviewers: 1 }));
    await trackPullRequest(listed.deps, TASK_ID);
    expect(listed.github.calls.some((call) => call.startsWith("reviewers"))).toBe(false);
    expect(listed.github.calls).toContain("ready:7");
    const none = world();
    await trackPullRequest(none.deps, TASK_ID);
    expect(none.github.calls.some((call) => call.startsWith("reviewers"))).toBe(false);
  });

  it("does not mark ready when the head is not Rovara's, the checks fail, or the pull request is not open", async () => {
    for (const odd of [
      status({ headSha: HEAD_B, checks: passing }),
      status({ checks: failing }),
      status({ state: "closed", checks: passing }),
    ]) {
      const w = world();
      w.github.statuses.set(7, odd);
      await trackPullRequest(w.deps, TASK_ID);
      expect(w.github.calls.some((call) => call.startsWith("ready"))).toBe(false);
      expect(itemOf(w).readyAt).toBeUndefined();
    }
  });

  it("recovers a pass that marked the pull request ready but died before it wrote: the next pass records it and asks for the reviewers", async () => {
    const w = world();
    settingsWith(w, ["alice"]);
    w.github.statuses.set(7, status({ draft: false, checks: passing }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(w.github.calls.some((call) => call === "ready:7")).toBe(false);
    expect(itemOf(w).readyAt).toBeDefined();
    expect(w.github.calls).toContain("reviewers:7:alice");
  });

  it("never presses merge: GitHub is never asked for anything but reads, readiness and reviewers", async () => {
    const w = world();
    settingsWith(w, ["alice"]);
    await trackPullRequest(w.deps, TASK_ID);
    expect(w.github.calls.every((call) => /^(status|permission|ready|reviewers):/.test(call))).toBe(true);
  });
});

describe("no CI", () => {
  const w0 = () => {
    const w = world();
    w.github.statuses.set(7, status({ checks: [], headHasWorkflowFiles: true }));
    return w;
  };

  it("right after a push, a pull request with workflow files and no check yet stays pending", async () => {
    const w = w0();
    await trackPullRequest(w.deps, TASK_ID);
    w.setNow(NOW + 60 * 60_000);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "pending", checksEverSeen: false });
    expect(w.github.calls.some((call) => call.startsWith("ready"))).toBe(false);
  });

  it("with no workflow files, none only after a full sweep interval, then it is marked ready", async () => {
    const w = world();
    w.github.statuses.set(7, status({ checks: [], headHasWorkflowFiles: false }));
    const first = await trackTask(w.deps, TASK_ID);
    expect(itemOf(w).ci).toBe("pending");
    expect(first.recheckAt).toBe(NOW + 5 * 60_000);
    w.setNow(NOW + 5 * 60_000 - 1);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).ci).toBe("pending");
    w.setNow(NOW + 5 * 60_000);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "none", draft: false });
    expect(w.github.calls).toContain("ready:7");
  });

  it("a status that appeared once and then is missing on a new head reads pending, not none", async () => {
    const w = world();
    w.github.statuses.set(7, status({ checks: [{ name: "external/ci", status: "completed", conclusion: "success", required: false, url: "" }], draft: true, headHasWorkflowFiles: false }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).checksEverSeen).toBe(true);
    w.setNow(NOW + 60 * 60_000);
    w.github.statuses.set(7, status({ checks: [], headHasWorkflowFiles: false, draft: true }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "pending", checksEverSeen: true });
  });
});

describe("which checks count", () => {
  const check = (name: string, conclusion: "success" | "failure", required: boolean) => ({ name, status: "completed" as const, conclusion, required, url: "" });
  const read = (input: Partial<ReturnType<typeof status>>) => readCi(status(input), { checksEverSeen: true, lastRovaraPushAt: NOW - 1e9, now: NOW });

  it("an unprotected base counts every check: a red non-required test is failing, on the all-checks basis", async () => {
    const w = world();
    w.github.statuses.set(7, status({ checks: [check("test", "failure", false)], baseHasRequiredChecks: false }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "failing", ciBasis: "all_checks", failingChecks: ["test"] });
  });

  it("a protected base ignores a non-required failure, and a required one that has not reported is pending", () => {
    expect(read({ checks: [check("build", "success", true), check("lint", "failure", false)], baseHasRequiredChecks: true })).toMatchObject({ ci: "passing", ciBasis: "required", failingChecks: [] });
    expect(read({ checks: [check("lint", "success", false)], baseHasRequiredChecks: true })).toMatchObject({ ci: "pending", ciBasis: "required" });
    expect(read({ checks: [check("build", "failure", true)], baseHasRequiredChecks: true })).toMatchObject({ ci: "failing", failingChecks: ["build"] });
  });

  it("an unfinished counted check is pending, a cancelled or timed-out one failing, an action-required one pending, a skipped one passing", () => {
    const run = (conclusion: string | undefined, state: "completed" | "pending" = "completed") =>
      read({ checks: [{ name: "x", status: state, ...(conclusion === undefined ? {} : { conclusion: conclusion as never }), required: false, url: "" }] }).ci;
    expect(run(undefined, "pending")).toBe("pending");
    expect(run("cancelled")).toBe("failing");
    expect(run("timed_out")).toBe("failing");
    expect(run("action_required")).toBe("pending");
    expect(run("skipped")).toBe("passing");
    expect(run("neutral")).toBe("passing");
  });

  it("keeps ten failing check names at most, each once", () => {
    const many = Array.from({ length: 14 }, (_, index) => check(`job-${String(index)}`, "failure", false));
    expect(read({ checks: [...many, check("job-0", "failure", false)] }).failingChecks).toHaveLength(10);
  });
});

describe("approvals and reviews", () => {
  const review = (id: number, login: string, state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED", at: string, userType = "User") =>
    ({ githubUserId: String(id), login, userType, state, commitId: HEAD_A, submittedAt: `2026-10-25T${at}:00.000Z` });

  it("counts an approval only from a person with write access, and takes the latest review of each reviewer", async () => {
    const w = world();
    w.github.permissions.set("maint", "write");
    w.github.permissions.set("reader", "read");
    w.github.statuses.set(7, status({ reviews: [review(1, "maint", "APPROVED", "09:00"), review(2, "reader", "APPROVED", "09:30")] }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ review: "approved", approval: { githubUserId: "1", login: "maint", commitId: HEAD_A } });

    // The same reviewer later asks for changes, or has the approval dismissed: not approved.
    w.github.statuses.set(7, status({ reviews: [review(1, "maint", "APPROVED", "09:00"), review(1, "maint", "CHANGES_REQUESTED", "10:00")] }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ review: "changes_requested" });
    expect(itemOf(w).approval).toBeUndefined();
    w.github.statuses.set(7, status({ reviews: [review(1, "maint", "APPROVED", "09:00"), review(1, "maint", "DISMISSED", "10:00")] }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).review).toBe("not_requested");
  });

  it("does not count a bot, a read-only member, a comment, or more reviewers than it looks up", async () => {
    const w = world();
    w.github.permissions.set("bot[bot]", "write");
    w.github.statuses.set(7, status({ reviews: [review(3, "bot[bot]", "APPROVED", "09:00", "Bot"), review(4, "talker", "COMMENTED", "09:10")] }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).review).toBe("not_requested");
    expect(w.github.calls.some((call) => call.startsWith("permission"))).toBe(false);

    const crowd = world();
    const reviews = Array.from({ length: 9 }, (_, index) => review(10 + index, `person${String(index)}`, "APPROVED", "09:00"));
    for (const entry of reviews) crowd.github.permissions.set(entry.login, "write");
    crowd.github.statuses.set(7, status({ reviews }));
    await trackPullRequest(crowd.deps, TASK_ID);
    expect(itemOf(crowd)).toMatchObject({ review: "requested" });
    expect(itemOf(crowd).approval).toBeUndefined();
  });

  it("looks each permission up once a pass and fails closed (tries again) when it cannot", async () => {
    const w = world({ pullRequests: [{ repositoryId: "payments", number: 7 }, { repositoryId: "payments-ui", number: 8 }] });
    w.github.permissions.set("maint", "write");
    w.github.statuses.set(7, status({ number: 7, reviews: [review(1, "maint", "APPROVED", "09:00")] }));
    w.github.statuses.set(8, status({ number: 8, reviews: [review(1, "maint", "APPROVED", "09:00")] }));
    await trackPullRequest(w.deps, TASK_ID);
    // Different repositories are different permissions.
    expect(w.github.calls.filter((call) => call === "permission:maint")).toHaveLength(2);
    const broken = world();
    broken.github.getRepositoryPermission = async () => { throw new Error("GitHub is down"); };
    broken.github.statuses.set(7, status({ reviews: [review(1, "maint", "APPROVED", "09:00")] }));
    await expect(trackPullRequest(broken.deps, TASK_ID)).rejects.toThrow(/down/);
    expect(broken.db.get(trackingKey())).toBeUndefined();
  });
});

describe("the branch", () => {
  it.each([
    [{ mergeable: false, mergeableState: "dirty" as const }, "conflicted"],
    [{ mergeableState: "behind" as const, behindBy: undefined }, "behind"],
    [{ mergeableState: "blocked" as const, behindBy: 4 }, "behind"],
    [{ mergeableState: "clean" as const, behindBy: 0 }, "up_to_date"],
    [{ mergeableState: "unknown" as const, mergeable: undefined, behindBy: undefined }, "unknown"],
    [{ mergeableState: "draft" as const, mergeable: false }, "conflicted"],
  ])("reads %j as %s", async (change, expected) => {
    const w = world();
    const base = status(change as never);
    if ("mergeable" in change && change.mergeable === undefined) delete (base as { mergeable?: boolean }).mergeable;
    w.github.statuses.set(7, base);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).branch).toBe(expected);
  });
});

describe("what it writes, and when", () => {
  it("writes an item only when a decision-relevant fact changes, and a read that saw nothing new writes nothing", async () => {
    const w = world();
    w.github.statuses.set(7, status({ checks: pendingCheck }));
    await trackPullRequest(w.deps, TASK_ID);
    const before = structuredClone(itemOf(w));
    w.setNow(NOW + 3 * 60_000);
    const writes = vi.spyOn(w.db, "send");
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("unchanged");
    expect(writes.mock.calls.filter(([command]) => ["PutCommand", "UpdateCommand", "TransactWriteCommand"].includes((command as { constructor: { name: string } }).constructor.name))
      .filter(([command]) => JSON.stringify((command as { input: unknown }).input).includes("MERGE_TRACKING"))).toEqual([]);
    expect(itemOf(w)).toEqual(before);
    w.github.statuses.set(7, status({ checks: failing }));
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("changed");
    expect(itemOf(w)).toMatchObject({ version: 2, ci: "failing" });
    expect(itemOf(w).observedAt).toBe(new Date(NOW + 3 * 60_000).toISOString());
  });

  it("tracks twenty identical check_run wakes with one tracking write, and leaves the workflow and an owner's decision alone", async () => {
    const w = world();
    w.github.statuses.set(7, status({ checks: pendingCheck }));
    const task = structuredClone(w.task());
    for (let wake = 0; wake < 20; wake += 1) await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).version).toBe(1);
    expect(w.task()).toEqual(task);
    // The owner's feedback decision, a conditional write on the workflow revision, goes through.
    const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
    await expect(w.db.send(new UpdateCommand({
      TableName: "state", Key: { pk: `DEVTASK#${TASK_ID}`, sk: "META" }, UpdateExpression: "SET workflow.revision = :next", ConditionExpression: "workflow.revision = :revision",
      ExpressionAttributeValues: { ":next": 10, ":revision": 9 },
    }))).resolves.toBeDefined();
  });

  it("keeps the merge claim, nudges and syncs another task wrote, and never removes the claim", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    const claim = { headSha: HEAD_A, by: "presser", at: "2026-10-25T11:59:00.000Z" };
    const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
    await w.db.send(new UpdateCommand({
      TableName: "state", Key: trackingKey(), UpdateExpression: "SET mergeClaim = :claim, nudges = :nudges, #v = #v + :one",
      ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":claim": claim, ":nudges": { count: 2, lastAt: "2026-10-25T10:00:00.000Z" }, ":one": 1 },
    }));
    w.github.statuses.set(7, status({ checks: failing }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ mergeClaim: claim, nudges: { count: 2, lastAt: "2026-10-25T10:00:00.000Z" }, ci: "failing", version: 3 });
  });

  it("retries a write that lost to another writer's version, and gives up as retryable after three", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    w.github.statuses.set(7, status({ checks: failing }));
    const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
    const bump = () => w.db.send(new UpdateCommand({ TableName: "state", Key: trackingKey(), UpdateExpression: "SET #v = #v + :one", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":one": 1 } }));
    // A writer sneaks in once: the pass reads again and writes on top of it.
    const send = w.db.send.bind(w.db);
    let sneaked = false;
    w.deps.documentClient = { send: async (command: unknown) => {
      if (!sneaked && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" || (!sneaked && (command as { constructor: { name: string } }).constructor.name === "UpdateCommand" && JSON.stringify((command as { input: unknown }).input).includes("#version"))) { sneaked = true; await bump(); }
      return send(command as never);
    } };
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "failing", version: 3 });
    // Always losing: gives up.
    let loses = 0;
    w.github.statuses.set(7, status({ checks: pendingCheck }));
    w.deps.documentClient = { send: async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if ((name === "UpdateCommand" || name === "TransactWriteCommand") && JSON.stringify((command as { input: unknown }).input).includes("#version")) { loses += 1; await bump(); }
      return send(command as never);
    } };
    await expect(trackPullRequest(w.deps, TASK_ID)).rejects.toThrow(/changed by another writer/);
    expect(loses).toBe(3);
  });
});

describe("a task that is not tracked", () => {
  it("is gone when it is closed, finished, released, without an org, or a version 1 task", async () => {
    for (const change of [{ closedAt: "2026-10-25T10:00:00.000Z" }, { releasedAt: "2026-10-25T10:00:00.000Z" }, { orgId: undefined }]) {
      const w = world();
      w.setTask(change);
      expect(await trackPullRequest(w.deps, TASK_ID)).toBe("gone");
      expect(w.github.calls).toEqual([]);
    }
    const finished = world();
    finished.setWorkflow({ stage: "MERGED", state: "COMPLETE" });
    expect(await trackPullRequest(finished.deps, TASK_ID)).toBe("gone");
    const v1 = world({ definitionVersion: "1.0.0" });
    expect(await trackPullRequest(v1.deps, TASK_ID)).toBe("gone");
    expect(v1.github.calls).toEqual([]);
    expect(await trackPullRequest(v1.deps, "00000000-0000-4000-8000-0000000000ff")).toBe("gone");
  });

  it("refuses a pull request that is not the one linked to this task, or another org's item", async () => {
    const w = world();
    w.db.set({ ...w.db.get("GITHUB_PR#acme/payments", "PR#0000000007")!, taskId: "00000000-0000-4000-8000-0000000000b2" });
    await expect(trackPullRequest(w.deps, TASK_ID)).rejects.toThrow(/not linked/);
    expect(w.github.calls).toEqual([]);
    // A stored item of another org is not read as this task's: it is replaced by this org's own read.
    const other = world();
    other.db.set({ ...trackingKey(), entityType: "MERGE_TRACKING", orgId: "org_zzzzzzzzzzzzzzzzzzzz", taskId: TASK_ID, version: 41 });
    await expect(trackPullRequest(other.deps, TASK_ID)).rejects.toThrow();
  });

  it("refuses an answer for another pull request number", async () => {
    const w = world();
    w.github.statuses.set(7, status({ number: 9 }));
    await expect(trackPullRequest(w.deps, TASK_ID)).rejects.toThrow(/another pull request/);
  });
});

describe("Rovara's own push, and somebody else's", () => {
  const events = (w: TrackingWorld) => w.db.find((item) => typeof item.pk === "string" && item.pk.includes(SESSION_ID) && item.entityType === "AGENT_SESSION_EVENT").map((item) => item.text).filter((text) => !String(text).startsWith("Rovara marked"));

  it("its own synchronize arriving before its result leaves headByRovara true and says nothing", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    // A fix is being pushed: the workflow is not waiting; GitHub already shows the new head, the result is not recorded.
    w.setWorkflow({ stage: "PULL_REQUEST", state: "RUNNING" });
    w.github.statuses.set(7, status({ headSha: HEAD_B }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ headSha: HEAD_B, headByRovara: true });
    expect(events(w)).toEqual([]);
  });

  it("a push by someone else sends the exact message once and stops fix decisions; a later result naming that head takes it back", async () => {
    const decide = vi.fn((): MergeActionRequest | undefined => undefined);
    unregister.push(registerMergeActionDecider("ci_fix", decide));
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    decide.mockClear();
    w.github.statuses.set(7, status({ headSha: HEAD_B, checks: failing }));
    await trackPullRequest(w.deps, TASK_ID);
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ headSha: HEAD_B, headByRovara: false });
    expect(events(w)).toEqual([SOMEONE_ELSE_PUSHED_MESSAGE]);
    expect(decide).not.toHaveBeenCalled();

    // The push result is recorded later and names that head.
    w.setWorkflow({ pullRequests: workflowOf([{ repositoryId: "payments", number: 7, headSha: HEAD_B }]).pullRequests });
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).headByRovara).toBe(true);
    expect(events(w).sort()).toEqual([PUSH_WAS_MINE_MESSAGE, SOMEONE_ELSE_PUSHED_MESSAGE].sort());
  });

  it("the pull request record's head (moved by the push's own result first) counts as Rovara's", async () => {
    const w = world({ deps: { recordedHead: async () => HEAD_B } });
    w.github.statuses.set(7, status({ headSha: HEAD_B }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).headByRovara).toBe(true);
  });

  it("the first pass with an unknown head and nothing pending is someone else's", async () => {
    const w = world();
    w.github.statuses.set(7, status({ headSha: sha("d") }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w).headByRovara).toBe(false);
  });
});

describe("the next action", () => {
  const request = (slot: MergeActionRequest["slot"], world_: TrackingWorld): MergeActionRequest => ({
    slot, workflow: { ...(world_.task().workflow as object), revision: 10, stage: "IMPLEMENT", state: "READY", updatedAt: "2026-10-25T12:00:00.000Z" } as never,
    items: [{ Put: { TableName: "state", Item: { pk: "WORKFLOW_DISPATCH", sk: `TASK#${TASK_ID}#10`, entityType: "WORKFLOW_DISPATCH" } } }],
  });
  const asItem = (w: TrackingWorld) => itemOf(w) as MergeTrackingItem;

  it("is none while nothing is filled, and runs the slots in the order conflict, CI fix, feedback, sync, one at a time", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    expect(nextMergeAction(asItem(w), w.task().workflow as never, DEFAULT_CODE_SETTINGS, "prepare", NOW)).toEqual({ slot: "none", reason: "no_action" });
    const order: string[] = [];
    for (const slot of ["sync", "feedback", "ci_fix", "conflict"] as const) {
      unregister.push(registerMergeActionDecider(slot, () => { order.push(slot); return slot === "feedback" ? request(slot, w) : undefined; }));
    }
    const action = nextMergeAction(asItem(w), w.task().workflow as never, DEFAULT_CODE_SETTINGS, "prepare", NOW);
    expect(order).toEqual(["conflict", "ci_fix", "feedback"]);
    expect(action.slot).toBe("feedback");
    expect(() => registerMergeActionDecider("sync", () => undefined)).toThrow(/already/);
  });

  it("starts nothing while the task is not waiting for the merge, the pull request is not open, or the head is someone else's", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    unregister.push(registerMergeActionDecider("conflict", () => request("conflict", w)));
    const workflow = w.task().workflow as never;
    expect(nextMergeAction({ ...asItem(w), state: "closed" }, workflow, DEFAULT_CODE_SETTINGS, "prepare", NOW)).toMatchObject({ reason: "not_open" });
    expect(nextMergeAction({ ...asItem(w), headByRovara: false }, workflow, DEFAULT_CODE_SETTINGS, "prepare", NOW)).toMatchObject({ reason: "someone_else_pushed" });
    for (const change of [{ stage: "IMPLEMENT" }, { state: "RUNNING" }, { state: "BLOCKED" }]) {
      expect(nextMergeAction(asItem(w), { ...(workflow as object), ...change } as never, DEFAULT_CODE_SETTINGS, "prepare", NOW)).toMatchObject({ reason: "in_flight" });
    }
  });

  it("an owner's card that waits blocks every action, a conflict included, and red CI seen meanwhile shows with it", async () => {
    const w = world();
    const decide = vi.fn(() => request("conflict", w));
    unregister.push(registerMergeActionDecider("conflict", decide));
    w.setWorkflow({ feedbackReview: { status: "PENDING" } });
    w.github.statuses.set(7, status({ mergeable: false, mergeableState: "dirty", checks: failing }));
    const revision = (w.task().workflow as { revision: number }).revision;
    await trackPullRequest(w.deps, TASK_ID);
    expect(decide).not.toHaveBeenCalled();
    expect(itemOf(w)).toMatchObject({ branch: "conflicted", ci: "failing", failingChecks: ["test"] });
    expect((w.task().workflow as { revision: number }).revision).toBe(revision);
    const action = nextMergeAction(asItem(w), w.task().workflow as never, DEFAULT_CODE_SETTINGS, "prepare", NOW);
    expect(action).toEqual({ slot: "none", reason: "owner_card", ciFailures: ["test"] });
    // A card still being prepared waits too; one the owner decided does not.
    w.setWorkflow({ feedbackReview: { status: "COLLECTING" } });
    expect(nextMergeAction(asItem(w), w.task().workflow as never, DEFAULT_CODE_SETTINGS, "prepare", NOW)).toMatchObject({ reason: "owner_card" });
    w.setWorkflow({ feedbackReview: { status: "DISMISSED" } });
    expect(nextMergeAction(asItem(w), w.task().workflow as never, DEFAULT_CODE_SETTINGS, "prepare", NOW).slot).toBe("conflict");
  });

  it("commits an action's workflow and its dispatch row with the tracking item in one transaction, or none of them", async () => {
    const w = world();
    unregister.push(registerMergeActionDecider("ci_fix", () => request("ci_fix", w)));
    w.github.statuses.set(7, status({ checks: failing }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(itemOf(w)).toMatchObject({ ci: "failing" });
    expect(w.task().workflow).toMatchObject({ revision: 10, stage: "IMPLEMENT" });
    expect(w.db.get("WORKFLOW_DISPATCH", `TASK#${TASK_ID}#10`)).toBeDefined();

    // The workflow moved under it (the owner decided): the whole transaction is refused, the item stays as it was.
    const lost = world();
    unregister.push(() => undefined);
    const stale = request("ci_fix", lost);
    const spy = vi.fn(() => stale);
    const dropped = registerMergeActionDecider("conflict", spy);
    unregister.push(dropped);
    lost.github.statuses.set(7, status({ checks: failing }));
    const original = lost.deps.loadTask;
    let reads = 0;
    lost.deps.loadTask = async (id) => {
      const task = await original(id);
      reads += 1;
      if (reads === 2) lost.setWorkflow({ revision: 99 });
      return task;
    };
    await expect(trackPullRequest(lost.deps, TASK_ID)).rejects.toThrow();
    expect(lost.db.get(trackingKey())).toBeUndefined();
    expect(lost.db.get("WORKFLOW_DISPATCH", `TASK#${TASK_ID}#10`)).toBeUndefined();
  });
});

describe("the request allowance", () => {
  const budget = () => { let count = 0; return { count: () => count, budget: { signal: new AbortController().signal, beforeRequest: () => { count += 1; } } }; };

  it("is a base amount plus more for each pull request beyond the first", () => {
    expect(trackingRequestCap(1)).toBe(TRACKING_REQUESTS_BASE);
    expect(trackingRequestCap(3)).toBe(TRACKING_REQUESTS_BASE + 2 * TRACKING_REQUESTS_PER_EXTRA_PR);
  });

  it("a row over its allowance settles as a retry and the next pass finishes the pull requests it did not reach", async () => {
    const w = world({ pullRequests: [{ repositoryId: "a-api", number: 7 }, { repositoryId: "b-ui", number: 8 }, { repositoryId: "c-docs", number: 9 }] });
    w.github.statusCost = 10; // three pull requests cost 30 requests; the allowance for three is 24
    const parent = budget();
    const deps = { ...w.deps, observeMerge: async () => ({ kind: "OBSERVED" as const }) };
    const first = await reconcileTrackingTask(deps, TASK_ID, parent.budget);
    expect(first).toMatchObject({ kind: "RETRY", scope: "task" });
    expect(w.db.get(trackingKey(7, "a-api"))).toBeDefined();
    expect(w.db.get(trackingKey(8, "b-ui"))).toBeDefined();
    expect(w.db.get(trackingKey(9, "c-docs"))).toBeUndefined();
    const second = await reconcileTrackingTask(deps, TASK_ID, budget().budget);
    expect(second.kind).toBe("OBSERVED");
    expect(w.db.get(trackingKey(9, "c-docs"))).toBeDefined();
    expect(parent.count()).toBeLessThanOrEqual(trackingRequestCap(3));
  });

  it("turns GitHub's rate limit into the shared one and any other failure into a retry that names no text", async () => {
    const w = world();
    const deps = { ...w.deps, observeMerge: async () => ({ kind: "OBSERVED" as const }) };
    w.github.failWith = new GithubMergeRateLimitError(NOW + 600_000);
    expect(await reconcileTrackingTask(deps, TASK_ID, budget().budget)).toEqual({ kind: "RETRY", retryAt: NOW + 600_000, scope: "github-global" });
    w.github.failWith = new Error("token ghs_secret leaked in text");
    const logged: Array<Record<string, unknown>> = [];
    const result = await reconcileTrackingTask({ ...deps, log: (_event, fields) => logged.push(fields) }, TASK_ID, budget().budget);
    expect(result.kind).toBe("RETRY");
    expect(JSON.stringify(logged)).not.toContain("ghs_secret");
  });
});

describe("the merge observation beside tracking", () => {
  it("runs when a pull request is no longer open, and otherwise at most once per sweep interval", async () => {
    const w = world();
    const observe = vi.fn(async () => ({ kind: "OBSERVED" as const }));
    const deps = { ...w.deps, observeMerge: observe };
    const parent = { signal: new AbortController().signal, beforeRequest: () => undefined };
    await reconcileTrackingTask(deps, TASK_ID, parent);
    expect(observe).toHaveBeenCalledTimes(1);
    w.setNow(NOW + 60_000);
    await reconcileTrackingTask(deps, TASK_ID, parent);
    expect(observe).toHaveBeenCalledTimes(1);
    w.github.statuses.set(7, status({ state: "merged" }));
    w.setNow(NOW + 120_000);
    await reconcileTrackingTask(deps, TASK_ID, parent);
    expect(observe).toHaveBeenCalledTimes(2);
    w.github.statuses.set(7, status({ state: "open" }));
    w.setNow(NOW + 5 * 60_000 + 120_000);
    await reconcileTrackingTask(deps, TASK_ID, parent);
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it("passes on what the observation found when it is not simply 'observed' (a finished task retires its row)", async () => {
    const w = world();
    w.github.statuses.set(7, status({ state: "merged" }));
    const deps = { ...w.deps, observeMerge: async () => ({ kind: "TERMINAL" as const, release: "queued" as const }) };
    expect(await reconcileTrackingTask(deps, TASK_ID, { signal: new AbortController().signal, beforeRequest: () => undefined })).toEqual({ kind: "TERMINAL", release: "queued" });
  });

  it("asks the merge observation about a task tracking calls gone (closed), which is how its row is retired", async () => {
    const w = world();
    w.setTask({ closedAt: "2026-10-25T10:00:00.000Z" });
    const observe = vi.fn(async () => ({ kind: "TERMINAL" as const, release: "confirmed" as const }));
    expect(await reconcileTrackingTask({ ...w.deps, observeMerge: observe }, TASK_ID, { signal: new AbortController().signal, beforeRequest: () => undefined })).toEqual({ kind: "TERMINAL", release: "confirmed" });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("asks to be looked at again when the wait for 'no CI' ends", async () => {
    const w = world();
    w.github.statuses.set(7, status({ checks: [], headHasWorkflowFiles: false }));
    const deps = { ...w.deps, observeMerge: async () => ({ kind: "OBSERVED" as const }) };
    const result = await reconcileTrackingTask(deps, TASK_ID, { signal: new AbortController().signal, beforeRequest: () => undefined });
    expect(result).toEqual({ kind: "OBSERVED", nextAt: NOW + 5 * 60_000 });
  });
});
