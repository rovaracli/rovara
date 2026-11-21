import "./parts/outcome-delivery-held.css";

export interface HeldStateProps { presentation?: "chip" | "line" }

/** One quiet unknown observation per subject, without invented clocks or actions. */
export function HeldState({ presentation = "chip" }: HeldStateProps) {
 if (presentation === "line") return <p className="rv-held-line">Rovara can&apos;t confirm this yet. It is checking.</p>;
 return <span className="rv-held-chip" title="Rovara can't confirm the state yet. It is checking."><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M6.4 6a1.7 1.7 0 1 1 2.8 1.3C8.4 7.8 8 8.1 8 9" /><path d="M8 10.5v1" /></svg>Unknown</span>;
}
