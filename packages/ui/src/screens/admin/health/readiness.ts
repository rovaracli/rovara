// The Health and readiness rules (lane exp/health-readiness; switch `rovara.health` = "v2"). Pure functions: reads in, rows out. No React, no broker.
// One rule runs through all of it: GREEN NEEDS AN OBSERVATION. A row is Healthy only when a read shows something was seen working (a passed check, a status the vendor reported).
// A configured thing that nothing has checked is Unknown, a read that was refused or failed is Unknown, and an observation with no recorded time, a time in the future, or a time older than
// CHECK_STALE_DAYS (measured against the clock) is Unknown ("check it again"). Only the two rows the broker computes live at read time (service qualification, team record delete check) take the read time.
// The GitHub, Slack and AI model rows also take the broker's "health observations" (when each check last ran and what it found): Healthy only with a fresh passing observation, Action needed for a failing one,
// Unknown with none, a stale one, a future one or one that could not tell. Its ages are the broker's, plus the time since the page read them.
import type { HealthModelUseObservation, OrgHealthObservationsResponse, OrgServiceStatus } from "@agentx/cloud-contracts/web";
import type { Read, ReadinessApprovals, ReadinessConnection, ReadinessDesignReview, ReadinessFeatures, ReadinessProject, ReadinessReads, ReadinessSpendRequest } from "../../../api/readiness.js";
import type { LessonCompanyPreset } from "../../../api/lessons.js";
import { githubSummary } from "../connections/connection-state.js";
import { requestKindWords } from "../spending-format.js";

export type Status = "healthy" | "action" | "unknown";
/** `checking`: its read has not come back yet. Never a final answer. */
export type RowStatus = Status | "checking";
export const STATUS_WORDS: Readonly<Record<RowStatus, string>> = { healthy: "Healthy", action: "Action needed", unknown: "Unknown", checking: "Checking" };
/** A manual check older than this no longer counts as an observation of today. */
export const CHECK_STALE_DAYS = 7;
const DAY = 86_400_000;
/** How far ahead of the clock a recorded time may be (clock skew) before it is not believed. */
export const FUTURE_SLACK_MS = 5 * 60_000;
export type Freshness = "fresh" | "stale" | "future" | "none";
/** Whether a recorded observation time still counts: it must exist, not be in the future, and be at most CHECK_STALE_DAYS old. */
export function freshness(at: string | undefined, now: number): Freshness {
 const time = at === undefined ? Number.NaN : Date.parse(at);
 if (!Number.isFinite(time) || time <= 0) return "none";
 if (time > now + FUTURE_SLACK_MS) return "future";
 return now - time > CHECK_STALE_DAYS * DAY ? "stale" : "fresh";
}

export interface Fix { /** What to do, in a sentence. */ text: string; /** The link's own words. */ label: string; /** An existing page of the app. */ to: string }
export interface ReadinessRow {
 id: string; title: string; status: RowStatus;
 /** One plain sentence on what was seen. */ line: string;
 /** Where the answer came from. */ source: string;
 /** When it was last checked, in words; or that no time is recorded. */ checked: string; checkedAt?: string;
 /** A second plain line, shown under `line` (the backup model line). */ note?: string;
 fix?: Fix;
 /** Raw facts behind the answer (provider names, model ids, stored words). Shown only under "Details". */ details: string[];
}
export const CONNECTIONS_PATH = "/app/admin/connections", HEALTH_PATH = "/app/admin/health", HOW_WE_WORK_PATH = "/app/admin/how-we-work", WAITING_PATH = "/app/admin/waiting", MODELS_PATH = "/app/admin/models/sources";
export const setupPath = (project: string) => `/app/onboard?project=${encodeURIComponent(project)}&step=setup`;
export const projectSourcesPath = (project: string) => `/app/projects/${encodeURIComponent(project)}?tab=sources`;

