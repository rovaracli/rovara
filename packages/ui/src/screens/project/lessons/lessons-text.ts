// The fixed words of the Lessons tab, the Sources tab and the task page's lessons list. Text from a lesson or a source is never put into these sentences as markup: the screens show it as text.
import type { LESSON_TIER_REASONS } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { visibleText } from "../../../design/VisibleText.js";

export const T = {
 LOADING: "Loading lessons", TRY_AGAIN: "Try again", LOAD_FAILED: "Couldn't load the lessons. Try again.",
 TITLE: "Lessons",
 INTRO: "Short pieces of advice Rovara learned from this team's own work. Rovara uses a lesson only after a maintainer approves it, and it checks the code a lesson cites before every use.",
 WAITING: "Waiting for you", WAITING_NONE: "Nothing is waiting for you.", WAITING_ONLY_DECIDERS: "Maintainers and admins approve lessons.",
 ACTIVE: "Active lessons", ACTIVE_NONE: "No lesson is in use yet.", SEARCH: "Search active lessons", NO_MATCH: "No active lesson matches.",
 REMOVED: "Removed lessons", REMOVED_NONE: "No lesson has been removed.",
 APPROVE: "Approve", APPROVE_EDIT: "Edit and approve", REJECT: "Reject", RETIRE: "Remove", HISTORY: "History", HIDE_HISTORY: "Hide history", CANCEL: "Cancel",
 EDIT_TITLE: "Title", EDIT_DESCRIPTION: "Short description", EDIT_BODY: "Lesson", EDIT_HINT: "Editing starts the check again: new wording that touches tests, checks, security or access needs two people.",
 REJECT_REASON: "Why isn't this useful?", REJECT_SEND: "Reject lesson", REMOVE_SEND: "Remove lesson", REMOVE_REASON: "Why remove it? (optional)",
 APPROVED_ACTIVE: "Approved. Rovara can use this lesson now.", APPROVED_WAITING: "Your approval is recorded. This lesson now waits for a second maintainer or admin.", REJECTED: "Lesson rejected.", REMOVED_DONE: "Lesson removed.",
 YOU_APPROVED: "You approved this. It waits for a second maintainer or admin.", CANNOT_APPROVE: "You can't approve this one. Another maintainer or admin has to.",
 ONE_PERSON: "Needs one maintainer's OK", TWO_PEOPLE: "Needs two people: a maintainer, then a second maintainer or admin",
 FIRST_APPROVED: "Approved first by", STILL_NEEDS: "Still needs a second maintainer or admin.", GROUP_NEEDS: "Must also be approved by someone in",
 SENT_BACK: "Sent back for a person to look at again, so it can't go live on its own.", CONTRADICTS: "This lesson says the opposite of another one.", RETIRE_PROPOSED: "Rovara suggests removing this lesson because people marked it wrong more than helpful.", REPLACES: "This lesson replaces an earlier one.",
 WHERE_FROM: "Where it comes from", CITES: "Code it cites", NO_CITES: "It doesn't cite code.", FROM_PEOPLE: "Said or edited by", MEASURED: "Backed by a measured outcome (a send-back, revert or failed check).", TASKS_BACK: "tasks back it.",
 HELPFUL: "Helpful", WRONG: "Wrong here", USED: "used", EXPIRES: "Expires", LAST_HELPED: "Last helped",
 STALE: "Its code references no longer hold. Rovara has stopped using it until a person looks.",
 QUEUED: "more are being collected. They show up here once something backs them up.", HIDDEN: "come from sources you can't see and are left out.",
 DIGEST: "This week", DIGEST_TOP: "Top lessons", DIGEST_NONE: "Nothing to report this week.", DIGEST_WAITING: "Waiting for approval", DIGEST_REVIEW: "Sent back for a look", DIGEST_AUTO: "Went live on their own", DIGEST_RETIRED: "Removed this week",
 DIGEST_STALE: "Stale or suggested for removal", DIGEST_PAUSED: "Paused sources", DIGEST_PAUSED_HIDDEN: "paused sources are not named because they could identify a source you can't see.",
 ROLLBACK: "Go back to an earlier set", ROLLBACK_HINT: "Brings back the lessons as they were. Every restored lesson waits for approval again; nothing goes live by itself.", ROLLBACK_SEND: "Go back to this set", ROLLBACK_NONE: "There is no earlier set to go back to.",
 ROLLED_BACK: "Done. The restored lessons are waiting for approval.", CHANGED: "This changed while you were looking. The list was read again.",
 OFF: "Learning is switched off for this project. Nothing is captured and no lesson is used.", COLLECT: "Rovara is collecting what the team does but isn't suggesting lessons yet.", LOCKED: "Your company set this to be stricter than the project's own choice.",
 AUDITOR: "You can read lessons here but not change them.", READ_ONLY: "You can read the active lessons. Maintainers and admins decide them.",
 TRUNCATED: "The list was cut short. The most important lessons are shown first.", FORMER: "a former member",
 SOURCES_TITLE: "Sources", SOURCES_BANNER: "Rovara keeps who could see each item. People only see what they could see at the source. Deleting at the source deletes here within 1 hour (hidden at once).",
 SOURCES_NONE: "No source feeds the team record for this project yet.", SOURCES_LOADING: "Loading sources", SOURCES_UNAVAILABLE: "The team record isn't set up here yet.",
 SOURCE_PAUSED: "Paused: it produced far more lessons than usual. A maintainer has to resume it.", SOURCE_PAUSED_OTHER: "other sources are paused for the same reason.", SOURCE_OFF: "Switched off", SOURCE_ON: "On",
 SOURCE_HIDDEN: "Kept for maintainers", SOURCE_EXCLUDED: "excluded", KEEPS: "Rovara keeps", STATUS: "Status", WHO_SEES: "Who sees it",
 LOADED_TITLE: "Lessons the agent loaded", LOADED_NONE: "No lesson was loaded for this task.", LOADED_HIDDEN: "A lesson from a source you can't see", LOADED_THANKS: "Thanks. Your mark is recorded.",
} as const;

