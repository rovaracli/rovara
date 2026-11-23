import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { WikiIndexResponseSchema, WikiCorrectionsResponseSchema, WikiSearchResponseSchema, WIKI_TRUST_LINE, type WikiIndexEntry } from "@agentx/contracts/web";
import { fixedWikiWords } from "../../api/wiki.js";
import { useAnswersEnabled } from "../../api/answers.js";
import { T } from "../project/wiki/wiki-text.js";
import { Button } from "../../design/Button.js";
import { useRead, useScope, failed } from "./read-model.js";
import { ReadState } from "./ReadState.js";
import { WikiPageReadScreen } from "./WikiPageReadScreen.js";
import { WikiCorrectionsReadScreen } from "./WikiCorrectionsReadScreen.js";
import { ProjectAnswerReadPanel } from "./ProjectAnswerReadPanel.js";
import { WikiSetupReadPanel } from "./WikiSetupReadPanel.js";
import { WikiBuildHere } from "./WikiBuildHere.js";
import { Chip, Header, HeadRow, HeldLine, Notice, Row, Rows, Section, day, readClock } from "./parts.js";

const LAST_BUILD: Record<string, string> = { running: "running", done: "done", stopped: "stopped", failed: "failed" };
/** One chip per page, from the facts the index serves: an open mark, changed sources, or sources found. */
function PageChips({ row }: { row: WikiIndexEntry }) {
 return <>{row.flagged && <Chip tone="attention">Disputed</Chip>}{row.claims.changed > 0 && <Chip icon="clock">Source changed</Chip>}{!row.flagged && row.claims.changed === 0 && row.claims.found > 0 && <Chip tone="ok">Sources found</Chip>}</>;
}
function PageRow({ row, to }: { row: WikiIndexEntry; to: string }) {
 return <Row title={<Link to={to}>{row.title}</Link>} detail={row.summary} extra={<p className="rv-wsr-meta">{row.repos.length === 0 ? <span>Source revision: Can&apos;t tell yet.</span> : row.repos.map(revision => <span key={revision.repo + ":" + revision.commit}>{revision.repo} at <abbr title={revision.commit}>{revision.commit.slice(0, 7)}</abbr></span>)}</p>} side={<><PageChips row={row} /><p className="rv-wsr-meta"><span>Updated <time dateTime={row.writtenAt}>{day(row.writtenAt)}</time></span></p></>} />;
}
export function WikiIndexReadScreen() {
 const { project } = useScope(), answersOn = useAnswersEnabled();
 const read = useRead("index", "wiki", WikiIndexResponseSchema), [params] = useSearchParams(), [search, setSearch] = useState("");
 const index = !failed(read) && !read.isFetching ? read.data : undefined;
 const first = index?.pages[0]?.pageId;
 const permission = useRead("permission:" + (first ?? ""), "wiki/pages/" + encodeURIComponent(first ?? "") + "/corrections", WikiCorrectionsResponseSchema, first !== undefined, true);
 const canSee = !failed(permission) && !permission.isFetching && permission.data?.you.seeDisputed === true;
 // Closing marks is Code's say-so on the same read, and only from a read that is current.
 const canResolve = canSee && permission.data?.you.resolveMarks === true && !permission.isError && permission.failureCount === 0;
 const view = params.get("view"), page = params.get("page");
 // A list is OPENED only from a confirmed grant: while the person's permission is being read again a list that is not yet open waits; one that is already open keeps its place (last good read).
 const [opened, setOpened] = useState(false), lists = view === "disputed" || view === "gaps";
 if (!lists && opened) setOpened(false);
 else if (lists && canSee && !permission.refetching && !opened) setOpened(true);
 const canOpen = canSee && (!permission.refetching || opened);
 const href = (values: Record<string, string>) => { const next = new URLSearchParams(params); next.delete("view"); next.delete("page"); for (const [key, value] of Object.entries(values)) next.set(key, value); return "?" + next.toString(); };
 const selected = view === "disputed" || view === "gaps" || view === "setup" || view === "ask" || page !== null;
 // Under two characters the title and summary filter answers; from two on Code's full-text search does, as the old Wiki tab did (page text too).
 const typed = search.trim(), [settled, setSettled] = useState("");
 useEffect(() => { if (typed.length < 2) return; const timer = setTimeout(() => { setSettled(typed); }, 250); return () => { clearTimeout(timer); }; }, [typed]);
 const wanted = typed.length < 2 ? "" : settled;
 const found = useRead("search:" + wanted, "wiki/search?q=" + encodeURIComponent(wanted), WikiSearchResponseSchema, index !== undefined && wanted !== "");
 const serverSearch = typed.length >= 2;
 const matches = index?.pages.filter(row => (row.title + " " + row.summary).toLowerCase().includes(search.toLowerCase())) ?? [];
 const back = { label: "Back to Wiki", href: href({ tab: "wiki" }) };
 return <ReadState read={read} label={view === "disputed" || view === "gaps" ? "the wiki corrections" : page !== null && view === null ? "this wiki page" : "this wiki"} code={view === "disputed" || view === "gaps" ? "WIKI-CORRECTIONS-READ-FAILED" : page !== null && view === null ? "WIKI-PAGE-READ-FAILED" : "WIKI-INDEX-READ-FAILED"} {...(selected ? { back } : {})} staleLine={!selected} header={(confirmed, readAt) => selected && confirmed ? null : <Header project={project} trail={view === "disputed" || view === "gaps" ? ["Wiki", "Corrections"] : view === "setup" ? ["Wiki", "Scope and build"] : view === "ask" ? ["Wiki", "Ask"] : page !== null ? ["Wiki", "Page"] : ["Wiki"]} {...(confirmed && !selected && index !== undefined ? { meta: "Wiki · " + String(index.pages.length) + (index.pages.length === 1 ? " page" : " pages"), readAt } : {})} />}>{index !== undefined && (
 view === "disputed" || view === "gaps" ? (canOpen ? <WikiCorrectionsReadScreen view={view} canResolve={canResolve} /> : first === undefined ? <HeldLine back={back}>Can&apos;t tell yet.</HeldLine> : <ReadState read={{ ...permission, isFetching: permission.refetching }} back={back} header={() => <Header project={project} trail={["Wiki", "Corrections"]} />}><HeldLine back={back}>This list isn&apos;t available to you.</HeldLine></ReadState>)
 : view === "setup" ? <WikiSetupReadPanel />
 : view === "ask" ? <ProjectAnswerReadPanel readAt={readClock(read.dataUpdatedAt)} />
 : page !== null ? <WikiPageReadScreen key={page} pageId={page} marked={index.pages.find(row => row.pageId === page)?.flagged === true} />
 : <div className="rv-wsr-page">
 <HeadRow title={"What Rovara knows about " + project} text="Short pages Rovara wrote from the repo, finished tasks and kept lessons. Tasks read them before planning, and every page lists the files it was built from." actions={<>{index.state !== "empty" && <Link className="rv-button rv-button-secondary" to={href({ tab: "wiki", view: "setup" })}>Scope and build</Link>}<Link className="rv-button rv-button-secondary" to={href({ tab: "wiki", view: "ask" })}>{answersOn ? "Ask a question" : "Existing answers"}</Link></>} />
 {!index.agentsEnabled && <Notice>Tasks are not reading the wiki.</Notice>}
 {index.lastBuild !== undefined && <Notice>Last build: {LAST_BUILD[index.lastBuild.state] ?? index.lastBuild.state}{index.lastBuild.stopReason === undefined ? "" : " · " + index.lastBuild.stopReason}</Notice>}
 <label className="rv-wsr-search"><span>Search the wiki</span><input type="search" className="rv-input" placeholder="Search page titles, summaries and text" maxLength={80} value={search} onChange={event => { setSearch(event.target.value); }} /></label>
 {search !== "" && (() => { const hits = found.data?.query === wanted ? found.data.results : undefined, count = serverSearch ? hits?.length : matches.length, pending = serverSearch && hits === undefined && !found.isError; return <div className="rv-wsr-resultcard"><div className="rv-wsr-results" role="status"><span>{pending ? "Searching the wiki" : (count === 1 ? "1 result" : String(count ?? 0) + " results")} for “{search}”</span><Button variant="quiet" onClick={() => { setSearch(""); }}>Clear</Button></div>
  {serverSearch ? (found.isError ? <Notice role="alert">{fixedWikiWords(found.error, T.SEARCH_FAILED)}</Notice> : hits === undefined ? <Notice>Searching the wiki…</Notice> : hits.length > 0 ? <Rows label="Search results">{hits.map(hit => <Row key={hit.pageId} title={<Link to={href({ tab: "wiki", page: hit.pageId })}>{hit.title}</Link>} detail={hit.snippet} />)}</Rows> : <Notice>{T.NO_RESULTS}</Notice>)
   : matches.length > 0 ? <Rows label="Search results">{matches.map(row => <PageRow key={row.pageId} row={row} to={href({ tab: "wiki", page: row.pageId })} />)}</Rows> : <Notice>No pages match this search.</Notice>}</div>; })()}
 <Section title="All pages" label="All pages" aside={canSee ? <nav className="rv-wsr-links" aria-label="Wiki reviews"><Link to={href({ tab: "wiki", view: "disputed" })}>Disputed sections</Link><Link to={href({ tab: "wiki", view: "gaps" })}>Questions without an answer</Link></nav> : undefined}>
 {index.pages.length > 0 && <Rows label="All pages">{index.pages.map(row => <PageRow key={row.pageId} row={row} to={href({ tab: "wiki", page: row.pageId })} />)}</Rows>}
 {index.state === "empty" && <Notice>{index.lastBuild?.state === "running" ? "The first wiki build is running." : "No wiki pages yet."}</Notice>}
 {index.state === "empty" && index.pages.length === 0 && <WikiBuildHere />}
 <p className="rv-wsr-note">{WIKI_TRUST_LINE}</p>
 </Section>
 </div>)}</ReadState>;
}
