// What happens to triggers when something they depend on changes (Plan 4 Task 18). A change to a target (a publish, a rollback, a budget, an archive, a roster change, a
// built-in's pin or its being turned off) re-checks every enabled trigger of the target against what runs now, and turns off the ones that no longer qualify, telling their
// owners; the change that caused it still succeeds. A member who leaves or is merged hands their triggers on, or turns them off and says so: nothing fails silently.
import { randomBytes } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApprovalIdSchema, BUILTIN_AGENT_IDS, agentKey, approvalKey, chainKey, isBuiltinAgentId, orgPk, type OrgId, type TriggerTarget } from "@rovara-code/contracts";
import { shownText } from "../agents/approvals.js";
import { approverDrops, commitOrLost, dueItems, getAnyApproval, type ApprovalDependencies } from "../agents/approvals-store.js";
import { Aliases, type TransactItem } from "../agents/table-writes.js";
import { auditApprovalExpired } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { neutralText } from "../chains/run-events.js";
import { checkTime, registerMemberMover, resolveMember } from "../agents/lifecycle.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import { displayNameOf } from "../chains/gates.js";
import type { ChainTriggerHooks } from "../chains/routes.js";
import type { DisabledTrigger, TriggerHooks } from "./ports.js";
import { ownerQualifies, targetName, triggerProblemText, triggerProblems, triggerWords, type TriggerProblem } from "./requirements.js";
import { isTriggerConflict, type TriggerRecord, type TriggerStore } from "./store.js";

type Deps = AgentRouteDependencies;

const SYSTEM = "system";
const REASON_MAX = 300;
const NAME_MAX = 80;
const MAX_RETRIES = 3;

const log = (deps: Pick<Deps, "log">, event: string, fields: Record<string, unknown>): void =>
  (deps.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const trimStop = (text: string): string => text.replace(/\.+$/u, "");

function storeOf(deps: Pick<Deps, "triggers">): TriggerStore {
  if (deps.triggers === undefined) throw new Error("triggers are not set up in this deployment");
  return deps.triggers;
}

/** The people a target's triggers answer to besides their creators: the owner of a member's, the accountable maintainer of a project's (a built-in has the one an admin named, if any). */
async function ownersOfTarget(deps: Deps, orgId: OrgId, target: TriggerTarget): Promise<string[]> {
  if (target.kind === "chain") {
    const chain = await deps.chains?.get(orgId, target.chainId);
    if (chain === undefined) return [];
    return chain.owner.kind === "member" ? [chain.owner.developerId] : chain.accountable === undefined ? [] : [chain.accountable.developerId];
  }
  if (isBuiltinAgentId(target.agentId)) {
    const settings = await deps.store.getBuiltinSettings(orgId, target.agentId);
    return settings?.accountable === undefined ? [] : [settings.accountable.developerId];
  }
  const agent = await deps.store.get(orgId, target.agentId);
  if (agent === undefined) return [];
  return agent.owner.kind === "member" ? [agent.owner.developerId] : agent.accountable === undefined ? [] : [agent.accountable.developerId];
}

async function uniqueMembers(deps: Deps, orgId: OrgId, ids: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const id of ids) {
    const member = await resolveMember(deps, orgId, id);
    if (!found.includes(member)) found.push(member);
  }
  return found;
}

/** The item a target's own event log gets: what happened to one of its triggers (the log is the target's, so the item is under its key). Built-ins have no log. */
export function targetEventItem(deps: Pick<Deps, "tableName" | "now">, orgId: OrgId, target: TriggerTarget, kind: string, detail: Record<string, unknown>): TransactItem[] {
  if (target.kind === "agent" && isBuiltinAgentId(target.agentId)) return [];
  const at = new Date(deps.now()).toISOString();
  const sk = `EVENT#${at}#t${randomBytes(4).toString("hex")}` as const;
  const [key, entityType, idField, id] = target.kind === "chain"
    ? [chainKey(orgId, target.chainId, sk), "CHAIN_EVENT", "chainId", target.chainId] as const
    : [agentKey(orgId, target.agentId, sk), "AGENT_EVENT", "agentId", target.agentId] as const;
  return [{ Put: { TableName: deps.tableName, Item: { ...key, entityType, orgId, [idField]: id, kind, at, by: SYSTEM, ...detail } } }];
}

