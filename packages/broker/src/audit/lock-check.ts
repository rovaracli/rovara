// Object Lock enforcement and drift (Task 9 of the Audit Ledger plan). The anchor writes objects that are only worth
// something while they stay locked, so every run asks the bucket what it really is, and every object is read back before its
// org is finalized.
//
//  - `lockFloor` is the weakest lock this install may run with. It is in code, from the environment's NAME and the lock
//    profile the stack was deployed with, never from the deploy values (those can be edited by a raw CloudFormation update).
//    The ratchet makes the floor one-way: the first time the bucket's default retention is seen in COMPLIANCE mode, a marker
//    is written to the seals table (`AUDIT_LOCK / RATCHET`, with the floor's days, the bucket's name and the time). It is
//    written with `attribute_not_exists` and never again: the anchor's role holds GetItem and PutItem on that key and no
//    UpdateItem or DeleteItem, and the code has no other write to it. ANY item at that key counts as ratcheted (a marker that
//    is corrupted or rewritten fails closed). From then on the floor is COMPLIANCE for at least the recorded days whatever the
//    profile parameter or the environment's name says, and a marker that names another bucket than the configured one blocks.
//  - `checkLockDrift` (each run) reads the bucket's default retention, its versioning and its policy. A default retention
//    below the floor, or versioning that is not Enabled, blocks the run (`ok: false`). A default retention that differs from
//    the deployed mode and days while still meeting the floor, and a policy whose hash differs from the synthesized one,
//    are logged but do not block: the first is a console edit that did not weaken anything past the floor, the second can
//    be a different serialization of the same policy and must never stop the ledger by itself.
//  - `enforceObjectLock` reads each object back with HeadObject by its version id and compares mode and retain-until date
//    with the floor.
//  - `sweepSealedVersions` lists the versions of a slice of sealed keys each run (cycling through the SEALS# index items) and
//    logs `audit.version_drift` for a delete marker, a second version, or a version that is not the one recorded.
// Every mismatch is logged as `audit.lock_config_mismatch` (or `audit.version_drift`) with the expected and the actual value;
// the audit-lock-drift alarm counts both.
import { createHash } from "node:crypto";
import {
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AUDIT_GOVERNANCE_RETENTION_DAYS, AUDIT_RETENTION_DAYS_MIN_COMPLIANCE, AUDIT_VERSION_SWEEP_KEYS_PER_RUN, type LockedObjectV1 } from "@agentx/cloud-contracts";
import { canonicalJson } from "@rovara-code/contracts";

export type LockMode = "COMPLIANCE" | "GOVERNANCE";
export type AuditLockProfileName = "production" | "trial";

export interface LockFloor {
  mode: LockMode;
  days: number;
}

const DAY_MS = 86_400_000;
/** Objects are read this many at a time. */
const CHECK_CONCURRENCY = 20;
/** Enough of a key's listing to see two versions or a marker (the key itself sorts before any longer key with its prefix). */
const SWEEP_LIST_KEYS = 3;
/** Sorts after every sort key of the SEALS# index (twelve digits). */
const AFTER_ALL_SEALS = "~";

/** Where the ratchet and the sweep's cursor live in the seals table. */
const LOCK_PARTITION = "AUDIT_LOCK";
const RATCHET_SORT_KEY = "RATCHET";
/** The sweep's cursor has a partition of its own: the anchor's role may only read and create the ratchet's (`AUDIT_LOCK`), and moves this one. */
const SWEEP_PARTITION = "AUDIT_SWEEP";
const SWEEP_SORT_KEY = "CURSOR";

/** Only these environments may run in governance mode for a short time: `staging`, `test`, `dev` and `dev-<suffix>`. Every other name is a real install. */
const TEST_NAME = /^(?:staging|test|dev|dev-.+)$/;
function isTestName(envName: string): boolean {
  return TEST_NAME.test(envName);
}

/**
 * The weakest lock this install may run with. `staging`, `test`, `dev` and `dev-<suffix>` run governance for one day
 * whatever the profile says. Any other name runs compliance for 365 days, unless it was deployed with the `trial` profile
 * (a trial install created from a published template), which runs governance for one day. Once the ratchet is set (the
 * bucket has been seen in compliance mode) the floor is compliance whatever the profile says, for the days the ratchet
 * recorded (`ratchetDays`) or the name's own days if that is more: renaming the environment never lowers it.
 */
