// Plan 3 Task 20b: how an agent's connector write is classified, and what it is sent as.
//
// `prepareAgentWrite` runs first, before classification and before an approval is stored, so an approval holds exactly what will be sent: it strips
// @-mentions (unless the recipe allows them) and adds Rovara's own label to a tracker create. `classifyWrite` is the pure core: it follows the steps of
// the plan in order and returns `read`, `safe`, `consequential` or `merge`, and a project's deny rule for `decideWrite` to refuse. `classifyAgentWrite`
// resolves what the core cannot know by itself (the repository's comment rule, label names, the items this run created) and fails closed: a lookup that
// breaks makes the call consequential, never safe. `recordOwnItems` keeps what a create made, so a later change to it by the same run is `safe`.
//
// A write is `safe` only when its name says it records something (a create, a comment, a label) and nothing in the call needs a person; every other
// write waits (fix round 1, C1). Tool names are split on every character that is not a letter or digit, after NFKC and the confusable fold (C2).
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { BULK_ITEM_LIMIT, CONSEQUENTIAL_KEYS, CONSEQUENTIAL_VALUES, DESTRUCTIVE_WORDS, INDEX_EXPIRY_ATTRIBUTE, OUTWARD_KEYS, OUTWARD_WORDS, ROVARA_LABEL, SAFE_CHANGE_KEYS, TRACKER_ITEM_WORDS, WRITE_VERBS, agentItemKey, agentItemsPk, agentXError, baseClass, cleanText, commentSignal, destructiveSignal, itemCount, itemPathValues, matchingPolicyRules, nameWords, normalizeForMatching, stripMentions, toolPatternMatches, type ActionClass, type ActionPolicy, type AgentConnectorType, type ApprovalRules, type Autonomy, type GrantedTool, type OrgId, type ToolFacts, type WriteClass } from "@rovara-code/contracts";
import { commentTriggerRule } from "./comment-trigger-optouts.js";
import { resolveLabelNames, type LabelConnector, type LabelNameDependencies } from "./label-names.js";

/**
 * Code-owned exceptions per connector type and upstream tool name. An entry may lower `consequential` to `safe` (never a merge, a bulk call, a call
 * with an assignee, an outward send, a command, an unlabelled tracker create, a destructive call, or anything a project rule, an always-ask rule or
 * the agent's autonomy raised), and may raise any call. Empty here: Plan 4's new connectors fill it.
 */
export type WriteClassOverrides = Partial<Record<AgentConnectorType, Record<string, "safe" | "consequential">>>;
export const WRITE_CLASS_OVERRIDES: WriteClassOverrides = {};

/**
 * Read-approved tools whose names carry a destructive word but only read (Jira's `get_transitions` lists the transitions an issue could take). By
 * connector type, with the name as `foldedName` writes it (lower case, words joined by `_`). Reviewed like the overrides: an entry is a decision that
 * a tool with this exact name never writes. The vendor's own hints still apply.
 */
export const READ_NAME_EXCEPTIONS: Readonly<Partial<Record<AgentConnectorType, readonly string[]>>> = {
  jira: ["get_transitions", "list_transitions", "get_issue_transitions", "list_issue_transitions", "get_transitions_for_jira_issue"],
  mcp: ["get_transitions", "list_transitions", "get_issue_transitions", "list_issue_transitions", "get_transitions_for_jira_issue"],
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** A value that is set: not undefined, null, the empty string, or an empty list or object. */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/** A key compared without case or `_`/`-` separators, as the lifecycle keys are. */
function normalisedKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/gu, "");
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const MAX_WALK_DEPTH = 64;

/**
 * The first object key (compared as `normalisedKey`) that `matches` and holds a set value, anywhere in the arguments, in objects and arrays. Paths in
 * `skip` (written as `a.b` and `a[].b`) are not entered. `tooDeep` when the arguments nest beyond the walk limit.
 */
function findSetKey(value: unknown, matches: (normalised: string) => boolean, skip: ReadonlySet<string>): { found: boolean; tooDeep: boolean } {
  let tooDeep = false;
  const walk = (current: unknown, path: string, depth: number): boolean => {
    if (current === null || typeof current !== "object") return false;
    if (depth > MAX_WALK_DEPTH) {
      tooDeep = true;
      return false;
    }
    if (Array.isArray(current)) return (current as unknown[]).some((entry) => walk(entry, `${path}[]`, depth + 1));
    return Object.entries(current).some(([key, entry]) => {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (skip.has(childPath)) return false;
      if (matches(normalisedKey(key)) && isSet(entry)) return true;
      return walk(entry, childPath, depth + 1);
    });
  };
  const found = walk(value, "", 0);
  return { found, tooDeep };
}

