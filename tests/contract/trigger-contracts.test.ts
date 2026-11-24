// Plan 4 Task 18: the trigger contracts: the event and schedule variants of a recipe's triggers, the tables of event types and filter keys, schedules, the
// normalised event and its summary, the targets, the keys a trigger lives under, and the built-in suggestions.
import { describe, expect, it } from "vitest";
import { TriggerSpecSchema } from "../../packages/contracts/src/agent-recipe.js";
import { EVENT_FILTER_KEYS, EVENT_SOURCES, EVENT_TYPES, SCHEDULE_INTERVAL_MINUTES, ScheduleSpecSchema, eventFilterKeys } from "../../packages/contracts/src/trigger-specs.js";
import { MAX_TRIGGERS_PER_TARGET, TRIGGER_ACTIVITY_TTL_DAYS, TRIGGER_DEFAULT_MAX_RUNS_PER_HOUR, TRIGGER_MAX_RUNS_PER_HOUR, triggerScheduleRate, triggerSpecWidens } from "../../packages/contracts/src/trigger-specs.js";

describe("the tables", () => {
  it("lists the nine sources and exactly the event types of each", () => {
    expect([...EVENT_SOURCES]).toEqual(["github", "linear", "jira", "pagerduty", "sentry", "datadog", "grafana", "vercel", "cloudwatch"]);
    expect(EVENT_TYPES).toEqual({
      github: ["pull_request.opened", "pull_request.ready_for_review", "issues.opened", "issues.labeled", "issues.assigned", "deployment_status.success", "deployment_status.failure", "workflow_run.completed"],
      linear: ["issue.created"], jira: ["issue.created", "issue.labeled", "issue.assigned"], pagerduty: ["incident.triggered"], sentry: ["issue.created", "alert.triggered"], datadog: ["monitor.triggered"],
      grafana: ["alert.firing"], vercel: ["deployment.succeeded", "deployment.error"], cloudwatch: ["alarm.fired"],
    });
  });

  it("gives each event type its filter keys, and tells linear's and sentry's issue.created apart", () => {
    expect(eventFilterKeys("github", "pull_request.opened")).toEqual(["baseBranch", "label", "authorAssociation"]);
    expect(eventFilterKeys("github", "pull_request.ready_for_review")).toEqual(["baseBranch", "label", "authorAssociation"]);
    expect(eventFilterKeys("github", "issues.opened")).toEqual(["label", "authorAssociation"]);
    expect(eventFilterKeys("github", "issues.labeled")).toEqual(["label"]);
    expect(eventFilterKeys("github", "issues.assigned")).toEqual(["assignee"]);
    expect(eventFilterKeys("jira", "issue.labeled")).toEqual(["label"]);
    expect(eventFilterKeys("jira", "issue.assigned")).toEqual(["assignee"]);
    expect(eventFilterKeys("github", "deployment_status.failure")).toEqual(["environment"]);
    expect(eventFilterKeys("github", "workflow_run.completed")).toEqual(["workflow", "conclusion", "branch"]);
    expect(eventFilterKeys("linear", "issue.created")).toEqual(["label", "issueType"]);
    expect(eventFilterKeys("jira", "issue.created")).toEqual(["label", "issueType"]);
    expect(eventFilterKeys("sentry", "issue.created")).toEqual(["level", "environment"]);
    expect(eventFilterKeys("sentry", "alert.triggered")).toEqual(["level", "environment"]);
    expect(eventFilterKeys("pagerduty", "incident.triggered")).toEqual(["urgency", "service"]);
    expect(eventFilterKeys("datadog", "monitor.triggered")).toEqual(["priority", "tag"]);
    expect(eventFilterKeys("grafana", "alert.firing")).toEqual(["label"]);
    expect(eventFilterKeys("vercel", "deployment.error")).toEqual(["target"]);
    expect(eventFilterKeys("cloudwatch", "alarm.fired")).toEqual(["alarm", "namespace", "region"]);
    expect(eventFilterKeys("github", "nonsense")).toEqual([]);
    expect(Object.keys(EVENT_FILTER_KEYS).length).toBe(Object.values(EVENT_TYPES).flat().length);
  });

  it("has the limits the plan names", () => {
    expect(SCHEDULE_INTERVAL_MINUTES).toEqual([15, 30, 60, 120, 240, 360, 720, 1440]);
    expect([TRIGGER_DEFAULT_MAX_RUNS_PER_HOUR, TRIGGER_MAX_RUNS_PER_HOUR, MAX_TRIGGERS_PER_TARGET, TRIGGER_ACTIVITY_TTL_DAYS]).toEqual([30, 60, 10, 30]);
  });
});

