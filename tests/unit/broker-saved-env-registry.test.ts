// SH24: the broker's registry of a project's saved environment images: when a rebuild is queued, what a build result must satisfy before it is recorded, who may hold the job's lease, what a task may use,
// keep N and the age ceiling, archive and delete. Everything is off with `sv` off.
import { describe, expect, it } from "vitest";
import { savedEnvRepositoryName, type SavedEnvManifest } from "../../packages/contracts/src/index.js";
import {
  ARCHIVE_POLICY, SAVED_ENV_FAILURE_BACKOFF_MS, SAVED_ENV_JOB_LEASE_MS, authorizeLease, checkRebuild, imageForTask, lightSetup, markStale, onProjectArchived, onProjectDeleted, rebuildReason, recordBuild, reportFailure, requestReset, walk,
  type RegistryImage, type RegistryPort, type SavedEnvDeps, type SavedEnvImageRecord, type SavedEnvState,
} from "../../packages/broker/src/test-env/saved-env.js";
import { expectedRepositoryPolicy, type RepositoryDescription, type SavedEnvSessionConfig, type SavedEnvSessionPorts } from "../../packages/broker/src/test-env/saved-env-session.js";
import { memorySavedEnvStore } from "../support/memory-saved-env-store.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-02T12:00:00Z");
const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
const ids = { orgId: "org-1", projectId: "proj-1" };
const APPROVED = { revision: 4, digest: "a".repeat(64) };
const KEY = "k".repeat(64).replace(/k/gu, "c");
const COMMIT = "f".repeat(40);
const repository = savedEnvRepositoryName({ env: "test", orgId: ids.orgId, projectId: ids.projectId });
const iso = (ms: number) => new Date(ms).toISOString();

const manifestOf = (over: Partial<SavedEnvManifest> = {}): SavedEnvManifest => ({
  schemaVersion: 1, environmentKey: KEY, testEnvRevision: 4, commits: [{ repositoryId: "svc", sha: COMMIT }], proveReportDigest: "b".repeat(64), imageDigest: `sha256:${"1".repeat(64)}`, builtAt: iso(T0), ...over,
});
const imageOf = (digest: string, over: Partial<SavedEnvImageRecord> = {}): SavedEnvImageRecord => ({ digest, tag: `k-${digest.slice(7, 12)}`, manifest: manifestOf({ imageDigest: digest }), recordedAt: iso(T0), status: "ready", ...over });
const dig = (n: number): string => `sha256:${String(n).repeat(64)}`;

