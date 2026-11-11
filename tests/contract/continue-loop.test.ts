// "Continue in your own tool", the server side (decision 4; E-28..E-31, owner Q13): the working branch name in the task view, "Changed outside Rovara · checks needed" with the pusher's login,
// the publish-working-branch action and the manual Recheck. Rovara's own pushes are never flagged; an outside push is; a force-push is handled; the actions meet every guard of a person's paid work.
import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentXError, builtinSettingsKey, mergeTrackingKey, projectMetaKey, workspaceSessionKey } from "@rovara-code/contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import { publishWorkingBranchAction, recheckAction } from "../../packages/broker/src/aws/developer-tasks/continue-loop.js";
import { CHANGED_OUTSIDE_LABEL, ContinueLoopViewSchema, DeveloperTaskViewSchema, OUTSIDE_RECHECK_WORKER_MISSING, PUBLISHED_BRANCH_NOTE, RECHECK_NEEDS_PULL_REQUEST_NOTE, workingBranchName, type MergeTrackingItem } from "@agentx/cloud-contracts";
import { mergeTrackingDecisionDigest } from "../../packages/cloud-contracts/src/rovara-code-node.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { handleGithubWebhook, type BranchPushWebhookEvent, type PullRequestWebhookEvent } from "../../packages/broker/src/aws/github-webhooks.js";
import { continueLoopViewOf, outsideOfPublishedBranch, outsideOfPullRequest, outsidePushKey, publishWorkingBranch, readWorkingBranches, recheckPossible, recordOutsidePush, workingBranchKey, type WorkingBranchPort } from "../../packages/broker/src/aws/developer-tasks/continue-loop.js";
import { outsidePushTarget, recordOutsidePushEvent, type OutsidePushDependencies } from "../../packages/broker/src/rovara-code/outside-push.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { trackPullRequest } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { githubInstallationKey } from "../../packages/cloud-contracts/src/org-node.js";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { HEAD_A, HEAD_B, TABLE, TASK_ID, sha, status, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

