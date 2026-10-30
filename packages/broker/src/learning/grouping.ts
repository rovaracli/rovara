// v1.2 learning loop, B5: spotting repeats, grouping, dismissed sets and Forget (design 4, 7.2). New logic of B5; B3, B4, B6 and B8 call it.
//
// What a run (`groupCorrections`) does, in this order:
//   1. If PR capture is off, withdraw the suggestions that PR corrections held up (`withdrawPrDependentSuggestions`).
//   2. Judge every correction that has no `groupedAt`: work out its `repeatOf`, then in ONE transaction set `groupedAt` and `repeatOf` on it and add to the month's METRIC, on the condition that
//      `groupedAt` is not set. So a correction is counted once however often grouping runs or fails, and never before its `repeatOf` exists (the counters do not read `repeatOf` from the item).
//   3. Join free corrections to open suggestions, then open new suggestions from the groups that remain. Single-link: A~B and B~C put A, B and C together even when A is not similar to C, so a
//      suggestion keeps EVERY member's correction id and the card can show every member's text. Every write is conditioned on what the run read (the STATE revision, the suggestion's revision
//      and each member's current `suggestionId`), so racing runs open one suggestion and no correction is in two.
//
// Nothing is ever applied here: a person decides every rule. A dismissal (`recordDismissal`, called by B6) suppresses only the exact member set (a hash of the sorted ids); a similar
// correction that arrives later makes a new set and can form a new suggestion.
//
// Counts and limits: corrections of the last 30 days, the newest 200; a suggestion holds 2 to 10 corrections from at least 2 tasks; the 21st open suggestion waits (its corrections stay free).
import { createHash, randomUUID } from "node:crypto";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  LEARNING_OPEN_SUGGESTIONS_MAX, LEARNING_SUGGESTION_SOURCES_MAX, LEARNING_SUGGESTION_SOURCES_MIN, LearningCorrectionSchema, LearningRuleSchema, LearningSuggestionSchema, agentXError,
  projectLearningKey, type LearningCorrection, type LearningRule, type LearningSuggestion, type OrgId,
} from "@agentx/contracts";
import { dismissedEvent, flushLearningEvents, learningEvents, memberActor, rememberedEvent, suggestedEvent, systemActor } from "./audit.js";
import { metricMonth, metricUpdateItem, ensureMetricCurrent, type MetricCounters } from "./metric.js";
import { visibility } from "./retention.js";
import {
  buildDocumentFrequency, compareSignatures, type DocumentFrequency, type Signature,
} from "./similarity.js";
import { proposedRuleText } from "./text.js";
import {
  getLearningItem, putDismissed, readLearningPartition, readLearningState, sourceSk, suggestionSk, terminalSuggestionItems, closeSuggestion, type LearningDeps, type LearningScope,
} from "./store.js";

type Item = Record<string, unknown>;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

/** The window grouping reads: corrections newer than this many days, at most `WINDOW_MAX_ITEMS` of them (the newest). */
export const GROUPING_WINDOW_DAYS = 30;
export const GROUPING_WINDOW_MAX_ITEMS = 200;
/** Corrections judged in one run; the rest wait for the next. */
const JUDGE_MAX = 50;
/** Suggestions opened or joined in one run, and conflicts a run puts up with before it leaves the rest to the next. */
const FORM_ROUNDS_MAX = 25;
const CONFLICTS_MAX = 8;
/** The document-frequency weighting needs a sample worth the name: with a handful of corrections every word looks rare. */
const FREQUENCY_MIN_SAMPLE = 30;
/** Older members of a suggestion are found by reading the corrections of the partition (at most as many as a project may hold); the cap on that read. */
const RESOLVE_MAX_ITEMS = 2000;
/** Design 4.2: grouping works from at most 200 items of one stage family. The same cap holds for the older members read outside the window. */
const RESOLVE_PER_FAMILY_MAX = GROUPING_WINDOW_MAX_ITEMS;
/** Suggestions are read in full, a page at a time, up to this many items (terminal ones included; they expire 180 days after they end). */
const SUGGESTIONS_READ_MAX = 2000;

/** Stage families (design 4.2): a correction groups with others of its own family. Only real step kinds are listed (`code_review` and `security_review` are stage ids, not step kinds). Any other stage is a family of its own. */
const STAGE_FAMILIES: ReadonlyArray<readonly string[]> = [["plan", "plan_critic"], ["review"]];
export const stageFamily = (stage: string): string => STAGE_FAMILIES.find((family) => family.includes(stage))?.[0] ?? stage;

