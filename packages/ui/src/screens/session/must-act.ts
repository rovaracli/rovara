import type { ReadSession } from "./SessionHeader.js";
import { MERGE_SECTION_ID, type Lead } from "./task-plain-state.js";
import { QUESTIONS_SECTION_ID, mayAnswerQuestions, openQuestionsOf } from "./UnderstandQuestions.js";
import type { ReadTask } from "./workspace-types.js";

/**
 * Something inside the phone page's closed "Work details and evidence" disclosure that the reader has to act on now. `key` names the action: the same key is the same action, so a reader who
 * closed the disclosure by hand is not asked again for it; a new key (the next round of questions) is a new action. `targetId` is the element to scroll to.
 */
export interface MustAct { key: string; targetId: string }

/** Whether pressing Merge is offered to this reader (the server still decides on every press). */
export const mayPressMerge = (session: ReadSession): boolean => session.you.level !== "view" || session.you.mayMerge === true;

/**
 * The open-when-you-must-act rule of the phone order (owner decision of 2026-11-12). The disclosure opens by itself, and only, when something inside it needs this reader now:
 * - Understand's questions, when this reader may answer them;
 * - the one control the lead block names inside the disclosure (today "Go to Merge"), when the merge is ready and this reader may press it.
 * A decision card is not inside the disclosure (the phone order draws it above the facts), so a decision the reader can make needs nothing here.
 * `decisionsKnown` is false while the pending decisions are still being read: until then the lead names Merge only because a merge card has not arrived yet.
 */
export function mustActInside({ session, task, lead, decisionsKnown }: { session: ReadSession; task: ReadTask | undefined; lead: Pick<Lead, "action">; decisionsKnown: boolean }): MustAct | undefined {
 const questions = openQuestionsOf(task);
 if (questions !== undefined && mayAnswerQuestions(session)) return { key: "questions:" + String(questions.round), targetId: QUESTIONS_SECTION_ID };
 if (lead.action?.targetId === MERGE_SECTION_ID && decisionsKnown && task?.merge?.ready === true && mayPressMerge(session)) return { key: "merge", targetId: MERGE_SECTION_ID };
 return undefined;
}
