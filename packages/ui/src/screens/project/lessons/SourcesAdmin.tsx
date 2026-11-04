// The Sources tab for a person who may edit sources (source-row lane T5): the project's sources with their controls, the sources being removed, and Add a source. Every change applies at once (no second person).
// Its own chunk: the tab loads it only
// when the record route returned the editors' view. The server decides every rule and every refusal; nothing here grants anything.
import { useState } from "react";
import type { SourcesAdminViewData } from "../../../api/record-sources.js";
import { Banner } from "../../../design/Banner.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SourceAdd } from "./SourceAdd.js";
import { SourceRow } from "./SourceRow.js";
import { T, kindWords } from "./lessons-text.js";
import "./lessons.css";

export default function SourcesAdmin({ project, view }: { project: string; view: SourcesAdminViewData }) {
 const [notice, setNotice] = useState<string>();
 return <section className="rv-lessons" aria-label={T.SOURCES_TITLE}>
  <Banner title={T.SOURCES_BANNER} tone="info" />
  {notice !== undefined && <p role="status">{notice}</p>}
  {view.sources.length === 0 ? <p className="rv-muted">{T.SOURCES_NONE}</p> : <ul className="rv-lessons-list" aria-label={T.SOURCES_TITLE}>{view.sources.map(row => <SourceRow key={row.kind + "|" + row.scope} project={project} row={row} offered={view.offered} skipped={view.skippedUnlinked?.[row.kind] ?? 0} notesSwitch={view.notesSwitch === true} notify={setNotice} />)}</ul>}
  {view.otherPaused > 0 && <p className="rv-muted">{String(view.otherPaused)} {T.SOURCE_PAUSED_OTHER}</p>}
  {view.clearing !== undefined && view.clearing.length > 0 && <section aria-label={T.SRC_CLEARING} className="rv-lessons-section"><h3>{T.SRC_CLEARING}</h3><ul className="rv-lessons-list" aria-label={T.SRC_CLEARING}>{view.clearing.map(place => <li key={place.source + "|" + place.scope} className="rv-lessons-source rv-muted">
   <p><strong>{kindWords(place.source)}</strong> <VisibleText text={place.scope} /></p>
   <p>{T.SRC_CLEARING_ROW}</p>
  </li>)}</ul></section>}
  <SourceAdd project={project} view={view} notify={setNotice} />
 </section>;
}
