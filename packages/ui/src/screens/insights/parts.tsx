import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { PanelStatus } from "../../api/insights.js";
import { barPercent, notReadyWords } from "./insights-format.js";

/** One panel's frame: a labelled region with its own heading. */
export function Panel({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
 return <section className="rv-ins-panel rv-surface" aria-labelledby={id}><h2 id={id}>{title}</h2>{intro !== undefined && <p className="rv-muted">{intro}</p>}{children}</section>;
}
/** "Collecting data since <date>" or "Not available yet". Shown instead of a chart, never beside an empty one. */
export function NotReady({ status, collectingSince, now, what }: { status: PanelStatus; collectingSince: string | null | undefined; now: number; what?: string }) {
 return <p className="rv-ins-notready" role="status">{what !== undefined && <><strong>{what}:</strong>{" "}</>}<VisibleText text={notReadyWords(status, collectingSince, now)} /></p>;
}
/** A read's loading and failed states. A failed refresh keeps no figures on the page. */
export function Reading<T>({ read, title, children }: { read: Pick<UseQueryResult<T>, "isPending" | "isError" | "data" | "refetch" | "fetchStatus">; title: string; children: (data: T) => ReactNode }) {
 if (read.isPending && read.fetchStatus === "idle") return <p className="rv-muted">Checking access...</p>;
 if (read.isPending) return <Skeleton label={`Loading ${title}`} />;
 if (read.isError || read.data === undefined) return <p role="alert">Couldn&apos;t load {title}. No figures are shown. <button type="button" className="rv-ins-link-button" onClick={() => { void read.refetch(); }}>Try again</button></p>;
 return <>{children(read.data)}</>;
}
export interface BarRow { key: string; label: string; value: number; text: string }
/** Horizontal bars with the figure written next to each one. The text is the alternative: the bars are decoration. Rows with no value draw no bar. */
export function BarList({ rows, caption }: { rows: readonly BarRow[]; caption: string }) {
 const max = Math.max(0, ...rows.map(row => row.value));
 return <ul className="rv-ins-bars" aria-label={caption}>{rows.map(row => <li key={row.key}><span className="rv-ins-bar-label"><VisibleText text={row.label} /></span><span className="rv-ins-bar-track" aria-hidden="true"><span className="rv-ins-bar-fill" style={{ width: `${String(barPercent(row.value, max))}%` }} /></span><span className="rv-ins-bar-text"><VisibleText text={row.text} /></span></li>)}</ul>;
}