// ---- turning a trigger off

/**
 * Turns one trigger off with the reason of the first problem it has: a conditional update to `enabled: false` with `disabledReason`, an activity item `disabled` and the notices to
 * its creator and the target's owner, in one transaction; then, for a schedule trigger, its schedule is set `DISABLED`. A trigger already off is left as it is. `plainReason`
 * names the reason without the problem's path, and `alsoTell` adds people to the notice (the project's maintainers and the org's owners, when nobody could own the trigger).
 */
export async function disableTrigger(deps: Deps, trigger: TriggerRecord, problems: readonly TriggerProblem[], options: { alsoTell?: readonly string[] } = {}): Promise<void> {
  const store = storeOf(deps);
  const first = problems[0];
  if (first === undefined) return;
  let current: TriggerRecord | undefined = trigger;
  for (let attempt = 0; attempt < MAX_RETRIES && current !== undefined; attempt += 1) {
    if (!current.enabled) return;
    const reason = shownText(triggerProblemText(first), REASON_MAX);
    const name = shownText(await targetName(deps, current.orgId, current.target), NAME_MAX);
    const text = `${name}'s trigger "${triggerWords(current)}" was turned off: ${trimStop(reason)}.`;
    const recipients = await uniqueMembers(deps, current.orgId, [current.createdBy, ...await ownersOfTarget(deps, current.orgId, current.target), ...(options.alsoTell ?? [])]);
    const extra: TransactItem[] = [
      store.activityItem(current.orgId, current.triggerId, { eventKey: `disabled#${String(current.revision)}`, outcome: "disabled", reason }),
      ...recipients.flatMap((developerId) => store.noticeItems(current!.orgId, current!.triggerId, developerId, text)),
      ...targetEventItem(deps, current.orgId, current.target, "trigger_disabled", { triggerId: current.triggerId, reason }),
    ];
    try {
      await store.update({ trigger: current, patch: { enabled: false, disabledReason: reason }, extra });
      break;
    } catch (error) {
      if (!isTriggerConflict(error)) throw error;
      current = await store.get(current.orgId, current.triggerId);
    }
  }
  if (trigger.spec.kind === "schedule") {
    // The schedule is set DISABLED; dispatch of a due schedule asks `triggerProblems` and the trigger's own flag again, so one that could not be reached is still not started.
    await deps.triggerSchedules?.disable({ orgId: trigger.orgId, triggerId: trigger.triggerId }).catch((error: unknown) => { log(deps, "trigger_schedule.disable_failed", { orgId: trigger.orgId, triggerId: trigger.triggerId, error: errorName(error) }); });
  }
}

/** Re-checks every enabled trigger of the target and turns off the ones that no longer qualify. Answers the ones it turned off. A trigger that can't be checked now is left for dispatch to check. */
export async function recheckTriggersForTarget(deps: Deps, orgId: OrgId, target: TriggerTarget): Promise<DisabledTrigger[]> {
  if (deps.triggers === undefined) return [];
  const turnedOff: DisabledTrigger[] = [];
  for (const trigger of await deps.triggers.listForTarget(orgId, target)) {
    if (!trigger.enabled) continue;
    try {
      const problems = await triggerProblems(deps, trigger);
      if (problems.length === 0) continue;
      await disableTrigger(deps, trigger, problems);
      turnedOff.push({ triggerId: trigger.triggerId, problems: problems.map((problem) => ({ path: problem.path, message: triggerProblemText(problem) })) });
    } catch (error) {
      // The change this follows has been made: a trigger that could not be looked at now is looked at again before its next start.
      log(deps, "trigger_recheck.failed", { orgId, triggerId: trigger.triggerId, error: errorName(error) });
    }
  }
  return turnedOff;
}

/** Turns off every trigger of an archived target; unarchiving turns none back on, a person does that. */
export async function disableTargetTriggers(deps: Deps, orgId: OrgId, target: TriggerTarget): Promise<void> {
  if (deps.triggers === undefined) return;
  const name = shownText(await targetName(deps, orgId, target), NAME_MAX);
  for (const trigger of await deps.triggers.listForTarget(orgId, target)) {
    if (trigger.enabled) await disableTrigger(deps, trigger, [{ path: "target", code: "CHAIN_UNAVAILABLE", message: `${name} was archived` }]);
  }
}

