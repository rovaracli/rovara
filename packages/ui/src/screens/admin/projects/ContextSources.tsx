import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createContextSourcesApi, type DiscoveredView, type McpServerView, type SourceView } from "../../../api/context-sources.js";

// Build is not in this list on purpose: sources are for the stages that read and judge, never the one that runs commands.
const STAGES = [["UNDERSTAND", "Understand"], ["PLAN", "Plan"], ["PLAN_CRITIQUE", "Plan check"], ["REVIEW", "Review"]] as const;
const QUOTES = [["citations_only", "Nobody sees quotes; everyone sees the title and the link"], ["project_members", "Project members see quotes"]] as const;
const stageWord = (stage: string) => STAGES.find(([value]) => value === stage)?.[1] ?? stage;
const quoteWord = (value: string) => value === "citations_only" ? "Citations only" : value === "project_members" ? "Project members see quotes" : "People allowed at the source";
const annotationWord = { read_only: "says it only reads", unannotated: "does not say it only reads", unsafe: "says it changes things" } as const;

type ServerChoice = { key: string; label: string; server: SourceView["server"] };

/** The Sources of one project (owner or admin): what Rovara may read while it understands, plans, checks a plan and reviews. Read-only, per project, never in Build. */
export function ContextSources({ project }: { project: string }) {
 const host = useAppHost(), api = useMemo(() => createContextSourcesApi(host), [host]);
 const client = useQueryClient(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string>();
 const [choice, setChoice] = useState(""), [tools, setTools] = useState<DiscoveredView[]>(), [ticked, setTicked] = useState<Record<string, { role: "search" | "read" | "status"; confirmed: boolean }>>({});
 const [label, setLabel] = useState(""), [sourceId, setSourceId] = useState(""), [stages, setStages] = useState<string[]>(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"]), [quotes, setQuotes] = useState<"citations_only" | "project_members">("citations_only"), [code, setCode] = useState(false);
 const key = useMemo(() => ["context-sources", project], [project]);
 const read = useQuery({
  queryKey: key, retry: false, gcTime: 0, refetchOnWindowFocus: false,
  queryFn: async () => {
   const sources = await api.sources(project);
   // The servers and connections only fill the "Add a source" choices; a failure to read them leaves the list empty, not the page broken.
   const [servers, connections] = await Promise.all([api.servers().then(value => value.servers, (): McpServerView[] => []), api.connections().then(value => value.connections, (): Array<{ connectionId: string; label: string; type: string }> => [])]);
   return { sources: sources.document.sources, pending: sources.pending, servers, connections };
  },
 });
 const hidden = read.error instanceof ApiError && (read.error.status === 403 || read.error.status === 404);
 const data = read.data, loadError = read.error instanceof ApiError && !hidden ? read.error.message : read.isError && !hidden ? "Couldn't load sources." : undefined;
 const servers = data?.servers ?? [], connections = data?.connections ?? [];
 const choices: ServerChoice[] = [
  ...connections.filter(c => c.type === "mcp").map(c => ({ key: `c:${c.connectionId}`, label: `${c.label} (connection)`, server: { kind: "connection" as const, connectionId: c.connectionId } })),
  ...servers.filter(s => s.status === "approved").map(s => ({ key: `s:${s.serverId}`, label: `${s.label} (on your network)`, server: { kind: "registered_server" as const, serverId: s.serverId } })),
 ];
 async function run(action: () => Promise<void>) { setBusy(true);setError(undefined);setNotice(undefined);try { await action();await client.invalidateQueries({ queryKey: key }); } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Rovara couldn't do that. Try again."); } finally { setBusy(false); } }
 if (hidden) return null;
 const chosen = choices.find(c => c.key === choice);
 function buildSource(): unknown {
  const picked = (tools ?? []).filter(t => ticked[t.name] !== undefined);
  return {
   sourceId, label: label.trim(), server: chosen!.server,
   tools: picked.map(t => ({ upstreamName: t.name, role: ticked[t.name]!.role, schemaHash: t.schemaHash, ...(ticked[t.name]!.confirmed ? { attestedReadOnly: true } : {}) })),
   stages, quotes, retention: "team_record", limits: { callsPerStage: 25, bytesPerResult: 16384, bytesPerStage: 196608 }, liveFacts: [], sendCodeSnippets: code,
  };
 }
 const needsConfirm = (t: DiscoveredView) => t.annotation === "unannotated" || t.nameSuggestsChange;
 const ready = chosen !== undefined && /^[a-z][a-z0-9]{1,15}$/u.test(sourceId) && label.trim() !== "" && stages.length > 0 && (tools ?? []).some(t => ticked[t.name] !== undefined) && (tools ?? []).every(t => ticked[t.name] === undefined || !needsConfirm(t) || ticked[t.name]!.confirmed);
 return <section aria-labelledby="context-sources-title">
  <h2 id="context-sources-title">Sources</h2>
  <p>Systems Rovara may read while it understands a request, plans, checks a plan and reviews a change: your tracker, your wiki. Rovara only reads, never in Build, and treats whatever comes back as information, never as instructions.</p>
  {(error ?? loadError) && <p role="alert">{error ?? loadError}</p>}{notice && <p role="status">{notice}</p>}
  {data === undefined ? <p role="status">Loading sources.</p> : data.sources.length === 0 ? <p>This project has no sources.</p> : <ul>{data.sources.map(source => <li key={source.sourceId}>
   <strong><VisibleText text={source.label} /></strong> · {source.tools.length} tools · {source.stages.map(stageWord).join(", ")} · {quoteWord(source.quotes)}{source.sendCodeSnippets ? " · may receive code in its queries" : ""}
   <Button disabled={busy} onClick={() => { void run(async () => { await api.propose(project, { kind: "remove", sourceId: source.sourceId });setNotice("Removal proposed. Confirm it below."); }); }}>Remove</Button>
  </li>)}</ul>}
  {data !== undefined && data.pending.length > 0 && <><h3>Waiting for confirmation</h3><ul>{data.pending.map(change => <li key={change.changeId}>
   {change.kind === "remove" ? "Remove" : "Add or change"} <strong><VisibleText text={change.source?.label ?? change.sourceId} /></strong>.{change.secondAdminReasons.length > 0 && <> A second admin must confirm: <VisibleText text={change.secondAdminReasons.join("; ")} />.</>}
   <Button variant="primary" disabled={busy} onClick={() => { void run(async () => { await api.confirm(project, change.changeId);setNotice("Done."); }); }}>Confirm</Button>
   <Button disabled={busy} onClick={() => { void run(async () => { await api.reject(project, change.changeId); }); }}>Turn down</Button>
  </li>)}</ul></>}
  <h3>Add a source</h3>
  {choices.length === 0 ? <p>There is no server to read from yet. Add a connection, or an MCP server on your network, first.</p> : <>
   <label htmlFor="source-server">Server</label>
   <select id="source-server" className="rv-input" value={choice} onChange={event => { setChoice(event.target.value);setTools(undefined);setTicked({}); }}><option value="">Choose a server</option>{choices.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
   <Button disabled={busy || chosen === undefined} onClick={() => { void run(async () => { setTools((await api.discover(project, chosen!.server)).tools);setTicked({}); }); }}>Show its tools</Button>
   {tools && <fieldset><legend>Tools Rovara may use</legend>
    {tools.length === 0 ? <p>The server offers no tools.</p> : tools.map(tool => <div key={tool.name}>
     <label><input type="checkbox" disabled={tool.annotation === "unsafe"} checked={ticked[tool.name] !== undefined} onChange={event => setTicked(current => { const next = { ...current };if (event.target.checked) next[tool.name] = { role: "read", confirmed: false };else delete next[tool.name];return next; })} /> <code><VisibleText text={tool.name} /></code></label>: {annotationWord[tool.annotation]}. <VisibleText text={tool.description} />
     {tool.takesAddress && <> Takes an address: only addresses on the server's own site are sent.</>}
     {ticked[tool.name] && <>
      <select aria-label={`What ${tool.name} is for`} value={ticked[tool.name]!.role} onChange={event => setTicked(current => ({ ...current, [tool.name]: { ...current[tool.name]!, role: event.target.value as "search" | "read" | "status" } }))}><option value="search">Search</option><option value="read">Read one item</option><option value="status">Status</option></select>
      {needsConfirm(tool) && <label><input type="checkbox" checked={ticked[tool.name]!.confirmed} onChange={event => setTicked(current => ({ ...current, [tool.name]: { ...current[tool.name]!, confirmed: event.target.checked } }))} /> I confirm this tool only reads. A second admin must also confirm it.</label>}
     </>}
    </div>)}
   </fieldset>}
   <TextField label="Name" maxLength={60} value={label} onChange={event => setLabel(event.target.value)} />
   <TextField label="Short id" hint="Lower-case letters and digits, 2 to 16 characters, for example tracker" maxLength={16} value={sourceId} onChange={event => setSourceId(event.target.value)} />
   <fieldset><legend>Where it may be used</legend>{STAGES.map(([value, word]) => <label key={value}><input type="checkbox" checked={stages.includes(value)} onChange={event => setStages(current => event.target.checked ? [...current, value] : current.filter(entry => entry !== value))} /> {word}</label>)}<p>Build is not offered. Rovara never reads these sources while it writes code.</p></fieldset>
   <label htmlFor="source-quotes">Who may see quotes</label>
   <select id="source-quotes" className="rv-input" value={quotes} onChange={event => setQuotes(event.target.value as "citations_only" | "project_members")}>{QUOTES.map(([value, word]) => <option key={value} value={value}>{word}</option>)}</select>
   <label><input type="checkbox" checked={code} onChange={event => setCode(event.target.checked)} /> Allow code in its queries. Off unless you turn it on.</label>
   <Button variant="primary" busy={busy} disabled={!ready} onClick={() => { void run(async () => { const proposed = await api.propose(project, { kind: "set", source: buildSource() });setNotice(proposed.needsSecondAdmin.length > 0 ? "Proposed. A second admin must confirm it." : "Proposed. Confirm it below.");setChoice("");setTools(undefined);setTicked({});setLabel("");setSourceId(""); }); }}>Propose this source</Button>
  </>}
 </section>;
}
