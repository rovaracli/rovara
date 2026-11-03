// Saved project images (SV wiring): what makes the registry look at a project. A push to a project's default branch (any of its repositories), the nightly, the periodic poll and the task-start check each call the
// registry's decision; a job it queues is started the same way, whichever asked, and one that cannot be started for a reason that will not mend is ended at once.
import { describe, expect, it, vi } from "vitest";
import { githubInstallationKey, githubRepoProjectKey, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type OrgId } from "@agentx/contracts";
import { GithubWebhookRetryableError } from "../../packages/broker/src/aws/github-webhooks.js";
import { runSavedEnvPoll, savedEnvBeforeNightly, savedEnvOnQueued, savedEnvPushQueue } from "../../packages/broker/src/aws/broker/saved-env-triggers.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";
import { abandonQueuedJob, checkRebuild, runPoll, SAVED_ENV_POLL_BACKOFF_MAX_MS, SAVED_ENV_POLL_MS, savedEnvForPrepare } from "../../packages/broker/src/test-env/saved-env.js";
import { deliverGithubTriggerEvents, githubCodePushes } from "../../packages/broker/src/triggers/github-events.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { APPROVED, DAY, imageOf, dig, savedEnvWorld } from "../support/saved-env-world.js";

const ORG: OrgId = TEST_ORG;
const PROJECT = "payments";
const INSTALLATION = 55;
const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } as const;
const repo = (name: string, id: number, extra: Record<string, unknown> = {}) => ({ name, url: `https://github.com/acme/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app", installationId: INSTALLATION, githubRepositoryId: id, ...extra });

// ---- the push

describe("a GitHub push to a project's repository", () => {
  function pushWorld(repositories = [repo("api", 101), repo("web", 102)]) {
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING, definition: { name: PROJECT, revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "Delegate work." } });
    db.set({ ...orgProjectCatalogKey(ORG, PROJECT), entityType: "PROJECT_CATALOG", name: PROJECT, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    db.set({ ...projectMetaKey(ORG, PROJECT), entityType: "PROJECT_META", name: PROJECT, status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: "seed" });
    db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: ORG, status: "active" });
    for (const entry of repositories) db.set({ ...githubRepoProjectKey(entry.githubRepositoryId, ORG, PROJECT), entityType: "GITHUB_REPO_PROJECT", orgId: ORG, project: PROJECT, installationId: INSTALLATION, githubRepositoryId: entry.githubRepositoryId });
    const queued: Array<{ orgId: string; project: string }> = [];
    const deps = (extra: Record<string, unknown> = {}) => ({ documentClient: db, tableName: "state", now: () => Date.parse("2026-11-02T12:00:00Z"), dispatch: async () => undefined, log: () => undefined, queueSavedEnvPush: async (push: { orgId: string; project: string }) => { queued.push(push); }, ...extra }) as never;
    return { db, queued, deps };
  }
  const pushed = (over: Record<string, unknown> = {}, repositoryId = 101) => ({ eventName: "push", installationId: INSTALLATION, payload: { ref: "refs/heads/main", after: "a".repeat(40), deleted: false, repository: { id: repositoryId, default_branch: "main" }, ...over } });

  it("tells the registry once per project whose repository was pushed to its default branch, for a code repository too", async () => {
    const { queued, deps } = pushWorld();
    expect(await deliverGithubTriggerEvents(deps(), pushed())).toEqual({ events: 1, duplicates: 0 });
    expect(queued).toEqual([{ orgId: ORG, project: PROJECT }]);
    await deliverGithubTriggerEvents(deps(), pushed({}, 102));
    expect(queued).toHaveLength(2);
  });

  it("ignores another branch, a branch Rovara made, a deleted branch, a push of nothing, a repository the project does not record, and an installation that is not bound", async () => {
    const { db, queued, deps } = pushWorld();
    for (const over of [{ ref: "refs/heads/feature" }, { ref: "refs/tags/main" }, { ref: "refs/heads/agentx/x", repository: { id: 101, default_branch: "agentx/x" } }, { deleted: true }, { after: "0".repeat(40) }, { after: "short" }]) {
      expect(await deliverGithubTriggerEvents(deps(), pushed(over) as never), JSON.stringify(over)).toEqual({ events: 0, duplicates: 0 });
    }
    expect(await deliverGithubTriggerEvents(deps(), pushed({}, 4242) as never)).toEqual({ events: 0, duplicates: 0 });
    db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: ORG, status: "removed" });
    expect(await deliverGithubTriggerEvents(deps(), pushed())).toEqual({ events: 0, duplicates: 0 });
    expect(queued).toEqual([]);
  });

  it("follows the project's own record of the default branch, not the payload's", async () => {
    const { queued, deps } = pushWorld([repo("api", 101, { defaultBranch: "trunk" })]);
    await deliverGithubTriggerEvents(deps(), pushed());
    expect(queued).toEqual([]);
    await deliverGithubTriggerEvents(deps(), pushed({ ref: "refs/heads/trunk", repository: { id: 101, default_branch: "trunk" } }));
    expect(queued).toHaveLength(1);
  });

  it("reads no record for a push that is not to the default branch", async () => {
    const { db, deps } = pushWorld();
    const before = db.commandNames().length;
    await deliverGithubTriggerEvents(deps(), pushed({ ref: "refs/heads/feature" }));
    expect(db.commandNames().length).toBe(before);
  });

  it("does nothing when the registry is not wired, and asks GitHub to deliver again when the registry fails", async () => {
    const { deps } = pushWorld();
    expect(await deliverGithubTriggerEvents(deps({ queueSavedEnvPush: undefined }), pushed() as never)).toEqual({ events: 0, duplicates: 0 });
    await expect(deliverGithubTriggerEvents(deps({ queueSavedEnvPush: async () => { throw new Error("down"); } }), pushed() as never)).rejects.toBeInstanceOf(GithubWebhookRetryableError);
  });

  it("reads the pushes without telling the registry", async () => {
    const { db } = pushWorld();
    expect(await githubCodePushes({ documentClient: db, tableName: "state", log: () => undefined }, pushed() as never)).toEqual([{ orgId: ORG, project: PROJECT }]);
  });

  it("the broker's queue for it is the registry's push check, only while sv is on and the registry is installed", async () => {
    const w = savedEnvWorld();
    const queue = savedEnvPushQueue({ savedEnvDeps: w.deps } as unknown as AwsBrokerDependencies, { SAVED_ENV_ENABLED: "1" });
    await queue!({ orgId: w.ids.orgId, project: w.ids.projectId });
    expect(w.row()?.lastPushAt).toBeDefined();
    expect(w.row()?.job?.reason).toBe("no_image");
    // every write of the row sets the poll time, so a project that has been touched is polled
    expect(Date.parse(w.row()!.nextPollAt!)).toBe(w.clock.now + SAVED_ENV_POLL_MS);
    expect(savedEnvPushQueue({ savedEnvDeps: w.deps } as unknown as AwsBrokerDependencies, {})).toBeUndefined();
    expect(savedEnvPushQueue({} as AwsBrokerDependencies, { SAVED_ENV_ENABLED: "1" })).toBeUndefined();
  });
});

// ---- a queued job is started by whichever trigger queued it

describe("onQueued", () => {
  it("is called with the job by every trigger that queues one: push, task, nightly, poll, reset", async () => {
    for (const trigger of ["push", "task", "nightly", "poll"] as const) {
      const w = savedEnvWorld();
      const onQueued = vi.fn(async () => undefined);
      const result = await checkRebuild({ ...w.deps, onQueued }, w.ids, trigger);
      expect(result, trigger).toMatchObject({ ok: true, queued: true });
      expect(onQueued, trigger).toHaveBeenCalledWith(w.ids, expect.objectContaining({ reason: "no_image" }));
    }
  });

  it("is not called when nothing was queued, and a throwing start changes nothing about the queued job", async () => {
    const w = savedEnvWorld({ approved: undefined });
    const onQueued = vi.fn(async () => undefined);
    expect(await checkRebuild({ ...w.deps, onQueued }, w.ids, "poll")).toMatchObject({ queued: false });
    expect(onQueued).not.toHaveBeenCalled();
    const v = savedEnvWorld();
    expect(await checkRebuild({ ...v.deps, onQueued: async () => { throw new Error("boom"); } }, v.ids, "poll")).toMatchObject({ ok: true, queued: true });
    expect(v.row()?.job).toBeDefined();
  });

  it("the task-start check starts the job too", async () => {
    const w = savedEnvWorld();
    const onQueued = vi.fn(async () => undefined);
    await savedEnvForPrepare({ ...w.deps, onQueued }, w.ids, APPROVED);
    expect(onQueued).toHaveBeenCalledTimes(1);
  });

  it("the broker's start ends a job it cannot start for a reason that will not mend (and only that)", async () => {
    const w = savedEnvWorld();
    const job = await checkRebuild(w.deps, w.ids, "poll");
    if (!job.ok || !job.queued) throw new Error("not queued");
    // no project to read: the start answers `no_project`
    const dependencies = { savedEnvDeps: w.deps, documentClient: new FakeDynamoDb(), tableName: "state" } as unknown as AwsBrokerDependencies;
    const onQueued = savedEnvOnQueued(() => dependencies, undefined, { SAVED_ENV_ENABLED: "1" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await onQueued(w.ids, job.job);
    expect(w.row()?.job).toBeUndefined();
    expect(w.row()).toMatchObject({ health: "needs_repair", lastFailure: "no_project" });
  });

  it("the broker's start leaves a job alone when the start refuses because the switch is off, and never throws", async () => {
    const w = savedEnvWorld();
    const job = await checkRebuild(w.deps, w.ids, "poll");
    if (!job.ok || !job.queued) throw new Error("not queued");
    const dependencies = { savedEnvDeps: w.deps, documentClient: new FakeDynamoDb(), tableName: "state" } as unknown as AwsBrokerDependencies;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(savedEnvOnQueued(() => dependencies, undefined, {})(w.ids, job.job)).resolves.toBeUndefined();
    expect(w.row()?.job).toBeDefined();
    await expect(savedEnvOnQueued(() => { throw new Error("x"); }, undefined, { SAVED_ENV_ENABLED: "1" })(w.ids, job.job)).resolves.toBeUndefined();
  });
});

describe("ending a queued job", () => {
  it("ends the project's current job that nobody has been given the lease of, with a fixed word and the failure backoff", async () => {
    const w = savedEnvWorld();
    const queued = await checkRebuild(w.deps, w.ids, "poll");
    if (!queued.ok || !queued.queued) throw new Error("not queued");
    expect(await abandonQueuedJob(w.deps, w.ids, "another-job", "no_owner")).toEqual({ ok: false });
    expect(w.row()?.job).toBeDefined();
    expect(await abandonQueuedJob(w.deps, w.ids, queued.job.jobId, "No Owner!")).toEqual({ ok: true });
    expect(w.row()).toMatchObject({ health: "needs_repair", lastFailure: "owner" });
    expect(w.row()?.job).toBeUndefined();
    // the backoff now holds a new automatic job back
    expect(await checkRebuild(w.deps, w.ids, "poll")).toMatchObject({ ok: true, queued: false, why: "backoff" });
  });

  it("does not end a job whose lease was handed out, and does nothing when the switch is off", async () => {
    const w = savedEnvWorld();
    w.seed({ job: { jobId: "j1", leaseToken: "T".repeat(40), reason: "no_image", approved: APPROVED, commits: { svc: "f".repeat(40) }, expectedKey: "c".repeat(64), createdAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + DAY).toISOString(), dispatchedAt: new Date().toISOString() } });
    expect(await abandonQueuedJob(w.deps, w.ids, "j1", "no_owner")).toEqual({ ok: false });
    const off = savedEnvWorld({ enabled: false });
    off.seed({});
    expect(await abandonQueuedJob(off.deps, off.ids, "j1", "x")).toEqual({ ok: false });
  });
});

// ---- the poll

describe("the periodic poll", () => {
  it("looks at the projects whose time has come, queues what is due, and moves a quiet project's time on", async () => {
    const w = savedEnvWorld();
    w.seed({ images: [imageOf(dig(1))], health: "healthy", nextPollAt: new Date(w.clock.now - 1000).toISOString() });
    const quiet = savedEnvWorld({ ids: { orgId: "org-2", projectId: "proj-2" } });
    expect(await runPoll(w.deps, 10)).toEqual({ ok: true, checked: 1, failed: 0 });
    expect(w.row()?.job).toBeUndefined();
    expect(Date.parse(w.row()!.nextPollAt!)).toBe(w.clock.now + SAVED_ENV_POLL_MS);
    // not due again until its time
    expect(await runPoll(w.deps, 10)).toEqual({ ok: true, checked: 0, failed: 0 });
    // an image past its age is rebuilt by the poll
    w.clock.now += 8 * DAY;
    const onQueued = vi.fn(async () => undefined);
    expect(await runPoll({ ...w.deps, onQueued }, 10)).toEqual({ ok: true, checked: 1, failed: 0 });
    expect(w.row()?.job?.reason).toBe("max_age");
    expect(onQueued).toHaveBeenCalledTimes(1);
    void quiet;
  });

  it("never looks at a project that is archived, deleted or turned off, at most `limit` a pass, and does nothing with the switch off", async () => {
    const w = savedEnvWorld();
    const due = new Date(w.clock.now - 1000).toISOString();
    for (const change of [{ archived: true }, { deleted: true }, { enabled: false }]) {
      w.seed({ nextPollAt: due, ...change });
      expect(await runPoll(w.deps, 10), JSON.stringify(change)).toEqual({ ok: true, checked: 0, failed: 0 });
    }
    expect(await runPoll(savedEnvWorld({ enabled: false }).deps, 10)).toEqual({ ok: false, reason: "disabled" });
    const many = savedEnvWorld();
    for (let index = 0; index < 5; index += 1) many.store.rows.set(`org-${String(index)}#p`, { orgId: `org-${String(index)}`, projectId: "p", version: 1, enabled: true, images: [], health: "never_proved", nextPollAt: due });
    expect((await runPoll(many.deps, 3) as { checked: number }).checked).toBe(3);
  });

  it("counts a project whose check fails and moves its time on with a growing backoff, so it cannot take every pass; a poll that works clears the failures", async () => {
    const w = savedEnvWorld();
    w.seed({ nextPollAt: new Date(w.clock.now - 1000).toISOString() });
    const approved = w.deps.approved;
    w.deps.approved = async () => { throw new Error("down"); };
    const gaps: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      expect(await runPoll(w.deps, 10)).toEqual({ ok: true, checked: 0, failed: 1 });
      gaps.push(Date.parse(w.row()!.nextPollAt!) - w.clock.now);
      expect(w.row()?.pollFailures).toBe(round + 1);
      // not looked at again until its time
      expect(await runPoll(w.deps, 10)).toEqual({ ok: true, checked: 0, failed: 0 });
      w.clock.now = Date.parse(w.row()!.nextPollAt!) + 1;
    }
    expect(gaps.slice(0, 3)).toEqual([2 * SAVED_ENV_POLL_MS, 4 * SAVED_ENV_POLL_MS, 8 * SAVED_ENV_POLL_MS]);
    expect(Math.max(...gaps)).toBe(SAVED_ENV_POLL_BACKOFF_MAX_MS);
    w.deps.approved = approved;
    expect(await runPoll(w.deps, 10)).toMatchObject({ ok: true, failed: 0 });
    expect(w.row()?.pollFailures).toBeUndefined();
    expect(Date.parse(w.row()!.nextPollAt!)).toBe(w.clock.now + SAVED_ENV_POLL_MS);
  });

  it("counts a check that lost its write as a failure too, and backs the project off", async () => {
    const w = savedEnvWorld();
    w.seed({ nextPollAt: new Date(w.clock.now - 1000).toISOString() });
    w.store.failNextCommit();
    expect(await runPoll(w.deps, 10)).toEqual({ ok: true, checked: 0, failed: 1 });
    expect(w.row()).toMatchObject({ pollFailures: 1 });
    expect(Date.parse(w.row()!.nextPollAt!)).toBe(w.clock.now + 2 * SAVED_ENV_POLL_MS);
  });

  it("is the broker's pass only while sv is on, and never throws", async () => {
    const w = savedEnvWorld();
    w.seed({ images: [imageOf(dig(1))], health: "healthy", nextPollAt: new Date(w.clock.now - 1000).toISOString() });
    const dependencies = { savedEnvDeps: w.deps } as unknown as AwsBrokerDependencies;
    expect(await runSavedEnvPoll(dependencies, {})).toBe("off");
    expect(await runSavedEnvPoll(dependencies, { SAVED_ENV_ENABLED: "1" })).toEqual({ ok: true, checked: 1, failed: 0 });
    w.deps.store.pollDue = async () => { throw new Error("down"); };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runSavedEnvPoll(dependencies, { SAVED_ENV_ENABLED: "1" })).toEqual({ ok: false, reason: "unavailable" });
  });
});

