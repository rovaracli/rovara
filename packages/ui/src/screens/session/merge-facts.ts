import { actionLock, basisOf, sameItems, itemsBound, type LockKind } from "../../safe-action.js";
export type { LockKind } from "../../safe-action.js";
import type { MergeReadiness } from "../../api/session-actions.js";
import type { ReadTask } from "./workspace-types.js";

/**
 * What the Merge section may say about each pull request, from facts the page is already served: Code's merge tracking (what GitHub said when Code last read it), the task's pull request list and the
 * readiness read (Code's answer for this person, built from its stored tracking: not a live GitHub read, so it is never labelled as one). Nothing here is a receipt: a pull request GitHub shows as merged is an observation, never "merged by this request". The receipt facts the
 * reader will serve (CONTRACTS R1a) are not read here; their held presentation (MergeReceiptView) is kept on branch held/merge-receipt-view until the receipt reader exists.
 */
export type TrackedPull = NonNullable<ReadTask["mergeTracking"]>[number];
export type MergeTone = "ok" | "wait" | "bad" | "idle" | "run";
export interface Fact { tone: MergeTone; words: string }

export const pullKey = (repositoryId: string, number: number): string => repositoryId + "#" + String(number);
export const shortSha = (sha: string): string => sha.slice(0, 7);

const BRANCH_WORDS: Record<string, Fact> = {
 up_to_date: { tone: "ok", words: "Up to date with its base" },
 behind: { tone: "wait", words: "Behind its base" },
 conflicted: { tone: "bad", words: "Conflicts with its base" },
 unknown: { tone: "idle", words: "Not read yet" },
};

/** Checks: passed, failed, still running and "none to wait for" are four different things; none is never worded as a pass. */
export function checksFact(item: TrackedPull): Fact {
 if (item.ci === "passing") return { tone: "ok", words: "Passed" };
 if (item.ci === "failing") return { tone: "bad", words: item.failingChecks.length === 0 ? "Failed" : "Failed: " + item.failingChecks.join(", ") };
 if (item.ci === "pending") return { tone: "run", words: "Still running, not in yet" };
 return { tone: "idle", words: "None to wait for" };
}

/** Review: an approval of an earlier head is shown as that, not as an approval of the code GitHub would merge. */
export function reviewFact(item: TrackedPull): Fact {
 if (item.review === "approved") {
  if (item.approval === undefined) return { tone: "ok", words: "Approved" };
  return item.approval.commitId === item.headSha ? { tone: "ok", words: "Approved by " + item.approval.login } : { tone: "wait", words: "Approved by " + item.approval.login + " on an earlier head; GitHub decides whether it still counts" };
 }
 if (item.review === "changes_requested") return { tone: "bad", words: "A reviewer asked for changes" };
 return item.review === "requested" ? { tone: "wait", words: "Review requested" } : { tone: "idle", words: "Not reviewed yet" };
}

export const branchFact = (item: TrackedPull): Fact => BRANCH_WORDS[item.branch] ?? BRANCH_WORDS.unknown!;

export interface PullRow {
 key: string;
 number: number;
 label: string;
 state: "open" | "closed" | "merged" | "unknown";
 /** A github.com link Code sent for it (the caller still passes it through safeExternalUrl). */
 url: string | undefined;
 tracked: TrackedPull | undefined;
 /** The head GitHub had when Code last read it for tracking; the head every check and review shown was read for. */
 checkedHead: string | undefined;
 /** The head in the readiness answer. Code builds it from its stored tracking, so it carries no observation time of its own: it is never shown as a fresh GitHub read. */
 githubHead: string | undefined;
 /** Both heads are known and differ: nothing shown for the checked head counts for what GitHub would merge. */
 drift: boolean;
}

type Pulls = NonNullable<ReadTask["pullRequests"]>;

/** One row per pull request, from tracking first (in Code's order), then any open pull request tracking has not read yet. */
export function pullRowsOf(task: ReadTask, readiness: MergeReadiness | undefined): PullRow[] {
 const pulls: Pulls = task.pullRequests ?? [], heads = new Map((readiness?.heads ?? []).map(head => [pullKey(head.repositoryId, head.number), head.headSha] as const));
 const readinessUrls = new Map((readiness?.pullRequests ?? []).map(pull => [pullKey(pull.repositoryId, pull.number), pull.url] as const));
 const rows: PullRow[] = [], seen = new Set<string>();
 for (const item of task.mergeTracking ?? []) {
  const key = pullKey(item.repositoryId, item.number);
  if (seen.has(key)) continue;
  seen.add(key);
  const pull = pulls.find(candidate => candidate.repository === item.repositoryId && candidate.number === item.number);
  const githubHead = item.state === "open" ? heads.get(key) : undefined;
  rows.push({ key, number: item.number, label: item.repositoryId + " #" + String(item.number), state: item.state, url: pull?.url ?? readinessUrls.get(key), tracked: item, checkedHead: item.headSha, githubHead, drift: githubHead !== undefined && githubHead !== item.headSha });
 }
 for (const pull of pulls) {
  const key = pullKey(pull.repository, pull.number);
  if (seen.has(key) || pull.state === "closed") continue;
  seen.add(key);
  rows.push({ key, number: pull.number, label: pull.repository + " #" + String(pull.number), state: pull.state, url: pull.url, tracked: undefined, checkedHead: undefined, githubHead: undefined, drift: false });
 }
 return rows;
}