function world(over: { enabled?: boolean; approved?: typeof APPROVED | undefined; key?: string | undefined; heads?: Map<string, string> | undefined; keep?: number; description?: RepositoryDescription | "absent"; registry?: Partial<RegistryPort>; images?: RegistryImage[]; now?: number } = {}) {
  const store = memorySavedEnvStore();
  const clock = { now: over.now ?? T0 };
  const config: SavedEnvSessionConfig = { enabled: over.enabled ?? true, env: "test", scope: { partition: "aws", region: "us-west-2", account: "111122223333" }, kmsKeyArn: KMS };
  const assumed: Array<{ roleArn: string; policy: string }> = [];
  const good = (): RepositoryDescription => ({ encryptionType: "KMS", kmsKey: KMS, imageTagMutability: "IMMUTABLE", policyText: JSON.stringify(expectedRepositoryPolicy(config)) });
  const ports: SavedEnvSessionPorts = {
    async assume(request) { assumed.push(request); return { credentials: { accessKeyId: "id", secretAccessKey: "s", sessionToken: "t" }, expiresAtMs: clock.now + 900_000 }; },
    async authorizationToken() { return { password: "p".repeat(30), registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", expiresAtMs: clock.now + 3_600_000 }; },
    async inspectRepository() { return over.description ?? good(); },
    async readApproved() { return over.approved === undefined && "approved" in over ? undefined : (over.approved ?? APPROVED); },
    async proveHolds() { return true; },
    now: () => clock.now,
  };
  const calls = { deleted: [] as string[][], repoDeleted: 0, scans: [] as string[] };
  const registry: RegistryPort = {
    async listImages() { return over.images ?? []; },
    async batchDelete(_c, _r, digests) { calls.deleted.push(digests); },
    async deleteRepository() { calls.repoDeleted += 1; },
    async startScan(_c, _r, digest) { calls.scans.push(digest); },
    ...over.registry,
  };
  let counter = 0;
  const deps: SavedEnvDeps = {
    store, session: { config, ports }, registry,
    approved: async () => ("approved" in over ? over.approved : APPROVED),
    currentKey: async () => ("key" in over ? over.key : KEY),
    defaultHeads: async () => ("heads" in over ? over.heads : new Map([["svc", COMMIT]])),
    keep: async () => over.keep ?? 3,
    now: () => clock.now,
    random: () => { counter += 1; return `${String(counter).padStart(2, "0")}`.repeat(24); },
  };
  return { deps, store, clock, assumed, calls };
}

const seed = (w: ReturnType<typeof world>, state: Partial<SavedEnvState>): void => { w.store.rows.set("org-1#proj-1", { orgId: "org-1", projectId: "proj-1", version: 1, enabled: true, images: [], health: "never_proved", ...state }); };

describe("when a rebuild is due", () => {
  const image = imageOf(dig(1));
  const base = { now: T0, image, approved: APPROVED, currentKey: KEY, resetRequested: false };

  it("no approved environment decides nothing; no image, a stale one, another revision, another key, an old image and a reset each have their word", () => {
    expect(rebuildReason({ ...base, approved: undefined, image: undefined })).toBeUndefined();
    expect(rebuildReason({ ...base, image: undefined })).toBe("no_image");
    expect(rebuildReason({ ...base, image: { ...image, status: "stale" } })).toBe("stale");
    expect(rebuildReason({ ...base, approved: { ...APPROVED, revision: 5 } })).toBe("key_changed");
    expect(rebuildReason({ ...base, currentKey: "d".repeat(64) })).toBe("key_changed");
    expect(rebuildReason({ ...base, now: T0 + 7 * DAY + 1 })).toBe("max_age");
    expect(rebuildReason({ ...base, resetRequested: true })).toBe("reset");
    expect(rebuildReason(base)).toBeUndefined();
    expect(rebuildReason({ ...base, now: T0 + 7 * DAY })).toBeUndefined();
  });

  it("a key that cannot be worked out decides nothing about the key", () => {
    expect(rebuildReason({ ...base, currentKey: undefined })).toBeUndefined();
  });

  it("an idle repository (no push and no task for 7 days) is saved light: no image is built", () => {
    expect(lightSetup({ lastPushAt: iso(T0 - 8 * DAY) }, T0)).toBe(true);
    expect(lightSetup({ lastPushAt: iso(T0 - 8 * DAY), lastTaskAt: iso(T0 - DAY) }, T0)).toBe(false);
    expect(lightSetup({}, T0)).toBe(false);
    expect(lightSetup({ lastPushAt: iso(T0 - 4 * DAY) }, T0, 3)).toBe(true);
  });
});

describe("queueing a rebuild", () => {
  it("is off with `sv` off: nothing is read or written", async () => {
    const w = world({ enabled: false });
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: false, reason: "disabled" });
    expect(await requestReset(w.deps, ids)).toEqual({ ok: false, reason: "disabled" });
    expect(await authorizeLease(w.deps, ids, { jobId: "x", leaseToken: "y" })).toEqual({ ok: false, reason: "disabled" });
    expect(await walk(w.deps, ids)).toEqual({ ok: false, reason: "disabled" });
    expect(await onProjectDeleted(w.deps, ids)).toEqual({ ok: false, reason: "disabled" });
    expect(await markStale(w.deps, ids, { digest: dig(1), step: "pull" })).toEqual({ ok: false });
    expect(w.store.rows.size).toBe(0);
    expect(w.assumed).toEqual([]);
  });

  it("a project with an approved environment and no image gets a job with a lease; a second check while it runs changes nothing", async () => {
    const w = world();
    const first = await checkRebuild(w.deps, ids, "push");
    expect(first).toMatchObject({ ok: true, queued: true, job: { reason: "no_image", approved: APPROVED } });
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row.job).toMatchObject({ reason: "no_image", approved: APPROVED });
    expect(row.job!.leaseUntil).toBe(iso(T0 + SAVED_ENV_JOB_LEASE_MS));
    expect(row.job!.leaseToken.length).toBeGreaterThanOrEqual(32);
    expect(await checkRebuild(w.deps, ids, "nightly")).toEqual({ ok: true, queued: false, why: "in_flight" });
    expect(w.store.audit.filter((entry) => entry.action === "rebuild_queued")).toHaveLength(1);
  });

  it("an expired lease is taken over by the next check", async () => {
    const w = world();
    await checkRebuild(w.deps, ids, "push");
    const first = w.store.rows.get("org-1#proj-1")!.job!;
    w.clock.now += SAVED_ENV_JOB_LEASE_MS + 1;
    expect(await checkRebuild(w.deps, ids, "poll")).toMatchObject({ ok: true, queued: true });
    expect(w.store.rows.get("org-1#proj-1")!.job!.jobId).not.toBe(first.jobId);
    expect((await authorizeLease(w.deps, ids, { jobId: first.jobId, leaseToken: first.leaseToken })).ok).toBe(false);
  });

  it("no approved environment, an archived project, and a project that turned the feature off queue nothing", async () => {
    expect(await checkRebuild(world({ approved: undefined }).deps, ids, "push")).toEqual({ ok: true, queued: false, why: "no_approved" });
    const archived = world(); seed(archived, { archived: true });
    expect(await checkRebuild(archived.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "archived" });
    const off = world(); seed(off, { enabled: false });
    expect(await checkRebuild(off.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "off_for_project" });
  });

  it("a fresh image with the same key queues nothing; a changed key, an age past 7 days and a stale mark each queue", async () => {
    const quiet = world(); seed(quiet, { images: [imageOf(dig(1))], health: "healthy" });
    expect(await checkRebuild(quiet.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "no_change" });
    const changed = world({ key: "d".repeat(64) }); seed(changed, { images: [imageOf(dig(1))] });
    expect(await checkRebuild(changed.deps, ids, "push")).toMatchObject({ queued: true, job: { reason: "key_changed" } });
    const old = world({ now: T0 + 8 * DAY }); seed(old, { images: [imageOf(dig(1))], lastPushAt: iso(T0 + 8 * DAY - 1000) });
    expect(await checkRebuild(old.deps, ids, "nightly")).toMatchObject({ queued: true, job: { reason: "max_age" } });
    const stale = world(); seed(stale, { images: [imageOf(dig(1), { status: "stale" })] });
    expect(await checkRebuild(stale.deps, ids, "poll")).toMatchObject({ queued: true, job: { reason: "stale" } });
  });

  it("an idle repository is not rebuilt by the nightly or the poll, but a push or a Reset does", async () => {
    const w = world({ now: T0 }); seed(w, { images: [], lastPushAt: iso(T0 - 9 * DAY) });
    expect(await checkRebuild(w.deps, ids, "nightly")).toEqual({ ok: true, queued: false, why: "idle" });
    expect(await checkRebuild(w.deps, ids, "poll")).toEqual({ ok: true, queued: false, why: "idle" });
    expect(await requestReset(w.deps, ids)).toMatchObject({ queued: true, job: { reason: "reset" } });
    const pushed = world(); seed(pushed, { images: [], lastPushAt: iso(T0 - 9 * DAY) });
    expect(await checkRebuild(pushed.deps, ids, "push")).toMatchObject({ queued: true });
  });

  it("Reset queues a rebuild even when the image is fresh and after a failure's backoff", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "needs_repair", lastFailureAt: iso(T0 - 1000) });
    expect(await checkRebuild(w.deps, ids, "poll")).toEqual({ ok: true, queued: false, why: "backoff" });
    expect(await requestReset(w.deps, ids)).toMatchObject({ queued: true, job: { reason: "reset" } });
    const later = world({ now: T0 + SAVED_ENV_FAILURE_BACKOFF_MS + 1 }); seed(later, { images: [imageOf(dig(1), { status: "stale" })], lastFailureAt: iso(T0) });
    expect(await checkRebuild(later.deps, ids, "poll")).toMatchObject({ queued: true });
  });

  it("a write that met another write is reported, not applied twice", async () => {
    const w = world();
    w.store.failNextCommit();
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: false, reason: "stale_write" });
  });
});

