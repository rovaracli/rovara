import { Button } from "../../design/Button.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import { ChainSections } from "./ChainSections.js";
import { UnderstandQuestions } from "./UnderstandQuestions.js";
import { NoChangeSection } from "./NoChangeSection.js";
import { AnsweredSection } from "./AnsweredSection.js";
import { ModelFallbackNotes } from "./ModelFallbackNotes.js";
import { visibleAnchor, workflowStateWords, type ReadTask, type CommentOnPart } from "./workspace-types.js";
const STAGES = ["Understand", "Plan", "Plan check", "Build", "Check", "Review", "Pull request", "Merge"];
const STAGE_WORDS: Record<string, string> = { UNDERSTAND: "Understand", PLAN: "Plan", PLAN_REVIEW: "Plan check", IMPLEMENT: "Build", VERIFY: "Check", REVIEW: "Review", PULL_REQUEST: "Pull request", WAIT_FOR_MERGE: "Merge", MERGED: "Merge" };
const stepWords: Record<string, string> = { pending: "Not started", running: "Working", waiting: "Waiting", done: "Finished", failed: "Failed" };
export function PipelineTab({ session, task, onComment }: { session: ReadSession; task?: ReadTask | undefined; onComment?: CommentOnPart | undefined }) {
 if (session.body.kind === "chain") return <ChainSections session={session} />;
 return <section aria-label="Work progress">{task?.workflow && <><ol className="rv-pipeline" aria-label="Task stages">{STAGES.map(stage => <li key={stage} {...(STAGE_WORDS[task.workflow!.stage] === stage ? { "aria-current": "step" as const } : {})}>{stage}</li>)}</ol><p className="rv-muted">{workflowStateWords(task.workflow.state)}</p></>}
 {task && <ModelFallbackNotes task={task} />}
 {task && <NoChangeSection task={task} />}
 {task && <AnsweredSection session={session} task={task} />}
 {task?.run && <ol className="rv-run-steps">{task.run.steps.map(step => { const anchor = visibleAnchor(session, "step", step.id);return <li key={step.id}><details open={task.run?.currentStep?.id === step.id}><summary><VisibleText text={step.name} /> <span className="rv-muted">{stepWords[step.status] ?? "Status unavailable"}</span></summary>{step.report !== undefined && <p className="rv-evidence-text"><VisibleText text={step.report} /></p>}{anchor && onComment && <Button variant="quiet" aria-label={"Comment on " + visibleText(step.name)} onClick={event => onComment(anchor, event.currentTarget)}>Comment on this step</Button>}</details></li>; })}</ol>}
 {!task?.workflow && !task?.run && <p className="rv-evidence-text"><VisibleText text={session.peek ?? session.step ?? "No work details are available yet."} /></p>}
 <UnderstandQuestions session={session} task={task} />
 {/* PLAN6: critic reports, timing and merge controls stay with their owning implementation. */}
 </section>;
}