export interface GroupingOptions {
  /** Whether PR-comment capture is off for the project. Default: `prCaptureOff`, which reads the project setting; B8 plugs in the company lock here. */
  prCaptureOff?: (deps: LearningDeps, scope: LearningScope) => Promise<boolean>;
  /** Ids for new suggestions (tests). */
  newId?: () => string;
}
export interface GroupingResult {
  /** Corrections judged (counted) in this run. */
  judged: number;
  opened: string[];
  joined: string[];
  withdrawn: string[];
  /** A group was ready but the project already has 20 open suggestions. */
  capped: boolean;
}
export type ForgetResult = { ok: true } | { ok: false; reason: "missing" | "in_accepted_rule" | "suggestion_busy" | "suggestion_changed" };

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Learning could not be read or written. Try again.");
const invalid = (what: string) => agentXError("CONFIG_INVALID", `${what} is not valid.`);
const isCancellation = (error: unknown) => error instanceof Error && error.name === "TransactionCanceledException";

function normalized(scope: LearningScope): LearningScope {
  const time = Date.parse(scope.projectCreatedAt);
  if (!Number.isFinite(time)) throw invalid("The project's creation time");
  return { ...scope, projectCreatedAt: new Date(time).toISOString() };
}
const keyOf = (scope: { orgId: OrgId; project: string }, sk: string) => projectLearningKey(scope.orgId, scope.project, sk);

// ---- PR capture setting

/** Whether PR-comment capture is off for the project: the `SETTINGS` item says `on`, otherwise it is off (design 2.5: off by default). B8 adds the company lock to the check it passes in `GroupingOptions`. */
export async function prCaptureOff(deps: LearningDeps, scope: LearningScope): Promise<boolean> {
  const item = await getLearningItem(deps, scope, "SETTINGS");
  return item?.["prComments"] !== "on";
}

// ---- dismissed member sets

/** The key of a member set: a hash of the sorted, distinct correction ids. The same set gives the same key whatever order it is given in. */
export function dismissedSetKey(correctionIds: readonly string[]): string {
  return createHash("sha256").update([...new Set(correctionIds)].sort().join("\n"), "utf8").digest("hex").slice(0, 32);
}

/** Records a dismissal of exactly this member set (B6 calls it where it dismisses). Similar corrections that come later make a new set and are not suppressed. */
export async function recordDismissal(deps: LearningDeps, scope: LearningScope, suggestion: Pick<LearningSuggestion, "id" | "correctionIds" | "signature">): Promise<void> {
  await putDismissed(deps, scope, { signatureHash: dismissedSetKey(suggestion.correctionIds), suggestionId: suggestion.id, signature: [...suggestion.signature] });
}

// ---- reading the project

interface Corr { c: LearningCorrection; sk: string }

const parseCorrection = (item: Item): Corr | undefined => {
  const parsed = LearningCorrectionSchema.safeParse(item);
  return parsed.success && typeof item["sk"] === "string" ? { c: parsed.data, sk: item["sk"] } : undefined;
};
const parseSuggestion = (item: Item): LearningSuggestion | undefined => {
  const parsed = LearningSuggestionSchema.safeParse(item);
  return parsed.success ? parsed.data : undefined;
};
const byTime = (a: Corr, b: Corr): number => (a.c.createdAt === b.c.createdAt ? (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0) : a.c.createdAt < b.c.createdAt ? -1 : 1);
const LIVE_STATUSES = new Set(["open", "accepting", "awaiting_approval"]);
const isLive = (suggestion: LearningSuggestion) => LIVE_STATUSES.has(suggestion.status);
const tasksOf = (members: readonly Corr[]) => new Set(members.map((member) => member.c.taskId)).size;
const asSignature = (c: LearningCorrection): Signature => c.signature;

/** The newest corrections of the window: visible (not expired, of this project), newest first by key, then oldest first. */
async function readWindow(deps: LearningDeps, scope: LearningScope): Promise<Corr[]> {
  const cutoff = new Date(deps.now() - GROUPING_WINDOW_DAYS * 86_400_000).toISOString();
  const pk = keyOf(scope, "STATE").pk;
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
    ExpressionAttributeValues: { ":pk": pk, ":low": `CORRECTION#${cutoff}`, ":high": "CORRECTION#~" },
    ConsistentRead: true, ScanIndexForward: false, Limit: GROUPING_WINDOW_MAX_ITEMS,
  })) as { Items?: Item[] };
  const found: Corr[] = [];
  for (const item of response.Items ?? []) {
    if (visibility(item, { nowMs: deps.now(), projectCreatedAt: scope.projectCreatedAt }) !== "visible") continue;
    const parsed = parseCorrection(item);
    if (parsed !== undefined) found.push(parsed);
  }
  return found.sort(byTime);
}

interface Context {
  state: NonNullable<Awaited<ReturnType<typeof readLearningState>>>;
  off: boolean;
  corrections: Corr[];
  byId: Map<string, Corr>;
  suggestions: Map<string, LearningSuggestion>;
  /** Active rules, with the signatures they are matched against: the suggestion's own and those of its members still in the window. */
  rules: Array<{ rule: LearningRule; signatures: Signature[] }>;
  frequency: DocumentFrequency | undefined;
  /** Shared by every context of one run, so the older members of a stage family are read once per run, not once per round. */
  cache: RunCache;
}