export function lockFloor(envName: string, profile: AuditLockProfileName = "production", ratcheted = false, ratchetDays?: number): LockFloor {
  if (ratcheted) {
    const ofName = isTestName(envName) ? AUDIT_GOVERNANCE_RETENTION_DAYS : AUDIT_RETENTION_DAYS_MIN_COMPLIANCE;
    const recorded = typeof ratchetDays === "number" && Number.isFinite(ratchetDays) && ratchetDays > 0 ? ratchetDays : 0;
    return { mode: "COMPLIANCE", days: Math.max(ofName, recorded) };
  }
  if (isTestName(envName) || profile === "trial") return { mode: "GOVERNANCE", days: AUDIT_GOVERNANCE_RETENTION_DAYS };
  return { mode: "COMPLIANCE", days: AUDIT_RETENTION_DAYS_MIN_COMPLIANCE };
}

/** What every object written before the ratchet was held to: only a trial install or a test name can have written one. */
const PRE_RATCHET_FLOOR: LockFloor = { mode: "GOVERNANCE", days: AUDIT_GOVERNANCE_RETENTION_DAYS };
/**
 * An object counts as written before the ratchet only when its LastModified is this far before the ratchet's time. S3 reports
 * whole seconds, and the anchor writes the ratchet before any object of its run, so an object of the run that set the ratchet
 * never falls in this margin by mistake.
 */
const RATCHET_GRACE_MS = 5_000;

/** What the stack deployed, as environment variables of the anchor. Nothing here lowers the floor (`lockFloor` decides that). */
export interface LockSettings {
  envName: string;
  profile: AuditLockProfileName;
  /** The default retention the stack set on the bucket. */
  deployed: LockFloor;
  /** SHA-256 (hex) of the canonical bucket policy document with the placeholders, as synthesized for the chosen profile. */
  bucketPolicySha256: string;
  partition: string;
  accountId: string;
  region: string;
}

export interface LockCheckDeps {
  documentClient: DynamoDBDocumentClient;
  ledgerTable: string;
  sealsTable: string;
  s3: Pick<S3Client, "send">;
  bucket: string;
  log: (entry: Record<string, unknown>) => void;
  lock: LockSettings;
  /** How many sealed keys one sweep looks at. Defaults to AUDIT_VERSION_SWEEP_KEYS_PER_RUN. */
  sweepKeysPerRun?: number;
}

function variable(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") throw new Error(`audit anchor: ${name} is missing`);
  return value.trim();
}

/** The lock settings from the function's environment. A missing or malformed value stops the function from starting: it never runs without a check. */
export function lockSettingsFromEnvironment(environment: Record<string, string | undefined>): LockSettings {
  const profile = variable(environment, "AUDIT_LOCK_PROFILE");
  if (profile !== "production" && profile !== "trial") throw new Error("audit anchor: AUDIT_LOCK_PROFILE must be production or trial");
  const mode = variable(environment, "AUDIT_LOCK_MODE");
  if (mode !== "COMPLIANCE" && mode !== "GOVERNANCE") throw new Error("audit anchor: AUDIT_LOCK_MODE must be COMPLIANCE or GOVERNANCE");
  const days = variable(environment, "AUDIT_RETENTION_DAYS");
  if (!/^[1-9]\d{0,5}$/.test(days)) throw new Error("audit anchor: AUDIT_RETENTION_DAYS must be a whole number of days");
  const hash = variable(environment, "AUDIT_BUCKET_POLICY_SHA256");
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("audit anchor: AUDIT_BUCKET_POLICY_SHA256 must be a SHA-256 in hex");
  const accountId = variable(environment, "AUDIT_ACCOUNT_ID");
  if (!/^\d{12}$/.test(accountId)) throw new Error("audit anchor: AUDIT_ACCOUNT_ID must be a 12-digit account id");
  return {
    envName: variable(environment, "AUDIT_ENV_NAME"),
    profile,
    deployed: { mode, days: Number(days) },
    bucketPolicySha256: hash,
    partition: variable(environment, "AUDIT_PARTITION"),
    accountId,
    region: variable(environment, "AWS_REGION"),
  };
}

