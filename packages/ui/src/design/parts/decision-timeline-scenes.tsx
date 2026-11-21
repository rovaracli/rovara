import { useState } from "react";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { readDecisions } from "../../api/decisions.js";
import { Button } from "../Button.js";
import { DecisionFrame } from "../DecisionFrame.js";
import { StatusChip } from "../StatusChip.js";
import { TaskTimeline } from "../TaskTimeline.js";
import { VisibleText } from "../VisibleText.js";

// Local gallery data only; no API calls or live decision authority.
const mergeExample = readDecisions(DecisionCardsViewReaderSchema.parse({
 cards: [{
  id: "merge:example42", kind: "merge", taskId: "11111111-1111-4111-8111-111111111111", project: "payments",
  title: "Add refunds endpoint", question: "Merge #42 into main?",
  recommended: { action: "open", why: "Two required results are missing for this version." },
  next: { text: "Resolve each missing result before merging." },
  evidence: [
   { kind: "checks", label: "Integration tests", value: "The runner disconnected at 14:38, before the first test.", state: "unknown" },
   { kind: "review", label: "Second review", value: "A required second review has not happened. Ana can run it.", state: "unknown" },
  ],
  risk: "medium", riskReasons: ["Two required results are missing."],
  friction: { expandEvidenceFirst: true, freshSignIn: false, secondPerson: false },
  actions: [], rejectReasons: [], status: "pending", createdAt: "2026-10-30T14:00:00.000Z",
 }], total: 1, tabs: {}, details: {}, digests: { "merge:example42": "a".repeat(64) }, dropped: 0, unconfirmed: [],
}))[0]!;
function SceneIcon({ kind }: { kind: "risk" | "read" | "unread" | "lock" }) {
 return <svg className={`rv-decision-scene-icon is-${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">{kind === "read" ? <path d="m6 12 4 4 8-9" /> : kind === "lock" ? <><rect x="6" y="10" width="12" height="10" rx="2" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></> : <><circle cx="12" cy="12" r="9" />{kind === "risk" && <path d="M12 7v6m0 3v1" />}</>}</svg>;
}
function DecisionsScene() {
 const [selected, setSelected] = useState<string>(), [reading, setReading] = useState<"test" | "full">();
 return <div className="rv-decision-scene">
  <DecisionFrame title="Answer 2 questions" status={{ state: "needs_you" }} meta="asked 12 min ago" actions={<><Button variant="primary" onClick={() => setSelected("Answer questions")}>Answer questions</Button><Button onClick={() => setSelected("Ask Sam instead")}>Ask Sam instead</Button></>}>
   <p className="rv-decision-scene-intro">Rovara needs two answers before it writes the plan. Nothing has changed in acme/payments.</p>
  </DecisionFrame>
  <p className="rv-decision-frame-meta">Cards are only for decisions. Everything else is a plain section with a heading, so the decision is the heaviest thing on the page.</p>
  <DecisionFrame title="Approve plan v3?" className="rv-decision rv-decision-scene-plan" actions={<><Button variant="primary" onClick={() => setReading("test")}>Read the test plan</Button><Button variant="quiet" onClick={() => setSelected("Request changes")}>Request changes</Button><Button variant="quiet" onClick={() => setSelected("Design first")}>Design first</Button></>} footer={<p>Reading unlocks Approve; it never approves. If nobody decides, the task waits and nothing is spent. Only an owner can approve; Sam can comment. Estimate $2 to $4 in total, task limit $6.</p>}>
   <p className="rv-decision-scene-outcome"><strong>Outcome:</strong> a POST /refunds endpoint for full and partial refunds of a settled payment. A repeated request returns the first result instead of refunding twice.</p>
   <p className="rv-decision-scene-intro">Approving starts the build. Nothing has changed in acme/payments yet. <a href="#ds-p2-full-plan" onClick={() => setReading("full")}>Read full plan v3</a> · replaces v2 after your 2 answers</p>
   <section className="rv-decision-scene-risk-section"><h3>Risks to know before you decide</h3>
    <ul className="rv-decision-scene-risks">
     <li><SceneIcon kind="risk" /><span><strong>The ledger tables change.</strong> Partial refunds add a column; a migration runs when this is deployed.</span></li>
     <li><SceneIcon kind="risk" /><span><strong>Payments still in flight are refused.</strong> The plan rejects a refund until the payment has settled.</span></li>
     <li><SceneIcon kind="risk" /><span><strong>The provider is simulated in checks.</strong> Checks won&apos;t call the real payment provider.</span></li>
    </ul>
   </section>
   <section className="rv-decision-scene-review" aria-labelledby="ds-p2-review"><div className="rv-decision-scene-step"><h3 id="ds-p2-review"><span className="rv-decision-scene-number">1</span> Review evidence</h3><span>2 of 3 read by you, for v3</span></div>
    <ul className="rv-decision-scene-evidence">
     <li><SceneIcon kind="read" /><span>How refunds work today in acme/payments</span><span className="rv-decision-frame-meta">Read 14:01</span></li>
     <li><SceneIcon kind="read" /><span>The provider&apos;s refund rules</span><span className="rv-decision-frame-meta">Read 14:03</span></li>
     <li className="is-unread"><SceneIcon kind="unread" /><strong>Test plan</strong><span className="rv-decision-frame-meta">Not read · about 1 min</span></li>
    </ul>
   </section>
   <div className="rv-decision-scene-step is-locked"><h3><span className="rv-decision-scene-number">2</span> Approve plan v3</h3><span><SceneIcon kind="lock" /> Unlocks when all 3 are read for v3</span></div>
  </DecisionFrame>
  {reading !== undefined && <section id={reading === "full" ? "ds-p2-full-plan" : "ds-p2-test-plan"} aria-label={reading === "full" ? "Plan v3" : "Test plan"} className="rv-decision-frame"><h3>{reading === "full" ? "Plan v3" : "Test plan"}</h3><p>Check full and partial refunds and a repeated request. The provider is simulated.</p></section>}
  <DecisionFrame title={mergeExample.card.question} status={{ state: "needs_you" }} meta="acme/payments · head 5b81d0c" className="rv-decision" actions={<Button lockedReason="a required check couldn't run and a required review has not happened." aria-describedby="ds-p2-merge-lock">Merge #42</Button>}>
   <p><VisibleText text={mergeExample.card.recommended.why} /></p>
   <div className="rv-decision-scene-blockers">{mergeExample.card.evidence.map((item, index) => <section key={item.label} aria-label={item.label}><div><header><h3><VisibleText text={item.label} /></h3><StatusChip state={index === 0 ? "could_not_run" : "not_run"} /></header><p><VisibleText text={item.value} /></p></div><Button onClick={() => setSelected(index === 0 ? "Retry integration tests" : "Run second review")}>{index === 0 ? "Retry integration tests" : "Run second review"}</Button></section>)}</div>
   <p id="ds-p2-merge-lock" className="rv-decision-scene-lock">Resolve both missing results before merging.</p>
  </DecisionFrame>
  {selected !== undefined && <p role="status">{selected} selected.</p>}
 </div>;
}
function TimelineScene() {
 return <div className="rv-decision-scene"><TaskTimeline items={[
  { id: "workspace", title: "Set up workspace", detail: "Cloned acme/payments at a3f9c1e", state: "done", elapsed: "1m 12s" },
  { id: "build", title: "Build", detail: "Writing the POST /refunds handler · last heard 20 s ago", state: "running", elapsed: "6m 40s", logPreview: "edit src/refunds/handlers.py (+48 -0)", log: <pre>edit src/refunds/handlers.py (+48 -0)</pre> },
  { id: "checks", title: "Checks", state: "next" },
 ]} /><p className="rv-decision-frame-meta">Real step names and elapsed time. Never an invented percentage. The live log folds under the running step.</p></div>;
}
export const decisionTimelineGalleryScenes = [
 { id: "decisions", title: "Decision card", render: DecisionsScene },
 { id: "timeline", title: "Timeline row", render: TimelineScene },
] as const;
