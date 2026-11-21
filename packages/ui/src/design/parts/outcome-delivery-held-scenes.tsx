import { useState } from "react";
import { OutcomeNotConfirmed } from "../OutcomeNotConfirmed.js";
import { MessageDelivery } from "../MessageDelivery.js";
import { HeldState } from "../HeldState.js";

function OutcomeExample() {
 const [afterCheck, setAfterCheck] = useState<string>();
 return <div className="rv-outcome-scenes">
  <p className="rv-muted">Example: a lost save reply and a demonstration read of the current limit. No company setting is changed.</p>
  <OutcomeNotConfirmed
   title="Rovara didn't hear back about the monthly limit."
   happened="The save was sent, but no reply came back. The limit may be $400 or $600."
   safe="Your $600 is kept in the field. Nothing was charged. Don't save again yet."
   next=""
   check={{ label: "Check current limit", onCheck: () => setAfterCheck("After the check: the limit is $600. Your change was saved at 14:06.") }}
   refCode="MONEY-SAVE-NO-REPLY"
   {...(afterCheck === undefined ? {} : { afterCheck })}
  />
 </div>;
}
function DeliveryExample() {
 return <div className="rv-outcome-scenes">
  <p className="rv-muted">Presentation examples: all six observations. Live messages currently serve only queued, delivered and not delivered.</p>
  <div className="rv-delivery-scene">
   <MessageDelivery receipt={{ state: "queued", detail: "Rovara has the message" }} />
   <MessageDelivery receipt={{ state: "delivered", detail: "the build acknowledged it" }} />
   <MessageDelivery receipt={{ state: "applied", detail: "an event names the work it changed" }} />
   <MessageDelivery receipt={{ state: "checking", detail: "no reply yet; the same message is looked up, never re-sent" }} />
   <MessageDelivery receipt={{ state: "not_delivered", detail: "refused, with the reason and the text kept" }} />
   <MessageDelivery receipt={{ state: "outside_plan", detail: "becomes a plan change that needs approval" }} />
   <MessageDelivery />
  </div>
 </div>;
}
function HeldExample() {
 return <div className="rv-held-scene">
  <p className="rv-muted">Examples: use one chip or one line for each subject whose state is unconfirmed. Known facts and lock reasons stay visible.</p>
  <div role="group" aria-label="Compact example"><HeldState /></div>
  <div role="group" aria-label="Sentence example"><HeldState presentation="line" /></div>
 </div>;
}

/** P5 mounts these on the existing authenticated design-system route. */
export const outcomeDeliveryHeldGalleryScenes = [
 { id: "outcome", title: "Error: outcome not confirmed", render: () => <OutcomeExample /> },
 { id: "delivery", title: "New in v2: delivery states for a message", render: () => <DeliveryExample /> },
 { id: "held", title: "Held and unknown", render: () => <HeldExample /> },
] as const;