// ---- the bucket policy hash ---------------------------------------------------------------------------------------

export interface PolicyContext {
  envName: string;
  partition: string;
  accountId: string;
  region: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
/** CDK writes a one-element list as the element itself; S3 may store either. */
const scalarOfOne = (value: unknown): unknown => (Array.isArray(value) && value.length === 1 ? value[0] : value);

function placeholders(value: unknown, context: PolicyContext): unknown {
  if (Array.isArray(value)) return value.map((entry) => placeholders(entry, context));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, placeholders(entry, context)]));
  if (typeof value !== "string") return value;
  return value
    .replaceAll(`arn:${context.partition}:`, "arn:{{partition}}:")
    .replaceAll(`agentx-${context.envName}-`, "agentx-{{env}}-")
    .replaceAll(context.accountId, "{{account}}")
    .replaceAll(context.region, "{{region}}");
}

function normalizeStatement(statement: unknown): unknown {
  if (!isObject(statement)) return statement;
  const next: Json = { ...statement };
  if (next.Principal === "*") next.Principal = { AWS: "*" };
  else if (isObject(next.Principal)) next.Principal = Object.fromEntries(Object.entries(next.Principal).map(([kind, value]) => [kind, scalarOfOne(value)]));
  for (const field of ["Action", "NotAction", "Resource", "NotResource"]) {
    if (next[field] !== undefined) next[field] = scalarOfOne(next[field]);
  }
  if (isObject(next.Condition)) {
    next.Condition = Object.fromEntries(Object.entries(next.Condition).map(([operator, keys]) => [
      operator,
      isObject(keys) ? Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, scalarOfOne(value)])) : keys,
    ]));
  }
  return next;
}

/**
 * The live policy document in the form the synthesized hash is taken over: `"*"` principals as `{ "AWS": "*" }`, one-element
 * lists as the element, and this deployment's partition, account, region and environment name replaced by `{{partition}}`,
 * `{{account}}`, `{{region}}` and `{{env}}` (the synthesis cannot know them; the environment name is replaced too so a
 * published template, synthesized for a placeholder name, still matches once it is rendered for a real one).
 */
export function normalizeBucketPolicy(policyText: string, context: PolicyContext): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(policyText);
  } catch {
    throw new Error("audit anchor: the bucket policy is not a JSON policy document");
  }
  if (!isObject(parsed) || parsed.Statement === undefined) throw new Error("audit anchor: the bucket policy is not a policy document");
  const statements = Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement];
  return placeholders({ ...parsed, Statement: statements.map(normalizeStatement) }, context) as Json;
}

/** SHA-256 (hex) of the canonical normalized policy document (the same canonical JSON the synthesis hashes): compared with the synthesized `bucketPolicySha256`. */
export function bucketPolicyHash(policyText: string, context: PolicyContext): string {
  return createHash("sha256").update(canonicalJson(normalizeBucketPolicy(policyText, context)), "utf8").digest("hex");
}

// ---- helpers ------------------------------------------------------------------------------------------------------

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

const rank = (mode: LockMode): number => (mode === "COMPLIANCE" ? 1 : 0);

/** Compliance is stronger than governance, and more days are stronger than fewer. */
function meetsFloor(actual: { mode: LockMode; days: number }, floor: LockFloor): boolean {
  return rank(actual.mode) >= rank(floor.mode) && actual.days >= floor.days;
}

function mismatch(deps: LockCheckDeps, check: string, expected: unknown, actual: unknown, extra: Record<string, unknown> = {}): void {
  deps.log({ event: "audit.lock_config_mismatch", level: "error", check, expected, actual, ...extra });
}

// ---- the ratchet --------------------------------------------------------------------------------------------------

/** What the ratchet item says. Its existence is the ratchet: every field is only read for what it adds. */
interface Ratchet {
  /** The floor's days when it was set; undefined when the item has no usable number. */
  days: number | undefined;
  /** The bucket it was set for; undefined when the item does not name one. */
  bucket: string | undefined;
  /** When it was set (ms); undefined when the item has no usable time. */
  sinceMs: number | undefined;
}

