// v1.2 learning loop, B6: settlement of rules (design 5.3). A rule is written `pending` before its publish, becomes `awaiting_approval` when the publish waits for a person, and is settled by what
// happened: published (`active`, the suggestion `accepted`, correction text removed, the metric, `rule.accepted`) or not (`not_applied` after a decline, an expiry or a failed approval, the
// suggestion back to `open`, `rule.not_applied`). Settlement is lazy and idempotent: the learning routes settle the project before they decide anything, and Home hands ended approvals to
// `learningSettler` (home-source.ts). Every move is one transaction conditioned on the rule's current status, so two settlers, a retry and a Home read agree on one outcome.
//
// A rule stuck in `pending` (a crash between the steps of an Accept) is resolved after 10 minutes: if a published version carries the note "Suggested rule <id>" it is `active`, if an approval
// for the same request exists it is `awaiting_approval`, otherwise it was never published and goes back to `open` like a rule that was not applied.
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  LearningCorrectionSchema, LearningRuleSchema, canonicalJson, LearningSuggestionSchema, isTerminalSuggestionStatus, projectLearningKey,
  type LearningCorrection, type LearningRule, type LearningSuggestion, type OrgId,
} from "@agentx/contracts";
import type { ApprovalDependencies } from "../agents/approvals.js";
import { approvalIdFor, getAnyApproval } from "../agents/approvals-store.js";
import type { LearningHomeSettler } from "./home-source.js";
import { appendRuleToOverlay } from "./overlay.js";
import type { ProjectPlaybookDependencies } from "../playbook/routes.js";
import { acceptedEvent, flushLearningEvents, learningEvents, memberActor, notAppliedEvent, rolledBackEvent } from "./audit.js";
import { ensureMetricCurrent, metricMonth, metricUpdateItem } from "./metric.js";
import {
  clearCorrectionText, clearCorrectionTextItem, getLearningItem, readLearningPartition, readLearningState, suggestionSk, terminalSuggestionItems, type LearningDeps, type LearningScope,
} from "./store.js";

type Item = Record<string, unknown>;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

/** What the decisions need: the playbook dependencies (the process layer and the agent store), with the approvals required, and an optional PR-capture check (B8 plugs the company lock in). */
export interface LearningDecideDeps extends ProjectPlaybookDependencies {
  approvals: ApprovalDependencies;
  prCaptureOff?: (deps: LearningDeps, scope: LearningScope) => Promise<boolean>;
}
/** What settlement needs: no caller, no project lookup. */
export type LearningSettleDeps = Pick<LearningDecideDeps, "documentClient" | "tableName" | "now" | "audit" | "approvals">;

/** A rule stuck in `pending` is looked at again after this long. */
export const PENDING_RULE_STUCK_MS = 10 * 60 * 1000;
/** How many published versions back the version carrying a rule's note is looked for. */
const VERSIONS_SCANNED_MAX = 25;

export const ruleSk = (id: string): string => `RULE#${id}`;
export const acceptNote = (ruleId: string): string => `Suggested rule ${ruleId}`;
export const removeNote = (ruleId: string): string => `Removed rule ${ruleId}`;

export const learningOf = (deps: Pick<LearningDecideDeps, "documentClient" | "tableName" | "now" | "audit">): LearningDeps => ({
  documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }),
});
const keyOf = (scope: { orgId: OrgId; project: string }, sk: string) => projectLearningKey(scope.orgId, scope.project, sk);
const isCancellation = (error: unknown): boolean => error instanceof Error && error.name === "TransactionCanceledException";

export function parseRule(item: Item | undefined): LearningRule | undefined {
  if (item === undefined) return undefined;
  const parsed = LearningRuleSchema.safeParse(item);
  return parsed.success ? parsed.data : undefined;
}
export function parseSuggestionItem(item: Item | undefined): LearningSuggestion | undefined {
  if (item === undefined) return undefined;
  const parsed = LearningSuggestionSchema.safeParse(item);
  return parsed.success ? parsed.data : undefined;
}
export async function readRule(learning: LearningDeps, scope: LearningScope, id: string): Promise<LearningRule | undefined> {
  return parseRule(await getLearningItem(learning, scope, ruleSk(id)));
}

