// exp/automations: one chain's page (`/app/chains/:id`, only where the `chains` feature is on): its facts and budget, its design and versions, its triggers and its runs.
// What the server says the person may do (`access`) decides which change buttons show; the server checks again on every write and its refusals are shown as it wrote them.
import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chainKey, useAutomationsApi } from "../../api/automations.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { NotFound } from "../../shell/NotFound.js";
import { paths } from "../../paths.js";
import { ActionNote, CompanySharedContext, problemNote, type Note } from "./ActionNote.js";
import { useReturnFocus } from "./useReturnFocus.js";
import { CHAIN_READ_ONLY_NOTE } from "./automation-text.js";
import { ChainDefinition } from "./ChainDefinition.js";
import { ChainFacts } from "./ChainFacts.js";
import { ChainVersions } from "./ChainVersions.js";
import { RunList } from "./RunList.js";
import { TriggerDialog } from "./TriggerDialog.js";
import { TriggerRow } from "./TriggerRow.js";
import "./automations.css";

/** A chain's id: `chn_` and 20 of 0-9 a-z (anything else is not a chain, so it is a plain "not found" with no request). */
const CHAIN_ID = /^chn_[0-9a-z]{20}$/u;
const RANK = { none: 0, view: 1, use: 2, edit: 3, manage: 4 } as const;
export function ChainScreen() {
  const { id } = useParams(), chainId = id !== undefined && CHAIN_ID.test(id) ? id : undefined, api = useAutomationsApi(), query = useQueryClient();
  const read = useQuery({ queryKey: chainKey(chainId ?? "", "chain"), queryFn: () => api.chain(chainId!), enabled: chainId !== undefined, retry: false });
  const triggers = useQuery({ queryKey: chainKey(chainId ?? "", "triggers"), queryFn: () => api.triggers(chainId!), enabled: chainId !== undefined && read.data !== undefined, retry: false });
  const level = RANK[read.data?.chain.access as keyof typeof RANK] ?? 0;
  // Who confirms a change depends on whether the chain is shared with the whole company; only people who manage it can read its shares (the same read ChainFacts makes).
  const shares = useQuery({ queryKey: chainKey(chainId ?? "", "shares"), queryFn: () => api.shares(chainId!), enabled: chainId !== undefined && level >= RANK.manage, retry: false });
  const companyShared = shares.data === undefined ? undefined : shares.data.shares.some(share => share.principal.kind === "org");
  const [adding, setAdding] = useState(false), [epoch, setEpoch] = useState(0), [note, setNote] = useState<Note>(), back = useReturnFocus();
  if (chainId === undefined || (read.error instanceof ApiError && read.error.status === 404)) return <NotFound />;
  if (read.isPending) return <section><h1 tabIndex={-1}>Chain</h1><Skeleton label="Loading the chain" /></section>;
  if (read.isError) return <section><h1 tabIndex={-1}>Chain unavailable</h1><ActionNote note={problemNote(read.error, true)} /><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
  const { chain, current } = read.data, canEdit = level >= RANK.edit, canManage = level >= RANK.manage,
    // The server lets people who only edit change what runs (publish, roll back) while no trigger of the chain is on; a manager always may (its requireManagerWhileTriggered).
    triggered = triggers.data?.triggers.some(trigger => trigger.enabled) === true, canChangeWhatRuns = canManage || (canEdit && triggers.data !== undefined && !triggered), project = chain.owner.kind === "project" ? chain.owner.project : undefined;
  const changed = () => { void query.invalidateQueries({ queryKey: ["automations"] }); };
  return <CompanySharedContext.Provider value={companyShared}><section className="rv-project rv-auto" aria-label="Chain">
    <PageHeader focusOnMount title={chain.name} {...(chain.description === "" ? {} : { description: chain.description })} actions={project === undefined ? undefined : <Link to={paths.project(project) + "?tab=automations"}>Back to {project}</Link>} />
    {!canEdit && <p className="rv-muted" role="note">{CHAIN_READ_ONLY_NOTE}.</p>}
    <ChainFacts chain={chain} canManage={canManage} onChanged={changed} />
    <ChainDefinition chain={chain} current={current} canEdit={canEdit} canPublish={canChangeWhatRuns} onChanged={changed} />
    <ChainVersions chainId={chain.chainId} canEdit={canChangeWhatRuns} onChanged={changed} />
    <section className="rv-project-section" aria-labelledby="chain-triggers"><div className="rv-auto-title"><h2 id="chain-triggers" tabIndex={-1}>Triggers</h2>{canManage && <Button onClick={event => { back.remember(event);setNote(undefined);setEpoch(value => value + 1);setAdding(true); }}>Add a trigger</Button>}</div>
      {triggers.isPending ? <Skeleton label="Loading triggers" /> : triggers.isError ? <ActionNote note={problemNote(triggers.error, true)} /> : triggers.data.triggers.length === 0 ? <p className="rv-muted">Nothing starts this chain on its own yet.</p> : <ul className="rv-auto-list">{triggers.data.triggers.map(trigger => <TriggerRow key={trigger.triggerId} trigger={trigger} chainId={chain.chainId} canEdit={canManage} afterRemove={() => { document.getElementById("chain-triggers")?.focus(); }} onChanged={changed} />)}</ul>}
      <ActionNote note={note} />
      {canManage && <TriggerDialog key={epoch} chainId={chain.chainId} project={project ?? triggers.data?.triggers[0]?.project} open={adding} onCloseAutoFocus={event => { back.onCloseAutoFocus(event); }} onOpenChange={open => { if (!open) setAdding(false); }} onSaved={saved => { setNote(saved);changed(); }} />}
    </section>
    <section className="rv-project-section" aria-labelledby="chain-runs"><h2 id="chain-runs">Runs</h2><RunList scope={{ chain: chain.chainId }} showChain={false} /></section>
  </section></CompanySharedContext.Provider>;
}