/** A time as the Health page says it, in UTC. Anything that is not a real time is "not recorded", never a guess. */
export function stamp(value: string | number | undefined): string | undefined {
 const time = typeof value === "number" ? value : value === undefined ? Number.NaN : Date.parse(value);
 return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : undefined;
}
const checkedAt = (value: string | undefined, verb = "Last checked"): { checked: string; checkedAt?: string } => { const words = stamp(value);return words === undefined ? { checked: "Check time not recorded" } : { checked: `${verb} ${words}`, checkedAt: value! }; };
/** How long ago, in words: "less than a minute ago", "5 minutes ago", "3 hours ago", "2 days ago". */
export function ago(ms: number): string {
 const minutes = Math.floor(Math.max(0, ms) / 60_000);
 if (minutes < 1) return "less than a minute ago";
 if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? "" : "s"} ago`;
 const hours = Math.floor(minutes / 60);
 if (hours < 24) return `${String(hours)} hour${hours === 1 ? "" : "s"} ago`;
 const days = Math.floor(hours / 24);
 return `${String(days)} day${days === 1 ? "" : "s"} ago`;
}
/**
 * What the broker's health observation says about one check. `loading`: not read yet. `unread`: the read was refused, missing or failed (rows stay as they were). `never`: no check on record.
 * `badtime` and `future`: a check with no readable time, or one dated ahead of the clock: not believed. `stale`: older than CHECK_STALE_DAYS. `ok`, `failed`, `unknown`: a fresh check and what it found.
 */
export type ObservedKind = "loading" | "unread" | "never" | "badtime" | "future" | "stale" | "ok" | "failed" | "unknown";
export interface Observed { kind: ObservedKind; /** Words for the row's time line. */ checked: string; checkedAt?: string; /** How old, in words (not for loading, unread, never, badtime or future). */ age?: string }
type ObservedFeature = "github" | "slack" | "modelSource";
/** The age shown is the broker's age at its read plus the time since this page read it, never the browser clock against the stored time. Freshness (future, stale) is judged against the clock, as for every other check. */
export function observe(read: Read<OrgHealthObservationsResponse>, feature: ObservedFeature, now: number): Observed {
 if (read.state === "loading") return { kind: "loading", checked: "Not yet" };
 if (read.state !== "ok") return { kind: "unread", checked: "Check time not recorded" };
 const item = read.data[feature];
 if (item === undefined || !item.checked) return { kind: "never", checked: "Never checked" };
 const elapsed = item.ageSeconds * 1000 + Math.max(0, now - read.at), age = freshness(item.checkedAt, now);
 if (age === "none") return { kind: "badtime", checked: "Check time not recorded" };
 if (age === "future") return { kind: "future", checked: "Check time not believed: it is dated in the future" };
 const words = ago(elapsed), base = { checked: `Checked ${words}`, checkedAt: item.checkedAt, age: words };
 return age === "stale" || elapsed > CHECK_STALE_DAYS * DAY ? { kind: "stale", ...base } : { kind: item.result, ...base };
}
const lastCheckDetail = (label: string, seen: Observed): string => `${label}: ${seen.age === undefined ? seen.checked : `${seen.age}${seen.checkedAt === undefined || stamp(seen.checkedAt) === undefined ? "" : ` (${stamp(seen.checkedAt)!})`}`}`;
/** What each kind of observation that is not a fresh pass says, after a thing that is configured. `what` names the check ("The last GitHub App check"). */
function notFresh(seen: Observed, what: string): string {
 switch (seen.kind) {
  case "never": return `${what} has never been run, so this can't be called healthy.`;
  case "badtime": return `${what} has no readable time, so this can't be called healthy.`;
  case "future": return `${what} is dated in the future, so it isn't believed and this can't be called healthy.`;
  case "stale": return `${what} was more than ${String(CHECK_STALE_DAYS)} days ago, so this can't be called healthy.`;
  case "unknown": return `${what} ran but couldn't tell, so this can't be called healthy.`;
  default: return `${what} is not known, so this can't be called healthy.`;
 }
}
const pending = (id: string, title: string, what: string): ReadinessRow => ({ id, title, status: "checking", line: `Checking ${what}.`, source: "Waiting for the read", checked: "Not yet", details: [] });
const worst = (a: Status, b: Status): Status => a === "action" || b === "action" ? "action" : a === "unknown" || b === "unknown" ? "unknown" : "healthy";

/** What a row says when its read did not give an answer. Always Unknown. */
function unread<T>(read: Read<T>, what: string, id: string, title: string, fix: Fix): ReadinessRow | undefined {
 switch (read.state) {
  case "ok": return undefined;
  case "loading": return { id, title, status: "checking", line: `Checking ${what}.`, source: "Waiting for the read", checked: "Not yet", details: [] };
  case "refused": return { id, title, status: "unknown", line: `Rovara wouldn't show ${what} to your account, so it can't be checked.`, source: "Rovara did not allow this read", checked: "Not checked", fix, details: ["The read was refused (not signed in, or not allowed)."] };
  case "missing": return { id, title, status: "unknown", line: `${what.charAt(0).toUpperCase()}${what.slice(1)} isn't available on this install.`, source: "This install does not answer this read", checked: "Not checked", details: ["The read answered not found."] };
  case "failed": return { id, title, status: "unknown", line: `Rovara couldn't read ${what} just now.`, source: "The read failed", checked: "Not checked", fix: { ...fix, text: "Check again in a moment." }, details: ["The read failed or was unreadable."] };
 }
}

// ---- code host

export function codeHostRow(reads: Pick<ReadinessReads, "github" | "githubRequests" | "observations" | "now">): ReadinessRow {
 const fix: Fix = { text: "Open the GitHub connection.", label: "Open GitHub connection", to: `${CONNECTIONS_PATH}?open=github` };
 const base = { id: "code-host", title: "Code host: GitHub" };
 const missing = unread(reads.github, "the GitHub connection", base.id, base.title, fix);
 if (missing !== undefined || reads.github.state !== "ok") return missing ?? { ...base, status: "unknown", line: "Unknown", source: "", checked: "", details: [] };
 const installs = reads.github.data;
 // The request list is optional detail: waiting for a GitHub admin only matters when nothing is installed.
 const requests = reads.githubRequests.state === "ok" ? reads.githubRequests.data : [];
 const summary = githubSummary(installs, requests);
 const details = installs.map(install => `${install.accountLogin}: ${install.status}`);
 if (summary.state !== "connected") return { ...base, status: "action", line: summary.why, source: "The GitHub app's status as GitHub last reported it to Rovara", checked: "Check time not recorded", fix: { text: summary.fix ?? fix.text, label: summary.state === "not_connected" ? "Connect GitHub" : "Fix GitHub", to: fix.to }, details };
 // The stored install status has no observation time (connectedAt is when it was connected, not when it was checked), so an active app is Healthy only when the broker's last GitHub App check is fresh and passed.
 const seen = observe(reads.observations, "github", reads.now);
 if (seen.kind === "loading") return pending(base.id, base.title, "when the GitHub App was last checked");
 if (seen.kind === "unread") return { ...base, status: "unknown", line: `${summary.why} Rovara records no time for that status, so this can't be called healthy.`, source: "The GitHub app's status as GitHub last reported it to Rovara", checked: "Check time not recorded", fix, details };
 const source = "The last GitHub App installed check (run when Rovara's health check runs), and the app's status as GitHub last reported it", seenDetails = [...details, lastCheckDetail("Last GitHub App check", seen)];
 const when = { checked: seen.checked, ...(seen.checkedAt === undefined ? {} : { checkedAt: seen.checkedAt }) };
 if (seen.kind === "ok") return { ...base, status: "healthy", line: `${summary.why} The last GitHub App check passed.`, source, ...when, details: seenDetails };
 if (seen.kind === "failed") return { ...base, status: "action", line: "The last check that the GitHub App is installed failed.", source, ...when, fix: { text: "Open the GitHub connection and fix or reinstall the app.", label: "Fix GitHub", to: fix.to }, details: seenDetails };
 return { ...base, status: "unknown", line: `${summary.why} ${notFresh(seen, "The last GitHub App check")}`, source, ...when, fix, details: seenDetails };
}

