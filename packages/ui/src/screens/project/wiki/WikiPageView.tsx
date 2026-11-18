// One wiki page: title, one meta line (who wrote it, as of which commit, one freshness chip), the summary, pinned notes, the "Relevant source files" fold, the text with its
// numbered sources, and one footer line. The right rail holds "On this page" and "About this page". Read only: Mark wrong and notes are C1's writes (not here until wired).
import { useEffect, useMemo, useRef, useState } from "react";
import { fixedWikiWords, useWikiCorrections, useWikiPage, useWikiSources, type WikiIndexEntry, type WikiPageResponse } from "../../../api/wiki.js";
import { ApiError } from "../../../api/errors.js";
import { useProject } from "../../../api/projects.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { RelativeTime } from "../../../design/RelativeTime.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { Block, type BlockMarking } from "./WikiBlocks.js";
import { MarkForm, PageMark, PageNotes, viewOf } from "./WikiCorrections.js";
import { TeamLessons } from "../lessons/TeamLessons.js";
import { hostLink, modelOf, type PageModel } from "./wiki-model.js";
import { T, chipOf, crumbOf, linesWords, shortSha } from "./wiki-text.js";

const headingId = (blockId: string) => `rv-wiki-h-${blockId}`;
const counts = (res: WikiPageResponse) => ({ found: res.page.claims.filter((c) => c.source === "found").length, changed: res.page.claims.filter((c) => c.source === "changed").length });

function Chip({ res }: { res: WikiPageResponse }) {
  const chip = chipOf(counts(res));
  return <span className={`rv-wiki-chip rv-wiki-chip-${chip.tone}`}>{chip.short}</span>;
}

function Sources({ project, id, commits, links }: { project: string; id: string; commits: ReadonlyMap<string, string>; links: (cite: { repo: string; path: string; commit: string; line: number; lineEnd?: number }) => string | undefined }) {
  const [open, setOpen] = useState(false);
  const read = useWikiSources(project, id, open);
  // A cited file at a commit the page was not written from is not shown (the sources answer cannot be checked against the page on the server).
  const files = (read.data?.files ?? []).filter((file) => commits.get(file.repo) === file.commit);
  return (
    <details className="rv-wiki-srcs" onToggle={(event) => { setOpen(event.currentTarget.open); }}>
      <summary>{T.SOURCES}{read.data !== undefined && <span className="rv-muted"> ({files.length})</span>}</summary>
      {open && read.isPending && <Skeleton label={T.SOURCES_LOADING} />}
      {open && read.isError && <p role="alert" className="rv-wiki-pad"><VisibleText text={fixedWikiWords(read.error, T.SOURCES_FAILED)} /></p>}
      {read.data !== undefined && (
        <ol>{files.map((file, at) => {
          const first = file.ranges[0], link = first === undefined ? undefined : links({ repo: file.repo, path: file.path, commit: file.commit, line: first.line, ...(first.lineEnd === undefined ? {} : { lineEnd: first.lineEnd }) });
          return (
            <li key={`${String(at)}/${file.repo}/${file.path}`}>
              <span className="rv-wiki-srcrow"><VisibleText text={`${file.repo}/${file.path}`} /> <i>{file.ranges.map((r) => linesWords(r.line, r.lineEnd)).join(", ")} at {shortSha(file.commit)}</i></span>
              {link !== undefined && <> <a href={link} target="_blank" rel="noopener noreferrer">{T.SOURCE_OPEN}</a></>}
            </li>
          );
        })}</ol>
      )}
    </details>
  );
}

export function Rail({ res, model, onJump }: { res: WikiPageResponse; model: PageModel; onJump: (blockId: string) => void }) {
  const chip = chipOf(counts(res));
  return (
    <aside className="rv-wiki-rail" aria-label={T.ABOUT}>
      {model.outline.length > 0 && (
        <nav className="rv-wiki-outline" aria-label={T.ON_PAGE}>
          <p className="rv-wiki-raillab">{T.ON_PAGE}</p>
          <ul>{model.outline.map((item) => <li key={item.blockId}><button type="button" onClick={() => { onJump(item.blockId); }}><VisibleText text={item.text} /></button></li>)}</ul>
        </nav>
      )}
      <div className="rv-wiki-about">
        <p className="rv-wiki-raillab">{T.ABOUT}</p>
        <p>{res.trustLine}</p>
        <dl>{res.page.repos.map((one) => <div key={one.repo}><dt><VisibleText text={one.repo} /></dt><dd><code>{shortSha(one.commit)}</code></dd></div>)}</dl>
        <p>Written <RelativeTime at={res.page.writtenAt} /></p>
        <p><Chip res={res} /></p>
        <p>{chip.long}</p>
        <dl><div><dt>Sources</dt><dd>{model.cites.length}</dd></div>{res.openFlags > 0 && <div><dt>Marked wrong</dt><dd>{res.openFlags}</dd></div>}</dl>
      </div>
    </aside>
  );
}