/** Per stage family, the older corrections (outside the window) read from the partition: at most 200 each, read only when a suggestion has a member older than the window. */
interface RunCache { fallback: Map<string, Map<string, Corr>> }
const newCache = (): RunCache => ({ fallback: new Map() });

/** Every suggestion of the project, paged in full: a live suggestion that is not read would leave its members looking free. */
async function readSuggestions(deps: LearningDeps, scope: LearningScope): Promise<Map<string, LearningSuggestion>> {
  const suggestions = new Map<string, LearningSuggestion>();
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const page = await readLearningPartition(deps, scope, { prefix: "SUGGESTION#", ...(cursor === undefined ? {} : { cursor }), maxItems: 100, maxPages: 1, pageSize: 100 });
    scanned += page.scanned;
    for (const item of page.items) {
      const parsed = parseSuggestion(item);
      if (parsed !== undefined) suggestions.set(parsed.id, parsed);
    }
    cursor = page.cursor;
  } while (cursor !== undefined && scanned < SUGGESTIONS_READ_MAX);
  return suggestions;
}

async function readContext(deps: LearningDeps, scope: LearningScope, off: boolean, cache: RunCache = newCache()): Promise<Context | undefined> {
  const state = await readLearningState(deps, scope);
  if (state === undefined) return undefined;
  const corrections = await readWindow(deps, scope);
  const suggestions = await readSuggestions(deps, scope);
  const byId = new Map(corrections.map((entry) => [entry.c.id, entry]));
  const rulePage = await readLearningPartition(deps, scope, { prefix: "RULE#", maxItems: 300, maxPages: 3 });
  // Past the page budget a suggestion can still be missing: read the ones a window correction or an active rule points at, so a held correction never looks free.
  const wanted = new Set<string>(corrections.flatMap((entry) => entry.c.suggestionId === undefined ? [] : [entry.c.suggestionId]));
  for (const item of rulePage.items) {
    const parsed = LearningRuleSchema.safeParse(item);
    if (parsed.success && parsed.data.status === "active") wanted.add(parsed.data.suggestionId);
  }
  for (const id of wanted) {
    if (suggestions.has(id)) continue;
    const raw = await getLearningItem(deps, scope, suggestionSk(id));
    const parsed = raw === undefined ? undefined : parseSuggestion(raw);
    if (parsed !== undefined) suggestions.set(parsed.id, parsed);
  }
  const rules: Context["rules"] = [];
  for (const item of rulePage.items) {
    const parsed = LearningRuleSchema.safeParse(item);
    if (!parsed.success || parsed.data.status !== "active") continue;
    const source = suggestions.get(parsed.data.suggestionId);
    if (source === undefined || source.status !== "accepted") continue;
    const fromMembers = source.correctionIds.flatMap((id) => { const member = byId.get(id); return member === undefined ? [] : [asSignature(member.c)]; });
    rules.push({ rule: parsed.data, signatures: [source.signature, ...fromMembers] });
  }
  const usable = corrections.filter((entry) => entry.c.standing === "member");
  const frequency = usable.length >= FREQUENCY_MIN_SAMPLE ? buildDocumentFrequency(usable.map((entry) => asSignature(entry.c))) : undefined;
  return { state, off, corrections, byId, suggestions, rules, frequency, cache };
}

/** The members of a suggestion that still exist: from the window, else from the older corrections of its stage family (read once per run). Forgotten and expired members are absent. */
async function membersOf(deps: LearningDeps, scope: LearningScope, context: Context, suggestion: LearningSuggestion): Promise<Corr[]> {
  const family = stageFamily(suggestion.stage);
  const missing = suggestion.correctionIds.filter((id) => !context.byId.has(id));
  if (missing.length > 0 && !context.cache.fallback.has(family)) {
    const older = new Map<string, Corr>();
    let cursor: string | undefined;
    let scanned = 0;
    do {
      const page = await readLearningPartition(deps, scope, { prefix: "CORRECTION#", ...(cursor === undefined ? {} : { cursor }), maxItems: 500, maxPages: 1, pageSize: 500 });
      scanned += page.scanned;
      for (const item of page.items) {
        const parsed = parseCorrection(item);
        if (parsed !== undefined && stageFamily(parsed.c.stage) === family && older.size < RESOLVE_PER_FAMILY_MAX) older.set(parsed.c.id, parsed);
      }
      cursor = page.cursor;
    } while (cursor !== undefined && scanned < RESOLVE_MAX_ITEMS);
    context.cache.fallback.set(family, older);
  }
  const older = context.cache.fallback.get(family);
  return suggestion.correctionIds.flatMap((id) => {
    const found = context.byId.get(id) ?? older?.get(id);
    return found === undefined ? [] : [found];
  });
}

