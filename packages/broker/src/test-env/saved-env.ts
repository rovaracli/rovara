// Setup and test health SH24 (design setup-test-health.md, sections 5.2 to 5.4): the broker's registry of a project's saved environment images.
//
// What it keeps, per project (one row, compare-and-set on `version`): the images it knows (newest first; each with its manifest, digest and whether it is `ready` or `stale`), the rebuild JOB that is queued
// or running (with the lease token that is the only thing allowed to ask for the push login), whether a Reset was asked, whether the project is archived, and the last time anything happened. Everything is
// behind the install's `sv` setting: with it off every function answers `disabled` and touches nothing.
//
// When a rebuild is queued (`checkRebuild`), and why (a fixed word):
//   no_image      the project has an approved environment and no usable image;
//   key_changed   the environment key of the default branch is not the image's (lockfiles, build files, toolchain files, secret names, the base image, the approved revision);
//   max_age       the image is older than 7 days;
//   stale         a task fell back from the image (SH23 reports the step) or a build failed to verify;
//   reset         a maintainer pressed Reset.
// Never when: the project is archived (images are kept, nothing is rebuilt), the repository is idle (see `lightSetup`: no push and no task for `lightAfterIdleDays`, so no image is built and its setup runs when
// a task first needs it), a job is already queued or running (an expired lease is taken over), or there is no approved environment.
// The triggers are the default branch's push events, the nightly, and a periodic poll until the push route is wired; all of them call `checkRebuild`.
//
// What a build result must satisfy before it is recorded (`recordBuild`), each its own fixed refusal:
//   - it comes from the job's lease (job id + lease token, compared in constant time): the push login and the result both belong to the rebuild job's lease only;
//   - the job's approved pin is still the project's newest approved revision and digest (TE-2);
//   - the manifest's commits are the code host's default branch heads for every repository (a build of a stale or a side commit is refused), its key and revision are the job's;
//   - the repository in the registry is the one the creation template made (`verifyRepository`: KMS, key, IMMUTABLE tags, the exact policy), checked AFTER the push and before the digest is recorded.
// Then it keeps the newest `keep` images, deletes the rest (and any past the 30 day ceiling) with a manage session, and starts a basic scan of the new image with a scan session.
//
// Delete: a deleted project loses all its images and its repository. An ARCHIVED project keeps them (an unarchive should not need a rebuild) until the 30 day ceiling deletes them; it queues no rebuild.
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  SAVED_ENV_IMAGE_CEILING_DAYS,
  SAVED_ENV_KEEP_DEFAULT,
  SAVED_ENV_KEEP_MAX,
  SAVED_ENV_KEEP_MIN,
  SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT,
  SAVED_ENV_MAX_AGE_DAYS,
  SavedEnvBuildResultSchema,
  type SavedEnvBuildResult,
  type SavedEnvManifest,
} from "@agentx/contracts";
import { mintManageSession, mintScanSession, verifyRepository, type SavedEnvSessionConfig, type SavedEnvSessionPorts, type SessionCredentials } from "./saved-env-session.js";

const DAY_MS = 86_400_000;
/** A recorded image the registry does not list yet is kept this long. */
const RECORD_GRACE_MS = 10 * 60_000;
/** A job that has not finished in this long is abandoned; the next check takes the project over. */
export const SAVED_ENV_JOB_LEASE_MS = 3 * 3_600_000;
/** After a failed build the project waits this long before the next automatic rebuild (a reset ignores it). */
export const SAVED_ENV_FAILURE_BACKOFF_MS = 30 * 60_000;

export const REBUILD_REASONS = ["no_image", "key_changed", "max_age", "stale", "reset"] as const;
export type RebuildReason = (typeof REBUILD_REASONS)[number];

export interface ApprovedPin { revision: number; digest: string }

export interface SavedEnvImageRecord {
  digest: string;
  tag: string;
  manifest: SavedEnvManifest;
  recordedAt: string;
  status: "ready" | "stale";
  /** The step a task fell back at (SH23), when `stale`. */
  staleStep?: string;
  scanStartedAt?: string;
}

export interface RebuildJob {
  jobId: string;
  /** The secret that authorises the push login and the result for THIS job. Never sent to a task. */
  leaseToken: string;
  reason: RebuildReason;
  approved: ApprovedPin;
  createdAt: string;
  leaseUntil: string;
}

export type SavedEnvHealth = "never_proved" | "healthy" | "needs_repair";

