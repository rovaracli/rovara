import { DataTable } from "../../design/DataTable.js";
import { VisibleText } from "../../design/VisibleText.js";
import { safeAppPath, safeExternalUrl } from "../../text/links.js";

export interface PlanRevision {
 revision: number;
 content: string;
}

export interface PlanRevisionRow {
 id: string;
 label: string;
 status: "added" | "changed" | "unchanged";
 before?: string;
 after?: string;
}

export interface PlanRevisionEvidence {
 id: string;
 label: string;
 href: string;
 pinnedRevision: number;
}

export type PlanRevisionComparison =
 | { status: "compared"; previous: PlanRevision; current: PlanRevision; rows: readonly PlanRevisionRow[]; evidence: readonly PlanRevisionEvidence[] }
 | { status: "same"; current: PlanRevision }
 | { status: "unavailable"; current?: PlanRevision }
 | { status: "superseded"; current: PlanRevision };

export interface PlanRevisionViewProps {
 readState: "loading" | "failed" | "ready";
 comparison: PlanRevisionComparison;
}

const labels: Record<PlanRevisionRow["status"], string> = { added: "Added", changed: "Changed", unchanged: "Unchanged" };

function EvidenceLinks({ evidence }: { evidence: readonly PlanRevisionEvidence[] }) {
 if (evidence.length === 0) return null;
 return <section className="rv-answered" aria-label="Evidence for this plan">
  <h3>Evidence</h3>
  <ul className="rv-answered-sources">{evidence.map(item => {
   const safe = safeAppPath(item.href) ? item.href : safeExternalUrl(item.href) === undefined ? undefined : item.href;
   return <li key={item.id}>{safe === undefined ? <VisibleText text={item.label} /> : <a href={safe}><VisibleText text={item.label} /></a>}{" · Pinned to revision " + String(item.pinnedRevision)}</li>;
  })}</ul>
 </section>;
}

export function PlanRevisionView({ readState, comparison }: PlanRevisionViewProps) {
 if (readState === "loading") return <p role="status">Loading the latest plan comparison…</p>;
 if (readState === "failed") return <p role="alert">Couldn't load the latest plan comparison. Try again from the task.</p>;

 if (comparison.status === "same") return <section aria-label="Plan comparison"><h2>Plan v{comparison.current.revision}</h2><p className="rv-muted">This is still plan v{comparison.current.revision}. There is no newer revision to compare.</p></section>;
 if (comparison.status === "unavailable") return <p role="status">The plan comparison isn't available. No changes are shown.</p>;
 if (comparison.status === "superseded") return <section aria-label="Plan comparison"><h2>Plan v{comparison.current.revision}</h2><p role="status">A newer plan is now current. This earlier comparison is no longer current.</p></section>;

 const { previous, current, rows, evidence } = comparison;
 return <section aria-label="Plan comparison" className="rv-task-plan-revision">
  <h2>Plan v{current.revision} replaces v{previous.revision}</h2>
  <DataTable
   caption="Supplied plan differences"
   columns={[
    { key: "item", title: "Item", render: row => <VisibleText text={row.label} /> },
    { key: "before", title: "Plan v" + String(previous.revision), render: row => row.before === undefined ? <span className="rv-muted">Not in this revision</span> : <VisibleText text={row.before} /> },
    { key: "after", title: "Plan v" + String(current.revision), render: row => row.after === undefined ? <span className="rv-muted">Not in this revision</span> : <VisibleText text={row.after} /> },
    { key: "change", title: "Change", render: row => <span>{labels[row.status]}</span> },
   ]}
   rows={rows}
   rowKey={row => row.id}
  />
  <EvidenceLinks evidence={evidence} />
 </section>;
}