// ---- similarity helpers

const similar = (context: Context, a: LearningCorrection, b: LearningCorrection) => compareSignatures(asSignature(a), asSignature(b), context.frequency).similar;
const countsInGrouping = (context: Context, entry: Corr): boolean => entry.c.standing === "member" && !(entry.c.source === "pr_comment" && context.off);

/** A rule's id when the correction repeats an accepted, active rule (the rule's stage family, or a project-wide rule). */
function matchingRule(context: Context, c: LearningCorrection): string | undefined {
  for (const { rule, signatures } of context.rules) {
    if (rule.stage !== "*" && stageFamily(rule.stage) !== stageFamily(c.stage)) continue;
    if (signatures.some((signature) => compareSignatures(asSignature(c), signature, context.frequency).similar)) return rule.id;
  }
  return undefined;
}

// ---- 2. judging: groupedAt, repeatOf and the metric, in one transaction

/** The earliest earlier member correction, of another task and the same stage family, that this one repeats. */
function earlierRepeat(context: Context, entry: Corr): string | undefined {
  for (const other of context.corrections) {
    if (byTime(other, entry) >= 0) break;
    if (!countsInGrouping(context, other) || other.c.taskId === entry.c.taskId || stageFamily(other.c.stage) !== stageFamily(entry.c.stage)) continue;
    if (similar(context, entry.c, other.c)) return other.c.id;
  }
  return undefined;
}

async function judge(deps: LearningDeps, scope: LearningScope, context: Context, entry: Corr): Promise<boolean> {
  const { c } = entry;
  const member = c.standing === "member";
  const rule = member ? matchingRule(context, c) : undefined;
  const repeatOf = member ? rule ?? earlierRepeat(context, entry) : undefined;
  const now = new Date(deps.now()).toISOString();
  const pr = c.source === "pr_comment";
  const items: TransactItem[] = [{
    Update: {
      TableName: deps.tableName, Key: keyOf(scope, entry.sk),
      // `repeatOfRule` marks a repeat of an accepted rule (repeatOf then holds the rule's id), so Forget can reverse the counter without the rule item.
      UpdateExpression: repeatOf === undefined ? "SET groupedAt = :at" : `SET groupedAt = :at, repeatOf = :repeat${rule === undefined ? "" : ", repeatOfRule = :yes"}`,
      ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc AND attribute_not_exists(groupedAt)",
      ExpressionAttributeValues: { ":at": now, ":pc": scope.projectCreatedAt, ...(repeatOf === undefined ? {} : { ":repeat": repeatOf }), ...(rule === undefined || repeatOf === undefined ? {} : { ":yes": true }) },
    },
  }];
  if (member) {
    const deltas: Partial<MetricCounters> = {
      memberCorrections: 1,
      ...(repeatOf === undefined ? {} : { repeats: 1 }), ...(rule === undefined ? {} : { repeatsOfAcceptedRules: 1 }),
      ...(pr ? { prMemberCorrections: 1, ...(repeatOf === undefined ? {} : { prRepeats: 1 }), ...(rule === undefined ? {} : { prRepeatsOfAcceptedRules: 1 }) } : {}),
    };
    const month = metricMonth(c.createdAt);
    await ensureMetricCurrent(deps, scope, month);
    items.push(metricUpdateItem(deps, scope, month, deltas));
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    // Judged by a racing run, forgotten meanwhile, or the project was created again: nothing to count.
    if (isCancellation(error)) return false;
    throw error;
  }
}

// ---- 3. forming suggestions

/** The fields a suggestion takes from its members: all their ids, the wording and signature of the latest, the stage of the latest, and whether one person wrote them all. */
function fieldsFor(members: readonly Corr[]): Pick<LearningSuggestion, "correctionIds" | "allFromOnePerson" | "proposedText" | "signature" | "stage"> | undefined {
  const ordered = [...members].sort(byTime);
  const latest = [...ordered].reverse().find((entry) => entry.c.text !== undefined && proposedRuleText(entry.c.text) !== "");
  if (latest === undefined) return undefined;
  return {
    correctionIds: ordered.map((entry) => entry.c.id), allFromOnePerson: new Set(ordered.map((entry) => entry.c.author)).size === 1,
    proposedText: proposedRuleText(latest.c.text!), signature: [...latest.c.signature], stage: latest.c.stage,
  };
}

