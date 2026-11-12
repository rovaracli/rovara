// exp/automations: a chain's facts and the things its managers change: its spending cap, who is accountable, who it is shared with (read only here), and archiving.
// Moving the owner or accountable person of a company-shared chain needs an owner or admin; the server says so, and a 202 shows the waiting words with the link.
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import type { ReadAppNav } from "@agentx/cloud-contracts/web";
import { chainKey, useAutomationsApi, type ChainRead, type ChainSharesReader } from "../../api/automations.js";
import { Button } from "../../design/Button.js";
import { Chip } from "../../design/Chip.js";
import { Dialog } from "../../design/Dialog.js";
import { Money } from "../../design/Money.js";
import { Select } from "../../design/Select.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ActionNote, noteOf, problemNote, type Note } from "./ActionNote.js";
import { useReturnFocus } from "./useReturnFocus.js";

const levelWords: Record<string, string> = { view: "can look at it", use: "can run it", edit: "can change it", manage: "can manage it" };
export function sharesWords(shares: z.infer<typeof ChainSharesReader>["shares"]): string[] {
  return shares.map(share => `${share.principal.kind === "org" ? "Everyone in the company" : share.principal.kind === "project" ? "The " + (share.principal.project ?? "") + " project" : "One person"} ${levelWords[share.level] ?? share.level}`);
}

