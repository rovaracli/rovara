import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AnswerGapsResponseSchema, WikiDisputedResponseSchema } from "@agentx/contracts/web";
import { useWikiApi, useWikiRefresh } from "../../api/wiki.js";
import { Button } from "../../design/Button.js";
import { Failed, useAct } from "../project/wiki/WikiCorrections.js";
import { T } from "../project/wiki/wiki-text.js";
import "../project/wiki/wiki.css";
import { useRead, useScope } from "./read-model.js";
import { ReadState } from "./ReadState.js";
import { Card, Chip, Fact, Facts, Header, Notice, Row, Rows, Section, day } from "./parts.js";

const KINDS = { not_found: "No page covered it", partly: "Only partly answered", wiki_empty: "The wiki was empty", not_right: "Marked not right" } as const;
const plural = (n: number, one: string, many: string) => String(n) + " " + (n === 1 ? one : many);
/** One page for both reads, as the board draws it: corrections to decide, then the questions the wiki could not answer. */
export function WikiCorrectionsReadScreen({ view, canResolve = false }: { view: "disputed" | "gaps"; canResolve?: boolean }) {
 const { project } = useScope();
 const [params] = useSearchParams(), api = useWikiApi(), refresh = useWikiRefresh(project), act = useAct(refresh), [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
 const disputed = useRead("disputed", "wiki/disputed", WikiDisputedResponseSchema);
 const gaps = useRead("gaps", "wiki/gaps", AnswerGapsResponseSchema);
 const to = (values: Record<string, string>, drop: string[] = []) => { const next = new URLSearchParams(params); next.delete("view"); for (const key of drop) next.delete(key); for (const [key, value] of Object.entries(values)) next.set(key, value); return "?" + next.toString(); };
 const back = { label: "Back to Wiki", href: to({}, ["page"]) };
 // The button is drawn only from a read that is current: a failed or merely kept read grants nothing (Code still decides again).
 const live = canResolve && disputed.data !== undefined && !disputed.isError && disputed.failureCount === 0;
 const counts = disputed.data === undefined ? undefined : [plural(disputed.data.items.length, "disputed section", "disputed sections") + (disputed.data.more ? " or more" : ""), ...(gaps.data === undefined || gaps.isFetching || gaps.isError ? [] : [plural(gaps.data.items.length, "gap", "gaps") + (gaps.data.more ? " or more" : "")])].join(" · ");
 return <ReadState read={view === "gaps" ? gaps : disputed} label={view === "gaps" ? "the unanswered questions" : "the disputed sections"} code="WIKI-CORRECTIONS-READ-FAILED" back={back} header={(confirmed, readAt) => <Header project={project} trail={["Wiki", "Corrections"]} {...(confirmed && counts !== undefined ? { meta: "Wiki corrections · " + counts, readAt } : {})} />}>{(view === "gaps" ? gaps.data : disputed.data) !== undefined && <div className="rv-wsr-page">
  <ReadState read={disputed} quiet label="the disputed sections"><>{disputed.data !== undefined && <>
   <div className="rv-wsr-intro"><h2>Corrections to decide</h2><p>Marks that say a wiki section is wrong. Until a maintainer decides, tasks keep reading the section with the mark attached.</p></div>
   {closed.size > 0 && <Notice role="status">{T.DISPUTED_RESOLVED}</Notice>}
   <Failed error={act.error} />
   {disputed.data.items.map((item, at) => <Card key={item.flagId} tone="attention" level={3} title={item.pageTitle} chip={<Chip tone="attention">Disputed</Chip>}>
    <Facts><Fact label="Raised by">{item.markedBy}, <time dateTime={item.markedAt}>{day(item.markedAt)}</time></Fact>{item.reason !== undefined && <Fact label="Note">{item.reason}</Fact>}{item.claimText !== undefined && <Fact label="The section says">{item.claimText}</Fact>}</Facts>
    <p className="rv-wsr-note">The section stays marked Disputed until a maintainer decides. <Link to={to({ page: item.pageId })}>Open the page</Link></p>
    {live && disputed.data?.items.findIndex(other => other.pageId === item.pageId) === at && <div className="rv-wsr-actionline"><Button variant="primary" busy={act.busy} aria-label={T.DISPUTED_RESOLVE + ": " + item.pageTitle} onClick={() => { void act.run(async () => { await api.resolveMarks(project, item.pageId); setClosed(new Set([...closed, item.pageId])); }); }}>{T.DISPUTED_RESOLVE}</Button></div>}
   </Card>)}
   {disputed.data.items.length === 0 && <Notice>No disputed sections in this read.</Notice>}
   {disputed.data.more && <Notice>More items may be available. This is a partial read.</Notice>}
  </>}</></ReadState>
  <Section title="Gaps: questions the wiki couldn't answer"><ReadState read={gaps} quiet label="the unanswered questions"><>{gaps.data !== undefined && <>
   {gaps.data.items.length > 0 && <Rows label="Questions without an answer">{gaps.data.items.map((item, i) => <Row key={i} title={item.topic} detail={String(item.people) + (item.people === 1 ? " person" : " people") + " · " + String(item.questions) + (item.questions === 1 ? " question" : " questions") + " · last asked " + day(item.lastAskedAt)} side={<Chip icon="dash">{KINDS[item.kind]}</Chip>} />)}</Rows>}
   {gaps.data.items.length === 0 && <Notice>No gaps in this read.</Notice>}
   {gaps.data.more && <Notice>More items may be available. This is a partial read.</Notice>}
   <p className="rv-wsr-note">Gaps are read from questions people asked. Who asked is never shown.</p>
  </>}</></ReadState></Section>
  <Section title="Decided in the last 30 days"><Notice>Can&apos;t tell yet.</Notice></Section>
 </div>}</ReadState>;
}
