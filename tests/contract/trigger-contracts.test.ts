// Plan 4 Task 18: the trigger contracts: the event and schedule variants of a recipe's triggers, the tables of event types and filter keys, schedules, the
// normalised event and its summary, the targets, the keys a trigger lives under, and the built-in suggestions.
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_IDS } from "@rovara-code/contracts";
import { BUILTIN_AGENTS } from "@rovara-code/contracts";
import { RecipeOverlaySchema, TriggerSpecSchema } from "@rovara-code/contracts";
import { EMPTY_RECIPE, TRIGGER_KINDS_AT_LAUNCH, recipeProblems } from "@rovara-code/contracts";
import { BUILTIN_TRIGGER_SUGGESTIONS } from "@rovara-code/contracts";
import { EVENT_FILTER_KEYS, EVENT_SOURCES, EVENT_TYPES, SCHEDULE_INTERVAL_MINUTES, ScheduleSpecSchema, eventFilterKeys } from "@rovara-code/contracts";
import { MAX_TRIGGERS_PER_TARGET, TRIGGER_ACTIVITY_TTL_DAYS, TRIGGER_DEFAULT_MAX_RUNS_PER_HOUR, TRIGGER_MAX_RUNS_PER_HOUR, triggerScheduleRate, triggerSpecWidens } from "@rovara-code/contracts";
import { TriggerEventSchema, TriggerTargetSchema, triggerSummary, type TriggerEvent } from "@rovara-code/contracts";
import { targetTriggersKey, triggerActivityKey, triggerKey, triggerMatchKey, triggerNoticeKey, triggersByCreatorKey, triggerTargetKey } from "@rovara-code/contracts";
import { TEST_ORG } from "../support/orgs.js";

const ORG = TEST_ORG;
const TRIGGER = `ctr_${"a".repeat(20)}`;
const CHAIN = `chn_${"b".repeat(20)}`;
const DEV = "a".repeat(64);

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
  const event = (extra: Record<string, unknown> = {}) => ({ kind: "event", source: "github", type: "pull_request.opened", ...extra });

  it("accepts person, event and schedule variants and launches with all three kinds", () => {
    expect([...TRIGGER_KINDS_AT_LAUNCH]).toEqual(["person", "event", "schedule"]);
    expect(TriggerSpecSchema.safeParse({ kind: "person" }).success).toBe(true);
    expect(TriggerSpecSchema.safeParse(event()).success).toBe(true);
    expect(TriggerSpecSchema.safeParse(event({ filter: { baseBranch: ["main"], authorAssociation: ["OWNER", "MEMBER"] } })).success).toBe(true);
    const schedule = TriggerSpecSchema.parse({ kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "Europe/Berlin" });
    expect(schedule).toMatchObject({ kind: "schedule", missed: "run_once" });
    expect(TriggerSpecSchema.safeParse({ kind: "schedule", schedule: { kind: "daily", at: "09:30", days: ["MON", "FRI"] }, timezone: "UTC", missed: "skip" }).success).toBe(true);
    expect(TriggerSpecSchema.safeParse({ kind: "schedule", schedule: { kind: "weekly", at: "23:59", day: "SUN" }, timezone: "America/New_York" }).success).toBe(true);
  });

  it("refuses a type the source does not have, a filter key the type does not have and a filter that is too big", () => {
    expect(TriggerSpecSchema.safeParse(event({ type: "issue.created" })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ source: "slack" })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ filter: { assignee: ["max"] } })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ filter: { label: [] } })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ filter: { label: Array.from({ length: 11 }, (_, i) => `l${String(i)}`) } })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ filter: { label: ["x".repeat(101)] } })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ extra: 1 })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ filter: { label: ["bug\u202e"] } })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ filter: { label: ["bu\ng"] } })).success).toBe(false);
    expect(TriggerSpecSchema.safeParse(event({ filter: { label: Array.from({ length: 10 }, (_, i) => `l${String(i)}`) } })).success).toBe(true);
  });

  it("takes authorAssociation on pull_request.opened and issues.opened and refuses it on workflow_run.completed", () => {
    const filter = { authorAssociation: ["MEMBER"] };
    expect(TriggerSpecSchema.safeParse(event({ filter })).success).toBe(true);
    expect(TriggerSpecSchema.safeParse(event({ type: "issues.opened", filter })).success).toBe(true);
    expect(TriggerSpecSchema.safeParse(event({ type: "workflow_run.completed", filter })).success).toBe(false);
  });

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

  it("is accepted in a custom agent's overlay, and a recipe with event or schedule triggers no longer has a structural problem about them", () => {
    expect(RecipeOverlaySchema.safeParse({ triggers: [{ kind: "person" }, event()] }).success).toBe(true);
    const recipe = { ...EMPTY_RECIPE, steps: [{ id: "work", name: "Work", kind: "agent" as const, workspace: "none" as const, settings: { instructions: [] } }], triggers: [{ kind: "person" as const }, TriggerSpecSchema.parse(event())] };
    expect(recipeProblems(recipe).map((problem) => problem.message)).not.toContain("event and schedule triggers aren't available yet");
    expect(recipeProblems(recipe).filter((problem) => problem.path === "triggers")).toEqual([]);
  });

  it("keeps every built-in recipe on person alone", () => {
    for (const id of BUILTIN_AGENT_IDS) {
      for (const release of BUILTIN_AGENTS[id].versions) expect(release.recipe.triggers).toEqual([{ kind: "person" }]);
    }
  });
});

