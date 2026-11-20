import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isGithubUrl, safeExternalUrl } from "../../text/links.js";
import { Clock, Facts, MergeChip, Sha, ThreeParts } from "./merge-parts.js";
import type { MergeTone } from "./merge-facts.js";

/**
 * The per-pull-request merge receipt (boards 3h, 9a, 15j; CONTRACTS R1a). Presentation only: it takes the facts the receipt reader will serve and draws them. It is NOT mounted yet. Mounting waits for the
 * gated reader, the Code producer and the original-operation adoption (brief: held). The types below are the R1a wire as the contract writes it; swap them for the reader's exported types when it lands.
 *
 * Rules it keeps: each pull request is read on its own row; a pull request GitHub shows as merged is an observation and is never worded as this request's merge unless that row's own attempt witnessed it;
 * a failed or older read keeps the earlier reading and says so; the Check callback is the only action and it is never a merge.
 */
export interface PullId { repositoryId: string; number: number }
export interface JournalRow extends PullId {
 expectedHead: string; url?: string;
 attempt: "not_started" | "in_flight" | "merged" | "refused" | "unknown";
 refusal?: string;
 observed: "open" | "closed" | "merged" | "unknown";
 observedHead?: string; checkedAt?: string;
 check?: { outcome: "ok" | "failed"; attemptedAt: string };
}
export interface JournalFacts {
 kind: "journal"; requestId: string; updatedAt: string;
 execution: "active" | "stopped" | "complete" | "uncertain";
 status: "pending" | "merged" | "partial" | "not_merged" | "unknown";
 intent: { expectedHeads: Array<PullId & { headSha: string }>; risk: "low" | "medium" | "high"; prepared?: { workflowRevision: number; mergeMethod: "merge" | "squash"; order: PullId[] } };
 pullRequests: JournalRow[];
}
export interface LegacyFacts { kind: "legacy_success"; requestId: string; status: "merged"; updatedAt: string; pullRequests: PullId[] }
export type ReceiptFacts = JournalFacts | LegacyFacts;

export interface RowOutcome { tone: MergeTone; chip: string; words: string }

const label = (row: PullId): string => row.repositoryId + " #" + String(row.number);

/** One row's outcome. Only this row's own attempt can say "merged by this request"; an observation alone says what GitHub shows. */
export function rowOutcome(row: JournalRow, execution: JournalFacts["execution"]): RowOutcome {
 if (row.attempt === "merged") return { tone: "ok", chip: "Merged", words: "Rovara's merge of this pull request was accepted by GitHub." };
 if (row.attempt === "refused") return { tone: "bad", chip: "Refused", words: row.refusal === undefined ? "The merge was refused." : row.refusal };
 const unsure = row.attempt === "unknown" || row.attempt === "in_flight";
 if (row.observed === "merged") return { tone: "idle", chip: "Merged on GitHub", words: unsure ? "GitHub shows this pull request merged. Rovara can't say whether its merge or something else did it." : "GitHub shows this pull request merged. Rovara has no record that this request merged it." };
 if (row.attempt === "unknown") return { tone: "wait", chip: "Unknown", words: "Rovara sent the merge and didn't hear back. It may or may not be merged. Don't merge again yet." };
 if (row.attempt === "in_flight") return { tone: "run", chip: "Merging", words: "The merge was sent. GitHub's answer isn't in yet." };
 return execution === "active" ? { tone: "idle", chip: "Waiting", words: "Not started. It is waiting for the pull requests before it." } : { tone: "wait", chip: "Not merged", words: "Rovara held this one before sending a merge. Nothing was sent." };
}

function observation(row: JournalRow) {
 if (row.observed === "unknown" || row.checkedAt === undefined) return <>Not read from GitHub yet.</>;
 const failed = row.check?.outcome === "failed";
 return <>GitHub showed it {row.observed} at <Clock at={row.checkedAt} />{row.observedHead === undefined ? "" : ", head "}{row.observedHead === undefined ? null : <Sha value={row.observedHead} />}.{failed && row.check !== undefined ? <> The latest read, at <Clock at={row.check.attemptedAt} />, failed; this is the earlier reading.</> : null}</>;
}

const countMerged = (rows: readonly JournalRow[]): number => rows.filter(row => row.attempt === "merged" || row.observed === "merged").length;

function headline(facts: JournalFacts): { tone: MergeTone; chip: string; title: string; lede: string } {
 const total = facts.pullRequests.length, done = countMerged(facts.pullRequests);
 const noun = total === 1 ? "pull request" : "pull requests";
 if (facts.status === "merged") return { tone: "ok", chip: "Merged", title: total === 1 ? label(facts.pullRequests[0]!) + " is merged" : "All " + String(total) + " " + noun + " are merged", lede: "Merging puts the code in main. It doesn't deploy it." };
 if (facts.status === "partial") return { tone: "wait", chip: "Partly merged", title: String(done) + " of " + String(total) + " " + noun + " merged", lede: "The rest is not confirmed merged. Each pull request below has its own answer." };
 if (facts.status === "pending") return { tone: "run", chip: "Merging", title: "Merge in progress", lede: "Rovara accepted this merge request and is working through it. There is no result yet." };
 if (facts.status === "not_merged") return { tone: "idle", chip: "Not merged", title: "Nothing was merged by this request", lede: "Rovara held or GitHub refused every pull request. Nothing reached main from this request." };
 return { tone: "wait", chip: "Unknown", title: "The result isn't confirmed yet", lede: "Rovara didn't get a clear answer. Nothing here says it merged, and nothing says it didn't." };
}