/** A member's `suggestionId` is set to `sid` only if it still is what this run read (none, or the earlier suggestion that ended), so a correction is never in two live suggestions. */
function linkMemberItem(deps: LearningDeps, scope: LearningScope, entry: Corr, sid: string): TransactItem {
  const seen = entry.c.suggestionId;
  return {
    Update: {
      TableName: deps.tableName, Key: keyOf(scope, entry.sk), UpdateExpression: "SET suggestionId = :sid",
      ConditionExpression: seen === undefined ? "attribute_exists(pk) AND projectCreatedAt = :pc AND attribute_not_exists(suggestionId)" : "attribute_exists(pk) AND projectCreatedAt = :pc AND suggestionId = :seen",
      ExpressionAttributeValues: { ":sid": sid, ":pc": scope.projectCreatedAt, ...(seen === undefined ? {} : { ":seen": seen }) },
    },
  };
}

/** The write that changes an open suggestion's members and the fields taken from them. It holds only at the revision read. */
function rewriteSuggestionItem(deps: LearningDeps, scope: LearningScope, suggestion: LearningSuggestion, fields: NonNullable<ReturnType<typeof fieldsFor>>): TransactItem {
  return {
    Update: {
      TableName: deps.tableName, Key: keyOf(scope, suggestionSk(suggestion.id)),
      UpdateExpression: "SET correctionIds = :ids, allFromOnePerson = :one, proposedText = :text, #signature = :signature, stage = :stage, #revision = #revision + :bump",
      ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc AND #status = :open AND #revision = :seen",
      ExpressionAttributeNames: { "#signature": "signature", "#revision": "revision", "#status": "status" },
      ExpressionAttributeValues: {
        ":ids": fields.correctionIds, ":one": fields.allFromOnePerson, ":text": fields.proposedText, ":signature": fields.signature, ":stage": fields.stage, ":bump": 1,
        ":pc": scope.projectCreatedAt, ":open": "open", ":seen": suggestion.revision,
      },
    },
  };
}

async function send(deps: LearningDeps, items: TransactItem[]): Promise<"ok" | "conflict"> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return "ok";
  } catch (error) {
    if (isCancellation(error)) return "conflict";
    throw error;
  }
}

/** Free corrections of a stage family: judged, member, with text, not covered by an active rule, not in a live or accepted suggestion. */
function freeCorrections(context: Context): Corr[] {
  const activeRules = new Set(context.rules.map((entry) => entry.rule.id));
  return context.corrections.filter((entry) => {
    if (!countsInGrouping(context, entry) || entry.c.groupedAt === undefined || entry.c.text === undefined) return false;
    if (entry.c.repeatOf !== undefined && activeRules.has(entry.c.repeatOf)) return false;
    // A repeat of an accepted rule never starts another suggestion for it, even one judged before the rule was published (it was waiting in a live suggestion then): it only feeds the metric.
    if (matchingRule(context, entry.c) !== undefined) return false;
    const holder = entry.c.suggestionId === undefined ? undefined : context.suggestions.get(entry.c.suggestionId);
    return holder === undefined || (!isLive(holder) && holder.status !== "accepted");
  });
}

type Step = { kind: "none" } | { kind: "conflict" } | { kind: "joined"; id: string } | { kind: "opened"; id: string } | { kind: "capped" };

/** Joins free corrections that are similar to a member of an open suggestion; false when nothing joined. */
async function joinStep(deps: LearningDeps, scope: LearningScope, context: Context, free: Corr[]): Promise<Step> {
  for (const suggestion of context.suggestions.values()) {
    if (suggestion.status !== "open") continue;
    const members = await membersOf(deps, scope, context, suggestion);
    if (members.length === 0) continue;
    const family = stageFamily(suggestion.stage);
    const present = new Set(members.map((entry) => entry.c.id));
    const grown = [...members];
    let changed = true;
    while (changed && grown.length < LEARNING_SUGGESTION_SOURCES_MAX) {
      changed = false;
      for (const candidate of free) {
        if (present.has(candidate.c.id) || stageFamily(candidate.c.stage) !== family || grown.length >= LEARNING_SUGGESTION_SOURCES_MAX) continue;
        if (grown.some((member) => similar(context, candidate.c, member.c))) {
          grown.push(candidate);
          present.add(candidate.c.id);
          changed = true;
        }
      }
    }
    const added = grown.filter((entry) => !members.includes(entry));
    if (added.length === 0) continue;
    const fields = fieldsFor(grown);
    if (fields === undefined || grown.length > LEARNING_SUGGESTION_SOURCES_MAX) continue;
    const outcome = await send(deps, [rewriteSuggestionItem(deps, scope, suggestion, fields), ...added.map((entry) => linkMemberItem(deps, scope, entry, suggestion.id))]);
    return outcome === "ok" ? { kind: "joined", id: suggestion.id } : { kind: "conflict" };
  }
  return { kind: "none" };
}

/** Single-link groups of free corrections, one per stage family, oldest seed first. */
function components(context: Context, free: Corr[]): Corr[][] {
  const seen = new Set<string>();
  const result: Corr[][] = [];
  for (const seed of free) {
    if (seen.has(seed.c.id)) continue;
    const family = stageFamily(seed.c.stage);
    const group: Corr[] = [];
    const queue = [seed];
    seen.add(seed.c.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      group.push(current);
      for (const other of free) {
        if (seen.has(other.c.id) || stageFamily(other.c.stage) !== family) continue;
        if (similar(context, current.c, other.c)) {
          seen.add(other.c.id);
          queue.push(other);
        }
      }
    }
    result.push(group);
  }
  return result;
}

