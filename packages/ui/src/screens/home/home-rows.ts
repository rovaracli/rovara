import { TaskStatusReaderSchema, decisionTaskSessionOf, taskStatusFromSession } from "@agentx/cloud-contracts/web";
import type { ReadDecision } from "../../api/decisions.js";
import type { ReadHomeCard } from "../../api/home.js";
import type { ReadFinishedSession } from "../../api/home-finished.js";
import type { ReadLiveTile } from "../../api/live.js";
import type { ReadAgent } from "../../api/agents.js";
import { plainState, type LeadStatus, type PlainState } from "../session/task-plain-state.js";

/**
 * Experience lane exp/home: what the new Home shows, as plain rows, from data the app already reads. Pure: nothing here reads the network. Every state is a plain word from the
 * merged plain-state table (`task-plain-state.ts`); no raw status code, kind or model id reaches a row. Where the data cannot say a thing (who acts next), the row says nothing.
 */

/** Continue and Finished recently each show at most this many rows (the full lists are in Work). */
export const HOME_LIST_MAX = 5;
/** The agents row shows at most this many. */
export const HOME_AGENTS_MAX = 4;

export interface HomeRow {
 key: string;
 title: string;
 state: PlainState;
 /** The one line that says why it is here (Needs you) or where it stands (Continue). */
 line: string | undefined;
 /** Who acts next and what happens, only where the data says it. */
 next: string | undefined;
 meta: string[];
 at: string | undefined;
}

/** The status a home card's kind means, in the one status model. A kind this build does not know reads as a decision (the safe side: it asks the person). */
const CARD_STATE: Readonly<Record<string, string>> = {
 approval: "needs_you", spend_request: "paused_budget", paused: "paused_budget", question: "needs_you", plan: "needs_you", failure: "failed", blocked: "needs_you",
 offer: "needs_you", rule_suggestion: "needs_you", waiting_ticket: "needs_you", intake_source: "needs_you", lesson_waiting: "needs_you",
};
/** A pull request card says the change waits for a review (the broker's own words: "waiting for review", "ready for review"); it never says it can be merged. */
const NEEDS_REVIEW: PlainState = { label: "Needs review", tone: "attention" };
export function homeCardState(kind: string): PlainState { return kind === "pull_request" ? NEEDS_REVIEW : plainState({ state: CARD_STATE[kind] ?? "needs_you" }, undefined); }

/** A decision card's plain state: a merge waits to be merged; every other card is a decision. */
export function decisionState(card: { kind: string }): PlainState { return plainState({ state: card.kind === "merge" ? "ready_to_merge" : "needs_you" }, undefined); }

/** The session a decision card is about, from its own "Open" link. */
export function decisionSession(decision: ReadDecision): string | undefined {
 const open = decision.card.actions.find(action => action.kind === "open" && action.method === "GET");
 return open === undefined ? undefined : decisionTaskSessionOf(open.href);
}

/** The sessions Needs you already holds: Continue never lists them a second time. */
export function needsYouSessions(cards: readonly ReadHomeCard[], decisions: readonly ReadDecision[]): Set<string> {
 const found = new Set<string>();
 for (const card of cards) if (typeof card.sessionId === "string") found.add(card.sessionId);
 for (const decision of decisions) { const session = decisionSession(decision);if (session !== undefined) found.add(session); }
 return found;
}

const sentence = (value: string): string => { const text = value.replace(/[.\s]+$/u, "");return text === "" ? text : text[0]!.toUpperCase() + text.slice(1); };
const AUTOMATIC = new Set(["understanding", "planning", "reviewing_design", "building", "checking"]);

/** The status of a session row: its summary's own (`display`) when it has one, else what its plain status says. */
export function rowStatus(summary: { status: string; lastRunFailed?: true | undefined; display?: unknown }): LeadStatus {
 const parsed = TaskStatusReaderSchema.safeParse(summary.display);
 if (parsed.success) { const data = parsed.data as LeadStatus;return { state: data.state, reason: data.reason, next: data.next, nextOthers: data.nextOthers, retryable: data.retryable === true }; }
 return taskStatusFromSession({ status: summary.status, ...(summary.lastRunFailed === true ? { lastRunFailed: true as const } : {}) });
}

/** Who acts next, only where the status says it: Rovara while it works on its own, or the status's own next-step words. Nothing otherwise. */
export function nextLine(status: LeadStatus): string | undefined {
 if (AUTOMATIC.has(status.state)) return "Rovara is on it";
 return status.next === undefined || status.next === "" ? undefined : sentence(status.next);
}

const unique = (items: readonly (string | undefined)[]): string[] => items.filter((item): item is string => item !== undefined && item !== "");

/** My open work that is running or waiting on others, newest first, never one Needs you holds. */
export function continueRows(tiles: readonly ReadLiveTile[], held: ReadonlySet<string>, max = HOME_LIST_MAX): Array<HomeRow & { sessionId: string; agentId: string | undefined }> {
 return tiles.filter(tile => !tile.needsYou && !held.has(tile.sessionId)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, max).map(tile => {
  const status = rowStatus({ status: tile.status, ...(tile.lastRunFailed === true ? { lastRunFailed: true as const } : {}) });
  return { key: tile.sessionId, sessionId: tile.sessionId, agentId: tile.agent?.agentId, title: tile.title, state: plainState(status, undefined), line: undefined, next: nextLine(status), meta: unique([tile.project, tile.agent?.name]), at: tile.updatedAt };
 });
}

/** My recently ended work, newest first. A session that ended with no status words of its own reads "Finished" (a plain "Closed" would hide that it went well). */
export function finishedRows(sessions: readonly ReadFinishedSession[], max = HOME_LIST_MAX): Array<HomeRow & { sessionId: string; agentId: string | undefined }> {
 return sessions.slice(0, max).map(tile => {
  const status = rowStatus(tile.summary), plain = plainState(status, undefined);
  const state: PlainState = status.state === "closed" && tile.summary.status === "succeeded" && TaskStatusReaderSchema.safeParse(tile.summary.display).success === false ? { label: "Finished", tone: "success" } : plain;
  return { key: tile.sessionId, sessionId: tile.sessionId, agentId: tile.agent?.agentId, title: tile.title, state, line: undefined, next: undefined, meta: unique([tile.project, tile.agent?.name]), at: tile.endedAt ?? tile.updatedAt };
 });
}

export interface HomeAgent { agentId: string; name: string; note: string; recent: boolean }
/**
 * The agents row: the agents the person used most recently first (read from their own recent work), then the directory's first ones, up to `max`. Only agents the directory lists, active and
 * not disabled, so a link never leads to a gone agent. A person with no history sees the directory's first few.
 */
export function pickAgents(directory: readonly ReadAgent[], recentIds: readonly string[], max = HOME_AGENTS_MAX): HomeAgent[] {
 const usable = directory.filter(agent => agent.status === "active" && agent.disabled !== true), byId = new Map(usable.map(agent => [agent.agentId, agent]));
 const recent = [...new Set(recentIds)].flatMap(id => { const agent = byId.get(id);return agent === undefined ? [] : [agent]; });
 const seen = new Set(recent.map(agent => agent.agentId)), rest = usable.filter(agent => !seen.has(agent.agentId));
 return [...recent.map(agent => ({ agent, recent: true })), ...rest.map(agent => ({ agent, recent: false }))].slice(0, max).map(({ agent, recent }) => ({ agentId: agent.agentId, name: agent.name, note: recent ? "Used recently" : agent.description, recent }));
}
