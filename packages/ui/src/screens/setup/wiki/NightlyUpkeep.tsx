// "Nightly upkeep" (setup-upkeep-plan.md decision 2; lead 4 W6): the ONE switch, off by default, and its monthly cap. The switch is Code's (a seam the nightly runner supplies: until Code serves it this says so and
// draws no dead switch). The cap is a spend limit of the company (`upkeep_month`, L4-E): a company owner or admin reads and changes it here with the same body the Spending page sends; a lower cap saves at once, a
// higher one asks for a fresh sign-in (the server decides, this page only asks). Anyone else is told who sets it. The panel says which limit each part uses.
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fixedWikiSetupWords, parseUsd, readUpkeepCap, useWikiSetupApi, wikiSetupAbsent, wikiSetupKey, type UpkeepCap } from "../../../api/wiki-setup.js";
import { needsStepUp } from "../../../api/admin-company.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { Money } from "../../../design/Money.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { FreshSignIn } from "../../admin/parts.js";
import { CAP_SENTENCES, T } from "./wiki-setup-text.js";

function CapField({ project, cap, onSaved, onEdit }: { project: string; cap: UpkeepCap; onSaved: () => void; onEdit: () => void }) {
  const api = useWikiSetupApi();
  const [text, setText] = useState(cap.usd === null ? "" : cap.usd.toFixed(2)), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [stepUp, setStepUp] = useState(false);
  const typed = parseUsd(text);
  async function save() {
    if (typed === undefined) { setError(T.CAP_INVALID); return; }
    setBusy(true); setError(undefined); onEdit(); setStepUp(false);
    try { await api.capWrite(project, cap.version, typed); onSaved(); }
    catch (caught) {
      if (needsStepUp(caught)) setStepUp(true);
      else setError(caught instanceof ApiError && CAP_SENTENCES.has(caught.message) ? caught.message : T.CAP_FAILED);
    } finally { setBusy(false); }
  }
  return <div className="rv-wikis-cap" data-testid="wiki-setup-cap">
    <TextField label={T.CAP} hint={T.CAP_HINT} inputMode="decimal" value={text} onChange={(event) => { setText(event.target.value); onEdit(); setError(undefined); }} />
    <p className="rv-muted">{cap.usd === null ? T.CAP_NONE : <>Now: <Money usd={cap.usd} /> a month. </>}{cap.own ? T.CAP_OWN : T.CAP_DEFAULT}</p>
    <Button busy={busy} disabled={text.trim() === ""} data-testid="wiki-setup-cap-save" onClick={() => { void save(); }}>{T.CAP_SAVE}</Button>
    {error !== undefined && <p role="alert" data-testid="wiki-setup-cap-error"><VisibleText text={error} /></p>}
    {stepUp && <FreshSignIn action="raise the nightly upkeep cap" refused />}
  </div>;
}

function Cap({ project }: { project: string }) {
  const api = useWikiSetupApi(), query = useQueryClient();
  // "Saved." lives here, not in the field: a saved cap redraws the field (it is keyed by what was read) and must not lose the word.
  const [saved, setSaved] = useState(false);
  const read = useQuery({ queryKey: wikiSetupKey(project, "cap"), queryFn: async () => readUpkeepCap(await api.capRead(), project), retry: false, gcTime: 0, refetchOnWindowFocus: false });
  if (read.isPending) return <Skeleton label="Loading the monthly cap" />;
  if (read.isError || read.data === undefined) return <p className="rv-muted" data-testid="wiki-setup-cap-unreadable">{T.CAP_UNREADABLE}</p>;
  // Keyed by what was read, so a saved cap redraws with its new version and words.
  return <>
    <CapField key={`${String(read.data.usd)}:${String(read.data.version)}`} project={project} cap={read.data} onEdit={() => { setSaved(false); }} onSaved={() => { setSaved(true); void query.invalidateQueries({ queryKey: wikiSetupKey(project, "cap") }); }} />
    {saved && <p role="status" data-testid="wiki-setup-cap-saved">{T.CAP_SAVED}</p>}
  </>;
}

export function NightlyUpkeep({ project, companyAdmin }: { project: string; companyAdmin: boolean }) {
  const api = useWikiSetupApi(), query = useQueryClient();
  const read = useQuery({ queryKey: wikiSetupKey(project, "upkeep"), queryFn: () => api.upkeep(project), retry: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), id = useRef<string | undefined>(undefined);
  if (read.isPending) return null;
  if (read.isError || read.data === undefined) {
    return <section className="rv-wikis-upkeep" aria-label={T.UPKEEP} data-testid="wiki-setup-upkeep"><h3>{T.UPKEEP}</h3>
      <p className="rv-muted" data-testid="wiki-setup-upkeep-absent">{wikiSetupAbsent(read.error) ? T.UPKEEP_NOT_YET : fixedWikiSetupWords(read.error, T.ACT_FAILED)}</p></section>;
  }
  const upkeep = read.data;
  async function flip(on: boolean) {
    setBusy(true); setError(undefined);
    const requestId = id.current ?? crypto.randomUUID();
    id.current = requestId;
    try { query.setQueryData(wikiSetupKey(project, "upkeep"), await api.setUpkeep(project, requestId, on)); id.current = undefined; }
    catch (caught) { setError(fixedWikiSetupWords(caught, T.ACT_FAILED)); void query.invalidateQueries({ queryKey: wikiSetupKey(project, "upkeep") }); }
    finally { setBusy(false); }
  }
  return <section className="rv-wikis-upkeep" aria-label={T.UPKEEP} data-testid="wiki-setup-upkeep">
    <div className="rv-wikis-setting"><div>
      <h3>{T.UPKEEP}</h3><p className="rv-muted">{T.UPKEEP_TEXT}</p>
      <p className="rv-muted" data-testid="wiki-setup-upkeep-state">{upkeep.enabled ? T.UPKEEP_ON : T.UPKEEP_OFF}</p></div>
      {upkeep.canManage && <Switch label={T.UPKEEP} checked={upkeep.enabled} disabled={busy} onCheckedChange={(on) => { void flip(on); }} />}
    </div>
    {error !== undefined && <p role="alert" data-testid="wiki-setup-upkeep-error"><VisibleText text={error} /></p>}
    <div data-testid="wiki-setup-upkeep-limits"><h4>{T.UPKEEP_LIMITS}</h4><ul><li>{T.LIMIT_FREE}</li><li>{T.LIMIT_CAP}</li><li>{T.LIMIT_MANUAL}</li></ul></div>
    {upkeep.canManage && (companyAdmin ? <Cap project={project} /> : <p className="rv-muted" data-testid="wiki-setup-cap-ask">{T.CAP_ASK_ADMIN}</p>)}
  </section>;
}
