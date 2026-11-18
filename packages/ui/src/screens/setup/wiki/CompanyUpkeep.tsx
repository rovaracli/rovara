// "Nightly upkeep for the company" (L4-P3, owner 2026-11-17): the company's one control, for owners and admins (the page that shows it decides who sees it; Code decides again). It says whether nightly upkeep is allowed
// for the company and, when it is, offers Withdraw with ONE confirm ("Nightly runs stop for every project now. Projects keep their switch."). Withdrawing needs no fresh sign-in. Allowing happens on a project's
// setup page (the offer there), which is where a person says what runs and what it costs; this control only withdraws. Every sentence is one of the fixed wiki sentences.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fixedWikiSetupWords, systemRunsKey, useWikiSetupApi, wikiSetupAbsent } from "../../../api/wiki-setup.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { T } from "./wiki-setup-text.js";

export function CompanyUpkeep() {
  const api = useWikiSetupApi(), query = useQueryClient();
  const read = useQuery({ queryKey: systemRunsKey, queryFn: () => api.systemRuns(), retry: false, gcTime: 0, refetchOnWindowFocus: false });
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState(false);
  const id = useRef<string | undefined>(undefined), group = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), cancelled = useRef(false);
  // Focus follows the person: into the confirm when it opens, back to Withdraw when it is cancelled.
  useEffect(() => { if (asking) group.current?.focus(); else if (cancelled.current) { cancelled.current = false; button.current?.focus(); } }, [asking]);
  const frame = (children: React.ReactNode) => <section className="rv-wikis-upkeep" aria-label={T.COMPANY_TITLE} data-testid="company-upkeep">{children}</section>;
  if (read.isPending) return frame(<Skeleton label="Loading nightly upkeep for the company" />);
  if (read.isError || read.data === undefined) {
    return frame(<p className="rv-muted" data-testid="company-upkeep-absent">{wikiSetupAbsent(read.error) ? T.COMPANY_NOT_AVAILABLE : fixedWikiSetupWords(read.error, T.COMPANY_UNREADABLE)}</p>);
  }
  const view = read.data;
  async function withdraw() {
    setBusy(true); setError(undefined); setDone(false);
    const requestId = id.current ?? crypto.randomUUID();
    id.current = requestId;
    try {
      const answer = await api.setSystemRuns(requestId, false);
      query.setQueryData(systemRunsKey, answer);
      // The project pages read the company's choice too: they must not keep showing the old answer.
      void query.invalidateQueries({ queryKey: ["wiki-setup"] });
      id.current = undefined; setAsking(false); setDone(true);
    } catch (caught) { setError(fixedWikiSetupWords(caught, T.ACT_FAILED)); void query.invalidateQueries({ queryKey: systemRunsKey }); }
    finally { setBusy(false); }
  }
  return frame(<>
    <p data-testid="company-upkeep-state">{T.COMPANY_TITLE}: <b>{view.allowed ? T.COMPANY_ALLOWED : T.COMPANY_NOT_ALLOWED}</b>{view.allowed && !view.available ? ` (${T.COMPANY_NOT_AVAILABLE})` : ""}</p>
    {view.allowed && !asking && <Button ref={button} data-testid="company-upkeep-withdraw" onClick={() => { setAsking(true); setDone(false); }}>{T.COMPANY_WITHDRAW}</Button>}
    {view.allowed && asking && <div ref={group} tabIndex={-1} className="rv-wikis-controls" role="group" aria-label={T.COMPANY_WITHDRAW} data-testid="company-upkeep-confirm">
      <p>{T.COMPANY_WITHDRAW_ASK}</p>
      <div className="rv-wikis-actions">
        <Button variant="primary" busy={busy} data-testid="company-upkeep-yes" onClick={() => { void withdraw(); }}>{T.COMPANY_WITHDRAW_YES}</Button>
        <Button disabled={busy} data-testid="company-upkeep-no" onClick={() => { cancelled.current = true; setAsking(false); }}>{T.CANCEL}</Button>
      </div>
    </div>}
    {!view.allowed && <p className="rv-muted" data-testid="company-upkeep-allow-where">{done ? T.COMPANY_WITHDRAWN : T.COMPANY_ALLOW_WHERE}</p>}
    {error !== undefined && <p role="alert" data-testid="company-upkeep-error"><VisibleText text={error} /></p>}
  </>);
}