const REASON_WORDS: Readonly<Record<(typeof LESSON_TIER_REASONS)[number], string>> = {
 reviewer_stage: "It would reach the plan and code reviewers.", review_check: "It is a check for reviewers.", escalation_words: "It mentions tests, checks, security, access or approvals.",
 command_or_url: "It contains a command or a web address.", encoded_content: "It contains encoded text.", risky_path: "It is about files that protect the project (tests, CI or security).",
 judge_escalate: "A second look flagged it as sensitive.", not_a_fact: "It is advice, not a checked fact.", citations_not_verified: "Its code references haven't been checked yet.",
 not_plain_declarative: "Its wording isn't a plain statement of fact.", source_not_trusted: "It rests on a source Rovara doesn't fully trust.", scope_not_one_repo: "It covers more than one repository (a broad lesson).",
 stage_not_allowed: "It would reach steps beyond building.", contradiction: "It contradicts another lesson.", restricted_source: "It comes from a source only some people can see.",
 supersedes_higher_tier: "It replaces a lesson that needed more care.", cited_fact: "A checked fact about the code.",
};
/** The words for a tier reason. A reason this build does not know has none: the raw code is never shown. */
export const reasonWords = (reason: string): string | undefined => Object.hasOwn(REASON_WORDS, reason) ? REASON_WORDS[reason as keyof typeof REASON_WORDS] : undefined;

const TYPE_WORDS: Readonly<Record<string, string>> = { fact: "Fact", convention: "Convention", pitfall: "Pitfall", procedure: "Procedure", preference: "Preference", review_check: "Review check" };
export const typeWords = (type: string): string => Object.hasOwn(TYPE_WORDS, type) ? TYPE_WORDS[type]! : "Lesson";
const STAGE_WORDS: Readonly<Record<string, string>> = { UNDERSTAND: "Understand", PLAN: "Plan", IMPLEMENT: "Build", PLAN_CRITIQUE: "Plan check", REVIEW: "Review" };
export const stagesWords = (stages: readonly string[]): string => stages.map(stage => Object.hasOwn(STAGE_WORDS, stage) ? STAGE_WORDS[stage]! : "Other").join(", ");

export function scopeWords(scope: { repos: readonly string[]; paths: readonly string[]; languages: readonly string[] }): string {
 const parts = [...scope.repos, ...scope.paths, ...scope.languages];
 return parts.length === 0 ? "The whole project" : parts.join(", ");
}

const CHECK_WORDS: Readonly<Record<string, string>> = { valid: "Still holds", moved: "Moved, found again", stale: "No longer holds", unchecked: "Not checked yet" };
export const checkWords = (check: string): string => Object.hasOwn(CHECK_WORDS, check) ? CHECK_WORDS[check]! : "Not checked yet";

/** A time as "2h ago" / "3d ago"; the screens that need exactness put the date in a title. */
export function agoWords(at: number, now: number): string {
 const minutes = Math.max(0, Math.floor((now - at) / 60_000));
 return minutes < 1 ? "just now" : minutes < 60 ? `${String(minutes)}m ago` : minutes < 1440 ? `${String(Math.floor(minutes / 60))}h ago` : `${String(Math.floor(minutes / 1440))}d ago`;
}
export const dateWords = (at: number): string => new Date(at).toISOString().slice(0, 10);
export function expiryWords(at: number, now: number): string {
 const days = Math.ceil((at - now) / 86_400_000);
 return days <= 0 ? "Expired" : days === 1 ? "Expires in 1 day" : `Expires in ${String(days)} days`;
}

const RETENTION: Readonly<Record<string, string>> = { A: "Nothing; read live", B: "Only notes with links", C: "Text for 30 days, then notes", D: "Full history" };
export const retentionWords = (retention: string): string => Object.hasOwn(RETENTION, retention) ? RETENTION[retention]! : "Unknown";
const KINDS: Readonly<Record<string, string>> = { slack: "Slack", github: "GitHub", linear: "Linear", jira: "Jira", sim: "SIM", taskei: "Taskei", mcp: "Connected tool", rovara: "Rovara" };
export const kindWords = (kind: string): string => Object.hasOwn(KINDS, kind) ? KINDS[kind]! : kind.startsWith("codehost:") ? "Code host" : "Other source";
export const healthWords = (health: string): string => health === "ok" ? "Working" : health === "failing" ? "Not working" : "Not checked yet";

/** What a failed call says: the server's own fixed sentence for a refusal, a fixed line for anything else. */
export function failureText(error: unknown, fallback: string): string {
 if (error instanceof ApiError && error.code !== "NETWORK_ERROR" && error.code !== "INVALID_RESPONSE" && error.code !== "REQUEST_FAILED") return visibleText(error.message);
 return fallback;
}
/** A failure that means the list is out of date: it is read again. */
export const isStale = (error: unknown): boolean => error instanceof ApiError && (error.code === "CHANGE_STALE" || error.code === "NOT_FOUND");