/** The corrections of a suggestion that still exist (forgotten and expired ones are absent), with their keys. */
export async function readMembers(learning: LearningDeps, scope: LearningScope, ids: readonly string[]): Promise<Array<{ c: LearningCorrection; sk: string }>> {
  const wanted = new Set(ids);
  const found: Array<{ c: LearningCorrection; sk: string }> = [];
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const page = await readLearningPartition(learning, scope, { prefix: "CORRECTION#", ...(cursor === undefined ? {} : { cursor }), maxItems: 500, maxPages: 1, pageSize: 500 });
    scanned += page.scanned;
    for (const item of page.items) {
      const parsed = LearningCorrectionSchema.safeParse(item);
      if (parsed.success && typeof item["sk"] === "string" && wanted.has(parsed.data.id)) found.push({ c: parsed.data, sk: item["sk"] });
    }
    cursor = page.cursor;
  } while (cursor !== undefined && scanned < 2000 && found.length < wanted.size);
  return found;
}

/** The published version (newest first, a bounded number back) whose note is `note`. */
export async function findVersionByNote(approvals: ApprovalDependencies, rule: Pick<LearningRule, "processAgentId">, orgId: OrgId, note: string): Promise<number | undefined> {
  const agent = await approvals.store.get(orgId, rule.processAgentId);
  if (agent?.currentVersion === undefined) return undefined;
  for (let version = agent.currentVersion, seen = 0; version >= 1 && seen < VERSIONS_SCANNED_MAX; version -= 1, seen += 1) {
    const stored = await approvals.store.getVersion(orgId, rule.processAgentId, version);
    if (stored?.note === note) return version;
  }
  return undefined;
}

// ---- the moves

const stateUpdate = (deps: LearningDeps, scope: LearningScope, deltas: { openSuggestions?: number; pendingRules?: number }): TransactItem => {
  const names = (["openSuggestions", "pendingRules"] as const).filter((name) => (deltas[name] ?? 0) !== 0);
  return {
    Update: {
      TableName: deps.tableName, Key: keyOf(scope, "STATE"), UpdateExpression: `ADD ${names.map((name, index) => `${name} :d${String(index)}`).join(", ")}`,
      ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc",
      ExpressionAttributeValues: { ":pc": scope.projectCreatedAt, ...Object.fromEntries(names.map((name, index) => [`:d${String(index)}`, deltas[name]!])) },
    },
  };
};

/** A rule move: `to` is the new `status`; `set` holds other fields to set, `remove` fields to remove. It holds only while the rule is in one of the `from` states. */
function ruleTransition(deps: LearningDeps, scope: LearningScope, id: string, from: readonly string[], to: string, set: Record<string, unknown> = {}, remove: readonly string[] = []): TransactItem {
  const names = Object.keys(set);
  return {
    Update: {
      TableName: deps.tableName, Key: keyOf(scope, ruleSk(id)),
      UpdateExpression: `SET #status = :to${names.map((name) => `, ${name} = :v_${name}`).join("")}${remove.length === 0 ? "" : ` REMOVE ${remove.join(", ")}`}`,
      ConditionExpression: `attribute_exists(pk) AND projectCreatedAt = :pc AND (${from.map((_, index) => `#status = :from${String(index)}`).join(" OR ")})`,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pc": scope.projectCreatedAt, ":to": to, ...Object.fromEntries(from.map((status, index) => [`:from${String(index)}`, status])),
        ...Object.fromEntries(names.map((name) => [`:v_${name}`, set[name]])),
      },
    },
  };
}

/** The suggestion goes back to `open` (a rule that was not applied): same content, one revision on, `ruleId` gone. */
export function reopenSuggestionItem(deps: LearningDeps, scope: LearningScope, suggestion: LearningSuggestion): TransactItem {
  return {
    Update: {
      TableName: deps.tableName, Key: keyOf(scope, suggestionSk(suggestion.id)), UpdateExpression: "SET #status = :open, #revision = #revision + :one REMOVE ruleId",
      ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc AND #revision = :seen AND (#status = :accepting OR #status = :waiting)",
      ExpressionAttributeNames: { "#status": "status", "#revision": "revision" },
      ExpressionAttributeValues: { ":open": "open", ":one": 1, ":pc": scope.projectCreatedAt, ":seen": suggestion.revision, ":accepting": "accepting", ":waiting": "awaiting_approval" },
    },
  };
}