export interface SavedEnvState {
  orgId: string;
  projectId: string;
  /** Compare-and-set counter of the row. */
  version: number;
  /** The project's `savedEnv.enabled` setting. */
  enabled: boolean;
  /** Newest first. */
  images: SavedEnvImageRecord[];
  job?: RebuildJob | undefined;
  resetRequested?: boolean | undefined;
  archived?: boolean | undefined;
  deleted?: boolean | undefined;
  lastPushAt?: string | undefined;
  lastTaskAt?: string | undefined;
  lastRebuildReason?: RebuildReason | undefined;
  lastFailureAt?: string | undefined;
  lastFailure?: string | undefined;
  health: SavedEnvHealth;
}

/** What the audit ledger gets: ids, digests and fixed words only. */
export interface SavedEnvAuditEntry {
  action: "activity" | "rebuild_queued" | "build_recorded" | "build_refused" | "build_failed" | "marked_stale" | "reset_requested" | "images_deleted" | "project_archived" | "project_deleted" | "ceiling_walk";
  orgId: string;
  projectId: string;
  at: string;
  reason?: string;
  digest?: string;
  count?: number;
}

export interface SavedEnvStore {
  get(orgId: string, projectId: string): Promise<SavedEnvState | undefined>;
  /** Writes `next` and the audit entry together or neither, only while the stored version is `expectedVersion` (null: no row yet). False when the row changed meanwhile. */
  commit(next: SavedEnvState, expectedVersion: number | null, audit: SavedEnvAuditEntry): Promise<boolean>;
}

export interface RegistryImage { digest: string; tags: string[]; pushedAt: string }

/** The ECR calls the registry makes with a manage or scan session's credentials (adapters over `@aws-sdk/client-ecr`, wired with the routes). */
export interface RegistryPort {
  listImages(credentials: SessionCredentials, repository: string): Promise<RegistryImage[]>;
  batchDelete(credentials: SessionCredentials, repository: string, digests: string[]): Promise<void>;
  deleteRepository(credentials: SessionCredentials, repository: string): Promise<void>;
  startScan(credentials: SessionCredentials, repository: string, digest: string): Promise<void>;
}

export interface SavedEnvDeps {
  store: SavedEnvStore;
  session: { config: SavedEnvSessionConfig; ports: SavedEnvSessionPorts };
  registry: RegistryPort;
  /** The project's newest approved test environment, or undefined (bind to `readApprovedTestEnvironment`). */
  approved(orgId: string, projectId: string): Promise<ApprovedPin | undefined>;
  /** The environment key of the project's default branches NOW (SH3 + SH21, worked out where the code is read), or undefined when it cannot be worked out (then no decision is made). */
  currentKey(orgId: string, projectId: string): Promise<string | undefined>;
  /** The head commit of each repository's default branch, by repository name, or undefined when the code host cannot answer. */
  defaultHeads(orgId: string, projectId: string): Promise<ReadonlyMap<string, string> | undefined>;
  /** `savedEnv.keep` of the company (1 to 10). */
  keep(orgId: string): Promise<number>;
  /** `savedEnv.lightAfterIdleDays`. */
  lightAfterIdleDays?(orgId: string, projectId: string): Promise<number>;
  now(): number;
  random?(): string;
}

type Disabled = { ok: false; reason: "disabled" };
const disabled = (deps: SavedEnvDeps): Disabled | undefined => (deps.session.config.enabled ? undefined : { ok: false, reason: "disabled" });
const iso = (ms: number): string => new Date(ms).toISOString();
const keepOf = (value: number): number => Math.min(SAVED_ENV_KEEP_MAX, Math.max(SAVED_ENV_KEEP_MIN, Number.isInteger(value) ? value : SAVED_ENV_KEEP_DEFAULT));
const token = (deps: SavedEnvDeps): string => (deps.random ?? (() => randomBytes(24).toString("hex")))();

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const blank = (orgId: string, projectId: string): SavedEnvState => ({ orgId, projectId, version: 0, enabled: true, images: [], health: "never_proved" });
const audit = (deps: SavedEnvDeps, state: Pick<SavedEnvState, "orgId" | "projectId">, action: SavedEnvAuditEntry["action"], extra: Partial<SavedEnvAuditEntry> = {}): SavedEnvAuditEntry => ({ action, orgId: state.orgId, projectId: state.projectId, at: iso(deps.now()), ...extra });

