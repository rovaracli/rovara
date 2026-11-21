import "./parts/outcome-delivery-held.css";

export interface HeldStateProps { presentation?: "chip" | "line" }

/** One quiet unknown observation per subject, without invented clocks or actions. */
export function HeldState({ presentation = "chip" }: HeldStateProps) {
 if (presentation === "line") return <p className="rv-held-line">Rovara can&apos;t confirm this yet. It is checking.</p>;
 return <StatusChip state="unknown" />;
}
import { StatusChip } from "./StatusChip.js";
