// Setup run limits, stored (sh-su-musts; design setup-test-health 3.2 and 11 `setupAgent.limits`): what a setup run may use (commands, tries of the same failing step, wall clock, model spend, new website asks).
//   - The DEFAULTS and the hard MAXIMA are the contract's (`SETUP_AGENT_LIMITS_DEFAULT`, `SETUP_AGENT_LIMITS_MAX`); `effectiveSetupAgentLimits` is the one rule that combines a project's setting with the company's lock
//     (the smaller of the two, never above the maximum, a damaged value is the default) and the start and the worker both use it. This file only STORES the two settings and says who may change them.
//   - The COMPANY's setting is a lock (SH29, `CompanySetupLocks.limits`): a company admin with a fresh browser sign-in sets it; making it stricter applies at once; LOOSENING it (a limit raised or removed) waits for a
//     second, different admin, or the sole-owner exception (`org/second-person-approval.ts`, audited `sole_owner_exception`), exactly as every lock does (owner decision 2026-11-01, "One-admin companies"). The lock
//     is stored by the locks store (`setup-locks-store.ts`) and decided by `org/setup-recipes.ts`; this file only maps its units (minutes and dollars) to the run's (minutes and cents).
//   - A PROJECT's setting is its maintainer's (`edit_settings`), from a browser session (never a token), audited. A project may only be STRICTER than the company's lock: a value above the lock is refused when it is
//     saved, and a lock that is lowered afterwards simply cuts it down when the run starts (never the other way). A project may set a limit above the default, up to the maximum, unless the lock is lower.
//   - Nothing here starts, changes or stops a run: a run keeps the limits it started with (setup-agent.ts).
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SETUP_AGENT_LIMIT_NAMES, SETUP_AGENT_LIMITS_DEFAULT, SETUP_AGENT_LIMITS_MAX, SetupAgentLimitSettingSchema, agentXError, canonicalJson, effectiveSetupAgentLimits, projectAllows, setupLimitsKey,
  type OrgId, type ProjectRole, type SetupAgentLimitSetting, type SetupAgentLimits,
} from "@agentx/contracts";
import { auditSetupLimitsChanged, auditOccurrence } from "../audit/events.js";
import { auditPending, type AuditRuntime } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { SETUP_LIMIT_MAXIMA, approveLocksChange, readCompanyLocks, setCompanyLocks, type CompanySetupLocks, type RecipeCaller, type SetupLocksDeps, type StoredLocks } from "../org/setup-recipes.js";
import { StatusReply } from "../aws/status-reply.js";
import type { DeveloperCaller } from "../aws/developer-routes/types.js";

type Client = { send(command: unknown): Promise<unknown> };

export const SETUP_LIMITS_WORDS = {
  browserOnly: "Change the setup limits from Rovara's web app: it needs a signed-in browser, not a token.",
  aboveLock: "That is more than the company allows for a setup run. Choose a smaller number, or ask a company admin to raise the company's limit.",
  stale: "The limits changed since you looked. Refresh and try again.",
  noPending: "There is no company limit change waiting for approval.",
} as const;

// ---- units: the lock counts minutes and dollars, a run counts minutes and cents

/** The company lock's limits as a run's setting (minutes, cents). A spend that is not a whole number of cents rounds DOWN (stricter). */
export function lockToRunSetting(locks: CompanySetupLocks | undefined): SetupAgentLimitSetting {
  const lock = locks?.limits;
  if (lock === undefined) return {};
  const whole = (value: number | undefined): number | undefined => (value === undefined ? undefined : Math.max(1, Math.floor(value)));
  const out: SetupAgentLimitSetting = {};
  if (lock.commands !== undefined) out.commands = whole(lock.commands)!;
  if (lock.sameStepTries !== undefined) out.sameStepTries = whole(lock.sameStepTries)!;
  if (lock.wallClockMinutes !== undefined) out.wallClockMin = whole(lock.wallClockMinutes)!;
  if (lock.spendUsd !== undefined) out.budgetCents = Math.max(1, Math.floor(lock.spendUsd * 100 + 1e-9));
  if (lock.hostAsks !== undefined) out.hostAsks = whole(lock.hostAsks)!;
  return out;
}

