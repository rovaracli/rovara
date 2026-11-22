import type { ReactNode } from "react";
import { VisibleText } from "../../design/VisibleText.js";

type Decision =
 | { kind: "confirmed" | "recorded"; version: number; actor: string; actorRole: string; revision: number; at: string }
 | { kind: "unknown"; version: number };
type Build = { state: "starting" } | { state: "first-command-observed"; command: string };

/** Read-only receipt content for the owner-controlled plan decision and task-session composition. */
export function PlanStartReceiptView(props: { unavailable: true } | {
 currentVersion: number;
 currentRevision: number;
 decision: Decision;
 build: Build;
 taskHref?: string;
 checkHref?: string;
}): ReactNode {
 if ("unavailable" in props) return <section aria-label="Plan approval and build start receipt">
  <p className="rv-muted">An approval receipt for this plan isn't available here. Check the task's decisions and build activity for recorded updates.</p>
 </section>;
 const { currentVersion, currentRevision, decision, build, taskHref, checkHref } = props;
 const samePlan = decision.version === currentVersion
  && (decision.kind === "unknown" || decision.revision === currentRevision);
 return <section className="rv-surface rv-plan-start-receipt" aria-label="Plan approval and build start receipt">
  {decision.kind === "unknown" ? <>
   <h2>Rovara didn't confirm this yet</h2>
   <p>Approval for plan v{decision.version} is unknown.</p>
  </> : samePlan ? <>
   <h2>Plan v{decision.version} approved</h2>
   <p>{decision.kind === "recorded" ? "Recorded by " : "Approved by "}<VisibleText text={`${decision.actor}, ${decision.actorRole}`} /> · revision {decision.revision}</p>
   <p className="rv-muted">Recorded <VisibleText text={decision.at} /></p>
  </> : <>
   <h2>Approval is not confirmed for the current plan</h2>
   <p>The recorded decision is for plan v{decision.version}, revision {decision.revision}. The current plan is v{currentVersion}, revision {currentRevision}.</p>
  </>}
  <section aria-label="Build status">
   <h3>{build.state === "starting" ? "Build starting" : "First command observed"}</h3>
   {build.state === "starting"
    ? <p className="rv-muted">The build is starting. The first command hasn't been observed yet.</p>
    : <p><VisibleText text={build.command} /></p>}
  </section>
  {(taskHref !== undefined || checkHref !== undefined) && <nav aria-label="Task receipt links">
   {taskHref !== undefined && <a href={taskHref}>Open task</a>}
   {checkHref !== undefined && <a href={checkHref}>Check</a>}
  </nav>}
 </section>;
}