/** The paths (`a.b`, `a[].b`, as commentSignal reads them) of every object key that `matches`, at any depth. */
function pathsOfKeys(value: unknown, matches: (normalised: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (current: unknown, path: string, depth: number): void => {
    if (current === null || typeof current !== "object" || depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(current)) {
      for (const entry of current as unknown[]) walk(entry, `${path}[]`, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (matches(normalisedKey(key))) found.push(childPath);
      walk(entry, childPath, depth + 1);
    }
  };
  walk(value, "", 0);
  return found;
}

/** Whether a value under a key named `event` (or another key of CONSEQUENTIAL_VALUES), anywhere in the arguments, is one of the listed values. */
function hasConsequentialValue(value: unknown): boolean {
  const table = new Map(Object.entries(CONSEQUENTIAL_VALUES).map(([key, listed]) => [normalisedKey(key), new Set(listed.map((entry) => entry.toUpperCase()))]));
  const walk = (current: unknown, depth: number): boolean => {
    if (current === null || typeof current !== "object" || depth > MAX_WALK_DEPTH) return false;
    if (Array.isArray(current)) return (current as unknown[]).some((entry) => walk(entry, depth + 1));
    return Object.entries(current).some(([key, entry]) => {
      const listed = table.get(normalisedKey(key));
      if (listed !== undefined && typeof entry === "string" && listed.has(entry.trim().toUpperCase())) return true;
      return walk(entry, depth + 1);
    });
  };
  return walk(value, 0);
}

// ---------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------

/** Argument names that hold what a person wrote: a fact that calls one of them non-text or a scope is wrong, and is ignored. */
const CONTENT_ARGUMENT_NAMES: ReadonlySet<string> = new Set(["title", "body", "text", "description", "comment", "message", "summary"]);

function namesContent(path: string): boolean {
  return path.split(".").some((segment) => CONTENT_ARGUMENT_NAMES.has(normalisedKey(segment.replace(/\[\]$/u, ""))));
}

/**
 * What is wrong with the argument lists in a tool's facts: `nonTextArguments` and `itemScopeArguments` must never name a free-text field (`title`,
 * `body`, `text`, `description`, `comment`, `message`, `summary`), because those arguments are not scanned for commands. Task 19 calls it when it builds
 * the facts. The classifier ignores an entry that fails anyway, so a mistake only makes the call stricter.
 */
export function nonTextFactProblems(facts: ToolFacts): string[] {
  const problems: string[] = [];
  for (const [list, paths] of [["nonTextArguments", facts.nonTextArguments], ["itemScopeArguments", facts.itemScopeArguments]] as const) {
    for (const path of paths ?? []) if (namesContent(path)) problems.push(`${list}: "${path.slice(0, 64)}" names a free-text field`);
  }
  return problems;
}

const usableNonText = (facts: ToolFacts): string[] => (facts.nonTextArguments ?? []).filter((path) => !namesContent(path));
const usableScope = (facts: ToolFacts): string[] => (facts.itemScopeArguments ?? []).filter((path) => !namesContent(path));

/** The tool's name as the classifier reads it: NFKC and the confusable fold, then every run of non-letters and non-digits as `_`. */
function foldedName(name: string): string {
  return nameWords(normalizeForMatching(name).replace(/[^\p{L}\p{N}]+/gu, "_")).join("_");
}

const wordsOf = (name: string): string[] => foldedName(name).split("_").filter((word) => word !== "");

/** The facts the classifier reads: the tool's own, with the access the project approved it for, its name folded, and unusable fact entries removed. */
function factsOf(tool: GrantedTool): ToolFacts {
  return { ...tool.facts, access: tool.access, upstreamName: foldedName(tool.upstreamName), nonTextArguments: usableNonText(tool.facts), itemScopeArguments: usableScope(tool.facts) };
}

/** The facts the project's rules match against: the name as the connector writes it. */
function ruleFactsOf(tool: GrantedTool): ToolFacts {
  return { ...tool.facts, access: tool.access };
}

/** The paths that are not text to scan: item references, scope arguments, and the arguments the schema declares as paths, URLs or choices. */
function skipPathsOf(facts: ToolFacts): string[] {
  return unique([...(facts.itemArguments ?? []), ...usableNonText(facts), ...usableScope(facts)]);
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

const WRITE_VERB_SET: ReadonlySet<string> = new Set(WRITE_VERBS);
/** The brief's outward words, and more: share, forward, mail, dm, chat, tweet and broadcast send something to people (fix round 1, I1). */
const OUTWARD_WORD_SET: ReadonlySet<string> = new Set([...OUTWARD_WORDS, "share", "forward", "mail", "dm", "chat", "tweet", "broadcast"]);
const OUTWARD_EXACT_KEYS: ReadonlySet<string> = new Set(OUTWARD_KEYS.map(normalisedKey));
const OUTWARD_KEY_PARTS = ["email", "recipient", "phone", "webhook", "url", "endpoint", "address", "channel", "sharewith"];
const isOutwardKey = (key: string): boolean => OUTWARD_EXACT_KEYS.has(key) || OUTWARD_KEY_PARTS.some((part) => key.includes(part));

const TRACKER_BASE_WORDS: ReadonlySet<string> = new Set([...TRACKER_ITEM_WORDS, "card", "todo", "subtask", "subissue"]);
const NOT_A_CREATE_WORDS: ReadonlySet<string> = new Set(["comment", "reply", "review"]);
/**
 * What a record verb may create and stay safe: the tracker words and their forms, and the things people write down or sort by (a comment, a note, a
 * label, a tag, a reaction, a draft, a document, a branch, a pull request, a reply). A create of anything else (a payment, a key, a deployment, an
 * incident) waits, whatever the verb (fix round 2, N1).
 */
const RECORD_OBJECT_WORDS: ReadonlySet<string> = new Set([
  ...TRACKER_BASE_WORDS, "comment", "note", "label", "tag", "reaction", "draft", "document", "doc", "branch", "pull", "pr", "pullrequest", "reply",
]);

/** A word of `set`, or its plural (`notes`, `stories`). */
function inWordSet(set: ReadonlySet<string>, word: string): boolean {
  if (set.has(word)) return true;
  if (word.endsWith("ies") && set.has(`${word.slice(0, -3)}y`)) return true;
  return word.endsWith("s") && set.has(word.slice(0, -1));
}

/** A tracker item word, or its plural (`issues`, `stories`). */
const isTrackerWord = (word: string): boolean => inWordSet(TRACKER_BASE_WORDS, word);

/**
 * The verbs that make a write a record: a create, a comment, a label, an edit of what the run made. A write is `safe` only when its name has one of
 * these and none of the verbs that act on the world; the list is explicit, in code (fix round 1, C1).
 */
const RECORD_VERBS: ReadonlySet<string> = new Set([
  "create", "add", "new", "insert", "save", "upsert", "write", "log", "note", "comment", "reply", "append", "record", "update", "edit", "set", "label", "tag", "annotate",
]);
const ACTION_VERBS: ReadonlySet<string> = new Set(WRITE_VERBS.filter((verb) => !RECORD_VERBS.has(verb)));
/** `post` and `reply` in a comment's name (`post_comment`, `reply_to_comment`) put a comment on an item; elsewhere they send something outward. */
const COMMENT_ONLY_WORDS: ReadonlySet<string> = new Set(["post", "reply"]);

/** The words of a name that count for outward and action checks: `post` and `reply` do not when the name says comment. */
function actingWords(words: readonly string[]): string[] {
  return words.includes("comment") ? words.filter((word) => !COMMENT_ONLY_WORDS.has(word)) : [...words];
}

/**
 * The destructive word a name word is, or is the plural or gerund of (`deletes`, `closing`, `cancelling`). Not the past tense: `closed` and
 * `merged` are the filter words of `list_closed_issues` and `get_merged_pull_requests`.
 */
function destructiveStem(word: string): string | undefined {
  if (DESTRUCTIVE_WORDS.has(word)) return word;
  for (const suffix of ["es", "s"] as const) {
    if (word.endsWith(suffix) && DESTRUCTIVE_WORDS.has(word.slice(0, -suffix.length))) return word.slice(0, -suffix.length);
  }
  if (word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    const found = [stem, `${stem}e`, ...(stem.endsWith("ll") ? [stem.slice(0, -1)] : [])].find((candidate) => DESTRUCTIVE_WORDS.has(candidate));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Why a name is not a read's: a write verb (base form) or a destructive word (any inflection but the past tense) among its words. */
function writeWordIn(name: string): string | undefined {
  for (const word of wordsOf(name)) {
    if (WRITE_VERB_SET.has(word)) return word;
    const stem = destructiveStem(word);
    if (stem !== undefined) return stem;
  }
  return undefined;
}

function isReadNameException(tool: GrantedTool): boolean {
  if (!Object.hasOwn(READ_NAME_EXCEPTIONS, tool.type)) return false;
  return (READ_NAME_EXCEPTIONS[tool.type] ?? []).includes(foldedName(tool.upstreamName));
}

/** Whether the vendor's own hints say a tool that the project approved to read writes or destroys. They only tighten. */
function hintsSayWrite(facts: ToolFacts): boolean {
  return facts.hints?.readOnlyHint === false || facts.hints?.destructiveHint === true;
}

/**
 * Whether a tool the project approved for reading is a read: its name has no write verb and no destructive word (bar a reviewed exception), and the
 * vendor does not say it writes. A tool approved as a write is never a read, whatever its name says.
 */
export function isReadByName(tool: GrantedTool): boolean {
  return tool.access === "read" && (isReadNameException(tool) || writeWordIn(tool.upstreamName) === undefined) && !hintsSayWrite(tool.facts);
}

/** Any word of the name that contains `merge` or `merging` (`merged`, `automerge`) makes a write a merge; `emergency` does not. */
const isMergeTool = (tool: GrantedTool): boolean => wordsOf(tool.upstreamName).some((word) => /merg(?:e|ing)/u.test(word) && !word.startsWith("emerg"));

const MERGE_METHOD_KEYS: ReadonlySet<string> = new Set(["method", "action", "mergemethod"]);
const MERGE_METHOD_VALUES: ReadonlySet<string> = new Set(["merge", "squash", "rebase"]);

/**
 * Whether the arguments merge or arrange to merge: a set key with `merge` or `autocomplete` in its name, `completionOptions` set, or a `method`,
 * `action` or `mergeMethod` of merge, squash or rebase (fix round 2, N4). `false`, null, empty and an empty object do not count.
 */
function mergesByArguments(args: unknown): boolean {
  const walk = (current: unknown, depth: number): boolean => {
    if (current === null || typeof current !== "object" || depth > MAX_WALK_DEPTH) return false;
    if (Array.isArray(current)) return (current as unknown[]).some((entry) => walk(entry, depth + 1));
    return Object.entries(current).some(([key, entry]) => {
      const normal = normalisedKey(key);
      if ((normal.includes("merge") || normal.includes("autocomplete") || normal === "completionoptions") && entry !== false && isSet(entry)) return true;
      if (MERGE_METHOD_KEYS.has(normal) && typeof entry === "string" && MERGE_METHOD_VALUES.has(entry.trim().toLowerCase())) return true;
      return walk(entry, depth + 1);
    });
  };
  return walk(args, 0);
}

/** A write is a merge by its name, or by what it sets. */
const isMergeCall = (tool: GrantedTool, args: unknown): boolean => isMergeTool(tool) || mergesByArguments(args);

/** A create of a ticket, issue or task: a tracker item name without comment, reply or review, and no existing item named. */
function isTrackerCreate(tool: GrantedTool, args: Record<string, unknown>): boolean {
  if (tool.access !== "write") return false;
  const words = wordsOf(tool.upstreamName);
  if (!words.some(isTrackerWord) || words.some((word) => NOT_A_CREATE_WORDS.has(word))) return false;
  return baseClass(tool.upstreamName, factsOf(tool), args) === "create";
}

// ---------------------------------------------------------------------------------------------
// Label arguments
// ---------------------------------------------------------------------------------------------

/** A normalised key with `label` or `tag` in it (`stage` is not one): `labels`, `labelNames`, `tags`, `issueLabelIds`. */
const isLabelWord = (key: string): boolean => key.includes("label") || /(?:^|[^s])tag/u.test(key);
/** Keys that take labels off an item: a label key with `remove` or `removed` in it. */
const isLabelRemovalKey = (key: string): boolean => isLabelWord(key) && key.includes("remove");
/** Keys that hold label ids, at any depth: a label key that also has `id` in it. They are resolved to names through the connector's label list. */
const isLabelIdKey = (key: string): boolean => isLabelWord(key) && !key.includes("remove") && key.replace(/label|tag/gu, "").includes("id");
/** Keys that hold label names, at any depth: a label key that is neither an id nor a removal. */
const isLabelNameKey = (key: string): boolean => isLabelWord(key) && !key.includes("remove") && !isLabelIdKey(key);
/** Keys that set a label list whole. */
const LABEL_SET_KEYS: ReadonlySet<string> = new Set(["labels", "labelids"]);
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/u;

function segmentsOf(path: string): string[] | undefined {
  const segments = path.split(".");
  return segments.length > 0 && segments.length <= 4 && segments.every((segment) => PATH_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment)) ? segments : undefined;
}

/** The value at a dotted path through plain objects, or undefined. */
function valueAt(args: Record<string, unknown>, segments: readonly string[]): unknown {
  let current: unknown = args;
  for (const segment of segments) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The same object with the value at `segments` replaced by `update(current)`, creating plain objects on the way; undefined when it can't be set. */
function withValueAt(
  object: Record<string, unknown>,
  segments: readonly string[],
  update: (current: unknown) => unknown,
): Record<string, unknown> | undefined {
  const [head, ...rest] = segments;
  if (head === undefined) return undefined;
  const current = Object.hasOwn(object, head) ? object[head] : undefined;
  if (rest.length === 0) {
    const next = update(current);
    return next === undefined ? undefined : { ...object, [head]: next };
  }
  if (current !== undefined && current !== null && !isPlainObject(current)) return undefined;
  const inner = withValueAt(isPlainObject(current) ? current : {}, rest, update);
  return inner === undefined ? undefined : { ...object, [head]: inner };
}

const isRovara = (label: string): boolean => label.trim().toLowerCase() === ROVARA_LABEL;

/** Whether a label value (a list of names, or a comma-separated string) carries `rovara` as one of its labels. */
function carriesRovara(value: unknown): boolean {
  if (Array.isArray(value)) return (value as unknown[]).some((label) => typeof label === "string" && isRovara(label));
  return typeof value === "string" && value.split(",").some(isRovara);
}

/** The label value with `rovara` added, in its own shape; undefined when the value is of a shape that can't be extended. */
function withRovara(current: unknown, shape: ToolFacts["labelArgumentShape"]): unknown {
  if (current === undefined || current === null || current === "") return shape === "comma_list" ? ROVARA_LABEL : [ROVARA_LABEL];
  if (Array.isArray(current)) {
    if (!(current as unknown[]).every((label) => typeof label === "string")) return undefined;
    return carriesRovara(current) ? current : [...(current as string[]), ROVARA_LABEL];
  }
  if (typeof current === "string") {
    if (carriesRovara(current)) return current;
    const kept = current.replace(/[,\s]+$/u, "");
    if (kept === "") return ROVARA_LABEL;
    return `${kept}${current.includes(", ") ? ", " : ","}${ROVARA_LABEL}`;
  }
  return undefined;
}

/** The label ids a call carries (under a label-id key at any depth, or a declared label id argument), and whether any is in a shape that can't be read as one. */
export function labelIdValues(facts: ToolFacts, args: Record<string, unknown>): { ids: string[]; unreadable: boolean } {
  const ids = new Set<string>();
  let unreadable = false;
  const take = (value: unknown): void => {
    const parts = Array.isArray(value) ? (value as unknown[]) : [value];
    for (const part of parts) {
      if (typeof part === "string") {
        for (const piece of part.split(",")) if (piece.trim() !== "") ids.add(piece.trim());
      } else if (typeof part === "number" && Number.isFinite(part)) {
        ids.add(String(part));
      } else if (part !== undefined && part !== null) {
        unreadable = true;
      }
    }
  };
  const walk = (current: unknown, depth: number): void => {
    if (current === null || typeof current !== "object") return;
    if (depth > MAX_WALK_DEPTH) {
      unreadable = true;
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current as unknown[]) walk(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (isLabelIdKey(normalisedKey(key)) && isSet(entry)) take(entry);
      else walk(entry, depth + 1);
    }
  };
  walk(args, 0);
  for (const path of facts.labelIdArguments ?? []) {
    const segments = segmentsOf(path);
    if (segments === undefined) {
      unreadable = true;
      continue;
    }
    const value = valueAt(args, segments);
    if (isSet(value)) take(value);
  }
  return { ids: [...ids], unreadable };
}

/**
 * Whether a call takes labels off the item (`removeLabels`, `removedLabelIds`, or a `remove` or `set` operation inside a label list, as Jira's `update`
 * does), and whether it sets a whole label list that the tool says replaces the item's labels.
 */
function labelChanges(tool: GrantedTool, facts: ToolFacts, args: Record<string, unknown>): { removes: boolean; replaces: boolean } {
  const replaceDefault = tool.type === "github";
  const replacing = facts.labelsReplace ?? replaceDefault;
  let removes = findSetKey(args, isLabelRemovalKey, new Set()).found;
  let replaces = false;
  const walk = (current: unknown, inLabels: boolean, depth: number): void => {
    if (current === null || typeof current !== "object" || depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(current)) {
      for (const entry of current as unknown[]) walk(entry, inLabels, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      const normal = normalisedKey(key);
      if (inLabels && (normal === "remove" || normal === "set") && isSet(entry)) removes = true;
      if (replacing && LABEL_SET_KEYS.has(normal) && isSet(entry)) replaces = true;
      walk(entry, inLabels || isLabelWord(normal), depth + 1);
    }
  };
  walk(args, false, 0);
  if (replacing) {
    for (const path of [facts.labelArgument, ...(facts.labelIdArguments ?? [])]) {
      const segments = path === undefined ? undefined : segmentsOf(path);
      if (segments !== undefined && isSet(valueAt(args, segments))) replaces = true;
    }
  }
  return { removes, replaces };
}

// ---------------------------------------------------------------------------------------------
// prepareAgentWrite
// ---------------------------------------------------------------------------------------------

function cleanStrings(value: unknown, path: string, depth: number, skip: ReadonlySet<string>): unknown {
  if (typeof value === "string") return cleanText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_WALK_DEPTH) throw agentXError("CONFIG_INVALID", "The arguments are nested too deeply to check, so the request was not sent.");
  if (Array.isArray(value)) return (value as unknown[]).map((entry) => cleanStrings(entry, `${path}[]`, depth + 1, skip));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const childPath = path === "" ? key : `${path}.${key}`;
    return [key, skip.has(childPath) ? entry : cleanStrings(entry, childPath, depth + 1, skip)];
  }));
}

/**
 * What an agent's call is sent as. It runs before classification and before an approval is stored. Text arguments are cleaned (NFKC, invisible
 * characters removed) so the text that is checked is the text that is sent; @-mentions are stripped unless the recipe allows them; and a tracker create
 * whose schema declares a label argument gets Rovara's own `rovara` label, keeping the agent's labels and the argument's shape. Item references and
 * arguments the schema declares as not text are left exactly as given. The input is not changed. A tool approved only for reading is left alone.
 */
export function prepareAgentWrite(tool: GrantedTool, args: Record<string, unknown>, options: { allowMentions: boolean }): { args: Record<string, unknown>; strippedMentions: string[] } {
  if (tool.access === "read" || !isPlainObject(args)) return { args, strippedMentions: [] };
  const skip = skipPathsOf(tool.facts);
  let prepared: Record<string, unknown>;
  let strippedMentions: string[] = [];
  if (options.allowMentions) {
    prepared = cleanStrings(args, "", 0, new Set(skip)) as Record<string, unknown>;
  } else {
    const stripped = stripMentions(args, { skipPaths: skip });
    prepared = stripped.args as Record<string, unknown>;
    strippedMentions = stripped.stripped;
  }
  const labelled = addRovaraLabel(tool, prepared);
  return { args: labelled, strippedMentions };
}

function addRovaraLabel(tool: GrantedTool, args: Record<string, unknown>): Record<string, unknown> {
  const path = tool.facts.labelArgument;
  if (path === undefined || !isTrackerCreate(tool, args)) return args;
  const segments = segmentsOf(path);
  if (segments === undefined) return args;
  return withValueAt(args, segments, (current) => withRovara(current, tool.facts.labelArgumentShape)) ?? args;
}

// ---------------------------------------------------------------------------------------------
// Own items
// ---------------------------------------------------------------------------------------------

/**
 * The scope an item number lives in, from the call's scope arguments (`owner/repo`, lower case): empty when the tool declares none, undefined when it
 * declares some and the call lacks one, and undefined for a `github` tool that declares none (no own-item exemption until it does).
 */
function ownScope(tool: GrantedTool, facts: ToolFacts, args: Record<string, unknown>): string | undefined {
  const declared = usableScope(facts);
  if (declared.length === 0) return tool.type === "github" ? undefined : "";
  const parts: string[] = [];
  for (const path of declared) {
    const segments = segmentsOf(path);
    const value = segments === undefined ? undefined : valueAt(args, segments);
    const text = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
    if (text === "" || text.includes("#")) return undefined;
    parts.push(text.toLowerCase());
  }
  return parts.join("/");
}

const ownKey = (connector: string, scope: string, value: string): string => `${connector}#${scope}#${value}`;

/** `<connector>#<scope>#<value>` for every existing item a call names, or none when its scope can't be known. */
function ownItemKeys(tool: GrantedTool, facts: ToolFacts, args: Record<string, unknown>): string[] {
  const scope = ownScope(tool, facts, args);
  if (scope === undefined) return [];
  const values = (facts.itemArguments ?? []).flatMap((path) => itemPathValues(args, path));
  return values.map((value) => ownKey(tool.connector, scope, typeof value === "string" ? value : JSON.stringify(value)));
}

// ---------------------------------------------------------------------------------------------
// classifyWrite
// ---------------------------------------------------------------------------------------------

export interface ClassifyWriteInput {
  tool: GrantedTool;
  /** The prepared arguments (`prepareAgentWrite`'s), exactly as they would be sent. */
  args: Record<string, unknown>;
  projectPolicy?: ActionPolicy | undefined;
  rules: ApprovalRules;
  autonomy: Autonomy;
  allowMentions: boolean;
  /** `<connector>#<scope>#<value>` for every item this run created. */
  ownItems: ReadonlySet<string>;
  /** The org's guardrails that add to the maintained command and trigger-label lists. */
  guardrails?: { extraCommandWords: readonly string[]; extraTriggerLabels: readonly string[] } | undefined;
  /** Label id to name for the connector, from `resolveLabelNames`; an id that is missing or `undefined` could not be resolved. Absent: nothing was looked up. */
  labelNames?: ReadonlyMap<string, string | undefined> | undefined;
  /** The repository rule for a GitHub write, from `commentTriggerRule`. Absent for a GitHub write: it could not be checked. */
  repositoryRule?: { consequential: boolean } | undefined;
  /** Defaults to `WRITE_CLASS_OVERRIDES`. */
  overrides?: WriteClassOverrides | undefined;
}

export interface WriteClassification {
  class: WriteClass;
  reason: string;
  /** The 1-based numbers of the project's rules that were ignored because they would have lowered the class (or, for a read, would have made it wait). */
  ignoredRules: number[];
  /** A project deny rule that matches: `decideWrite` refuses the call, whatever the class. */
  denied?: { rule: number; reason: string };
}

interface Cause {
  reason: string;
  /** A cause a code override may never lower. */
  hard: boolean;
}

const ACTION_RANK: Readonly<Record<ActionClass, number>> = { read: 0, create: 1, change: 2, destructive: 3 };

interface RuleBook {
  denied?: { rule: number; reason: string };
  /** Matching `ask` rules; `exact` when the rule names one tool with no `*`. */
  asks: Array<{ rule: number; exact: boolean }>;
  /** The strictest class a matching treatAs rule asks for, above the base class. */
  raised?: { rule: number; to: ActionClass };
  /** Allow rules and lowering treatAs rules. */
  ignored: number[];
}

function readRuleBook(input: ClassifyWriteInput, ruleFacts: ToolFacts, baseRank: number, args: Record<string, unknown>): RuleBook {
  const book: RuleBook = { asks: [], ignored: [] };
  const policy = input.projectPolicy;
  if (policy === undefined) return book;
  for (const number of matchingPolicyRules({ name: input.tool.presentedName, facts: ruleFacts, args, policy })) {
    const rule = policy.rules[number - 1];
    if (rule === undefined) continue;
    if (rule.outcome === "deny") book.denied ??= { rule: number, reason: rule.reason ?? `an administrator's deny rule matches ${rule.tool}` };
    else if (rule.outcome === "ask") book.asks.push({ rule: number, exact: !rule.tool.includes("*") });
    else if (rule.outcome === "allow") book.ignored.push(number);
    else if (rule.treatAs !== undefined) {
      const rank = ACTION_RANK[rule.treatAs];
      if (rank < baseRank) book.ignored.push(number);
      else if (rank > baseRank && (book.raised === undefined || rank > ACTION_RANK[book.raised.to])) book.raised = { rule: number, to: rule.treatAs };
    }
  }
  return book;
}

/** The top-level argument names that are not content of the change: item references and scope arguments. */
function exemptTopLevel(facts: ToolFacts): Set<string> {
  const names = [...(facts.itemArguments ?? []), ...usableScope(facts)].filter((path) => !/[.[]/u.test(path));
  return new Set(names.map(normalisedKey));
}

const SAFE_CHANGE_KEY_SET: ReadonlySet<string> = new Set(SAFE_CHANGE_KEYS.map(normalisedKey));
const CONSEQUENTIAL_KEY_SET: ReadonlySet<string> = new Set(CONSEQUENTIAL_KEYS.map(normalisedKey));
/** Keys that assign work, ask for a review, file work with a team or project, or hand something over (fix round 1, I2; round 2, N3). */
const CONSEQUENTIAL_KEY_PARTS = ["assign", "reviewer", "lead", "member", "subscriber", "delegate", "owner", "team", "project"];
const isConsequentialKey = (key: string): boolean => CONSEQUENTIAL_KEY_SET.has(key) || CONSEQUENTIAL_KEY_PARTS.some((part) => key.includes(part));

/** A change is safe on an item this run created, or when everything it sets is a safe key (and it sets one) and takes no label off or replaces the labels. */
function changeCause(input: ClassifyWriteInput, facts: ToolFacts, args: Record<string, unknown>): Cause | undefined {
  const references = ownItemKeys(input.tool, facts, args);
  if (references.length > 0 && references.every((key) => input.ownItems.has(key))) return undefined;
  const labels = labelChanges(input.tool, facts, args);
  if (labels.removes) return { reason: "it takes a label off an item this run did not create", hard: true };
  if (labels.replaces) return { reason: "it replaces the labels of an item this run did not create", hard: true };
  const exempt = exemptTopLevel(facts);
  const set = Object.entries(args).filter(([key, value]) => isSet(value) && !exempt.has(normalisedKey(key)));
  if (set.length > 0 && set.every(([key]) => SAFE_CHANGE_KEY_SET.has(normalisedKey(key)))) return undefined;
  return { reason: "it changes an item this run did not create", hard: false };
}

/** The most items a call touches: `itemCount`, and the comma lists and item-path values of its declared item arguments. */
function bulkCount(facts: ToolFacts, args: Record<string, unknown>): number {
  let count = itemCount(args);
  for (const path of facts.itemArguments ?? []) {
    const values = itemPathValues(args, path);
    count = Math.max(count, values.length);
    for (const value of values) {
      if (Array.isArray(value)) count = Math.max(count, value.length);
      else if (typeof value === "string") count = Math.max(count, value.split(",").filter((part) => part.trim() !== "").length);
    }
  }
  return count;
}

function lookupOverride(overrides: WriteClassOverrides, tool: GrantedTool): "safe" | "consequential" | undefined {
  if (!Object.hasOwn(overrides, tool.type)) return undefined;
  const table = overrides[tool.type];
  return table !== undefined && Object.hasOwn(table, tool.upstreamName) ? table[tool.upstreamName] : undefined;
}

const alwaysAskMatches = (input: ClassifyWriteInput, exactOnly: boolean): boolean =>
  input.rules.alwaysAsk.some((pattern) => (!exactOnly || !pattern.includes("*")) && (toolPatternMatches(pattern, input.tool.upstreamName) || toolPatternMatches(pattern, input.tool.presentedName)));

/**
 * Classifies an agent's write, in the plan's order. The first cause names the reason; a code override may lower the class to `safe` only when no hard
 * cause raised it. Pure: what it needs from lookups comes in as `ownItems`, `labelNames` and `repositoryRule`, and a lookup that is missing counts
 * against the call.
 */
export function classifyWrite(input: ClassifyWriteInput): WriteClassification {
  const { tool } = input;
  const facts = factsOf(tool);
  const plain = isPlainObject(input.args);
  const args = plain ? input.args : {};
  const baseAction: ActionClass = plain ? baseClass(tool.upstreamName, facts, args) : "change";
  const book = readRuleBook(input, ruleFactsOf(tool), ACTION_RANK[baseAction], args);
  const overrides = input.overrides ?? WRITE_CLASS_OVERRIDES;
  const finish = (klass: WriteClass, reason: string, ignored: readonly number[] = book.ignored): WriteClassification => ({
    class: klass, reason, ignoredRules: [...ignored].sort((left, right) => left - right), ...(book.denied === undefined ? {} : { denied: book.denied }),
  });
  const raiseOnly = (klass: WriteClass, reason: string, ignored?: readonly number[]): WriteClassification => {
    const result = finish(klass, reason, ignored);
    return klass !== "merge" && lookupOverride(overrides, tool) === "consequential" ? { ...result, class: "consequential" } : result;
  };

  // 1. Reads never wait, and only reads: the rule applies only to a tool the project approved for reading, whose name carries no write word.
  // An administrator's rule or an always-ask entry that names the tool exactly still makes it wait; wildcards and suggest autonomy do not.
  if (tool.access === "read") {
    const problem = isReadNameException(tool) ? undefined : writeWordIn(tool.upstreamName);
    if (problem === undefined && !hintsSayWrite(tool.facts)) {
      const exactAsk = book.asks.some((ask) => ask.exact) || alwaysAskMatches(input, true);
      if (exactAsk) return raiseOnly("consequential", "an administrator's rule or this agent's recipe says to ask for this tool", [...book.ignored, ...book.asks.filter((ask) => !ask.exact).map((ask) => ask.rule)]);
      const unused = [...book.ignored, ...book.asks.map((ask) => ask.rule), ...(book.raised === undefined ? [] : [book.raised.rule])];
      return raiseOnly("read", "the project approved this tool for reading and its name says nothing else", unused);
    }
    return raiseOnly("consequential", problem === undefined ? "the vendor marks this tool as writing, but the project approved it only for reading" : `the project approved this tool only for reading, but its name says "${problem}"`);
  }

  // 2. A merge, then a destructive name or a state change.
  if (isMergeTool(tool)) return finish("merge", "the tool's name says \"merge\"");
  if (mergesByArguments(args)) return finish("merge", "the call merges, or sets the pull request to merge when it can");
  const causes: Cause[] = [];
  const add = (reason: string, hard: boolean): void => { causes.push({ reason, hard }); };
  if (!plain) add("the arguments are not an object", true);
  const destructive = destructiveSignal(facts.upstreamName, args, facts.itemArguments);
  if (destructive !== undefined) add(destructive.startsWith("the tool's name") ? destructive : "the call changes the state of an item", true);
  const words = wordsOf(tool.upstreamName);
  const acting = actingWords(words);

  // 3. A command in the text, a trigger label, a label id that can't be resolved, or a repository that reacts to comments.
  const skip = skipPathsOf(facts);
  const labelPaths = unique([...pathsOfKeys(args, isLabelNameKey), ...(facts.labelArgument === undefined ? [] : [facts.labelArgument])]);
  const signalOptions = {
    allowMentions: input.allowMentions,
    labelPaths,
    skipPaths: skip,
    extraCommandWords: input.guardrails?.extraCommandWords,
    extraTriggerLabels: input.guardrails?.extraTriggerLabels,
  };
  if (commentSignal(args, signalOptions).consequential) add("the text holds a command, a mention that triggers a bot, or a label that starts an automation", true);
  const labels = labelIdValues(facts, args);
  if (labels.unreadable) add("a label id is in a shape that can't be checked", true);
  const resolved: string[] = [];
  let unresolved = false;
  for (const id of labels.ids) {
    const name = input.labelNames?.get(id);
    if (name === undefined) unresolved = true;
    else resolved.push(name);
  }
  if (unresolved) add("a label id could not be resolved to a name", true);
  if (resolved.length > 0 && commentSignal({ labels: resolved }, { ...signalOptions, labelPaths: ["labels"], skipPaths: [] }).consequential) {
    add("a label starts an automation", true);
  }
  if (tool.type === "github") {
    if (input.repositoryRule === undefined) add("the repository's comment-triggered workflows could not be checked", true);
    else if (input.repositoryRule.consequential) add("this repository has workflows that act on comments or labels", true);
  }

  // 4. The base class (without project rules), with what makes a create or a change more than safe.
  const items = bulkCount(facts, args);
  if (items > BULK_ITEM_LIMIT) add(`this write touches ${String(items)} items; more than ${String(BULK_ITEM_LIMIT)} always asks`, true);
  const outwardWord = acting.find((word) => OUTWARD_WORD_SET.has(word));
  const outwardKey = findSetKey(args, isOutwardKey, new Set());
  if (outwardWord !== undefined) add(`the tool's name says "${outwardWord}", which sends something outward`, true);
  else if (outwardKey.found || outwardKey.tooDeep) add("the call sets a recipient, address or URL, which sends something outward", true);
  const actionVerb = acting.find((word) => ACTION_VERBS.has(word));
  if (destructive === undefined) {
    if (actionVerb !== undefined) add(`the tool's name says "${actionVerb}"`, false);
    else if (!words.some((word) => RECORD_VERBS.has(word))) add("the tool's name does not say it only records or labels something", false);
  }
  if (facts.itemArguments === undefined && facts.hints?.destructiveHint === true) add("the vendor marks this tool destructive and Rovara can't tell what it changes", false);
  const classCause = (action: ActionClass): Cause | undefined => {
    if (action === "destructive") return destructive === undefined ? { reason: "this action is destructive", hard: true } : undefined;
    if (action === "change") return changeCause(input, facts, args);
    if (action === "create" && isTrackerCreate(tool, args) && !carriesRovaraLabel(facts, args)) return { reason: "it creates a ticket without Rovara's label", hard: true };
    if (action === "create" && !words.some((word) => inWordSet(RECORD_OBJECT_WORDS, word))) return { reason: "it creates something that is not a comment, note, label or other record", hard: false };
    return undefined;
  };
  const base = classCause(baseAction);
  if (base !== undefined) causes.push(base);

  // 5. An assignee, owner, reviewer, member, team or project; an approving or rejecting review.
  const consequentialKeys = findSetKey(args, isConsequentialKey, new Set(usableScope(facts)));
  if (consequentialKeys.found || consequentialKeys.tooDeep || hasConsequentialValue(args)) add("the call sets an assignee, owner, reviewer, team or project, or approves or rejects a review", true);

  // 6. Project rules only raise.
  if (book.asks.length > 0) add("an administrator's rule says to ask for this tool", true);
  if (book.raised !== undefined) {
    const raised = classCause(book.raised.to);
    if (raised !== undefined) causes.push({ ...raised, hard: true });
  }

  // 7. Always-ask patterns, and an agent that only suggests.
  if (alwaysAskMatches(input, false)) add("this agent's recipe always asks for this tool", true);
  if (input.autonomy === "suggest") add("this agent only suggests, so every write waits", true);

  // 8. Code overrides.
  const first = causes[0];
  if (first === undefined) return raiseOnly("safe", "it only creates or labels, and nothing in it needs a person");
  const override = lookupOverride(overrides, tool);
  if (override === "safe" && causes.every((cause) => !cause.hard)) return finish("safe", "a Rovara exception says this tool is safe");
  return finish("consequential", first.reason);
}

function carriesRovaraLabel(facts: ToolFacts, args: Record<string, unknown>): boolean {
  const segments = facts.labelArgument === undefined ? undefined : segmentsOf(facts.labelArgument);
  return segments !== undefined && carriesRovara(valueAt(args, segments));
}

// ---------------------------------------------------------------------------------------------
// The items a run created
// ---------------------------------------------------------------------------------------------

export interface OwnItemDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

const TASK_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const MAX_OWN_ITEMS_PER_RESULT = 50;
const MAX_OWN_ITEM_LENGTH = 200;
const OWN_ITEM_DAYS = 30;
const OWN_ITEM_PAGE_LIMIT = 50;

function checkedTaskId(taskId: string): string {
  if (!TASK_ID.test(taskId)) throw agentXError("CONFIG_INVALID", "taskId: not a task id");
  return taskId;
}

/** `<connector>#<scope>#<value>` for every item the run created, read now from the table under the org and the task. Throws when the table can't be read. */
export async function loadOwnItems(deps: OwnItemDependencies, input: { orgId: OrgId; taskId: string }): Promise<Set<string>> {
  const taskId = checkedTaskId(input.taskId);
  const found = new Set<string>();
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < OWN_ITEM_PAGE_LIMIT; page += 1) {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": agentItemsPk(input.orgId, taskId) },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      if (item["orgId"] === input.orgId && item["taskId"] === taskId && typeof item["sk"] === "string") found.add(item["sk"]);
    }
    start = response.LastEvaluatedKey;
    if (start === undefined) return found;
  }
  // More items than the pages read: the rest are unknown, which only makes later changes ask.
  return found;
}

function usableItemValue(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
  if (text === undefined || text === "" || text.length > MAX_OWN_ITEM_LENGTH || /[\p{Cc}\p{Cf}]/u.test(text)) return undefined;
  return text;
}

/** The JSON a connector result carries: the text itself, or each text part of an MCP result's `content`. */
function resultRoots(resultText: string): Array<Record<string, unknown>> {
  const roots: Array<Record<string, unknown>> = [];
  const parse = (text: string): unknown => { try { return JSON.parse(text) as unknown; } catch { return undefined; } };
  const outer = parse(resultText);
  if (!isPlainObject(outer)) return roots;
  roots.push(outer);
  if (Array.isArray(outer["content"])) {
    for (const part of outer["content"] as unknown[]) {
      const text = isPlainObject(part) ? part["text"] : undefined;
      const inner = typeof text === "string" ? parse(text) : undefined;
      if (isPlainObject(inner)) roots.push(inner);
    }
  }
  return roots;
}

/**
 * After a successful create, keeps `<connector>#<scope>#<value>` for every value at the tool's item paths in the result, so a later change to that
 * item by the same run is the run's own. The scope comes from the create's own scope arguments (a repository's `owner/repo`); a create whose scope
 * can't be known records nothing. Only a create records anything. It never throws: the create already happened, so a failed write is reported
 * (`failed`) and the item stays unrecorded, which only makes a later change ask. At most 50 values are kept per result, in one transaction.
 */
export async function recordOwnItems(
  deps: OwnItemDependencies,
  input: { orgId: OrgId; taskId: string; tool: GrantedTool; args: Record<string, unknown>; resultText: string },
): Promise<{ recorded: number; failed: boolean }> {
  try {
    const taskId = checkedTaskId(input.taskId);
    const facts = factsOf(input.tool);
    if (input.tool.access !== "write" || !isPlainObject(input.args) || baseClass(input.tool.upstreamName, facts, input.args) !== "create") return { recorded: 0, failed: false };
    const scope = ownScope(input.tool, facts, input.args);
    if (scope === undefined) return { recorded: 0, failed: false };
    const paths = unique([...(facts.itemArguments ?? []), ...(facts.resultItemArguments ?? [])]);
    const values = new Set<string>();
    for (const root of resultRoots(input.resultText)) {
      for (const path of paths) {
        for (const raw of itemPathValues(root, path)) {
          const value = usableItemValue(raw);
          if (value !== undefined && values.size < MAX_OWN_ITEMS_PER_RESULT) values.add(value);
        }
      }
    }
    if (values.size === 0) return { recorded: 0, failed: false };
    const expiry = Math.floor(deps.now() / 1000) + OWN_ITEM_DAYS * 86_400;
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [...values].map((value) => ({
        Put: {
          TableName: deps.tableName,
          Item: {
            ...agentItemKey(input.orgId, taskId, `${input.tool.connector}#${scope}`, value), entityType: "AGENT_ITEM", orgId: input.orgId, taskId, connector: input.tool.connector,
            [INDEX_EXPIRY_ATTRIBUTE]: expiry,
          },
        },
      })),
    }));
    return { recorded: values.size, failed: false };
  } catch {
    return { recorded: 0, failed: true };
  }
}