/**
 * Removes everything of an org's triggers (it closed): first the schedules of its schedule triggers at the scheduler, then the triggers themselves. A schedule that can't be deleted
 * stops the close before any trigger is, so closing again finds them and finishes (a schedule left behind would fire at nothing).
 */
export async function deleteOrgTriggers(deps: Pick<Deps, "triggers" | "triggerSchedules">, orgId: OrgId): Promise<void> {
  if (deps.triggers === undefined) return;
  if (deps.triggerSchedules !== undefined) {
    let failed: unknown;
    for (const trigger of await deps.triggers.listAll(orgId)) {
      if (trigger.spec.kind !== "schedule") continue;
      try {
        await deps.triggerSchedules.remove({ orgId, triggerId: trigger.triggerId });
      } catch (error) {
        failed ??= error;
      }
    }
    if (failed !== undefined) throw failed instanceof Error ? failed : new Error("a schedule could not be deleted");
  }
  await deps.triggers.deleteOrg(orgId);
}

/** The hooks the agent routes, the chain routes and the confirmations call (one line each), over the route dependencies. */
export function triggerHooksFor(deps: Deps): TriggerHooks {
  return {
    hasEnabledTriggers: async (orgId, target) => (await deps.triggers?.listForTarget(orgId, target))?.some((trigger) => trigger.enabled) === true,
    recheckTriggersForTarget: (orgId, target) => recheckTriggersForTarget(deps, orgId, target),
    disableTriggersForTarget: (orgId, target) => disableTargetTriggers(deps, orgId, target),
    recheckBuiltinTriggers: (orgId) => recheckBuiltinTriggers(deps, orgId),
  };
}

/** The same, in the shape the chain routes already take. */
export function chainTriggerHooksFor(deps: Deps): ChainTriggerHooks {
  const hooks = triggerHooksFor(deps);
  return {
    hasEnabledTriggers: (orgId, chainId) => hooks.hasEnabledTriggers(orgId, { kind: "chain", chainId }),
    recheckTriggersForTarget: (orgId, target) => hooks.recheckTriggersForTarget(orgId, target),
    disableTriggersForTarget: (orgId, target) => hooks.disableTriggersForTarget(orgId, target),
  };
}

/** Rechecks the triggers of every built-in agent: the company turned some off or on, or moved a pin. */
export async function recheckBuiltinTriggers(deps: Deps, orgId: OrgId): Promise<DisabledTrigger[]> {
  const all: DisabledTrigger[] = [];
  for (const agentId of BUILTIN_AGENT_IDS) all.push(...await recheckTriggersForTarget(deps, orgId, { kind: "agent", agentId }));
  return all;
}

// ---- when a member leaves or is merged

/** The members of the org with this role, by when they joined (the first owner is who takes over what nobody else can). */
async function orgMembersWithRole(deps: Deps, orgId: OrgId, role: "owner" | "admin", except: string): Promise<string[]> {
  const found: Array<{ developerId: string; joinedAt: string }> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "MEMBER#" }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ developerId?: unknown; role?: unknown; joinedAt?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (item.role === role && typeof item.developerId === "string" && item.developerId !== except) found.push({ developerId: item.developerId, joinedAt: String(item.joinedAt) });
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return found.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.developerId.localeCompare(b.developerId)).map((member) => member.developerId);
}

const orgOwners = (deps: Deps, orgId: OrgId, except: string): Promise<string[]> => orgMembersWithRole(deps, orgId, "owner", except);

/** How many org admins are told when a trigger is turned off in an org with no owner left: the longest-standing ones. */
const ADMINS_TOLD_MAX = 5;

/** The maintainers of the project, in the order the project lists them, grants first, who could be asked to take a trigger. */
async function projectMaintainers(deps: Deps, orgId: OrgId, project: string): Promise<string[]> {
  return (await deps.projectMembers.list(orgId, project)).filter((member) => member.role === "maintainer" && member.source === "grant").map((member) => member.developerId);
}

