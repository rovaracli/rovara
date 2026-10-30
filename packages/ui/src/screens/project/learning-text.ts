// "Suggested rules": every fixed word of the section, and how a refusal is read. Who may decide, what is less safe and whose standing counts come from the server; nothing here works any of that out.
import { LEARNING_DISMISS_KINDS, LEARNING_PROJECT_WIDE, parseStageRefusalMessage } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import { safeAppPath } from "../../text/links.js";
import { visibleText } from "../../design/VisibleText.js";
import { STAGE_LABELS, refusalText } from "./stage-model-text.js";

export const LEARNING_TEXT = {
 EMPTY: "No suggested rules yet. Rovara suggests one when the same correction comes up twice.",
 LOAD_FAILED: "Couldn't load suggested rules. Try again.",
 LOADING: "Loading suggested rules",
 WORDING_LABEL: "Proposed wording",
 WORDING_HINT: "Proposed wording (from the latest correction). Edit before accepting.",
 STAGE_LABEL: "Use this rule for",
 PROJECT_WIDE: "Everyone except reviewers (project-wide)",
 SECOND_PERSON_MARK: "needs a second person",
 ONE_PERSON: "All from one person",
 LESS_SAFE: "Needs a second person",
 LESS_SAFE_BODY: "Someone else who can approve changes in this project confirms this rule before it applies.",
 READ_ONLY: "Only a project maintainer can decide.",
 SAVING: "Saving",
 WAITING: "Waiting for a second person",
 ACCEPT: "Accept as new version",
 REQUEST_APPROVAL: "Request approval",
 DISMISS: "Dismiss…",
 DISMISS_LEGEND: "Why dismiss this?",
 DISMISS_NOTE: "Note (optional)",
 DISMISS_SEND: "Dismiss suggestion",
 CANCEL: "Cancel",
 REOPEN: "Reopen",
 REMOVE: "Remove rule",
 RELOAD: "Reload",
 TRY_AGAIN: "Try again",
 OPEN_CONFIRMATION: "Open confirmation",
 NEEDS_EDITOR: "This rule was edited by hand. Remove it in the editor.",
 CUT_SHORT: "This list is cut short. It shows the newest.",
 FIX_LINK: "How to fix this",
 REFUSALS_HEADING: "These model choices can't be published yet.",
 DISMISSED_LIST: "Dismissed suggestions",
 RULES_LIST: "Rules added by suggestions",
 SAVED: "Saved.",
} as const;
export const addedMessage = (version: number | undefined) => version === undefined ? "Added. New tasks use it; running tasks keep their version." : `Added in version ${String(version)}. New tasks use it; running tasks keep their version.`;
export const removedMessage = (version: number | undefined) => version === undefined ? "Removed. New tasks use the change; running tasks keep their version." : `Removed in version ${String(version)}. New tasks use it; running tasks keep their version.`;
export const DISMISSED_MESSAGE = "Dismissed. You can reopen it from the Dismissed list.";
export const REOPENED_MESSAGE = "Reopened. It is back in the suggested rules.";
export const whyText = (count: number) => `Why: said ${String(count)} ${count === 1 ? "time" : "times"}`;
export const overlapText = (rules: readonly string[]) => "May overlap with: " + rules.join("; ");
export const lessSafeWordsText = (words: readonly string[]) => "Words that triggered this: " + words.join(", ");
export const headerText = (count: number) => `Suggested rules (${String(count)})`;
export const dismissedToggle = (count: number) => `Dismissed (${String(count)})`;
export const addedToggle = (count: number) => `Added by suggestions (${String(count)})`;

