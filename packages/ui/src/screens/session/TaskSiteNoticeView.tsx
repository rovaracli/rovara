import type { ReactNode } from "react";
import type { ProjectAllowedWebsitesResult, SetupJournalReply } from "@agentx/contracts/web";
import { Card } from "../../design/Card.js";
import { StatusPill } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";

export type TaskSiteNoticeState =
 | Readonly<{ kind: "blocked"; journal: SetupJournalReply; entryN: number }>
 | Readonly<{ kind: "request-result"; result: ProjectAllowedWebsitesResult }>
 | Readonly<{ kind: "read-failed" }>
 | Readonly<{ kind: "unresolved"; detail: string }>;

export function TaskSiteNoticeView({ project, state, actions }: {
 project: string;
 state: TaskSiteNoticeState;
 actions?: ReactNode;
}) {
 const headingStyle = { display: "grid", gap: 8, minWidth: 0 } as const;
 const factsStyle = { display: "grid", gridTemplateColumns: "minmax(96px, max-content) minmax(0, 1fr)", gap: "8px 16px", margin: 0 } as const;
 if (state.kind === "read-failed") return <Card aria-labelledby="task-site-notice-heading" data-testid="task-site-notice" style={{ display: "grid", gap: 16, minWidth: 0 }}>
  <header style={headingStyle}><StatusPill tone="bad" label="Unavailable" /><h2 id="task-site-notice-heading">Approved-site details unavailable</h2></header>
  <p className="rv-muted" role="alert">The latest site read could not be read. Cached request and run details are hidden.</p>
 </Card>;

 if (state.kind === "blocked") {
  const entry = state.journal.entries.find(candidate => candidate.n === state.entryN);
  const blockedHosts = entry?.blockedHosts ?? [];
  if (entry === undefined || blockedHosts.length === 0) return <Card aria-labelledby="task-site-notice-heading" data-testid="task-site-notice" style={{ display: "grid", gap: 16, minWidth: 0 }}>
   <header style={headingStyle}><StatusPill tone="idle" label="Evidence unavailable" /><h2 id="task-site-notice-heading">Blocked-site evidence unavailable</h2></header>
   <p className="rv-muted">The selected run record does not contain a blocked host.</p>
  </Card>;
  return <Card aria-labelledby="task-site-notice-heading" data-testid="task-site-notice" data-state="blocked" style={{ display: "grid", gap: 16, minWidth: 0 }}>
   <header style={headingStyle}>
    <StatusPill tone="wait" label="Blocked" />
    <h2 id="task-site-notice-heading">A setup run recorded a blocked host</h2>
    <p className="rv-muted"><VisibleText text={project} /></p>
   </header>
   <section aria-label="Blocked run evidence" style={{ display: "grid", gap: 12, minWidth: 0 }}>
    <p>Rovara's setup-run journal marked this host as blocked during the command:</p>
    <ul style={{ margin: 0, paddingInlineStart: 20, overflowWrap: "anywhere" }}>{blockedHosts.map(host => <li key={host}><code>{host}</code></li>)}</ul>
    <dl style={factsStyle}>
     <dt className="rv-muted">Run entry</dt><dd style={{ margin: 0 }}>{entry.n}</dd>
     <dt className="rv-muted">Command</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}><code>{entry.command}</code></dd>
     <dt className="rv-muted">Started</dt><dd style={{ margin: 0 }}>{new Date(entry.startedAt).toLocaleString()}</dd>
    </dl>
    <p className="rv-muted">This record does not show whether the task continued after this command.</p>
   </section>
   {actions !== undefined && <div className="rv-actions" aria-label="Available task actions">{actions}</div>}
  </Card>;
 }

 if (state.kind === "unresolved") return <Card aria-labelledby="task-site-notice-heading" data-testid="task-site-notice" data-state="unresolved" style={{ display: "grid", gap: 16, minWidth: 0 }}>
  <header style={headingStyle}><StatusPill tone="wait" label="Unconfirmed" /><h2 id="task-site-notice-heading">Rovara didn't confirm this yet</h2><p className="rv-muted"><VisibleText text={project} /></p></header>
  <p><VisibleText text={state.detail} /></p>
  <p className="rv-muted">No site or task change is confirmed. Check the current status before trying again.</p>
  {actions !== undefined && <div className="rv-actions" aria-label="Available task actions">{actions}</div>}
 </Card>;

 const result = state.result;
 if (result.kind === "proposal") return <Card aria-labelledby="task-site-notice-heading" data-testid="task-site-notice" data-state="request-result" style={{ display: "grid", gap: 16, minWidth: 0 }}>
  <header style={headingStyle}><StatusPill tone={result.status === "pending" ? "wait" : result.status === "applied" ? "ok" : "bad"} label={result.status === "pending" ? "Waiting for review" : result.status} /><h2 id="task-site-notice-heading">Project website proposal</h2><p className="rv-muted"><VisibleText text={project} /></p></header>
  <p>The server returned a <VisibleText text={result.status} /> website proposal.</p>
  <dl style={factsStyle}><dt className="rv-muted">Request</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}><code>{result.proposalId}</code></dd><dt className="rv-muted">Created</dt><dd style={{ margin: 0 }}>{new Date(result.createdAt).toLocaleString()}</dd></dl>
  <p className="rv-muted">This response does not show that the host is approved on every machine or that the task continued.</p>
  {actions !== undefined && <div className="rv-actions" aria-label="Available task actions">{actions}</div>}
 </Card>;

 if (result.kind === "receipt") return <Card aria-labelledby="task-site-notice-heading" data-testid="task-site-notice" data-state="request-result" style={{ display: "grid", gap: 16, minWidth: 0 }}>
  <header style={headingStyle}><StatusPill tone={result.status === "applied" ? "ok" : "bad"} label={result.status} /><h2 id="task-site-notice-heading">Project website settings response</h2><p className="rv-muted"><VisibleText text={project} /></p></header>
  <p>The server returned <VisibleText text={result.status} /> for this request.</p>
  <dl style={factsStyle}><dt className="rv-muted">Request</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}><code>{result.receipt.requestId}</code></dd><dt className="rv-muted">Recorded</dt><dd style={{ margin: 0 }}>{new Date(result.receipt.createdAt).toLocaleString()}</dd>{result.receipt.state === "applied" && <><dt className="rv-muted">Revision</dt><dd style={{ margin: 0 }}>{result.receipt.resultRevision}</dd></>}</dl>
  <p className="rv-muted">This response does not show that the host is approved on every machine or that the task continued.</p>
 </Card>;

 return <Card aria-labelledby="task-site-notice-heading" data-testid="task-site-notice" data-state="request-result" style={{ display: "grid", gap: 16, minWidth: 0 }}>
  <header style={headingStyle}><StatusPill tone="idle" label="Unchanged" /><h2 id="task-site-notice-heading">Project website settings were unchanged</h2><p className="rv-muted"><VisibleText text={project} /></p></header>
  <p>The server returned unchanged at revision {result.resultRevision}.</p>
  <p className="rv-muted">This response does not show that the host is approved on every machine or that the task continued.</p>
 </Card>;
}
