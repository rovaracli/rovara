// Rovara Code (bug I): a GitHub review wakes merge tracking. Reviews enter tracking only inside a tracking pass, so before this a person's approval waited for the 15-minute heartbeat
// (and the 5-minute sweep) before Rovara's Merge stopped saying "Not reviewed yet". A `pull_request_review` delivery (submitted, edited or dismissed), and a pull request that is made ready,
// pushed to or reopened, now wake the task's tracking row the way a check or status delivery does. The delivery is only a nudge: the pass reads the reviews and the permissions live.
import { createHmac, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { githubInstallationKey } from "../../packages/contracts/src/org-node.js";
import { TRACKING_COALESCE_SECONDS, TRACKING_GATE_SECONDS, TRACKING_HEARTBEAT_MINUTES, TRACKING_REVIEW_COALESCE_SECONDS } from "../../packages/contracts/src/rovara-code.js";
import { authorizeLinkedGithubWebhook, handleGithubWebhook, type PullRequestWebhookEvent } from "../../packages/broker/src/aws/github-webhooks.js";
import { runDueWorkflowMergeTracking, trackingRecoveryItem } from "../../packages/broker/src/aws/workflow-merge-recovery.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { mergeViewOf } from "../../packages/broker/src/rovara-code/merge.js";
import { trackTask, type MergeTrackingDependencies, type TrackedTask } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { boundInstallationOrg, wakeFromPullRequestEvent, wakesTrackingRow, type HeadEventDependencies } from "../../packages/broker/src/rovara-code/tracking-events.js";
import { HEAD_A, NOW, TABLE, TASK_ID, FakeGithub, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { GH, LOGIN, mergeWorld } from "../support/rovara-code-merge-world.js";
import { PRIYA } from "../support/agent-session-world.js";
import { TEST_ORG } from "../support/orgs.js";

const SECRET = "webhook-secret";
const INSTALLATION = 777;
const REPOSITORY = 1234;
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as typeof TEST_ORG;
const COALESCE = TRACKING_COALESCE_SECONDS * 1_000;
const REVIEW_COALESCE = TRACKING_REVIEW_COALESCE_SECONDS * 1_000;
const GATE = TRACKING_GATE_SECONDS * 1_000;
const HEARTBEAT = TRACKING_HEARTBEAT_MINUTES * 60_000;
const sign = (body: string): string => `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

const review = (action: string, source: "review" | "review_comment" | "pr_discussion" = "review"): PullRequestWebhookEvent => ({
  kind: "PR_COMMENT", action, installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", number: 7,
  comment: { id: 99, body: "Looks good", truncated: false, url: "https://github.com/acme/payments/pull/7#pullrequestreview-99", author: "maint", source },
});
const pullRequest = (action: string, extra: Partial<PullRequestWebhookEvent> = {}): PullRequestWebhookEvent => ({
  kind: "PULL_REQUEST", action, installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", number: 7, ...extra,
});

interface Setup { w: TrackingWorld; deps: HeadEventDependencies }

async function setup(options: { installationOrg?: string; installationStatus?: string } = {}): Promise<Setup> {
  const w = world();
  w.db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: options.installationOrg ?? TEST_ORG, status: options.installationStatus ?? "active" });
  for (const key of [...w.db.items.keys()]) if (key.includes("WORKFLOW_MERGE_RECOVERY")) w.db.items.delete(key);
  await w.db.send(new TransactWriteCommand({ TransactItems: [trackingRecoveryItem(TABLE, TASK_ID, new Date(NOW + HEARTBEAT).toISOString())] }));
  const deps: HeadEventDependencies = {
    documentClient: w.db, tableName: TABLE, now: () => w.now(), loadTask: (id) => w.deps.loadTask(id), repositoryUrl: (...args) => w.deps.repositoryUrl(...args),
    verifyRepository: async () => true, orgOfInstallation: (id) => boundInstallationOrg({ documentClient: w.db, tableName: TABLE }, id),
  };
  return { w, deps };
}
const row = (w: TrackingWorld) => w.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${TASK_ID}`)!;

describe("which pull request deliveries wake the tracking row", () => {
  it("wakes for a review that is submitted, edited or dismissed, and for a pull request made ready, pushed to or reopened", () => {
    for (const action of ["submitted", "edited", "dismissed"]) expect(wakesTrackingRow(review(action)), action).toBe(true);
    for (const action of ["ready_for_review", "synchronize", "reopened"]) expect(wakesTrackingRow(pullRequest(action)), action).toBe(true);
  });

  it("does not wake for the other pull request actions, a plain comment, or an event the broker raised itself (installation 0)", () => {
    for (const action of ["opened", "closed", "edited", "converted_to_draft"]) expect(wakesTrackingRow(pullRequest(action)), action).toBe(false);
    for (const source of ["review_comment", "pr_discussion"] as const) expect(wakesTrackingRow(review("created", source)), source).toBe(false);
    expect(wakesTrackingRow({ ...pullRequest("synchronize"), installationId: 0 })).toBe(false);
    expect(wakesTrackingRow({ ...review("submitted"), installationId: 0 })).toBe(false);
  });
});

describe("wakeFromPullRequestEvent", () => {
  // Approval-to-ready latency (0.4.13 rehearsal: 62 s, worst about 93 s): a person's review is waited for, so its wake is due in 10 seconds; the other deliveries keep the 30 seconds that lets a CI run's
  // many jobs and a push's events coalesce.
  it("wakes the tracking row of the task the pull request belongs to: a review to now plus 10 seconds, a pull request action to now plus 30", async () => {
    expect(REVIEW_COALESCE).toBe(10_000);
    for (const event of [review("submitted"), review("edited"), review("dismissed"), pullRequest("ready_for_review"), pullRequest("synchronize"), pullRequest("reopened")]) {
      const s = await setup();
      expect(await wakeFromPullRequestEvent(s.deps, event), event.action).toBe("woken");
      expect(row(s.w), event.action).toMatchObject({ wakeAt: NOW, nextAttemptAt: NOW + (event.kind === "PR_COMMENT" ? REVIEW_COALESCE : COALESCE) });
    }
  });

  it("coalesces a burst of review deliveries into the first one's time, and a later, longer wake never pushes it back", async () => {
    const s = await setup();
    await wakeFromPullRequestEvent(s.deps, review("submitted"));
    s.w.setNow(s.w.now() + 1_000);
    await wakeFromPullRequestEvent(s.deps, review("edited"));
    s.w.setNow(s.w.now() + 1_000);
    await wakeFromPullRequestEvent(s.deps, pullRequest("synchronize"));
    expect(row(s.w).nextAttemptAt).toBe(NOW + REVIEW_COALESCE);
  });

  it("leaves the row alone for an action that does not wake it, and for a plain comment", async () => {
    const s = await setup();
    const before = structuredClone(row(s.w));
    for (const event of [pullRequest("opened"), pullRequest("closed"), pullRequest("converted_to_draft"), review("created", "pr_discussion"), review("created", "review_comment")]) {
      expect(await wakeFromPullRequestEvent(s.deps, event)).toBe("unfollowed");
    }
    expect(row(s.w)).toEqual(before);
  });

  it("is idempotent: twenty redeliveries are one pass, the row's time set once and never later", async () => {
    const s = await setup();
    await wakeFromPullRequestEvent(s.deps, review("submitted"));
    const first = row(s.w).nextAttemptAt;
    for (let delivery = 0; delivery < 20; delivery += 1) {
      s.w.setNow(s.w.now() + 100);
      expect(await wakeFromPullRequestEvent(s.deps, review("submitted"))).toBe("woken");
      expect(row(s.w).nextAttemptAt).toBe(first);
    }
  });

  it("is scoped to the installation's org: another org's binding, a suspended or unbound installation, or a task of another org wake nothing", async () => {
    const before = async (s: Setup) => structuredClone(row(s.w));
    const other = await setup({ installationOrg: OTHER_ORG });
    const otherBefore = await before(other);
    expect(await wakeFromPullRequestEvent(other.deps, review("submitted"))).toBe("unfollowed");
    expect(row(other.w)).toEqual(otherBefore);
    const suspended = await setup({ installationStatus: "suspended" });
    expect(await wakeFromPullRequestEvent(suspended.deps, review("submitted"))).toBe("unfollowed");
    expect(row(suspended.w).wakeAt).toBeUndefined();
    const unbound = await setup();
    expect(await wakeFromPullRequestEvent(unbound.deps, { ...review("submitted"), installationId: 4242 })).toBe("unfollowed");
    expect(row(unbound.w).wakeAt).toBeUndefined();
    const crossed = await setup();
    crossed.w.setTask({ orgId: OTHER_ORG });
    expect(await wakeFromPullRequestEvent(crossed.deps, review("submitted"))).toBe("unfollowed");
    expect(row(crossed.w).wakeAt).toBeUndefined();
  });

  it("wakes nothing when the pull request is not linked to a task, its link names another task, or the pinned repository is another one", async () => {
    const unlinked = await setup();
    expect(await wakeFromPullRequestEvent(unlinked.deps, { ...review("submitted"), number: 99 })).toBe("unfollowed");
    const relinked = await setup();
    relinked.w.db.set({ ...relinked.w.db.get("GITHUB_PR#acme/payments", "PR#0000000007")!, taskId: "00000000-0000-4000-8000-0000000000b2" });
    expect(await wakeFromPullRequestEvent(relinked.deps, review("submitted"))).toBe("unfollowed");
    expect(row(relinked.w).wakeAt).toBeUndefined();
    const repinned = await setup();
    const url = repinned.deps.repositoryUrl.bind(repinned.deps);
    repinned.deps.repositoryUrl = async (...args) => (await url(...args))?.replace("payments", "other");
    expect(await wakeFromPullRequestEvent(repinned.deps, review("submitted"))).toBe("unfollowed");
    expect(row(repinned.w).wakeAt).toBeUndefined();
  });

  it("wakes nothing for a task that is closed or finished, and makes no row for a task that has none", async () => {
    for (const change of ["closed", "finished"]) {
      const s = await setup();
      if (change === "closed") s.w.setTask({ closedAt: "2026-10-25T10:00:00.000Z" });
      else s.w.setWorkflow({ stage: "MERGED", state: "COMPLETE" });
      expect(await wakeFromPullRequestEvent(s.deps, review("submitted")), change).toBe("unfollowed");
      expect(row(s.w).wakeAt, change).toBeUndefined();
    }
    const none = await setup();
    for (const key of [...none.w.db.items.keys()]) if (key.includes("WORKFLOW_MERGE_RECOVERY")) none.w.db.items.delete(key);
    expect(await wakeFromPullRequestEvent(none.deps, review("submitted"))).toBe("none");
    expect(none.w.db.find((item) => item.pk === "WORKFLOW_MERGE_RECOVERY")).toEqual([]);
  });
});

describe("approve, then the webhook, then the wake, then a pass: ready within one pass", () => {
  const arjun = { githubUserId: GH.arjun, login: LOGIN.arjun, userType: "User", commitId: HEAD_A };

  async function company() {
    const w = mergeWorld();
    await w.linkAll();
    w.settings();
    w.db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: w.orgId, status: "active" });
    const now = () => w.clock.now;
    const github = new FakeGithub();
    github.statuses.set(7, status({ number: 7, headSha: HEAD_A, draft: false, requestedReviewers: 1, reviews: [] }));
    github.permissions.set(LOGIN.arjun, "write");
    github.permissions.set(LOGIN.reader, "read");
    const tracking: MergeTrackingDependencies = {
      documentClient: w.db, tableName: "state", now, github, scope: (orgId) => ({ orgId }), loadTask: async (id) => w.db.get(taskKey(id)) as unknown as TrackedTask,
      repositoryUrl: async (_project, _revision, repositoryId) => `https://github.com/acme/${repositoryId}`, recordedHead: async () => undefined,
    };
    const wakeDeps: HeadEventDependencies = {
      documentClient: w.db, tableName: "state", now, loadTask: (id) => w.host.loadTask(id), repositoryUrl: (...args) => w.host.repositoryUrl(...args),
      verifyRepository: async () => true, orgOfInstallation: (id) => boundInstallationOrg({ documentClient: w.db, tableName: "state" }, id),
    };
    await w.db.send(new TransactWriteCommand({ TransactItems: [trackingRecoveryItem("state", w.taskId, new Date(now()).toISOString())] }));
    const trackNow = async (taskId: string) => { await trackTask(tracking, taskId); };
    const pass = (options: { wokenOnly?: true } = {}) => runDueWorkflowMergeTracking({
      documentClient: w.db, tableName: "state", now, reconcile: async (taskId) => { await trackNow(taskId); return { kind: "OBSERVED" }; },
    }, options);
    const merge = async () => {
      const items = [w.trackingOf({ repositoryId: "payments", number: 7 })!];
      return mergeViewOf(w.deps, w.db.get(taskKey(w.taskId))! as never, items, PRIYA);
    };
    /** GitHub delivers a `pull_request_review` webhook: signed, verified, scoped to the linked pull request, then processed as the broker does. */
    const deliver = async (state: string, deliveryId: string = randomUUID()) => {
      const body = JSON.stringify({
        action: "submitted", installation: { id: INSTALLATION }, repository: { id: REPOSITORY, full_name: "acme/payments" }, pull_request: { number: 7 },
        review: { id: 99, state, body: null, html_url: "https://github.com/acme/payments/pull/7#pullrequestreview-99", user: { login: LOGIN.arjun } },
      });
      const processed: PullRequestWebhookEvent[] = [];
      const outcome = await handleGithubWebhook({
        documentClient: w.db, tableName: "state", rawBody: body, headers: { "x-hub-signature-256": sign(body), "x-github-delivery": deliveryId, "x-github-event": "pull_request_review" }, secret: SECRET,
        authorizeRepository: (scope) => "headSha" in scope ? Promise.resolve(false) : authorizeLinkedGithubWebhook({
          documentClient: w.db, tableName: "state", scope, loadTask: async (id) => w.db.get(taskKey(id)) as never, repositoryUrl: (...args) => w.host.repositoryUrl(...(args as Parameters<typeof w.host.repositoryUrl>)), verifyRepository: async () => true,
        }),
        process: async (event) => {
          if (event.kind === "HEAD_STATUS") throw new Error("a review is not a head event");
          processed.push(event);
          await wakeFromPullRequestEvent(wakeDeps, event);
        },
        now: () => new Date(now()).toISOString(),
      });
      return { outcome, processed };
    };
    return { w, github, pass, trackNow, merge, deliver, now };
  }

  it("shows Not ready before the approval, then ready by the next pass (a minute) after the review webhook, not a heartbeat later", async () => {
    const c = await company();
    expect(await c.pass()).toMatchObject({ attempted: 1, reconciled: 1 });
    expect(await c.merge()).toMatchObject({ ready: false });
    const started = c.now();

    // The person approves on GitHub two minutes later; nothing has told Rovara yet, and the next pass is a heartbeat away.
    c.w.clock.now += 2 * 60_000;
    c.github.statuses.set(7, status({ number: 7, headSha: HEAD_A, draft: false, requestedReviewers: 1, reviews: [{ ...arjun, state: "APPROVED", submittedAt: new Date(c.now()).toISOString() }] }));
    expect(await c.pass()).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(await c.merge()).toMatchObject({ ready: false });

    // GitHub's webhook arrives; the wake brings the row forward to 10 seconds from now, and the schedule (every minute, through the pass's 60-second gate) runs it.
    const { outcome, processed } = await c.deliver("approved");
    expect(outcome.status).toBe("ACCEPTED");
    expect(processed).toHaveLength(1);
    expect(c.w.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${c.w.taskId}`)).toMatchObject({ wakeAt: c.now(), nextAttemptAt: c.now() + REVIEW_COALESCE });
    c.w.clock.now += GATE;
    expect(await c.pass()).toMatchObject({ attempted: 1, reconciled: 1 });
    expect(await c.merge()).toMatchObject({ ready: true });
    expect(c.now() - started).toBeLessThan(HEARTBEAT);
  });

  // The pass for a woken row does not wait out the 60-second gate that rations the heartbeat passes, and costs no more GitHub calls: only woken rows are read, once, and the gate is left as it was.
  it("passes a review-woken row within 15 seconds even while the heartbeat gate is closed, reads nothing else, and leaves the gate alone", async () => {
    const c = await company();
    const gate = () => c.w.db.get("WORKFLOW_MERGE_SWEEP", "TRACKING")?.nextSweepAt;
    const read: string[] = [];
    const passWith = (options: { wokenOnly?: true } = {}) => runDueWorkflowMergeTracking({
      documentClient: c.w.db, tableName: "state", now: c.now, reconcile: async (taskId) => { read.push(taskId); if (taskId === c.w.taskId) await c.trackNow(taskId); return { kind: "OBSERVED" }; },
    }, options);
    expect(await passWith()).toMatchObject({ attempted: 1 });
    const closedUntil = gate();
    read.length = 0;
    c.w.clock.now += 20_000;
    // A second followed task whose heartbeat has come due since: the woken pass must not touch it (the gated heartbeat pass will).
    const OTHER = "00000000-0000-4000-8000-0000000000c3";
    c.w.db.set({ ...c.w.db.get(taskKey(c.w.taskId))!, pk: `DEVTASK#${OTHER}`, taskId: OTHER });
    await c.w.db.send(new TransactWriteCommand({ TransactItems: [trackingRecoveryItem("state", OTHER, new Date(c.now() - 1_000).toISOString())] }));
    const approvedAt = c.now();
    c.github.statuses.set(7, status({ number: 7, headSha: HEAD_A, draft: false, requestedReviewers: 1, reviews: [{ ...arjun, state: "APPROVED", submittedAt: new Date(approvedAt).toISOString() }] }));
    c.w.clock.now += 3_000;
    await c.deliver("approved");
    c.w.clock.now += REVIEW_COALESCE;
    // The scheduled heartbeat pass is still behind its gate (the heartbeat gate is kept) ...
    expect(await passWith()).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(read).toEqual([]);
    // ... and the pass for woken rows runs the one woken task, once.
    expect(await passWith({ wokenOnly: true })).toMatchObject({ attempted: 1, reconciled: 1 });
    expect(read).toEqual([c.w.taskId]);
    expect(await c.merge()).toMatchObject({ ready: true });
    expect(c.now() - approvedAt).toBeLessThanOrEqual(15_000);
    expect(gate()).toBe(closedUntil);
    // Nothing is woken now: a second woken pass reads nothing.
    expect(await passWith({ wokenOnly: true })).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(read).toEqual([c.w.taskId]);
  });

  it("makes one pass of a burst of review deliveries, however many arrive", async () => {
    const c = await company();
    await c.pass();
    c.w.clock.now += 20_000;
    c.github.statuses.set(7, status({ number: 7, headSha: HEAD_A, draft: false, requestedReviewers: 1, reviews: [{ ...arjun, state: "APPROVED", submittedAt: new Date(c.now()).toISOString() }] }));
    for (const state of ["approved", "commented", "approved"]) {
      await c.deliver(state);
      c.w.clock.now += 700;
    }
    c.w.clock.now += REVIEW_COALESCE;
    expect(await c.pass({ wokenOnly: true })).toMatchObject({ attempted: 1, reconciled: 1 });
    expect(await c.pass({ wokenOnly: true })).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
  });

  it("is a no-op beyond one extra pass when GitHub redelivers the webhook", async () => {
    const c = await company();
    await c.pass();
    c.w.clock.now += 60_000;
    c.github.statuses.set(7, status({ number: 7, headSha: HEAD_A, draft: false, requestedReviewers: 1, reviews: [{ ...arjun, state: "APPROVED", submittedAt: new Date(c.now()).toISOString() }] }));
    const deliveryId = randomUUID();
    expect((await c.deliver("approved", deliveryId)).outcome.status).toBe("ACCEPTED");
    expect((await c.deliver("approved", deliveryId)).outcome.status).toBe("DUPLICATE");
    c.w.clock.now += GATE;
    expect(await c.pass()).toMatchObject({ attempted: 1 });
    expect(await c.merge()).toMatchObject({ ready: true });
    expect(await c.pass()).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
  });

  it("never believes the webhook's word for the approval: the pass reads GitHub, and a read-only reviewer's approval does not count", async () => {
    const c = await company();
    await c.pass();
    c.w.clock.now += 60_000;
    // The body says APPROVED, but the live reviews hold only a read-only person's approval.
    c.github.statuses.set(7, status({ number: 7, headSha: HEAD_A, draft: false, requestedReviewers: 1, reviews: [{ githubUserId: GH.reader, login: LOGIN.reader, userType: "User", commitId: HEAD_A, state: "APPROVED", submittedAt: new Date(c.now()).toISOString() }] }));
    await c.deliver("approved");
    c.w.clock.now += GATE;
    expect(await c.pass()).toMatchObject({ attempted: 1 });
    expect(await c.merge()).toMatchObject({ ready: false });
    // And a webhook that says nothing of approval still shows one that GitHub has.
    c.w.clock.now += 60_000;
    c.github.statuses.set(7, status({ number: 7, headSha: HEAD_A, draft: false, requestedReviewers: 1, reviews: [{ ...arjun, state: "APPROVED", submittedAt: new Date(c.now()).toISOString() }] }));
    await c.deliver("commented");
    c.w.clock.now += GATE;
    await c.pass();
    expect(await c.merge()).toMatchObject({ ready: true });
  });
});
