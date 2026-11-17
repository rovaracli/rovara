// Spending limits (lead 3 B1, DEC 254t b): a monthly limit for one project or one person, over the company default. Company owners and admins only (the server
// refuses everyone else, and a member never sees the link). Raising a limit needs the fresh sign-in step; lowering one does not, so the page just sends it and
// shows the step only when the server asks. The company defaults live in Company settings; a project's per-task limit lives on its own page.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { MEMBERS_PATH, SCOPE_ID, SPEND_LIMITS_PATH, SPEND_LIMIT_TABLES, limitPath, parseUsd, readPeopleNames, readSpendLimits, type PersonName, type SpendLimitRow, type SpendLimitScope, type SpendLimitTable, type SpendLimitsRead } from "../../../api/admin-spend-limits.js";
import { isNotConnected, needsStepUp } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Money } from "../../../design/Money.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select } from "../../../design/Select.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { VisuallyHidden } from "../../../design/VisuallyHidden.js";
import { useAdminContext } from "../AdminLayout.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { AdminSection, FreshSignIn, NotConnected, forgetConfirmed, useJustConfirmed } from "../parts.js";

const reader = { parse: readSpendLimits };
const namesReader = { parse: readPeopleNames };
/** What a row of each scope is called, and what its id looks like. */
const WORDS: Record<SpendLimitScope, { one: string; noun: string; idLabel: string; idHint: string; valid: (id: string) => boolean }> = {
 project: { one: "project", noun: "Projects", idLabel: "Project name", idHint: "The project's name, as it appears in Projects.", valid: id => SCOPE_ID.project.test(id) },
 person: { one: "person", noun: "People", idLabel: "Person ID", idHint: "The person's developer ID (64 letters and digits, from the People page).", valid: id => SCOPE_ID.person.test(id) },
};
const AMOUNT_HELP = "Use an amount from 0 to 1,000,000, with at most two decimals.";
const problem = (when: boolean, text: string) => (when ? { error: text } : {});
const usdOrNone = (value: number | null) => (value === null ? "No limit" : <Money usd={value} />);
const shortId = (scope: SpendLimitScope, id: string) => (scope === "person" ? `${id.slice(0, 12)}…` : id);

export function SpendLimitsScreen() {
 const read = useAdminRead("spend-limits", SPEND_LIMITS_PATH, reader, { stable: true });
 return <section><PageHeader focusOnMount title="Spending limits" description="A monthly limit on the agents' AI spending for one project or one person, over the company's default. The company's monthly limit always stays the outer bound. These limits do not apply to a project's product AI or to lessons' learning." />
  {read.isError && isNotConnected(read.error) && read.error instanceof ApiError && read.error.status === 501 ? <AdminSection title="Spending limits"><NotConnected what="Spending limits" /></AdminSection>
   : <ReadSection read={read} label="Spending limits">{limits => <Limits limits={limits} reload={() => { void read.refetch(); }} />}</ReadSection>}
 </section>;
}

function Limits({ limits, reload }: { limits: SpendLimitsRead; reload: () => void }) {
 const { developerId } = useAdminContext(), host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 // The company's people, to show names. Best effort: when the list can't be read the page falls back to person IDs, and nothing else changes.
 const people = useAdminRead("spend-limits-people", MEMBERS_PATH, namesReader, { stable: true }).data;
 const confirmed = useJustConfirmed(developerId);
 // People and limits links here with `?person=<id>`: that person's add (or edit) form opens (only a well-formed id is used).
 const [params] = useSearchParams(), asked = params.get("person") ?? "", pick = SCOPE_ID.person.test(asked) ? asked : "";
 const [stepNeeded, setStepNeeded] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 /** Sends one change. `usd` null removes the limit. The server decides whether it needs the fresh sign-in step. */
 async function send(table: SpendLimitTable, id: string, version: number, usd: number | null, done: string): Promise<boolean> {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer("PUT", limitPath(table, id), { expectedVersion: version, monthlyUsd: usd }, { parse: answer => answer }, { retry: "never" });
   setStepNeeded(false); setNotice({ ok: true, text: done });
   await query.invalidateQueries({ queryKey: ["admin", "lane-c", "spend-limits"] }); reload();
   return true;
  } catch (error) {
   if (needsStepUp(error)) { setStepNeeded(true); forgetConfirmed(host.storage, developerId); }
   else setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
   return false;
  } finally { setBusy(false); }
 }
 const d = limits.defaults;
 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  {stepNeeded && <FreshSignIn action="raise a spending limit" refused />}
  {!stepNeeded && confirmed && <FreshSignIn action="raise a spending limit" done />}
  <AdminSection title="Company defaults" note="Change these in Company settings">
   <ul data-testid="spend-defaults">
    <li>Company, each month: {usdOrNone(d.companyMonthlyUsd)}</li>
    <li>Each person, each month: {usdOrNone(d.memberMonthlyUsd)}</li>
    <li>Each project, each month: {usdOrNone(d.projectMonthlyUsd)}</li>
    <li data-testid="spend-task-default">Each task: {usdOrNone(d.taskUsd)}. A project's own per-task limit is set on <a href="/app/admin/projects">that project's page</a>.</li>
   </ul>
   <p className="rv-muted">Raising a limit asks you to confirm it's you. Lowering one does not.</p>
  </AdminSection>
  {SPEND_LIMIT_TABLES.map(table => <LimitTable key={table.listKey} table={table} initialId={table.scope === "person" ? pick : ""} people={people} rows={limits.lists[table.listKey] ?? []} fallback={d[table.defaultKey]} max={limits.max[table.listKey] ?? 0} partial={limits.partial} busy={busy} send={send} />)}
 </>;
}

