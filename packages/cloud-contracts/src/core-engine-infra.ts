/**
 * The deployment half of the core engine switch (0.5.19, DEFERRED S0-CC-INFRA-UNWIRED, S3-ENTRY-NEEDS). Plain data for the CDK app (infra/lib/core-engine.ts) and the CLI: the app cannot read
 * the broker's job table (packages/broker/src/cloud/app/jobs.ts), so the schedules are listed here and tests/contract/core-engine-infrastructure.test.ts holds the two equal.
 */

/** The `source` of the event a core job schedule sends to the broker (CORE_SCHEDULE_SOURCE in the broker's jobs.ts). */
export const CORE_JOB_EVENT_SOURCE = "agentx.core-job";

export interface CoreJobSchedule {
  /** The job's name in the broker's CORE_JOBS table: the event is `{ source: "agentx.core-job", job: <name> }`. */
  readonly job: string;
  /** EventBridge Scheduler's rate expression. One minute is its shortest rate. */
  readonly rate: string;
}

/** Every CORE_JOBS row whose trigger is a schedule. The `outbox-relay` row is a stream trigger, not a schedule: only its backstop is here. */
export const CORE_JOB_SCHEDULES: readonly CoreJobSchedule[] = [
  { job: "outbox-relay-backstop", rate: "rate(1 minute)" },
  { job: "dispatch-sweep", rate: "rate(1 minute)" },
  { job: "merge-tracking", rate: "rate(1 minute)" },
  { job: "session-sweep", rate: "rate(5 minutes)" },
  { job: "notify-deliver", rate: "rate(5 minutes)" },
  { job: "admission-hold-sweep", rate: "rate(15 minutes)" },
  { job: "automation-stop", rate: "rate(1 minute)" },
];

/**
 * What the `cc` setting (stack parameter CoreEngine, `agentx config set coreEngine.switch`) may be: `off`, `on` (every company), `on:<company id>[:<company id>]` or `drain` (S3-10 review H1: no new task on the core, its running tasks served to the end), the shape the broker's
 * parseCoreSwitch reads (packages/broker/src/cloud/app/flags.ts). A company id is `org_` and twenty lowercase letters or digits. At most two: a packed setting holds 64 characters
 * (BROKER_SETTING_VALUE) and `on:` plus two ids is 52. The pattern admits no comma, equals sign, slash or space, so the value is joined into the broker's packed settings unescaped.
 */
export const CORE_ENGINE_PARAMETER_PATTERN = "^(off|on|drain|on:org_[0-9a-z]{20}(:org_[0-9a-z]{20})?)$";
export const CORE_ENGINE_PARAMETER_MAX_LENGTH = 64;
export const CORE_ENGINE_DEFAULT = "off";
