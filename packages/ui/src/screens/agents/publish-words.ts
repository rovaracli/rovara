import type { PublishTarget, ReadAgentCard, ReadAgentSummary, ReadPublication, ReadPublishRequest } from "../../api/agent-publish.js";
/**
 * The plain words of agent publishing, in one place: what a target is called, what approving does, what the state of a request is, why a card is shown. Pure (nothing here reads the network), so the words are tested
 * without a screen. Anything the server says in its own fixed sentence (the request's `effect`, a refusal) is shown as it is; these are only the words this app adds.
 */
/** A target as a reader gives it: a kind this build does not know reads as "unknown", and says nothing specific. */
export type ReadTarget = { kind: string; project?: unknown };
export function knownTarget(target: ReadTarget): PublishTarget | undefined {
 if (target.kind === "company") return { kind: "company" };
 return target.kind === "project" && typeof target.project === "string" && target.project !== "" ? { kind: "project", project: target.project } : undefined;
}
export const targetName = (target: ReadTarget): string => { const known = knownTarget(target);return known === undefined ? "another place" : known.kind === "company" ? "the whole company" : "the " + known.project + " project"; };
export const targetShort = (target: ReadTarget): string => { const known = knownTarget(target);return known === undefined ? "Another place" : known.kind === "company" ? "Company" : known.project; };
export function targetKey(target: ReadTarget): string | undefined { const known = knownTarget(target);return known === undefined ? undefined : known.kind === "company" ? "company" : "project:" + known.project; }
export function parseTargetKey(value: string): PublishTarget | undefined {
 if (value === "company") return { kind: "company" };
 return value.startsWith("project:") && value.length > 8 ? { kind: "project", project: value.slice(8) } : undefined;
}

/** What approving does, said before anything is asked (owner decision 91): a project request MOVES the agent to the project and a maintainer there becomes accountable. */
export function askEffect(agentName: string, target: PublishTarget): string {
 return target.kind === "project"
  ? `If this is approved, ${agentName} moves to the ${target.project} project. A maintainer there becomes accountable for it, and you keep edit access so you can keep improving it. If you maintain ${target.project} yourself, it happens right away.`
  : `If this is approved, everyone in your company can use ${agentName}. You stay its owner. Only an admin can approve this, on a confirmation page after signing in again.`;
}

/** The profile's publication line: who can use the agent. */
export function publicationLine(publication: ReadPublication): string {
 if (publication.level === "company") return "Company";
 if (publication.level === "project") return publication.projects.length === 0 ? "A project" : publication.projects.length === 1 ? publication.projects[0]! + " project" : publication.projects.join(", ") + " projects";
 return "Only you";
}
/** Who a waiting request waits for. */
export function waitingLine(target: ReadTarget): string { const known = knownTarget(target);return known === undefined ? "Waiting for an approver" : known.kind === "company" ? "Waiting for an admin" : `Waiting for a ${known.project} maintainer`; }

export const STATE_WORDS: Readonly<Record<string, string>> = { pending: "Waiting", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn", expired: "Expired", stale: "Out of date", failed: "Could not be applied" };
export const stateWords = (state: string): string => STATE_WORDS[state] ?? "Unknown";

/** Why a person cannot decide a waiting request, in plain words. */
export function cannotDecideLine(request: Pick<ReadPublishRequest, "approval" | "target">): string | undefined {
 const known = knownTarget(request.target);
 switch (request.approval.reason) {
  case "you_requested": return "You asked for this, so someone else decides.";
  case "not_a_maintainer": return known?.kind === "project" ? `Only a maintainer of ${known.project} can decide this.` : "Only a maintainer can decide this.";
  case "not_an_admin": return "Only an admin can decide this.";
  case "stale": return "The agent changed after this was asked. Ask again.";
  case "expired": return "This request ran out of time. Ask again.";
  default: return undefined;
 }
}
export const STALE_LINE = "The agent changed after this was asked. Ask again.";

/** The line under a request that is no longer waiting. */
export function outcomeLine(request: Pick<ReadPublishRequest, "state" | "decidedBy" | "declineReason" | "failureText">): string | undefined {
 const by = request.decidedBy === null ? undefined : request.decidedBy.name;
 switch (request.state) {
  case "approved": return by === undefined ? "Approved" : "Approved by " + by;
  case "declined": return (by === undefined ? "Declined" : "Declined by " + by) + (typeof request.declineReason === "string" && request.declineReason !== "" ? ": " + request.declineReason : "");
  case "withdrawn": return "Withdrawn by the person who asked";
  case "expired": return "Nobody decided it in time";
  case "stale": return STALE_LINE;
  case "failed": return typeof request.failureText === "string" && request.failureText !== "" ? request.failureText : "Approved, but the change could not be applied";
  default: return undefined;
 }
}

/** The small label under an agent card that says why it is there. A reason this build does not know says nothing. */
export const REASON_WORDS: Readonly<Record<string, string>> = { favourite: "Your favourite", project_roster: "On this project's roster", used_by_you: "You use this", starter: "Starter", popular_in_company: "Popular in your company" };
export const reasonLabel = (reason: string): string | undefined => REASON_WORDS[reason];

const AUTONOMY: Readonly<Record<string, string>> = { suggest: "Suggest", prepare: "Prepare", run: "Run" };
const TRIGGERS: Readonly<Record<string, string>> = { manual: "Started by a person", schedule: "On a schedule", event: "When something happens" };
const ACCESS: Readonly<Record<string, string>> = { read: "read", read_write: "read and write" };
export interface SummaryLine { label: string; value: string }
/** What the approver is told this agent can do, as label and value lines in the order of the doc (steps, tools and access, autonomy, triggers, skills, builds on). Budgets are shown as money by the screen. */
export function summaryLines(summary: ReadAgentSummary): SummaryLine[] {
 const lines: SummaryLine[] = [{ label: "Steps", value: String(summary.steps) }];
 lines.push({ label: "Tools and access", value: summary.tools.length === 0 ? "No connector tools" : summary.tools.map(tool => `${tool.connector}: ${ACCESS[tool.access] ?? "access unavailable"}`).join("; ") });
 lines.push({ label: "Autonomy", value: AUTONOMY[summary.autonomy] ?? "Unavailable" });
 lines.push({ label: "Starts", value: summary.triggers.length === 0 ? "Not set" : summary.triggers.map(trigger => TRIGGERS[trigger] ?? "Another way").join("; ") });
 lines.push({ label: "Skills", value: String(summary.skills) });
 if (summary.extends !== undefined) lines.push({ label: "Builds on", value: `${summary.extends.agentId} version ${String(summary.extends.version)}` });
 return lines;
}

/** Favourites first, then suggestions that are not already favourites. */
export function dedupeSuggested(favourites: readonly ReadAgentCard[], suggested: readonly ReadAgentCard[]): ReadAgentCard[] {
 const have = new Set(favourites.map(card => card.agentId));
 return suggested.filter(card => !have.has(card.agentId));
}

/** The favourites list after one agent is added (at the end) or removed. */
export function toggledFavourites(current: readonly string[], agentId: string): string[] { return current.includes(agentId) ? current.filter(id => id !== agentId) : [...current, agentId]; }