export function ChainFacts({ chain, canManage, onChanged }: { chain: ChainRead; canManage: boolean; onChanged: () => void }) {
  const api = useAutomationsApi(), query = useQueryClient(), [fallbackElement, setFallbackElement] = useState<HTMLElement | null>(null), back = useReturnFocus(fallbackElement), [note, setNote] = useState<Note>(), [busy, setBusy] = useState<string>(), [cap, setCap] = useState(chain.monthlyBudgetUsd === undefined ? "" : String(chain.monthlyBudgetUsd)), [who, setWho] = useState(""), [asking, setAsking] = useState(false), sending = useRef(false);
  const project = chain.owner.kind === "project" ? chain.owner.project : undefined, archived = chain.status === "archived";
  const shares = useQuery({ queryKey: chainKey(chain.chainId, "shares"), queryFn: () => api.shares(chain.chainId), enabled: canManage, retry: false });
  const people = useQuery({ queryKey: ["automations", "people", project], queryFn: () => api.people(project!), enabled: project !== undefined, retry: false });
  // Decision 92: moving who is accountable for a company-shared chain is for an org owner or admin. Not known to be otherwise (shares still loading) offers nothing.
  const orgRole = query.getQueryData<ReadAppNav>(["nav"])?.me.orgRole, orgAdmin = orgRole === "owner" || orgRole === "admin";
  const companyShared = shares.data?.shares.some(share => share.principal.kind === "org"), mayMoveAccountable = shares.data !== undefined && (companyShared !== true || orgAdmin);
  const members = people.data?.members ?? [], accountableName = chain.accountable === undefined ? undefined : members.find(member => member.developerId === chain.accountable?.developerId)?.name;
  const maintainers = members.filter(member => member.role === "maintainer");
  async function run(label: string, work: () => Promise<Note>) {
    if (sending.current) return;
    sending.current = true;setBusy(label);setNote(undefined);
    try { const next = await work();setNote(next);await query.invalidateQueries({ queryKey: ["automations"] });onChanged();back.rescue(); } catch (error) { setNote(problemNote(error)); }
    finally { sending.current = false;setBusy(undefined); }
  }
  const capValue = Number(cap), capBad = cap.trim() !== "" && !(Number.isFinite(capValue) && capValue >= 0);
  const disabled = (result: { disabledTriggers: Array<{ triggerId: string; problems: Array<{ message?: string | undefined }> }> }) => result.disabledTriggers.map(item => `A trigger was turned off: ${item.problems[0]?.message ?? "it no longer qualifies"}`);
  const saveCap = (value: number | null) => run("budget", async () => { const result = await api.setBudget(chain.chainId, value);return noteOf(result, value === null ? "The spending cap is removed." : "The spending cap is saved.", result.kind === "done" ? disabled(result.value) : undefined); });
  const setArchived = (archive: boolean) => run("archive", async () => { const result = await (archive ? api.archive(chain.chainId) : api.unarchive(chain.chainId));setAsking(false);return noteOf(result, archive ? "The chain is archived. Its triggers are off." : "The chain is active again. Its triggers stay off until someone turns them on."); });
  const accountable = () => run("accountable", async () => noteOf(await api.setAccountable(chain.chainId, who), "The accountable person is changed."));
  return <section className="rv-project-section rv-auto" aria-labelledby="chain-facts" tabIndex={-1} ref={setFallbackElement}><h2 id="chain-facts">About this chain</h2>
    <dl className="rv-auto-facts">
      <div><dt>Status</dt><dd>{archived ? <Chip>Archived</Chip> : "Active"}{chain.openRuns > 0 && <span className="rv-muted"> · {chain.openRuns} running</span>}</dd></div>
      <div><dt>Owner</dt><dd>{project === undefined ? "One person" : <>The <VisibleText text={project} /> project</>}</dd></div>
      {project !== undefined && <div><dt>Accountable</dt><dd>{chain.accountable === undefined ? "Nobody is named yet" : accountableName === undefined ? "A project maintainer" : <VisibleText text={accountableName} />}</dd></div>}
      <div><dt>Spending cap</dt><dd>{chain.monthlyBudgetUsd === undefined ? "None yet. A chain that runs on its own needs one." : <><Money usd={chain.monthlyBudgetUsd} /> a month</>}</dd></div>
      {canManage && <div><dt>Shared with</dt><dd>{shares.isPending ? "Loading" : shares.isError ? "Couldn't load" : shares.data.shares.length === 0 ? "Nobody else" : <ul>{sharesWords(shares.data.shares).map(line => <li key={line}>{line}</li>)}</ul>}</dd></div>}
    </dl>
    {canManage ? <>
      <form className="rv-auto-form" onSubmit={event => { event.preventDefault();if (!capBad && cap.trim() !== "") void saveCap(capValue); }}>
        <TextField label="Monthly spending cap, in US dollars" type="number" min={0} step="0.01" value={cap} onChange={event => { setCap(event.target.value); }} {...(capBad ? { error: "Use a number of dollars" } : {})} />
        <div className="rv-actions"><Button type="submit" busy={busy === "budget"} disabled={capBad || cap.trim() === ""}>Save cap</Button>{chain.monthlyBudgetUsd !== undefined && <Button onClick={() => { setCap("");void saveCap(null); }}>Remove cap</Button>}</div>
      </form>
      {project !== undefined && shares.data !== undefined && !mayMoveAccountable && <p className="rv-muted" role="note">Only an owner or admin can change who is accountable for a company-shared chain.</p>}
      {project !== undefined && mayMoveAccountable && maintainers.length > 0 && <form className="rv-auto-form" onSubmit={event => { event.preventDefault();if (who !== "") void accountable(); }}>
        <Select label="Who is accountable" value={who} onValueChange={setWho} placeholder="Choose a maintainer" options={maintainers.map(member => ({ value: member.developerId, label: member.name }))} />
        <div className="rv-actions"><Button type="submit" busy={busy === "accountable"} disabled={who === "" || who === chain.accountable?.developerId}>Change who is accountable</Button></div>
      </form>}
      <div className="rv-actions">{archived ? <Button busy={busy === "archive"} onClick={() => { void setArchived(false); }}>Unarchive</Button> : <Button onClick={event => { back.remember(event);setAsking(true); }}>Archive</Button>}</div>
    </> : <p className="rv-muted" role="note">Only people who manage this chain can change these.</p>}
    {!asking && <ActionNote note={note} />}
    <Dialog title="Archive this chain?" description="It will start nothing, and its triggers go off." onCloseAutoFocus={event => { back.onCloseAutoFocus(event); }} open={asking} onOpenChange={open => { setAsking(open);if (!open) setNote(undefined); }}>
      <ActionNote note={note} />
      <div className="rv-actions"><Button variant="danger" busy={busy === "archive"} onClick={() => { void setArchived(true); }}>Archive chain</Button><Button onClick={() => { setAsking(false); }}>Keep it</Button></div>
    </Dialog>
  </section>;
}