const NOW = "2026-11-11T12:00:00.000Z";
const SECRET = "webhook-secret";
const HEAD_C = sha("c");
const BASE = sha("e");
const ORG_B = "org_zzzzzzzzzzzzzzzzzzzz" as typeof TEST_ORG;
const sign = (body: string): string => `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
type CheckAccess = DeveloperTaskRouteDependencies["checkAccess"];
const grantedAs = (role: "maintainer" | "contributor" | "viewer"): CheckAccess => async () => ({ revision: 1, policy: {} as never, access: "granted", channelIds: [], role });
const noAccess: CheckAccess = async () => { throw agentXError("PROJECT_ACCESS_DENIED", "no access"); };
const OWNER_CALLER: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member", developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack", name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
const trackingKey = (number = 7, repository = "payments") => mergeTrackingKey(TASK_ID, repository, number);
const hint = (headSha: string, login = "maya-codes", at = NOW) => ({ headSha, login, at });

// ---------------------------------------------------------------------------------------------------------------- the decision

describe("what counts as changed outside Rovara", () => {
  const item = (extra: Partial<MergeTrackingItem> = {}) => ({ repositoryId: "payments", number: 7, state: "open" as const, headSha: HEAD_B, headByRovara: false, ...extra });

  it("flags a pull request head that is not Rovara's, with the pusher only when the hint names that very head", () => {
    expect(outsideOfPullRequest({ item: item(), hint: hint(HEAD_B), canRecheck: true })).toEqual({ repository: "payments", number: 7, headSha: HEAD_B, lastPushedBy: { login: "maya-codes", at: NOW }, canRecheck: true });
    // A hint about an earlier head says nothing about who made this one.
    expect(outsideOfPullRequest({ item: item(), hint: hint(HEAD_A), canRecheck: false })).toEqual({ repository: "payments", number: 7, headSha: HEAD_B, canRecheck: false });
    expect(outsideOfPullRequest({ item: item(), hint: undefined, canRecheck: false })).not.toHaveProperty("lastPushedBy");
  });

  it("never flags Rovara's own head, nor a pull request that is not open", () => {
    expect(outsideOfPullRequest({ item: item({ headByRovara: true }), hint: hint(HEAD_B, "rovara[bot]"), canRecheck: true })).toBeUndefined();
    expect(outsideOfPullRequest({ item: item({ state: "merged" }), hint: hint(HEAD_B), canRecheck: true })).toBeUndefined();
    expect(outsideOfPullRequest({ item: item({ state: "closed" }), hint: hint(HEAD_B), canRecheck: true })).toBeUndefined();
  });

  it("a branch published on request is outside only when the host's push event names a head other than the one it was made at", () => {
    const branch = { repository: "payments", baseSha: BASE };
    expect(outsideOfPublishedBranch({ branch, hint: undefined })).toBeUndefined();
    expect(outsideOfPublishedBranch({ branch, hint: hint(BASE) })).toBeUndefined();
    expect(outsideOfPublishedBranch({ branch, hint: hint(HEAD_B) })).toEqual({ repository: "payments", headSha: HEAD_B, lastPushedBy: { login: "maya-codes", at: NOW }, canRecheck: false, recheckNote: RECHECK_NEEDS_PULL_REQUEST_NOTE });
  });

  it("a re-check is possible only while the task waits for the merge with nothing of Rovara's running on the open pull request", () => {
    const pullRequests = [{ repositoryId: "payments", number: 7, state: "OPEN", headSha: HEAD_A }];
    const workflow = (extra: Record<string, unknown> = {}) => ({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests, ...extra }) as never;
    expect(recheckPossible(workflow(), { repositoryId: "payments", number: 7 })).toBe(true);
    expect(recheckPossible(workflow({ state: "READY" }), { repositoryId: "payments", number: 7 })).toBe(false);
    expect(recheckPossible(workflow({ state: "RUNNING" }), { repositoryId: "payments", number: 7 })).toBe(false);
    expect(recheckPossible(workflow({ stage: "VERIFY" }), { repositoryId: "payments", number: 7 })).toBe(false);
    expect(recheckPossible(workflow({ branchSync: { repositoryId: "payments", number: 7 } }), { repositoryId: "payments", number: 7 })).toBe(false);
    expect(recheckPossible(workflow(), { repositoryId: "payments", number: 8 })).toBe(false);
    expect(recheckPossible(undefined, { repositoryId: "payments", number: 7 })).toBe(false);
  });
});

describe("the state, read through real merge tracking", () => {
  const rowOf = async (w: TrackingWorld, canRecheck = true) => {
    const items = [w.db.get(trackingKey()) as unknown as MergeTrackingItem];
    const stored = w.db.get(outsidePushKey(TASK_ID, "payments", 7).pk, outsidePushKey(TASK_ID, "payments", 7).sk);
    return outsideOfPullRequest({ item: items[0]!, hint: stored === undefined ? undefined : { headSha: String(stored["headSha"]), login: String(stored["login"]), at: String(stored["at"]) }, canRecheck });
  };

  it("Rovara's own push is never flagged, even when its synchronize arrives before its result is recorded", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    w.setWorkflow({ stage: "PULL_REQUEST", state: "RUNNING" });
    w.github.statuses.set(7, status({ headSha: HEAD_B }));
    await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "payments", subject: 7, headSha: HEAD_B, login: "rovara[bot]", at: NOW });
    await trackPullRequest(w.deps, TASK_ID);
    expect(await rowOf(w)).toBeUndefined();
  });

  it("a push by someone else is flagged with their login; their later push moves the row to the new head", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    w.github.statuses.set(7, status({ headSha: HEAD_B }));
    await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "payments", subject: 7, headSha: HEAD_B, login: "maya-codes", at: "2026-11-11T12:00:00.000Z" });
    await trackPullRequest(w.deps, TASK_ID);
    expect(await rowOf(w)).toMatchObject({ headSha: HEAD_B, lastPushedBy: { login: "maya-codes" } });
    // Another person pushes again: the newest event wins, and the row names the head the host shows now.
    w.github.statuses.set(7, status({ headSha: HEAD_C }));
    await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "payments", subject: 7, headSha: HEAD_C, login: "omar-d", at: "2026-11-11T12:05:00.000Z" });
    await trackPullRequest(w.deps, TASK_ID);
    expect(await rowOf(w)).toMatchObject({ headSha: HEAD_C, lastPushedBy: { login: "omar-d" } });
    // A late delivery of the older push never overwrites the newer one.
    expect(await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "payments", subject: 7, headSha: HEAD_B, login: "maya-codes", at: "2026-11-11T12:01:00.000Z" })).toBe(false);
    expect(await rowOf(w)).toMatchObject({ headSha: HEAD_C, lastPushedBy: { login: "omar-d" } });
  });

  it("a force-push to a different head moves the flag with it, and a force-push back to the head Rovara recorded clears it", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    w.github.statuses.set(7, status({ headSha: HEAD_B }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(await rowOf(w)).toMatchObject({ headSha: HEAD_B });
    w.github.statuses.set(7, status({ headSha: HEAD_C }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(await rowOf(w)).toMatchObject({ headSha: HEAD_C });
    // The person puts the branch back exactly where Rovara left it (the workflow's recorded head is HEAD_A).
    w.github.statuses.set(7, status({ headSha: HEAD_A }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(await rowOf(w)).toBeUndefined();
  });

  it("stores a login only in the spelling GitHub allows, and a head only if it is a commit", async () => {
    const w = world();
    for (const login of ["a@b.example", "bad login", "-leading", "x".repeat(50), "", "a[bot]x"]) {
      expect(await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "payments", subject: 7, headSha: HEAD_B, login, at: NOW })).toBe(false);
    }
    expect(await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "payments", subject: 7, headSha: "nope", login: "maya", at: NOW })).toBe(false);
    expect(await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "payments", subject: 7, headSha: HEAD_B, login: "dependabot[bot]", at: NOW })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the detector, from deliveries

describe("the host's push events", () => {
  const INSTALLATION = 777;
  const repository = { id: 1234, full_name: "Acme/Payments" };

  function deps(w: TrackingWorld, installationOrg: string | null = TEST_ORG): OutsidePushDependencies {
    return {
      documentClient: w.db, tableName: TABLE, now: () => NOW, loadTask: async (id) => id === TASK_ID ? w.task() as never : undefined,
      repositoryUrl: async (_p, _r, repositoryId) => `https://github.com/acme/${repositoryId}`, installationOrg: async () => installationOrg ?? undefined,
    };
  }
  const pullRequestPush = (extra: Partial<PullRequestWebhookEvent> = {}): PullRequestWebhookEvent => ({ kind: "PULL_REQUEST", action: "synchronize", installationId: INSTALLATION, repositoryId: 1234, fullName: "acme/payments", number: 7, headSha: HEAD_B, pushedBy: "maya-codes", ...extra });
  const branchPush = (extra: Partial<BranchPushWebhookEvent> = {}): BranchPushWebhookEvent => ({ kind: "BRANCH_PUSH", installationId: INSTALLATION, repositoryId: 1234, fullName: "acme/payments", branch: workingBranchName(TASK_ID), headSha: HEAD_B, pushedBy: "maya-codes", ...extra });
  const hintOf = (w: TrackingWorld, subject: number | "branch") => w.db.get(outsidePushKey(TASK_ID, "payments", subject).pk, outsidePushKey(TASK_ID, "payments", subject).sk);
  const withWorkingBranch = (w: TrackingWorld) => w.db.set({ ...workingBranchKey(TASK_ID, "payments"), entityType: "WORKING_BRANCH", taskId: TASK_ID, orgId: TEST_ORG, repository: "payments", branch: workingBranchName(TASK_ID), baseSha: BASE, createdAt: NOW, createdBy: "x" });

  it("a push to a linked pull request records its pusher against that head", async () => {
    const w = world();
    expect(await recordOutsidePushEvent(deps(w), pullRequestPush())).toBe(true);
    expect(hintOf(w, 7)).toMatchObject({ headSha: HEAD_B, login: "maya-codes", at: NOW });
  });

  it("a pull request nobody linked, another action and a push with no named pusher record nothing (an unrelated pull request never attaches)", async () => {
    const w = world();
    expect(await recordOutsidePushEvent(deps(w), pullRequestPush({ number: 99 }))).toBe(false);
    expect(await recordOutsidePushEvent(deps(w), pullRequestPush({ action: "edited" }))).toBe(false);
    const { pushedBy: _pushedBy, ...unnamed } = pullRequestPush(); void _pushedBy;
    expect(await recordOutsidePushEvent(deps(w), unnamed as PullRequestWebhookEvent)).toBe(false);
    expect(await recordOutsidePushEvent(deps(w), { kind: "HEAD_STATUS" })).toBe(false);
    expect(hintOf(w, 7)).toBeUndefined();
  });

  it("a push to the task's own working branch records the pusher; any other branch, repository, task, company or a closed task records nothing", async () => {
    const w = world();
    withWorkingBranch(w);
    expect(await recordOutsidePushEvent(deps(w), branchPush({ branch: "agentx/00000000-0000-4000-8000-0000000000ff" }))).toBe(false);
    expect(await recordOutsidePushEvent(deps(w), branchPush({ fullName: "acme/web" }))).toBe(false);
    expect(await recordOutsidePushEvent(deps(w, ORG_B), branchPush())).toBe(false);
    expect(await recordOutsidePushEvent(deps(w, null), branchPush())).toBe(false);
    w.setTask({ closedAt: NOW });
    expect(await recordOutsidePushEvent(deps(w), branchPush())).toBe(false);
    expect(hintOf(w, "branch")).toBeUndefined();
    w.setTask({ closedAt: undefined });
    expect(await recordOutsidePushEvent(deps(w), branchPush())).toBe(true);
    expect(hintOf(w, "branch")).toMatchObject({ headSha: HEAD_B, login: "maya-codes" });
  });

  it("pushes are ordered by GitHub's own push time: a late delivery of an older push never overwrites a newer one; a deleted branch forgets its hint (but not a newer push's)", async () => {
    const w = world();
    withWorkingBranch(w);
    const LATER = "2026-11-11T12:05:00.000Z";
    expect(await recordOutsidePushEvent(deps(w), branchPush({ headSha: HEAD_C, pushedAt: LATER }))).toBe(true);
    expect(await recordOutsidePushEvent(deps(w), branchPush({ headSha: HEAD_B, pushedAt: NOW }))).toBe(false);
    expect(hintOf(w, "branch")).toMatchObject({ headSha: HEAD_C, at: LATER });
    expect(await recordOutsidePushEvent(deps(w), branchPush({ headSha: HEAD_B, pushedAt: NOW, deleted: true }))).toBe(false);
    expect(hintOf(w, "branch")).toMatchObject({ headSha: HEAD_C });
    expect(await recordOutsidePushEvent(deps(w), branchPush({ headSha: HEAD_C, pushedAt: "2026-11-11T12:06:00.000Z", deleted: true }))).toBe(true);
    expect(hintOf(w, "branch")).toBeUndefined();
    // A pull request push is timed by GitHub's own time too.
    expect(await recordOutsidePushEvent(deps(w), pullRequestPush({ pushedAt: LATER }))).toBe(true);
    expect(hintOf(w, 7)).toMatchObject({ at: LATER });
  });

  it("a push to an agentx branch that is not a task's own published branch, or came through another company's installation, is not even stored as a delivery", async () => {
    const w = world();
    const body = JSON.stringify(pushEvent());
    w.db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: TEST_ORG, status: "active" });
    const before = w.db.find(() => true).length;
    await expect(handleGithubWebhook({
      documentClient: w.db, tableName: TABLE, rawBody: body,
      headers: { "x-hub-signature-256": sign(body), "x-github-delivery": randomUUID(), "x-github-event": "push" }, secret: SECRET,
      authorizeRepository: async () => true, authorizeBranchPush: async (push) => (await outsidePushTarget(deps(w), push)) !== undefined,
      process: async () => undefined, now: () => NOW,
    })).rejects.toThrow(/unsupported/);
    expect(w.db.find(() => true).length).toBe(before);
  });

  it("a branch the task never published has no row to attach to", async () => {
    const w = world();
    expect(await recordOutsidePushEvent(deps(w), branchPush())).toBe(false);
  });

  const deliver = async (w: TrackingWorld, name: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const processed: Array<PullRequestWebhookEvent | BranchPushWebhookEvent | { kind: string }> = [];
    w.db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: TEST_ORG, status: "active" });
    const outcome = await handleGithubWebhook({
      documentClient: w.db, tableName: TABLE, rawBody: body,
      headers: { "x-hub-signature-256": sign(body), "x-github-delivery": randomUUID(), "x-github-event": name }, secret: SECRET,
      authorizeRepository: async () => true,
      process: async (event) => { processed.push(event); },
      now: () => NOW,
    });
    return { outcome, processed };
  };
  const pullRequestEvent = (sender: unknown) => ({ action: "synchronize", installation: { id: INSTALLATION }, repository, pull_request: { number: 7, state: "open", head: { sha: HEAD_B } }, ...(sender === undefined ? {} : { sender }) });
  const pushEvent = (extra: Record<string, unknown> = {}) => ({ ref: `refs/heads/${workingBranchName(TASK_ID)}`, after: HEAD_B, before: HEAD_A, forced: false, installation: { id: INSTALLATION }, repository, sender: { login: "maya-codes" }, pusher: { name: "Maya Chen", email: "maya@example.com" }, ...extra });

  it("a signed synchronize carries the sender's login, and only a login", async () => {
    const w = world();
    expect((await deliver(w, "pull_request", pullRequestEvent({ login: "maya-codes", email: "maya@example.com" }))).processed).toEqual([expect.objectContaining({ kind: "PULL_REQUEST", headSha: HEAD_B, pushedBy: "maya-codes" })]);
    const odd = (await deliver(w, "pull_request", pullRequestEvent({ login: "a@b.example" }))).processed[0] as PullRequestWebhookEvent;
    expect(odd).not.toHaveProperty("pushedBy");
    expect((await deliver(w, "pull_request", pullRequestEvent(undefined))).processed[0]).not.toHaveProperty("pushedBy");
    expect(JSON.stringify(w.db.items)).not.toContain("maya@example.com");
  });

  it("a signed push to a working branch becomes a BRANCH_PUSH event with the sender, never the commit pusher's name or email", async () => {
    const w = world();
    const { processed } = await deliver(w, "push", pushEvent());
    expect(processed).toEqual([{ kind: "BRANCH_PUSH", installationId: INSTALLATION, repositoryId: 1234, fullName: "acme/payments", branch: workingBranchName(TASK_ID), headSha: HEAD_B, pushedBy: "maya-codes" }]);
    expect(JSON.stringify(processed)).not.toContain("maya@example.com");
    expect(JSON.stringify(processed)).not.toContain("Maya Chen");
  });

  it("a push to any other branch, a deletion that names no head, or a body that is not a push is the unsupported event it was", async () => {
    const w = world();
    for (const payload of [pushEvent({ ref: "refs/heads/main" }), pushEvent({ ref: "refs/heads/agentx/not-a-uuid" }), pushEvent({ ref: "refs/tags/agentx/00000000-0000-4000-8000-0000000000a1" }), pushEvent({ deleted: true, before: undefined }), pushEvent({ after: "0".repeat(40) }), { nonsense: true }]) {
      await expect(deliver(w, "push", payload)).rejects.toThrow(/unsupported/);
    }
  });

  it("a deleted working branch becomes a BRANCH_PUSH that names the head it had, timed by GitHub's own push time", async () => {
    const w = world();
    const processed = (await deliver(w, "push", pushEvent({ deleted: true, after: "0".repeat(40), repository: { ...repository, pushed_at: 1_794_000_000 } }))).processed;
    expect(processed).toEqual([expect.objectContaining({ kind: "BRANCH_PUSH", headSha: HEAD_A, deleted: true, pushedAt: new Date(1_794_000_000_000).toISOString() })]);
  });

  it("a forged delivery is refused before any of this", async () => {
    const w = world();
    const body = JSON.stringify(pushEvent());
    await expect(handleGithubWebhook({ documentClient: w.db, tableName: TABLE, rawBody: body, headers: { "x-hub-signature-256": sign(body + " "), "x-github-delivery": randomUUID(), "x-github-event": "push" }, secret: SECRET,
      authorizeRepository: async () => true, process: async () => undefined, now: () => NOW })).rejects.toThrow(/signature/);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the view

describe("the continue-loop part of the task view", () => {
  const owner = { role: "owner" as const };
  function view(w: TrackingWorld, options: { access?: { role: "owner" | "viewer" | "commenter"; source?: "session" }; offers?: { publish: boolean; recheck: boolean }; waiting?: boolean } = {}) {
    w.db.set({ pk: "WORKSPACE#ws-1", sk: "PULL_REQUEST#payments#000000000007", entityType: "PULL_REQUEST", headBranch: "agentx/11111111-1111-4111-8111-111111111111" });
    if (options.waiting !== false) w.setWorkflow({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const items = [w.db.get(trackingKey()) as unknown as MergeTrackingItem].filter((entry) => entry !== undefined);
    return continueLoopViewOf({ documentClient: w.db, tableName: TABLE }, w.task() as never, options.access ?? owner, items, options.offers);
  }

  it("names the pull request's branch, and flags an outside head with the pusher, for the owner", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    w.github.statuses.set(7, status({ headSha: HEAD_B }));
    await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "payments", subject: 7, headSha: HEAD_B, login: "maya-codes", at: NOW });
    await trackPullRequest(w.deps, TASK_ID);
    const result = await view(w);
    expect(result).toMatchObject({
      branches: [{ repository: "payments", branch: "agentx/11111111-1111-4111-8111-111111111111", source: "pull_request", headSha: HEAD_A, pullRequest: { number: 7 } }],
      outside: [{ repository: "payments", number: 7, headSha: HEAD_B, lastPushedBy: { login: "maya-codes" }, canRecheck: true }],
      label: CHANGED_OUTSIDE_LABEL, canRecheck: true,
    });
    expect(ContinueLoopViewSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/@/u);
  });

  it("says nothing is outside while the head is Rovara's, and offers Recheck to nobody who may not work on the task", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    expect(await view(w)).toMatchObject({ outside: [], canRecheck: false });
    expect(await view(w)).not.toHaveProperty("label");
    w.github.statuses.set(7, status({ headSha: HEAD_B }));
    await trackPullRequest(w.deps, TASK_ID);
    expect(await view(w, { access: { role: "viewer" } })).toMatchObject({ outside: [{ canRecheck: false }], canRecheck: false, canPublishBranch: false });
    expect(await view(w, { access: { role: "commenter" } })).toMatchObject({ canRecheck: false });
    expect(await view(w, { access: { role: "owner", source: "session" } })).toMatchObject({ canRecheck: false });
    // An install that cannot start a re-check offers none, whatever the task looks like.
    expect(await view(w, { offers: { publish: true, recheck: false } })).toMatchObject({ outside: [{ canRecheck: false }], canRecheck: false });
  });

  it("offers no Recheck while the task is not waiting for the merge, and none on a closed task", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    w.github.statuses.set(7, status({ headSha: HEAD_B }));
    await trackPullRequest(w.deps, TASK_ID);
    w.setWorkflow({ stage: "PULL_REQUEST", state: "RUNNING" });
    expect(await view(w, { waiting: false })).toMatchObject({ canRecheck: false });
    w.setTask({ closedAt: NOW });
    w.setWorkflow({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(await view(w, { waiting: false })).toMatchObject({ canRecheck: false, canPublishBranch: false });
  });

  it("lists a published branch at its base and flags a push to it; a version 1 task has none", async () => {
    const w = world();
    await trackPullRequest(w.deps, TASK_ID);
    w.setTask({ preparedBase: [{ repositoryId: "payments", baseCommitSha: BASE }] });
    w.db.set({ ...workingBranchKey(TASK_ID, "web"), entityType: "WORKING_BRANCH", taskId: TASK_ID, orgId: TEST_ORG, repository: "web", branch: workingBranchName(TASK_ID), baseSha: BASE, createdAt: NOW, createdBy: "x" });
    expect((await view(w))?.branches.find((entry) => entry.source === "published")).toEqual({ repository: "web", branch: workingBranchName(TASK_ID), source: "published", headSha: BASE });
    expect((await view(w))?.outside).toEqual([]);
    await recordOutsidePush(w.deps, { taskId: TASK_ID, repository: "web", subject: "branch", headSha: HEAD_C, login: "omar-d", at: NOW });
    expect((await view(w))?.outside).toEqual([{ repository: "web", headSha: HEAD_C, lastPushedBy: { login: "omar-d", at: NOW }, canRecheck: false, recheckNote: RECHECK_NEEDS_PULL_REQUEST_NOTE }]);
    // The view says, word for word, that Rovara's pull request comes from its own branch; "payments" can still get a branch, at its base.
    expect(await view(w)).toMatchObject({ publishedBranchNote: PUBLISHED_BRANCH_NOTE });
    const v1 = world({ definitionVersion: "1.0.0" });
    expect(await view(v1)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------- publish the working branch

describe("publishing the working branch", () => {
  const PROJECT = { definition: { name: "payments", repositories: [{ name: "payments", url: "https://github.com/acme/payments.git", path: "repo/payments", defaultBranch: "main", credentialRef: "github-app" }] } };
  function port(over: Partial<WorkingBranchPort> = {}) {
    const created: Array<{ branch: string; commit: string }> = [];
    const heads = new Map<string, string>();
    const value: WorkingBranchPort = {
      branchHead: async (_t, _r, branch) => heads.get(branch),
      createBranch: async (_t, _r, branch, commit) => { created.push({ branch, commit }); heads.set(branch, commit); },
      ...over,
    };
    return { value, created, heads };
  }
  const deps = (w: TrackingWorld, workingBranchPort: WorkingBranchPort | undefined) => ({
    documentClient: w.db, tableName: TABLE, orgId: TEST_ORG, now: () => Date.parse(NOW), workingBranchPort,
    actions: { projectRevision: async () => PROJECT },
  }) as never;
  const prepared = (w: TrackingWorld) => w.setTask({ preparedBase: [{ repositoryId: "payments", baseCommitSha: BASE }] });

  it("makes agentx/<taskId> at the commit the task was prepared on, records it once, and a repeat changes nothing", async () => {
    const w = world(); prepared(w);
    const p = port();
    const first = await publishWorkingBranch(deps(w, p.value), w.task() as never, { repository: "payments", actorId: "a" });
    expect(first).toEqual({ repository: "payments", branch: workingBranchName(TASK_ID), commit: BASE, created: true });
    expect(p.created).toEqual([{ branch: workingBranchName(TASK_ID), commit: BASE }]);
    expect(await publishWorkingBranch(deps(w, p.value), w.task() as never, { repository: "payments", actorId: "a" })).toEqual({ ...first, created: false });
    expect(p.created).toHaveLength(1);
    expect((await readWorkingBranches({ documentClient: w.db, tableName: TABLE }, TASK_ID)).map((row) => row.baseSha)).toEqual([BASE]);
  });

  it("a branch the host already has at the base is recorded, not recreated; a recorded branch the person moved is theirs (created: false); one the host lost is made again at the same base", async () => {
    const w = world(); prepared(w);
    const p = port();
    p.heads.set(workingBranchName(TASK_ID), BASE);
    expect(await publishWorkingBranch(deps(w, p.value), w.task() as never, { repository: "payments", actorId: "a" })).toMatchObject({ created: false, commit: BASE });
    expect(p.created).toEqual([]);
    p.heads.set(workingBranchName(TASK_ID), HEAD_C);
    expect(await publishWorkingBranch(deps(w, p.value), w.task() as never, { repository: "payments", actorId: "a" })).toMatchObject({ created: false, commit: BASE });
    expect(p.created).toEqual([]);
    p.heads.delete(workingBranchName(TASK_ID));
    expect(await publishWorkingBranch(deps(w, p.value), w.task() as never, { repository: "payments", actorId: "a" })).toMatchObject({ created: true, commit: BASE });
    expect(p.created).toEqual([{ branch: workingBranchName(TASK_ID), commit: BASE }]);
  });

  it("a concurrent press that made the branch first (the host answers 'already exists') is the same branch: created false, and nothing is moved", async () => {
    const w = world(); prepared(w);
    const p = port();
    const raced = port({ createBranch: async (_t, _r, branch) => { p.heads.set(branch, BASE); throw Object.assign(new Error("Reference already exists"), { status: 422 }); }, branchHead: async (_t, _r, branch) => p.heads.get(branch) });
    expect(await publishWorkingBranch(deps(w, raced.value), w.task() as never, { repository: "payments", actorId: "a" })).toMatchObject({ created: false, commit: BASE });
    // Another commit there is not ours: the failure stands.
    const w2 = world(); prepared(w2);
    const q = port();
    const other = port({ createBranch: async (_t, _r, branch) => { q.heads.set(branch, HEAD_C); throw new Error("Reference already exists"); }, branchHead: async (_t, _r, branch) => q.heads.get(branch) });
    await expect(publishWorkingBranch(deps(w2, other.value), w2.task() as never, { repository: "payments", actorId: "a" })).rejects.toThrow(/already exists/);
  });

  it("never moves or claims a branch that exists elsewhere than at the base (no force-push), and says so", async () => {
    const w = world(); prepared(w);
    const p = port();
    p.heads.set(workingBranchName(TASK_ID), HEAD_B);
    await expect(publishWorkingBranch(deps(w, p.value), w.task() as never, { repository: "payments", actorId: "a" })).rejects.toThrow(/already exists/);
    expect(p.created).toEqual([]);
    expect(await readWorkingBranches({ documentClient: w.db, tableName: TABLE }, TASK_ID)).toEqual([]);
  });

  it("refuses a repository that is not the project's, a task not yet prepared, a closed task and an install without the port", async () => {
    const w = world();
    await expect(publishWorkingBranch(deps(w, port().value), w.task() as never, { repository: "payments", actorId: "a" })).rejects.toThrow(/finished preparing/);
    prepared(w);
    await expect(publishWorkingBranch(deps(w, port().value), w.task() as never, { repository: "other", actorId: "a" })).rejects.toThrow(/finished preparing/);
    w.setTask({ preparedBase: [{ repositoryId: "other", baseCommitSha: BASE }] });
    await expect(publishWorkingBranch(deps(w, port().value), w.task() as never, { repository: "other", actorId: "a" })).rejects.toThrow(/not part of this task's project/);
    prepared(w);
    await expect(publishWorkingBranch(deps(w, undefined), w.task() as never, { repository: "payments", actorId: "a" })).rejects.toThrow(/not available/);
    w.setTask({ closedAt: NOW });
    await expect(publishWorkingBranch(deps(w, port().value), w.task() as never, { repository: "payments", actorId: "a" })).rejects.toThrow(/no working branch/);
  });

  it("a host failure records nothing", async () => {
    const w = world(); prepared(w);
    const p = port({ createBranch: async () => { throw new Error("host down"); } });
    await expect(publishWorkingBranch(deps(w, p.value), w.task() as never, { repository: "payments", actorId: "a" })).rejects.toThrow(/host down/);
    expect(await readWorkingBranches({ documentClient: w.db, tableName: TABLE }, TASK_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the routes, through the whole broker

describe("the two actions, through the broker", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  const trackingItem = (taskId: string, extra: Partial<MergeTrackingItem> = {}): MergeTrackingItem => {
    const fields = {
      orgId: TEST_ORG, taskId, repositoryId: "demo", number: 7, headSha: HEAD_B, draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const, ciBasis: "required" as const,
      checksEverSeen: true, failingChecks: [], review: "not_requested" as const, branch: "up_to_date" as const, headByRovara: false, nudges: { count: 0 }, syncs: { day: "2026-11-11", count: 0 }, ...extra,
    };
    return { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: NOW };
  };

  async function setup(options: { recheck?: boolean; port?: WorkingBranchPort | undefined; audit?: boolean; sameOrg?: boolean } = {}) {
    const calls: string[] = [];
    const created: Array<{ branch: string; commit: string }> = [];
    const heads = new Map<string, string>();
    const fakePort: WorkingBranchPort = options.port ?? {
      branchHead: async (_t, _r, branch) => heads.get(branch),
      createBranch: async (_t, _r, branch, commit) => { calls.push("create"); created.push({ branch, commit }); heads.set(branch, commit); },
    };
    const recheck = vi.fn(async () => "STARTED" as const);
    const audit = capturingAuditDeps();
    const harness = await createDeveloperTaskBroker({
      audit,
      ...(options.sameOrg === true ? {} : { orgResolver: (async (subject: { developerId: string }) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG)) as never }),
      brokerExtra: { agents: {}, workingBranchPort: fakePort, ...(options.recheck === false ? {} : { outsideRecheck: recheck }) },
    });
    await harness.orgOf(MAYA);
    seedMembership(harness.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const store = new AgentStore({ documentClient: harness.db, tableName: "state", now: Date.now });
    await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
    harness.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
    const reply = await harness.dev(MAYA, "POST", "/v1/app/agents/rovara-code/runs", { requestId: randomUUID(), project: "payments", input: { text: "Fix the retry bug" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    type Row = Record<string, unknown> & { workflow: Record<string, unknown>; workspaceId: string };
    const record = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Row;
    const prepare = (harness.db.find((item) => item.pk === `WORKSPACE#${record().workspaceId}` && item.entityType === "OPERATION") as Array<Record<string, unknown>>).find((operation) => operation.kind === "prepare")!;
    await harness.finish(record().workspaceId, String(prepare.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: BASE }] } });
    const toWaiting = (extra: Record<string, unknown> = {}) => {
      harness.db.set({ ...record(), workflow: { ...record().workflow, stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [
        { repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", candidateDigest: "c".repeat(64), required: true, state: "OPEN", headSha: HEAD_A },
      ], ...extra } });
      harness.db.set({ pk: `WORKSPACE#${record().workspaceId}`, sk: "PULL_REQUEST#demo#000000000007", entityType: "PULL_REQUEST", headBranch: "agentx/11111111-1111-4111-8111-111111111111" });
      harness.db.set({ ...mergeTrackingKey(taskId, "demo", 7), entityType: "MERGE_TRACKING", ...trackingItem(taskId) });
    };
    const web = async (who: Developer, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) => {
      const id = randomUUID();
      harness.db.set({ ...(harness.db.get(`SESSION#${who.sessionId}`, "META") as Record<string, unknown>), pk: `SESSION#${id}`, sessionId: id, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600, authTime: new Date().toISOString() });
      const response = await harness.handler({
        rawPath: path.replace("/v1/app/", "/v1/web/"), rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
        headers: { cookie: `__Host-agentx_review_session=${id}`, "sec-fetch-site": "same-origin", origin: new URL(DEV_ISSUER).origin, [APP_CSRF_HEADER]: appCsrfTokenFor(id), ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "r", http: { method } },
      });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    const view = (who: Developer, headers: Record<string, string> = { "x-agentx-task-view": "2" }) => harness.dev(who, "GET", `/v1/dev/tasks/${taskId}?details=true`, undefined, headers);
    const routeDeps = (checkAccess: CheckAccess): DeveloperTaskRouteDependencies => ({
      documentClient: harness.db, tableName: "state", actions: harness.actions, orgId: TEST_ORG, checkAccess, projectChannelIds: async () => [], now: () => Date.now(), log: () => undefined,
      learningAudit: audit.audit, workingBranchPort: fakePort, startOutsideRecheck: recheck,
    });
    /** The workspace's worker is up and lists these features (the re-check's start asks it). */
    const workerUp = (features: string[]) => harness.db.set({ ...workspaceSessionKey(record().workspaceId), entityType: "WORKSPACE_SESSION", state: "READY", workerFeatures: features });
    return { harness, taskId, record, toWaiting, web, view, calls, created, recheck, audit, routeDeps, workerUp };
  }
  const publishBody = () => ({ requestId: randomUUID(), repository: "demo" });
  const recheckBody = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), repository: "demo", number: 7, headSha: HEAD_B, ...extra });

  it("publish-branch: the owner in a browser session makes the branch, once, with one audit row; a repeat creates nothing and records nothing more", async () => {
    const t = await setup();
    const route = `/v1/app/tasks/${t.taskId}/continue/publish-branch`;
    const first = await t.web(MAYA, "POST", route, publishBody());
    expect(first, JSON.stringify(first.body)).toMatchObject({ status: 200, body: { repository: "demo", branch: workingBranchName(t.taskId), commit: BASE, created: true } });
    expect(t.created).toEqual([{ branch: workingBranchName(t.taskId), commit: BASE }]);
    const again = await t.web(MAYA, "POST", route, publishBody());
    expect(again).toMatchObject({ status: 200, body: { created: false } });
    expect(t.created).toHaveLength(1);
    const events = t.audit.recorded().filter((event) => event.action === "task.working_branch_published");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: MAYA.developerId }, target: { kind: "task", id: t.taskId }, facts: { created: true } });
    expect(JSON.stringify(events[0])).not.toContain(workingBranchName(t.taskId));
  });

  it("publish-branch: a token, a stranger from another company, a viewer's body and a malformed body are all refused and make nothing", async () => {
    const t = await setup();
    const route = `/v1/app/tasks/${t.taskId}/continue/publish-branch`;
    expect((await t.harness.dev(MAYA, "POST", route, publishBody())).status).toBe(403);
    expect((await t.web(OMAR, "POST", route, publishBody())).status).toBeGreaterThanOrEqual(400);
    expect((await t.web(OMAR, "POST", route, publishBody())).status).not.toBe(200);
    expect((await t.web(MAYA, "POST", route, { requestId: "no" })).status).toBe(400);
    expect((await t.web(MAYA, "POST", route, { ...publishBody(), extra: 1 })).status).toBe(400);
    expect((await t.web(MAYA, "POST", route.replace(t.taskId, randomUUID()), publishBody())).status).toBe(404);
    expect(t.created).toEqual([]);
    expect(t.audit.recorded().filter((event) => event.action === "task.working_branch_published")).toEqual([]);
  });

  it("publish-branch: a closed task and a task nobody prepared are refused", async () => {
    const t = await setup();
    const route = `/v1/app/tasks/${t.taskId}/continue/publish-branch`;
    expect((await t.web(MAYA, "POST", route, { requestId: randomUUID(), repository: "web" })).status).toBeGreaterThanOrEqual(400);
    t.harness.db.set({ ...t.record(), closedAt: NOW, outcome: "CLOSED" });
    expect((await t.web(MAYA, "POST", route, publishBody())).status).toBeGreaterThanOrEqual(400);
    expect(t.created).toEqual([]);
  });

  it("recheck: the owner in a browser session starts it for the head they saw, once audited; a token and a stranger from another company cannot", async () => {
    const t = await setup();
    t.toWaiting();
    const route = `/v1/app/tasks/${t.taskId}/continue/recheck`;
    expect((await t.harness.dev(MAYA, "POST", route, recheckBody())).status).toBe(403);
    expect((await t.web(OMAR, "POST", route, recheckBody())).status).not.toBe(200);
    expect(t.recheck).not.toHaveBeenCalled();
    const started = await t.web(MAYA, "POST", route, recheckBody());
    expect(started, JSON.stringify(started.body)).toMatchObject({ status: 200, body: { status: "started" } });
    expect(t.recheck).toHaveBeenCalledTimes(1);
    expect(t.recheck.mock.calls[0]).toMatchObject([expect.anything(), { repository: "demo", number: 7, headSha: HEAD_B, actorId: expect.any(String) as string }]);
    const events = t.audit.recorded().filter((event) => event.action === "task.recheck_requested");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { id: MAYA.developerId }, target: { kind: "task", id: t.taskId }, facts: { outcome: "started" } });
  });

  it("recheck: a head that moved since, nothing changed outside, a task not waiting for the merge and an install without the port each refuse and start nothing", async () => {
    const t = await setup();
    t.toWaiting();
    const route = `/v1/app/tasks/${t.taskId}/continue/recheck`;
    expect((await t.web(MAYA, "POST", route, recheckBody({ headSha: HEAD_C }))).status).toBe(409);
    t.harness.db.set({ ...mergeTrackingKey(t.taskId, "demo", 7), entityType: "MERGE_TRACKING", ...trackingItem(t.taskId, { headByRovara: true }) });
    expect((await t.web(MAYA, "POST", route, recheckBody())).status).toBe(400);
    t.harness.db.set({ ...mergeTrackingKey(t.taskId, "demo", 7), entityType: "MERGE_TRACKING", ...trackingItem(t.taskId) });
    t.toWaiting({ state: "READY", branchSync: { repositoryId: "demo", number: 7, expectedHeadCommit: HEAD_A, reason: "behind" } });
    expect((await t.web(MAYA, "POST", route, recheckBody())).status).toBe(400);
    expect((await t.web(MAYA, "POST", route, recheckBody({ number: 9 }))).status).toBe(400);
    expect(t.recheck).not.toHaveBeenCalled();
    // An install whose worker is up without the adoption feature: refused in plain words, and nothing starts.
    const bare = await setup({ recheck: false });
    bare.toWaiting();
    bare.workerUp(["task.workflowMode"]);
    const unavailable = await bare.web(MAYA, "POST", `/v1/app/tasks/${bare.taskId}/continue/recheck`, recheckBody());
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(unavailable.body)).toContain(OUTSIDE_RECHECK_WORKER_MISSING);
    expect(bare.audit.recorded().filter((event) => event.action === "task.recheck_requested")).toEqual([]);
  });

  it("recheck meets the money gate: a task waiting for more spend is not re-checked, whoever asks", async () => {
    const t = await setup();
    t.toWaiting();
    const route = `/v1/app/tasks/${t.taskId}/continue/recheck`;
    t.harness.db.set({ ...t.record(), budgetPause: { scope: { kind: "task", taskId: t.taskId }, at: NOW } });
    const refused = await t.web(MAYA, "POST", route, recheckBody());
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toMatch(/spend|approve/u);
    expect(t.recheck).not.toHaveBeenCalled();
    expect(t.audit.recorded().filter((event) => event.action === "task.recheck_requested")).toEqual([]);
  });

  it("recheck meets the project's new-work rule: an archived project is not re-checked", async () => {
    const t = await setup();
    t.toWaiting();
    t.harness.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", status: "archived" });
    const refused = await t.web(MAYA, "POST", `/v1/app/tasks/${t.taskId}/continue/recheck`, recheckBody());
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(t.recheck).not.toHaveBeenCalled();
  });

  it("the task view carries the loop for the owner, flagged with the label and the offers the install has, and not for another company", async () => {
    const t = await setup();
    t.toWaiting();
    const owner = await t.view(MAYA);
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    const task = (owner.body.task ?? owner.body) as Record<string, unknown>;
    const loop = task.continueLoop as Record<string, unknown>;
    // "demo" already has its pull request's branch, so no repository is left to publish one in.
    expect(loop, JSON.stringify(Object.keys(task))).toMatchObject({ canPublishBranch: false, label: CHANGED_OUTSIDE_LABEL, canRecheck: true,
      branches: [{ repository: "demo", branch: "agentx/11111111-1111-4111-8111-111111111111", source: "pull_request" }], outside: [{ repository: "demo", number: 7, headSha: HEAD_B, canRecheck: true }] });
    expect(ContinueLoopViewSchema.safeParse(loop).success).toBe(true);
    // The task view schema carries the field (a minimal view, so the fixture workflow here is not judged).
    const minimal = { taskId: t.taskId, title: "x", project: "payments", status: "RUNNING", startingRevision: 1, client: "c", shared: false, createdAt: NOW, updatedAt: NOW, events: [], continueLoop: loop };
    expect(DeveloperTaskViewSchema.parse(minimal).continueLoop).toEqual(loop);
    expect((await t.view(OMAR)).status).not.toBe(200);
    const bare = await setup({ recheck: false, port: undefined });
    bare.toWaiting();
    bare.workerUp([]);
    const noRecheck = ((await bare.view(MAYA)).body.task ?? {}) as { continueLoop?: { canRecheck: boolean; outside: Array<{ canRecheck: boolean }> } };
    expect(noRecheck.continueLoop).toMatchObject({ canRecheck: false, outside: [{ canRecheck: false }] });
  });

  it("an older client never receives the field", async () => {
    const t = await setup();
    t.toWaiting();
    const response = await t.view(MAYA, {});
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("continueLoop");
  });

  it("publish-branch and recheck: someone who may read the task but not work on it (a commenter) is refused, and nothing starts", async () => {
    const t = await setup({ sameOrg: true });
    t.toWaiting();
    t.harness.db.set({ pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [
      { developerId: OMAR.developerId, slackUserId: "U0OMAR0001", name: OMAR.name, role: "commenter" } ] });
    const base = `/v1/app/tasks/${t.taskId}/continue`;
    expect((await t.web(OMAR, "POST", `${base}/publish-branch`, publishBody())).status).toBeGreaterThanOrEqual(400);
    expect((await t.web(OMAR, "POST", `${base}/recheck`, recheckBody())).status).toBeGreaterThanOrEqual(400);
    expect(t.created).toEqual([]);
    expect(t.recheck).not.toHaveBeenCalled();
  });

  describe("every guard of a person's own paid work, called with the caller's project access", () => {
    it("recheck: an allowed contributor starts it; a project viewer, a member with no project access and an archived project (a maintainer included) are refused and nothing starts", async () => {
      const t = await setup({ sameOrg: true });
      t.toWaiting();
      const ask = (checkAccess: CheckAccess) => recheckAction(t.routeDeps(checkAccess), OWNER_CALLER, t.taskId, recheckBody());
      await expect(ask(grantedAs("viewer"))).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      await expect(ask(noAccess)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      expect(t.recheck).not.toHaveBeenCalled();
      expect(await ask(grantedAs("contributor"))).toEqual({ status: "started" });
      expect(t.recheck).toHaveBeenCalledTimes(1);
      t.harness.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: NOW, createdBy: "x" });
      await expect(ask(grantedAs("maintainer"))).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
      expect(t.recheck).toHaveBeenCalledTimes(1);
    });

    it("publish-branch: a project viewer and a member with no project access are refused, and an archived project too; nothing is made", async () => {
      const t = await setup({ sameOrg: true });
      const ask = (checkAccess: CheckAccess) => publishWorkingBranchAction(t.routeDeps(checkAccess), OWNER_CALLER, t.taskId, publishBody());
      await expect(ask(grantedAs("viewer"))).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      await expect(ask(noAccess)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      t.harness.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: NOW, createdBy: "x" });
      await expect(ask(grantedAs("maintainer"))).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
      expect(t.created).toEqual([]);
    });

    it("recheck: a task waiting for more spend to be approved is refused for the owner and for a maintainer alike, before anything is started", async () => {
      const t = await setup({ sameOrg: true });
      t.toWaiting();
      t.harness.db.set({ ...t.record(), budgetPause: { scope: { kind: "task", taskId: t.taskId }, at: NOW } });
      for (const role of ["contributor", "maintainer"] as const) {
        await expect(recheckAction(t.routeDeps(grantedAs(role)), OWNER_CALLER, t.taskId, recheckBody())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
      }
      expect(t.recheck).not.toHaveBeenCalled();
    });

    it("recheck meets the company's Admission: a refusal (trial, machine time, budget) is answered in its own words and nothing starts", async () => {
      const t = await setup({ sameOrg: true });
      t.toWaiting();
      const refusing = { ...t.routeDeps(grantedAs("contributor")), admitOutsideRecheck: async () => { throw agentXError("BUDGET_EXCEEDED", "The project's monthly budget is used up."); } };
      await expect(recheckAction(refusing, OWNER_CALLER, t.taskId, recheckBody())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(t.recheck).not.toHaveBeenCalled();
      const admitted = vi.fn(async () => undefined);
      expect(await recheckAction({ ...t.routeDeps(grantedAs("contributor")), admitOutsideRecheck: admitted }, OWNER_CALLER, t.taskId, recheckBody())).toEqual({ status: "started" });
      expect(admitted).toHaveBeenCalledTimes(1);
      expect(t.recheck).toHaveBeenCalledTimes(1);
    });

    it("owner-only: someone who can read the task through its channel (a contributor in the project, a channel member) can neither publish nor re-check, and nothing is made or started", async () => {
      const t = await setup({ sameOrg: true });
      t.toWaiting();
      t.harness.db.set({ ...t.record(), share: { mode: "continue", channelId: "C0SHARED01", sharedReason: "requested" } });
      const omar: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member", developerId: OMAR.developerId, sessionId: OMAR.sessionId, amr: "oidc", name: OMAR.name, slackUserId: "U0OMAR0001" };
      const deps = { ...t.routeDeps(grantedAs("contributor")), channelMember: async () => true };
      await expect(publishWorkingBranchAction(deps, omar, t.taskId, publishBody())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      await expect(recheckAction(deps, omar, t.taskId, recheckBody())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(t.created).toEqual([]);
      expect(t.recheck).not.toHaveBeenCalled();
    });

    it("recheck is idempotent per request: a repeat of the same request starts nothing more; the same request ID for another head is refused", async () => {
      const t = await setup({ sameOrg: true });
      t.toWaiting();
      const body = recheckBody();
      t.harness.db.set({ pk: `DEVTASK#${t.taskId}`, sk: `OUTSIDE_RECHECK#${String(body.requestId)}`, entityType: "OUTSIDE_RECHECK_REQUEST", taskId: t.taskId, repository: "demo", number: 7, headSha: HEAD_B,
        actorId: taskOwnerKey(MAYA.developerId, t.taskId), at: NOW });
      expect(await recheckAction(t.routeDeps(grantedAs("contributor")), OWNER_CALLER, t.taskId, body)).toEqual({ status: "started" });
      expect(t.recheck).not.toHaveBeenCalled();
      await expect(recheckAction(t.routeDeps(grantedAs("contributor")), OWNER_CALLER, t.taskId, { ...body, headSha: HEAD_C })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(t.recheck).not.toHaveBeenCalled();
    });
  });
});
