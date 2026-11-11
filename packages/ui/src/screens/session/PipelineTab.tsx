import { Suspense, lazy } from "react";
import { errorRefKey, type ErrorRef } from "@agentx/contracts/web";
import { Button } from "../../design/Button.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { isClosedTask, sessionDisplay, type ReadSession } from "./SessionHeader.js";
import { ChainSections } from "./ChainSections.js";
import { UnderstandQuestions } from "./UnderstandQuestions.js";
import { NoChangeSection } from "./NoChangeSection.js";
import { FindingsActions } from "./FindingsActions.js";
import { AnsweredSection } from "./AnsweredSection.js";
import { ModelFallbackNotes } from "./ModelFallbackNotes.js";
import { LoadedKnowledgePanel } from "./LoadedKnowledgePanel.js";
import { useAppHost } from "../../host.js";
import { isWorkingAgreementOn } from "../agreement/agreement-flags.js";
import { visibleAnchor, type ReadTask, type CommentOnPart } from "./workspace-types.js";
// Fix with agent is its own chunk: it is fetched only where the session view offers it.
// The compact Working agreement (switch rovara.agreement = v2, off by default) is its own chunk, requested only while the switch is on.
const TaskAgreement = lazy(() => import("../agreement/TaskAgreement.js"));
const FixWithAgentPanel = lazy(async () => ({ default: (await import("./FixWithAgentPanel.js")).FixWithAgentPanel }));
// UX2 slice 2: one strip with the stages the task really passes through. PLAN_CRITIQUE is the automated plan check; PLAN_REVIEW is the person approving it (or the design, on a Design first task).
const STAGES = ["Understand", "Plan", "Plan check", "Approval", "Build", "Check", "Review", "Pull request", "Merge"];
const STAGE_WORDS: Record<string, string> = { UNDERSTAND: "Understand", PLAN: "Plan", PLAN_CRITIQUE: "Plan check", PLAN_REVIEW: "Approval", IMPLEMENT: "Build", VERIFY: "Check", REVIEW: "Review", PULL_REQUEST: "Pull request", WAIT_FOR_MERGE: "Merge", MERGED: "Merge" };
/** A Design first task's approval stage is the design's review. */
const stagesOf = (workflow: { path?: unknown; reviewPhase?: unknown }): string[] => (workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? STAGES.map(stage => stage === "Approval" ? "Design review" : stage) : STAGES);
const stageWord = (workflow: { stage: string; path?: unknown; reviewPhase?: unknown }): string | undefined => { const word = STAGE_WORDS[workflow.stage];return word === "Approval" && workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? "Design review" : word; };
const stepWords: Record<string, string> = { pending: "Not started", running: "Working", waiting: "Waiting", done: "Finished", failed: "Failed" };
export function PipelineTab({ session, task, onComment }: { session: ReadSession; task?: ReadTask | undefined; onComment?: CommentOnPart | undefined }) {
 const host = useAppHost();
 if (session.body.kind === "chain") return <ChainSections session={session} />;
 const closed = isClosedTask(session);
 return <section aria-label="Work progress">{task?.workflow && <><ol className="rv-pipeline" aria-label="Task stages">{stagesOf(task.workflow).map(stage => <li key={stage} {...(!closed && stageWord(task.workflow!) === stage ? { "aria-current": "step" as const } : {})}>{stage}</li>)}</ol><p className="rv-muted"><VisibleText text={sessionDisplay(session).text} /></p></>}
 {task?.reviewFindings !== undefined && <FindingsActions task={task} sessionId={session.sessionId} mayAct={session.you.owner || session.you.level === "edit"} />}
 {task && <ModelFallbackNotes task={task} />}
 {task && <NoChangeSection task={task} />}
 {task?.workflow && <LoadedKnowledgePanel taskId={task.taskId} project={task.project} />}
 {task && isWorkingAgreementOn(host) && <Suspense fallback={null}><TaskAgreement project={task.project} task={{ designReview: task.workflow?.designReview, agent: task.agent }} /></Suspense>}
 {task && <AnsweredSection session={session} task={task} />}
 {task?.run && <ol className="rv-run-steps">{task.run.steps.map(step => { const anchor = visibleAnchor(session, "step", step.id);return <li key={step.id}><details open={task.run?.currentStep?.id === step.id}><summary><VisibleText text={step.name} /> <span className="rv-muted">{stepWords[step.status] ?? "Status unavailable"}</span></summary>{step.report !== undefined && <p className="rv-evidence-text"><VisibleText text={step.report} /></p>}{anchor && onComment && <Button variant="quiet" aria-label={"Comment on " + visibleText(step.name)} onClick={event => onComment(anchor, event.currentTarget)}>Comment on this step</Button>}</details></li>; })}</ol>}
 {session.you.live?.fix === true && session.errorRef !== undefined && <Suspense fallback={null}><FixWithAgentPanel key={errorRefKey(session.errorRef as ErrorRef)} errorRef={session.errorRef} /></Suspense>}
 {!task?.workflow && !task?.run && <p className="rv-evidence-text"><VisibleText text={session.peek ?? session.step ?? "No work details are available yet."} /></p>}
 <UnderstandQuestions session={session} task={task} />
 {/* PLAN6: critic reports, timing and merge controls stay with their owning implementation. */}
 </section>;
}