/** Commits `next` over `prior` (null: first write). Returns the committed state, or undefined when the row changed meanwhile. */
async function commit(deps: SavedEnvDeps, prior: SavedEnvState | undefined, next: SavedEnvState, entry: SavedEnvAuditEntry): Promise<SavedEnvState | undefined> {
  const written = { ...next, version: (prior?.version ?? 0) + 1 };
  return (await deps.store.commit(written, prior === undefined ? null : prior.version, entry)) ? written : undefined;
}

// ---- when to rebuild

export interface RebuildInput {
  now: number;
  image: SavedEnvImageRecord | undefined;
  approved: ApprovedPin | undefined;
  currentKey: string | undefined;
  resetRequested: boolean;
}

/**
 * Why the project needs a rebuild, or undefined. Pure. The newest image counts only while it is `ready`. A key that cannot be worked out (undefined) decides nothing about the key; a missing approved environment
 * decides everything: no rebuild.
 */
export function rebuildReason(input: RebuildInput): RebuildReason | undefined {
  if (input.approved === undefined) return undefined;
  if (input.resetRequested) return "reset";
  const image = input.image;
  if (image === undefined) return "no_image";
  if (image.status === "stale") return "stale";
  if (image.manifest.testEnvRevision !== input.approved.revision) return "key_changed";
  if (input.currentKey !== undefined && image.manifest.environmentKey !== input.currentKey) return "key_changed";
  if (input.now - Date.parse(image.recordedAt) > SAVED_ENV_MAX_AGE_DAYS * DAY_MS) return "max_age";
  return undefined;
}

/** Whether the repository has been idle long enough to be saved as a clone only: no image is built, and its setup runs when a task first needs it. */
export function lightSetup(state: Pick<SavedEnvState, "lastPushAt" | "lastTaskAt">, nowMs: number, idleDays: number = SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT): boolean {
  const latest = Math.max(Date.parse(state.lastPushAt ?? "") || 0, Date.parse(state.lastTaskAt ?? "") || 0);
  return latest > 0 && nowMs - latest > idleDays * DAY_MS;
}

export type CheckResult =
  | { ok: true; queued: false; why: "no_change" | "in_flight" | "archived" | "idle" | "no_approved" | "backoff" | "off_for_project" }
  | { ok: true; queued: true; job: Pick<RebuildJob, "jobId" | "reason" | "approved"> }
  | { ok: false; reason: "disabled" | "stale_write" };

/**
 * Called on a default branch push, before each nightly, and by the poll. Records the activity (`push`) and, if a rebuild is due and none is in flight, queues one. Idempotent: a second call while a job is
 * queued or running changes nothing but the activity time.
 */
export async function checkRebuild(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, trigger: "push" | "nightly" | "poll" | "task"): Promise<CheckResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const prior = await deps.store.get(ids.orgId, ids.projectId);
  const base = prior ?? blank(ids.orgId, ids.projectId);
  const now = deps.now();
  const touched: SavedEnvState = { ...base, ...(trigger === "push" ? { lastPushAt: iso(now) } : {}), ...(trigger === "task" ? { lastTaskAt: iso(now) } : {}) };
  const stay = async (why: Extract<CheckResult, { queued: false; ok: true }>["why"]): Promise<CheckResult> => {
    // Activity is recorded even when nothing is queued (the idle test reads it); a lost race is not an error here.
    if (trigger === "push" || trigger === "task") await commit(deps, prior, touched, audit(deps, base, "activity", { reason: trigger })).catch(() => undefined);
    return { ok: true, queued: false, why };
  };
  if (base.deleted === true || base.archived === true) return stay("archived");
  if (!base.enabled) return stay("off_for_project");
  const approved = await deps.approved(ids.orgId, ids.projectId);
  if (approved === undefined) return stay("no_approved");
  if (base.job !== undefined && Date.parse(base.job.leaseUntil) > now) return stay("in_flight");
  const idleDays = (await deps.lightAfterIdleDays?.(ids.orgId, ids.projectId)) ?? SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT;
  if (base.resetRequested !== true && base.images.length === 0 && lightSetup(base, now, idleDays) && trigger !== "push" && trigger !== "task") return stay("idle");
  if (base.resetRequested !== true && base.lastFailureAt !== undefined && now - Date.parse(base.lastFailureAt) < SAVED_ENV_FAILURE_BACKOFF_MS) return stay("backoff");
  const currentKey = await deps.currentKey(ids.orgId, ids.projectId).catch(() => undefined);
  const reason = rebuildReason({ now, image: base.images[0], approved, currentKey, resetRequested: base.resetRequested === true });
  if (reason === undefined) return stay("no_change");
  if (lightSetup(base, now, idleDays) && reason !== "reset" && trigger !== "push") return stay("idle");
  const job: RebuildJob = { jobId: token(deps).slice(0, 24), leaseToken: token(deps), reason, approved, createdAt: iso(now), leaseUntil: iso(now + SAVED_ENV_JOB_LEASE_MS) };
  const written = await commit(deps, prior, { ...touched, job, resetRequested: false, lastRebuildReason: reason }, audit(deps, base, "rebuild_queued", { reason }));
  return written === undefined ? { ok: false, reason: "stale_write" } : { ok: true, queued: true, job: { jobId: job.jobId, reason, approved } };
}

