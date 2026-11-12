// exp/automations: the words the automation screens use. Plain sentences. Where the server wrote a sentence (a refusal, a trigger's off reason) it is shown as the server wrote it.
import { ApiError } from "../../api/errors.js";

/** The reason a trigger carries while an owner or admin has yet to confirm turning it on (the broker's own text, `triggers/routes.ts`). */
export const WAITING_REASON = "waiting for someone to confirm turning it on";
export const WAITING_FOR_ADMIN = "Waiting for an admin to confirm";
export const WAITING_FOR_SOMEONE = "Waiting for confirmation";
/** A company-shared chain's changes are confirmed by an owner or admin only, so only there is "an admin" said; anywhere else (or when it isn't known) the words are neutral. */
export const waitingWords = (companyShared: boolean | undefined) => companyShared === true ? WAITING_FOR_ADMIN : WAITING_FOR_SOMEONE;
export const READ_ONLY_NOTE = "Only maintainers can change automations";
export const CHAIN_READ_ONLY_NOTE = "You can look at this chain. Only people who manage it can change it";
export const NOT_ALLOWED = "You can't change this.";
export const NOT_ALLOWED_TO_SEE = "You can't see this.";

export interface TriggerLike { enabled: boolean; disabledReason?: string | undefined; scheduleStatus?: string | undefined }
export type TriggerStateKind = "on" | "paused" | "waiting" | "refused";
/** Where a trigger stands, in words. An off trigger with a reason of its own (the server's sentence) is "refused"; one waiting for a confirmation says so; any other is paused. */
export function triggerState(trigger: TriggerLike, companyShared?: boolean): { kind: TriggerStateKind; words: string; reason?: string } {
  if (trigger.enabled) return { kind: "on", words: "On" };
  if (trigger.disabledReason === WAITING_REASON) return { kind: "waiting", words: waitingWords(companyShared) };
  if (trigger.disabledReason !== undefined && trigger.disabledReason !== "") return { kind: "refused", words: "Turned off", reason: trigger.disabledReason };
  return { kind: "paused", words: "Paused" };
}

const SOURCES: Record<string, string> = { github: "GitHub", linear: "Linear", jira: "Jira", pagerduty: "PagerDuty", sentry: "Sentry", datadog: "Datadog", grafana: "Grafana", vercel: "Vercel", cloudwatch: "CloudWatch" };
/** Event types the trigger editor offers, by source (the same closed list the server holds: Code's `EVENT_TYPES`; the server checks it again). */
export const EVENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  github: ["pull_request.opened", "pull_request.ready_for_review", "issues.opened", "issues.labeled", "issues.assigned", "deployment_status.success", "deployment_status.failure", "workflow_run.completed"],
  linear: ["issue.created"], jira: ["issue.created", "issue.labeled", "issue.assigned"], pagerduty: ["incident.triggered"], sentry: ["issue.created", "alert.triggered"], datadog: ["monitor.triggered"], grafana: ["alert.firing"],
  vercel: ["deployment.succeeded", "deployment.error"], cloudwatch: ["alarm.fired"],
};
export const EVENT_SOURCE_NAMES: ReadonlyArray<readonly [string, string]> = Object.entries(SOURCES);
export const SCHEDULE_INTERVALS = [15, 30, 60, 120, 240, 360, 720, 1440] as const;
export const WEEKDAY_NAMES: ReadonlyArray<readonly [string, string]> = [["MON", "Monday"], ["TUE", "Tuesday"], ["WED", "Wednesday"], ["THU", "Thursday"], ["FRI", "Friday"], ["SAT", "Saturday"], ["SUN", "Sunday"]];
const dayName = (code: string) => WEEKDAY_NAMES.find(([key]) => key === code)?.[1] ?? code;
export const eventTypeWords = (type: string) => type.replace(/[._]/gu, " ");
export function intervalWords(minutes: number): string { return minutes === 1440 ? "Every day" : minutes % 60 === 0 ? `Every ${minutes === 60 ? "hour" : String(minutes / 60) + " hours"}` : `Every ${String(minutes)} minutes`; }