// ---- chat

export function chatRow(reads: Pick<ReadinessReads, "slack" | "observations" | "now">): ReadinessRow {
 const fix: Fix = { text: "Open the Slack connection.", label: "Open Slack connection", to: `${CONNECTIONS_PATH}?open=slack` };
 const base = { id: "chat", title: "Chat: Slack" };
 const missing = unread(reads.slack, "the Slack connection", base.id, base.title, fix);
 if (missing !== undefined) return missing;
 if (reads.slack.state !== "ok") return { ...base, status: "unknown", line: "Unknown", source: "", checked: "", details: [] };
 const data = reads.slack.data, when = checkedAt(data.checkedAt, "Stored associations read");
 const source = "The Slack workspace links Rovara has stored for this company";
 const details = [`${String(data.associationCount)} stored workspace links`, `${String(data.unavailableCount)} that could not be used`];
 if (data.unavailableCount > 0) return { ...base, status: "action", line: "Some of the Slack links Rovara stored can't be used.", source, ...when, fix: { text: "Open the Slack connection and see which link is broken.", label: fix.label, to: fix.to }, details };
 if (data.associationCount === 0) return { ...base, status: "unknown", line: "Slack isn't connected to this company, so there is nothing to check.", source, ...when, fix: { text: "Connect Slack if your team talks to Rovara in chat.", label: "Set up Slack", to: fix.to }, details };
 // Stored links are configuration: Healthy only when the broker's last live Slack check is fresh and passed.
 const seen = observe(reads.observations, "slack", reads.now);
 if (seen.kind === "loading") return pending(base.id, base.title, "when Slack was last checked");
 if (seen.kind === "unread") return { ...base, status: "unknown", line: "Slack is connected, but nothing shows it still works: Rovara has no live check of the chat connection yet.", source, ...when, fix: { text: "Open the Slack connection.", label: fix.label, to: fix.to }, details };
 const live = "The last live Slack check (a probe of Rovara's Slack token, run when Rovara's health check runs), and the workspace links Rovara has stored";
 const seenWhen = { checked: seen.checked, ...(seen.checkedAt === undefined ? {} : { checkedAt: seen.checkedAt }) }, seenDetails = [...details, `Stored workspace links read: ${stamp(data.checkedAt) ?? "time not recorded"}`];
 if (seen.kind === "ok") return { ...base, status: "healthy", line: "Slack is connected and its last live check passed.", source: live, ...seenWhen, details: seenDetails };
 if (seen.kind === "failed") return { ...base, status: "action", line: "The last live check of the Slack connection failed.", source: live, ...seenWhen, fix: { text: "Open the Slack connection and reconnect it.", label: fix.label, to: fix.to }, details: seenDetails };
 return { ...base, status: "unknown", line: `Slack is connected. ${notFresh(seen, "The last live Slack check")}`, source: live, ...seenWhen, fix: { text: "Open the Slack connection.", label: fix.label, to: fix.to }, details: seenDetails };
}

// ---- saved connections (tracker, monitoring, other tools)

export interface ConnectionVerdict { status: Status; line: string; checkedAt?: string }
/** One saved connection: Healthy only when its own last check passed, recently, and (for a tracker) Rovara can write back. */
export function connectionVerdict(connection: ReadinessConnection, now: number): ConnectionVerdict {
 if (connection.type !== "cloudwatch" && !connection.hasCredential) return { status: "action", line: "No key is saved for it." };
 const check = connection.lastCheck;
 if (check === undefined) return { status: "unknown", line: "It has never been checked." };
 if (!check.ok) return { status: "action", line: "Its last check failed.", checkedAt: check.at };
 if ((connection.type === "linear" || connection.type === "jira") && connection.ticketUpdates === "needs_write_access") return { status: "action", line: "It passed its last check, but Rovara can't write ticket updates back: it is read only.", checkedAt: check.at };
 switch (freshness(check.at, now)) {
  case "none": return { status: "unknown", line: "Its last check has no readable time." };
  case "future": return { status: "unknown", line: "Its last check is dated in the future, so it isn't believed." };
  case "stale": return { status: "unknown", line: `Its last check passed more than ${String(CHECK_STALE_DAYS)} days ago.`, checkedAt: check.at };
  default: return { status: "healthy", line: "Its last check passed.", checkedAt: check.at };
 }
}
const TRACKERS = new Set(["linear", "jira"]), MONITORING = new Set(["sentry", "datadog", "cloudwatch", "grafana", "vercel", "pagerduty"]);
const TYPE_WORDS: Readonly<Record<string, string>> = { linear: "Linear", jira: "Jira", sentry: "Sentry", datadog: "Datadog", cloudwatch: "Amazon CloudWatch", grafana: "Grafana", vercel: "Vercel", pagerduty: "PagerDuty", mcp: "Tool" };
export const connectionTypeWords = (type: string): string => Object.hasOwn(TYPE_WORDS, type) ? TYPE_WORDS[type]! : "Connection";

