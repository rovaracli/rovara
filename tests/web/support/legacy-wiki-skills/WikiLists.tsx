// LEGACY (test-only): the old Wiki tab's disputed-marks and unanswered-questions lists. Production draws the rebuilt pages (screens/wiki-skills-read/WikiCorrectionsReadScreen).
import { useState } from "react";
import { fixedCorrectionWords, useWikiApi, useWikiDisputed, useWikiGaps, useWikiRefresh } from "../../../../packages/ui/src/api/wiki.js";
import { Button } from "../../../../packages/ui/src/design/Button.js";
import { RelativeTime } from "../../../../packages/ui/src/design/RelativeTime.js";
import { Skeleton } from "../../../../packages/ui/src/design/Skeleton.js";
import { VisibleText } from "../../../../packages/ui/src/design/VisibleText.js";
import { Failed, useAct } from "../../../../packages/ui/src/screens/project/wiki/WikiCorrections.js";
import { T } from "../../../../packages/ui/src/screens/project/wiki/wiki-text.js";

/** The marks still open after a page was written again (maintainers): who marked what and why, with a way to close them once the code was checked. */
export function DisputedList({ project, open, back }: { project: string; open: (id: string) => void; back: () => void }) {
  const read = useWikiDisputed(project, true), api = useWikiApi(), refresh = useWikiRefresh(project), act = useAct(async () => { await refresh(); });
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  if (read.isPending) return <Skeleton label={T.DISPUTED_LOADING} />;
  if (read.isError || read.data === undefined) return <div><p role="alert" data-testid="wiki-disputed-error"><VisibleText text={fixedCorrectionWords(read.error, T.ACTION_FAILED)} /></p><Button onClick={back}>{T.DISPUTED_BACK}</Button></div>;
  const pages = new Map<string, { title: string; items: typeof read.data.items }>();
  for (const item of read.data.items) { const group = pages.get(item.pageId) ?? { title: item.pageTitle, items: [] }; group.items = [...group.items, item]; pages.set(item.pageId, group); }
  return (
    <section className="rv-wiki-art" aria-label={T.DISPUTED_TITLE} data-testid="wiki-disputed">
      <p className="rv-wiki-crumb">{T.DISPUTED}</p>
      <h2 className="rv-wiki-h1">{T.DISPUTED_TITLE}</h2>
      <p className="rv-wiki-lede">{T.DISPUTED_HINT}</p>
      <Failed error={act.error} />
      {read.data.more && <p className="rv-wiki-who" data-testid="wiki-disputed-more">{T.DISPUTED_MORE}</p>}
      {closed.size > 0 && <p role="status" className="rv-wiki-who" data-testid="wiki-disputed-closed">{T.DISPUTED_RESOLVED}</p>}
      {pages.size === 0 && <p className="rv-wiki-lede" data-testid="wiki-disputed-empty">{T.DISPUTED_NONE}</p>}
      {[...pages.entries()].map(([pageId, group]) => (
        <div key={pageId} className="rv-wiki-tnote" role="group" aria-label={group.title} data-page={pageId}>
          <b><VisibleText text={group.title} /></b>
          <ul>{group.items.map((item) => (
            <li key={item.flagId}>
              {item.claimText !== undefined ? <VisibleText text={item.claimText} /> : <>The whole page</>}
              <span className="rv-wiki-who"> Marked by <VisibleText text={item.markedBy} />, <RelativeTime at={item.markedAt} />.{item.reason !== undefined && <> Reason: <VisibleText text={item.reason} /></>}</span>
            </li>
          ))}</ul>
          <div className="rv-wiki-row">
            <Button onClick={() => { open(pageId); }}>{T.DISPUTED_OPEN}</Button>
            <Button variant="primary" busy={act.busy} onClick={() => { void act.run(async () => { await api.resolveMarks(project, pageId); setClosed(new Set([...closed, pageId])); }); }}>{T.DISPUTED_RESOLVE}</Button>
          </div>
        </div>
      ))}
      <div className="rv-wiki-row"><Button onClick={back}>{T.DISPUTED_BACK}</Button></div>
    </section>
  );
}

/** The questions the wiki could not answer (maintainers): topics with how many different people asked and the day it was last asked. Nobody is named; the words are drawn as plain text. */
export function GapsList({ project, back }: { project: string; back: () => void }) {
  const read = useWikiGaps(project, true);
  if (read.isPending) return <Skeleton label={T.GAPS_LOADING} />;
  if (read.isError || read.data === undefined) return <div><p role="alert" data-testid="wiki-gaps-error"><VisibleText text={fixedCorrectionWords(read.error, T.ACTION_FAILED)} /></p><Button onClick={back}>{T.GAPS_BACK}</Button></div>;
  return (
    <section className="rv-wiki-art" aria-label={T.GAPS_TITLE} data-testid="wiki-gaps">
      <p className="rv-wiki-crumb">{T.GAPS}</p>
      <h2 className="rv-wiki-h1">{T.GAPS_TITLE}</h2>
      <p className="rv-wiki-lede">{T.GAPS_HINT}</p>
      {read.data.more && <p className="rv-wiki-who" data-testid="wiki-gaps-more">{T.GAPS_MORE}</p>}
      {read.data.items.length === 0 && <p className="rv-wiki-lede" data-testid="wiki-gaps-empty">{T.GAPS_NONE}</p>}
      <ul>{read.data.items.map((item, index) => (
        <li key={`${String(index)}:${item.topic}`} data-kind={item.kind}>
          <b><VisibleText text={item.topic} /></b>
          <span className="rv-wiki-who"> {Object.hasOwn(T.GAPS_KIND, item.kind) ? T.GAPS_KIND[item.kind] : item.kind}. Asked by {String(item.people)} {item.people === 1 ? "person" : "people"}, {String(item.questions)} {item.questions === 1 ? "time" : "times"}; last on <VisibleText text={item.lastAskedAt} />.</span>
        </li>
      ))}</ul>
      <div className="rv-wiki-row"><Button onClick={back}>{T.GAPS_BACK}</Button></div>
    </section>
  );
}
