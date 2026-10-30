// v1.2 learning loop, B6: Accept, Dismiss, Reopen and Remove (design 5). A person decides every rule; nothing here applies by itself.
//
// Accept builds the draft from the PUBLISHED overlay, never from a draft: the draft is per agent, not per person, so Accept refuses when the layer has any unpublished change (anyone's, or a
// publish waiting on an approval). It then publishes through `publishDraft` (agents/changes.ts), the function the How-we-work publish route calls, with all its checks: the less-safe rules, the
// guardrails, and the second person for a reviewing stage. A publish that waits for a person is the same 202 a hand publish gives. There is no parallel write.
//
// The request id is derived from the suggestion (suggestion id, the revision the person saw, the stage and the exact text), so a retry is the same request: it finds the same pending rule, the same
// draft and the same approval. The rule is written `pending` before the draft, so a crash leaves a state that settlement (settle.ts) can resolve.
//
// Checked again at Accept, live: the accepter's standing and How we work edit rights (L3: being an author grants nothing), every source author's standing, and PR-only membership (a source
// that is a PR comment while PR capture is off does not count). A suggestion with fewer than 2 sources from 2 tasks left is withdrawn and refused.
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  LearningAcceptBodySchema, LearningDismissBodySchema, LearningRuleRemoveBodySchema, LearningRuleSchema, LEARNING_SUGGESTION_SOURCES_MIN, agentXError, canonicalJson, projectAllows, projectLearningKey,
  type LearningRule, type LearningSuggestion, type RecipeOverlay,
} from "@agentx/contracts";
import type { ZodType } from "zod";
import { approvalIdFor } from "../agents/approvals-store.js";
import { publishDraft, type ChangeResult } from "../agents/changes.js";
import type { AgentDraft, AgentRecord, AgentVersion } from "../agents/store.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { inertRuleText } from "../playbook/inert-rule-text.js";
import { appendRuleToOverlay, removeRuleFromOverlay } from "./overlay.js";
import { postProjectProcess } from "../playbook/process-layer.js";
import { dismissedEvent, flushLearningEvents, learningEvents, memberActor, rolledBackEvent } from "./audit.js";
import { dismissedSetKey, groupCorrections, prCaptureOff } from "./grouping.js";
import { ensureMetricCurrent, metricMonth, metricUpdateItem } from "./metric.js";
import {
  acceptNote, commitApplied, commitAwaiting, commitNotApplied, findVersionByNote, learningOf, parseSuggestionItem, readMembers, readRule, removeNote, ruleSk, ruleTransition, settleProject,
  type LearningDecideDeps,
} from "./settle.js";
import { canAcceptSuggestion, learningScopeChecked, readStandingChecked, readStandingsChecked, type StandingCheck } from "./standing.js";
import { closeSuggestion, dismissedSk, getLearningItem, suggestionSk, terminalSuggestionItems, type LearningScope } from "./store.js";
import { learningExpiry } from "./retention.js";

/** `changes` (what makes the publish wait, in words) is what a hand publish's 202 also carries; the routes answer 202 with it. */
export type AcceptAnswer = { outcome: "published"; version: number } | { outcome: "awaiting_approval"; confirmUrl: string; changes?: string[] };
export type RemoveAnswer = AcceptAnswer | { outcome: "needs_editor"; stage: string };

// ---- words

const CHANGED = "This suggestion changed. Refresh the page and try again.";
const BUSY_LAYER = "How we work has unpublished changes. Publish or discard them first.";
const SOURCES_GONE = "This suggestion no longer has enough sources.";
const MAINTAINERS_ONLY = "Only a project maintainer can decide on suggested rules.";
// What a hand publish says to a person without edit rights (playbook/routes.ts); Accept is a publish, so it says the same.
const PUBLISH_FORBIDDEN = "only a project maintainer can change how the project works";
const DRAFT_CHANGED = "Someone else changed this agent's draft. Reload it and make your change again.";

const failure = (code: Parameters<typeof agentXError>[0], message: string) => agentXError(code, message);
const stale = () => failure("AGENT_REVISION_CONFLICT", CHANGED);