function ratchetOf(item: Record<string, unknown>): Ratchet {
  const since = typeof item.since === "string" ? Date.parse(item.since) : Number.NaN;
  return {
    days: typeof item.days === "number" && Number.isFinite(item.days) && item.days > 0 ? item.days : undefined,
    bucket: typeof item.bucket === "string" ? item.bucket : undefined,
    sinceMs: Number.isNaN(since) ? undefined : since,
  };
}

/** Any item at the key is a ratchet, whatever its `mode` says: a marker that was corrupted or rewritten must not read as "not ratcheted". */
async function readRatchet(deps: LockCheckDeps): Promise<Ratchet | undefined> {
  const out = await deps.documentClient.send(new GetCommand({ TableName: deps.sealsTable, Key: { pk: LOCK_PARTITION, sk: RATCHET_SORT_KEY }, ConsistentRead: true }));
  return out.Item === undefined ? undefined : ratchetOf(out.Item);
}

/**
 * Create-only (`attribute_not_exists`): the one write the anchor ever makes to the ratchet. There is no update and no
 * overwrite, and its role has no UpdateItem or DeleteItem on this key. Returns the ratchet that stands afterwards: this one,
 * or the one another run set first.
 */
async function setRatchet(deps: LockCheckDeps, now: number): Promise<Ratchet> {
  const floor = lockFloor(deps.lock.envName, deps.lock.profile, true);
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.sealsTable,
      Item: { pk: LOCK_PARTITION, sk: RATCHET_SORT_KEY, mode: "COMPLIANCE", days: floor.days, bucket: deps.bucket, since: new Date(now).toISOString() },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return { days: floor.days, bucket: deps.bucket, sinceMs: now };
  } catch (error) {
    // Another run (or an earlier one) set it first: that one stands.
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    return (await readRatchet(deps)) ?? { days: floor.days, bucket: deps.bucket, sinceMs: now };
  }
}

function floorOf(deps: LockCheckDeps, ratchet: Ratchet | undefined): LockFloor {
  return lockFloor(deps.lock.envName, deps.lock.profile, ratchet !== undefined, ratchet?.days);
}

/** The floor in force now (the environment's name, the deployed profile and the ratchet), and when the ratchet was set. */
export async function currentLockState(deps: LockCheckDeps): Promise<{ floor: LockFloor; ratchetSince: number | undefined }> {
  const ratchet = await readRatchet(deps);
  return { floor: floorOf(deps, ratchet), ratchetSince: ratchet?.sinceMs };
}

/** The floor in force now. */
export async function currentFloor(deps: LockCheckDeps): Promise<LockFloor> {
  return (await currentLockState(deps)).floor;
}

// ---- the drift check ----------------------------------------------------------------------------------------------

export interface LockStatus {
  /** False when the bucket's default retention is below the floor or its versioning is not Enabled: nothing may be finalized. */
  ok: boolean;
  floor: LockFloor;
  ratcheted: boolean;
}

interface BucketRetention { mode: LockMode; days: number }

async function readDefaultRetention(deps: LockCheckDeps): Promise<BucketRetention | undefined> {
  let out;
  try {
    out = await deps.s3.send(new GetObjectLockConfigurationCommand({ Bucket: deps.bucket }));
  } catch (error) {
    if (errorName(error) === "ObjectLockConfigurationNotFoundError") return undefined;
    throw error;
  }
  const configuration = out.ObjectLockConfiguration;
  const retention = configuration?.Rule?.DefaultRetention;
  if (configuration?.ObjectLockEnabled !== "Enabled" || retention?.Mode === undefined) return undefined;
  const days = retention.Days ?? (retention.Years === undefined ? 0 : retention.Years * 365);
  return { mode: retention.Mode, days };
}

async function readPolicyHash(deps: LockCheckDeps): Promise<string> {
  let text: string | undefined;
  try {
    text = (await deps.s3.send(new GetBucketPolicyCommand({ Bucket: deps.bucket }))).Policy;
  } catch (error) {
    if (errorName(error) === "NoSuchBucketPolicy") return "none";
    throw error;
  }
  if (text === undefined) return "none";
  const { envName, partition, accountId, region } = deps.lock;
  try {
    return bucketPolicyHash(text, { envName, partition, accountId, region });
  } catch {
    return "unreadable";
  }
}