describe("the built-in suggestions", () => {
  it("are Plan 4 data: one list for each built-in, of event or schedule specs only, each valid", () => {
    expect(Object.keys(BUILTIN_TRIGGER_SUGGESTIONS).sort()).toEqual([...BUILTIN_AGENT_IDS].sort());
    for (const id of BUILTIN_AGENT_IDS) {
      for (const spec of BUILTIN_TRIGGER_SUGGESTIONS[id]) {
        expect(["event", "schedule"]).toContain(spec.kind);
        expect(TriggerSpecSchema.safeParse(spec).success).toBe(true);
      }
    }
  });

  it("suggests pull_request.opened for the code reviewer, limited to people who belong to the repository", () => {
    expect(BUILTIN_TRIGGER_SUGGESTIONS["code-reviewer"]).toContainEqual({ kind: "event", source: "github", type: "pull_request.opened", filter: { authorAssociation: ["OWNER", "MEMBER", "COLLABORATOR"] } });
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

describe("the target and the normalised event", () => {
  it("names a chain or an agent", () => {
    expect(TriggerTargetSchema.safeParse({ kind: "chain", chainId: CHAIN }).success).toBe(true);
    expect(TriggerTargetSchema.safeParse({ kind: "agent", agentId: "code-reviewer" }).success).toBe(true);
    expect(TriggerTargetSchema.safeParse({ kind: "chain", chainId: "nope" }).success).toBe(false);
    expect(TriggerTargetSchema.safeParse({ kind: "chain", chainId: CHAIN, extra: 1 }).success).toBe(false);
    expect(triggerTargetKey({ kind: "chain", chainId: CHAIN })).toBe(`CHAIN#${CHAIN}`);
    expect(triggerTargetKey({ kind: "agent", agentId: "code-reviewer" })).toBe("AGENT#code-reviewer");
  });

  const event: TriggerEvent = {
    source: "github", type: "pull_request.opened", eventKey: "github:delivery-1", occurredAt: "2026-10-22T09:00:00.000Z", project: "web",
    subject: { kind: "pull_request", id: "42", title: "Fix the refund bug", url: "https://github.com/acme/web/pull/42" }, fields: { label: ["bug"] }, actor: { kind: "external", id: "octocat" },
  };

  it("parses an event strictly and sums it up as one line for the hand-off", () => {
    expect(TriggerEventSchema.safeParse(event).success).toBe(true);
    expect(TriggerEventSchema.safeParse({ ...event, extra: 1 }).success).toBe(false);
    expect(TriggerEventSchema.safeParse({ ...event, eventKey: "x".repeat(201) }).success).toBe(false);
    expect(TriggerEventSchema.safeParse({ ...event, subject: { ...event.subject, title: "t".repeat(301) } }).success).toBe(false);
    expect(TriggerEventSchema.safeParse({ ...event, subject: { ...event.subject, url: "http://github.com/x" } }).success).toBe(false);
    expect(TriggerEventSchema.safeParse({ ...event, subject: { ...event.subject, kind: "banana" } }).success).toBe(false);
    expect(TriggerEventSchema.safeParse({ ...event, hookId: `hk_${"a".repeat(26)}` }).success).toBe(true);
    expect(triggerSummary(event)).toBe("GitHub pull request opened: Fix the refund bug (https://github.com/acme/web/pull/42)");
    const { url: _url, ...bare } = event.subject; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(triggerSummary({ ...event, source: "pagerduty", type: "incident.triggered", subject: bare })).toBe("PagerDuty incident triggered: Fix the refund bug");
    expect(triggerSummary({ ...event, source: "cloudwatch", type: "alarm.fired" })).toMatch(/^CloudWatch alarm fired: /);
    expect(triggerSummary({ ...event, source: "github", type: "deployment_status.failure" })).toMatch(/^GitHub deployment status failure: /);
  });
});

describe("the keys", () => {
  it("scope every partition by the org and put the hook id in the match key", () => {
    expect(triggerKey(ORG, TRIGGER).pk).toBe(`ORG#${ORG}#TRIGGER#${TRIGGER}`);
    expect(targetTriggersKey(ORG, `CHAIN#${CHAIN}`, TRIGGER).pk).toContain(`TARGET_TRIGGERS#CHAIN#${CHAIN}`);
    expect(targetTriggersKey(ORG, `CHAIN#${CHAIN}`, TRIGGER).sk).toBe(TRIGGER);
    expect(triggersByCreatorKey(ORG, DEV, TRIGGER).pk).toContain(`TRIGGERS_BY_CREATOR#${DEV}`);
    const hookId = `hk_${"c".repeat(26)}`;
    const first = triggerMatchKey(ORG, "sentry", "web", hookId, TRIGGER);
    const second = triggerMatchKey(ORG, "sentry", "web", `hk_${"d".repeat(26)}`, TRIGGER);
    expect(first.pk).toContain(`TRIGGERS#sentry#web#${hookId}`);
    expect(first.pk).not.toBe(second.pk);
    expect(triggerMatchKey(ORG, "github", "web", "github", TRIGGER).pk).toContain("TRIGGERS#github#web#github");
    expect(triggerActivityKey(ORG, TRIGGER, "2026-10-22T09:00:00Z", "k1").pk).toContain(`TRIGGER_ACTIVITY#${TRIGGER}`);
    expect(triggerNoticeKey(ORG, DEV, "2026-10-22T09:00:00Z", TRIGGER).pk).toContain(`TRIGGER_NOTICES#${DEV}`);
    expect(triggerNoticeKey(ORG, DEV, "2026-10-22T09:00:00Z", TRIGGER).sk).toBe(`2026-10-22T09:00:00.000Z#${TRIGGER}`);
  });
});