/** The publish waits for a person: the rule and the suggestion say so, and `rule.accepted` is written with the outcome `awaiting_approval`. */
export async function commitAwaiting(deps: LearningSettleDeps, scope: LearningScope, rule: LearningRule, approvalId: string, actor: string): Promise<boolean> {
  const learning = learningOf(deps);
  const suggestion = parseSuggestionItem(await getLearningItem(learning, scope, suggestionSk(rule.suggestionId)));
  if (suggestion === undefined || suggestion.status !== "accepting") return false;
  const audited = await learningEvents(learning, () => [acceptedEvent(learning, scope, memberActor(actor), {
    suggestionId: rule.suggestionId, ruleId: rule.id, stage: rule.stage, processAgentId: rule.processAgentId, outcome: "awaiting_approval", approvalId, edited: rule.edited ?? false, lessSafe: true,
  })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      ruleTransition(learning, scope, rule.id, ["pending"], "awaiting_approval", { approvalId, lessSafe: true }),
      {
        Update: {
          TableName: deps.tableName, Key: keyOf(scope, suggestionSk(suggestion.id)), UpdateExpression: "SET #status = :waiting, #revision = #revision + :one",
          ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc AND #revision = :seen AND #status = :accepting",
          ExpressionAttributeNames: { "#status": "status", "#revision": "revision" },
          ExpressionAttributeValues: { ":waiting": "awaiting_approval", ":one": 1, ":pc": scope.projectCreatedAt, ":seen": suggestion.revision, ":accepting": "accepting" },
        },
      },
      ...audited.items,
    ] }));
  } catch (error) {
    if (isCancellation(error)) return false;
    throw error;
  }
  await flushLearningEvents(learning, audited.events);
  return true;
}

/**
 * The publish applied (now, or when the approval was confirmed): the rule is `active` at `version`, the suggestion `accepted` (it loses `proposedText`), the correction text is removed, the
 * metric counts it, and `rule.accepted` is written with the outcome `published`. One transaction; false when the rule was settled already.
 */
export async function commitApplied(deps: LearningSettleDeps, scope: LearningScope, ruleId: string, version: number, decidedBy: string): Promise<boolean> {
  const learning = learningOf(deps);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rule = await readRule(learning, scope, ruleId);
    if (rule === undefined || (rule.status !== "pending" && rule.status !== "awaiting_approval")) return false;
    const suggestion = parseSuggestionItem(await getLearningItem(learning, scope, suggestionSk(rule.suggestionId)));
    const live = suggestion !== undefined && !isTerminalSuggestionStatus(suggestion.status);
    const members = suggestion === undefined ? [] : await readMembers(learning, scope, suggestion.correctionIds);
    const month = metricMonth(new Date(deps.now()).toISOString());
    if (live) await ensureMetricCurrent(learning, scope, month);
    const audited = await learningEvents(learning, () => [acceptedEvent(learning, scope, memberActor(decidedBy), {
      suggestionId: rule.suggestionId, ruleId: rule.id, stage: rule.stage, processAgentId: rule.processAgentId, outcome: "published", processVersion: version,
      ...(rule.approvalId === undefined ? {} : { approvalId: rule.approvalId }), edited: rule.edited ?? false, lessSafe: rule.lessSafe ?? false,
    })]);
    // The second try drops the text removal from the transaction (a member may have just expired) and does it on its own afterwards.
    const withText = attempt === 0 && live;
    const items: TransactItem[] = [ruleTransition(learning, scope, rule.id, ["pending", "awaiting_approval"], "active", { processVersion: version })];
    if (live) {
      // The suggestion's own update, and one STATE update for both counters (a transaction may not name an item twice).
      items.push(terminalSuggestionItems(learning, scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "accepted", decidedBy, ruleId: rule.id })[0]!);
      items.push(stateUpdate(learning, scope, { openSuggestions: -1, pendingRules: -1 }));
      items.push(metricUpdateItem(learning, scope, month, { accepted: 1 }));
    } else {
      items.push(stateUpdate(learning, scope, { pendingRules: -1 }));
    }
    if (withText) for (const member of members) items.push(clearCorrectionTextItem(learning, scope, member.sk));
    items.push(...audited.items);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isCancellation(error)) continue;
      throw error;
    }
    if (!withText && live) await clearCorrectionText(learning, scope, members.map((member) => member.sk));
    await flushLearningEvents(learning, audited.events);
    return true;
  }
  return false;
}