/**
 * Each run. Sets the ratchet when the bucket is seen in compliance mode, then compares the bucket with the floor, with the
 * deployed values, and with the synthesized policy hash. Every difference is logged with both values. A check that cannot
 * be made (an error other than "this is not configured") is thrown, never read as a pass.
 */
export async function checkLockDrift(deps: LockCheckDeps, now: number): Promise<LockStatus> {
  let ratchet = await readRatchet(deps);
  const retention = await readDefaultRetention(deps);
  if (retention?.mode === "COMPLIANCE" && ratchet === undefined) ratchet = await setRatchet(deps, now);
  const ratcheted = ratchet !== undefined;
  const floor = floorOf(deps, ratchet);
  let ok = true;

  // The ratchet belongs to one bucket. Another name (or none) is not this install's history: nothing is finalized until a person looks.
  if (ratchet !== undefined && ratchet.bucket !== deps.bucket) {
    ok = false;
    mismatch(deps, "ratchet_bucket", deps.bucket, ratchet.bucket ?? "none");
  }

  if (retention === undefined || !meetsFloor(retention, floor)) {
    ok = false;
    mismatch(deps, "default_retention_floor", floor, retention ?? "none");
  } else if (retention.mode !== deps.lock.deployed.mode || retention.days !== deps.lock.deployed.days) {
    // Still at or above the floor, so nothing is blocked; the deployed value is what the stack promised.
    mismatch(deps, "default_retention_deployed", deps.lock.deployed, retention);
  }

  const versioning = (await deps.s3.send(new GetBucketVersioningCommand({ Bucket: deps.bucket }))).Status;
  if (versioning !== "Enabled") {
    ok = false;
    mismatch(deps, "versioning", "Enabled", versioning ?? "none");
  }

  const actualHash = await readPolicyHash(deps);
  if (actualHash !== deps.lock.bucketPolicySha256) mismatch(deps, "bucket_policy", deps.lock.bucketPolicySha256, actualHash);

  return { ok, floor, ratcheted };
}

// ---- the objects --------------------------------------------------------------------------------------------------

export interface EnforceOptions {
  /** The floor to hold the objects to. Default: the floor in force now. */
  floor?: LockFloor;
  /**
   * When the ratchet was set (ms). An object whose LastModified is before it was written under the profile of that time (a trial
   * install that has since become production), so it is held to the trial floor it was written under, not to the ratchet's.
   * Default: when `floor` is not given, the ratchet's own time; when `floor` is given without it, no object is judged that way.
   */
  ratchetSince?: number | undefined;
  /** Added to every log entry (for example the org and the epoch). */
  context?: Record<string, unknown>;
}

function isMissing(error: unknown): boolean {
  return ["NotFound", "NoSuchKey", "NoSuchVersion"].includes(errorName(error)) || httpStatus(error) === 404;
}

type ObjectVerdict = { ok: true } | { ok: false; actual: unknown; expected: LockFloor };

async function checkObject(deps: LockCheckDeps, object: LockedObjectV1, floorNow: LockFloor, ratchetSince: number | undefined, now: number): Promise<ObjectVerdict> {
  let head;
  try {
    head = await deps.s3.send(new HeadObjectCommand({ Bucket: deps.bucket, Key: object.key, VersionId: object.versionId }));
  } catch (error) {
    if (isMissing(error)) return { ok: false, actual: "missing", expected: floorNow };
    throw error;
  }
  // An object written before the ratchet was set was written under the profile of that time: a trial install (or a test name)
  // that has since become production keeps the floor its open epoch was written under. Everything else is held to the floor now.
  const writtenAt = head.LastModified?.getTime();
  const beforeRatchet = ratchetSince !== undefined && writtenAt !== undefined && writtenAt + RATCHET_GRACE_MS < ratchetSince;
  const floor = beforeRatchet ? PRE_RATCHET_FLOOR : floorNow;
  const mode = head.ObjectLockMode;
  const until = head.ObjectLockRetainUntilDate;
  if ((mode !== "COMPLIANCE" && mode !== "GOVERNANCE") || until === undefined) return { ok: false, actual: { mode: mode ?? "none", retainUntil: null }, expected: floor };
  // The retention counts from when the object was locked (its LastModified), never from a later `now`: an epoch that was stopped
  // for days must still be finishable. One day of slack, as the brief allows.
  const lockedAt = Math.min(now, head.LastModified === undefined ? now : head.LastModified.getTime());
  const retainUntil = new Date(until).getTime();
  const fits = rank(mode) >= rank(floor.mode) && retainUntil >= lockedAt + (floor.days - 1) * DAY_MS;
  return fits ? { ok: true } : { ok: false, actual: { mode, retainUntil: new Date(retainUntil).toISOString() }, expected: floor };
}

