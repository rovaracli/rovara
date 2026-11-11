import { useEffect, useRef, useState } from "react";
import { SettingsNote } from "../SettingsNote.js";
import { ApiError } from "../../../api/errors.js";
import { useCompanyRules } from "../../../api/company-rules.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { APPROVAL_WORDS, T } from "./company-rules-text.js";
import { formatDay } from "./format.js";
import { HistorySection } from "./HistorySection.js";
import { PendingProposal } from "./PendingProposal.js";
import { RulesList } from "./parts.js";
import { RulesEditor } from "./RulesEditor.js";
import { toRules } from "./rules-logic.js";
import { SyncSection } from "./SyncSection.js";
import type { State } from "./types.js";
import "./company-rules.css";

function CurrentRules({ state }: { state: State }) {
 const current = state.current;
 return <section aria-labelledby="cr-current" className="rv-cr-card"><h2 id="cr-current">{T.CURRENT_HEADING}</h2>
  {current === null ? <p>{T.NONE_YET}</p> : <>
   <p><strong>Version {current.version}</strong>{current.approvedBy === undefined ? "" : <>, approved by <VisibleText text={current.approvedBy.name} /></>} on {formatDay(current.approvedAt)}.
    {current.approvalMode !== undefined && <> {(APPROVAL_WORDS as Record<string, string>)[current.approvalMode] ?? ""}</>}</p>
   {typeof current.note === "string" && current.note !== "" && <p><strong>{T.NOTE}:</strong> <VisibleText text={current.note} /></p>}
   {current.rules.length === 0 ? <p>{T.NONE_YET}</p> : <RulesList rules={toRules(current.rules)} label="Current rules" />}
  </>}
 </section>;
}

/**
 * Settings > Company rules (lane exp/company-rules; behind the Standing instructions switch `si`): the company's standing instructions for every agent. Owners and admins read the current version, propose a change (a second admin
 * approves it), see what waits, read the history and connect an optional repository file. Everyone the server lets read sees the current version only. Everything the server decides (who may, what a refusal says) comes from it;
 * this screen shows the answer, sends one press and reads again. With the switch off the server answers 404 and the page says so.
 */
export function CompanyRulesScreen() {
 const read = useCompanyRules(), [notice, setNotice] = useState(""), noticeNode = useRef<HTMLParagraphElement>(null);
 // A done-sentence outlives the section that sent it (an approved proposal's section is gone the moment it is approved), so it shows here, and comes into view.
 useEffect(() => { if (notice !== "") noticeNode.current?.scrollIntoView({ block: "nearest" }); }, [notice]);
 if (read.isPending) return <section aria-label={T.TITLE} aria-busy="true"><Skeleton label="Loading the company rules" /></section>;
 if (read.error instanceof ApiError && read.error.status === 404) return <section><PageHeader focusOnMount title={T.TITLE} description={T.INTRO} /><SettingsNote area="company-rules" /><p role="status">{T.SWITCHED_OFF}</p></section>;
 if (read.data === undefined) return <section><PageHeader focusOnMount title={T.TITLE} /><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : T.LOAD_FAILED} /></p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></section>;
 const state: State = read.data, reader = state.viewer.role === "owner" || state.viewer.role === "admin";
 return <section aria-label={T.TITLE} className="rv-cr"><PageHeader focusOnMount title={T.TITLE} description={T.INTRO} />
  <p role="status" ref={noticeNode} className="rv-cr-notice" data-empty={notice === "" || undefined}>{notice}</p>
  <SettingsNote area="company-rules" />
  <p className="rv-cr-rank"><strong>{T.RANK_HEADING}.</strong> {T.RANK}</p>
  <CurrentRules state={state} />
  {state.pending !== null && <PendingProposal state={state} proposal={state.pending} onStatus={setNotice} />}
  <RulesEditor state={state} onStatus={setNotice} />
  <HistorySection enabled={reader} />
  <SyncSection state={state} onStatus={setNotice} />
 </section>;
}
