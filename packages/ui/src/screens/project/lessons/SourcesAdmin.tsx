// The Sources tab for a person who may edit sources (source-row lane T5): the project's sources with their controls, the changes waiting for a second person, and Add a source. Its own chunk: the tab loads it only
// when the record route returned the editors' view. The server decides every rule and every refusal; nothing here grants anything.
import { useState } from "react";
import type { SourcesAdminViewData } from "../../../api/record-sources.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { Card } from "../../../design/Card.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { SourceAdd } from "./SourceAdd.js";
import { SourceRow } from "./SourceRow.js";
import { T, expiryWords, kindWords, sourceReasonWords } from "./lessons-text.js";
import { useSourceWrite } from "./use-source-write.js";
import "./lessons.css";

type Pending = SourcesAdminViewData["pending"][number];

/** A change that waits for a second person. The one who made it sees "Waiting"; another person sees Approve and Reject; the only person who can approve (`soleApprover`) may approve their own. */
function PendingCard({ project, change, soleApprover, now, notify }: { project: string; change: Pending; soleApprover: boolean; now: number; notify: (text: string) => void }) {
 const writer = useSourceWrite(project), reasons = change.reasons.map(sourceReasonWords).filter(words => words !== "");
 const decide = async (action: "approve" | "reject") => {
  const reply = await writer.send({ action, changeId: change.changeId }, false);
  if (reply !== undefined) notify(action === "approve" ? T.SRC_APPROVED : T.SRC_REJECTED);
 };
 return <li><Card className="rv-lessons-card" aria-label={T.SRC_PENDING_CARD + ": " + kindWords(change.source) + " " + visibleText(change.scope)}>
  <h4>{T.SRC_PENDING_CARD}</h4>
  <p>{change.kind === "add" ? T.SRC_NEW : T.SRC_CHANGE}: <strong>{kindWords(change.source)}</strong> <span className="rv-muted"><VisibleText text={change.scope} /></span></p>
  {reasons.length > 0 && <p className="rv-muted">{reasons.join(", ")}</p>}
  <p className="rv-muted">{expiryWords(Date.parse(change.expiresAt), now)}</p>
  {change.proposedByYou && !soleApprover && <p><strong>{T.SRC_WAITING}</strong> {T.SRC_WAITING_FOR}</p>}
  {change.proposedByYou && soleApprover && <p>{T.SRC_SOLE}</p>}
  {(!change.proposedByYou || soleApprover) && <div className="rv-lessons-actions"><Button variant="primary" busy={writer.busy} onClick={() => { void decide("approve"); }}>{T.APPROVE}</Button>{!change.proposedByYou && <Button busy={writer.busy} onClick={() => { void decide("reject"); }}>{T.REJECT}</Button>}</div>}
  {writer.error !== undefined && <div role="alert"><p>{writer.error}</p>{writer.reauth && <Button onClick={writer.signInAgain}>{T.SRC_SIGN_IN}</Button>}</div>}
 </Card></li>;
}

export default function SourcesAdmin({ project, view }: { project: string; view: SourcesAdminViewData }) {
 const [notice, setNotice] = useState<string>(), [now] = useState(() => Date.now());
 return <section className="rv-lessons" aria-label={T.SOURCES_TITLE}>
  <Banner title={T.SOURCES_BANNER} tone="info" />
  {notice !== undefined && <p role="status">{notice}</p>}
  {view.sources.length === 0 ? <p className="rv-muted">{T.SOURCES_NONE}</p> : <ul className="rv-lessons-list" aria-label={T.SOURCES_TITLE}>{view.sources.map(row => <SourceRow key={row.kind + "|" + row.scope} project={project} row={row} offered={view.offered} skipped={view.skippedUnlinked?.[row.kind] ?? 0} notify={setNotice} />)}</ul>}
  {view.otherPaused > 0 && <p className="rv-muted">{String(view.otherPaused)} {T.SOURCE_PAUSED_OTHER}</p>}
  {view.pending.length > 0 && <section aria-label={T.SRC_PENDING} className="rv-lessons-section"><h3>{T.SRC_PENDING}</h3><ul className="rv-lessons-cards" aria-label={T.SRC_PENDING}>{view.pending.map(change => <PendingCard key={change.changeId} project={project} change={change} soleApprover={view.soleApprover} now={now} notify={setNotice} />)}</ul></section>}
  {view.clearing !== undefined && view.clearing.length > 0 && <section aria-label={T.SRC_CLEARING} className="rv-lessons-section"><h3>{T.SRC_CLEARING}</h3><ul className="rv-lessons-list" aria-label={T.SRC_CLEARING}>{view.clearing.map(place => <li key={place.source + "|" + place.scope} className="rv-lessons-source rv-muted">
   <p><strong>{kindWords(place.source)}</strong> <VisibleText text={place.scope} /></p>
   <p>{T.SRC_CLEARING_ROW}</p>
  </li>)}</ul></section>}
  <SourceAdd project={project} view={view} notify={setNotice} />
 </section>;
}