function groupRow(reads: Pick<ReadinessReads, "connections">, now: number, spec: { id: string; title: string; open: string; types: (type: string) => boolean; none: string; optional: boolean; connect: string; what: string }): ReadinessRow | undefined {
 const fix: Fix = { text: "Open the connection.", label: `Open ${spec.what}`, to: `${CONNECTIONS_PATH}?open=${spec.open}` };
 const missing = unread(reads.connections, "your saved connections", spec.id, spec.title, fix);
 if (missing !== undefined) return missing;
 if (reads.connections.state !== "ok") return undefined;
 const mine = reads.connections.data.filter(connection => spec.types(connection.type));
 if (mine.length === 0) return spec.optional ? undefined : { id: spec.id, title: spec.title, status: "unknown", line: spec.none, source: "The company's saved connections", checked: "Nothing to check", fix: { text: spec.connect, label: spec.connect, to: fix.to }, details: [] };
 const verdicts = mine.map(connection => ({ connection, verdict: connectionVerdict(connection, now) }));
 const status = verdicts.reduce<Status>((total, item) => worst(total, item.verdict.status), "healthy");
 const times = verdicts.flatMap(item => item.verdict.checkedAt === undefined ? [] : [item.verdict.checkedAt]).sort((a, b) => Date.parse(a) - Date.parse(b));
 const first = verdicts.find(item => item.verdict.status === status && status !== "healthy") ?? verdicts[0]!;
 const line = status === "healthy" ? (mine.length === 1 ? `${first.connection.label} passed its last check.` : `All ${String(mine.length)} connections passed their last check.`) : `${first.connection.label}: ${first.verdict.line}`;
 const when = times[0] === undefined ? { checked: "Never checked" } : checkedAt(times[0], mine.length > 1 ? "Oldest check" : "Last checked");
 const open = spec.id === "tracker" && first.connection.type === "jira" ? "jira" : spec.open;
 const fixFor: Fix = status === "healthy" ? fix : { text: status === "action" ? "Open it, fix what the check says, then press Check it works." : "Open it and press Check it works.", label: status === "action" ? `Fix ${spec.what}` : `Check ${spec.what}`, to: `${CONNECTIONS_PATH}?open=${open}` };
 return { id: spec.id, title: spec.title, status, line, source: "Each connection's own last \"Check it works\" result", ...when, ...(status === "healthy" ? {} : { fix: fixFor }), details: verdicts.map(item => `${connectionTypeWords(item.connection.type)}, ${item.connection.label}: ${item.verdict.line}`) };
}
export const trackerRow = (reads: Pick<ReadinessReads, "connections">, now: number) => groupRow(reads, now, { id: "tracker", title: "Tracker: Linear or Jira", open: "linear", types: type => TRACKERS.has(type), none: "No tracker is connected, so there is nothing to check.", optional: false, connect: "Connect a tracker", what: "tracker connection" })!;
export const monitoringRow = (reads: Pick<ReadinessReads, "connections">, now: number) => groupRow(reads, now, { id: "monitoring", title: "Cloud and monitoring tools", open: "cloud", types: type => MONITORING.has(type), none: "", optional: true, connect: "", what: "monitoring tools" });
export const toolsRow = (reads: Pick<ReadinessReads, "connections">, now: number) => groupRow(reads, now, { id: "tools", title: "Other tools", open: "tools", types: type => type === "mcp", none: "", optional: true, connect: "", what: "tools" });

// ---- model sources