/** Whether this request still has a pull request whose merge may or may not have happened: no second merge is offered for it. */
export const needsCheck = (facts: JournalFacts): boolean => facts.execution === "uncertain" || facts.status === "unknown" || facts.pullRequests.some(row => row.attempt === "unknown" || row.attempt === "in_flight");

function Row({ row, facts, index, many }: { row: JournalRow; facts: JournalFacts; index: number; many: boolean }) {
 const outcome = rowOutcome(row, facts.execution), url = row.url !== undefined && isGithubUrl(row.url) ? safeExternalUrl(row.url) : undefined;
 const moved = row.observedHead !== undefined && row.observedHead !== row.expectedHead;
 return <li className="rv-merge-pr" data-state={row.attempt}>
  <div className="rv-merge-pr-head">{many && <span className="rv-merge-order" aria-hidden="true">{index + 1}</span>}<h3><VisibleText text={label(row)} /></h3><MergeChip tone={outcome.tone}>{outcome.chip}</MergeChip>
   {url !== undefined && <a className="rv-merge-link" href={url} target="_blank" rel="noopener noreferrer">Open on GitHub: <VisibleText text={label(row)} /></a>}</div>
  <p>{outcome.words}</p>
  <Facts rows={[
   { label: "Authorized head", value: <Sha value={row.expectedHead} /> },
   { label: "On GitHub", value: observation(row), ...(moved ? { tone: "wait" as const } : {}) },
   ...(moved ? [{ label: "Head moved", value: <>GitHub has <Sha value={row.observedHead!} />, not the authorized <Sha value={row.expectedHead} />. Nothing checked for the old head counts for it.</>, tone: "wait" as const }] : []),
  ]} />
 </li>;
}

/** Rows in the plan's order when the receipt froze one, else as sent. */
function ordered(facts: JournalFacts): JournalRow[] {
 const order = facts.intent.prepared?.order ?? [];
 return [...facts.pullRequests].sort((a, b) => { const ai = order.findIndex(id => id.repositoryId === a.repositoryId && id.number === a.number), bi = order.findIndex(id => id.repositoryId === b.repositoryId && id.number === b.number); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); });
}

export function MergeReceiptView({ facts, onCheck, checking = false }: { facts: ReceiptFacts; onCheck?: (() => void) | undefined; checking?: boolean }) {
 if (facts.kind === "legacy_success") {
  const rows = facts.pullRequests;
  return <section aria-label="Merge receipt" className="rv-merge" data-state="merged">
   <header className="rv-merge-head"><MergeChip tone="ok">Merged</MergeChip><h2 className="rv-merge-state">Merged</h2>
    <p>{rows.length === 0 ? "Rovara recorded this merge before it kept details for each pull request, so none are shown." : "Rovara recorded this merge before it kept a per-pull-request receipt. Only the pull requests are known; heads, order and who pressed Merge are not shown."} Merging puts the code in main. It doesn't deploy it.</p></header>
   {rows.length > 0 && <ul className="rv-merge-prs">{rows.map(row => <li className="rv-merge-pr" key={label(row)}><div className="rv-merge-pr-head"><h3><VisibleText text={label(row)} /></h3><MergeChip tone="ok">Merged</MergeChip></div></li>)}</ul>}
  </section>;
 }
 const top = headline(facts), rows = ordered(facts), check = needsCheck(facts), many = rows.length > 1;
 return <section aria-label="Merge receipt" className="rv-merge" data-state={facts.status} aria-live="polite">
  <header className="rv-merge-head"><MergeChip tone={top.tone}>{top.chip}</MergeChip><h2 className="rv-merge-state">{top.title}</h2><p>{top.lede} <span className="rv-merge-muted">Updated <Clock at={facts.updatedAt} />.</span></p></header>
  {check && <ThreeParts happened={<>Rovara sent a merge and has no clear answer for {rows.filter(row => row.attempt === "unknown" || row.attempt === "in_flight").length > 0 ? "at least one pull request" : "this request"}.</>}
   safe={<>Rovara will not send another merge for this request. Reading from GitHub changes nothing. Nothing was deployed.</>} next={onCheck === undefined ? <>Reload this page in a moment, or open the pull request on GitHub.</> : <>Ask GitHub now.</>} />}
  <ol className="rv-merge-prs" aria-label="Pull requests">{rows.map((row, index) => <Row key={label(row)} row={row} facts={facts} index={index} many={many} />)}</ol>
  {check && onCheck !== undefined && <div className="rv-merge-actions"><Button busy={checking} onClick={onCheck}>Check GitHub now</Button><span className="rv-merge-muted">Check reads the saved pull requests. It never merges.</span></div>}
 </section>;
}
