import { WikiPageResponseSchema, WikiSourcesResponseSchema, WikiCorrectionsResponseSchema, WIKI_PAGE_ID_PATTERN, type WikiBlock, type WikiShownClaim } from "@agentx/contracts/web";
import { useState } from "react";
import { useProject } from "../../api/projects.js";
import { Button } from "../../design/Button.js";
import { MarkForm, PageMark, PageNotes, viewOf } from "../project/wiki/WikiCorrections.js";
import { hostLink } from "../project/wiki/wiki-model.js";
import { TeamLessons } from "../project/lessons/TeamLessons.js";
import { T } from "../project/wiki/wiki-text.js";
import "../project/wiki/wiki.css";
import { useRead, useScope } from "./read-model.js";
import { ReadState } from "./ReadState.js";
import { Card, Chip, Header, Notice, RailCard, Rows, Section, Two, day } from "./parts.js";

type Group = { id: string; title?: string; blocks: WikiBlock[] };
/** Headings open a section; text before the first heading forms an untitled opening section. */
function groups(blocks: readonly WikiBlock[]): Group[] {
 const out: Group[] = [];
 for (const block of blocks) {
  if (block.kind === "heading") out.push({ id: block.blockId, title: block.text, blocks: [] });
  else { let last = out[out.length - 1]; if (last === undefined) { last = { id: block.blockId, blocks: [] }; out.push(last); } last.blocks.push(block); }
 }
 return out;
}
type Link = (cite: { repo: string; path: string; commit: string; line: number; lineEnd?: number | undefined }) => string | undefined;
const lines = (claim: WikiShownClaim) => claim.citations.map(c => ({ text: c.repo + "/" + c.path + " · line " + String(c.line) + (c.lineEnd === undefined ? "" : "\u2060–\u2060" + String(c.lineEnd)), cite: c }));
function SourceChip({ claim }: { claim: WikiShownClaim }) {
 return claim.source === "found" ? <Chip tone="ok">Source found</Chip> : claim.source === "changed" ? <Chip icon="clock">Source changed · may be out of date</Chip> : <Chip icon="dash" dashed>Source not found</Chip>;
}
/** The file and lines as text; with the project's own repository it also opens on the code host (never built from wiki text). */
function Cite({ text, href }: { text: string; href: string | undefined }) {
 return href === undefined ? <code>{text}</code> : <a href={href} target="_blank" rel="noopener noreferrer"><code>{text}</code><span className="rv-visually-hidden"> ({T.SOURCE_OPEN})</span></a>;
}
function ClaimList({ claims, label, link }: { claims: readonly WikiShownClaim[]; label: string; link: Link }) {
 if (claims.length === 0) return null;
 return <ul className="rv-wsr-claims" aria-label={label}>{claims.map(claim => <li key={claim.claimId}><p>{claim.text}</p><div className="rv-wsr-claim-meta"><SourceChip claim={claim} />{claim.flagged && <Chip tone="attention">Disputed</Chip>}{lines(claim).map(line => <Cite key={line.text} text={line.text} href={link(line.cite)} />)}</div></li>)}</ul>;
}
export function WikiPageReadScreen({ pageId, marked = false }: { pageId: string; /** An open mark on the whole page (the index row's own fact). */ marked?: boolean }) {
 const scope = useScope(), { project } = scope, overview = useProject(project), [marking, setMarking] = useState<string>();
 const valid = WIKI_PAGE_ID_PATTERN.test(pageId), path = "wiki/pages/" + encodeURIComponent(pageId);
 const page = useRead("page:" + pageId, path, { parse(raw: unknown) { const value = WikiPageResponseSchema.parse(raw); if (value.page.pageId !== pageId) throw new Error("Wrong page"); return value; } }, valid, true);
 const sources = useRead("sources:" + pageId, path + "/sources", { parse(raw: unknown) { const value = WikiSourcesResponseSchema.parse(raw); if (value.pageId !== pageId) throw new Error("Wrong page"); return value; } }, valid, true);
 const corrections = useRead("corrections:" + pageId, path + "/corrections", { parse(raw: unknown) { const value = WikiCorrectionsResponseSchema.parse(raw); if (value.pageId !== pageId) throw new Error("Wrong page"); return value; } }, valid, true);
 const files = sources.data?.files.filter(file => page.data?.page.repos.some(repo => repo.repo === file.repo && repo.commit === file.commit)) ?? [];
 const partialSources = sources.data !== undefined && files.length !== sources.data.files.length;
 const back = { label: "Back to Wiki", href: "?tab=wiki" };
 const repositories = overview.data?.project.repositories ?? [];
 const link: Link = cite => hostLink(repositories, { repo: cite.repo, path: cite.path, commit: cite.commit, line: cite.line, ...(cite.lineEnd === undefined ? {} : { lineEnd: cite.lineEnd }) });
 // Controls are Code's say-so on this person's corrections read; a read that failed or is only kept from earlier draws none (Code still decides every write again).
 const live = page.data !== undefined && !page.isError && page.failureCount === 0 && corrections.data !== undefined && !corrections.isError && corrections.failureCount === 0;
 const view = live ? viewOf(corrections.data) : undefined;
 if (!valid) return <p role="alert">Page unavailable.</p>;
 return <ReadState read={page} label="this wiki page" code="WIKI-PAGE-READ-FAILED" back={back} notFound={T.NO_PAGE} header={(confirmed, readAt) => <Header project={project} trail={["Wiki", confirmed && page.data !== undefined ? page.data.page.title : "Page"]} {...(confirmed && page.data !== undefined ? { meta: "Wiki page · written " + day(page.data.page.writtenAt), readAt } : {})} />}>{page.data !== undefined && (() => {
  const data = page.data, claims = new Map(data.page.claims.map(claim => [claim.claimId, claim]));
  const sections = groups(data.page.blocks), used = new Set<string>();
  const forGroup = (group: Group) => group.blocks.flatMap(block => block.kind === "heading" ? [] : block.claimIds).flatMap(id => { const claim = claims.get(id); if (claim === undefined || used.has(id)) return []; used.add(id); return [claim]; });
  const rendered = sections.map(group => ({ group, claimsHere: forGroup(group) }));
  const rest = data.page.claims.filter(claim => !used.has(claim.claimId));
  // Mark wrong: the section's claims that are not already marked are listed to tick; one mark (the same request the old paragraph mark sent) for each ticked claim.
  const toMark = (group: Group) => [...new Set(group.blocks.flatMap(block => block.kind === "heading" ? [] : block.claimIds))].filter(id => claims.get(id)?.flagged === false);
  return <Two rail={<RailCard title="Older versions"><p>Can&apos;t tell yet.</p></RailCard>}>
 <div className="rv-wsr-head"><div className="rv-wsr-title"><h2>{data.page.title}</h2>{data.openFlags > 0 && <Chip tone="attention">{String(data.openFlags) + " open disputed " + (data.openFlags === 1 ? "mark" : "marks")}</Chip>}</div>
 <p className="rv-wsr-lede">{data.page.summary}</p>
 <p className="rv-wsr-meta"><span>{String(rendered.length)} {rendered.length === 1 ? "section" : "sections"}</span><span>Written {day(data.page.writtenAt)}</span>{data.page.repos.map(revision => <span key={revision.repo + ":" + revision.commit}>{revision.repo} at <abbr title={revision.commit}>{revision.commit.slice(0, 7)}</abbr></span>)}</p>
 <PageMark project={project} res={data} view={view} marked={marked} /></div>
 {rendered.map(({ group, claimsHere }) => { const disputed = claimsHere.some(claim => claim.flagged), changed = claimsHere.some(claim => claim.source === "changed"), found = claimsHere.length > 0 && claimsHere.every(claim => claim.source === "found"), mark = toMark(group); return <Card key={group.id} level={3} {...(group.title === undefined ? {} : { title: group.title })} {...(disputed ? { tone: "attention" as const, chip: <Chip tone="attention">Disputed</Chip> } : changed ? { chip: <Chip icon="clock">May be out of date</Chip> } : found ? { chip: <Chip tone="ok">Sources found</Chip> } : {})}>
  {group.blocks.map(block => block.kind === "diagram" ? <pre key={block.blockId}>{block.mermaid}</pre> : block.kind === "paragraph" ? <p key={block.blockId} className="rv-wsr-body">{block.text}</p> : null)}
  <ClaimList claims={claimsHere} label={"About the claims in " + (group.title ?? "this page")} link={link} />
  {disputed && <p className="rv-wsr-note">The section stays marked Disputed until a maintainer decides.</p>}
  {view?.you.markWrong === true && mark.length > 0 && (marking === group.id ? <MarkForm project={project} id={data.page.pageId} claimIds={mark} choices={mark.map(claimId => ({ claimId, text: claims.get(claimId)?.text ?? claimId }))} onDone={() => { setMarking(undefined); }} /> : <div className="rv-wsr-actionline"><Button variant="quiet" aria-label={T.MARK_WRONG + ": " + (group.title ?? "this page")} onClick={() => { setMarking(group.id); }}>{T.MARK_WRONG}</Button></div>)}
 </Card>; })}
 {rest.length > 0 && <Card title="Other claims" level={3}><ClaimList claims={rest} label="Other claims" link={link} /></Card>}
 <details className="rv-wsr-disclosure"><summary>Relevant source files</summary><ReadState read={sources} quiet label="the source files"><>{partialSources && <Notice>Can&apos;t tell yet. Some source files do not match this page revision and are hidden.</Notice>}<Rows label="Source files">{files.map((file, i) => { const first = file.ranges[0], href = first === undefined ? undefined : link({ repo: file.repo, path: file.path, commit: file.commit, line: first.line, ...(first.lineEnd === undefined ? {} : { lineEnd: first.lineEnd }) }); return <li className="rv-wsr-row" key={i}><div className="rv-wsr-row-line"><div className="rv-wsr-row-main"><code>{file.repo}/{file.path}</code><p>Commit {file.commit} · {file.ranges.map(range => String(range.line) + (range.lineEnd === undefined ? "" : "\u2060–\u2060" + String(range.lineEnd))).join(", ")}</p></div>{href !== undefined && <div className="rv-wsr-row-side"><a href={href} target="_blank" rel="noopener noreferrer">{T.SOURCE_OPEN}<span className="rv-visually-hidden">: {file.repo}/{file.path}</span></a></div>}</div></li>; })}</Rows></></ReadState></details>
 <Section title="Existing corrections"><ReadState read={corrections} quiet label="the corrections">{view !== undefined ? <PageNotes project={project} res={data} view={view} /> : data.notes.length === 0 ? <Notice>No notes in this read.</Notice> : <Rows label="Existing corrections">{data.notes.map(note => <li className="rv-wsr-row" key={note.noteId}><div className="rv-wsr-row-line"><div className="rv-wsr-row-main"><p className="rv-wsr-body">{note.text}</p><p className="rv-wsr-quiet">{note.author} · {note.approval}</p></div>{corrections.data?.notes.find(row => row.noteId === note.noteId)?.mayBeOutOfDate === true && <div className="rv-wsr-row-side"><Chip icon="clock">File may have changed</Chip></div>}</div></li>)}</Rows>}</ReadState></Section>
 <TeamLessons project={project} pageId={pageId} />
 <p className="rv-wsr-note">{data.trustLine}</p>
 </Two>; })()}</ReadState>;
}
