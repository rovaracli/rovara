// The project's Wiki tab (lead 4 W5; designs-2026-11-17/project-wiki-demo-v2.html is the target look): the page tree and a search box on the left, one page at
// reading width in the middle, "On this page" and "About this page" on the right. Everything is read from Code through Cloud (api/wiki.ts); this tab writes nothing.
// Search looks through page titles, summaries and page text through Code's W5x route. The Ask box stays separate from this page search.
import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";
import { ApiError } from "../../../api/errors.js";
import { fixedWikiWords, useWikiCorrections, useWikiIndex, useWikiSearch, type WikiIndexEntry, type WikiIndexResponse, type WikiSearchResponse } from "../../../api/wiki.js";
import { Button } from "../../../design/Button.js";
import { EmptyState } from "../../../design/EmptyState.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { WikiPageView } from "./WikiPageView.js";
import { DisputedList } from "./WikiCorrections.js";
import { BUILD_STOP_WORDS, T, buildNotice, crumbOf, dotOf, treeOf } from "./wiki-text.js";
import "./wiki.css";

function Tree({ index, current, searching, open }: { index: WikiIndexResponse; current: string | undefined; searching: boolean; open: (id: string) => void }) {
  const groups = treeOf(index.pages);
  const item = (page: WikiIndexEntry, cls: string) => {
    const dot = dotOf(page);
    return (
      <li key={page.pageId} className={cls}>
        <button type="button" onClick={() => { open(page.pageId); }} {...(current === page.pageId && !searching ? { "aria-current": "page" as const } : {})}>
          <span><VisibleText text={page.title} /></span>
          {dot !== undefined && <><span className={`rv-wiki-dot rv-wiki-dot-${dot.tone}`} aria-hidden="true" /><span className="rv-visually-hidden">, {dot.words}</span></>}
        </button>
      </li>
    );
  };
  return (
    <>
      <p className="rv-wiki-navlab">{T.GROUP_PROJECT}</p>
      <ul>{groups.project.map((page) => item(page, ""))}</ul>
      {groups.repos.length > 0 && <p className="rv-wiki-navlab">{T.GROUP_REPOS}</p>}
      <ul>{groups.repos.flatMap((group) => [item(group.page, "rv-wiki-repo"), ...group.children.map((page) => item(page, "rv-wiki-mod"))])}</ul>
      <p className="rv-muted rv-wiki-small"><span className="rv-wiki-dot rv-wiki-dot-warn" aria-hidden="true" /> {T.KEY_CHANGED}<br /><span className="rv-wiki-dot rv-wiki-dot-bad" aria-hidden="true" /> {T.KEY_BAD}</p>
    </>
  );
}

/** "Disputed marks" in the navigation, only for a person Code says may see the list (maintainers). The same read the page makes, so it costs nothing more. */
function DisputedEntry({ project, pageId, active, onOpen }: { project: string; pageId: string | undefined; active: boolean; onOpen: () => void }) {
  const read = useWikiCorrections(project, pageId);
  if (read.data?.you.seeDisputed !== true) return null;
  return <p className="rv-wiki-small"><button type="button" className="rv-wiki-disputed-link" data-testid="wiki-disputed-link" {...(active ? { "aria-current": "page" as const } : {})} onClick={onOpen}>{T.DISPUTED}</button></p>;
}

function SearchResults({ index, q, search, open }: { index: WikiIndexResponse; q: string; search: ReturnType<typeof useWikiSearch>; open: (id: string) => void }) {
  // The match is found on the original text (a case-insensitive pattern), so the highlight cannot drift when lowercasing changes a character's length.
  const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
  const hits: WikiSearchResponse["results"] = search.data?.results ?? [];
  return (
    <section className="rv-wiki-art" aria-label="Search results" data-testid="wiki-results">
      <p className="rv-wiki-crumb">Search</p>
      <h2 className="rv-wiki-h1"><VisibleText text={q} /></h2>
      <p role="status" className="rv-visually-hidden">{search.isPending ? "Searching the wiki" : hits.length === 1 ? "1 page matches" : `${String(hits.length)} pages match`}</p>
      {search.isError ? <p role="alert" className="rv-wiki-lede">{fixedWikiWords(search.error, T.SEARCH_FAILED)}</p> : search.isPending ? <p className="rv-wiki-lede">Searching the wiki…</p> : hits.length === 0 ? <p className="rv-wiki-lede">{T.NO_RESULTS}</p> : (
        <ul className="rv-wiki-results">{hits.map((hit) => (
          <li key={hit.pageId}>
            <button type="button" onClick={() => { open(hit.pageId); }}>
              <b><VisibleText text={crumbOf(index.pages.find((page) => page.pageId === hit.pageId) ?? index.pages[0]!, index.pages) + " / " + hit.title} /></b>
              <span className="rv-muted">{(() => { const found = pattern.exec(hit.snippet); return found === null ? <VisibleText text={hit.snippet} /> : <><VisibleText text={hit.snippet.slice(0, found.index)} /><mark><VisibleText text={found[0]} /></mark><VisibleText text={hit.snippet.slice(found.index + found[0].length)} /></>; })()}</span>
            </button>
          </li>
        ))}</ul>
      )}
    </section>
  );
}