/**
 * HeadObject each object by its version id: its mode must meet the floor and its retain-until date must be at least the
 * floor's days (less one) after it was locked. Each failure is logged as `audit.lock_config_mismatch` and the object is
 * returned in `failed`; the anchor does not finalize the org or epoch the object belongs to.
 */
export async function enforceObjectLock(deps: LockCheckDeps, objects: readonly LockedObjectV1[], now: number, options: EnforceOptions = {}): Promise<{ ok: boolean; failed: LockedObjectV1[] }> {
  let floor = options.floor;
  let ratchetSince = options.ratchetSince;
  if (floor === undefined) {
    const state = await currentLockState(deps);
    floor = state.floor;
    ratchetSince ??= state.ratchetSince;
  }
  const held = floor;
  const failed: LockedObjectV1[] = [];
  for (let offset = 0; offset < objects.length; offset += CHECK_CONCURRENCY) {
    const slice = objects.slice(offset, offset + CHECK_CONCURRENCY);
    const verdicts = await Promise.all(slice.map((object) => checkObject(deps, object, held, ratchetSince, now)));
    verdicts.forEach((verdict, index) => {
      if (verdict.ok) return;
      const object = slice[index]!;
      failed.push(object);
      mismatch(deps, "object", verdict.expected, verdict.actual, { key: object.key, versionId: object.versionId, ...(options.context ?? {}) });
    });
  }
  return { ok: failed.length === 0, failed };
}

// ---- the sweep ----------------------------------------------------------------------------------------------------

/** Where the sweep stopped: in the SEALS# index of `orgId`, after the item with sort key `after`. */
export interface SweepCursor {
  orgId: string;
  after: string;
}

export interface SweepResult {
  /** Sealed keys looked at in this run. */
  checked: number;
  drift: number;
  /** Where the next run continues; undefined once every org has been covered (the next run starts over). */
  next: SweepCursor | undefined;
}

type Item = Record<string, unknown>;

async function checkSealedKey(deps: LockCheckDeps, orgId: string, object: LockedObjectV1): Promise<boolean> {
  const out = await deps.s3.send(new ListObjectVersionsCommand({ Bucket: deps.bucket, Prefix: object.key, MaxKeys: SWEEP_LIST_KEYS }));
  const versions = (out.Versions ?? []).filter((version) => version.Key === object.key);
  const markers = (out.DeleteMarkers ?? []).filter((marker) => marker.Key === object.key);
  const reason = markers.length > 0 ? "delete_marker"
    : versions.length > 1 ? "extra_version"
      : versions.length === 0 ? "version_missing"
        : versions[0]!.VersionId !== object.versionId ? "version_replaced"
          : undefined;
  if (reason === undefined) return false;
  deps.log({ event: "audit.version_drift", level: "error", orgId, key: object.key, versionId: object.versionId, reason });
  return true;
}

/**
 * Looks at up to `AUDIT_VERSION_SWEEP_KEYS_PER_RUN` sealed keys, in the order of the orgs and of their SEALS# index items,
 * starting where `cursor` says. A key must hold exactly the version the index recorded: a delete marker, a second version,
 * another version or none is `audit.version_drift`. The sweep only reads, and logs.
 */
