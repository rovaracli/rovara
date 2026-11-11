import type { ReactNode } from "react";
/** Chips always show words plus an icon: never colour alone. "company-lock" is the accent colour with a lock (red is only for failures and blocks); "outside-change" is the info colour with a laptop. */
export type ChipKind = "neutral" | "company-lock" | "outside-change";
const ICONS: Record<Exclude<ChipKind, "neutral">, ReactNode> = {
 "company-lock": <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
 "outside-change": <><rect x="5" y="5" width="14" height="10" rx="1.5" /><path d="M3 19h18" /></>,
};
export function Chip({ kind = "neutral", children }: { kind?: ChipKind; children: ReactNode }) {
 return <span className={kind === "neutral" ? "rv-chip" : `rv-chip rv-chip-${kind}`}>{kind !== "neutral" && <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[kind]}</svg>}{children}</span>;
}