describe("a recipe's trigger specs", () => {

  it("refuses a schedule with an interval of 5 minutes, an unknown zone or a bad time of day", () => {
    expect(ScheduleSpecSchema.safeParse({ kind: "interval", minutes: 5 }).success).toBe(false);
    for (const minutes of SCHEDULE_INTERVAL_MINUTES) expect(ScheduleSpecSchema.safeParse({ kind: "interval", minutes }).success).toBe(true);
    expect(TriggerSpecSchema.safeParse({ kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(ScheduleSpecSchema.safeParse({ kind: "daily", at: "24:00" }).success).toBe(false);
    expect(ScheduleSpecSchema.safeParse({ kind: "daily", at: "9:00" }).success).toBe(false);
    expect(ScheduleSpecSchema.safeParse({ kind: "weekly", at: "09:00" }).success).toBe(false);
    expect(ScheduleSpecSchema.safeParse({ kind: "weekly", at: "09:00", day: "FUNDAY" }).success).toBe(false);
    expect(ScheduleSpecSchema.safeParse({ kind: "daily", at: "09:00", days: ["MON", "MON"] }).success).toBe(false);
  });
});

describe("how often a schedule fires", () => {
  const schedule = (spec: unknown, missed: "skip" | "run_once" = "run_once") => TriggerSpecSchema.parse({ kind: "schedule", schedule: spec, timezone: "UTC", missed });

  it("counts fires per week", () => {
    expect(triggerScheduleRate(schedule({ kind: "interval", minutes: 60 }))).toBe(168);
    expect(triggerScheduleRate(schedule({ kind: "interval", minutes: 15 }))).toBe(672);
    expect(triggerScheduleRate(schedule({ kind: "interval", minutes: 1440 }))).toBe(7);
    expect(triggerScheduleRate(schedule({ kind: "daily", at: "09:00" }))).toBe(7);
    expect(triggerScheduleRate(schedule({ kind: "daily", at: "09:00", days: ["MON", "THU"] }))).toBe(2);
    expect(triggerScheduleRate(schedule({ kind: "weekly", at: "09:00", day: "MON" }))).toBe(1);
    expect(triggerScheduleRate({ kind: "person" })).toBe(0);
  });

  it("calls a change wider when it fires more often, or turns a skip into a run", () => {
    const weekly = schedule({ kind: "weekly", at: "09:00", day: "MON" });
    const daily = schedule({ kind: "daily", at: "09:00" });
    expect(triggerSpecWidens(weekly, daily)).toBe(true);
    expect(triggerSpecWidens(daily, weekly)).toBe(false);
    expect(triggerSpecWidens(schedule({ kind: "interval", minutes: 60 }), schedule({ kind: "interval", minutes: 15 }))).toBe(true);
    expect(triggerSpecWidens(schedule({ kind: "interval", minutes: 15 }), schedule({ kind: "interval", minutes: 60 }))).toBe(false);
    expect(triggerSpecWidens(schedule({ kind: "daily", at: "09:00", days: ["MON"] }), schedule({ kind: "daily", at: "09:00", days: ["MON", "THU"] }))).toBe(true);
    expect(triggerSpecWidens(schedule({ kind: "daily", at: "09:00", days: ["MON", "THU"] }), schedule({ kind: "daily", at: "09:00", days: ["THU"] }))).toBe(false);
    expect(triggerSpecWidens(schedule({ kind: "daily", at: "09:00" }, "skip"), schedule({ kind: "daily", at: "09:00" }, "run_once"))).toBe(true);
    expect(triggerSpecWidens(schedule({ kind: "daily", at: "09:00" }, "run_once"), schedule({ kind: "daily", at: "09:00" }, "skip"))).toBe(false);
    expect(triggerSpecWidens(schedule({ kind: "daily", at: "09:00" }), schedule({ kind: "daily", at: "10:00" }))).toBe(false);
  });

  it("calls a wider event filter wider and a narrower one not", () => {
    const filtered = (filter?: Record<string, string[]>) => TriggerSpecSchema.parse({ kind: "event", source: "github", type: "pull_request.opened", ...(filter === undefined ? {} : { filter }) });
    expect(triggerSpecWidens(filtered({ label: ["a"] }), filtered())).toBe(true);
    expect(triggerSpecWidens(filtered({ label: ["a"] }), filtered({ label: ["a", "b"] }))).toBe(true);
    expect(triggerSpecWidens(filtered({ label: ["a", "b"] }), filtered({ label: ["a"] }))).toBe(false);
    expect(triggerSpecWidens(filtered(), filtered({ label: ["a"] }))).toBe(false);
    expect(triggerSpecWidens(filtered({ label: ["a"] }), filtered({ label: ["a"], baseBranch: ["main"] }))).toBe(false);
    expect(triggerSpecWidens(filtered({ label: ["a"], baseBranch: ["main"] }), filtered({ label: ["a"] }))).toBe(true);
  });
});