/** `focusTitle`: the person just opened this page from the tree, a link or a search result, so its title takes focus (a page shown as the tab opens does not steal it). */
export function WikiPageView({ project, id, entry, pages, focusTitle }: { project: string; id: string; entry: WikiIndexEntry; pages: readonly WikiIndexEntry[]; focusTitle: boolean }) {
  const read = useWikiPage(project, id), overview = useProject(project), corrections = useWikiCorrections(project, id), [marking, setMarking] = useState<string | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null), focused = useRef(false);
  const res = read.data;
  useEffect(() => {
    if (!focusTitle || focused.current || res === undefined || res.page.pageId !== id) return;
    focused.current = true;
    heading.current?.focus();
  }, [focusTitle, id, res]);
  const model = useMemo(() => (res === undefined ? undefined : modelOf(res)), [res]);
  if (read.isPending) return <div data-testid="wiki-page-loading"><Skeleton label={T.LOADING_PAGE} /></div>;
  if (read.isError || res === undefined || model === undefined) {
    const gone = read.error instanceof ApiError && read.error.status === 404;
    return <div><p role="alert" data-testid="wiki-page-error"><VisibleText text={fixedWikiWords(read.error, gone ? T.NO_PAGE : T.UNAVAILABLE)} /></p>{!gone && <Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button>}</div>;
  }
  const repositories = overview.data?.project.repositories ?? [];
  const link = (cite: Parameters<typeof hostLink>[1]) => hostLink(repositories, cite);
  const chip = chipOf(counts(res));
  const only = res.page.repos.length === 1 ? res.page.repos[0] : undefined;
  // Corrections: every control comes from what Code says this person may do. A read that failed (or is still running) shows the page with no controls, never a button that would be refused.
  const view = viewOf(corrections.data), flaggedClaims = new Map(res.page.claims.map((claim) => [claim.claimId, claim.flagged] as const));
  const toMark = (block: (typeof res.page.blocks)[number]) => (block.kind === "heading" ? [] : block.claimIds.filter((claimId) => flaggedClaims.get(claimId) === false));
  const markingContext: BlockMarking | undefined = view?.you.markWrong === true ? {
    markable: (block) => toMark(block).length > 0, open: marking, start: setMarking,
    form: (block) => <MarkForm project={project} id={id} claimIds={toMark(block)} onDone={() => { setMarking(undefined); }} />,
  } : undefined;
  const context = { model, link, headingId, marking: markingContext };
  const jump = (blockId: string) => { document.getElementById(headingId(blockId))?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  return (
    <div className="rv-wiki-wrap">
      <article className="rv-wiki-art" data-testid="wiki-page" data-page={res.page.pageId} aria-labelledby="rv-wiki-title">
        <p className="rv-wiki-crumb"><VisibleText text={crumbOf(entry, pages)} /></p>
        <h2 id="rv-wiki-title" className="rv-wiki-h1" tabIndex={-1} ref={heading}><VisibleText text={res.page.title} /></h2>
        <p className="rv-wiki-meta" data-testid="wiki-meta">
          <span>{T.WRITTEN_BY}</span><span aria-hidden="true" className="rv-wiki-sep">|</span>
          <span>{only !== undefined ? <>as of <code>{shortSha(only.commit)}</code>, <RelativeTime at={res.page.writtenAt} /></> : <>as of {res.page.repos.length} commits, one per repo, <RelativeTime at={res.page.writtenAt} /></>}</span>
          <Chip res={res} />
        </p>
        {res.page.summary !== "" && <p className="rv-wiki-lede"><VisibleText text={res.page.summary} /></p>}
        {(entry.flagged || chip.tone === "bad") && <div className="rv-wiki-alerts">{entry.flagged ? <Banner title={T.FLAGGED_PAGE} tone="danger" /> : <Banner title={T.MOSTLY_OLD} tone="warning" />}</div>}
        <PageMark project={project} res={res} view={view} marked={entry.flagged} />
        <PageNotes project={project} res={res} view={view} />
        {model.cites.length > 0 && <Sources project={project} id={id} commits={new Map(res.page.repos.map((one) => [one.repo, one.commit]))} links={link} />}
        {res.page.blocks.map((block) => <Block key={block.blockId} block={block} context={context} />)}
        <TeamLessons project={project} pageId={id} />
        <p className="rv-wiki-truth" data-testid="wiki-truth">{res.trustLine} {T.TRUTH_EXTRA}</p>
      </article>
      <Rail res={res} model={model} onJump={jump} />
    </div>
  );
}