/** A run's setting as the lock's limits. The body must already be a valid `SetupAgentLimitSetting`. */
export function runSettingToLockLimits(setting: SetupAgentLimitSetting): NonNullable<CompanySetupLocks["limits"]> | undefined {
  const out: NonNullable<CompanySetupLocks["limits"]> = {};
  if (setting.commands !== undefined) out.commands = setting.commands;
  if (setting.sameStepTries !== undefined) out.sameStepTries = setting.sameStepTries;
  if (setting.wallClockMin !== undefined) out.wallClockMinutes = setting.wallClockMin;
  if (setting.budgetCents !== undefined) out.spendUsd = setting.budgetCents / 100;
  if (setting.hostAsks !== undefined) out.hostAsks = setting.hostAsks;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The lock's maxima and the run's maxima are the same numbers in different units; this is checked by a test so a change to one cannot leave the other behind. */
export const LOCK_MAXIMA_AS_RUN: SetupAgentLimits = {
  commands: SETUP_LIMIT_MAXIMA.commands, sameStepTries: SETUP_LIMIT_MAXIMA.sameStepTries, wallClockMin: SETUP_LIMIT_MAXIMA.wallClockMinutes, budgetCents: SETUP_LIMIT_MAXIMA.spendUsd * 100, hostAsks: SETUP_LIMIT_MAXIMA.hostAsks,
};

const digestOf = (setting: SetupAgentLimitSetting): string => createHash("sha256").update(canonicalJson(setting), "utf8").digest("hex");

// ---- the project's setting

export interface StoredProjectLimits { revision: number; limits: SetupAgentLimitSetting; updatedBy: string; updatedAt: string; lastRequestId?: string }
export interface SetupLimitsDeps extends SetupLocksDeps {
  documentClient: Client;
  tableName: string;
  audit?: AuditRuntime;
}

export async function readProjectLimits(deps: Pick<SetupLimitsDeps, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<StoredProjectLimits | undefined> {
  const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: setupLimitsKey(orgId, project), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined) return undefined;
  const limits = SetupAgentLimitSettingSchema.safeParse(item["limits"]);
  // A stored setting that does not read is held to the defaults by `effectiveSetupAgentLimits` (never looser); the page sees it as no setting.
  return { revision: Number.isSafeInteger(item["revision"]) ? item["revision"] as number : 0, limits: limits.success ? limits.data : {}, updatedBy: typeof item["updatedBy"] === "string" ? item["updatedBy"] : "", updatedAt: typeof item["updatedAt"] === "string" ? item["updatedAt"] : "", ...(typeof item["lastRequestId"] === "string" ? { lastRequestId: item["lastRequestId"] } : {}) };
}

/**
 * The two stored settings a run starts from: the project's own and the company's lock (in the run's units). Read at the start of every run; a lock that cannot be read refuses the start (the store throws), it is never
 * taken for "no lock". `effectiveSetupAgentLimits` combines them.
 */
export function limitSettingsOf(deps: SetupLimitsDeps): (orgId: OrgId, project: string) => Promise<{ project?: unknown; companyLock?: unknown; setupOff?: boolean }> {
  return async (orgId, project) => {
    const [stored, locks] = await Promise.all([readProjectLimits(deps, orgId, project), readCompanyLocks(deps, orgId)]);
    return { ...(stored === undefined ? {} : { project: stored.limits }), companyLock: lockToRunSetting(locks?.locks), ...(locks?.locks.setupAgentOff === true ? { setupOff: true } : {}) };
  };
}

export const ProjectLimitsBodySchema = z.object({
  requestId: z.string().uuid(),
  /** The revision the person looked at (0: they saw no setting). */
  expectedRevision: z.number().int().min(0),
  /** Any subset of the limits; none given removes the project's own setting (the defaults, cut down by the lock). */
  limits: SetupAgentLimitSettingSchema,
}).strict();

export interface ProjectLimitsView {
  revision: number;
  /** The project's own setting (empty: none). */
  limits: SetupAgentLimitSetting;
  /** The company's lock in the run's units (empty: none). */
  companyLock: SetupAgentLimitSetting;
  /** What a run started now would use. */
  effective: SetupAgentLimits;
  defaults: SetupAgentLimits;
  maxima: SetupAgentLimits;
}

async function projectView(deps: SetupLimitsDeps, orgId: OrgId, project: string): Promise<ProjectLimitsView> {
  const [stored, locks] = await Promise.all([readProjectLimits(deps, orgId, project), readCompanyLocks(deps, orgId)]);
  const companyLock = lockToRunSetting(locks?.locks);
  return { revision: stored?.revision ?? 0, limits: stored?.limits ?? {}, companyLock, effective: effectiveSetupAgentLimits(stored?.limits, companyLock), defaults: SETUP_AGENT_LIMITS_DEFAULT, maxima: SETUP_AGENT_LIMITS_MAX };
}

const bodyError = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) => agentXError("CONFIG_INVALID", `${error.issues[0]?.path.join(".") || "body"}: ${error.issues[0]?.message ?? "invalid"}`);