// ---------------------------------------------------------------------------------------------
// classifyAgentWrite: the lookups, failing closed
// ---------------------------------------------------------------------------------------------

export type ClassifyAgentWriteDependencies = LabelNameDependencies & OwnItemDependencies & Parameters<typeof commentTriggerRule>[0];

export type ClassifyAgentWriteInput = Omit<ClassifyWriteInput, "ownItems" | "labelNames" | "repositoryRule"> & {
  orgId: OrgId;
  taskId: string;
  project: string;
  /** The repository (`owner/name`) a GitHub write is in: the project's connector for the call. The call's own `owner` and `repo` must name it. */
  repository?: string | undefined;
  /** The installation the project pinned for that repository: the scan is held to it (Task 14b's fix round). */
  installationId?: number | undefined;
};

/** The repository (`owner/name`, lower case) a GitHub call names in its `owner` and `repo` arguments, or undefined when it names none. */
function callRepository(args: unknown): string | undefined {
  if (!isPlainObject(args)) return undefined;
  const { owner, repo } = args;
  if (typeof owner !== "string" || typeof repo !== "string" || owner.trim() === "" || repo.trim() === "") return undefined;
  return `${owner.trim()}/${repo.trim()}`.toLowerCase();
}

/**
 * `classifyWrite` with its lookups done: the run's own items (read now), the names of the label ids in the call (through the connector's label list,
 * once per run), and for a GitHub write the repository's comment rule (scanned once per run, with the audited opt-out). A lookup that fails makes the
 * call consequential. A GitHub call whose own `owner` and `repo` are missing or are not `repository` is consequential without a scan. A read, and a
 * merge, need none of them and read nothing.
 */