/** The rule was not applied: `not_applied`, the suggestion back to `open`, and (for an approval that ended) `rule.not_applied`. `approvalOutcome` is absent for a rule that never reached an approval. */
export async function commitNotApplied(deps: LearningSettleDeps, scope: LearningScope, ruleId: string, approvalOutcome?: "declined" | "expired" | "failed"): Promise<LearningRule | undefined> {
  const learning = learningOf(deps);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rule = await readRule(learning, scope, ruleId);
    if (rule === undefined || (rule.status !== "pending" && rule.status !== "awaiting_approval")) return undefined;
    const suggestion = parseSuggestionItem(await getLearningItem(learning, scope, suggestionSk(rule.suggestionId)));
    const back = suggestion !== undefined && (suggestion.status === "accepting" || suggestion.status === "awaiting_approval") && suggestion.ruleId === rule.id;
    const audited = await learningEvents(learning, () => approvalOutcome === undefined ? [] : [notAppliedEvent(learning, scope, { suggestionId: rule.suggestionId, ruleId: rule.id, approvalOutcome })]);
    const items: TransactItem[] = [ruleTransition(learning, scope, rule.id, ["pending", "awaiting_approval"], "not_applied"), stateUpdate(learning, scope, { pendingRules: -1 })];
    if (back) items.push(reopenSuggestionItem(learning, scope, suggestion));
    items.push(...audited.items);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isCancellation(error)) continue;
      throw error;
    }
    await flushLearningEvents(learning, audited.events);
    await restoreDraftOf(deps, scope, rule);
    return rule;
  }
  return undefined;
}

/**
 * Best effort, after a rule was not applied: the draft the request wrote is put back to the published overlay, so the layer is not left with unpublished changes. Only when the draft is
 * exactly the published overlay plus this rule (anyone's other edit is left alone). Never throws.
 */
async function restoreDraftOf(deps: LearningSettleDeps, scope: LearningScope, rule: LearningRule): Promise<void> {
  try {
    const store = deps.approvals.store;
    const agent = await store.get(scope.orgId, rule.processAgentId);
    const draft = await store.getDraft(scope.orgId, rule.processAgentId);
    if (agent === undefined || draft === undefined) return;
    const published = agent.currentVersion === undefined ? undefined : (await store.getVersion(scope.orgId, rule.processAgentId, agent.currentVersion))?.overlay ?? {};
    const base = published ?? {};
    if (JSON.stringify(canonicalJson(draft.overlay)) !== JSON.stringify(canonicalJson(appendRuleToOverlay(base, rule.stage, rule.text)))) return;
    await store.saveDraft({ orgId: scope.orgId, agentId: rule.processAgentId, overlay: base, expectedRevision: draft.revision, by: rule.requestedBy ?? "system" });
  } catch { /* the draft stays; the next Accept sees it as unpublished changes */ }
}

// ---- settling

export type SettleOutcome = "missing" | "unchanged" | "waiting" | "active" | "not_applied" | "removed";

/** Settles one rule from what has happened to its approval or its version. Safe to call at any time, any number of times. */
export async function settleRule(deps: LearningSettleDeps, scope: LearningScope, ruleId: string): Promise<SettleOutcome> {
  const learning = learningOf(deps);
  const rule = await readRule(learning, scope, ruleId);
  if (rule === undefined) return "missing";
  const { orgId } = scope;

  if (rule.status === "active" && rule.removalApprovalId !== undefined) return settleRemoval(deps, scope, rule);
  if (rule.status === "awaiting_approval") {
    if (rule.approvalId === undefined) return "waiting";
    const record = await getAnyApproval(deps.approvals, orgId, rule.approvalId as never);
    if (record === undefined) return "waiting";
    switch (record.status) {
      case "APPROVED_DONE": {
        const version = await findVersionByNote(deps.approvals, rule, orgId, acceptNote(rule.id));
        if (version === undefined) return "waiting";
        return await commitApplied(deps, scope, rule.id, version, record.kind === "change" && record.decidedBy !== undefined ? record.decidedBy : rule.requestedBy ?? "system") ? "active" : "unchanged";
      }
      case "DECLINED": return await commitNotApplied(deps, scope, rule.id, "declined") ? "not_applied" : "unchanged";
      case "EXPIRED": return await commitNotApplied(deps, scope, rule.id, "expired") ? "not_applied" : "unchanged";
      case "APPROVED_FAILED": return await commitNotApplied(deps, scope, rule.id, "failed") ? "not_applied" : "unchanged";
      default: return "waiting";
    }
  }
  if (rule.status === "pending") {
    const age = rule.createdAt === undefined ? Number.POSITIVE_INFINITY : deps.now() - Date.parse(rule.createdAt);
    if (age < PENDING_RULE_STUCK_MS) return "waiting";
    const version = await findVersionByNote(deps.approvals, rule, orgId, acceptNote(rule.id));
    if (version !== undefined) return await commitApplied(deps, scope, rule.id, version, rule.requestedBy ?? "system") ? "active" : "unchanged";
    if (rule.requestedBy !== undefined) {
      const approvalId = approvalIdFor(orgId, rule.requestedBy, rule.requestId);
      if (await getAnyApproval(deps.approvals, orgId, approvalId) !== undefined) return await commitAwaiting(deps, scope, rule, approvalId, rule.requestedBy) ? "waiting" : "unchanged";
    }
    return await commitNotApplied(deps, scope, rule.id) ? "not_applied" : "unchanged";
  }
  return "unchanged";
}