function strictBody<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  // Field names only: the values are the caller's.
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw failure("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

// ---- derived ids

const NAMESPACE = Buffer.from("5f0c7a52e1b34d9c8a6b1e0f4d2c9a77", "hex");
/** A version 5 UUID of `name`: the same name always gives the same id. */
function uuidV5(name: string): string {
  const hash = createHash("sha1").update(NAMESPACE).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** The request id (and the rule id) of one Accept: a retry of the same request derives the same one; a changed suggestion, stage or text derives another. */
export function acceptRequestId(suggestionId: string, suggestionRevision: number, stage: string, text: string): string {
  const digest = createHash("sha256").update(`${stage}\0${text}`, "utf8").digest("hex");
  return uuidV5(`learning-accept\0${suggestionId}\0${String(suggestionRevision)}\0${digest}`);
}
export const removeRequestId = (ruleId: string): string => uuidV5(`learning-remove\0${ruleId}`);

// ---- the rule text and the overlay

/** The text of a rule as it is appended: inert, one paragraph (blank lines inside collapse to a line end, so Remove can find the paragraph again), at most 1,000 characters. */
export function cleanRuleText(raw: string): string {
  const text = inertRuleText(raw).replace(/\n[ \t]*(\n[ \t]*)+/g, "\n");
  if (text === "") throw failure("CONFIG_INVALID", "text: a rule needs some words");
  if (Array.from(text).length > 1000) throw failure("CONFIG_INVALID", "text: must be at most 1,000 characters");
  return text;
}

// ---- the process layer

interface Layer { agent: AgentRecord; draft: AgentDraft; published: AgentVersion | undefined; publishedOverlay: RecipeOverlay }

const sameOverlay = (a: RecipeOverlay, b: RecipeOverlay) => canonicalJson(a) === canonicalJson(b);
const sameBase = (a: AgentDraft["extends"], b: AgentDraft["extends"]) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

async function readLayer(deps: LearningDecideDeps, orgId: string, agentId: string): Promise<Layer> {
  const store = deps.approvals.store;
  const agent = await store.get(orgId, agentId);
  if (agent === undefined || agent.status === "archived") throw failure("AGENT_UNAVAILABLE", "How we work isn't available for this project right now.");
  const draft = await store.getDraft(orgId, agentId);
  if (draft === undefined) throw failure("AGENT_UNAVAILABLE", "How we work isn't available for this project right now.");
  const published = agent.currentVersion === undefined ? undefined : await store.getVersion(orgId, agentId, agent.currentVersion);
  return { agent, draft, published, publishedOverlay: published?.overlay ?? {} };
}

/**
 * Where the layer stands against a rule that is to be written: `clean` (the draft is what is published), `ours` (the draft already is published plus this change: an earlier try of the same
 * request wrote it), or busy (anyone else's unpublished change, or one waiting on an approval), which is refused.
 */
function layerState(layer: Layer, built: RecipeOverlay): "clean" | "ours" {
  const base = layer.published?.extends ?? layer.draft.extends;
  if (sameOverlay(layer.draft.overlay, layer.publishedOverlay) && sameBase(layer.draft.extends, base)) return "clean";
  if (sameOverlay(layer.draft.overlay, built) && sameBase(layer.draft.extends, base)) return "ours";
  throw failure("LEARNING_LAYER_BUSY", BUSY_LAYER);
}

/** Best effort: puts the draft back to the published overlay when it still is exactly the change this request wrote. Never throws. */
async function restoreDraft(deps: LearningDecideDeps, caller: DeveloperCaller, layer: Layer, built: RecipeOverlay): Promise<void> {
  try {
    const draft = await deps.approvals.store.getDraft(caller.orgId, layer.agent.agentId);
    if (draft === undefined || !sameOverlay(draft.overlay, built)) return;
    await deps.approvals.store.saveDraft({ orgId: caller.orgId, agentId: layer.agent.agentId, overlay: layer.publishedOverlay, expectedRevision: draft.revision, by: caller.developerId });
  } catch { /* the draft stays as it is; the next Accept sees it as unpublished changes */ }
}

/** The draft exactly as this request wrote it: the revision `saveDraft` returned (or the current one, when an earlier try of the same request already wrote it), and that revision's content. */
async function saveExactDraft(deps: LearningDecideDeps, caller: DeveloperCaller, layer: Layer, built: RecipeOverlay): Promise<{ agent: AgentRecord; revision: number }> {
  const store = deps.approvals.store;
  const agentId = layer.agent.agentId;
  let revision = layer.draft.revision;
  if (!sameOverlay(layer.draft.overlay, built)) {
    revision = (await store.saveDraft({ orgId: caller.orgId, agentId, overlay: built, expectedRevision: layer.draft.revision, by: caller.developerId })).revision;
  }
  // Not the layer re-read the publish used to take: whatever draft is there NOW must be the one written, or somebody else's work would be published under this rule's name.
  const agent = await store.get(caller.orgId, agentId);
  const draft = await store.getDraft(caller.orgId, agentId);
  if (agent === undefined || draft === undefined) throw failure("AGENT_UNAVAILABLE", "How we work isn't available for this project right now.");
  if (draft.revision !== revision || agent.draftRevision !== revision || !sameOverlay(draft.overlay, built) || !sameBase(draft.extends, layer.draft.extends)) throw failure("AGENT_REVISION_CONFLICT", DRAFT_CHANGED);
  return { agent, revision };
}

/** A refusal from the agent code (not "unavailable"): nothing was published. A network error or any other failure may have come after the write, so it is never read as a refusal. */
function isRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === "AgentXError" && (error as { code?: unknown }).code !== "RUNTIME_UNAVAILABLE";
}

/** True when a published version carries `note`, or when that cannot be told (then nothing is undone). */
async function mayHavePublished(deps: LearningDecideDeps, caller: DeveloperCaller, agentId: string, note: string): Promise<boolean> {
  try { return await findVersionByNote(deps.approvals, { processAgentId: agentId }, caller.orgId, note) !== undefined; } catch { return true; }
}

/** A trigger re-check after a publish is best effort: the publish is done, and no failure of the re-check may undo or hide it. */
async function recheckTriggers(deps: LearningDecideDeps, caller: DeveloperCaller, agentId: string): Promise<void> {
  try { await deps.approvals.triggerHooks?.recheckTriggersForTarget(caller.orgId, { kind: "agent", agentId: agentId }); } catch { /* the next change or sweep re-checks */ }
}

/** One condition per record: a transaction may not name an item twice (the accepter can be a source author too). */
function uniqueChecks(...lists: StandingCheck[][]): StandingCheck[] {
  const seen = new Set<string>();
  return lists.flat().filter((check) => {
    const key = JSON.stringify(check.ConditionCheck?.Key ?? check);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- authority

interface Authority { scope: LearningScope; scopeChecks: StandingCheck[]; accepterChecks: StandingCheck[]; maintainer: boolean; standing: "member" | "outsider" }

async function authorize(deps: LearningDecideDeps, caller: DeveloperCaller, rawProject: string, refusal: string): Promise<Authority & { project: string }> {
  const found = await deps.projectFor(caller, rawProject);
  const project = found.name;
  const checked = await learningScopeChecked(deps, caller.orgId, project);
  if (checked === undefined) throw failure("NOT_FOUND", "Rovara isn't learning from this project right now.");
  // Read now, not from the sign-in: a person demoted since they signed in is not a member.
  const standing = await readStandingChecked(deps, caller.orgId, caller.developerId, project);
  const maintainer = projectAllows(found.role, "edit_settings");
  if (!canAcceptSuggestion({ standing: standing.standing, maintainer })) throw failure("FORBIDDEN", refusal);
  return { project, scope: checked.scope, scopeChecks: checked.checks, accepterChecks: standing.checks, maintainer, standing: standing.standing };
}

// ---- Accept

/**
 * `POST …/learning/suggestions/{id}/accept`. See the module comment. The body's `requestId` is not used: the request id is derived from the suggestion, so a retry cannot publish twice.
 */
export async function acceptSuggestion(deps: LearningDecideDeps, caller: DeveloperCaller, rawProject: string, suggestionId: string, rawBody: unknown): Promise<AcceptAnswer> {
  const body = strictBody(LearningAcceptBodySchema, rawBody);
  const learning = learningOf(deps);
  const auth = await authorize(deps, caller, rawProject, PUBLISH_FORBIDDEN);
  const { scope, project } = auth;
  await settleProject(deps, scope);

  const suggestion = parseSuggestionItem(await getLearningItem(learning, scope, suggestionSk(suggestionId)));
  if (suggestion === undefined) throw failure("NOT_FOUND", "That suggestion is gone.");
  if (body.stage !== suggestion.stage) throw failure("CONFIG_INVALID", "stage: a rule is accepted for the stage it was suggested for");
  const text = cleanRuleText(body.text);
  const requestId = acceptRequestId(suggestion.id, body.expectedRevision, suggestion.stage, text);
  const ruleId = requestId;

  // A retry of this very request: it is already accepted, or on its way.
  if (suggestion.status === "accepted" && suggestion.ruleId === ruleId) {
    const done = await readRule(learning, scope, ruleId);
    if (done?.status === "active" && done.processVersion !== undefined) return { outcome: "published", version: done.processVersion };
  }
  const resuming = (suggestion.status === "accepting" || suggestion.status === "awaiting_approval") && suggestion.ruleId === ruleId;
  if (!resuming) {
    if (suggestion.status === "accepting" || suggestion.status === "awaiting_approval") throw failure("LEARNING_LAYER_BUSY", "This suggestion is being accepted. Try again once it is decided.");
    if (suggestion.status !== "open" || suggestion.revision !== body.expectedRevision) throw stale();
  }

  // The members, read live. Authority was settled above (edit rights and standing); being one of the authors adds nothing.
  const members = await readMembers(learning, scope, suggestion.correctionIds);

  // The source authors, read now (design 5.1), with the records they were read from: those conditions go into the transaction that follows. A retry re-reads them too, and is refused when
  // fewer than 2 sources from 2 tasks are left (it withdraws nothing: the rule it resumes is settled on its own).
  const sources = await weighSources(deps, caller, scope, project, members);
  if (!sources.enough) {
    if (!resuming) await withdrawSuggestion(learning, scope, suggestion);
    throw failure("LEARNING_SOURCES_GONE", SOURCES_GONE);
  }

  // The layer: the accepter has edit rights, so they set it up if the project has none yet.
  const agentId = (await postProjectProcess(deps, caller, project)).agentId;
  const layer = await readLayer(deps, caller.orgId, agentId);
  const built = appendRuleToOverlay(layer.publishedOverlay, suggestion.stage, text);
  layerState(layer, built);

  // The pending rule and the suggestion `accepting`, before anything is published. A retry holds the same standing records in a transaction of conditions.
  let started = false;
  if (resuming) await holdStanding(deps, scope, ruleId, uniqueChecks(auth.accepterChecks, auth.scopeChecks, sources.checks));
  else {
    started = await startAccepting(deps, caller, auth, suggestion, {
      ruleId, requestId, stage: suggestion.stage, text, processAgentId: agentId, edited: text !== (suggestion.proposedText ?? ""), expectedRevision: body.expectedRevision, sourceChecks: sources.checks,
    });
  }

  // Only a refusal before the publish undoes the Accept (a refusal means nothing was published). The draft is saved at a revision this code knows, and exactly that revision is published.
  let result: ChangeResult<AgentVersion>;
  try {
    const exact = await saveExactDraft(deps, caller, layer, built);
    result = await publishDraft(deps.approvals, caller, exact.agent, { requestId, expectedRevision: exact.revision, note: acceptNote(ruleId) });
  } catch (error) {
    // A network error or an unavailable table may have published; those stay pending for a retry of the same request, or for settlement.
    if (started && isRefusal(error) && !await mayHavePublished(deps, caller, agentId, acceptNote(ruleId))) {
      await restoreDraft(deps, caller, layer, built);
      try { await commitNotApplied(deps, scope, ruleId); } catch { /* settlement resolves it */ }
    }
    throw error;
  }
  // From here the publish happened or is waiting: nothing below undoes it. A failure leaves the rule as it is, and settlement finishes it.
  if (result.applied) {
    await recheckTriggers(deps, caller, agentId);
    await commitApplied(deps, scope, ruleId, result.value.version, caller.developerId);
    return { outcome: "published", version: result.value.version };
  }
  const rule = await readRule(learning, scope, ruleId);
  if (rule?.status === "pending") await commitAwaiting(deps, scope, rule, approvalIdFor(caller.orgId, caller.developerId, requestId), caller.developerId);
  return { outcome: "awaiting_approval", confirmUrl: result.confirmUrl, changes: result.changes ?? [] };
}

type Members = Awaited<ReturnType<typeof readMembers>>;

/**
 * Re-checks the sources (design 5.1): who still counts (a member now, not erased, not a PR comment while PR capture is off) and whether 2 sources from 2 tasks remain. `checks` are the records
 * each counted author's standing was read from, for the transaction that goes on to write.
 */
async function weighSources(deps: LearningDecideDeps, caller: DeveloperCaller, scope: LearningScope, project: string, members: Members): Promise<{ enough: boolean; checks: StandingCheck[] }> {
  const learning = learningOf(deps);
  const authors = members.map((member) => member.c.author).filter((author) => author !== "erased");
  const standings = await readStandingsChecked(deps, caller.orgId, project, authors);
  const prOff = await (deps.prCaptureOff ?? prCaptureOff)(learning, scope);
  const kept = members.filter((member) => member.c.standing === "member" && member.c.author !== "erased" && standings.get(member.c.author)?.standing === "member" && !(member.c.source === "pr_comment" && prOff));
  const enough = kept.length >= LEARNING_SUGGESTION_SOURCES_MIN && new Set(kept.map((member) => member.c.taskId)).size >= 2;
  return { enough, checks: enough ? kept.flatMap((member) => standings.get(member.c.author)?.checks ?? []) : [] };
}

/** A suggestion left with fewer than 2 sources from 2 tasks is withdrawn. */
async function withdrawSuggestion(learning: ReturnType<typeof learningOf>, scope: LearningScope, suggestion: LearningSuggestion): Promise<void> {
  await closeSuggestion(learning, scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "withdrawn" });
}

/** A retry of an Accept that already started: one transaction of conditions, so a standing that changed since it was read, or a rule settled meanwhile, stops it. */
async function holdStanding(deps: LearningDecideDeps, scope: LearningScope, ruleId: string, checks: StandingCheck[]): Promise<void> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      {
        ConditionCheck: {
          TableName: deps.tableName, Key: projectLearningKey(scope.orgId, scope.project, ruleSk(ruleId)), ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc AND (#status = :pending OR #status = :waiting)",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":pc": scope.projectCreatedAt, ":pending": "pending", ":waiting": "awaiting_approval" },
        },
      },
      ...checks,
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") throw stale();
    throw error;
  }
}

interface Starting { ruleId: string; requestId: string; stage: string; text: string; processAgentId: string; edited: boolean; expectedRevision: number; sourceChecks: StandingCheck[] }

/** One transaction: the rule `pending`, the suggestion `accepting`, one more pending rule on STATE, under the revision the person saw and the standing records read for this request. */
async function startAccepting(deps: LearningDecideDeps, caller: DeveloperCaller, auth: Authority, suggestion: LearningSuggestion, input: Starting): Promise<boolean> {
  const learning = learningOf(deps);
  const { scope } = auth;
  const rule = LearningRuleSchema.parse({
    id: input.ruleId, suggestionId: suggestion.id, stage: input.stage, text: input.text, processAgentId: input.processAgentId, requestId: input.requestId, status: "pending",
    createdAt: new Date(deps.now()).toISOString(), requestedBy: caller.developerId, edited: input.edited, lessSafe: false, projectCreatedAt: scope.projectCreatedAt,
  });
  const key = (sk: string) => projectLearningKey(scope.orgId, scope.project, sk);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: { ...key(ruleSk(rule.id)), entityType: "LEARNING_RULE", orgId: scope.orgId, ...rule }, ConditionExpression: "attribute_not_exists(pk)" } },
      {
        Update: {
          TableName: deps.tableName, Key: key(suggestionSk(suggestion.id)), UpdateExpression: "SET #status = :accepting, ruleId = :rule, #revision = #revision + :one",
          ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc AND #status = :open AND #revision = :expected",
          ExpressionAttributeNames: { "#status": "status", "#revision": "revision" },
          ExpressionAttributeValues: { ":accepting": "accepting", ":rule": rule.id, ":one": 1, ":pc": scope.projectCreatedAt, ":open": "open", ":expected": input.expectedRevision },
        },
      },
      {
        Update: {
          TableName: deps.tableName, Key: key("STATE"), UpdateExpression: "ADD pendingRules :one", ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc",
          ExpressionAttributeValues: { ":one": 1, ":pc": scope.projectCreatedAt },
        },
      },
      ...uniqueChecks(auth.accepterChecks, auth.scopeChecks, input.sourceChecks),
    ] }));
    return true;
  } catch (error) {
    if (!(error instanceof Error && error.name === "TransactionCanceledException")) throw error;
    // Someone else moved the suggestion, a record the decision rests on changed, or an identical request got there first (then this one goes on with it).
    const now = parseSuggestionItem(await getLearningItem(learning, scope, suggestionSk(suggestion.id)));
    if (now !== undefined && now.status === "accepting" && now.ruleId === input.ruleId) return false;
    throw stale();
  }
}