export async function classifyAgentWrite(deps: ClassifyAgentWriteDependencies, input: ClassifyAgentWriteInput): Promise<WriteClassification> {
  const { orgId, taskId, project, repository, installationId, ...rest } = input;
  const { tool, args } = input;
  if (isReadByName(tool) || (tool.access === "write" && isMergeCall(tool, args))) return classifyWrite({ ...rest, ownItems: new Set<string>() });

  let ownItems = new Set<string>();
  try {
    ownItems = await loadOwnItems(deps, { orgId, taskId });
  } catch {
    // Nothing known about the run's own items: every change to an item is then not the run's own.
  }

  let labelNames: Map<string, string | undefined> | undefined;
  const ids = isPlainObject(args) ? labelIdValues(factsOf(tool), args).ids : [];
  if (ids.length > 0) {
    const connector: LabelConnector = { type: tool.type, id: tool.connector, ...(tool.type === "github" && repository !== undefined ? { repository } : {}) };
    try {
      labelNames = await resolveLabelNames(deps, { orgId, taskId, connector, ids });
    } catch {
      labelNames = undefined;
    }
  }

  let repositoryRule: { consequential: boolean } | undefined;
  if (tool.type === "github" && repository !== undefined) {
    const named = callRepository(args);
    if (named === undefined || named !== repository.toLowerCase()) {
      repositoryRule = { consequential: true };
    } else {
      try {
        const rule = await commentTriggerRule(deps, { orgId, project, repository, taskId, cache: deps.runCache({ orgId, taskId }), ...(installationId === undefined ? {} : { installationId }) });
        repositoryRule = { consequential: rule.consequential };
      } catch {
        repositoryRule = { consequential: true };
      }
    }
  }

  return classifyWrite({ ...rest, ownItems, labelNames, repositoryRule });
}