const PROVIDERS: Readonly<Record<string, string>> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", bedrock: "Amazon Bedrock", endpoint: "a gateway endpoint" };
const FALLBACK_WORDS: Readonly<Record<string, string>> = { DEFAULT_MODEL_UNAVAILABLE: "the main model was unavailable", MODEL_CALL_REFUSED: "the main model refused the call", CHATGPT_PLAN_UNAVAILABLE: "the ChatGPT plan was unavailable", CONFIGURED_FALLBACK: "the company's settings call for a backup" };
/** A time of day in UTC, with the date when it is not today (UTC). */
function clockTime(iso: string, now: number): string {
 const time = Date.parse(iso);
 if (!Number.isFinite(time)) return "a time that isn't recorded";
 const day = (value: number) => new Date(value).toISOString().slice(0, 10), clock = new Date(time).toISOString().slice(11, 16);
 return `${day(time) === day(now) ? "" : `${new Date(time).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}, `}${clock} UTC`;
}
/** One plain sentence on whether Rovara used a backup model in the last 24 hours; model ids stay under Details. Nothing when no model-governed step has run (or the broker is older). */
export function fallbackLine(use: HealthModelUseObservation | undefined, now: number): string | undefined {
 if (use === undefined || !use.checked) return undefined;
 const reason = use.lastFallbackReason === undefined ? "" : ` (${Object.hasOwn(FALLBACK_WORDS, use.lastFallbackReason) ? FALLBACK_WORDS[use.lastFallbackReason] : "the main model could not be used"})`;
 if (use.usedFallback) return `Rovara used a backup model in the last ${String(use.windowHours)} hours${reason}${use.lastFallbackAt === undefined ? "" : `; last at ${clockTime(use.lastFallbackAt, now)}`}.`;
 return `Rovara did not need a backup model in the last ${String(use.windowHours)} hours${use.lastFallbackAt === undefined ? "" : `; the last time was ${clockTime(use.lastFallbackAt, now)}`}.`;
}
export function modelRow(reads: Pick<ReadinessReads, "sources" | "observations" | "now">): ReadinessRow {
 const fix: Fix = { text: "Open the AI provider connection.", label: "Open AI models", to: MODELS_PATH };
 const base = { id: "models", title: "AI models" };
 const missing = unread(reads.sources, "the AI model sources", base.id, base.title, fix);
 if (missing !== undefined) return missing;
 if (reads.sources.state !== "ok") return { ...base, status: "unknown", line: "Unknown", source: "", checked: "", details: [] };
 const sources = reads.sources.data.sources;
 const details = [...sources.map(item => `${item.label} (${Object.hasOwn(PROVIDERS, item.kind) ? PROVIDERS[item.kind] : item.kind}): ${item.kind === "bedrock" ? "set up outside Rovara" : item.hasCredential ? "key saved" : "no key saved"}; models: ${item.models.map(model => model.catalog.modelId).join(", ") || "none listed"}`)];
 const broken = sources.filter(item => item.kind !== "bedrock" && !item.hasCredential);
 const seen = observe(reads.observations, "modelSource", reads.now);
 const use = reads.observations.state === "ok" ? reads.observations.data.modelUse : undefined, backup = fallbackLine(use, reads.now);
 const note = backup === undefined ? {} : { note: backup };
 if (use?.checked === true) details.push(`Main model last used: ${use.lastMainAt === undefined ? "never recorded" : stamp(use.lastMainAt) ?? "time not recorded"}`, `Backup model last used: ${use.lastFallbackAt === undefined ? "never recorded" : stamp(use.lastFallbackAt) ?? "time not recorded"}`);
 const plain = "The company's saved AI providers. No read shows whether the main model answered or a fallback was used";
 const broken0 = broken[0];
 if (broken0 !== undefined) return { ...base, status: "action", line: `${broken0.label} has no key saved, so Rovara can't use it.`, source: seen.kind === "unread" ? plain : "The company's saved AI providers, the last Check of an AI provider, and which model answered in the last 24 hours", checked: seen.kind === "unread" || seen.kind === "loading" ? "Check time not recorded" : seen.checked, ...(seen.checkedAt === undefined ? {} : { checkedAt: seen.checkedAt }), ...note, fix: { text: "Add its key, or remove the provider.", label: "Fix AI provider", to: `${CONNECTIONS_PATH}?open=ai-provider` }, details };
 const own = sources.length === 0 ? "Work runs on Rovara's own models." : `${String(sources.length)} AI provider${sources.length === 1 ? " is" : "s are"} saved.`;
 if (seen.kind === "loading") return pending(base.id, base.title, "when the AI providers were last checked");
 if (seen.kind === "unread") return { ...base, status: "unknown", line: `${own} Rovara doesn't record whether the main model is in use or a fallback was used recently, so this can't be called healthy.`, source: plain, checked: "Check time not recorded", fix: { ...fix, text: "See the order your providers are tried in, and press Check it works on each." }, details };
 const source = "The last Check of an AI provider (the Check button on a provider), and which model answered in the last 24 hours", when = { checked: seen.checked, ...(seen.checkedAt === undefined ? {} : { checkedAt: seen.checkedAt }) };
 const seenDetails = [...details, lastCheckDetail("Last AI provider check", seen)];
 if (seen.kind === "ok") return { ...base, status: "healthy", line: `${own} The last check of an AI provider passed.`, source, ...when, ...note, details: seenDetails };
 if (seen.kind === "failed") return { ...base, status: "action", line: "The last check of an AI provider failed.", source, ...when, ...note, fix: { text: "Open the AI providers, press Check it works on each and fix the one that fails.", label: "Fix AI provider", to: MODELS_PATH }, details: seenDetails };
 return { ...base, status: "unknown", line: `${own} ${notFresh(seen, "The last check of an AI provider")}`, source, ...when, ...note, fix: { ...fix, text: "Press Check it works on each provider." }, details: seenDetails };
}

// ---- each project's environment check

export function projectRows(reads: Pick<ReadinessReads, "projects">, now: number): ReadinessRow[] {
 const fix: Fix = { text: "Open the project's connections page.", label: "Open projects", to: "/app/admin/projects" };
 const missing = unread(reads.projects, "the projects", "projects", "Project environments", fix);
 if (missing !== undefined) return [missing];
 if (reads.projects.state !== "ok") return [];
 return reads.projects.data.filter(project => project.status === "active").map(project => projectRow(project, now));
}
export function projectRow(project: ReadinessProject, now: number): ReadinessRow {
 const id = `project:${project.name}`, title = `Test environment: ${project.name}`, source = "The project's last environment check (setup and tests on a clean machine)";
 const to = setupPath(project.name), setup = project.setup;
 const when = checkedAt(setup.checkedAt);
 const details = [`Check state: ${setup.status}`, ...(setup.failedStep === undefined ? [] : [`Failed step: ${setup.failedStep}`])];
 switch (setup.status) {
  case "ready": {
   // A passed check counts only with a recorded time that is not in the future and not older than the age limit.
   const age = freshness(setup.checkedAt, now);
   if (age === "fresh") return { id, title, status: "healthy", line: "Setup and tests ran on a clean machine and passed.", source, ...when, details };
   const why = age === "none" ? "but Rovara recorded no time for that check" : age === "future" ? "but its time is in the future, so it isn't believed" : `but that was more than ${String(CHECK_STALE_DAYS)} days ago`;
   return { id, title, status: "unknown", line: `The last environment check passed, ${why}, so this can't be called healthy.`, source, ...when, fix: { text: "Run the check again.", label: "Check test setup", to }, details };
  }
  case "failed": return { id, title, status: "action", line: "The last environment check failed, so Rovara can't be sure work here will run.", source, ...when, fix: { text: "Open the project's test setup, fix the step that failed, and run the check again.", label: "Fix test setup", to }, details };
  case "checking": return { id, title, status: "unknown", line: "A check is running now.", source, ...when, details };
  case "outdated": return { id, title, status: "unknown", line: "The project's settings changed after the last check, so that check no longer counts.", source, ...when, fix: { text: "Run the check again.", label: "Check test setup", to }, details };
  default: return { id, title, status: "unknown", line: "This project's environment has never been checked.", source, checked: "Never checked", fix: { text: "Open the project's test setup and run the check.", label: "Check test setup", to }, details };
 }
}

