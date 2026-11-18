import { ANSWER_SOURCES_MAX, answerSourceLine, plainAnswerText } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import type { ReadTask } from "./workspace-types.js";

export const ANSWERED_HEADING = "Rovara answered this. No code was changed.";
/** Hosted Code serves no change-anyway route (L4-TA5b, 2026-11-18), so this page starts nothing from here: it says where to go instead, in fixed words. */
export const FOLLOW_UP_WORDS = "To change this after it's answered, start a follow-up task.";

/** The answer Understand gave, for a task that ended Answered (a model's words: shown only as plain text). Undefined for any other task. */
export function answeredOf(task: ReadTask | undefined) {
 const workflow = task?.workflow, assessment = workflow?.intent?.assessment;
 return workflow?.outcome === "ANSWERED" && assessment?.kind === "answer" ? assessment : undefined;
}

/**
 * A task Understand answered without changing code (playbook R1b): what Rovara said and where in the code it read it. There is no "Make a change anyway" button: the hosted Code has no
 * change-anyway route, so a person who can use the session is told in fixed words to start a follow-up task. Everyone else only reads.
 */
export function AnsweredSection({ session, task }: { session: ReadSession; task: ReadTask }) {
 const answer = answeredOf(task);
 if (answer === undefined) return null;
 const mayAsk = (session.you.level === "use" || session.you.level === "edit") && session.where.kind === "cloud";
 return <section aria-label="Rovara's answer" className="rv-answered">
  <h3>{ANSWERED_HEADING}</h3>
  <p className="rv-evidence-text"><VisibleText text={plainAnswerText(answer.answer)} /></p>
  {answer.sources.length > 0 && <><h4>Where it was read</h4><ul className="rv-answered-sources">{answer.sources.slice(0, ANSWER_SOURCES_MAX).map((source, index) => <li key={String(index)}><code><VisibleText text={answerSourceLine(source)} /></code></li>)}</ul></>}
  {mayAsk && <p className="rv-muted">{FOLLOW_UP_WORDS}</p>}
 </section>;
}