describe("the job's lease is the only way to the push login and the result", () => {
  it("a lease is honoured for the right job id and token only", async () => {
    const w = world();
    await checkRebuild(w.deps, ids, "push");
    const job = w.store.rows.get("org-1#proj-1")!.job!;
    expect((await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: job.leaseToken })).ok).toBe(true);
    expect(await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: "x".repeat(job.leaseToken.length) })).toEqual({ ok: false, reason: "bad_lease" });
    expect(await authorizeLease(w.deps, ids, { jobId: "other", leaseToken: job.leaseToken })).toEqual({ ok: false, reason: "bad_lease" });
    expect(await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: "" })).toEqual({ ok: false, reason: "bad_lease" });
    expect(await authorizeLease(w.deps, { orgId: "org-2", projectId: "proj-1" }, { jobId: job.jobId, leaseToken: job.leaseToken })).toEqual({ ok: false, reason: "no_job" });
    w.clock.now += SAVED_ENV_JOB_LEASE_MS + 1;
    expect(await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: job.leaseToken })).toEqual({ ok: false, reason: "expired" });
  });
});

describe("recording a build", () => {
  const resultOf = (over: { digest?: string; manifest?: Partial<SavedEnvManifest>; ok?: boolean } = {}) => {
    const digest = over.digest ?? dig(2);
    return { ok: true, repository, tag: "k0123456789abcdef-20261102120000-01234567", imageDigest: digest, manifest: manifestOf({ imageDigest: digest, ...over.manifest }) };
  };
  async function queued(over: Parameters<typeof world>[0] = {}) {
    const w = world(over);
    await checkRebuild(w.deps, ids, "push");
    const job = w.store.rows.get("org-1#proj-1")!.job!;
    return { w, lease: { jobId: job.jobId, leaseToken: job.leaseToken } };
  }

  it("records an image that came from the lease, is the approved revision, is the code host's default branch heads and sits in the template's repository; starts a scan", async () => {
    const { w, lease } = await queued();
    const recorded = await recordBuild(w.deps, ids, { ...lease, result: resultOf() });
    expect(recorded).toMatchObject({ ok: true, image: { digest: dig(2), status: "ready" } });
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row.images.map((image) => image.digest)).toEqual([dig(2)]);
    expect(row.job).toBeUndefined();
    expect(row.health).toBe("healthy");
    expect(w.calls.scans).toEqual([dig(2)]);
    expect(w.assumed.some((request) => request.roleArn.includes("img-push") && request.policy.includes("StartImageScan"))).toBe(true);
  });

  it("refuses a result from anyone without the lease", async () => {
    const { w, lease } = await queued();
    expect(await recordBuild(w.deps, ids, { jobId: lease.jobId, leaseToken: "z".repeat(48), result: resultOf() })).toEqual({ ok: false, reason: "bad_lease" });
    expect(w.store.rows.get("org-1#proj-1")!.images).toEqual([]);
  });

  it("refuses a manifest whose commits are not the code host's default branch heads: a stale commit, a side commit, a missing repository, an extra one; and the head lookup failing", async () => {
    const cases: Array<[string, Partial<SavedEnvManifest>, Map<string, string> | undefined]> = [
      ["stale commit", { commits: [{ repositoryId: "svc", sha: "e".repeat(40) }] }, undefined],
      ["missing", { commits: [] as never }, undefined],
      ["extra", { commits: [{ repositoryId: "svc", sha: COMMIT }, { repositoryId: "other", sha: COMMIT }] }, undefined],
      ["no answer", {}, new Map()],
    ];
    for (const [name, manifest, heads] of cases) {
      const { w, lease } = await queued({ ...(heads === undefined ? {} : { heads }) });
      const refused = await recordBuild(w.deps, ids, { ...lease, result: resultOf({ manifest }) });
      expect(refused.ok, name).toBe(false);
      expect(w.store.rows.get("org-1#proj-1")!.images, name).toEqual([]);
    }
    const { w, lease } = await queued({ heads: undefined });
    expect(await recordBuild(w.deps, ids, { ...lease, result: resultOf() })).toEqual({ ok: false, reason: "wrong_commits" });
  });

  it("refuses when the project's approved environment moved since the job was queued, or the manifest is for another revision or another digest", async () => {
    const { w, lease } = await queued();
    const moved = { ...w, deps: { ...w.deps, approved: async () => ({ revision: 5, digest: "9".repeat(64) }) } };
    expect(await recordBuild(moved.deps, ids, { ...lease, result: resultOf() })).toEqual({ ok: false, reason: "not_approved" });
    const second = await queued();
    expect(await recordBuild(second.w.deps, ids, { ...second.lease, result: resultOf({ manifest: { testEnvRevision: 3 } }) })).toEqual({ ok: false, reason: "wrong_manifest" });
    const third = await queued();
    expect(await recordBuild(third.w.deps, ids, { ...third.lease, result: { ...resultOf(), imageDigest: dig(7) } })).toEqual({ ok: false, reason: "wrong_manifest" });
  });

  it("refuses when the repository in the registry is not the one the template made (squatting), and records nothing", async () => {
    const { w, lease } = await queued({ description: { encryptionType: "AES256", kmsKey: undefined, imageTagMutability: "MUTABLE", policyText: undefined } });
    expect(await recordBuild(w.deps, ids, { ...lease, result: resultOf() })).toEqual({ ok: false, reason: "repository_mismatch" });
    expect(w.store.rows.get("org-1#proj-1")!.images).toEqual([]);
    expect(w.store.rows.get("org-1#proj-1")!.health).toBe("needs_repair");
    const absent = await queued({ description: "absent" });
    expect(await recordBuild(absent.w.deps, ids, { ...absent.lease, result: resultOf() })).toEqual({ ok: false, reason: "repository_mismatch" });
  });

  it("a failed build is recorded as needing repair with its fixed word, and the lease is released", async () => {
    const { w, lease } = await queued();
    expect(await recordBuild(w.deps, ids, { ...lease, result: { ok: false, reason: "secrets_found" } })).toEqual({ ok: false, reason: "build_failed" });
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row).toMatchObject({ health: "needs_repair", lastFailure: "secrets_found" });
    expect(row.job).toBeUndefined();
    const again = await queued();
    expect((await reportFailure(again.w.deps, ids, { ...again.lease, reason: "push_failed; DROP" })).ok).toBe(true);
    expect(again.w.store.rows.get("org-1#proj-1")!.lastFailure).toBe("push_failed");
  });

  it("garbage in place of a result is refused", async () => {
    const { w, lease } = await queued();
    expect(await recordBuild(w.deps, ids, { ...lease, result: { ok: true, imageDigest: "latest" } })).toEqual({ ok: false, reason: "bad_result" });
  });

  it("the row keeps at most N images even when the registry cannot be walked", async () => {
    const { w, lease } = await queued({ keep: 2, registry: { listImages: async () => { throw new Error("denied"); } } });
    seed(w, { ...w.store.rows.get("org-1#proj-1")!, images: [imageOf(dig(3)), imageOf(dig(1))] });
    const recorded = await recordBuild(w.deps, ids, { ...lease, result: resultOf({ digest: dig(4) }) });
    expect(recorded.ok).toBe(true);
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(4), dig(3)]);
  });

  it("keeps the newest N images: a fourth build drops the oldest from the row and the registry", async () => {
    const images: RegistryImage[] = [1, 2, 3].map((n) => ({ digest: dig(n), tags: ["t"], pushedAt: iso(T0 - (4 - n) * 3_600_000) }));
    const { w, lease } = await queued({ images: [...images, { digest: dig(4), tags: ["t"], pushedAt: iso(T0) }] });
    seed(w, { ...w.store.rows.get("org-1#proj-1")!, images: images.map((i) => imageOf(i.digest)).reverse() });
    // the seeded row keeps the job
    const recorded = await recordBuild(w.deps, ids, { ...lease, result: resultOf({ digest: dig(4) }) });
    expect(recorded.ok).toBe(true);
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(4), dig(3), dig(2)]);
    expect(w.calls.deleted).toEqual([[dig(1)]]);
  });
});

