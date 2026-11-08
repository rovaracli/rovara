// Setup and test health SH17 (owner decision F4, option D): the company setting "always two people" for "Mark as known failing". OFF by default. With it ON, every mark needs a second, different maintainer or admin, with
// the same sole-owner exception rule as every other second-person approval. It is the SAME shape as the company's sole-owner switch (lessons/sole-owner-switch.ts `setSoleOwnerSwitch` / `approveSoleOwnerSwitch`), reused
// as it is rather than built again:
//   - turning it ON is the STRICTER direction: it applies at once, by an eligible admin, audited (an audit outage never blocks the stricter side);
//   - turning it OFF is a LOOSENING: it opens a proposal that a DIFFERENT eligible admin approves, and the sole-owner exception does not apply to loosening it (the one-admin rule: a company of one that turned it on keeps it on
//     unless a second admin joins). Every write is conditional on the value it was made against and fenced on the membership the decision rested on.
// The shared functions keep the switch as "may one person decide" (`enabled`, ON when never set); this module stores that value and shows it the other way round: `alwaysTwoPeople = !enabled`. A value that cannot be
// read counts as "always two people" (fail closed: the stricter side).
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { orgMetaKey, type AuditEventInput } from "@agentx/contracts";
import { auditEventId } from "@agentx/contracts";
import { secondPersonTier0Authority } from "../lessons/tier0-authority.js";
import { approveSoleOwnerSwitch, setSoleOwnerSwitch, type SoleOwnerSwitchChange, type SoleOwnerSwitchDeps, type SoleOwnerSwitchStore, type Tier0Authority, type Tier0Failure, type Tier0Fence } from "../lessons/sole-owner-switch.js";
import type { LessonAuditEvent, LessonAuditSink } from "../lessons/ports.js";
import type { TransactItem } from "../audit/outbox.js";
import type { SecondPersonEvidenceDependencies } from "./second-person-evidence.js";