/** Remove waited for a person: when that approval ends, the rule is `removed` (applied) or stays `active` (declined, expired, failed). */
async function settleRemoval(deps: LearningSettleDeps, scope: LearningScope, rule: LearningRule): Promise<SettleOutcome> {
  const learning = learningOf(deps);
  const record = await getAnyApproval(deps.approvals, scope.orgId, rule.removalApprovalId as never);
  if (record === undefined) return "waiting";
  const clear = ruleTransition(learning, scope, rule.id, ["active"], "active", {}, ["removalApprovalId"]);
  switch (record.status) {
    case "APPROVED_DONE": {
      const version = await findVersionByNote(deps.approvals, rule, scope.orgId, removeNote(rule.id));
      if (version === undefined) return "waiting";
      const by = record.kind === "change" && record.decidedBy !== undefined ? record.decidedBy : "system";
      const audited = await learningEvents(learning, () => [rolledBackEvent(learning, scope, memberActor(by), { ruleId: rule.id, processAgentId: rule.processAgentId, processVersion: version })]);
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [ruleTransition(learning, scope, rule.id, ["active"], "removed", { removedInVersion: version }, ["removalApprovalId"]), ...audited.items] }));
      } catch (error) {
        if (isCancellation(error)) return "unchanged";
        throw error;
      }
      await flushLearningEvents(learning, audited.events);
      return "removed";
    }
    case "DECLINED": case "EXPIRED": case "APPROVED_FAILED":
      try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [clear] })); } catch (error) { if (!isCancellation(error)) throw error; }
      return "active";
    default: return "waiting";
  }
}

/** Settles the project's waiting rules (at most 5 per call): the rules the learning routes call before they decide anything. A failure to settle never fails the caller. */
export async function settleProject(deps: LearningSettleDeps, scope: LearningScope, log?: (entry: Record<string, unknown>) => void): Promise<number> {
  const learning = learningOf(deps);
  let settled = 0;
  try {
    if (await readLearningState(learning, scope) === undefined) return 0;
    const page = await readLearningPartition(learning, scope, { prefix: "RULE#", maxItems: 100, maxPages: 1, pageSize: 100 });
    let looked = 0;
    for (const item of page.items) {
      const rule = parseRule(item);
      if (rule === undefined || looked >= 5) continue;
      if (rule.status === "awaiting_approval" || rule.status === "pending" || (rule.status === "active" && rule.removalApprovalId !== undefined)) {
        looked += 1;
        const outcome = await settleRule(deps, scope, rule.id);
        if (outcome === "active" || outcome === "not_applied" || outcome === "removed") settled += 1;
      }
    }
  } catch (error) {
    log?.({ event: "learning.settle_failed", error: error instanceof Error ? error.name : "unknown" });
  }
  return settled;
}

/** The settler Home hands an ended approval to (`setLearningHomeSettler(learningSettler(deps))`): it carries ids and the approval's state, and settles from the stored records. */
export function learningSettler(deps: LearningSettleDeps): LearningHomeSettler {
  return async (settlement) => {
    await settleRule(deps, { orgId: settlement.orgId, project: settlement.project, projectCreatedAt: settlement.projectCreatedAt }, settlement.ruleId);
  };
}

/** Items of the RULE# partition that the lists need; exported for the decide module. */
export async function queryRules(learning: LearningDeps, scope: LearningScope): Promise<LearningRule[]> {
  const response = await learning.documentClient.send(new QueryCommand({
    TableName: learning.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": keyOf(scope, "STATE").pk, ":prefix": "RULE#" }, ConsistentRead: true, Limit: 500,
  })) as { Items?: Item[] };
  return (response.Items ?? []).flatMap((item) => { const rule = parseRule(item); return rule === undefined ? [] : [rule]; });
}

export { ruleTransition };