describe("the manage walk: keep N, the age ceiling, untagged images", () => {
  it("deletes beyond keep, past 30 days and untagged images older than a day, and drops what the registry no longer holds from the row", async () => {
    const listed: RegistryImage[] = [
      { digest: dig(1), tags: ["a"], pushedAt: iso(T0 - 1 * 3_600_000) },
      { digest: dig(2), tags: ["a"], pushedAt: iso(T0 - 2 * DAY) },
      { digest: dig(3), tags: ["a"], pushedAt: iso(T0 - 31 * DAY) },
      { digest: dig(4), tags: [], pushedAt: iso(T0 - 2 * DAY) },
      { digest: dig(5), tags: ["a"], pushedAt: iso(T0 - 3 * DAY) },
      { digest: dig(6), tags: ["a"], pushedAt: iso(T0 - 4 * DAY) },
    ];
    const w = world({ images: listed, keep: 3 });
    const old = { recordedAt: iso(T0 - 3 * DAY) };
    seed(w, { images: [imageOf(dig(1), old), imageOf(dig(2), old), imageOf(dig(3), old), imageOf(dig(9), old)], health: "healthy" });
    const result = await walk(w.deps, ids);
    expect(result).toEqual({ ok: true, deleted: 4 });
    expect(w.calls.deleted[0]!.sort()).toEqual([dig(3), dig(4), dig(5), dig(6)].sort());
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(1), dig(2)]);
  });

  it("the ceiling deletes the newest image too when it is that old, and the project reads as needing repair", async () => {
    const w = world({ images: [{ digest: dig(1), tags: ["a"], pushedAt: iso(T0 - 40 * DAY) }] });
    seed(w, { images: [imageOf(dig(1), { recordedAt: iso(T0 - 40 * DAY) })], health: "healthy" });
    expect(await walk(w.deps, ids)).toEqual({ ok: true, deleted: 1 });
    expect(w.store.rows.get("org-1#proj-1")).toMatchObject({ images: [], health: "needs_repair" });
  });

  it("an image recorded minutes ago stays even if the registry's list does not show it yet; one recorded long ago does not", async () => {
    const w = world({ images: [] });
    seed(w, { images: [imageOf(dig(1), { recordedAt: iso(T0 - 60_000) }), imageOf(dig(2), { recordedAt: iso(T0 - DAY) })], health: "healthy" });
    expect(await walk(w.deps, ids)).toEqual({ ok: true, deleted: 0 });
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(1)]);
  });

  it("a registry that cannot be listed changes nothing", async () => {
    const w = world({ registry: { listImages: async () => { throw new Error("denied"); } } });
    seed(w, { images: [imageOf(dig(1))] });
    expect(await walk(w.deps, ids)).toEqual({ ok: false, reason: "unavailable" });
    expect(w.store.rows.get("org-1#proj-1")!.images).toHaveLength(1);
  });

  it("walks with a manage session of the broker's own, naming this project's repository only", async () => {
    const w = world();
    seed(w, { images: [] });
    await walk(w.deps, ids);
    expect(w.assumed).toHaveLength(1);
    expect(w.assumed[0]!.roleArn).toContain("img-manage");
    expect(w.assumed[0]!.policy).toContain(repository);
  });
});