/**
 * Who a trigger moves to when its creator `leaving` goes: the target's accountable maintainer when the target is a project's and they qualify, else the first maintainer of the
 * project by grant who does, else the first org owner who does. Qualifying is `triggerProblems`' owner rule (`ownerQualifies`).
 */
async function successorOf(deps: Deps, trigger: TriggerRecord, leaving: string): Promise<string | undefined> {
  const { orgId } = trigger;
  const owners = await ownersOfTarget(deps, orgId, trigger.target);
  const targetIsProjects = trigger.target.kind === "chain"
    ? (await deps.chains?.get(orgId, trigger.target.chainId))?.owner.kind === "project"
    : !isBuiltinAgentId(trigger.target.agentId) && (await deps.store.get(orgId, trigger.target.agentId))?.owner.kind === "project";
  const ordered = [...(targetIsProjects ? owners : []), ...await projectMaintainers(deps, orgId, trigger.project), ...await orgOwners(deps, orgId, leaving)];
  for (const candidate of await uniqueMembers(deps, orgId, ordered)) {
    if (candidate === leaving || await resolveMember(deps, orgId, leaving) === candidate) continue;
    if (await ownerQualifies(deps, trigger, candidate)) return candidate;
  }
  return undefined;
}

/**
 * A member left. Each trigger they created moves to the project's accountable maintainer (see `successorOf`), with an activity item, a notice to the new creator and an event
 * on the target. When nobody qualifies the trigger is turned off with the reason `no remaining member could own this trigger`, and the project's maintainers and the org's
 * owners are told. Repeatable: a trigger that has moved is no longer theirs.
 */
export async function onTriggerOwnersRemoved(deps: Deps, input: { orgId: OrgId; developerId: string }): Promise<void> {
  const store = storeOf(deps);
  const { orgId, developerId } = input;
  const removedName = shownText(await displayNameOf(deps, developerId), NAME_MAX);
  for (const listed of await store.listByCreator(orgId, developerId)) {
    checkTime(deps);
    for (let attempt = 0, trigger: TriggerRecord | undefined = listed; attempt < MAX_RETRIES && trigger !== undefined && trigger.createdBy === developerId; attempt += 1) {
      const successor = await successorOf(deps, trigger, developerId);
      if (successor === undefined) {
        const [maintainers, owners] = [await projectMaintainers(deps, orgId, trigger.project), await orgOwners(deps, orgId, developerId)];
        // With no owner left (the last one is the one who left) the org's admins are the people to tell: nobody else could turn the trigger back on or give it away.
        const tell = [...maintainers, ...(owners.length > 0 ? owners : (await orgMembersWithRole(deps, orgId, "admin", developerId)).slice(0, ADMINS_TOLD_MAX))];
        if (tell.length === 0 && trigger.enabled) log(deps, "trigger.no_one_to_tell", { orgId, triggerId: trigger.triggerId });
        await disableTrigger(deps, trigger, [{ path: "", message: "no remaining member could own this trigger" }], { alsoTell: tell });
        // The creator is the one who left: the trigger stays listed under them until someone qualifying is found, which a later merge or removal pass can still do.
        break;
      }
      const name = shownText(await targetName(deps, orgId, trigger.target), NAME_MAX);
      const text = `${shownText(await displayNameOf(deps, successor), NAME_MAX)} now owns trigger "${triggerWords(trigger)}" on ${name} because ${removedName} left.`;
      try {
        await store.update({
          trigger, patch: { createdBy: successor },
          extra: [
            store.activityItem(orgId, trigger.triggerId, { eventKey: `owner_moved#${String(trigger.revision)}`, outcome: "skipped", reason: text }),
            ...store.noticeItems(orgId, trigger.triggerId, successor, text),
            ...targetEventItem(deps, orgId, trigger.target, "trigger_owner_changed", { triggerId: trigger.triggerId, from: developerId, to: successor }),
          ],
        });
        break;
      } catch (error) {
        if (!isTriggerConflict(error)) throw error;
        trigger = await store.get(orgId, trigger.triggerId);
      }
    }
  }
}

