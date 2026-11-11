import { Suspense, lazy, useId, useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReadAppNav } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { useAgents } from "../../api/agents.js";
import { useDecisions, decisionOpenTarget, type ReadDecision } from "../../api/decisions.js";
import type { ReadHomeCard } from "../../api/home.js";
import { useHomeFinished } from "../../api/home-finished.js";
import { mergeLiveTiles, useLive } from "../../api/live.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { HomeCardRow } from "./HomeCardRow.js";
import { useAgentPublishOn } from "../agents/publish-flags.js";
import { StatePill } from "./StatePill.js";
import { continueRows, decisionSession, decisionState, finishedRows, needsYouSessions, pickAgents, type HomeRow } from "./home-rows.js";
// The start box is the existing one (outcome first); it loads after the first paint like on today's Home.
const HomeStart = lazy(async () => ({ default: (await import("./HomeStart.js")).HomeStart }));
// Favourites and suggested agents (exp/agent-publish): loaded only where its own switch (`rovara.publish`) is on, on top of this Home's switch.
const HomeAgentsRow = lazy(() => import("./HomeAgentsRow.js"));

const WORK_LINK = paths.live, NO_CARDS: readonly ReadHomeCard[] = [];

function Failed({ error, fallback, retry }: { error: unknown; fallback: string; retry: () => void }) {
 return <div className="rv-hv2-failed" role="alert"><p><VisibleText text={error instanceof ApiError ? error.message : fallback} /></p><Button onClick={retry}>Try again</Button></div>;
}

/** One decision as a row: its plain state, the question it asks, how long ago it was asked, and one primary action (its own Open). The decision itself is made on the card the link opens. */
function DecisionRow({ decision }: { decision: ReadDecision }) {
 const host = useAppHost(), card = decision.card, target = decisionOpenTarget(card, host.origin), open = card.actions.find(action => action.kind === "open"), label = open?.label ?? "Open", name = label + ": " + card.title;
 // A card whose own Open is not one this app can follow still gets a way in: its task page, else its own decision page.
 const session = decisionSession(decision), fallback = target !== undefined ? undefined : session !== undefined ? paths.session(session) : "/app/decisions/" + card.id.replace(":", "/");
 return <li className="rv-hv2-row" data-card-kind={card.kind}>
  <div className="rv-hv2-main"><p className="rv-hv2-top"><StatePill state={decisionState(card)} /><span className="rv-hv2-meta"><VisibleText text={card.project} /></span><span className="rv-hv2-age">Asked <RelativeTime at={card.createdAt} /></span></p><h3><VisibleText text={card.title} /></h3><p className="rv-hv2-line"><VisibleText text={card.question} /></p></div>
  <div className="rv-hv2-actions">{target?.kind === "internal" && <Link className="rv-button rv-button-primary" to={target.to} aria-label={name}><VisibleText text={label} /></Link>}{target?.kind === "external" && <Button variant="primary" aria-label={name} onClick={() => { host.openExternal(target.href); }}><VisibleText text={label} /></Button>}{fallback !== undefined && <Link className="rv-button rv-button-primary" to={fallback} aria-label={"Open: " + card.title}>Open</Link>}</div>
 </li>;
}

function SessionRow({ row, sessionId }: { row: HomeRow; sessionId: string }) {
 return <li className="rv-hv2-row rv-hv2-session">
  <div className="rv-hv2-main"><p className="rv-hv2-top"><StatePill state={row.state} />{row.meta.map(item => <span key={item} className="rv-hv2-meta"><VisibleText text={item} /></span>)}{row.at !== undefined && <span className="rv-hv2-age">Updated <RelativeTime at={row.at} /></span>}</p><h3><Link to={paths.session(sessionId)}><VisibleText text={row.title} /></Link></h3>{row.next !== undefined && <p className="rv-hv2-line"><VisibleText text={row.next} /></p>}</div>
 </li>;
}