// ---- team record and lessons

export function teamRecordRow(reads: Pick<ReadinessReads, "serviceStatus">): ReadinessRow {
 const fix: Fix = { text: "Open How we work, where the team record and lessons are set.", label: "Open How we work", to: HOW_WE_WORK_PATH };
 const base = { id: "team-record", title: "Team record" };
 const missing = unread(reads.serviceStatus, "the team record's stored check", base.id, base.title, fix);
 if (missing !== undefined) return missing;
 if (reads.serviceStatus.state !== "ok") return { ...base, status: "unknown", line: "Unknown", source: "", checked: "", details: [] };
 const data = reads.serviceStatus.data, record = data.teamRecord, when = checkedAt(data.checkedAt, "Stored status read");
 const source = "The team record's stored delete check";
 if (record === undefined) return { ...base, status: "unknown", line: "This install doesn't report a team record check.", source, ...when, details: [] };
 const details = [`Stored status: ${record.status}`, record.detail];
 if (record.status === "ok") return { ...base, status: "healthy", line: "The team record's stored delete check is fine.", source, ...when, details };
 if (record.status === "warn") return { ...base, status: "action", line: "The team record's stored check found something to look at.", source, ...when, fix: { ...fix, text: "Open How we work and read the record settings, or ask your Rovara operator." }, details };
 return { ...base, status: "unknown", line: "The team record's stored check has no result yet.", source, ...when, details };
}
const SOURCE_WORDS: Readonly<Record<string, string>> = { slack: "Slack", github: "GitHub", linear: "Linear", jira: "Jira", ticket: "Tickets", codehost: "Code host" };
export function lessonsRow(reads: Pick<ReadinessReads, "lessons" | "lessonsSkipped" | "projects">): ReadinessRow | undefined {
 const base = { id: "lessons", title: "Lessons and team record sources" };
 if (reads.lessons.length === 0) return reads.projects.state === "ok" ? { ...base, status: "unknown", line: "No project has team record sources to check yet.", source: "Source health stored by the learning loop", checked: "Not checked", fix: { text: "Open How we work.", label: "Open How we work", to: HOW_WE_WORK_PATH }, details: [] } : undefined;
 const source = "Source health stored by the learning loop, per project";
 if (reads.lessons.some(item => item.read.state === "loading")) return { ...base, status: "checking", line: "Checking the team record sources.", source, checked: "Not yet", details: [] };
 const missing = reads.lessons.filter(item => item.read.state === "missing");
 if (missing.length === reads.lessons.length) return { ...base, status: "unknown", line: "The team record and lessons aren't set up on this install.", source, checked: "Not checked", details: ["Every project's sources read answered not found."] };
 let status: Status = "unknown", first: { project: string; why: string } | undefined;
 const details: string[] = [];
 for (const item of reads.lessons) {
  if (item.read.state !== "ok") { status = worst(status, "unknown");details.push(`${item.project}: could not be read`);first ??= item.read.state === "missing" ? undefined : { project: item.project, why: "its sources could not be read" };continue; }
  const rows = item.read.data.sources;
  if (rows.length === 0) { status = worst(status, "unknown");details.push(`${item.project}: no sources`);continue; }
  for (const row of rows) {
   const words = `${Object.hasOwn(SOURCE_WORDS, row.kind) ? SOURCE_WORDS[row.kind] : row.kind}${row.scope === undefined ? "" : ` ${row.scope}`}`;
   details.push(`${item.project}: ${words}, health ${row.health}${row.paused ? ", paused" : ""}${row.enabled ? "" : ", off"}`);
   if (!row.enabled) continue;
   // A stored health word has no observation time (updatedAt is when the source was last edited), so "ok" is never Healthy; only a failing or paused source is news.
   const next: Status = row.health === "failing" || row.paused ? "action" : "unknown";
   if (next === "action" && first === undefined) first = { project: item.project, why: row.paused ? "a source was paused because it spiked" : "a source is failing" };
   if (next === "action") status = "action";
  }
 }
 const rest = reads.lessonsSkipped > 0 ? ` ${String(reads.lessonsSkipped)} more project${reads.lessonsSkipped === 1 ? " was" : "s were"} not read.` : "";
 const line = status === "action" ? `In ${first?.project ?? "a project"}, ${first?.why ?? "a source needs attention"}.${rest}` : `No source is failing or paused, but Rovara records no time for a source's health, and some may have no result or couldn't be read, so this can't be called healthy.${rest}`;
 return { ...base, status, line, source, checked: "Check time not recorded", ...(status === "action" && first !== undefined ? { fix: { text: "Open the project's Sources tab and resume or repair the source.", label: "Open Sources", to: projectSourcesPath(first.project) } } : status === "unknown" ? { fix: { text: "Open How we work.", label: "Open How we work", to: HOW_WE_WORK_PATH } } : {}), details };
}

// ---- Rovara's own service qualification