async function openStep(deps: LearningDeps, scope: LearningScope, context: Context, free: Corr[], newId: () => string): Promise<Step> {
  // A free correction that is similar to a member of a live suggestion that cannot take it (full, or already being accepted) belongs to that one: it does not start another.
  const live: Corr[] = [];
  for (const suggestion of context.suggestions.values()) if (isLive(suggestion)) live.push(...(await membersOf(deps, scope, context, suggestion)));
  const unclaimed = free.filter((candidate) => !live.some((member) => stageFamily(member.c.stage) === stageFamily(candidate.c.stage) && similar(context, candidate.c, member.c)));
  for (const group of components(context, unclaimed)) {
    if (tasksOf(group) < 2) continue;
    // More than 10 in a chain: the newest 10, which is the same pick on every run.
    const picked = group.length > LEARNING_SUGGESTION_SOURCES_MAX ? [...group].sort(byTime).slice(-LEARNING_SUGGESTION_SOURCES_MAX) : group;
    if (picked.length < LEARNING_SUGGESTION_SOURCES_MIN || tasksOf(picked) < 2) continue;
    const dismissed = await getLearningItem(deps, scope, `DISMISSED#${dismissedSetKey(picked.map((entry) => entry.c.id))}`);
    if (dismissed !== undefined) continue;
    if (context.state.openSuggestions >= LEARNING_OPEN_SUGGESTIONS_MAX) return { kind: "capped" };
    const fields = fieldsFor(picked);
    if (fields === undefined) continue;
    const nowMs = deps.now();
    const id = newId();
    const suggestion = LearningSuggestionSchema.parse({
      id, ...fields, status: "open", lessSafe: false, kinds: [], overlaps: [], revision: 0, createdAt: new Date(nowMs).toISOString(), projectCreatedAt: scope.projectCreatedAt,
    });
    const month = metricMonth(suggestion.createdAt);
    await ensureMetricCurrent(deps, scope, month);
    const audited = await learningEvents(deps, () => [suggestedEvent(deps, scope, {
      suggestionId: id, stage: suggestion.stage, sourceCount: picked.length, sourceKinds: [...new Set(picked.map((entry) => entry.c.source))].sort().join(","), lessSafe: suggestion.lessSafe, fromOnePerson: suggestion.allFromOnePerson,
    })]);
    const outcome = await send(deps, [
      {
        Update: {
          TableName: deps.tableName, Key: keyOf(scope, "STATE"), UpdateExpression: "SET #revision = #revision + :one ADD openSuggestions :one",
          ConditionExpression: "projectCreatedAt = :pc AND #revision = :expected AND openSuggestions < :cap", ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: { ":one": 1, ":pc": scope.projectCreatedAt, ":expected": context.state.revision, ":cap": LEARNING_OPEN_SUGGESTIONS_MAX },
        },
      },
      { Put: { TableName: deps.tableName, Item: { ...keyOf(scope, suggestionSk(id)), entityType: "LEARNING_SUGGESTION", orgId: scope.orgId, ...suggestion }, ConditionExpression: "attribute_not_exists(pk)" } },
      ...picked.map((entry) => linkMemberItem(deps, scope, entry, id)),
      metricUpdateItem(deps, scope, month, { suggestions: 1 }),
      ...audited.items,
    ]);
    if (outcome === "ok") await flushLearningEvents(deps, audited.events);
    return outcome === "ok" ? { kind: "opened", id } : { kind: "conflict" };
  }
  return { kind: "none" };
}

// ---- the entry point

/**
 * One grouping run for a project (design 4.3). Call it after a correction is stored (B3, B4, B8); a failure is the caller's to log, and the next run finishes the work, since a correction
 * with no `groupedAt` is judged again and a free correction is grouped again. Safe to run at the same time as itself.
 */