// ---- the nightly

describe("before each nightly", () => {
  const fire = (orgId: string, project: string) => ({ source: "agentx.test-env-nightly", orgId, project, scheduledAt: new Date().toISOString() });

  it("checks the project's images as the nightly trigger, and sweeps the deleted projects' registries", async () => {
    const w = savedEnvWorld({ ids: { orgId: TEST_ORG, projectId: PROJECT } });
    w.store.rows.set(`${TEST_ORG}#gone`, { orgId: TEST_ORG, projectId: "gone", version: 1, enabled: true, images: [], health: "never_proved", deleted: true, deletedAt: new Date(w.clock.now - 10 * DAY).toISOString() });
    const dependencies = { savedEnvDeps: w.deps } as unknown as AwsBrokerDependencies;
    const event = fire(TEST_ORG, PROJECT);
    await savedEnvBeforeNightly(dependencies, event, { SAVED_ENV_ENABLED: "1" });
    expect(w.row()?.job?.reason).toBe("no_image");
    expect(w.calls.repoDeleted).toBe(1);
  });

  it("does nothing with the switch off or no registry, ignores an event that is not a fire, and never fails the night", async () => {
    const w = savedEnvWorld({ ids: { orgId: TEST_ORG, projectId: PROJECT } });
    const dependencies = { savedEnvDeps: w.deps } as unknown as AwsBrokerDependencies;
    await savedEnvBeforeNightly(dependencies, fire(TEST_ORG, PROJECT), {});
    await savedEnvBeforeNightly({} as AwsBrokerDependencies, fire(TEST_ORG, PROJECT), { SAVED_ENV_ENABLED: "1" });
    expect(w.row()).toBeUndefined();
    await savedEnvBeforeNightly(dependencies, { source: "other" }, { SAVED_ENV_ENABLED: "1" });
    expect(w.row()).toBeUndefined();
    w.deps.approved = async () => { throw new Error("down"); };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(savedEnvBeforeNightly(dependencies, fire(TEST_ORG, PROJECT), { SAVED_ENV_ENABLED: "1" })).resolves.toBeUndefined();
  });
});