/** `GET .../setup-agent/limits`: the project's own setting beside the company's lock and what a run would use. A maintainer's to read. */
export async function getProjectLimits(deps: SetupLimitsDeps, caller: DeveloperCaller, found: { name: string; role: ProjectRole }): Promise<StatusReply> {
  if (!projectAllows(found.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can read the setup limits");
  return new StatusReply(200, await projectView(deps, caller.orgId, found.name));
}

/**
 * `PUT .../setup-agent/limits`: a maintainer sets the project's own limits, from a signed-in browser (never a token). Each value is the contract's own whole number up to the maximum, and no more than the
 * company's lock for that limit. The write is conditional on the revision the person saw and audited in the same transaction; a repeat of the same request id answers what it answered. Changing nothing writes nothing.
 */
export async function setProjectLimits(deps: SetupLimitsDeps, caller: DeveloperCaller, found: { name: string; role: ProjectRole }, rawBody: unknown): Promise<StatusReply> {
  if (!projectAllows(found.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change the setup limits");
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", SETUP_LIMITS_WORDS.browserOnly);
  const parsed = ProjectLimitsBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError(parsed.error);
  const body = parsed.data;
  const [current, locks] = await Promise.all([readProjectLimits(deps, caller.orgId, found.name), readCompanyLocks(deps, caller.orgId)]);
  // A repeat of the request that made the stored setting answers the same, whatever happened since.
  if (current?.lastRequestId === body.requestId) return new StatusReply(200, await projectView(deps, caller.orgId, found.name));
  if ((current?.revision ?? 0) !== body.expectedRevision) throw agentXError("CHANGE_STALE", SETUP_LIMITS_WORDS.stale);
  const lock = lockToRunSetting(locks?.locks);
  for (const name of SETUP_AGENT_LIMIT_NAMES) {
    const wanted = body.limits[name];
    const cap = lock[name];
    if (wanted !== undefined && cap !== undefined && wanted > cap) throw agentXError("CONFIG_INVALID", `${name}: ${SETUP_LIMITS_WORDS.aboveLock}`);
  }
  const previousDigest = digestOf(current?.limits ?? {});
  const nextDigest = digestOf(body.limits);
  if (previousDigest === nextDigest && current !== undefined) return new StatusReply(200, await projectView(deps, caller.orgId, found.name));
  const at = new Date(deps.now().getTime()).toISOString();
  const revision = (current?.revision ?? 0) + 1;
  const event = auditSetupLimitsChanged({
    orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: at, occurrence: auditOccurrence(found.name, String(revision)), projectName: found.name, revision, previousDigest, nextDigest, limits: body.limits,
  });
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: deps.tableName,
        Item: { ...setupLimitsKey(caller.orgId, found.name), entityType: "SETUP_LIMITS", orgId: caller.orgId, project: found.name, revision, limits: body.limits, updatedBy: caller.developerId, updatedAt: at, lastRequestId: body.requestId },
        ...(current === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": current.revision } }),
      } },
      ...auditPending(deps, event),
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") throw agentXError("CHANGE_STALE", SETUP_LIMITS_WORDS.stale);
    throw error;
  }
  await flushAuditEvents(deps, [event]);
  return new StatusReply(200, await projectView(deps, caller.orgId, found.name));
}

// ---- the company's locks

const ImageName = z.string().min(1).max(300);
export const CompanyLocksBodySchema = z.object({
  requestId: z.string().uuid(),
  /** The lock's revision the admin looked at (null: there was no lock row). */
  expectedRevision: z.number().int().min(0).nullable(),
  /** Only what is given changes; the rest stays as it is. The company's setup-run limits, any subset: a project's limit is the smaller of its own and this. `{}` removes them (a loosening if there were any). */
  limits: SetupAgentLimitSettingSchema.optional(),
  /** No setup run may start in any project of the company. `false` removes the lock (a loosening). */
  setupAgentOff: z.boolean().optional(),
  /** Dev container base images only from this list (enforced when recipes are offered). `null` removes the lock (a loosening). */
  devcontainerImages: z.array(ImageName).max(50).nullable().optional(),
  /** Turns the sole-owner exception off for loosening company locks. `false` removes it (a loosening). */
  noSoleOwnerException: z.boolean().optional(),
}).strict().refine((body) => body.limits !== undefined || body.setupAgentOff !== undefined || body.devcontainerImages !== undefined || body.noSoleOwnerException !== undefined, { message: "say which lock to change" });
export const CompanyLocksApproveBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().min(1), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export interface CompanyLocksState {
  limits: SetupAgentLimitSetting;
  setupAgentOff: boolean;
  devcontainerImages: string[] | null;
  noSoleOwnerException: boolean;
}
export interface CompanyLocksView extends CompanyLocksState {
  revision: number | null;
  defaults: SetupAgentLimits;
  maxima: SetupAgentLimits;
  /** A loosening that waits for a second admin: what it would set, the digest the second admin approves, and whether the viewer proposed it (so they know they cannot approve it themselves, the sole-owner exception aside). */
  pending?: CompanyLocksState & { digest: string; proposedAt: string; byYou: boolean };
}

const stateOf = (locks: CompanySetupLocks | undefined): CompanyLocksState => ({
  limits: lockToRunSetting(locks), setupAgentOff: locks?.setupAgentOff === true, devcontainerImages: locks?.devcontainerImages === undefined ? null : [...locks.devcontainerImages], noSoleOwnerException: locks?.noSoleOwnerException === true,
});

function companyView(stored: StoredLocks | undefined, viewer: string): CompanyLocksView {
  return {
    revision: stored?.revision ?? null, ...stateOf(stored?.locks), defaults: SETUP_AGENT_LIMITS_DEFAULT, maxima: SETUP_AGENT_LIMITS_MAX,
    ...(stored?.pending === undefined ? {} : { pending: { ...stateOf(stored.pending.locks), digest: stored.pending.digest, proposedAt: stored.pending.proposedAt, byYou: stored.pending.proposedBy === viewer } }),
  };
}

const recipeCaller = (caller: DeveloperCaller): RecipeCaller => ({ orgId: caller.orgId, developerId: caller.developerId, sessionId: caller.sessionId });
function requireBrowser(caller: DeveloperCaller): void {
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", SETUP_LIMITS_WORDS.browserOnly);
}

/** `GET /v1/app/org/setup-agent/locks`: the company's setup locks and any change waiting for a second admin. A live company owner or admin, from a browser. */
export async function getCompanyLocksView(deps: SetupLimitsDeps, caller: DeveloperCaller): Promise<StatusReply> {
  requireBrowser(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
  return new StatusReply(200, companyView(await readCompanyLocks(deps, caller.orgId), caller.developerId));
}

/**
 * `PUT /v1/app/org/setup-agent/locks`: a company admin changes the company's setup locks, from a browser, with a fresh sign-in, against the revision they saw. Only the locks given change. A change to a lock that
 * something enforces (limits, setupAgentOff, devcontainerImages, noSoleOwnerException) that is stricter or equal applies at once (200 `applied`); a loosening of ANY lock is stored as a change waiting for a second
 * admin (202 `needs_second_admin`) and changes nothing until they approve it. Every write is audited. The other locks (hostsOnlyFromCompanyList, hostApprover, nightlyHealthOn) are "not available yet".
 */
export async function setCompanyLockSettings(deps: SetupLimitsDeps, caller: DeveloperCaller, rawBody: unknown): Promise<StatusReply> {
  requireBrowser(caller);
  const parsed = CompanyLocksBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError(parsed.error);
  const body = parsed.data;
  const current = await readCompanyLocks(deps, caller.orgId);
  const next: Record<string, unknown> = { ...(current?.locks ?? {}) };
  const put = (key: string, value: unknown): void => { if (value === undefined) delete next[key]; else next[key] = value; };
  if (body.limits !== undefined) put("limits", runSettingToLockLimits(body.limits));
  if (body.setupAgentOff !== undefined) put("setupAgentOff", body.setupAgentOff ? true : undefined);
  if (body.devcontainerImages !== undefined) put("devcontainerImages", body.devcontainerImages === null ? undefined : body.devcontainerImages);
  if (body.noSoleOwnerException !== undefined) put("noSoleOwnerException", body.noSoleOwnerException ? true : undefined);
  const result = await setCompanyLocks(deps, recipeCaller(caller), { locks: next, expectedRevision: body.expectedRevision });
  return new StatusReply(result.status === "applied" ? 200 : 202, { status: result.status, ...companyView(result.locks, caller.developerId) });
}

/** `POST /v1/app/org/setup-agent/locks/approve`: a DIFFERENT admin (or the sole owner, through the existing exception after its cool-off, unless the company turned it off) approves the waiting loosening they saw, from a browser, with a fresh sign-in. */
export async function approveCompanyLockSettings(deps: SetupLimitsDeps, caller: DeveloperCaller, rawBody: unknown): Promise<StatusReply> {
  requireBrowser(caller);
  const parsed = CompanyLocksApproveBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError(parsed.error);
  const approved = await approveLocksChange(deps, recipeCaller(caller), { expectedRevision: parsed.data.expectedRevision, expectedDigest: parsed.data.expectedDigest });
  return new StatusReply(200, { status: "applied", ...companyView(approved, caller.developerId) });
}