interface ScheduleLike { kind: string; minutes?: number | undefined; at?: string | undefined; days?: string[] | undefined; day?: string | undefined }
interface SpecLike { kind: string; source?: string | undefined; type?: string | undefined; filter?: Record<string, string[]> | undefined; schedule?: ScheduleLike | undefined; timezone?: string | undefined }
/** What starts the trigger, in words: "GitHub: pull request opened" or "Every day at 09:30 (Europe/Berlin)". */
export function specWords(spec: SpecLike): string {
  if (spec.kind === "event") {
    const filter = Object.entries(spec.filter ?? {}).map(([key, values]) => `${key} ${values.join(" or ")}`).join(", ");
    return `${SOURCES[spec.source ?? ""] ?? spec.source ?? "An outside tool"}: ${eventTypeWords(spec.type ?? "event")}${filter === "" ? "" : " (" + filter + ")"}`;
  }
  if (spec.kind === "schedule" && spec.schedule !== undefined) {
    const zone = spec.timezone === undefined ? "" : ` (${spec.timezone})`, schedule = spec.schedule;
    if (schedule.kind === "interval") return intervalWords(schedule.minutes ?? 0);
    if (schedule.kind === "daily") return `Every ${schedule.days === undefined || schedule.days.length === 7 ? "day" : schedule.days.map(dayName).join(", ")} at ${schedule.at ?? ""}${zone}`;
    if (schedule.kind === "weekly") return `Every ${dayName(schedule.day ?? "")} at ${schedule.at ?? ""}${zone}`;
  }
  return "Started by a person";
}

const OUTCOME_WORDS: Record<string, string> = { started: "Started a run", skipped: "Skipped", missed: "Missed", failed: "Failed", duplicate: "Skipped: already handled", disabled: "Turned off" };
const REASON_WORDS: Record<string, string> = {
  trigger_turned_off: "turned off", CHAIN_BUDGET_REQUIRED: "needs a spending cap", CHAIN_BUDGET_EXCEEDED: "this month's spending cap is used up", busy: "too many runs are already going",
  caused_by_rovara: "Rovara's own change caused it", runtime_unavailable: "Rovara couldn't start it right now", trigger_invalid: "it no longer matches its chain", recent_subject: "a run for this started a moment ago",
  previous_run_still_running: "the last run is still going", covered_by_a_later_run: "a later run covered it", rate_limited: "the hourly limit was reached", org_daily_limit: "the company's daily limit was reached",
  start_in_progress: "a run is already starting", dead_letter: "it could not be delivered", intake_unavailable: "ticket intake is off", intake_not_a_ticket: "it was not a ticket",
};
/** One activity row in words: "Skipped: turned off", "Failed: needs a spending cap". A reason this screen has no words for is shown as the server sent it. */
export function outcomeWords(outcome: string, reason?: string): string {
  const lead = OUTCOME_WORDS[outcome] ?? outcome;
  if (reason === undefined || reason === "") return lead;
  const known = REASON_WORDS[reason] ?? (reason.startsWith("intake_") ? reason.slice(7).replace(/_/gu, " ") : reason);
  return outcome === "duplicate" ? lead : `${lead}: ${known}`;
}

export const runStatusWords: Record<string, string> = { running: "Running", waiting: "Waiting for a person", paused: "Paused", succeeded: "Finished", failed: "Failed", cancelled: "Stopped", timed_out: "Timed out" };
export const runStatusKey = (status: string) => status === "waiting" ? "waiting" : status === "succeeded" ? "succeeded" : status === "failed" || status === "timed_out" ? "failed" : status === "cancelled" ? "cancelled" : status === "paused" ? "paused" : "running";

export interface Problem { message: string; forbidden: boolean; reauth: boolean; /** The refusal was on a read, so the plain words are about seeing, not changing. */ read?: boolean }
/**
 * A refusal. A 403 says plainly that this isn't theirs (to change; to see, on a read), then the server's own sentence says why; a REAUTH asks for a new sign-in; anything else is the server's sentence.
 */
export function problemOf(error: unknown, fallback = "Rovara couldn't do that. Try again shortly.", read = false): Problem {
  if (error instanceof ApiError) {
    if (error.code === "REAUTH_REQUIRED") return { message: error.message, forbidden: false, reauth: true };
    return { message: error.message, forbidden: error.status === 403, reauth: false, ...(read ? { read: true } : {}) };
  }
  return { message: fallback, forbidden: false, reauth: false };
}
