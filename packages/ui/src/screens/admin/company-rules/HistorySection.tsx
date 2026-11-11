// History: every approved version (newest first) with who proposed and approved it and when, the proposals that did not become a version, and a view of any one version with what it changed. Owners and admins only; the server says no to anyone else.
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../api/errors.js";
import { useCompanyRulesApi, useCompanyRulesHistory, useCompanyRulesVersion } from "../../../api/company-rules.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { APPROVAL_WORDS, DECIDED_WORDS, SOURCE_WORDS, T } from "./company-rules-text.js";
import { formatDay, formatWhen, Person } from "./format.js";
import { DiffView, RulesList } from "./parts.js";
import { summaryWords, toDiff, toRules } from "./rules-logic.js";
import type { History } from "./types.js";

type Entry = History["entries"][number];
function VersionView({ version, onClose }: { version: number; onClose: () => void }) {
 const read = useCompanyRulesVersion(version), heading = useRef<HTMLHeadingElement>(null);
 useEffect(() => { heading.current?.focus(); }, [version]);
 const body = read.isPending ? <Skeleton label="Loading this version" /> : read.data === undefined ? <p role="alert">{read.error instanceof ApiError ? read.error.message : T.VERSION_LOAD_FAILED}</p> : <>
  <p><VersionLine version={read.data.version} /></p>
  <h4>{T.FROM_PREVIOUS}</h4><DiffView diff={toDiff(read.data.diffFromPrevious)} label={`Changes in version ${String(version)}`} />
  <h4>The rules in this version</h4><RulesList rules={toRules(read.data.version.rules)} label={`Version ${String(version)} rules`} />
 </>;
 return <div className="rv-cr-version" role="region" aria-labelledby="cr-version-heading"><h3 id="cr-version-heading" ref={heading} tabIndex={-1}>Version {version}</h3>{body}<Button onClick={onClose}>{T.CLOSE_VERSION}</Button></div>;
}
function VersionLine({ version }: { version: { approvedAt: string; approvedBy?: { name: string } | undefined; proposedBy?: { name: string } | undefined; approvalMode?: string | undefined; source?: string | undefined } }) {
 const mode = version.approvalMode === undefined ? undefined : (APPROVAL_WORDS as Record<string, string>)[version.approvalMode];
 return <>{version.proposedBy !== undefined && <>Proposed by <VisibleText text={version.proposedBy.name} />. </>}{version.approvedBy !== undefined && <>Approved by <VisibleText text={version.approvedBy.name} /> on {formatDay(version.approvedAt)}. </>}{version.approvedBy === undefined && <>Approved on {formatDay(version.approvedAt)}. </>}{mode !== undefined && mode + " "}{version.source !== undefined && <>Source: {SOURCE_WORDS[version.source] ?? "Rovara"}.</>}</>;
}

export function HistorySection({ enabled }: { enabled: boolean }) {
 const api = useCompanyRulesApi(), first = useCompanyRulesHistory(enabled);
 const [older, setOlder] = useState<History[]>([]), [loadingOlder, setLoadingOlder] = useState(false), [olderError, setOlderError] = useState<string>(), [open, setOpen] = useState<number>();
 if (!enabled) return null;
 const pages = first.data === undefined ? [] : [first.data, ...older], last = pages.at(-1);
 const entries: Entry[] = pages.flatMap(page => page.entries);
 async function loadOlder() {
  if (last?.nextBefore === null || last?.nextBefore === undefined) return;
  setLoadingOlder(true);setOlderError(undefined);
  try { const page = await api.history(last.nextBefore);setOlder(previous => [...previous, page]); }
  catch (error) { setOlderError(error instanceof ApiError ? error.message : T.HISTORY_LOAD_FAILED); }
  finally { setLoadingOlder(false); }
 }
 return <section aria-labelledby="cr-history" className="rv-cr-card" aria-busy={first.isFetching}><h2 id="cr-history">{T.HISTORY_HEADING}</h2>
  {first.isPending ? <Skeleton label="Loading the history" /> : first.data === undefined ? <p role="alert">{first.error instanceof ApiError ? first.error.message : T.HISTORY_LOAD_FAILED}</p> : <>
   {entries.length === 0 ? <p>{T.HISTORY_NONE}</p> : <ul className="rv-cr-history">{entries.map(entry => <li key={entry.version}>
    <h3>Version {entry.version}</h3>
    <p>Approved {formatDay(entry.approvedAt)} by <Person person={entry.approvedBy} />. Proposed by <Person person={entry.proposedBy} />. {entry.ruleCount} {entry.ruleCount === 1 ? "rule" : "rules"}.</p>
    <p className="rv-muted">{(APPROVAL_WORDS as Record<string, string>)[entry.approvalMode] ?? ""} Source: {SOURCE_WORDS[entry.source] ?? "Rovara"}. {summaryWords(entry.summary)}.</p>
    <Button aria-label={`View version ${String(entry.version)}`} aria-expanded={open === entry.version} onClick={() => { setOpen(open === entry.version ? undefined : entry.version); }}>{T.VIEW}</Button>
    {open === entry.version && <VersionView version={entry.version} onClose={() => { setOpen(undefined); }} />}
   </li>)}</ul>}
   {last?.nextBefore !== null && last?.nextBefore !== undefined && <div><Button busy={loadingOlder} onClick={() => { void loadOlder(); }}>{T.HISTORY_OLDER}</Button></div>}
   {olderError !== undefined && <p role="alert"><VisibleText text={olderError} /></p>}
   <p className="rv-muted">{T.NOTE_NOT_KEPT}</p>
   {first.data.decided.length > 0 && <><h3>{T.DECIDED_HEADING}</h3><ul className="rv-cr-history">{first.data.decided.map(item => <li key={item.proposalId}>
    <p><strong>{DECIDED_WORDS[item.state] ?? "Closed"}</strong> {formatWhen(item.decidedAt)}{item.decidedBy === null ? "" : " by "}{item.decidedBy !== null && <Person person={item.decidedBy} />}. Proposed by <Person person={item.proposedBy} /> on {formatDay(item.proposedAt)}. Source: {SOURCE_WORDS[item.source] ?? "Rovara"}.</p>
   </li>)}</ul></>}
  </>}
 </section>;
}
