import { useState } from "react";
import { OutcomeNotConfirmed } from "../OutcomeNotConfirmed.js";
import { MessageDelivery } from "../MessageDelivery.js";
import { HeldState } from "../HeldState.js";

function OutcomeExample() {
 // The board shows both observations together. This verified fact is local demo data.
 const [afterCheck, setAfterCheck] = useState("After the check: the limit is $600. Your change was saved at 14:06.");
 return <div className="rv-outcome-scenes">
  <OutcomeNotConfirmed
   title="Rovara didn't hear back about the monthly limit."
   happened="The save was sent, but no reply came back. The limit may be $400 or $600."
   safe="Your $600 is kept in the field. Nothing was charged. Don't save again yet."
   next=""
   check={{ label: "Check current limit", onCheck: () => setAfterCheck("After the check: the limit is $600. Your change was saved at 14:06.") }}
   refCode="MONEY-SAVE-NO-REPLY"
   afterCheck={afterCheck}
  />
  <p className="rv-outcome-caption">Three parts, one button. After a lost reply the button is Check, never Try again: Try again is only for a write Rovara knows did not apply.</p>
 </div>;
}
function DeliveryExample() {
 return <div className="rv-outcome-scenes">
  <p className="rv-outcome-caption">A second, smaller vocabulary, used only on instructions sent to a running session. Each word is shown only when its event exists.</p>
  <div className="rv-delivery-scene">
   <MessageDelivery receipt={{ state: "queued", detail: "Rovara has the message" }} />
   <MessageDelivery receipt={{ state: "delivered", detail: "the build acknowledged it" }} />
   <MessageDelivery receipt={{ state: "applied", detail: "an event names the work it changed" }} />
   <MessageDelivery receipt={{ state: "checking", detail: "no reply yet; the same message is looked up, never re‑sent" }} />
   <MessageDelivery receipt={{ state: "not_delivered", detail: "refused, with the reason and the text kept" }} />
   <MessageDelivery receipt={{ state: "outside_plan", detail: "becomes a plan change that needs approval" }} />
   <MessageDelivery />
  </div>
 </div>;
}
function HeldExample() {
 return <div className="rv-held-scene">
  <div className="rv-held-observation">
   <div className="rv-held-scene-heading"><h3>Integration tests</h3><HeldState /></div>
   <p>The runner disconnected before the first test.</p>
   <p className="rv-held-meta">acme/payments · 4 min ago · head 5b81d0c</p>
  </div>
  <p className="rv-outcome-caption">One 16 or 20 semibold heading for the thing a person can act on. One 14 regular sentence for the consequence. Source, elapsed time and revision share one 12 secondary line. Uppercase 12 labels are for sheet headings like this page, not for product screens. At most one semibold run per row.</p>
 </div>;
}

/** P5 mounts these on the existing authenticated design-system route. */
export const outcomeDeliveryHeldGalleryScenes = [
 { id: "outcome", title: "Error: outcome not confirmed", render: () => <OutcomeExample /> },
 { id: "delivery", title: "New in v2: delivery states for a message", render: () => <DeliveryExample /> },
 { id: "held", title: "New in v2: fewer competing labels", render: () => <HeldExample /> },
] as const;
