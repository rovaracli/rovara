import { useState } from "react";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { readDecisions } from "../../api/decisions.js";
import { Button } from "../Button.js";
import { DecisionFrame } from "../DecisionFrame.js";
import { StatusChip } from "../StatusChip.js";
import { TaskTimeline } from "../TaskTimeline.js";
import { VisibleText } from "../VisibleText.js";

// Local gallery examples, parsed by the same reader as live cards. No API calls,
// authority inference or write callbacks: these are not live task workflows.
const mergeExample = readDecisions(DecisionCardsViewReaderSchema.parse({
 cards: [{
  id: "merge:example42", kind: "merge", taskId: "11111111-1111-4111-8111-111111111111", project: "payments",
  title: "Add refunds endpoint", question: "Merge #42 into main?",
  recommended: { action: "open", why: "Two required results are missing for this version." },
  next: { text: "Resolve each missing result before merging." },
  evidence: [
   { kind: "checks", label: "Integration tests", value: "The runner disconnected before the first test.", state: "unknown" },
   { kind: "review", label: "Security review", value: "A required review has not happened. Ana can run it.", state: "unknown" },
  ],
  risk: "medium", riskReasons: ["Two required results are missing."],
  friction: { expandEvidenceFirst: true, freshSignIn: false, secondPerson: false },
  actions: [], rejectReasons: [], status: "pending", createdAt: "2026-10-30T14:00:00.000Z",
 }], total: 1, tabs: {}, details: {}, digests: { "merge:example42": "a".repeat(64) }, dropped: 0, unconfirmed: [],
}))[0]!;

function DecisionsScene() {
 const [example, setExample] = useState<string>();
 return <div className="rv-decision-scene">
  <DecisionFrame title="Answer 2 questions" status={{ state: "needs_you" }} meta="asked 12 min ago" actions={<><Button variant="primary" onClick={() => setExample("Answer questions")}>Answer questions</Button><Button onClick={() => setExample("Ask Sam instead")}>Ask Sam instead</Button></>}>
   <p>Rovara needs two answers before it writes the plan. Nothing has changed in acme/payments.</p>
  </DecisionFrame>
  <p className="rv-decision-frame-meta">Cards are only for decisions. Everything else is a plain section with a heading, so the decision is the heaviest thing on the page.</p>
  <DecisionFrame title="Approve plan v3?" actions={<><Button lockedReason="unlocks when all 3 are read for v3" aria-describedby="ds-p2-plan-lock">Approve plan v3</Button><Button variant="quiet" onClick={() => setExample("Request changes")}>Request changes</Button><Button variant="quiet" onClick={() => setExample("Design first")}>Design first</Button></>} className="rv-decision">
   <p><strong>Outcome:</strong> a POST /refunds endpoint for full and partial refunds of a settled payment. A repeated request returns the first result instead of refunding twice.</p>
   <p className="rv-decision-frame-meta">Approving starts the build. Nothing has changed in acme/payments yet.</p>
   <h3>Risks to know before you decide</h3>
   <ul><li>The ledger tables change. Partial refunds add a column; a migration runs when this is deployed.</li><li>Payments still in flight are refused.</li><li>The provider is simulated in checks.</li></ul>
   <h3>Review evidence</h3>
   <ul className="rv-decision-scene-evidence">
    <li><span>✓ How refunds work today in acme/payments</span><span className="rv-decision-frame-meta">Read 14:01</span></li>
    <li><span>✓ The provider&apos;s refund rules</span><span className="rv-decision-frame-meta">Read 14:03</span></li>
    <li className="is-unread"><details><summary>Test plan</summary><p>Check full and partial refunds and a repeated request. The provider is simulated.</p></details><span className="rv-decision-frame-meta">Not read · about 1 min</span></li>
   </ul>
   <p id="ds-p2-plan-lock" className="rv-decision-scene-lock">Reading never approves.</p>
  </DecisionFrame>
  <DecisionFrame title={mergeExample.card.question} status={{ state: "needs_you" }} meta="acme/payments · head 5b81d0c" className="rv-decision" actions={<Button lockedReason="a required check couldn't run and a required review has not happened." aria-describedby="ds-p2-merge-lock">Merge #42</Button>}>
   <p><VisibleText text={mergeExample.card.recommended.why} /></p>
   {mergeExample.card.evidence.map((item, index) => <section key={item.label} aria-label={item.label}><h3><VisibleText text={item.label} /></h3><StatusChip state={index === 0 ? "could_not_run" : "not_run"} /><p><VisibleText text={item.value} /></p></section>)}
   <p id="ds-p2-merge-lock" className="rv-decision-scene-lock">Resolve both missing results before merging.</p>
  </DecisionFrame>
  {example !== undefined && <p role="status">Example only: {example}. No task was changed.</p>}
 </div>;
}
function TimelineScene() {
 return <div className="rv-decision-scene"><TaskTimeline items={[
  { id: "workspace", title: "Set up workspace", detail: "Cloned acme/payments at a3f9c1e", state: "done", elapsed: "1m 12s" },
  { id: "build", title: "Build", detail: "Writing the POST /refunds handler · last heard 20 s ago", state: "running", elapsed: "6m 40s", log: <pre>edit src/refunds/handlers.py (+48 -0)</pre> },
  { id: "checks", title: "Checks", state: "next" },
 ]} /><p className="rv-decision-frame-meta">Real step names and elapsed time. Never an invented percentage. The live log folds under the running step.</p></div>;
}
export const decisionTimelineGalleryScenes = [
 { id: "decisions", title: "Decision card", render: DecisionsScene },
 { id: "timeline", title: "Timeline row", render: TimelineScene },
] as const;