// ---- Dismiss and reopen

/** `POST …/learning/suggestions/{id}/dismiss`: a maintainer. The pattern is remembered (the exact member set, as hashed tokens) so it does not come back; the note is never stored. */
export async function dismissSuggestion(deps: LearningDecideDeps, caller: DeveloperCaller, rawProject: string, suggestionId: string, rawBody: unknown): Promise<{ suggestion: { id: string; status: "dismissed" } }> {
  const body = strictBody(LearningDismissBodySchema, rawBody);
  const learning = learningOf(deps);
  const auth = await authorize(deps, caller, rawProject, MAINTAINERS_ONLY);
  const { scope } = auth;
  await settleProject(deps, scope);
  const suggestion = parseSuggestionItem(await getLearningItem(learning, scope, suggestionSk(suggestionId)));
  if (suggestion === undefined) throw failure("NOT_FOUND", "That suggestion is gone.");
  if (suggestion.status === "accepting" || suggestion.status === "awaiting_approval") throw failure("LEARNING_LAYER_BUSY", "This suggestion is being accepted. Try again once it is decided.");
  if (suggestion.status === "dismissed" && suggestion.dismissKind === body.dismissKind) return { suggestion: { id: suggestion.id, status: "dismissed" } };
  if (suggestion.status !== "open" || suggestion.revision !== body.expectedRevision) throw stale();

  const month = metricMonth(new Date(deps.now()).toISOString());
  await ensureMetricCurrent(learning, scope, month);
  const audited = await learningEvents(learning, () => [dismissedEvent(learning, scope, memberActor(caller.developerId), { suggestionId: suggestion.id, stage: suggestion.stage, dismissKind: body.dismissKind })]);
  const nowMs = deps.now();
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      ...terminalSuggestionItems(learning, scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "dismissed", decidedBy: caller.developerId, dismissKind: body.dismissKind }),
      {
        Put: {
          TableName: deps.tableName,
          Item: {
            ...projectLearningKey(scope.orgId, scope.project, dismissedSk(dismissedSetKey(suggestion.correctionIds))), entityType: "LEARNING_DISMISSED", orgId: scope.orgId, signature: suggestion.signature,
            suggestionId: suggestion.id, dismissedAt: new Date(nowMs).toISOString(), projectCreatedAt: scope.projectCreatedAt, indexExpiresAt: learningExpiry(nowMs),
          },
        },
      },
      metricUpdateItem(learning, scope, month, { dismissed: 1 }),
      ...auth.accepterChecks, ...auth.scopeChecks, ...audited.items,
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") throw stale();
    throw error;
  }
  await flushLearningEvents(learning, audited.events);
  return { suggestion: { id: suggestion.id, status: "dismissed" } };
}