export async function groupCorrections(deps: LearningDeps, rawScope: LearningScope, options: GroupingOptions = {}): Promise<GroupingResult> {
  const scope = normalized(rawScope);
  const result: GroupingResult = { judged: 0, opened: [], joined: [], withdrawn: [], capped: false };
  const off = await (options.prCaptureOff ?? prCaptureOff)(deps, scope);
  if (off) result.withdrawn.push(...await withdrawPrDependentSuggestions(deps, scope));

  const cache = newCache();
  const first = await readContext(deps, scope, off, cache);
  if (first === undefined) return result;
  for (const entry of first.corrections.filter((candidate) => candidate.c.groupedAt === undefined && !(candidate.c.source === "pr_comment" && off)).slice(0, JUDGE_MAX)) {
    if (await judge(deps, scope, first, entry)) result.judged += 1;
  }

  let conflicts = 0;
  for (let round = 0; round < FORM_ROUNDS_MAX; round += 1) {
    const context = await readContext(deps, scope, off, cache);
    if (context === undefined) break;
    const free = freeCorrections(context);
    if (free.length === 0) break;
    let step = await joinStep(deps, scope, context, free);
    if (step.kind === "none") step = await openStep(deps, scope, context, free, options.newId ?? randomUUID);
    if (step.kind === "none") break;
    if (step.kind === "capped") { result.capped = true; break; }
    if (step.kind === "conflict") {
      conflicts += 1;
      if (conflicts >= CONFLICTS_MAX) break;
      continue;
    }
    (step.kind === "opened" ? result.opened : result.joined).push(step.id);
  }
  return result;
}

// ---- PR capture off

/**
 * Applies "PR capture is off" to the open suggestions (design 2.5): a suggestion left with fewer than 2 non-PR sources (or from fewer than 2 tasks) is withdrawn, which clears its
 * `proposedText` through the store's terminal move; one that keeps 2 or more loses its PR members. The PR corrections themselves keep their text until it expires. Returns the withdrawn ids.
 * `groupCorrections` calls it when capture is off; B8 calls it when the setting or the company lock changes.
 */
export async function withdrawPrDependentSuggestions(deps: LearningDeps, rawScope: LearningScope): Promise<string[]> {
  const scope = normalized(rawScope);
  const context = await readContext(deps, scope, true);
  if (context === undefined) return [];
  const withdrawn: string[] = [];
  for (const suggestion of context.suggestions.values()) {
    // Only open suggestions are withdrawn or rewritten here; one that is accepting or awaiting approval is left alone. B6 must re-check PR-only membership at Accept.
    if (suggestion.status !== "open") continue;
    const members = await membersOf(deps, scope, context, suggestion);
    const dependent = members.filter((entry) => entry.c.source === "pr_comment");
    if (dependent.length === 0) continue;
    const rest = members.filter((entry) => entry.c.source !== "pr_comment");
    const fields = rest.length >= LEARNING_SUGGESTION_SOURCES_MIN && tasksOf(rest) >= 2 ? fieldsFor(rest) : undefined;
    if (fields === undefined) {
      const closed = await closeSuggestion(deps, scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "withdrawn" });
      if (closed.ok) withdrawn.push(suggestion.id);
      continue;
    }
    await send(deps, [
      rewriteSuggestionItem(deps, scope, suggestion, fields),
      ...dependent.map((entry): TransactItem => ({
        Update: {
          TableName: deps.tableName, Key: keyOf(scope, entry.sk), UpdateExpression: "REMOVE suggestionId", ConditionExpression: "attribute_exists(pk) AND suggestionId = :sid",
          ExpressionAttributeValues: { ":sid": suggestion.id },
        },
      })),
    ]);
  }
  return withdrawn;
}

// ---- Forget

/**
 * Deletes a correction and takes it out of every count: the project's live count, the month's metric (if it was counted) and its suggestion. A suggestion left with fewer than 2 sources
 * (or from fewer than 2 tasks) is withdrawn first, with its text cleared. Refused for a correction in an accepted rule (its text is gone and the rule is published) and while its suggestion is
 * being accepted. Who may forget is B3's to check. Pass `sourceKey` to delete the source record too, so the same comment can be remembered again.
 */
