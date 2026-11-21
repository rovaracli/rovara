import { HeldState } from "./HeldState.js";
import { VisibleText } from "./VisibleText.js";
import "./parts/outcome-delivery-held.css";

export interface MessageDeliveryProps {
 receipt?: {
  state: "queued" | "delivered" | "applied" | "checking" | "not_delivered" | "outside_plan";
  detail?: string;
 };
}
const delivery = {
 queued: { label: "Queued for this build", tone: "ok" },
 delivered: { label: "Delivered", tone: "ok" },
 applied: { label: "Applied", tone: "ok" },
 checking: { label: "Checking delivery", tone: "running" },
 not_delivered: { label: "Not delivered", tone: "bad" },
 outside_plan: { label: "Not applied: outside the plan", tone: "running" },
} as const;

/** Only an explicit observation earns a label. Delivery never implies application. */
export function MessageDelivery({ receipt }: MessageDeliveryProps) {
 if (receipt === undefined) return null;
 const observation = Object.hasOwn(delivery, receipt.state) ? delivery[receipt.state] : undefined;
 if (observation === undefined) return <HeldState />;
 return <p className="rv-message-delivery rv-delivery" data-tone={observation.tone} role="status">
  <span className="rv-delivery-dot" aria-hidden="true" />
  <span><strong>{observation.label}</strong>{receipt.detail === undefined || receipt.detail === "" ? null : <><span> </span><span className="rv-delivery-detail"><VisibleText text={receipt.detail} /></span></>}</span>
 </p>;
}