/** What the person saw when they opened the confirmation: the exact heads sent with the press, and each tracked head and review digest. */
export interface Shown { heads: MergeReadiness["heads"]; risk: MergeReadiness["risk"]; tracked: Array<{ key: string; head: string; digest: string }> }

export function shownOf(rows: readonly PullRow[], readiness: MergeReadiness | undefined): Shown {
 return { heads: readiness?.heads, risk: readiness?.risk, tracked: rows.flatMap(row => row.tracked === undefined || row.state !== "open" ? [] : [{ key: row.key, head: row.tracked.headSha, digest: row.tracked.decisionDigest }]) };
}

const headsKey = (heads: MergeReadiness["heads"]): string => (heads ?? []).map(head => pullKey(head.repositoryId, head.number) + "@" + head.headSha).sort().join(",");

/** True once anything the person was shown no longer matches: a head moved on GitHub, or the review facts (the decision digest) changed. A changed page is read again, never pressed. */
export function changedSince(shown: Shown, rows: readonly PullRow[], readiness: MergeReadiness | undefined): boolean {
 if (headsKey(shown.heads) !== headsKey(readiness?.heads)) return true;
 if (shown.risk !== readiness?.risk) return true;
 const now = shownOf(rows, readiness).tracked;
 return !sameItems(shown.tracked, now, item => JSON.stringify([item.key, item.head, item.digest]));
}

/** Why Merge is locked, in the words the board gives, or undefined when nothing here locks it (Code's own answer still decides whether it may be pressed). */
export interface Lock { kind: LockKind; words: string }
export function lockOf(input: { unresolved: boolean; identityUnread?: boolean; storage?: "unavailable" | "unreadable"; rows: readonly PullRow[]; readiness: MergeReadiness | undefined }): Lock | undefined {
 const kind = actionLock({ ...input, drift: input.rows.some(row => row.drift), ready: input.readiness?.ready === true });
 if (kind === "identity") return { kind: "identity", words: "Locked until Rovara has read who you are." };
 if (kind === "storage") return { kind: "storage", words: input.storage === "unreadable" ? "Locked: a saved merge request in this browser can't be read. Merge it on GitHub." : "Locked: this browser's storage can't be read, so Rovara can't be sure an earlier merge wasn't sent. Merge it on GitHub, or allow site storage and reload." };
 if (kind === "unresolved") return { kind: "unresolved", words: "Locked: the result of your earlier merge isn't confirmed. Rovara won't send another one until it is answered." };
 if (kind === "drift") return { kind: "drift", words: "Locked: Rovara's latest read shows a different head than the one that was checked." };
 if (kind === "not_ready") return { kind: "not_ready", words: "Locked until Code says this is ready to merge." };
 return undefined;
}

/**
 * A readiness answer binds a press to what the person saw only when its heads name EXACTLY the pull requests it would merge, once each, with at least one (a shape with no heads, a missing head, a duplicate or an extra head
 * binds nothing). Anything else is not offered in the app: the page falls back to the GitHub path (P1-5).
 */
export function headsBound(view: MergeReadiness): boolean {
 const heads = (view.heads ?? []).map(head => pullKey(head.repositoryId, head.number)), pulls = view.pullRequests.map(pull => pullKey(pull.repositoryId, pull.number));
 return itemsBound(heads, pulls);
}

/**
 * What a readiness answer was read for: the task's status and stage, its pull request set, and each pull request's state, head, review digest and the facts the digest stands for. Any change makes the readiness read under the
 * old basis inert: the page keys its readiness read by this, so only a read issued after the change can offer or send a merge (P1-3). Observation times are left out on purpose: a refresh that changes nothing meaningful reads nothing.
 */
export function taskBasisOf(task: ReadTask): string {
 const rows = pullRowsOf(task, undefined).map(row => { const item = row.tracked; return [row.key, row.state, item?.headSha ?? "", item?.decisionDigest ?? "", item?.draft === true ? "draft" : "", item?.ci ?? "", item?.failingChecks.join("+") ?? "", item?.review ?? "", item?.branch ?? ""].join(":"); });
 return basisOf([task.status, task.workflow?.stage ?? "", task.workflow?.state ?? "", task.merge?.risk?.level ?? "", ...rows]);
}

/**
 * Code's merge body is strict and REQUIRES the risk level the person saw, so an answer is offered in the app only when it also names one (with the heads it must bind). Without it the page falls back to GitHub.
 */
export const pressBound = (view: MergeReadiness): boolean => headsBound(view) && view.risk !== undefined;

export const pullsMergedOf = (rows: readonly PullRow[]): PullRow[] => rows.filter(row => row.state === "merged");