export function WikiTab({ project }: { project: string }) {
  const read = useWikiIndex(project), [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(""), [navOpen, setNavOpen] = useState(false), [opened, setOpened] = useState(false), searchId = useId();
  const [debouncedDraft, setDebouncedDraft] = useState("");
  const trimmedDraft = draft.trim();
  useEffect(() => {
    if (trimmedDraft.length < 2) return;
    const timer = setTimeout(() => { setDebouncedDraft(trimmedDraft); }, 250);
    return () => { clearTimeout(timer); };
  }, [trimmedDraft]);
  // Under two characters there is no search at all (derived, not stored, so no setState inside the effect).
  const search = useWikiSearch(project, trimmedDraft.length < 2 ? "" : debouncedDraft);
  if (read.isPending) return <section aria-label={T.TITLE}><Skeleton label={T.LOADING} /></section>;
  if (read.isError || read.data === undefined) {
    const absent = read.error instanceof ApiError && read.error.status === 501;
    return <section aria-label={T.TITLE}><p role="alert" data-testid="wiki-error"><VisibleText text={fixedWikiWords(read.error, T.UNAVAILABLE)} /></p>{!absent && <Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button>}</section>;
  }
  const index = read.data, notice = buildNotice(index.lastBuild);
  const agentsBanner = !index.agentsEnabled ? <p className="rv-wiki-agent-banner" role="status">{T.AGENTS_OFF}</p> : null;
  if (index.state === "empty") {
    const running = index.lastBuild?.state === "running", stopped = index.lastBuild !== undefined && (index.lastBuild.state === "stopped" || index.lastBuild.state === "failed");
    const [title, text] = running ? [T.EMPTY_BUILDING_TITLE, T.EMPTY_BUILDING] : stopped ? [T.EMPTY_STOPPED_TITLE, notice ?? BUILD_STOP_WORDS.failed] : [T.EMPTY_NONE_TITLE, T.EMPTY_NONE];
    return <section aria-label={T.TITLE}>{agentsBanner}<EmptyState testId="wiki-empty" title={title} description={text} /></section>;
  }
  const q = draft.trim();
  const wanted = params.get("page"), current = index.pages.find((page) => page.pageId === wanted) ?? index.pages.find((page) => page.kind === "overview") ?? index.pages[0];
  const disputed = params.get("view") === "disputed";
  const showDisputed = () => {
    setDraft("");
    setNavOpen(false);
    const next = new URLSearchParams(params);
    next.set("tab", "wiki");
    next.set("view", "disputed");
    next.delete("page");
    setParams(next);
  };
  const open = (id: string) => {
    setDraft("");
    setNavOpen(false);
    setOpened(true);
    const next = new URLSearchParams(params);
    next.set("tab", "wiki");
    next.set("page", id);
    next.delete("view");
    setParams(next);
  };
  return (
    <section className="rv-wiki" aria-label={T.TITLE} data-testid="wiki">
      <nav className="rv-wiki-nav" aria-label={T.NAV}>
        <div className="rv-wiki-navhead"><b>{T.TITLE}</b><span className="rv-muted">{T.SUBTITLE}</span></div>
        <button type="button" className="rv-wiki-navtoggle rv-button rv-button-secondary" aria-expanded={navOpen} aria-controls="rv-wiki-navbody" onClick={() => { setNavOpen(!navOpen); }}>{navOpen ? T.HIDE : T.BROWSE}</button>
        <div id="rv-wiki-navbody" className="rv-wiki-navbody" data-open={navOpen}>
          <label htmlFor={searchId} className="rv-visually-hidden">{T.SEARCH}</label>
          <input id={searchId} className="rv-input rv-wiki-search" type="search" placeholder={T.SEARCH_PLACEHOLDER} value={draft} maxLength={80} onChange={(event) => { setDraft(event.target.value); }} />
          {notice !== undefined && <p className="rv-muted rv-wiki-small" data-testid="wiki-build-notice">{notice}</p>}
          <Tree index={index} current={current?.pageId} searching={q !== "" || disputed} open={open} />
          <DisputedEntry project={project} pageId={current?.pageId} active={disputed} onOpen={showDisputed} />
        </div>
      </nav>
      <div className="rv-wiki-main">
        {agentsBanner}{q !== "" ? <SearchResults index={index} q={q} search={search} open={open} /> : disputed ? <DisputedList project={project} open={open} back={() => { open(current?.pageId ?? ""); }} /> : current === undefined ? <p className="rv-muted">{T.NO_PAGE}</p> : <WikiPageView key={current.pageId} project={project} id={current.pageId} entry={current} pages={index.pages} focusTitle={opened} />}
      </div>
    </section>
  );
}
