// Plan 4 Task 18: the routes of triggers. A chain's and an agent's triggers (`/v1/app/chains/{id}/triggers*`, `/v1/app/agents/{id}/triggers*`) and a project's switch for the
// triggers a built-in agent suggests (`/v1/app/projects/{p}/builtin-triggers*`). Every body is strict and carries a `requestId` (R18). Setting a trigger needs `manage` on its
// target and `edit_settings` on its project. Turning one on is a person's decision (N6): the trigger is stored off, and a `trigger_enable` approval waits on the confirmation
// page; it is bound to the spec the person was shown, and it turns on exactly that spec or nothing. Turning one off, narrowing it and lowering its rate apply at once.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentIdSchema,
  BUILTIN_AGENT_IDS,
  BUILTIN_TRIGGER_SUGGESTIONS,
  ChainIdSchema,
  TRIGGER_DEFAULT_MAX_RUNS_PER_HOUR,
  TRIGGER_MAX_RUNS_PER_HOUR,
  TriggerIdSchema,
  TriggerSpecSchema,
  agentXError,
  atLeast,
  canonicalJson,
  isBuiltinAgentId,
  newPrefixedId,
  projectAllows,
  triggerSpecWidens,
  type AgentId,
  type OrgId,
  type TriggerTarget,
} from "@agentx/contracts";
import { type AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { agentAccess, orgRoleOf, requireAgentAccess, resolveSurvivor, type AgentCaller } from "../agents/access.js";
import {
  approvalIdFor, confirmUrlFor, createPendingChange, pendingChangeFor, registerApprovalSubjectHandler, registerApproverRule, shownText,
  type ApprovalRecord, type ApproverSpec, type ApprovalDependencies,
} from "../agents/approvals.js";
import { orgAdmins } from "../agents/changes.js";
import { readGuardrails } from "../agents/guardrails.js";
import { jsonBody, markRequest, parseBody, type AgentRouteDependencies } from "../agents/routes.js";
import { requireChainAccess, chainAccess, type ChainAccessDeps } from "../chains/access.js";
import { displayNameOf } from "../chains/gates.js";
import { healGithubRepoIndex } from "./github-events.js";
import { closeTriggerEnableApproval, targetEventItem } from "./lifecycle.js";
import { triggerProblemError, triggerProblems, triggerWords, type TriggerProblem } from "./requirements.js";
import { isTriggerConflict, type TriggerRecord, type TriggerSpec, type TriggerStore } from "./store.js";

type Deps = AgentRouteDependencies;
type Shown = Record<string, unknown>;

const NAME_MAX = 80;
const WAITING_REASON = "waiting for someone to confirm turning it on";

const notFound = (what = "trigger") => agentXError("NOT_FOUND", `no ${what} has that ID`);

// ---- paths

export const CHAIN_TRIGGERS_PATH = /^\/v1\/app\/chains\/([^/]+)\/triggers(?:\/([^/]+)(?:\/(activity))?)?$/;
export const AGENT_TRIGGERS_PATH = /^\/v1\/app\/agents\/([^/]+)\/triggers(?:\/([^/]+)(?:\/(activity))?)?$/;
export const BUILTIN_TRIGGERS_PATH = /^\/v1\/app\/projects\/([^/]+)\/builtin-triggers(?:\/([^/]+)\/([0-9]{1,3}))?$/;

// ---- bodies

const RequestIdSchema = z.string().uuid();
const HookIdSchema = z.string().regex(/^hk_[0-9a-z]{26}$/);
const RunsPerHourSchema = z.number().int().min(1).max(TRIGGER_MAX_RUNS_PER_HOUR);
const PutBodySchema = z.object({ requestId: RequestIdSchema, project: z.string().min(1).max(200), spec: z.unknown(), hookId: HookIdSchema.optional(), enabled: z.boolean().optional(), maxRunsPerHour: RunsPerHourSchema.optional() }).strict();
const RequestOnlySchema = z.object({ requestId: RequestIdSchema }).strict();
const BuiltinBodySchema = z.object({
  requestId: RequestIdSchema, enabled: z.boolean(), hookId: HookIdSchema.optional(), filter: z.record(z.string(), z.array(z.string())).optional(), schedule: z.unknown().optional(), timezone: z.string().optional(),
  maxRunsPerHour: RunsPerHourSchema.optional(),
}).strict();

export function decodeSegment(raw: string, what: string): string {
  try { return decodeURIComponent(raw); } catch { throw agentXError("NOT_FOUND", `no ${what} has that name`); }
}

// ---- the keys of a trigger's change

/** What a person who turns a trigger on is shown, and what the approval is bound to: where it runs, what starts it and how often. */
export function specDigestOf(trigger: Pick<TriggerRecord, "target" | "project" | "spec" | "hookId" | "maxRunsPerHour">): string {
  return createHash("sha256").update(canonicalJson({ target: trigger.target, project: trigger.project, spec: trigger.spec, hookId: trigger.hookId ?? null, maxRunsPerHour: trigger.maxRunsPerHour }), "utf8").digest("hex");
}

/** Every id the project's switch derives starts with this, and no id a person puts a trigger under may (the ids are guessable, so the marker is what keeps them the switch's own). */
const BUILTIN_ID_MARKER = "bi0";
const ID_PREFIX = "ctr_";

/** Whether `triggerId` is of the kind the project's switch derives. */
export const isBuiltinTriggerId = (triggerId: string): boolean => triggerId.startsWith(`${ID_PREFIX}${BUILTIN_ID_MARKER}`);

/** The id of the trigger a project's switch for a built-in's suggestion keeps: the same on every call, so turning the row on twice is one trigger. */
export function builtinTriggerIdFor(orgId: OrgId, project: string, agentId: string, index: number): string {
  const derived = newPrefixedId("ctr", () => createHash("sha256").update(`builtin-trigger|${orgId}|${project}|${agentId}|${String(index)}`, "utf8").digest());
  return `${ID_PREFIX}${BUILTIN_ID_MARKER}${derived.slice(ID_PREFIX.length + BUILTIN_ID_MARKER.length)}`;
}

/** Whether a stored record is the one the switch keeps for this built-in on this project (and not another trigger that sits under its id). */
const isRowOf = (trigger: TriggerRecord, project: string, agentId: AgentId): boolean => trigger.target.kind === "agent" && trigger.target.agentId === agentId && trigger.project === project;

const targetKeyOf = (target: TriggerTarget): string => (target.kind === "chain" ? `chain/${target.chainId}` : `agent/${target.agentId}`);

// ---- access

const chainAccessOf = (deps: Deps): ChainAccessDeps => ({ ...deps, store: deps.chains! });

function storeOf(deps: Deps): TriggerStore {
  if (deps.triggers === undefined) throw agentXError("NOT_FOUND", "triggers are not set up in this deployment");
  return deps.triggers;
}

/** The target, when the caller holds at least `wanted` on it (a target the caller can't see is 404, as everywhere). A built-in is for everyone to see; an admin manages it. */
async function requireTarget(deps: Deps, caller: AgentCaller, target: TriggerTarget, wanted: "view" | "manage"): Promise<void> {
  if (target.kind === "chain") {
    if (deps.chains === undefined) throw agentXError("NOT_FOUND", "no chain has that ID");
    await requireChainAccess(chainAccessOf(deps), caller, target.chainId, wanted);
    return;
  }
  const { agent } = await requireAgentAccess(deps, caller, target.agentId, wanted);
  // A project's process layer is never started by a trigger: it reads as an agent that is not there.
  if ("owner" in agent && agent.purpose === "process") throw agentXError("NOT_FOUND", "no agent has that ID");
}

/** What the caller holds on the project: its role, or a 404 for a project they have no role on (which also is how another org's project reads). */
async function projectRoleOf(deps: Deps, caller: AgentCaller, project: string) {
  const role = await deps.projectMembers.roleOf(caller.orgId, project, { developerId: caller.developerId, orgRole: caller.orgRole });
  if (role === undefined) throw agentXError("NOT_FOUND", "no project has that name");
  return role;
}

export async function requireSettingsOn(deps: Deps, caller: AgentCaller, project: string): Promise<void> {
  const role = await projectRoleOf(deps, caller, project);
  if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", `Only a maintainer of ${shownText(project, NAME_MAX)} can set up its triggers.`);
}

// ---- how a trigger is shown

async function viewOf(deps: Deps, trigger: TriggerRecord): Promise<Shown> {
  return {
    triggerId: trigger.triggerId, target: trigger.target, project: trigger.project, spec: trigger.spec, ...(trigger.hookId === undefined ? {} : { hookId: trigger.hookId }),
    enabled: trigger.enabled, ...(trigger.disabledReason === undefined ? {} : { disabledReason: trigger.disabledReason }), maxRunsPerHour: trigger.maxRunsPerHour,
    ...(trigger.scheduleStatus === undefined ? {} : { scheduleStatus: trigger.scheduleStatus }), ...(trigger.lastFiredAt === undefined ? {} : { lastFiredAt: trigger.lastFiredAt }),
    ...(trigger.lastRunId === undefined ? {} : { lastRunId: trigger.lastRunId }), ...(trigger.lastTaskId === undefined ? {} : { lastTaskId: trigger.lastTaskId }),
    createdBy: { developerId: trigger.createdBy, name: await displayNameOf(deps, trigger.createdBy) }, createdAt: trigger.createdAt, updatedAt: trigger.updatedAt,
  };
}

// ---- the schedule

/** Makes the scheduler's copy of the trigger what the trigger says: running while it is on, `DISABLED` while it is off. A scheduler that isn't there, or fails, leaves `pending` for Task 26's repair. */
async function syncSchedule(deps: Deps, trigger: TriggerRecord, wasEnabled: boolean): Promise<TriggerRecord> {
  // A schedule that was never started and is not to be has nothing at the scheduler to set.
  if (trigger.spec.kind !== "schedule" || (!trigger.enabled && !wasEnabled)) return trigger;
  const store = storeOf(deps);
  const scheduler = deps.triggerSchedules;
  let status: "ok" | "pending" = "pending";
  if (scheduler !== undefined) {
    try {
      if (trigger.enabled) await scheduler.put({ orgId: trigger.orgId, triggerId: trigger.triggerId, spec: trigger.spec });
      else await scheduler.disable({ orgId: trigger.orgId, triggerId: trigger.triggerId });
      status = "ok";
    } catch (error) {
      (deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("trigger_schedule.sync_failed", { orgId: trigger.orgId, triggerId: trigger.triggerId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  if (trigger.scheduleStatus === status) return trigger;
  try {
    return await store.update({ trigger, patch: { scheduleStatus: status } });
  } catch (error) {
    if (!isTriggerConflict(error)) throw error;
    return await store.get(trigger.orgId, trigger.triggerId) ?? trigger;
  }
}

// ---- who is asked

/** The people shown a trigger's turn-on: org owners and admins, and the project's maintainers. The rule decides who may decide. */
async function approversFor(deps: Deps, trigger: TriggerRecord): Promise<ApproverSpec> {
  const candidates = new Set<string>([trigger.createdBy]);
  for (const id of await orgAdmins(deps, trigger.orgId)) candidates.add(id);
  for (const member of await deps.projectMembers.list(trigger.orgId, trigger.project)) if (projectAllows(member.role, "edit_settings")) candidates.add(member.developerId);
  return { kind: "rule", rule: "trigger_enable", candidates: [...candidates] };
}

async function waitForPerson(deps: Deps, caller: AgentCaller, requestId: string, trigger: TriggerRecord): Promise<StatusReply> {
  const record = await createPendingChange(deps, {
    orgId: caller.orgId, requestId, requestedBy: caller.developerId, subject: { kind: "trigger_enable", triggerId: trigger.triggerId, specDigest: specDigestOf(trigger), triggerRevision: trigger.revision },
    changes: [`turn on ${triggerWords(trigger)} for ${shownText(trigger.project, NAME_MAX)}`], approvers: await approversFor(deps, trigger),
  });
  // A replay of a request that was decided since is not waiting any more.
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return new StatusReply(202, { status: "NEEDS_CONFIRMATION", confirmUrl: confirmUrlFor(deps, record), changes: record.changes });
}

// ---- the one change

interface Wanted {
  triggerId: string;
  target: TriggerTarget;
  project: string;
  spec: TriggerSpec;
  hookId?: string | undefined;
  enabled?: boolean | undefined;
  maxRunsPerHour?: number | undefined;
}

/** What a stored answer holds, so a repeat of the request is answered without writing. */
interface Stored { triggerId: string; waiting: boolean; created: boolean }

/** Whether the change takes more than a person's say-so to apply: it turns a trigger on, changes what it is, or lets it start work it did not. */
function needsPerson(existing: TriggerRecord | undefined, next: { target: TriggerTarget; project: string; spec: TriggerSpec; hookId?: string | undefined; maxRunsPerHour: number; enabled: boolean }): boolean {
  if (!next.enabled) return false;
  if (existing === undefined || !existing.enabled) return true;
  if (targetKeyOf(existing.target) !== targetKeyOf(next.target) || existing.project !== next.project || existing.hookId !== next.hookId) return true;
  if (existing.spec.kind !== next.spec.kind) return true;
  if (existing.spec.kind === "event" && next.spec.kind === "event" && (existing.spec.source !== next.spec.source || existing.spec.type !== next.spec.type)) return true;
  return triggerSpecWidens(existing.spec, next.spec) || next.maxRunsPerHour > existing.maxRunsPerHour;
}

/** A problem a person who is only saving a trigger that stays off is still refused for: what ties it to another org's things or to nothing. */
const structural = (problem: TriggerProblem): boolean => problem.code === "NOT_FOUND";

/**
 * Stores a trigger as asked and answers it: created or changed at once, or stored off and waiting for the confirmation page. `existing` is what is stored under the id now.
 * The caller has checked access to the target (and to the existing trigger's) and to the project.
 */
async function change(deps: Deps, caller: AgentCaller, wanted: Wanted, requestId: string, fingerprintRoute: string, existing: TriggerRecord | undefined, status: "created" | "changed"): Promise<StatusReply> {
  const store = storeOf(deps);
  const { mark, replay } = await markRequest(deps, caller, fingerprintRoute, wanted.triggerId, { requestId, ...JSON.parse(JSON.stringify({ target: wanted.target, project: wanted.project, spec: wanted.spec, hookId: wanted.hookId, enabled: wanted.enabled, maxRunsPerHour: wanted.maxRunsPerHour })) as object });
  if (replay !== undefined) return answerReplay(deps, caller, requestId, replay.result as Stored);
  const enabled = wanted.enabled ?? existing?.enabled ?? true;
  const maxRunsPerHour = wanted.maxRunsPerHour ?? existing?.maxRunsPerHour ?? TRIGGER_DEFAULT_MAX_RUNS_PER_HOUR;
  const confirm = needsPerson(existing, { target: wanted.target, project: wanted.project, spec: wanted.spec, hookId: wanted.hookId, maxRunsPerHour, enabled });
  // A person's own say-so turns a trigger on only through the page, so the one who asks is the one whose rights the trigger runs under.
  const createdBy = existing === undefined || confirm ? caller.developerId : existing.createdBy;
  const candidate: TriggerRecord = {
    orgId: caller.orgId, triggerId: wanted.triggerId, target: wanted.target, project: wanted.project, spec: wanted.spec, ...(wanted.hookId === undefined ? {} : { hookId: wanted.hookId }),
    enabled, maxRunsPerHour, createdBy, createdAt: existing?.createdAt ?? new Date(deps.now()).toISOString(), updatedAt: "", revision: existing?.revision ?? 0,
  };
  const problems = await triggerProblems(deps, candidate);
  const refused = enabled ? problems[0] : problems.find(structural);
  if (refused !== undefined) throw triggerProblemError(refused);
  // The request this one makes is the only one that may turn the trigger on from here: the earlier one, if there is one, is closed once this is written.
  const pendingApprovalId = enabled && confirm ? approvalIdFor(caller.orgId, caller.developerId, requestId) : undefined;
  const stored: Omit<TriggerRecord, "revision" | "updatedAt"> = {
    ...candidate, enabled: enabled && !confirm, ...(pendingApprovalId === undefined ? {} : { pendingApprovalId }),
    ...(enabled && confirm ? { disabledReason: WAITING_REASON } : existing?.disabledReason !== undefined && !enabled ? { disabledReason: existing.disabledReason } : {}),
    // A schedule is the scheduler's once the trigger is on; until then it is not there, or is `DISABLED`.
    ...(candidate.spec.kind === "schedule" ? { scheduleStatus: existing?.scheduleStatus ?? "pending" as const } : {}),
    ...(existing?.lastFiredAt === undefined ? {} : { lastFiredAt: existing.lastFiredAt }), ...(existing?.lastRunId === undefined ? {} : { lastRunId: existing.lastRunId }), ...(existing?.lastTaskId === undefined ? {} : { lastTaskId: existing.lastTaskId }),
  };
  const result: Stored = { triggerId: wanted.triggerId, waiting: confirm, created: existing === undefined };
  await healIndexIfOn(deps, stored);
  const written = existing === undefined
    ? await store.create({ record: stored, request: mark, result, extra: targetEventItem(deps, caller.orgId, wanted.target, "trigger_created", { triggerId: wanted.triggerId, by: caller.developerId }) })
    : await store.update({
      trigger: existing, patch: patchOf(stored), clear: clearOf(existing, stored), request: mark, result,
      extra: targetEventItem(deps, caller.orgId, wanted.target, "trigger_changed", { triggerId: wanted.triggerId, by: caller.developerId }),
    });
  const settled = await syncSchedule(deps, written, existing?.enabled === true);
  // A turn-off, a change of what the trigger is and a newer request each end the request that was waiting. A close that does not happen leaves it bound to a revision that is
  // gone, so confirming it is refused all the same.
  if (existing?.pendingApprovalId !== undefined && existing.pendingApprovalId !== pendingApprovalId) {
    await closeTriggerEnableApproval(deps, caller.orgId, existing.triggerId, existing.pendingApprovalId, "The trigger was turned off, changed or asked for again after this request.").catch((error: unknown) => {
      (deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("trigger_enable.close_failed", { orgId: caller.orgId, triggerId: existing.triggerId, error: error instanceof Error ? error.name : "unknown" });
    });
  }
  if (confirm) return waitForPerson(deps, caller, requestId, settled);
  return new StatusReply(status === "created" ? 201 : 200, { trigger: await viewOf(deps, settled) });
}

/**
 * A GitHub trigger that is on finds its project through the repository index (Task 21), which a project registered before that has no rows of: turning the trigger on (or
 * confirming it, or saving it again while on) writes the rows of the project's latest revision first, so a fault here leaves the trigger as it was and the request can be repeated.
 */
async function healIndexIfOn(deps: Deps, trigger: Pick<TriggerRecord, "orgId" | "project" | "spec" | "enabled">): Promise<void> {
  if (trigger.enabled && trigger.spec.kind === "event" && trigger.spec.source === "github") await healGithubRepoIndex(deps, trigger.orgId, trigger.project);
}

type Patch = Parameters<TriggerStore["update"]>[0]["patch"];
function patchOf(next: Omit<TriggerRecord, "revision" | "updatedAt">): Patch {
  const { orgId: _orgId, triggerId: _triggerId, ...rest } = next; // eslint-disable-line @typescript-eslint/no-unused-vars -- the key is not patched
  return rest;
}
function clearOf(before: TriggerRecord, next: Omit<TriggerRecord, "revision" | "updatedAt">): NonNullable<Parameters<TriggerStore["update"]>[0]["clear"]> {
  const fields = ["hookId", "disabledReason", "scheduleStatus", "lastFiredAt", "lastRunId", "lastTaskId", "pendingApprovalId"] as const;
  return fields.filter((field) => before[field] !== undefined && next[field] === undefined);
}

async function answerReplay(deps: Deps, caller: AgentCaller, requestId: string, stored: Stored): Promise<StatusReply> {
  const trigger = await storeOf(deps).get(caller.orgId, stored.triggerId);
  if (trigger === undefined) return new StatusReply(200, { deleted: true });
  if (stored.waiting) {
    const approval = await pendingChangeFor(deps, caller.orgId, caller.developerId, requestId);
    if (approval === undefined) return waitForPerson(deps, caller, requestId, trigger);
    // The request as it was made (the trigger may have been written since): its own link, and a closed one says so.
    if (approval.status === "PENDING") return new StatusReply(202, { status: "NEEDS_CONFIRMATION", confirmUrl: confirmUrlFor(deps, approval), changes: approval.changes });
    if (approval.status === "EXPIRED") throw agentXError("APPROVAL_CLOSED", "this request was closed: the trigger was turned off, changed or asked for again");
  }
  return new StatusReply(stored.created ? 201 : 200, { trigger: await viewOf(deps, trigger) });
}

// ---- reading

async function listTriggers(deps: Deps, caller: AgentCaller, target: TriggerTarget): Promise<Shown> {
  await requireTarget(deps, caller, target, "view");
  return { triggers: await Promise.all((await storeOf(deps).listForTarget(caller.orgId, target)).map((trigger) => viewOf(deps, trigger))) };
}

async function requireOnTarget(deps: Deps, caller: AgentCaller, target: TriggerTarget, rawId: string): Promise<TriggerRecord> {
  const id = TriggerIdSchema.safeParse(rawId);
  const trigger = id.success ? await storeOf(deps).get(caller.orgId, id.data) : undefined;
  if (trigger === undefined || targetKeyOf(trigger.target) !== targetKeyOf(target)) throw notFound();
  return trigger;
}

async function activityOf(deps: Deps, caller: AgentCaller, target: TriggerTarget, rawId: string): Promise<Shown> {
  await requireTarget(deps, caller, target, "view");
  const trigger = await requireOnTarget(deps, caller, target, rawId);
  const entries = await storeOf(deps).listActivity(caller.orgId, trigger.triggerId);
  return { activity: entries.map((entry) => ({
    at: entry.at, eventKey: shownText(entry.eventKey, 200), outcome: entry.outcome, ...(entry.runId === undefined ? {} : { runId: entry.runId }),
    ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }), ...(entry.reason === undefined ? {} : { reason: shownText(entry.reason, 300) }),
  })) };
}

// ---- writing

async function putTrigger(deps: Deps, caller: AgentCaller, target: TriggerTarget, rawId: string, body: unknown): Promise<StatusReply> {
  const triggerId = TriggerIdSchema.safeParse(rawId);
  if (!triggerId.success) throw notFound();
  // The ids of the project's built-in switch are the switch's: a trigger put under one would be taken for a built-in's and moved or turned off by it.
  if (isBuiltinTriggerId(triggerId.data)) throw agentXError("CONFIG_INVALID", "that trigger ID is kept for the project's built-in trigger switch; use another");
  const input = parseBody(PutBodySchema, body);
  const store = storeOf(deps);
  // The built-ins have one route, the project's switch (G26): a trigger on one made here would start a built-in the project never turned on.
  if (target.kind === "agent" && isBuiltinAgentId(target.agentId)) throw agentXError("CONFIG_INVALID", "use the project's built-in trigger switch");
  await requireTarget(deps, caller, target, "manage");
  await requireSettingsOn(deps, caller, input.project);
  const parsed = TriggerSpecSchema.safeParse(input.spec);
  if (!parsed.success || parsed.data.kind === "person") {
    const first = parsed.success ? undefined : parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `spec: ${parsed.success ? "must be an event or a schedule" : `${first?.path.join(".") ?? ""} ${first?.message ?? "is not valid"}`.replace(/\s+/gu, " ").trim()}`);
  }
  const existing = await store.get(caller.orgId, triggerId.data);
  if (existing !== undefined) {
    // Moving a trigger needs the rights on where it was too: nobody takes another target's trigger by naming its id.
    await requireTarget(deps, caller, existing.target, "manage").catch(() => { throw notFound(); });
    await requireSettingsOn(deps, caller, existing.project).catch(() => { throw notFound(); });
  }
  return change(deps, caller, {
    triggerId: triggerId.data, target, project: input.project, spec: parsed.data, hookId: input.hookId, enabled: input.enabled, maxRunsPerHour: input.maxRunsPerHour,
  }, input.requestId, `trigger-put/${targetKeyOf(target)}`, existing, existing === undefined ? "created" : "changed");
}

async function deleteTrigger(deps: Deps, caller: AgentCaller, target: TriggerTarget, rawId: string, body: unknown): Promise<Shown> {
  const input = parseBody(RequestOnlySchema, body);
  await requireTarget(deps, caller, target, "manage");
  const trigger = await requireOnTarget(deps, caller, target, rawId);
  await requireSettingsOn(deps, caller, trigger.project);
  const { mark, replay } = await markRequest(deps, caller, "trigger-delete", trigger.triggerId, input);
  if (replay !== undefined) return { deleted: true };
  await storeOf(deps).delete({ trigger, request: mark, result: { deleted: true }, extra: targetEventItem(deps, caller.orgId, trigger.target, "trigger_deleted", { triggerId: trigger.triggerId, by: caller.developerId }) });
  if (trigger.spec.kind === "schedule") {
    // The trigger is gone either way, and a schedule that is left is deleted as stale at its next fire; the failure is logged by ids and the error's name (Task 26 review M-5).
    await deps.triggerSchedules?.remove({ orgId: trigger.orgId, triggerId: trigger.triggerId }).catch((error: unknown) => {
      (deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("trigger_schedule.delete_failed", { orgId: trigger.orgId, triggerId: trigger.triggerId, error: error instanceof Error ? error.name : "unknown" });
    });
  }
  return { deleted: true };
}

// ---- a chain's or an agent's triggers

async function targetRoute(deps: Deps, caller: AgentCaller, request: AdaptedHttpRequest, target: TriggerTarget, rawTrigger: string | undefined, activity: string | undefined): Promise<unknown> {
  const method = request.method;
  if (rawTrigger === undefined) {
    if (method === "GET") return listTriggers(deps, caller, target);
  } else if (activity !== undefined) {
    if (method === "GET") return activityOf(deps, caller, target, rawTrigger);
  } else if (method === "PUT") {
    return putTrigger(deps, caller, target, rawTrigger, jsonBody(request));
  } else if (method === "DELETE") {
    return deleteTrigger(deps, caller, target, rawTrigger, jsonBody(request));
  }
  throw agentXError("NOT_FOUND", "route not found");
}

/** `/v1/app/chains/{id}/triggers*`, or undefined for any other path. */
export async function routeChainTriggers(deps: Deps, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const matched = CHAIN_TRIGGERS_PATH.exec(url.pathname);
  if (matched === null) return undefined;
  const chainId = ChainIdSchema.safeParse(matched[1]);
  if (!chainId.success) throw agentXError("NOT_FOUND", "no chain has that ID");
  return targetRoute(deps, caller, request, { kind: "chain", chainId: chainId.data }, matched[2], matched[3]);
}

/** `/v1/app/agents/{id}/triggers*`, or undefined for any other path. */
export async function routeAgentTriggers(deps: Deps, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const matched = AGENT_TRIGGERS_PATH.exec(url.pathname);
  if (matched === null) return undefined;
  const agentId = AgentIdSchema.safeParse(matched[1]);
  if (!agentId.success) throw agentXError("NOT_FOUND", "no agent has that ID");
  return targetRoute(deps, caller, request, { kind: "agent", agentId: agentId.data }, matched[2], matched[3]);
}

// ---- a project's switch for the triggers built-in agents suggest

async function visibleBuiltins(deps: Deps, caller: AgentCaller): Promise<AgentId[]> {
  const admin = caller.orgRole === "owner" || caller.orgRole === "admin";
  const turnedOff = admin ? [] : (await readGuardrails(deps, caller.orgId)).disabledBuiltins;
  return BUILTIN_AGENT_IDS.filter((id) => !turnedOff.some((off) => off === id));
}

async function builtinRows(deps: Deps, caller: AgentCaller, project: string): Promise<Shown> {
  await projectRoleOf(deps, caller, project);
  const store = storeOf(deps);
  const rows: Shown[] = [];
  for (const agentId of await visibleBuiltins(deps, caller)) {
    const suggestions = BUILTIN_TRIGGER_SUGGESTIONS[agentId as keyof typeof BUILTIN_TRIGGER_SUGGESTIONS];
    if (suggestions.length === 0) continue;
    const runsVersion = await deps.store.pinnedBuiltinVersion(caller.orgId, agentId);
    for (const [index, spec] of suggestions.entries()) {
      const found = await store.get(caller.orgId, builtinTriggerIdFor(caller.orgId, project, agentId, index));
      const trigger = found !== undefined && isRowOf(found, project, agentId) ? found : undefined;
      rows.push({
        agentId, index, spec: trigger?.spec ?? spec, enabled: trigger?.enabled === true, ...(trigger === undefined ? {} : { triggerId: trigger.triggerId }),
        needsHook: spec.kind === "event" && spec.source !== "github", runsVersion,
      });
    }
  }
  return { triggers: rows };
}

/** The spec a project's trigger copies from a suggestion: the maintainer may narrow its filter and set its schedule, never widen what the built-in suggests. */
function specFromSuggestion(suggestion: TriggerSpec, input: z.infer<typeof BuiltinBodySchema>): TriggerSpec {
  const candidate: unknown = suggestion.kind === "event"
    ? { ...suggestion, ...(input.filter === undefined ? {} : { filter: input.filter }) }
    : { ...suggestion, ...(input.schedule === undefined ? {} : { schedule: input.schedule }), ...(input.timezone === undefined ? {} : { timezone: input.timezone }) };
  if (suggestion.kind === "event" && input.schedule !== undefined) throw agentXError("CONFIG_INVALID", "schedule: this suggestion starts on an event");
  if (suggestion.kind === "schedule" && input.filter !== undefined) throw agentXError("CONFIG_INVALID", "filter: this suggestion starts on a schedule");
  const parsed = TriggerSpecSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind === "person") {
    const first = parsed.success ? undefined : parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `spec: ${`${first?.path.join(".") ?? ""} ${first?.message ?? "is not valid"}`.replace(/\s+/gu, " ").trim()}`);
  }
  if (suggestion.kind === "event" && triggerSpecWidens(suggestion, parsed.data)) throw agentXError("CONFIG_INVALID", "filter: it can only narrow what the built-in agent suggests");
  return parsed.data;
}

async function putBuiltin(deps: Deps, caller: AgentCaller, project: string, rawAgent: string, rawIndex: string, body: unknown): Promise<StatusReply> {
  const input = parseBody(BuiltinBodySchema, body);
  const store = storeOf(deps);
  const role = await projectRoleOf(deps, caller, project);
  if (!projectAllows(role, "edit_settings") || !projectAllows(role, "start_tasks")) throw agentXError("FORBIDDEN", `Only a maintainer of ${shownText(project, NAME_MAX)} can turn on its built-in triggers.`);
  const agentId = AgentIdSchema.safeParse(rawAgent);
  const index = Number(rawIndex);
  const visible = agentId.success && isBuiltinAgentId(agentId.data) ? await visibleBuiltins(deps, caller) : [];
  const suggestion = agentId.success && visible.some((id) => id === agentId.data) ? BUILTIN_TRIGGER_SUGGESTIONS[agentId.data as keyof typeof BUILTIN_TRIGGER_SUGGESTIONS][index] : undefined;
  if (!agentId.success || suggestion === undefined) throw agentXError("NOT_FOUND", "no built-in trigger has that name");
  const triggerId = builtinTriggerIdFor(caller.orgId, project, agentId.data, index);
  const existing = await store.get(caller.orgId, triggerId);
  if (existing !== undefined && !isRowOf(existing, project, agentId.data)) throw agentXError("CONFIG_INVALID", "that trigger ID is taken by another trigger, so this built-in's trigger can't be set here");
  const spec = specFromSuggestion(suggestion, input);
  // Nothing is on and nothing was asked to be: there is nothing to store, and asking again is no different.
  if (existing === undefined && !input.enabled) return new StatusReply(200, { trigger: null });
  return change(deps, caller, {
    triggerId, target: { kind: "agent", agentId: agentId.data }, project, spec, hookId: input.hookId ?? (spec.kind === "event" && spec.source !== "github" ? existing?.hookId : undefined),
    enabled: input.enabled, maxRunsPerHour: input.maxRunsPerHour,
  }, input.requestId, "builtin-trigger", existing, existing === undefined ? "created" : "changed");
}

/** `/v1/app/projects/{p}/builtin-triggers*`, or undefined for any other path. */
export async function routeBuiltinTriggers(deps: Deps, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const matched = BUILTIN_TRIGGERS_PATH.exec(url.pathname);
  if (matched === null) return undefined;
  const project = decodeSegment(matched[1]!, "project");
  if (matched[2] === undefined) {
    if (request.method === "GET") return builtinRows(deps, caller, project);
  } else if (request.method === "PUT") {
    return putBuiltin(deps, caller, project, matched[2], matched[3]!, jsonBody(request));
  }
  throw agentXError("NOT_FOUND", "route not found");
}

// ---- what confirming does

const stale = () => agentXError("CONFIG_INVALID", "The trigger changed after this was asked. Turn it on again.");

function decider(record: ApprovalRecord): string {
  if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
  return record.decidedBy;
}

/**
 * Turns on exactly the spec the person was shown: the trigger is read again, must still hold what the approval is bound to, and must still qualify; then it is on, owned by the
 * person who asked (whose rights were checked), and a schedule is started. Told again after it was done, it changes nothing.
 */
async function confirmEnable(deps: ApprovalDependencies, record: ApprovalRecord): Promise<void> {
  const by = decider(record);
  const subject = record.subject as Extract<ApprovalRecord["subject"], { kind: "trigger_enable" }>;
  const routeDeps = deps as Deps;
  const store = storeOf(routeDeps);
  const trigger = await store.get(record.orgId, subject.triggerId);
  if (trigger === undefined) throw agentXError("NOT_FOUND", "this trigger was deleted after it was asked to be turned on");
  if (specDigestOf(trigger) !== subject.specDigest) throw stale();
  if (trigger.enabled && trigger.createdBy === record.requestedBy) {
    await healIndexIfOn(routeDeps, trigger);
    await syncSchedule(routeDeps, trigger, false);
    return;
  }
  // Only the latest request, made for the revision the trigger is at, turns it on (a turn-off or a newer request moved it on, whether or not the close was written).
  if (trigger.pendingApprovalId !== record.approvalId || trigger.revision !== subject.triggerRevision) throw stale();
  const next: TriggerRecord = { ...trigger, createdBy: record.requestedBy, enabled: true };
  const [problem] = await triggerProblems(routeDeps, next);
  if (problem !== undefined) throw triggerProblemError(problem);
  await healIndexIfOn(routeDeps, next);
  let written: TriggerRecord;
  try {
    written = await store.update({
      trigger, patch: { enabled: true, createdBy: record.requestedBy }, clear: ["disabledReason", "pendingApprovalId"],
      extra: targetEventItem(routeDeps, record.orgId, trigger.target, "trigger_enabled", { triggerId: trigger.triggerId, by }),
    });
  } catch (error) {
    if (isTriggerConflict(error)) throw stale();
    throw error;
  }
  await syncSchedule(routeDeps, written, false);
}

/** Whether `caller` may turn the trigger on now: `manage` on its target and `edit_settings` on its project (for a built-in, with `start_tasks`), read now (R68). */
async function mayEnable(deps: ApprovalDependencies, record: ApprovalRecord, caller: AgentCaller): Promise<boolean> {
  const triggerId = (record.subject as { triggerId?: unknown }).triggerId;
  if (caller.orgId !== record.orgId || typeof triggerId !== "string") return false;
  const routeDeps = deps as Deps;
  const trigger = await routeDeps.triggers?.get(record.orgId, triggerId);
  if (trigger === undefined) return false;
  const orgRole = await orgRoleOf(deps, record.orgId, caller.developerId);
  if (orgRole === undefined) return false;
  const role = await deps.projectMembers.roleOf(record.orgId, trigger.project, { developerId: await resolveSurvivor(deps, record.orgId, caller.developerId), orgRole });
  if (role === undefined || !projectAllows(role, "edit_settings")) return false;
  if (trigger.target.kind === "chain") {
    const chain = await deps.chains?.get(record.orgId, trigger.target.chainId);
    return chain !== undefined && deps.chains !== undefined && atLeast(await chainAccess({ ...deps, store: deps.chains }, caller, chain), "manage");
  }
  if (isBuiltinAgentId(trigger.target.agentId)) return projectAllows(role, "start_tasks");
  const agent = await deps.store.get(record.orgId, trigger.target.agentId);
  return agent !== undefined && atLeast(await agentAccess(deps, caller, agent), "manage");
}

/** Registers what makes a turn-on confirmable: the `trigger_enable` rule (evaluated live) and the handler for its subject. Safe to call more than once. */
export function registerTriggerApprovals(): void {
  registerApproverRule("trigger_enable", mayEnable);
  registerApprovalSubjectHandler("trigger_enable", (deps, record) => confirmEnable(deps, record as ApprovalRecord));
}

registerTriggerApprovals();
