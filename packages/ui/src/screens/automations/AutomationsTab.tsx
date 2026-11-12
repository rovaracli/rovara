// exp/automations: the project page's Automations tab: the chains this project owns or is shared, every trigger set on it (state and last result), and recent runs.
// Everyone with a role on the project reads. The change buttons show only where the server says `canEdit`; the server checks again on every write.
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { automationsKey, useAutomationsApi } from "../../api/automations.js";
import { Button } from "../../design/Button.js";
import { Chip } from "../../design/Chip.js";
import { Dialog } from "../../design/Dialog.js";
import { Money } from "../../design/Money.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ApiError } from "../../api/errors.js";
import { ActionNote, problemNote, type Note } from "./ActionNote.js";
import { READ_ONLY_NOTE } from "./automation-text.js";
import { RunList } from "./RunList.js";
import { TriggerRow } from "./TriggerRow.js";
import "./automations.css";

function NewChain({ project }: { project: string }) {
  const api = useAutomationsApi(), navigate = useNavigate(), query = useQueryClient(), [open, setOpen] = useState(false), [name, setName] = useState(""), [note, setNote] = useState<Note>(), [busy, setBusy] = useState(false), sending = useRef(false);
  async function create() {
    if (sending.current || name.trim() === "") return;
    sending.current = true;setBusy(true);setNote(undefined);
    try {
      const result = await api.createChain(project, name.trim());
      if (result.kind !== "done") { setNote({ kind: "problem", problem: { message: "Rovara asked for a confirmation instead of making the chain. Try again.", forbidden: false, reauth: false } });return; }
      await query.invalidateQueries({ queryKey: automationsKey(project) });setOpen(false);void navigate("/app/chains/" + encodeURIComponent(result.value.chain.chainId));
    } catch (error) { setNote(problemNote(error)); } finally { sending.current = false;setBusy(false); }
  }
  return <>
    <Button onClick={() => { setName("");setNote(undefined);setOpen(true); }}>New chain</Button>
    <Dialog title="New chain" description="It starts with one step. You can change it on its page before anything runs." open={open} onOpenChange={setOpen}>
      <form className="rv-auto-form" onSubmit={event => { event.preventDefault();void create(); }}>
        <TextField label="Name" value={name} maxLength={80} onChange={event => { setName(event.target.value); }} autoComplete="off" />
        <ActionNote note={note} />
        <div className="rv-actions"><Button variant="primary" type="submit" busy={busy} disabled={name.trim() === ""}>Make the chain</Button><Button onClick={() => { setOpen(false); }}>Cancel</Button></div>
      </form>
    </Dialog>
  </>;
}

export function AutomationsTab({ project }: { project: string }) {
  const api = useAutomationsApi(), query = useQueryClient(), read = useQuery({ queryKey: automationsKey(project), queryFn: () => api.project(project), retry: false });
  if (read.isPending) return <Skeleton label="Loading automations" />;
  if (read.isError) return <section className="rv-auto"><h2>Automations</h2>{read.error instanceof ApiError && read.error.status === 404 ? <p className="rv-muted">Automations aren't available here.</p> : <ActionNote note={problemNote(read.error)} />}<Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
  const { chains, triggers, canEdit } = read.data, changed = () => { void query.invalidateQueries({ queryKey: automationsKey(project) });void query.invalidateQueries({ queryKey: ["automations", "project-runs", project] }); };
  return <section className="rv-auto" aria-label="Automations">
    {!canEdit && <p className="rv-muted" role="note">{READ_ONLY_NOTE}.</p>}
    <section className="rv-project-section" aria-labelledby="auto-chains"><div className="rv-auto-title"><h2 id="auto-chains">Chains</h2>{canEdit && <NewChain project={project} />}</div>
      {chains.length === 0 ? <p className="rv-muted">No chains yet. A chain is a few agents working one after another.</p> : <ul className="rv-auto-list">{chains.map(chain => <li key={chain.chainId} className="rv-auto-row">
        <div className="rv-auto-row-head"><div><Link to={"/app/chains/" + encodeURIComponent(chain.chainId)}><VisibleText text={chain.name} /></Link>{chain.status === "archived" && <> <Chip>Archived</Chip></>}</div></div>
        {chain.description !== "" && <p className="rv-muted"><VisibleText text={chain.description} /></p>}
        <p className="rv-muted">{chain.currentVersion === undefined ? "Not published yet" : "Version " + String(chain.currentVersion)} · {chain.monthlyBudgetUsd === undefined ? "No spending cap yet" : <>Spending cap <Money usd={chain.monthlyBudgetUsd} /> a month</>}</p>
      </li>)}</ul>}
    </section>
    <section className="rv-project-section" aria-labelledby="auto-triggers"><h2 id="auto-triggers">Triggers</h2>
      {triggers.length === 0 ? <p className="rv-muted">Nothing starts a chain on its own here yet.</p> : <ul className="rv-auto-list">{triggers.map(trigger => <TriggerRow key={trigger.triggerId} trigger={trigger} showTarget canEdit={canEdit} chainId={trigger.target.kind === "chain" ? trigger.target.chainId : undefined} onChanged={changed} />)}</ul>}
    </section>
    <section className="rv-project-section" aria-labelledby="auto-runs"><h2 id="auto-runs">Recent runs</h2><RunList scope={{ project }} showChain /></section>
  </section>;
}