function Section({ id, title, count, link, children }: { id: string; title: string; count?: number | undefined; link?: { to: string; label: string } | undefined; children: React.ReactNode }) {
 return <section className="rv-hv2-section" aria-labelledby={id}><div className="rv-hv2-head"><h2 id={id}>{title}{count !== undefined && count > 0 && <span className="rv-hv2-count"> {count}</span>}</h2>{link !== undefined && <Link className="rv-hv2-link" to={link.to}>{link.label}</Link>}</div>{children}</section>;
}

export interface HomeV2Props {
 /** The Home read (the cards and their server count), and its refetch. */
 home: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
 /** The older Home cards to show (those whose decision no pending decision card holds), or undefined while unread. */
 shown: readonly ReadHomeCard[] | undefined;
 /** How many cards the person has in all (the server's count less those a decision card holds). */
 total: number;
 /** The ONE "needs you" count (the sidebar shows the same number). */
 needsYou: number;
 /** Whether the home read gave no cards though it counts some. */
 unavailable: boolean;
}

/**
 * The new Home (experience lane exp/home, behind `isNewHomeOn`). One list, in this order (decision D1): Needs you, then Start something beside a row of agents (D23), then Continue, then
 * Finished recently. Everything comes from reads the app already makes; each section says plainly when it is empty and never points to "Live" by name (the place is Work).
 */