/** Two accounts were found to be one person: the triggers of the duplicate become the survivor's, the index item moving with them. Repeating it changes nothing. */
export async function onTriggerOwnersMerged(deps: Deps, input: { orgId: OrgId; survivorId: string; duplicateId: string }): Promise<void> {
  const store = storeOf(deps);
  const { orgId, survivorId, duplicateId } = input;
  for (const listed of await store.listByCreator(orgId, duplicateId)) {
    checkTime(deps);
    for (let attempt = 0, trigger: TriggerRecord | undefined = listed; attempt < MAX_RETRIES && trigger !== undefined && trigger.createdBy === duplicateId; attempt += 1) {
      try {
        await store.update({ trigger, patch: { createdBy: survivorId } });
        break;
      } catch (error) {
        if (!isTriggerConflict(error)) throw error;
        trigger = await store.get(orgId, trigger.triggerId);
      }
    }
  }
}

/** Registers the trigger movers with Plan 3's member lifecycle: a mover runs for every removal and merge, even when another one failed. Safe to call more than once. */
export function registerTriggerMovers(): () => void {
  return registerMemberMover({
    name: "triggers",
    merged: async (deps, { orgId, survivorId, duplicateId }) => { if ((deps as Deps).triggers !== undefined) await onTriggerOwnersMerged(deps as Deps, { orgId, survivorId, duplicateId }); },
    removed: async (deps, { orgId, developerId }) => { if ((deps as Deps).triggers !== undefined) await onTriggerOwnersRemoved(deps as Deps, { orgId, developerId }); },
    // The org has no owner to hand anything to: the triggers they created still go through the same check, and what nobody can own is turned off with an admin told.
    orphaned: async (deps, { orgId, developerId }) => { if ((deps as Deps).triggers !== undefined) await onTriggerOwnersRemoved(deps as Deps, { orgId, developerId }); },
  });
}

registerTriggerMovers();

// ---- closing a request to turn a trigger on

/**
 * Closes a PENDING request to turn `triggerId` on (review I-3, M-3): one conditional update, `PENDING` to `EXPIRED`, that holds only for a change approval whose subject is
 * this trigger's turn-on in this org, so a wrong id can't close another approval. The record's open item and its approver items go in the same transaction, and it keeps who
 * closed it and why. A confirmation that comes later finds it closed and answers `APPROVAL_CLOSED`. True when this call closed it.
 */
export async function closeTriggerEnableApproval(deps: ApprovalDependencies, orgId: OrgId, triggerId: string, approvalId: string, reason: string): Promise<boolean> {
  const id = ApprovalIdSchema.safeParse(approvalId);
  if (!id.success) return false;
  const record = await getAnyApproval(deps, orgId, id.data);
  if (record === undefined || record.kind !== "change" || record.status !== "PENDING") return false;
  const subject = record.subject as { kind?: unknown; triggerId?: unknown };
  if (subject.kind !== "trigger_enable" || subject.triggerId !== triggerId) return false;
  const at = new Date(deps.now()).toISOString();
  const events = await tryAuditEvents(deps, () => [auditApprovalExpired({
    orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: record.approvalId, approvalId: record.approvalId, kind: record.kind, subjectKind: record.subject.kind,
  })]);
  const aliases = new Aliases();
  const condition = [
    `${aliases.name("status")} = ${aliases.value("PENDING")}`, `${aliases.name("kind")} = ${aliases.value("change")}`, `${aliases.name("orgId")} = ${aliases.value(orgId)}`,
    `${aliases.name("subject")}.${aliases.name("kind")} = ${aliases.value("trigger_enable")}`, `${aliases.name("subject")}.${aliases.name("triggerId")} = ${aliases.value(triggerId)}`,
  ].join(" AND ");
  const fields = { status: "EXPIRED", closedBy: "system", closedReason: neutralText(reason, REASON_MAX), closedAt: at };
  const sets = Object.entries(fields).map(([name, value]) => `${aliases.name(name)} = ${aliases.value(value)}`);
  const items: TransactItem[] = [
    { Update: { TableName: deps.tableName, Key: approvalKey(record.orgId, record.approvalId), UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: condition, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values } },
    ...dueItems(deps, record, [record.expiresAt], undefined),
    ...approverDrops(deps, record),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  if (!await commitOrLost(deps, items)) return false;
  await flushAuditEvents(deps, events);
  return true;
}
