// "Nightly upkeep" (setup-upkeep-plan.md decision 2; lead 4 W6): the ONE switch, off by default, and its monthly cap. The switch is Code's (a seam the nightly runner supplies: until Code serves it this says so and
// draws no dead switch). The cap is a spend limit of the company (`upkeep_month`, L4-E): a company owner or admin reads and changes it here with the same body the Spending page sends; the server decides
// who may raise it (this page only asks). Anyone else is told who sets it. The panel says which limit each part uses.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UPKEEP_PAUSE_SENTENCES } from "@agentx/contracts/web";
import { fixedWikiSetupWords, parseUsd, readUpkeepCap, useWikiSetupApi, wikiSetupAbsent, wikiSetupKey, type UpkeepCap, type WikiSetupUpkeepCap, type WikiSetupUpkeepSpend } from "../../../api/wiki-setup.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { Money } from "../../../design/Money.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { CAP_SENTENCES, T } from "./wiki-setup-text.js";

function CapField({ project, cap, onSaved, onEdit }: { project: string; cap: UpkeepCap; onSaved: () => void; onEdit: () => void }) {
  const api = useWikiSetupApi();
  const [text, setText] = useState(cap.usd === null ? "" : cap.usd.toFixed(2)), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const typed = parseUsd(text);
  async function save() {
    if (typed === undefined) { setError(T.CAP_INVALID); return; }
    setBusy(true); setError(undefined); onEdit();
    try { await api.capWrite(project, cap.version, typed); onSaved(); }
    catch (caught) {
      setError(caught instanceof ApiError && CAP_SENTENCES.has(caught.message) ? caught.message : T.CAP_FAILED);
    } finally { setBusy(false); }
  }
  return <div className="rv-wikis-cap" data-testid="wiki-setup-cap">
    <TextField label={T.CAP} hint={T.CAP_HINT} inputMode="decimal" value={text} onChange={(event) => { setText(event.target.value); onEdit(); setError(undefined); }} />
    <p className="rv-muted">{cap.usd === null ? T.CAP_NONE : <>Now: <Money usd={cap.usd} /> a month. </>}{cap.own ? T.CAP_OWN : T.CAP_DEFAULT}</p>
    <Button busy={busy} disabled={text.trim() === ""} data-testid="wiki-setup-cap-save" onClick={() => { void save(); }}>{T.CAP_SAVE}</Button>
    {error !== undefined && <p role="alert" data-testid="wiki-setup-cap-error"><VisibleText text={error} /></p>}
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

/** Spending limits is where the company's caps live (company owners and admins only); only a person Code says can raise the cap gets the link. */
const SPENDING_LIMITS_ROUTE = "/app/admin/money/limits";

/** The monthly cap as Code states it: its number, or (Code has no read) "set in Spending limits"; never a figure of ours. */
function CapLine({ cap }: { cap: WikiSetupUpkeepCap | undefined }) {
  const monthlyUsd = cap?.monthlyUsd ?? null, canRaise = cap?.canRaise === true;
  return <p className="rv-muted" data-testid="wiki-setup-upkeep-cap-line">{monthlyUsd === null
    ? <>{T.CAP_LINE_UNSET} {canRaise ? <Link to={SPENDING_LIMITS_ROUTE}>{T.CAP_LINK_LIMITS}</Link> : T.CAP_LINK_LIMITS}.</>
    : <>{T.CAP_LINE_SET} <Money usd={monthlyUsd} />. {canRaise && <Link to={SPENDING_LIMITS_ROUTE}>{T.CAP_LINK_RAISE}</Link>}</>}</p>;
}

/**
 * L4-CAPR: what nightly upkeep spent this month against the cap, for people who manage the project (the server sends it to no one else). A run whose cost Code could not state adds nothing to the dollars, so the
 * line says "at least" and counts those runs in words; the cap is Code's number from the gateway, and when it states none the line says only what was spent.
 */
function SpendLine({ spend, cap }: { spend: WikiSetupUpkeepSpend; cap: WikiSetupUpkeepCap | undefined }) {
  const monthlyUsd = cap?.monthlyUsd ?? null, unknown = spend.unknownRuns;
  // The line says "this month": a total for another UTC month (a stale answer across a month change) is not drawn.
  if (spend.month !== new Date().toISOString().slice(0, 7)) return null;
  // Under half a cent would read as "$0.00", which says nothing ran: it says what it is.
  const tiny = spend.spentUsd > 0 && spend.spentUsd < 0.005;
  return <p className="rv-muted" data-testid="wiki-setup-upkeep-spend">{T.SPEND_LINE} {unknown > 0 && <>{T.SPEND_AT_LEAST} </>}{tiny ? T.SPEND_TINY : <Money usd={spend.spentUsd} />}{monthlyUsd !== null && <> {T.SPEND_OF} <Money usd={monthlyUsd} /></>}
    {unknown > 0 && <span data-testid="wiki-setup-upkeep-spend-unknown"> ({String(unknown)} {unknown === 1 ? "run" : "runs"} with unknown cost)</span>}</p>;
}

/** The setup choice (company owners and admins): one button, then one confirm that says what runs and what the cap is. Yes sends the company's consent and the project switch in one act. */
function Offer({ cap, busy, onYes }: { cap: WikiSetupUpkeepCap | undefined; busy: boolean; onYes: () => void }) {
  const [asking, setAsking] = useState(false), group = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), cancelled = useRef(false);
  // Focus follows the person: into the confirm when it opens, back to the choice when it is cancelled.
  useEffect(() => { if (asking) group.current?.focus(); else if (cancelled.current) { cancelled.current = false; button.current?.focus(); } }, [asking]);
  if (!asking) return <Button ref={button} variant="primary" data-testid="wiki-setup-upkeep-offer" onClick={() => { setAsking(true); }}>{T.OFFER_BUTTON}</Button>;
  return <div ref={group} tabIndex={-1} className="rv-wikis-controls" role="group" aria-label={T.OFFER_TITLE} data-testid="wiki-setup-upkeep-confirm">
    <p>{T.OFFER_CONFIRM_LINE}</p>
    <CapLine cap={cap} />
    <p>{T.OFFER_CONFIRM_ASK}</p>
    <div className="rv-wikis-actions">
      <Button variant="primary" busy={busy} data-testid="wiki-setup-upkeep-yes" onClick={onYes}>{T.OFFER_YES}</Button>
      <Button disabled={busy} data-testid="wiki-setup-upkeep-no" onClick={() => { cancelled.current = true; setAsking(false); }}>{T.CANCEL}</Button>
    </div>
  </div>;
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
  // DEC 254zzl P0: until Code says its nightly runs are available, the switch, its state and the cap stay hidden (no dead control).
  if (upkeep.available !== true) {
    return <section className="rv-wikis-upkeep" aria-label={T.UPKEEP} data-testid="wiki-setup-upkeep"><h3>{T.UPKEEP}</h3>
      <p className="rv-muted" data-testid="wiki-setup-upkeep-absent">{T.UPKEEP_NOT_YET}</p></section>;
  }
  async function send(on: boolean, allowSystemRuns?: boolean) {
    setBusy(true); setError(undefined);
    const requestId = id.current ?? crypto.randomUUID();
    id.current = requestId;
    try { { const answer = await api.setUpkeep(project, requestId, on, allowSystemRuns); query.setQueryData(wikiSetupKey(project, "upkeep"), { ...answer, available: answer.available ?? true }); } id.current = undefined; }
    catch (caught) {
      setError(fixedWikiSetupWords(caught, T.ACT_FAILED)); void query.invalidateQueries({ queryKey: wikiSetupKey(project, "upkeep") });
    }
    finally { setBusy(false); }
  }
  // L4-W6b (DEC 254zzt option A, two locks): `systemRunsOn` is what really runs (the operator's ceiling AND the company's consent). Absent: a Code with the project switch only, shown as before.
  const gated = upkeep.systemRunsOn !== undefined, consent = upkeep.systemRunsOn === true;
  // Rule #14 and the same gate as Build: a control is drawn only for a person Code says may manage the project, and only from a read that is current.
  const fresh = !read.isError && read.failureCount === 0;
  const offer = gated && !consent && upkeep.canEnableSystemRuns === true && upkeep.canManage && fresh;
  const needsAdmin = gated && !consent && !offer && upkeep.canManage;
  const settled = !gated || consent;
  // The project's own switch counts only while system runs are on: with the company's consent off nothing runs, whatever the project switch says.
  const running = upkeep.enabled && settled;
  return <section className="rv-wikis-upkeep" aria-label={T.UPKEEP} data-testid="wiki-setup-upkeep">
    <div className="rv-wikis-setting"><div>
      <h3>{T.UPKEEP}</h3><p className="rv-muted">{T.UPKEEP_TEXT}</p>
      <p className="rv-muted" data-testid="wiki-setup-upkeep-state">{running ? T.UPKEEP_ON : T.UPKEEP_OFF}</p>
      {upkeep.canManage && upkeep.spend !== undefined && <SpendLine spend={upkeep.spend} cap={upkeep.cap} />}</div>
      {upkeep.canManage && fresh && settled && <Switch label={T.UPKEEP} checked={upkeep.enabled} disabled={busy} onCheckedChange={(on) => { void send(on); }} />}
    </div>
    {/* L4-U5: the admins' notice, on the page: why nightly upkeep is paused now (Code tells managers only), in the same fixed sentence the chat and the email carry. Silent when it is not paused. */}
    {upkeep.paused !== undefined && <div role="status" className="rv-wikis-paused" data-testid="wiki-setup-upkeep-paused"><p>{UPKEEP_PAUSE_SENTENCES[upkeep.paused.reason]}</p>{upkeep.cap?.canRaise === true && <p><Link to="/app/admin/money/limits">{T.CAP_LINK_RAISE}</Link></p>}</div>}
    {offer && <Offer cap={upkeep.cap} busy={busy} onYes={() => { void send(true, true); }} />}
    {needsAdmin && <p className="rv-muted" data-testid="wiki-setup-upkeep-needs-admin">{T.NEEDS_ADMIN}</p>}
    {error !== undefined && <p role="alert" data-testid="wiki-setup-upkeep-error"><VisibleText text={error} /></p>}
    {companyAdmin && gated && consent && <p className="rv-muted" data-testid="wiki-setup-upkeep-company-link">{T.COMPANY_LINK_LINE} <Link to="/app/admin/settings">{T.COMPANY_LINK}</Link>.</p>}
    {settled && <div data-testid="wiki-setup-upkeep-limits"><h4>{T.UPKEEP_LIMITS}</h4><ul><li>{T.LIMIT_FREE}</li><li>{T.LIMIT_CAP}</li><li>{T.LIMIT_MANUAL}</li></ul></div>}
    {settled && upkeep.canManage && (companyAdmin ? <Cap project={project} /> : <p className="rv-muted" data-testid="wiki-setup-cap-ask">{T.CAP_ASK_ADMIN}</p>)}
  </section>;
}
