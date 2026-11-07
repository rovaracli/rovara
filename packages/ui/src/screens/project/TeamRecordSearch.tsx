import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/errors.js";
import { useRecordSearch } from "../../api/record-search.js";
import { Button } from "../../design/Button.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useAppHost } from "../../host.js";
import { safeExternalUrl } from "../../text/links.js";

const SOURCE_WORDS: Readonly<Record<string, string>> = { slack: "Slack", github: "GitHub", linear: "Linear", jira: "Jira", rovara: "Rovara", codehost: "Code host", mcp: "Connected tool" };
const sourceWords = (source: string) => SOURCE_WORDS[source] ?? SOURCE_WORDS[source.split(".")[0] ?? ""] ?? "Source";
/** UX-4b review M3: the record paused in this installation (docs/day-two.md: the app says it is paused). */
export const PAUSED_WORDS = "The team record is paused in this installation, so nothing can be searched until it is resumed.";
const dateWords = (at: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(at));

/** A link the reader can follow: an address in this app opens in place; any other https address opens in a new tab without the opener. Anything else is not a link. */
function Where({ href, children }: { href: string | undefined; children: string }) {
 const host = useAppHost();
 if (href === undefined) return null;
 const safe = safeExternalUrl(href);
 if (safe === undefined) return null;
 const url = new URL(safe);
 if (url.origin === host.origin && url.pathname.startsWith("/app/")) return <Link to={url.pathname + url.search}>{children}</Link>;
 return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/**
 * Owner decision 3 (UX-4b): search the project's team record from the project page. Results are the record's own search (what was said and decided, each linking to its source) and past tasks like the
 * query (each linking to its task). The server reads with the same authority as the record's routes: what the reader can't see at the source never comes back, and "some hidden" is never a count.
 */
export function TeamRecordSearch({ project }: { project: string }) {
 const [draft, setDraft] = useState(""), [query, setQuery] = useState("");
 const read = useRecordSearch(project, query);
 const submit = (event: FormEvent) => { event.preventDefault();setQuery(draft.trim().slice(0, 500)); };
 const gone = read.error instanceof ApiError && read.error.status === 404, paused = read.error instanceof ApiError && read.error.code === "TEAM_RECORD_PAUSED";
 return <section className="rv-project-section" aria-label="Search the team record">
  <h2>Search the team record</h2>
  <form role="search" onSubmit={submit} className="rv-record-search"><TextField label="Search what this project's team said, decided and did" type="search" value={draft} maxLength={500} onChange={event => { setDraft(event.target.value); }} /><Button type="submit" disabled={draft.trim() === ""}>Search</Button></form>
  {query !== "" && (read.isPending ? <p className="rv-muted" role="status">Searching</p>
   : gone ? <p className="rv-muted">The team record isn't set up here yet, so there is nothing to search.</p>
   : paused ? <p className="rv-muted">{PAUSED_WORDS}</p>
   : read.isError ? <><p role="alert">Couldn't search the team record. Try again.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>
   : read.data === undefined ? null : <div role="status" aria-live="polite">
     <h3>From the team record</h3>
     {read.data.search.hits.length === 0 ? <p className="rv-muted">Nothing matches.</p> : <ul className="rv-record-hits" aria-label="Team record results">{read.data.search.hits.map(hit => <li key={hit.id}>
      <p><strong><VisibleText text={hit.title === "" ? sourceWords(hit.source) : hit.title} /></strong> <span className="rv-muted">{sourceWords(hit.source) + " · " + dateWords(hit.occurredAt)}</span></p>
      {hit.snippet !== "" && <p className="rv-muted"><VisibleText text={hit.snippet} /></p>}
      <Where href={hit.link}>{"Open in " + sourceWords(hit.source)}</Where>
     </li>)}</ul>}
     <h3>Past tasks like this</h3>
     {read.data.pastWork.items.length === 0 ? <p className="rv-muted">No past task matches.</p> : <ul className="rv-record-hits" aria-label="Past tasks">{read.data.pastWork.items.map(item => <li key={item.taskId}>
      <p><strong><VisibleText text={item.title} /></strong> <span className="rv-muted">{item.outcome.merged ? "Merged" : item.outcome.reverted ? "Reverted" : "Not merged"}</span></p>
      {item.planSummary !== "" && <p className="rv-muted"><VisibleText text={item.planSummary} /></p>}
      <Where href={item.link}>Open the task</Where>
     </li>)}</ul>}
     {(read.data.search.someHidden || read.data.pastWork.someHidden) && <p className="rv-muted">Some results are left out because they come from places you can't see.</p>}
    </div>)}
 </section>;
}