export async function forgetCorrection(deps: LearningDeps, rawScope: LearningScope, input: { correctionSk: string; sourceKey?: string; actor?: string }): Promise<ForgetResult> {
  const scope = normalized(rawScope);
  const item = await getLearningItem(deps, scope, input.correctionSk);
  const entry = item === undefined ? undefined : parseCorrection(item);
  if (entry === undefined) return { ok: false, reason: "missing" };
  const { c } = entry;

  // What the suggestion becomes, written in the same transaction as the delete: a rewrite, or the withdrawal of one left with fewer than 2 sources.
  let suggestionWrites: TransactItem[] = [];
  let readSuggestion: LearningSuggestion | undefined;
  let withdrawing = false;
  if (c.suggestionId !== undefined) {
    const raw = await getLearningItem(deps, scope, suggestionSk(c.suggestionId));
    const suggestion = raw === undefined ? undefined : parseSuggestion(raw);
    // Judged by the stored status first: an item that does not read as a suggestion never lets a forget through while a rule may be built from it.
    const storedStatus = raw?.["status"];
    if (storedStatus === "accepted") return { ok: false, reason: "in_accepted_rule" };
    if (storedStatus === "accepting" || storedStatus === "awaiting_approval" || (storedStatus === "open" && suggestion === undefined)) return { ok: false, reason: "suggestion_busy" };
    if (suggestion !== undefined && isLive(suggestion)) {
      if (suggestion.status !== "open") return { ok: false, reason: "suggestion_busy" };
      readSuggestion = suggestion;
      const context = await readContext(deps, scope, true);
      const members = context === undefined ? [] : await membersOf(deps, scope, context, suggestion);
      const rest = members.filter((member) => member.c.id !== c.id);
      const fields = rest.length >= LEARNING_SUGGESTION_SOURCES_MIN && tasksOf(rest) >= 2 ? fieldsFor(rest) : undefined;
      // The withdrawal's own STATE update (one fewer open) is folded into Forget's single STATE update below: a transaction may not name an item twice.
      suggestionWrites = fields === undefined
        ? terminalSuggestionItems(deps, scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "withdrawn" }).slice(0, 1)
        : [rewriteSuggestionItem(deps, scope, suggestion, fields)];
      withdrawing = fields === undefined;
    }
  }

  const counted = c.groupedAt !== undefined && c.standing === "member";
  const items: TransactItem[] = [
    {
      Delete: {
        TableName: deps.tableName, Key: keyOf(scope, entry.sk),
        ConditionExpression: `attribute_exists(pk) AND projectCreatedAt = :pc AND ${c.groupedAt === undefined ? "attribute_not_exists(groupedAt)" : "groupedAt = :grouped"}`,
        ExpressionAttributeValues: { ":pc": scope.projectCreatedAt, ...(c.groupedAt === undefined ? {} : { ":grouped": c.groupedAt }) },
      },
    },
    {
      Update: {
        TableName: deps.tableName, Key: keyOf(scope, "STATE"), UpdateExpression: withdrawing ? "ADD liveCorrections :minus, openSuggestions :minus" : "ADD liveCorrections :minus",
        ConditionExpression: "attribute_exists(pk) AND projectCreatedAt = :pc", ExpressionAttributeValues: { ":minus": -1, ":pc": scope.projectCreatedAt },
      },
    },
  ];
  items.push(...suggestionWrites);
  if (counted) {
    // A repeat of a rule is reversed from the correction's own marker; an item written before the marker existed falls back to the rule item.
    const ruleRepeat = c.repeatOf !== undefined && (item?.["repeatOfRule"] === true || await getLearningItem(deps, scope, `RULE#${c.repeatOf}`) !== undefined);
    const rule = ruleRepeat ? c.repeatOf : undefined;
    const pr = c.source === "pr_comment";
    const month = metricMonth(c.createdAt);
    await ensureMetricCurrent(deps, scope, month);
    items.push(metricUpdateItem(deps, scope, month, {
      memberCorrections: -1,
      ...(c.repeatOf === undefined ? {} : { repeats: -1 }), ...(rule === undefined ? {} : { repeatsOfAcceptedRules: -1 }),
      ...(pr ? { prMemberCorrections: -1, ...(c.repeatOf === undefined ? {} : { prRepeats: -1 }), ...(rule === undefined ? {} : { prRepeatsOfAcceptedRules: -1 }) } : {}),
    }));
  }
  if (input.sourceKey !== undefined) items.push({ Delete: { TableName: deps.tableName, Key: keyOf(scope, sourceSk(scope.projectCreatedAt, input.sourceKey)) } });
  // The events of this forget, in the same transaction: the correction forgotten (when a person did it) and the suggestion it left withdrawn (by the system).
  const audited = await learningEvents(deps, () => [
    ...(input.actor === undefined ? [] : [rememberedEvent(deps, scope, memberActor(input.actor), { correctionId: c.id, stage: c.stage, standing: c.standing, op: "forget" })]),
    ...(withdrawing && readSuggestion !== undefined ? [dismissedEvent(deps, scope, systemActor(), { suggestionId: readSuggestion.id, stage: readSuggestion.stage, dismissKind: "withdrawn" })] : []),
  ]);
  items.push(...audited.items);

  const outcome = await send(deps, items);
  if (outcome === "ok") {
    await flushLearningEvents(deps, audited.events);
    return { ok: true };
  }
  // Changed under us (judged, grouped or forgotten meanwhile): a gone correction is answered as gone, anything else asks the caller to try again.
  const again = await getLearningItem(deps, scope, input.correctionSk);
  if (again === undefined) return { ok: false, reason: "missing" };
  if (readSuggestion !== undefined) {
    const now = await getLearningItem(deps, scope, suggestionSk(readSuggestion.id));
    // Being accepted is busy; only the revision having moved (a member joined, a rewrite) means the item changed and a refresh is needed.
    if (now === undefined || now["status"] === "accepting" || now["status"] === "awaiting_approval") return { ok: false, reason: "suggestion_busy" };
    if (now["revision"] !== readSuggestion.revision || now["status"] !== "open") return { ok: false, reason: "suggestion_changed" };
  }
  throw unavailable();
}
