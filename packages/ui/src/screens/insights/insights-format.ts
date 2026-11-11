// Plain words and arithmetic for the Insights screens. No server rule lives here: this only turns what the reads return into sentences to show.
import type { Coverage, NextActor, PanelStatus, StuckItem } from "../../api/insights.js";

/** "2026-11-16T00:00:00.000Z" as "Nov 16, 2026" (UTC, so a date never moves with the device's zone). */
export function dateWords(value: string | null | undefined): string {
 const time = value === null || value === undefined ? Number.NaN : Date.parse(value);
 return Number.isFinite(time) ? new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "an unknown date";
}
/** "2026-11-09" (a Monday) as "Nov 9". */
export function weekWords(weekStart: string): string {
 const time = Date.parse(weekStart + "T00:00:00.000Z");
 return Number.isFinite(time) ? new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : weekStart;
}
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
/** How long something has waited: under an hour, hours up to two days, then days. */
export function ageWords(hours: number): string {
 if (!(hours >= 1)) return "Under an hour";
 if (hours < 48) return plural(Math.floor(hours), "hour", "hours");
 return plural(Math.floor(hours / 24), "day", "days");
}
/** A duration figure from the flow read: minutes under an hour, hours under two days, then days with one decimal at most. */
export function durationWords(hours: number): string {
 if (hours < 1) return plural(Math.max(1, Math.round(hours * 60)), "minute", "minutes");
 if (hours < 48) return `${String(Math.round(hours * 10) / 10)} hours`;
 return `${String(Math.round((hours / 24) * 10) / 10)} days`;
}
/** What the age is measured from. The server says "last_update" until it records when the state began; the label says so honestly. */
export function sinceWords(kind: StuckItem["sinceKind"]): string { return kind === "state" ? "in this state" : "since the last update"; }
export function rateWords(part: number, of: number): string {
 if (of <= 0) return "Not enough work yet";
 return `${String(part)} of ${String(of)} (${String(Math.round((part / of) * 100))}%)`;
}
const ROLES: Record<string, string> = { approver: "approver", reviewer: "reviewer", owner: "owner", maintainer: "maintainer", admin: "admin", collaborator: "collaborator" };
/** Who the work waits on, in words. A person or group shows its NAME (decision 91, 2026-11-11: names are shown, content is hidden). `kind: "unknown"` is a normal answer today. */
export function nextActorWords(actor: NextActor): string {
 const role = actor.role !== undefined && Object.hasOwn(ROLES, actor.role) ? ROLES[actor.role]! : undefined;
 switch (actor.kind) {
  case "person": return actor.name !== undefined ? (role === undefined ? actor.name : `${actor.name} (${role})`) : role === undefined ? "A person" : `A person (${role})`;
  case "group": return actor.name !== undefined ? `${actor.name} (a group)` : "A group";
  case "role": return role === undefined ? "Someone in a role" : `${/^[aeiou]/u.test(role) ? "An" : "A"} ${role}`;
  case "rovara": return "Rovara";
  default: return "Not known yet";
 }
}
const KIND_WORDS: Record<string, string> = { person: "A person", group: "A group", role: "Someone in a role", rovara: "Rovara", unknown: "Not known yet" };
export function actorKindWords(kind: string): string { return Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind]! : "Not known yet"; }
const BLOCKERS: Record<string, string> = { decision: "A decision", approval: "An approval", spend: "Spending", review: "A review", merge: "A merge", budget: "Budget", failure: "A failure", setup: "Setup", unknown: "Not known yet" };
export function blockerWords(blocker: string): string { return Object.hasOwn(BLOCKERS, blocker) ? BLOCKERS[blocker]! : "Something else"; }
const NOT_COVERED: Record<string, string> = { change_approvals: "change approvals", plan_reviews: "plan reviews", merge_readiness: "merge readiness", handoff_blockers: "hand-off blockers" };
/** "Does not include: plan reviews, merge readiness" (a fixed word the server adds that this screen does not know is shown as "other sources"). */
export function notCoveredWords(coverage: Coverage): string | undefined {
 if (coverage.notCovered.length === 0) return undefined;
 const words = [...new Set(coverage.notCovered.map(word => Object.hasOwn(NOT_COVERED, word) ? NOT_COVERED[word]! : "other sources"))];
 return `Does not include: ${words.join(", ")}.`;
}
/** Order: the longest wait first (the server sorts by `since` already; this keeps the order after pages are joined). */
export function byAge(items: readonly StuckItem[]): StuckItem[] {
 return [...items].sort((a, b) => b.ageHours - a.ageHours || Date.parse(a.since) - Date.parse(b.since));
}
/** The honest line for a panel whose numbers are not there yet. Never zero. `now` is the server's own clock (`asOf`) so the "days so far" does not depend on this device. */
export function notReadyWords(status: PanelStatus, collectingSince: string | null | undefined, now: number): string {
 if (status === "collecting") {
  const start = collectingSince === null || collectingSince === undefined ? Number.NaN : Date.parse(collectingSince);
  if (!Number.isFinite(start)) return "Collecting data. Numbers appear once Rovara has recorded enough work.";
  if (start > now) return `Collecting data starts ${dateWords(collectingSince)}. Numbers appear after that.`;
  const days = Math.max(0, Math.floor((now - start) / 86_400_000));
  return `Collecting data since ${dateWords(collectingSince)}: ${plural(days, "day", "days")} so far.`;
 }
 return "Not available yet.";
}
/** The last `count` months (UTC), newest first, as YYYY-MM, counted back from `now`. */
export function recentMonths(now: number, count: number): string[] {
 const date = new Date(now), months: string[] = [];
 for (let step = 0; step < count; step++) { const at = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - step, 1));months.push(`${String(at.getUTCFullYear())}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`); }
 return months;
}
/** A bar's width as a percent of the largest value; at least 2 for a real non-zero value so it stays visible. */
export function barPercent(value: number, max: number): number {
 if (!(max > 0) || !(value > 0)) return 0;
 return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}