interface TableProps { table: SpendLimitTable; /** The id the add form starts on (from the address). */ initialId: string; people?: PersonName[] | undefined; rows: SpendLimitRow[]; fallback: number | null; max: number; partial: boolean; busy: boolean; send: (table: SpendLimitTable, id: string, version: number, usd: number | null, done: string) => Promise<boolean> }
function LimitTable({ table, initialId, people, rows, fallback, max, partial, busy, send }: TableProps) {
 const kind = table.scope, key = table.listKey, words = WORDS[kind];
 const names = new Map((people ?? []).map(person => [person.developerId, person.name]));
 const label = (id: string) => (kind === "person" ? names.get(id) ?? shortId(kind, id) : id);
 // People without a limit of their own can be picked by name; with no readable list, the person's ID is typed.
 const pickable = kind === "person" ? (people ?? []).filter(person => !rows.some(row => row.id === person.developerId)) : [];
 // A person who already has a limit opens on its edit; one who has none opens the add form on them.
 const existing = rows.find(row => row.id === initialId);
 const [editing, setEditing] = useState<string | undefined>(existing?.id), [amount, setAmount] = useState(existing === undefined ? "" : String(existing.monthlyUsd)), [newId, setNewId] = useState(existing === undefined ? initialId : ""), [newAmount, setNewAmount] = useState("");
 const full = partial || rows.length >= max;
 const addId = newId.trim(), addUsd = parseUsd(newAmount);
 return <AdminSection title={table.title} note={`${String(rows.length)} of ${String(max)}`}>
  <div className="rv-table-wrap"><table className="rv-table" data-testid={`spend-${key}-table`}>
   <caption>{words.noun} with their own monthly limit. Everyone else keeps the default ({usdOrNone(fallback)}).</caption>
   <thead><tr><th scope="col">{words.idLabel}</th><th scope="col">Monthly limit</th><th scope="col"><VisuallyHidden>Actions</VisuallyHidden></th></tr></thead>
   <tbody>
    {rows.length === 0 && <tr><td colSpan={3}>None. Every {words.one} uses the default.</td></tr>}
    {rows.map(row => <tr key={row.id} data-testid={`spend-${key}-row`}>
     <th scope="row" title={row.id}><VisibleText text={label(row.id)} /></th>
     {editing === row.id
      ? <td><TextField label={`New monthly limit for ${label(row.id)} (dollars)`} inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); }} {...problem(amount !== "" && parseUsd(amount) === undefined, AMOUNT_HELP)} /></td>
      : <td><Money usd={row.monthlyUsd} /></td>}
     <td>{editing === row.id
      ? <><Button variant="primary" busy={busy} disabled={parseUsd(amount) === undefined} onClick={() => { const value = parseUsd(amount); if (value !== undefined) void send(table, row.id, row.version, value, `Saved the limit for ${label(row.id)}.`).then(saved => { if (saved) setEditing(undefined); }); }}>Save</Button> <Button variant="quiet" onClick={() => { setEditing(undefined); }}>Cancel</Button></>
      : <><Button variant="quiet" onClick={() => { setEditing(row.id); setAmount(String(row.monthlyUsd)); }}>Edit</Button> <Button variant="danger" busy={busy} onClick={() => { void send(table, row.id, row.version, null, `Removed the limit for ${label(row.id)}. The default applies again.`); }}>Remove</Button></>}</td>
    </tr>)}
   </tbody>
  </table></div>
  {full ? <p role="status" data-testid={`spend-${key}-full`}>There are too many limits of this kind. Remove some before adding another.</p>
   : <form aria-label={`Add a ${words.one} limit`} onSubmit={event => { event.preventDefault(); if (words.valid(addId) && addUsd !== undefined) void send(table, addId, 0, addUsd, `Saved the limit for ${label(addId)}.`).then(saved => { if (saved) { setNewId(""); setNewAmount(""); } }); }}>
    {pickable.length > 0
     ? <Select label="Person" value={newId} onValueChange={setNewId} placeholder="Choose a person" options={pickable.map(person => ({ value: person.developerId, label: person.name }))} />
     : <TextField label={words.idLabel} hint={words.idHint} value={newId} onChange={event => { setNewId(event.target.value); }} {...problem(addId !== "" && !words.valid(addId), `That isn't a valid ${words.one} ${kind === "project" ? "name" : "ID"}.`)} />}
    <TextField label={`Monthly limit for this ${words.one} (dollars)`} inputMode="decimal" value={newAmount} onChange={event => { setNewAmount(event.target.value); }} {...problem(newAmount !== "" && addUsd === undefined, AMOUNT_HELP)} />
    <Button variant="primary" busy={busy} disabled={!words.valid(addId) || addUsd === undefined} onClick={() => { if (words.valid(addId) && addUsd !== undefined) void send(table, addId, 0, addUsd, `Saved the limit for ${label(addId)}.`).then(saved => { if (saved) { setNewId(""); setNewAmount(""); } }); }}>Add limit</Button>
   </form>}
 </AdminSection>;
}
