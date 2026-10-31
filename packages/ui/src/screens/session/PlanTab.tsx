import { lazy, Suspense } from "react";
import { useAppHost } from "../../host.js";
import { IconButton } from "../../design/IconButton.js";
import { Button } from "../../design/Button.js";
import { Money } from "../../design/Money.js";
import { CRITIC_NOT_CHECKED_LINE, PLAN_PROOF_WORDS, formatMinutes } from "@agentx/contracts/web";
import type { MarkdownComment } from "../../design/SafeMarkdown.js";
import { planParts } from "./plan-parts.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import { visibleAnchor, workflowStateWords, type ReadTask, type CommentOnPart } from "./workspace-types.js";
const Markdown = lazy(async () => ({ default: (await import("../../design/SafeMarkdown.js")).SafeMarkdown }));
/** The plan on one screen (Decisions D5): the broker built it from the plan document, so this only shows it. A plan too big for one screen says so. */
function OneScreen({ one }: { one: NonNullable<ReadTask["planOneScreen"]> }) {
 return <section className="rv-plan-one" aria-label="Plan on one screen">
  <h2>Plan on one screen</h2>
  {one.tooBig && <p role="status">This plan is too big for one screen. Consider splitting it into smaller tasks.</p>}
  <dl><dt>Problem</dt><dd><VisibleText text={one.problem} /></dd>
   <dt>Approach</dt><dd><ul>{one.approach.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul></dd>
   <dt>Files that change</dt><dd>{one.files.length === 0 ? "None named" : <VisibleText text={one.files.join(", ") + (one.filesMore > 0 ? " and " + one.filesMore + " more" : "")} />}</dd>
   {one.risks.length > 0 && <><dt>Biggest risks</dt><dd><ul>{one.risks.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul></dd></>}
   {one.cost !== undefined && <><dt>Cost and time</dt><dd><VisibleText text={one.cost} /></dd></>}
   <dt>How we'll know</dt><dd><ul>{one.proof.map((entry, index) => <li key={index}><VisibleText text={entry.claim + ": " + (PLAN_PROOF_WORDS[entry.how as keyof typeof PLAN_PROOF_WORDS] ?? "not stated")} /></li>)}</ul></dd></dl>
 </section>;
}
export function PlanTab({ session, task, onComment }: { session: ReadSession; task: ReadTask; onComment?: CommentOnPart | undefined }) {
 const host = useAppHost(), workflow = task.workflow, estimate = task.runEstimate;
 if (workflow?.planContent === undefined) return <p>No plan is available yet.</p>;
 const unchecked = workflow.critique?.status === "done" && workflow.critique.critiques.length === 0;
 const parts = planParts(workflow.planContent), version = workflow.artifacts.filter(artifact => artifact.type === "plan").reduce<number | undefined>((latest, artifact) => latest === undefined || artifact.version > latest ? artifact.version : latest, undefined);
 const comments: MarkdownComment[] = [];
 if (onComment !== undefined && version !== undefined) for (const candidate of session.anchors ?? []) {
  if (candidate.target !== "plan_block") continue;
  const anchor = visibleAnchor(session, "plan_block", candidate.targetId), index = /^p([1-9][0-9]{0,2})$/.exec(candidate.targetId)?.[1];
  const part = index === undefined ? undefined : parts[Number(index) - 1];
  if (anchor === undefined || part === undefined || anchor.revision !== "v" + String(version)) continue;
  // RULING Q35: attach only where a real id and an exact rendered block agree; never split Markdown or manufacture paragraph ids.
  comments.push({ ...part, control: <IconButton variant="quiet" label={"Comment on plan paragraph " + index} onClick={event => onComment(anchor, event.currentTarget)}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M4 4h12v9H9l-5 3V4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></IconButton> });
 }
 const one = task.planOneScreen, full = <Suspense fallback={<Skeleton label="Loading the plan" />}><Markdown markdown={workflow.planContent} comments={comments} /></Suspense>;
 const review = session.you.owner && workflow.state === "WAITING" && (workflow.stage === "PLAN" || workflow.stage === "PLAN_REVIEW");
 return <section aria-label="Plan evidence"><div className="rv-plan-context"><p>{workflowStateWords(workflow.state)}</p>{estimate && <><p>Estimated cost: <Money usd={estimate.lowUsd} /> to <Money usd={estimate.highUsd} /></p><p>Run limit: <Money usd={estimate.runLimitUsd} /></p>{estimate.minutes && <p>{"Estimated time: " + formatMinutes(estimate.minutes.low, estimate.minutes.high) + " to a pull request."}</p>}</>}{unchecked && <p>{CRITIC_NOT_CHECKED_LINE}</p>}{review && <Button variant="primary" onClick={() => host.openExternal(host.origin + "/review/" + encodeURIComponent(task.taskId) + "/task")}>Review and approve the plan</Button>}</div>{one && <OneScreen one={one} />}{one ? <details className="rv-plan-details"><summary>Details</summary>{full}</details> : full}</section>;
}