/** A maintainer pressed Reset: a rebuild is queued now (a fresh backoff does not apply). The caller has checked the maintainer's right. */
export async function requestReset(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }): Promise<CheckResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const prior = await deps.store.get(ids.orgId, ids.projectId);
  const written = await commit(deps, prior, { ...(prior ?? blank(ids.orgId, ids.projectId)), resetRequested: true }, audit(deps, ids, "reset_requested"));
  if (written === undefined) return { ok: false, reason: "stale_write" };
  return checkRebuild(deps, ids, "poll");
}

// ---- the job's lease

export type LeaseResult = { ok: true; job: RebuildJob; state: SavedEnvState } | { ok: false; reason: "disabled" | "no_job" | "bad_lease" | "expired" };

/**
 * Whether `jobId` and `leaseToken` are the lease of the project's current rebuild job. The push login route and the result route both call this FIRST: no other caller (a task, the setup agent, a person) holds a
 * lease, so none of them can ask for a push login or record an image.
 */
export async function authorizeLease(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, lease: { jobId: string; leaseToken: string }): Promise<LeaseResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const state = await deps.store.get(ids.orgId, ids.projectId);
  const job = state?.job;
  if (state === undefined || job === undefined) return { ok: false, reason: "no_job" };
  if (!sameToken(job.jobId, lease.jobId) || !sameToken(job.leaseToken, lease.leaseToken)) return { ok: false, reason: "bad_lease" };
  if (Date.parse(job.leaseUntil) <= deps.now()) return { ok: false, reason: "expired" };
  return { ok: true, job, state };
}

// ---- recording a build

export type RecordRefusal = "disabled" | "no_job" | "bad_lease" | "expired" | "build_failed" | "not_approved" | "wrong_commits" | "wrong_manifest" | "repository_mismatch" | "stale_write" | "bad_result";
export type RecordResult = { ok: true; image: SavedEnvImageRecord; deleted: number } | { ok: false; reason: RecordRefusal };

export async function recordBuild(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, input: { jobId: string; leaseToken: string; result: unknown }): Promise<RecordResult> {
  const leased = await authorizeLease(deps, ids, input);
  if (!leased.ok) return leased;
  const { job, state } = leased;
  const parsed = SavedEnvBuildResultSchema.safeParse(input.result);
  if (!parsed.success) return { ok: false, reason: "bad_result" };
  const result: SavedEnvBuildResult = parsed.data;
  if (!result.ok) {
    await commit(deps, state, { ...state, job: undefined, health: "needs_repair", lastFailureAt: iso(deps.now()), lastFailure: result.reason }, audit(deps, state, "build_failed", { reason: result.reason }));
    return { ok: false, reason: "build_failed" };
  }
  const refuse = async (reason: RecordRefusal): Promise<RecordResult> => {
    await commit(deps, state, { ...state, job: undefined, lastFailureAt: iso(deps.now()), lastFailure: reason, health: "needs_repair" }, audit(deps, state, "build_refused", { reason, digest: result.imageDigest }));
    return { ok: false, reason };
  };
  // the environment the job was queued for is still the newest approved one
  const approved = await deps.approved(ids.orgId, ids.projectId);
  if (approved === undefined || approved.revision !== job.approved.revision || approved.digest !== job.approved.digest) return refuse("not_approved");
  // the manifest says what the job asked for, and the commits are the code host's default branch heads
  if (result.manifest.testEnvRevision !== job.approved.revision || result.manifest.imageDigest !== result.imageDigest) return refuse("wrong_manifest");
  const heads = await deps.defaultHeads(ids.orgId, ids.projectId);
  if (heads === undefined || result.manifest.commits.length !== heads.size || result.manifest.commits.some((commitEntry) => heads.get(commitEntry.repositoryId) !== commitEntry.sha)) return refuse("wrong_commits");
  // the repository in the registry is the one the creation template made (checked now, after the push)
  const verified = await verifyRepository(deps.session.config, deps.session.ports, ids);
  if (!verified.ok || verified.state !== "matches") return refuse("repository_mismatch");

  const image: SavedEnvImageRecord = { digest: result.imageDigest, tag: result.tag, manifest: result.manifest, recordedAt: iso(deps.now()), status: "ready" };
  const keep = keepOf(await deps.keep(ids.orgId).catch(() => SAVED_ENV_KEEP_DEFAULT));
  const images = [image, ...state.images.filter((known) => known.digest !== image.digest)].slice(0, keep);
  const written = await commit(deps, state, { ...state, images, job: undefined, health: "healthy", lastFailure: undefined, lastFailureAt: undefined }, audit(deps, state, "build_recorded", { digest: image.digest, reason: job.reason }));
  if (written === undefined) return { ok: false, reason: "stale_write" };
  // best effort from here: the image is recorded; a failed scan or walk is retried by the next walk
  const scanned = await startScan(deps, ids, image.digest);
  const walked = await walk(deps, ids);
  void scanned;
  return { ok: true, image: scanned ? { ...image, scanStartedAt: iso(deps.now()) } : image, deleted: walked.ok ? walked.deleted : 0 };
}