export function serviceRow(reads: Pick<ReadinessReads, "serviceStatus">): ReadinessRow {
 const fix: Fix = { text: "Open the stored qualification.", label: "Open stored qualification", to: `${HEALTH_PATH}/runtime/web` };
 const base = { id: "service", title: "Rovara service" };
 const missing = unread(reads.serviceStatus, "Rovara's service status", base.id, base.title, fix);
 if (missing !== undefined) return missing;
 if (reads.serviceStatus.state !== "ok") return { ...base, status: "unknown", line: "Unknown", source: "", checked: "", details: [] };
 const data: OrgServiceStatus = reads.serviceStatus.data, when = checkedAt(data.checkedAt, "Stored status read");
 const source = "Rovara's stored runtime qualification (not a live check)";
 const details = data.checks.map(check => `${check.kind === "web" ? "Browser" : "API"} runtime: ${check.observation}, ${check.reason}${check.expiresAt === undefined ? "" : `, expires ${check.expiresAt}`}`);
 if (!data.configured) return { ...base, status: "unknown", line: "Rovara's service qualification isn't set up in this deployment.", source, ...when, details };
 if (data.checks.some(check => check.observation === "expired")) return { ...base, status: "action", line: "Rovara's service qualification has expired.", source, ...when, fix: { ...fix, text: "Contact your Rovara operator to renew it." }, details };
 if (data.checks.every(check => check.observation === "qualified")) return { ...base, status: "healthy", line: "Rovara's service qualification is current.", source, ...when, details };
 if (data.checks.some(check => check.observation === "warning")) return { ...base, status: "action", line: "Rovara's service qualification expires soon or isn't ready.", source, ...when, fix: { ...fix, text: "Contact your Rovara operator." }, details };
 return { ...base, status: "unknown", line: "No qualification was recorded for Rovara's service.", source, ...when, fix, details };
}

// ---- turned-on features

export const FEATURE_WORDS: ReadonlyArray<readonly [keyof ReadinessFeatures, string]> = [["localAgents", "Local agents"], ["usage", "Usage"], ["chains", "Agent chains"], ["notices", "Notices"], ["describe", "Describe a task"], ["scriptTokens", "Script tokens"], ["decisionCards", "Decision cards"]];
export function featuresRow(reads: Pick<ReadinessReads, "features" | "designReview" | "preset">): ReadinessRow {
 const fix: Fix = { text: "Open How we work to see the company's rules.", label: "Open How we work", to: HOW_WE_WORK_PATH };
 const base = { id: "features", title: "Turned-on features" };
 const missing = unread(reads.features, "the turned-on features", base.id, base.title, fix);
 if (missing !== undefined) return missing;
 if (reads.features.state !== "ok") return { ...base, status: "unknown", line: "Unknown", source: "", checked: "", details: [] };
 const on = FEATURE_WORDS.filter(([key]) => reads.features.state === "ok" && reads.features.data[key]).map(([, words]) => words);
 const design = reads.designReview.state === "ok" ? reads.designReview.data : undefined;
 if (design?.allowed === true) on.push("Design review");
 if (reads.preset.state === "ok" && reads.preset.data.preset === "regulated") on.push("A person must approve every lesson");
 const source = "What this install and company have turned on";
 const details = [`Turned on: ${on.join(", ") || "none"}`, ...(design === undefined ? [] : [`Design review settings: ${design.unreadable ? "unreadable" : "readable"}`])];
 if (design?.unreadable === true) return { ...base, status: "action", line: "The company's design review settings can't be read, so nothing about them can be changed or trusted.", source, checked: "Check time not recorded", fix: { text: "Open How we work and ask your Rovara operator.", label: "Open How we work", to: HOW_WE_WORK_PATH }, details };
 return { ...base, status: "unknown", line: `${on.length === 0 ? "No optional feature is turned on." : `Turned on: ${on.join(", ")}.`} Nothing checks whether each one is working.`, source, checked: "Check time not recorded", fix, details };
}

// ---- the whole list

export interface Readiness { rows: ReadinessRow[]; counts: Record<Status, number>; checking: number }
export function buildReadiness(reads: ReadinessReads, now: number): Readiness {
 const rows: ReadinessRow[] = [codeHostRow(reads), chatRow(reads), trackerRow(reads, now)];
 for (const row of [monitoringRow(reads, now), toolsRow(reads, now)]) if (row !== undefined) rows.push(row);
 rows.push(modelRow(reads), ...projectRows(reads, now), teamRecordRow(reads));
 const lessons = lessonsRow(reads);if (lessons !== undefined) rows.push(lessons);
 rows.push(featuresRow(reads), serviceRow(reads));
 const counts: Record<Status, number> = { healthy: 0, action: 0, unknown: 0 };
 let checking = 0;
 for (const row of rows) { if (row.status === "checking") checking++;else counts[row.status]++; }
 return { rows, counts, checking };
}
/** Action first, then Unknown, then Healthy; each keeps its own order. */
export function sortRows(rows: readonly ReadinessRow[]): ReadinessRow[] {
 const rank: Record<RowStatus, number> = { action: 0, checking: 1, unknown: 2, healthy: 3 };
 return rows.map((row, index) => ({ row, index })).sort((a, b) => rank[a.row.status] - rank[b.row.status] || a.index - b.index).map(item => item.row);
}

// ---- "What needs an admin"

export type AdminItemKind = "confirm" | "spend" | "rule" | "connection" | "check";
export interface AdminItem { id: string; kind: AdminItemKind; title: string; why: string; when?: string; /** Waiting for someone else, not for this admin. */ others?: boolean; link: { label: string; to: string }; /** An approval's own confirmation page, as the server sent it: the screen opens it only if it is this app's own confirmation address, and otherwise offers `link`. */ confirmUrl?: string; details: string[] }
export interface NeedsAdmin { items: AdminItem[]; /** The company's open approvals as the server counts them; `truncated`: its open index was longer than one answer reads, so the total and the list may be incomplete. Absent while that read has not answered. */ approvals?: { total: number; truncated: boolean }; /** Reads that did not answer, so "nothing needs you" is never claimed over them. */ unread: string[] }
export const ADMIN_LIST_CAP = 8;