export function HomeV2({ home, shown, total, needsYou, unavailable }: HomeV2Props) {
 const decisions = useDecisions(), finished = useHomeFinished(), mine = useLive("mine"), directory = useAgents("all");
 const nav = useQuery<ReadAppNav>({ queryKey: ["nav"], enabled: false }).data;
 const pending = useMemo(() => decisions.isError ? [] : (decisions.data ?? []).filter(decision => decision.card.status === "pending"), [decisions.isError, decisions.data]);
 const cards = shown ?? NO_CARDS, held = useMemo(() => needsYouSessions(cards, pending), [cards, pending]);
 const tiles = useMemo(() => mergeLiveTiles(mine.data?.pages ?? []), [mine.data]);
 const cont = useMemo(() => continueRows(tiles, held), [tiles, held]);
 const ended = useMemo(() => finishedRows(finished.data?.sessions ?? []), [finished.data]);
 const recent = useMemo(() => [...cont, ...ended].map(row => row.agentId).filter((id): id is string => id !== undefined), [cont, ended]);
 const agents = useMemo(() => pickAgents(directory.isError ? [] : directory.data?.agents ?? [], recent), [directory.isError, directory.data, recent]);
 const publishOn = useAgentPublishOn(), startId = useId(), agentsId = useId(), needsId = useId(), continueId = useId(), finishedId = useId();
 // Today's agents row: the recently used agents, then the directory's first ones. The publishing row falls back to it when the server cannot answer.
 const today = <>
    {directory.isPending && <Skeleton label="Loading agents" />}
    {directory.isError && <p className="rv-muted">Couldn't load agents. See all agents to try again.</p>}
    {!directory.isPending && !directory.isError && agents.length === 0 && <p className="rv-hv2-empty">No agents are available yet.</p>}
    {agents.length > 0 && <ul className="rv-hv2-agent-list" aria-label="Agents">{agents.map(agent => <li key={agent.agentId}><Link className="rv-hv2-agent" to={paths.agent(agent.agentId)}><span className="rv-hv2-agent-name"><VisibleText text={agent.name} /></span><span className="rv-hv2-agent-note"><VisibleText text={agent.note} /></span></Link></li>)}</ul>}
 </>;
 const needsLoading = home.isPending || decisions.isPending, needsEmpty = !needsLoading && !home.isError && !decisions.isError && !unavailable && shown !== undefined && shown.length === 0 && pending.length === 0 && total === 0 && needsYou === 0;
 return <section className="rv-home rv-home-v2">
  <PageHeader title="Home" {...(shown !== undefined && needsYou > 0 ? { description: `${needsYou} ${needsYou === 1 ? "thing needs" : "things need"} you` } : {})} />
  <Section id={needsId} title="Needs you" count={needsLoading ? undefined : needsYou > 0 ? needsYou : pending.length + cards.length}>
   {needsLoading && <Skeleton label="Loading what needs you" />}
   {home.isError && <Failed error={home.error} fallback="Couldn't load what needs you. Try again." retry={() => { void home.refetch(); }} />}
   {decisions.isError && <Failed error={decisions.error} fallback="Couldn't load your decisions. Try again." retry={() => { void decisions.refetch(); }} />}
   {unavailable && <div role="status"><p>Items are temporarily unavailable.</p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
   {(pending.length > 0 || cards.length > 0) && <ol className="rv-hv2-list" aria-label="What needs you">{pending.map(decision => <DecisionRow key={decision.card.id} decision={decision} />)}{cards.map(card => <HomeCardRow key={card.cardId} card={card} />)}</ol>}
   {shown !== undefined && total > shown.length && shown.length > 0 && <p className="rv-muted">Showing {shown.length} of {total}</p>}
   {needsEmpty && <p className="rv-hv2-empty"><strong>Nothing needs you right now.</strong> <span className="rv-muted">Your team's work can keep moving.</span></p>}
  </Section>
  <div className="rv-hv2-start-grid">
   <section className="rv-hv2-card rv-hv2-start" aria-labelledby={startId}><h2 id={startId}>Start something</h2><p className="rv-muted">Describe the outcome; the project brings its defaults.</p>
    {nav !== undefined && nav.projects.length === 0 ? <p className="rv-hv2-empty">You aren't on a project yet, so there is nothing to start here.</p> : <Suspense fallback={<Skeleton label="Loading the start box" />}><HomeStart /></Suspense>}
   </section>
   <section className="rv-hv2-card rv-hv2-agents" aria-labelledby={agentsId}><div className="rv-hv2-head"><h2 id={agentsId}>Or start with an agent</h2><Link className="rv-hv2-link" to={paths.directory}>See all agents</Link></div>
    {publishOn ? <Suspense fallback={<Skeleton label="Loading agents" />}><HomeAgentsRow fallback={today} /></Suspense> : today}
   </section>
  </div>
  <Section id={continueId} title="Continue" link={{ to: WORK_LINK, label: "See all in Work" }}>
   {mine.isPending && <Skeleton label="Loading your work" />}
   {mine.isError && <Failed error={mine.error} fallback="Couldn't load your work. Try again." retry={() => { void mine.refetch(); }} />}
   {!mine.isPending && !mine.isError && cont.length === 0 && <p className="rv-hv2-empty"><strong>Nothing in progress.</strong> <span className="rv-muted">Work you start shows up here.</span></p>}
   {cont.length > 0 && <ul className="rv-hv2-list" aria-label="Work to continue">{cont.map(row => <SessionRow key={row.key} row={row} sessionId={row.sessionId} />)}</ul>}
  </Section>
  <Section id={finishedId} title="Finished recently" link={{ to: WORK_LINK, label: "See all in Work" }}>
   {finished.isPending && <Skeleton label="Loading finished work" />}
   {finished.isError && <Failed error={finished.error} fallback="Couldn't load your finished work. Try again." retry={() => { void finished.refetch(); }} />}
   {!finished.isPending && !finished.isError && ended.length === 0 && <p className="rv-hv2-empty"><strong>Nothing finished recently.</strong> <span className="rv-muted">Work you finish shows up here.</span></p>}
   {ended.length > 0 && <ul className="rv-hv2-list" aria-label="Recently finished work">{ended.map(row => <SessionRow key={row.key} row={row} sessionId={row.sessionId} />)}</ul>}
  </Section>
 </section>;
}