async function startScan(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, digest: string): Promise<boolean> {
  const scan = await mintScanSession(deps.session.config, deps.session.ports, ids);
  if (!scan.ok) return false;
  try { await deps.registry.startScan(scan.credentials, scan.repository, digest); } catch { return false; }
  return true;
}

// ---- failure, staleness

/** A build that could not finish (the worker reports a fixed word). The project's health says "needs repair"; the next automatic try waits out the backoff. */
export async function reportFailure(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, input: { jobId: string; leaseToken: string; reason: string }): Promise<{ ok: boolean }> {
  const leased = await authorizeLease(deps, ids, input);
  if (!leased.ok) return { ok: false };
  const reason = input.reason.replace(/[^a-z_]/gu, "").slice(0, 40);
  const written = await commit(deps, leased.state, { ...leased.state, job: undefined, health: "needs_repair", lastFailureAt: iso(deps.now()), lastFailure: reason }, audit(deps, leased.state, "build_failed", { reason }));
  return { ok: written !== undefined };
}

/**
 * A task fell back from the image at `step` (SH23's `onFallback`): the image is marked stale and a rebuild is queued. A task is never blocked: this only makes the next one better. The digest names which
 * image the task used, so a report about an older one does not stale the newest.
 */
export async function markStale(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, input: { digest: string; step: string }): Promise<{ ok: boolean }> {
  if (disabled(deps) !== undefined) return { ok: false };
  const state = await deps.store.get(ids.orgId, ids.projectId);
  if (state === undefined) return { ok: false };
  const at = state.images.findIndex((image) => image.digest === input.digest);
  if (at < 0) return { ok: true };
  const images = state.images.map((image, index) => (index === at ? { ...image, status: "stale" as const, staleStep: input.step.replace(/[^a-z_]/gu, "").slice(0, 20) } : image));
  const written = await commit(deps, state, { ...state, images }, audit(deps, state, "marked_stale", { digest: input.digest, reason: input.step }));
  if (written === undefined) return { ok: false };
  await checkRebuild(deps, ids, "poll");
  return { ok: true };
}

// ---- what a task may use

export type TaskImage = { digest: string; environmentKey: string; testEnvRevision: number };

/**
 * The image a task pinned to `taskPin` may use: the newest image that is `ready`, built at that very revision, not older than the max age. The caller (SH25) puts its digest in the prepare payload and mints the
 * pull login. Undefined: the task sets up fresh, as before.
 */
export function imageForTask(state: SavedEnvState | undefined, taskPin: ApprovedPin, nowMs: number): TaskImage | undefined {
  if (state === undefined || !state.enabled || state.deleted === true) return undefined;
  const image = state.images[0];
  if (image === undefined || image.status !== "ready") return undefined;
  if (image.manifest.testEnvRevision !== taskPin.revision) return undefined;
  if (nowMs - Date.parse(image.recordedAt) > (SAVED_ENV_MAX_AGE_DAYS + 1) * DAY_MS) return undefined;
  return { digest: image.digest, environmentKey: image.manifest.environmentKey, testEnvRevision: image.manifest.testEnvRevision };
}

// ---- the manage walk, archive and delete

