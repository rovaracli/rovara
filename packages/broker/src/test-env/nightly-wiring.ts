// Test environment (wire-testenv): the nightly full run, connected as far as it can be today.
//
// What IS connected, only while the switch is on:
//   - the SCHEDULE follows the approved environment (`nightlyHooks`): when an approval turns the nightly run on, one EventBridge schedule for that project is made in the install's existing schedule group (the one
//     schedule triggers use: same invoke role, same dead-letter queue, same IAM, so no new infrastructure); when it is off, the project's schedule is deleted. Nothing is made for a project that never turned it on.
//   - the FIRE is routed (`fireTestEnvNightly`): the scheduler's invocation reaches `handleNightlyFire`, which decides from what is stored now (see test-env/nightly.ts).
//
// What is NOT connected: STARTING the run. A nightly run is the project's whole suite on its default branch with nobody's task behind it (coverage contexts on, a per-test report, a rerun of failures). The worker
// has no run of that kind: a verification run belongs to a task's workflow, a setup check runs the project's commands in a workspace prepare. Until one exists the fire answers `run_unavailable` BEFORE it
// charges the project's budget or claims a slot, so a schedule that fires costs nothing and holds nothing. The ports are the seam: give `runs` and the fire goes through.
//
// Cost (no AWS call was made to measure; EventBridge Scheduler pricing is $1.00 per million invocations after 14 million free a month): the schedules themselves are free at any size this runs at. The cost of a
// night is the worker's time for the whole suite once (design 7 estimates 45 minutes for each of 5 to 6 repositories), charged to the project, and none of it is incurred until a run can be started.
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { NIGHTLY_SOURCE, type OrgId, type TestEnvironment } from "@agentx/contracts";
import { scheduleSettingsFromEnvironment, type SchedulerPort } from "../triggers/schedules.js";
import type { TestEnvRouteHooks } from "../aws/developer-routes/test-environment.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { deleteNightlySchedule, handleNightlyFire, putNightlySchedule, type NightlyFireOutcome, type NightlyRunPort, type NightlyScheduleDependencies } from "./nightly.js";
import { setupProvedHook } from "./health-wiring.js";
import { testEnvironmentEnabled } from "./switch.js";

/** The scheduler's invocation of a nightly fire: an event of its own, which has no request context (a request through the API always has one, so its body can never pass for this). */
export function isTestEnvNightlyEvent(event: unknown): event is { source: typeof NIGHTLY_SOURCE } {
  return event !== null && typeof event === "object" && !("requestContext" in event) && (event as { source?: unknown }).source === NIGHTLY_SOURCE;
}

/** Where schedules are made, from the broker's own environment (the same settings schedule triggers use); undefined when the install has none. */
export function nightlyScheduleDependencies(env: NodeJS.ProcessEnv = process.env, client?: SchedulerPort): NightlyScheduleDependencies | undefined {
  const settings = scheduleSettingsFromEnvironment(env);
  if (settings === undefined) return undefined;
  return { client: client ?? new SchedulerClient({}), settings };
}

/** After an approval: make the project's nightly schedule match the approved environment, and (SH28, only while `nh` is on) end a repair state: an approved revision is a proved one. */
export function nightlyHooks(deps: { scheduling?: NightlyScheduleDependencies | undefined; /** The store the project health is kept in. */ health?: TestEnvDeps | undefined } = {}, env: NodeJS.ProcessEnv = process.env): TestEnvRouteHooks {
  return {
    async onApproved(orgId: OrgId, project: string, approved: TestEnvironment, approval?: { replayed: boolean }) {
      if (!testEnvironmentEnabled(env)) return;
      // Neither step keeps the other from running; the first failure is thrown after both (the route logs it and never undoes the approval).
      let failure: Error | undefined;
      // A replay of an approval that already stood proves nothing new: it must not end a repair state that came after it.
      const proved = deps.health === undefined || approval?.replayed === true ? undefined : setupProvedHook(deps.health, env);
      if (proved !== undefined) {
        try { await proved(orgId, project); } catch (error) { failure = error instanceof Error ? error : new Error("health update failed"); }
      }
      const scheduling = deps.scheduling ?? nightlyScheduleDependencies(env);
      if (scheduling !== undefined) {
        const { nightly } = approved.environment;
        try {
          if (nightly.enabled) await putNightlySchedule(scheduling, { orgId, project, cronUtc: nightly.cronUtc, enabled: true });
          else await deleteNightlySchedule(scheduling, { orgId, project });
        } catch (error) { failure = failure ?? (error instanceof Error ? error : new Error("schedule update failed")); }
      }
      if (failure !== undefined) throw failure;
    },
  };
}

export type TestEnvNightlyAnswer = NightlyFireOutcome | { outcome: "off" } | { outcome: "skipped"; reason: "run_unavailable" };

/**
 * Handles one scheduler fire. Off: nothing is read. On, without a way to start a run: nothing is charged or claimed. On, with `runs`: `handleNightlyFire` decides. A fault that may pass is thrown (the
 * scheduler retries it and then dead-letters it); everything decided is an answer.
 */
export async function fireTestEnvNightly(deps: TestEnvDeps, event: unknown, runs?: NightlyRunPort, env: NodeJS.ProcessEnv = process.env): Promise<TestEnvNightlyAnswer> {
  if (!testEnvironmentEnabled(env)) return { outcome: "off" };
  if (runs === undefined) return { outcome: "skipped", reason: "run_unavailable" };
  return handleNightlyFire({ ...deps, runs }, event);
}