/** `POST …/learning/dismissed/{id}/reopen`: a maintainer takes the pattern off the dismissed list, so the same corrections can form a suggestion again. */
export async function reopenDismissed(deps: LearningDecideDeps, caller: DeveloperCaller, rawProject: string, dismissedId: string): Promise<{ reopened: true }> {
  const learning = learningOf(deps);
  const auth = await authorize(deps, caller, rawProject, MAINTAINERS_ONLY);
  if (!/^[a-f0-9]{32}$/.test(dismissedId)) throw failure("NOT_FOUND", "That is not on the dismissed list.");
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Delete: { TableName: deps.tableName, Key: projectLearningKey(auth.scope.orgId, auth.scope.project, dismissedSk(dismissedId)), ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc", ExpressionAttributeValues: { ":pc": auth.scope.projectCreatedAt } } },
      ...auth.accepterChecks, ...auth.scopeChecks,
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return { reopened: true };
    throw error;
  }
  // The corrections are free again (their suggestion ended); grouping forms the suggestion now. A failure here is the next capture's to finish.
  try { await groupCorrections(learning, auth.scope); } catch { /* the next grouping run does it */ }
  return { reopened: true };
}

// ---- Remove

/**
 * `POST …/learning/rules/{ruleId}/remove`: a maintainer. Removes the paragraph that equals the rule's text. A text that is not there once (hand-edited since, a duplicate, or only part of a
 * longer paragraph) is not guessed: the answer is `needs_editor`. Built from the published overlay with the same busy refusal as Accept; a reviewing stage's removal waits for a second person.
 */