const DISMISS_LABELS: Readonly<Record<(typeof LEARNING_DISMISS_KINDS)[number], string>> = { wrong: "Wrong or not helpful", already_covered: "Already covered by a rule", one_off: "One-off, not a pattern", other: "Other" };
export const DISMISS_OPTIONS = LEARNING_DISMISS_KINDS.map(kind => ({ value: kind, label: DISMISS_LABELS[kind] }));
export const dismissLabel = (kind: string | undefined): string | undefined => kind !== undefined && Object.hasOwn(DISMISS_LABELS, kind) ? DISMISS_LABELS[kind as keyof typeof DISMISS_LABELS] : undefined;
const KIND_LABELS: Readonly<Record<string, string>> = { comment: "Comment", send_back: "Plan send-back", pr_comment: "Pull request comment" };
export const sourceKindLabel = (kind: string): string => Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind]! : "Correction";
export const standingLabel = (standing: string): string | undefined => standing === "member" ? "Team member" : standing === "outsider" ? "Outside the team" : undefined;
const RULE_STATUS: Readonly<Record<string, string>> = { pending: LEARNING_TEXT.SAVING, awaiting_approval: LEARNING_TEXT.WAITING, active: "Active", not_applied: "Not applied", removed: "Removed" };
export const ruleStatusLabel = (status: string): string => Object.hasOwn(RULE_STATUS, status) ? RULE_STATUS[status]! : "Unknown";

/** A stage by its name in the project's How we work (the step's own name), `*` in words, and an id this page does not know as the id itself. */
export const stageLabel = (stage: string, names: ReadonlyMap<string, string>): string => stage === LEARNING_PROJECT_WIDE ? LEARNING_TEXT.PROJECT_WIDE : names.get(stage) ?? visibleText(stage);

/** The link of a source: an app path, or the server's own task page path (`/review/<task>/task`). Anything else is shown as text. */
export const taskPageHref = (href: string | undefined): { kind: "app" | "page"; href: string } | undefined => {
 if (href === undefined) return undefined;
 if (safeAppPath(href)) return { kind: "app", href };
 return /^\/review\/[A-Za-z0-9_-]{1,100}\/task$/.test(href) ? { kind: "page", href } : undefined;
};

const FIXED: Readonly<Record<string, string>> = {
 AGENT_REVISION_CONFLICT: "This suggestion changed. Reload and try again.",
 LEARNING_LAYER_BUSY: "Finish or discard the How we work draft or pending change first.",
 LEARNING_RULES_FULL: "This stage's rules are full. Make room in How we work first.",
 LEARNING_SOURCES_GONE: "This suggestion no longer has enough sources.",
 RATE_LIMITED: "Too many requests. Wait a moment and try again.",
 PROJECT_ACCESS_DENIED: "You don't have access to decide this suggestion.",
};
export type MessagePart = { text: string; href?: string };
/** A refusal's words as parts: a same-site app path (`/app/...`) is a link, everything else (another site, a script, a protocol-relative address) stays text. */
export function messageParts(message: string): MessagePart[] {
 const parts: MessagePart[] = [];
 let last = 0;
 for (const match of message.matchAll(/(?<![\w/.:%-])\/app\/[^\s]*[^\s.,;:!?)]/gu)) {
  if (!safeAppPath(match[0])) continue;
  if (match.index > last) parts.push({ text: message.slice(last, match.index) });
  parts.push({ text: match[0], href: match[0] });last = match.index + match[0].length;
 }
 if (last < message.length) parts.push({ text: message.slice(last) });
 return parts;
}
export type Failure =
 | { kind: "fixed"; text: string; reload: boolean }
 | { kind: "refusals"; items: Array<{ text: string; href?: string }> }
 | { kind: "message"; parts: MessagePart[] };
/** What to show for a failed write: a fixed sentence for a code the learning loop owns, the resolver's refusals in their fixed words, else the server's own message (never a retry). */
export function learningFailure(error: unknown, fallback: string): Failure {
 if (!(error instanceof ApiError)) return { kind: "message", parts: [{ text: fallback }] };
 if (Object.hasOwn(FIXED, error.code)) return { kind: "fixed", text: FIXED[error.code]!, reload: error.code === "AGENT_REVISION_CONFLICT" };
 const refusals = error.code === "CONFIG_INVALID" ? parseStageRefusalMessage(error.message) : undefined;
 if (refusals !== undefined) return { kind: "refusals", items: refusals.map(refusal => ({ text: `${STAGE_LABELS[refusal.stage]}: ${refusalText(refusal.code)}`, ...(refusal.fixHref !== undefined && safeAppPath(refusal.fixHref) ? { href: refusal.fixHref } : {}) })) };
 return { kind: "message", parts: messageParts(error.message) };
}
