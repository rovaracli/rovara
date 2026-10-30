// v1.2 learning loop: the company's master "suggestions" switch (owner decision 2026-10-30: suggestions stay OFF for pilots while capture keeps running).
//
// The value in force (`effectiveSuggestions`) is the company's own record (`ORG#<org>` / `LEARNING_SETTINGS`) when it has one, otherwise the install-wide default. The install default is
// deployment config, not a runtime setting: the control plane's stack parameter `LearningSuggestionsDefault` (off unless an operator sets it) reaches the broker in its packed settings
// (AGENTX_SETTINGS, code "lg"), which hydrate `LEARNING_SUGGESTIONS_DEFAULT`. Only the exact word "on" turns it on.
//
// While the value is off: grouping does nothing (grouping.ts asks `suggestionsOff` first), Home makes no card, the project view and overview report `collecting`, and Accept, Dismiss and
// Reopen answer 409 LEARNING_SUGGESTIONS_OFF (decide.ts). Capture, settlement of waiting rules, rules, rollback and remove are never gated.
//
// A record that does not read (an unknown value from a newer writer) is skipped: the install default applies, as for a company that never chose.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  LearningCompanySettingsSchema, LearningSuggestionSwitchSchema, agentXError, orgLearningSettingsKey,
  type AuditActor, type LearningCompanySettingsAnswer, type LearningSuggestionSwitch, type OrgId,
} from "@agentx/contracts";
import { flushLearningEvents, learningEvents, suggestionsSetEvent } from "./audit.js";
import type { LearningDeps, LearningScope } from "./store.js";

/** The variable the broker's packed settings hydrate (broker-names.ts, code "lg"). */
export const SUGGESTIONS_DEFAULT_VARIABLE = "LEARNING_SUGGESTIONS_DEFAULT";

type Item = Record<string, unknown>;
interface Table { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** The install-wide default: off unless the deployment says exactly `on`. */
export function installSuggestionsDefault(environment: Record<string, string | undefined> = process.env): LearningSuggestionSwitch {
  return environment[SUGGESTIONS_DEFAULT_VARIABLE] === "on" ? "on" : "off";
}

export interface EffectiveSuggestions {
  suggestions: LearningSuggestionSwitch;
  source: "company" | "install_default";
  /** 0 while there is no company record. */
  revision: number;
}

/** The value in force given the company's stored item (or none). A record that does not read counts as none, but keeps its revision so a write can replace it. */
export function effectiveFromItem(item: Item | undefined, environment: Record<string, string | undefined> = process.env): EffectiveSuggestions {
  const parsed = LearningCompanySettingsSchema.safeParse(item);
  if (parsed.success) return { suggestions: parsed.data.suggestions, source: "company", revision: parsed.data.revision };
  return { suggestions: installSuggestionsDefault(environment), source: "install_default", revision: 0 };
}

export async function readCompanySettingsItem(table: Table, orgId: OrgId): Promise<Item | undefined> {
  const found = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: orgLearningSettingsKey(orgId), ConsistentRead: true })) as { Item?: Item };
  return found.Item;
}

/** The value in force for a company now. */
export async function effectiveSuggestions(table: Table, orgId: OrgId, environment?: Record<string, string | undefined>): Promise<EffectiveSuggestions> {
  return effectiveFromItem(await readCompanySettingsItem(table, orgId), environment);
}

/** Grouping's default `suggestionsOff`: whether the company's effective switch is off. */
export async function suggestionsOff(deps: Pick<LearningDeps, "documentClient" | "tableName">, scope: Pick<LearningScope, "orgId">): Promise<boolean> {
  return (await effectiveSuggestions(deps, scope.orgId)).suggestions === "off";
}

/** Refuses a suggestion decision while the switch is off. */
export async function requireSuggestionsOn(deps: Pick<LearningDeps, "documentClient" | "tableName">, orgId: OrgId): Promise<void> {
  if ((await effectiveSuggestions(deps, orgId)).suggestions === "off") {
    throw agentXError("LEARNING_SUGGESTIONS_OFF", "Suggested rules are turned off for your company. Rovara is still collecting corrections.");
  }
}

export const canChangeSuggestions = (orgRole: string): boolean => orgRole === "owner" || orgRole === "admin";

/** The answer of GET and PUT `/v1/app/org/learning-settings`. */
export function settingsAnswer(effective: EffectiveSuggestions, orgRole: string): LearningCompanySettingsAnswer {
  return { suggestions: effective.suggestions, source: effective.source, revision: effective.revision, canChange: canChangeSuggestions(orgRole) };
}

const changed = () => agentXError("LEARNING_SETTINGS_CHANGED", "Someone else changed this setting. Refresh the page and try again.");
const isCancellation = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");

/**
 * Writes the company's switch. `expectedRevision` is what the caller read (0 while there is no record): the write is conditioned on it, so a stale one is
 * LEARNING_SETTINGS_CHANGED and the first write from the install default creates the record at revision 1. The audit event goes in the same transaction, in both directions. Writing
 * the value already in force still moves the revision (the event then says previous equals setting), so a double click is never a change the audit cannot see.
 */
export async function putSuggestionsSwitch(
  deps: Table & Pick<LearningDeps, "now" | "audit">,
  input: { orgId: OrgId; actor: AuditActor; developerId: string; expectedRevision: number; suggestions: LearningSuggestionSwitch },
): Promise<EffectiveSuggestions> {
  const suggestions = LearningSuggestionSwitchSchema.parse(input.suggestions);
  const current = effectiveFromItem(await readCompanySettingsItem(deps, input.orgId));
  if (current.revision !== input.expectedRevision) throw changed();
  const revision = input.expectedRevision + 1;
  const key = orgLearningSettingsKey(input.orgId);
  const at = new Date(deps.now()).toISOString();
  const learning: LearningDeps = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  const audited = await learningEvents(learning, () => [suggestionsSetEvent(learning, { orgId: input.orgId, actor: input.actor, revision, setting: suggestions, previous: current.suggestions })]);
  const write = input.expectedRevision === 0
    ? {
      // The first write: there is no record yet (a record that does not read, such as an unknown value, is replaced).
      Put: {
        TableName: deps.tableName,
        Item: { ...key, entityType: "LEARNING_COMPANY_SETTINGS", orgId: input.orgId, revision, suggestions, changedBy: input.developerId, changedAt: at },
        ConditionExpression: "attribute_not_exists(pk) OR attribute_not_exists(#revision) OR (#suggestions <> :on AND #suggestions <> :off)",
        ExpressionAttributeNames: { "#revision": "revision", "#suggestions": "suggestions" }, ExpressionAttributeValues: { ":on": "on", ":off": "off" },
      },
    }
    : {
      // Update, not Put: a field a newer writer added stays.
      Update: {
        TableName: deps.tableName, Key: key,
        UpdateExpression: "SET suggestions = :suggestions, #revision = :next, changedBy = :by, changedAt = :at",
        ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":suggestions": suggestions, ":next": revision, ":by": input.developerId, ":at": at, ":expected": input.expectedRevision },
      },
    };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [write, ...audited.items] }));
  } catch (error) {
    if (isCancellation(error)) throw changed();
    throw error;
  }
  await flushLearningEvents(learning, audited.events);
  return { suggestions, source: "company", revision };
}