type Item = Record<string, unknown>;
export interface PolicyTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
const SETTING_SK = "KNOWNFAILING#POLICY";
const CHANGE_PREFIX = "KNOWNFAILING#POLICYCHANGE#";
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
const changeKey = (orgId: string, id: string) => ({ pk: orgPk(orgId), sk: `${CHANGE_PREFIX}${id.replace(/#/gu, "_")}` });
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** The stored switch (`enabled`: one person may decide) and its proposals, in the State table beside the company's other settings. `write` is internal to the two functions below. */
export class KnownFailingPolicyStore implements SoleOwnerSwitchStore {
  constructor(private readonly table: PolicyTable) {}
  private async item(key: { pk: string; sk: string }): Promise<Item | undefined> {
    return (await this.table.documentClient.send(new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
  }
  async read(workspaceId: string): Promise<boolean> {
    const item = await this.item({ pk: orgPk(workspaceId), sk: SETTING_SK });
    if (item === undefined) return true;
    if (typeof item.enabled !== "boolean") throw new Error("the stored setting is not valid");
    return item.enabled;
  }
  async write(workspaceId: string, enabled: boolean, meta: { by: string; at: number }, from: boolean, fence?: Tier0Fence): Promise<boolean> {
    const put = {
      TableName: this.table.tableName, Item: { pk: orgPk(workspaceId), sk: SETTING_SK, entityType: "KNOWN_FAILING_POLICY", enabled, updatedAt: meta.at },
      ConditionExpression: from ? "attribute_not_exists(pk) OR #e = :from" : "#e = :from", ExpressionAttributeNames: { "#e": "enabled" }, ExpressionAttributeValues: { ":from": from },
    };
    try {
      if (fence?.conditions !== undefined && fence.conditions.length > 0) await this.table.documentClient.send(new TransactWriteCommand({ TransactItems: [...(fence.conditions as TransactItem[]), { Put: put }] }));
      else await this.table.documentClient.send(new PutCommand(put));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException" || errorName(error) === "TransactionCanceledException") return false;
      throw error;
    }
  }
  async create(change: SoleOwnerSwitchChange): Promise<boolean> {
    try {
      await this.table.documentClient.send(new PutCommand({ TableName: this.table.tableName, Item: { ...changeKey(change.workspaceId, change.id), entityType: "KNOWN_FAILING_POLICY_CHANGE", ...structuredClone(change) }, ConditionExpression: "attribute_not_exists(pk)" }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
  private parse(item: Item | undefined): SoleOwnerSwitchChange | undefined {
    if (item?.entityType !== "KNOWN_FAILING_POLICY_CHANGE" || typeof item.id !== "string" || typeof item.workspaceId !== "string" || typeof item.from !== "boolean" || typeof item.to !== "boolean") return undefined;
    if (item.state !== "pending" && item.state !== "applied" && item.state !== "cancelled") return undefined;
    if (typeof item.proposedBy !== "string" || typeof item.at !== "number" || typeof item.expiresAt !== "number") return undefined;
    return { id: item.id, workspaceId: item.workspaceId, from: item.from, to: item.to, proposedBy: item.proposedBy, at: item.at, expiresAt: item.expiresAt, state: item.state };
  }
  async get(workspaceId: string, id: string): Promise<SoleOwnerSwitchChange | undefined> { return this.parse(await this.item(changeKey(workspaceId, id))); }
  async open(workspaceId: string, now: number): Promise<SoleOwnerSwitchChange | undefined> {
    const response = await this.table.documentClient.send(new QueryCommand({
      TableName: this.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, ExpressionAttributeValues: { ":pk": orgPk(workspaceId), ":p": CHANGE_PREFIX },
    })) as { Items?: Item[] };
    return (response.Items ?? []).map((i) => this.parse(i)).find((c) => c !== undefined && c.state === "pending" && c.expiresAt > now);
  }
  async transition(workspaceId: string, id: string, from: SoleOwnerSwitchChange["state"], to: SoleOwnerSwitchChange["state"]): Promise<boolean> {
    try {
      await this.table.documentClient.send(new UpdateCommand({
        TableName: this.table.tableName, Key: changeKey(workspaceId, id), UpdateExpression: "SET #s = :to", ConditionExpression: "#s = :from", ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":to": to, ":from": from },
      }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
}

/** Whether every mark needs a second person in this company. Unreadable counts as yes (the stricter side). */
export async function alwaysTwoPeople(table: PolicyTable | PolicyStoreLike, orgId: string): Promise<boolean> {
  try { return !(await ("read" in table ? table : new KnownFailingPolicyStore(table)).read(orgId)); } catch { return true; }
}
type PolicyStoreLike = Pick<SoleOwnerSwitchStore, "read">;

/** The shared switch's audit events, written under this setting's own ledger names (the shared names would record a change of the sole-owner switch). Anything else the shared code might emit is refused. */
export function knownFailingPolicyAuditSink(write: (event: AuditEventInput) => Promise<void>, now: () => number): LessonAuditSink {
  let counter = 0;
  return {
    async emit(event: LessonAuditEvent) {
      const actor = typeof event.actor === "string" && /^[a-f0-9]{64}$/u.test(event.actor) ? { kind: "member" as const, id: event.actor } : { kind: "system" as const, id: "rovara" as const };
      const at = new Date(now()).toISOString();
      counter += 1;
      const base = { orgId: event.workspaceId, actor, target: { kind: "org" as const, id: event.workspaceId.slice(0, 100) }, occurredAt: at };
      const from = event.facts["from"] === true, to = event.facts["to"] === true;
      if (event.action === "lesson.sole_owner_switch_proposed") {
        await write({ ...base, eventId: auditEventId("company.known_failing_policy_proposed", event.workspaceId, at, String(counter)), action: "company.known_failing_policy_proposed", facts: { fromAlwaysTwo: !from, toAlwaysTwo: !to } });
      } else if (event.action === "lesson.sole_owner_switch_changed") {
        await write({ ...base, eventId: auditEventId("company.known_failing_policy_changed", event.workspaceId, at, String(counter)), action: "company.known_failing_policy_changed", facts: { fromAlwaysTwo: !from, toAlwaysTwo: !to, mode: event.facts["mode"] === "direct" ? "direct" : "second_person" } });
      } else if (event.action === "lesson.tier0_setting_refused_retryable") {
        await write({ ...base, eventId: auditEventId("company.known_failing_policy_refused", event.workspaceId, at, String(counter)), action: "company.known_failing_policy_refused", facts: { refusal: "membership_changed_retry" } });
      } else throw new Error("the ledger has no name for this setting's event");
    },
  };
}

export interface KnownFailingPolicyDeps {
  table: PolicyTable;
  /** The company's records, as the shared second-person evidence reads them. */
  evidence: SecondPersonEvidenceDependencies;
  audit: LessonAuditSink;
  now(): number;
  newId?: () => string;
  /** For tests: replaces the authority built from `evidence`. */
  authority?: Tier0Authority;
}
const switchDeps = (deps: KnownFailingPolicyDeps): SoleOwnerSwitchDeps => ({
  store: new KnownFailingPolicyStore(deps.table), audit: deps.audit, authority: deps.authority ?? secondPersonTier0Authority(deps.evidence), now: () => deps.now(), ...(deps.newId === undefined ? {} : { newId: deps.newId }),
});

export type PolicyRequest = { ok: true; status: "applied"; alwaysTwoPeople: boolean } | { ok: true; status: "needs_approval"; changeId: string } | { ok: false; code: Tier0Failure };

/** Asks to set "always two people". ON applies now (stricter); OFF opens a proposal for a DIFFERENT eligible admin. Only a company admin (the shared authority) may ask. */
export async function setAlwaysTwoPeople(deps: KnownFailingPolicyDeps, input: { orgId: string; alwaysTwo: boolean; requestedBy: string }): Promise<PolicyRequest> {
  const result = await setSoleOwnerSwitch(switchDeps(deps), { workspaceId: input.orgId, enabled: !input.alwaysTwo, requestedBy: input.requestedBy });
  return result.ok && result.status === "applied" ? { ok: true, status: "applied", alwaysTwoPeople: !result.enabled } : result;
}

/** A different eligible admin approves turning "always two people" OFF. The proposer can never approve it and the sole-owner exception does not apply. */
export async function approveAlwaysTwoPeopleOff(deps: KnownFailingPolicyDeps, input: { orgId: string; changeId: string; approverId: string }): Promise<{ ok: true; alwaysTwoPeople: boolean } | { ok: false; code: Tier0Failure }> {
  const result = await approveSoleOwnerSwitch(switchDeps(deps), { workspaceId: input.orgId, changeId: input.changeId, approverId: input.approverId });
  return result.ok ? { ok: true, alwaysTwoPeople: !result.enabled } : result;
}