export type WalkResult = { ok: true; deleted: number } | { ok: false; reason: "disabled" | "unavailable" | "stale_write" };

/**
 * Brings the registry in line with the row: images beyond the company's `keep`, images pushed more than 30 days ago (`SAVED_ENV_IMAGE_CEILING_DAYS`, which ECR's lifecycle cannot express), and untagged images are
 * deleted; a recorded image the registry no longer holds is dropped from the row. Uses a manage session of the broker's own.
 */
export async function walk(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }): Promise<WalkResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const state = await deps.store.get(ids.orgId, ids.projectId);
  if (state === undefined) return { ok: true, deleted: 0 };
  const manage = await mintManageSession(deps.session.config, deps.session.ports, ids);
  if (!manage.ok) return { ok: false, reason: "unavailable" };
  let listed: RegistryImage[];
  try { listed = await deps.registry.listImages(manage.credentials, manage.repository); } catch { return { ok: false, reason: "unavailable" }; }
  const now = deps.now();
  const keep = keepOf(await deps.keep(ids.orgId).catch(() => SAVED_ENV_KEEP_DEFAULT));
  const newestFirst = [...listed].sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
  const doomed = new Set<string>();
  newestFirst.forEach((image, index) => {
    if (image.tags.length === 0 && now - Date.parse(image.pushedAt) > DAY_MS) doomed.add(image.digest);
    else if (index >= keep) doomed.add(image.digest);
    else if (now - Date.parse(image.pushedAt) > SAVED_ENV_IMAGE_CEILING_DAYS * DAY_MS) doomed.add(image.digest);
  });
  if (doomed.size > 0) {
    try { await deps.registry.batchDelete(manage.credentials, manage.repository, [...doomed]); } catch { return { ok: false, reason: "unavailable" }; }
  }
  const held = new Set(newestFirst.map((image) => image.digest).filter((digest) => !doomed.has(digest)));
  // An image recorded in the last few minutes stays even if the registry's list does not show it yet (listing is not instantly consistent): dropping it would queue a rebuild of what was just built.
  const images = state.images.filter((image) => held.has(image.digest) || (!doomed.has(image.digest) && now - Date.parse(image.recordedAt) < RECORD_GRACE_MS));
  if (images.length === state.images.length) return { ok: true, deleted: doomed.size };
  const written = await commit(deps, state, { ...state, images, health: images.length === 0 && state.health === "healthy" ? "needs_repair" : state.health }, audit(deps, state, "ceiling_walk", { count: doomed.size }));
  return written === undefined ? { ok: false, reason: "stale_write" } : { ok: true, deleted: doomed.size };
}

/** Why an archived project keeps its images (recorded here so the decision is read in one place). */
export const ARCHIVE_POLICY = "An archived project keeps its saved images until the age ceiling deletes them, so an unarchive needs no rebuild; it queues no rebuild and mints no login. Only a delete removes them at once." as const;

export async function onProjectArchived(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, archived: boolean): Promise<{ ok: boolean }> {
  if (disabled(deps) !== undefined) return { ok: false };
  const state = await deps.store.get(ids.orgId, ids.projectId);
  if (state === undefined) return { ok: true };
  const written = await commit(deps, state, { ...state, archived, ...(archived ? { job: undefined } : {}) }, audit(deps, state, "project_archived", { reason: archived ? "archived" : "unarchived" }));
  return { ok: written !== undefined };
}

/**
 * A project was deleted: every image and the repository are deleted with a manage session, then the row is marked deleted. If the registry cannot be reached the row says so and the caller retries; nothing is
 * reported deleted that was not.
 */
export async function onProjectDeleted(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }): Promise<{ ok: true; deleted: number } | { ok: false; reason: "disabled" | "unavailable" }> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const manage = await mintManageSession(deps.session.config, deps.session.ports, ids);
  if (!manage.ok) return { ok: false, reason: "unavailable" };
  let count: number;
  try {
    const images = await deps.registry.listImages(manage.credentials, manage.repository);
    count = images.length;
    if (images.length > 0) await deps.registry.batchDelete(manage.credentials, manage.repository, images.map((image) => image.digest));
    await deps.registry.deleteRepository(manage.credentials, manage.repository);
  } catch { return { ok: false, reason: "unavailable" }; }
  const state = await deps.store.get(ids.orgId, ids.projectId);
  if (state !== undefined) await commit(deps, state, { ...state, images: [], job: undefined, deleted: true, health: "never_proved" }, audit(deps, state, "project_deleted", { count }));
  return { ok: true, deleted: count };
}