export async function sweepSealedVersions(deps: LockCheckDeps, cursor: SweepCursor | undefined): Promise<SweepResult> {
  const budget = deps.sweepKeysPerRun ?? AUDIT_VERSION_SWEEP_KEYS_PER_RUN;
  let checked = 0;
  let drift = 0;

  /** Sweeps an org's index from `after`. `last` is the sort key of the last item handled. */
  const sweepOrg = async (orgId: string, after: string | undefined): Promise<{ done: boolean; last: string | undefined }> => {
    let last = after;
    while (checked < budget) {
      const limit = Math.max(1, Math.ceil((budget - checked) / 2));
      const out = await deps.documentClient.send(new QueryCommand({
        TableName: deps.sealsTable,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `SEALS#${orgId}` },
        ConsistentRead: true,
        Limit: limit,
        ...(last === undefined ? {} : { ExclusiveStartKey: { pk: `SEALS#${orgId}`, sk: last } }),
      }));
      const items: Item[] = out.Items ?? [];
      const keys = items.flatMap((item) => {
        const objects = item.objects as { records?: LockedObjectV1; seal?: LockedObjectV1 } | undefined;
        return [objects?.records, objects?.seal].filter((object): object is LockedObjectV1 => object !== undefined);
      });
      for (let offset = 0; offset < keys.length; offset += CHECK_CONCURRENCY) {
        const found = await Promise.all(keys.slice(offset, offset + CHECK_CONCURRENCY).map((object) => checkSealedKey(deps, orgId, object)));
        drift += found.filter(Boolean).length;
      }
      checked += keys.length;
      if (items.length > 0) last = String(items[items.length - 1]!.sk);
      if (out.LastEvaluatedKey === undefined || items.length === 0) return { done: true, last };
    }
    return { done: false, last };
  };

  if (cursor !== undefined) {
    const resumed = await sweepOrg(cursor.orgId, cursor.after);
    if (!resumed.done || checked >= budget) return { checked, drift, next: { orgId: cursor.orgId, after: resumed.last ?? cursor.after } };
  }

  // The orgs after the cursor's, in order. An org without seals costs a query too, so the number of orgs a run looks at is capped as well.
  let after = cursor?.orgId;
  let examined = 0;
  for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.ledgerTable,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "AUDIT_ORGS" },
      ConsistentRead: true,
      Limit: Math.max(1, Math.min(budget, 100)),
      ...(after === undefined ? {} : { ExclusiveStartKey: { pk: "AUDIT_ORGS", sk: after } }),
    }));
    const orgs = (page.Items ?? []).map((item) => String(item.sk));
    for (const orgId of orgs) {
      const result = await sweepOrg(orgId, undefined);
      examined += 1;
      after = orgId;
      if (!result.done || checked >= budget) return { checked, drift, next: { orgId, after: result.last ?? AFTER_ALL_SEALS } };
      if (examined >= budget) return { checked, drift, next: { orgId, after: AFTER_ALL_SEALS } };
    }
    if (page.LastEvaluatedKey === undefined || orgs.length === 0) return { checked, drift, next: undefined };
  }
}

async function loadSweepCursor(deps: LockCheckDeps): Promise<SweepCursor | undefined> {
  const out = await deps.documentClient.send(new GetCommand({ TableName: deps.sealsTable, Key: { pk: SWEEP_PARTITION, sk: SWEEP_SORT_KEY }, ConsistentRead: true }));
  const item = out.Item;
  return typeof item?.orgId === "string" && typeof item.after === "string" ? { orgId: item.orgId, after: item.after } : undefined;
}

async function saveSweepCursor(deps: LockCheckDeps, cursor: SweepCursor | undefined, now: number): Promise<void> {
  await deps.documentClient.send(new PutCommand({
    TableName: deps.sealsTable,
    Item: { pk: SWEEP_PARTITION, sk: SWEEP_SORT_KEY, updatedAt: new Date(now).toISOString(), ...(cursor === undefined ? {} : { orgId: cursor.orgId, after: cursor.after }) },
  }));
}

/**
 * The checks of every run: the drift check, then the next slice of the sweep. Returns the drift check's verdict. The drift
 * check is fatal when it cannot be made (it is what lets anything be finalized). The sweep only detects: an error in it is
 * logged as `audit.lock_sweep_failed` (counted by the audit-lock-drift alarm) and the run goes on; the next run takes up the
 * same slice again.
 */
export async function runLockChecks(deps: LockCheckDeps, now: number): Promise<LockStatus> {
  const status = await checkLockDrift(deps, now);
  try {
    const result = await sweepSealedVersions(deps, await loadSweepCursor(deps));
    await saveSweepCursor(deps, result.next, now);
  } catch (error) {
    deps.log({ event: "audit.lock_sweep_failed", level: "error", error: errorName(error) });
  }
  return status;
}