/** What each kind of approval is, in words. The title is the confirmation page's own; this says what kind of thing waits, never who may decide it (the page checks that). */
const APPROVAL_KIND_WORDS: Readonly<Record<string, string>> = { write: "An agent's change waits for a person to confirm.", step: "A step of a run waits for a person to confirm.", change: "A protected change waits for a person to confirm." };
function approvalItems(summary: ReadinessApprovals): AdminItem[] {
 return summary.approvals.map(approval => ({
  id: `approval:${approval.approvalId}`, kind: "confirm" as const, title: approval.title, why: (APPROVAL_KIND_WORDS[approval.kind] ?? "An approval is waiting for a person to confirm.") + (approval.proposedBy === undefined ? "" : ` Asked by ${approval.proposedBy}.`),
  ...(stamp(approval.createdAt) === undefined ? {} : { when: `Asked ${stamp(approval.createdAt)!}` }), link: { label: "Open the waiting list", to: WAITING_PATH }, confirmUrl: approval.confirmUrl,
  details: [`Kind: ${approval.kind}`, ...(approval.subjectKind === undefined ? [] : [`Change: ${approval.subjectKind}`])],
 }));
}
function spendItems(list: readonly ReadinessSpendRequest[]): AdminItem[] {
 return list.filter(request => request.status === "PENDING").map(request => ({ id: `spend:${request.spendRequestId}`, kind: "spend" as const, title: `Spending request: ${requestKindWords(request.kind)}`, why: request.amountUsd === undefined ? "A spending request is waiting for a decision." : `A spending request for $${request.amountUsd.toFixed(2)} is waiting for a decision.`, ...(stamp(request.createdAt) === undefined ? {} : { when: `Asked ${stamp(request.createdAt)!}` }), link: { label: "Open the waiting list", to: WAITING_PATH }, details: [`Kind: ${request.kind ?? "not given"}`, ...(request.approverRole === undefined ? [] : [`Approver role: ${request.approverRole}`])] }));
}
function ruleItems(design: ReadinessDesignReview | undefined, preset: LessonCompanyPreset | undefined): AdminItem[] {
 const items: AdminItem[] = [];
 if (design?.pending !== undefined) {
  const what = design.pending.kind === "allowed" ? "allow design review in this company" : "loosen the company's design review rules";
  items.push({ id: "rule:design-review", kind: "rule", title: "Company rule proposal", why: design.pending.proposedByYou ? `You asked to ${what}. A different admin has to confirm it.` : `An admin asked to ${what}. A different admin (you) can confirm or withdraw it.`, ...(stamp(design.pending.expiresAt) === undefined ? {} : { when: `Waits until ${stamp(design.pending.expiresAt)!}` }), others: design.pending.proposedByYou, link: { label: "Open How we work", to: HOW_WE_WORK_PATH }, details: [`Kind: ${design.pending.kind}`] });
 }
 if (preset?.proposal !== undefined) {
  const proposal = preset.proposal;
  items.push({ id: "rule:lessons-preset", kind: "rule", title: "Company rule proposal", why: proposal.mine ? "You asked to let lessons go live without a person approving each one. A different admin has to confirm it." : "An admin asked to let lessons go live without a person approving each one. You can confirm or withdraw it.", others: proposal.mine, link: { label: "Open How we work", to: HOW_WE_WORK_PATH }, details: [`Change to: ${proposal.to}`] });
 }
 return items;
}
/** What each read is called when it did not answer. Every read the list or the health counts depend on is here. */
const READ_WORDS = [["approvals", "approvals waiting in the company"], ["spend", "spending requests"], ["preset", "company lesson rules"], ["designReview", "company design review rules"], ["github", "the GitHub connection"], ["githubRequests", "GitHub installation requests"], ["connections", "saved connections"], ["slack", "the Slack connection"], ["sources", "AI model sources"], ["projects", "project environment checks"], ["serviceStatus", "Rovara's service status and team record check"], ["observations", "when each check last ran"], ["features", "the turned-on features"]] as const satisfies ReadonlyArray<readonly [keyof ReadinessReads, string]>;

export function buildNeedsAdmin(reads: ReadinessReads, readiness: Readiness): NeedsAdmin {
 const items: AdminItem[] = [];
 if (reads.approvals.state === "ok") items.push(...approvalItems(reads.approvals.data));
 const approvals = reads.approvals.state === "ok" ? { total: reads.approvals.data.total, truncated: reads.approvals.data.truncated === true } : undefined;
 if (reads.spend.state === "ok") items.push(...spendItems(reads.spend.data));
 items.push(...ruleItems(reads.designReview.state === "ok" ? reads.designReview.data : undefined, reads.preset.state === "ok" ? reads.preset.data : undefined));
 for (const row of readiness.rows) {
  if (row.status !== "action" || row.fix === undefined) continue;
  items.push({ id: `row:${row.id}`, kind: row.id.startsWith("project:") ? "check" : "connection", title: row.title, why: row.line, ...(row.checkedAt === undefined ? {} : { when: row.checked }), link: { label: row.fix.label, to: row.fix.to }, details: row.details });
 }
 // What waits for this admin comes before what waits for someone else.
 const ordered = [...items.filter(item => item.others !== true), ...items.filter(item => item.others === true)];
 // Any read that did not answer (refused, missing, failed or still going) is named: "nothing needs an admin" is never said over a read that gave no answer. Members never reach this list.
 const unanswered: string[] = READ_WORDS.filter(([key]) => (reads[key] as Read<unknown>).state !== "ok").map(([, words]) => words);
 if (reads.lessons.some(item => item.read.state !== "ok")) unanswered.push("team record sources");
 return { items: ordered, unread: unanswered, ...(approvals === undefined ? {} : { approvals }) };
}
