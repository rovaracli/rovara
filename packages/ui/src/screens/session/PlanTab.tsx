import { lazy, Suspense } from "react";
import { useAppHost } from "../../host.js";
import { IconButton } from "../../design/IconButton.js";
import { Button } from "../../design/Button.js";
import { Money } from "../../design/Money.js";
import { CRITIC_NOT_CHECKED_LINE, formatMinutes } from "@agentx/contracts/web";
import type { MarkdownComment } from "../../design/SafeMarkdown.js";
import { planParts } from "./plan-parts.js";
import { Skeleton } from "../../design/Skeleton.js";
import type { ReadSession } from "./SessionHeader.js";
import { visibleAnchor, workflowStateWords, type ReadTask, type CommentOnPart } from "./workspace-types.js";
const Markdown = lazy(async () => ({ default: (await import("../../design/SafeMarkdown.js")).SafeMarkdown }));
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
 const review = session.you.owner && workflow.state === "WAITING" && (workflow.stage === "PLAN" || workflow.stage === "PLAN_REVIEW");
 return <section aria-label="Plan evidence"><div className="rv-plan-context"><p>{workflowStateWords(workflow.state)}</p>{estimate && <><p>Estimated cost: <Money usd={estimate.lowUsd} /> to <Money usd={estimate.highUsd} /></p><p>Run limit: <Money usd={estimate.runLimitUsd} /></p>{estimate.minutes && <p>{"Estimated time: " + formatMinutes(estimate.minutes.low, estimate.minutes.high) + " to a pull request."}</p>}</>}{unchecked && <p>{CRITIC_NOT_CHECKED_LINE}</p>}{review && <Button variant="primary" onClick={() => host.openExternal(host.origin + "/review/" + encodeURIComponent(task.taskId) + "/task")}>Review and approve the plan</Button>}</div><Suspense fallback={<Skeleton label="Loading the plan" />}><Markdown markdown={workflow.planContent} comments={comments} /></Suspense></section>;
}