describe("stale marks and what a task may use", () => {
  it("a fallback marks THAT image stale and queues a rebuild; a report about an image no longer known changes nothing", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    expect((await markStale(w.deps, ids, { digest: dig(1), step: "pull" })).ok).toBe(true);
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row.images[0]).toMatchObject({ status: "stale", staleStep: "pull" });
    expect(row.job).toMatchObject({ reason: "stale" });
    const other = world(); seed(other, { images: [imageOf(dig(1))] });
    await markStale(other.deps, ids, { digest: dig(8), step: "pull" });
    expect(other.store.rows.get("org-1#proj-1")!.images[0]!.status).toBe("ready");
  });

  it("a task may use the newest ready image built at its own revision, not a stale one, another revision's, or one far past the max age", () => {
    const state: SavedEnvState = { orgId: "org-1", projectId: "proj-1", version: 1, enabled: true, images: [imageOf(dig(1))], health: "healthy" };
    expect(imageForTask(state, APPROVED, T0)).toEqual({ digest: dig(1), environmentKey: KEY, testEnvRevision: 4 });
    expect(imageForTask(state, { ...APPROVED, revision: 5 }, T0)).toBeUndefined();
    expect(imageForTask({ ...state, images: [imageOf(dig(1), { status: "stale" })] }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask(state, APPROVED, T0 + 9 * DAY)).toBeUndefined();
    expect(imageForTask({ ...state, enabled: false }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask({ ...state, deleted: true }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask({ ...state, images: [] }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask(undefined, APPROVED, T0)).toBeUndefined();
  });
});

describe("archive and delete", () => {
  it("an archived project keeps its images, queues no rebuild and the reason is recorded", async () => {
    expect(ARCHIVE_POLICY).toContain("keeps its saved images");
    const w = world(); seed(w, { images: [imageOf(dig(1), { status: "stale" })], job: { jobId: "j", leaseToken: "t", reason: "stale", approved: APPROVED, createdAt: iso(T0), leaseUntil: iso(T0 + 1000) } });
    expect((await onProjectArchived(w.deps, ids, true)).ok).toBe(true);
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row.images).toHaveLength(1);
    expect(row.job).toBeUndefined();
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "archived" });
    expect(w.calls.deleted).toEqual([]);
    await onProjectArchived(w.deps, ids, false);
    expect(w.store.rows.get("org-1#proj-1")!.archived).toBe(false);
  });

  it("a deleted project loses every image and its repository, with a manage session on that repository only", async () => {
    const listed: RegistryImage[] = [{ digest: dig(1), tags: ["a"], pushedAt: iso(T0) }, { digest: dig(2), tags: [], pushedAt: iso(T0) }];
    const w = world({ images: listed });
    seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    expect(await onProjectDeleted(w.deps, ids)).toEqual({ ok: true, deleted: 2 });
    expect(w.calls.deleted).toEqual([[dig(1), dig(2)]]);
    expect(w.calls.repoDeleted).toBe(1);
    expect(w.assumed[0]!.policy).toContain(repository);
    expect(w.store.rows.get("org-1#proj-1")).toMatchObject({ images: [], deleted: true });
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "archived" });
  });

  it("a registry that cannot be reached leaves the row as it was and says so, so the caller retries", async () => {
    const w = world({ registry: { deleteRepository: async () => { throw new Error("denied"); } }, images: [{ digest: dig(1), tags: ["a"], pushedAt: iso(T0) }] });
    seed(w, { images: [imageOf(dig(1))] });
    expect(await onProjectDeleted(w.deps, ids)).toEqual({ ok: false, reason: "unavailable" });
    expect(w.store.rows.get("org-1#proj-1")!.deleted).toBeUndefined();
  });
});

describe("tenancy", () => {
  it("one org's project row is never read for another's, and the repository named in a session is that project's", async () => {
    const w = world();
    seed(w, { images: [imageOf(dig(1))] });
    expect(await w.deps.store.get("org-2", "proj-1")).toBeUndefined();
    expect(imageForTask(await w.deps.store.get("org-2", "proj-1"), APPROVED, T0)).toBeUndefined();
    await walk(w.deps, { orgId: "org-2", projectId: "proj-1" });
    expect(w.assumed).toHaveLength(0);
  });
});