export async function removeRule(deps: LearningDecideDeps, caller: DeveloperCaller, rawProject: string, ruleId: string, rawBody: unknown): Promise<RemoveAnswer> {
  strictBody(LearningRuleRemoveBodySchema, rawBody);
  const learning = learningOf(deps);
  const auth = await authorize(deps, caller, rawProject, MAINTAINERS_ONLY);
  const { scope } = auth;
  await settleProject(deps, scope);
  let rule: LearningRule | undefined = await readRule(learning, scope, ruleId);
  if (rule === undefined) throw failure("NOT_FOUND", "That rule is gone.");
  if (rule.status === "removed" && rule.removedInVersion !== undefined) return { outcome: "published", version: rule.removedInVersion };
  if (rule.status !== "active") throw failure("AGENT_REVISION_CONFLICT", "This rule isn't in How we work. Refresh the page and try again.");

  const layer = await readLayer(deps, caller.orgId, rule.processAgentId);
  const removal = removeRuleFromOverlay(layer.publishedOverlay, rule.stage, rule.text);
  if (removal.matches !== 1) return { outcome: "needs_editor", stage: rule.stage };
  layerState(layer, removal.overlay);

  const requestId = removeRequestId(rule.id);
  let result: ChangeResult<AgentVersion>;
  try {
    // The same as Accept: the revision `saveDraft` returned is the one published, and only if its content is exactly the removal.
    const exact = await saveExactDraft(deps, caller, layer, removal.overlay);
    result = await publishDraft(deps.approvals, caller, exact.agent, { requestId, expectedRevision: exact.revision, note: removeNote(rule.id) });
  } catch (error) {
    if (isRefusal(error) && !await mayHavePublished(deps, caller, rule.processAgentId, removeNote(rule.id))) await restoreDraft(deps, caller, layer, removal.overlay);
    throw error;
  }
  if (!result.applied) {
    rule = await readRule(learning, scope, ruleId);
    const approvalId = approvalIdFor(caller.orgId, caller.developerId, requestId);
    if (rule?.status === "active" && rule.removalApprovalId === undefined) {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [ruleTransition(learning, scope, ruleId, ["active"], "active", { removalApprovalId: approvalId })] }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "TransactionCanceledException")) throw error;
      }
    }
    return { outcome: "awaiting_approval", confirmUrl: result.confirmUrl, changes: result.changes ?? [] };
  }
  await recheckTriggers(deps, caller, rule.processAgentId);
  const audited = await learningEvents(learning, () => [rolledBackEvent(learning, scope, memberActor(caller.developerId), { ruleId: rule.id, processAgentId: rule.processAgentId, processVersion: result.value.version })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [ruleTransition(learning, scope, ruleId, ["active"], "removed", { removedInVersion: result.value.version }, ["removalApprovalId"]), ...audited.items] }));
    await flushLearningEvents(learning, audited.events);
  } catch (error) {
    if (!(error instanceof Error && error.name === "TransactionCanceledException")) throw error;
  }
  return { outcome: "published", version: result.value.version };
}

export { appendRuleToOverlay, removeRuleFromOverlay, canAcceptSuggestion };
