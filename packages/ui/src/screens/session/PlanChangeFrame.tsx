import type { ReactNode } from "react";
import { HeldState } from "../../design/HeldState.js";
import { VisibleText } from "../../design/VisibleText.js";
import { TaskTimeline, type TaskTimelineItem } from "../../design/TaskTimeline.js";
import { clockTime } from "./task-time.js";

/** What the plan-change frame may say: only what the plan document and the delivered instruction served. What the earlier plan said and what changed are held. */
export interface PlanChangeFrameFacts {
 version: number | undefined;
 headline: string | undefined;
 checks: readonly string[];
 estimate: string | undefined;
 taskCount: number;
 instruction?: { name: string; at: string; text: string } | undefined;
}

/** The comparison: the earlier plan is one Unknown line above the table; the proposed plan shows what the document served. */
export function PlanChangeTable({ facts }: { facts: PlanChangeFrameFacts }) {
 const rows: Array<[string, ReactNode]> = [];
 if (facts.headline !== undefined) rows.push(["Summary", <VisibleText key="h" text={facts.headline} />]);
 if (facts.checks.length > 0) rows.push(["Checks", <VisibleText key="c" text={facts.checks.join(". ")} />]);
 if (facts.estimate !== undefined) rows.push(["Estimate", <VisibleText key="e" text={facts.estimate} />]);
 if (facts.taskCount > 0) rows.push(["Work", facts.taskCount === 1 ? "1 item" : String(facts.taskCount) + " items"]);
 return <>
  <p className="rv-plan-change-earlier">Earlier plan <HeldState /></p>
  <table className="rv-plan-change-table" aria-label="The proposed plan">
   <thead><tr><th scope="col"><span className="rv-visually-hidden">What</span></th><th scope="col">{"Plan" + (facts.version === undefined ? "" : " v" + String(facts.version)) + " · proposed"}</th></tr></thead>
   <tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>)}</tbody>
  </table>
 </>;
}

/** The right-hand rail of a plan-change decision: what each choice leads to, then how the decision got here. */
export function PlanChangeRail({ facts }: { facts: PlanChangeFrameFacts }) {
 const named = "plan" + (facts.version === undefined ? "" : " v" + String(facts.version));
 const items: TaskTimelineItem[] = [
  ...(facts.instruction === undefined ? [] : [{ id: "instruction", title: "Instruction from " + facts.instruction.name, state: "done" as const, detail: (clockTime(facts.instruction.at) ?? "") + (clockTime(facts.instruction.at) === undefined ? "" : " · ") + "Delivered" }]),
  { id: "proposed", title: "Rovara proposed " + named, state: "done" as const },
  { id: "waiting", title: "Waiting for an owner's decision", state: "needs_you" as const, detail: "you are here" },
 ];
 return <aside className="rv-task-context rv-plan-change-rail" aria-label="What happens after you decide">
  <h2>What happens after you decide</h2>
  <h3>If you approve {named}</h3>
  <p>The build starts from the approved plan. An approval receipt is not available here yet.</p>
  <h3>Earlier plan · unavailable</h3>
  <p>Keeping the earlier plan is not available here yet. Nothing is approved until you decide.</p>
  <h3>If nobody decides</h3>
  <p>Nothing is approved and the proposed plan does not start. A reply in Talk or Slack does not approve it.</p>
  <h2 className="rv-plan-change-history">How this got here</h2>
  <TaskTimeline items={items} />
 </aside>;
}
