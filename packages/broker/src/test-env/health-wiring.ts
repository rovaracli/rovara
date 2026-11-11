// Setup and test health SH28: the joints between the project health (health.ts) and the places that feed it. Every one is undefined, or does nothing, while the `nh` switch (and the test environment) is off, so the
// callers' flow is today's flow.
//   recordNightlyResultWithHealth  the nightly record, with the health listener (for the route that receives a nightly result)
//   blockedByEnvironmentHook       a task whose auto-fix gave up on environment faults (the end of "Blocked by environment")
//   setupProvedHook                an approved, proved environment revision
//   healthPortsOf                  the card (SH17's records, versioned; none while `vx` is off) and proposed-task ports
import type { AutoFixCode } from "@agentx/cloud-contracts";
import type { OrgId, TestingBlockedReason } from "@rovara-code/contracts";
import { RESULT_RULES } from "../verification/result.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { healthFixSetupCards } from "./fix-setup-health.js";
import { noteBlockedTask, noteSetupProved, nightlyHealthListener, type HealthPorts } from "./health.js";
import { nightlyHealthEnabled } from "./health-switch.js";
import { knownFailingExpiryListener } from "./known-failing-undo.js";
import { recordNightlyResult, type MapStore, type NightlyRecorded } from "./nightly.js";
import { proposedFixTaskStore } from "./proposed-tasks.js";
import { testEnvironmentEnabled } from "./switch.js";

/** The ports the health logic calls: the Fix setup card (SH17's records, versioned; it does nothing while `vx` is off) and the real proposed-task store. */
export const healthPortsOf = (deps: TestEnvDeps, env: NodeJS.ProcessEnv = process.env): HealthPorts => ({ cards: healthFixSetupCards(deps, env), proposals: proposedFixTaskStore(deps) });

/** Both switches: no nightly health without the test environment it reads. */
export const healthWiringOn = (env: NodeJS.ProcessEnv = process.env): boolean => nightlyHealthEnabled(env) && testEnvironmentEnabled(env);

/** Records a finished nightly run; while `nh` is on the project's health follows it. With `nh` off this is `recordNightlyResult` exactly. */
export function recordNightlyResultWithHealth(deps: TestEnvDeps, maps: MapStore, input: { orgId: OrgId; project: string; result: unknown; coverageMap?: unknown }, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof recordNightlyResult> {
  return recordNightlyResult(deps, maps, input, nightlyListeners(nightlyHealthListener(deps, healthPortsOf(deps, env), env), knownFailingExpiryListener(deps, env)));
}

/** The listeners that are on, one after the other (the health first, as before; the marks' expiry never throws). Undefined when none is on, so the record path is today's. */
function nightlyListeners(...listeners: Array<((event: NightlyRecorded) => Promise<void>) | undefined>): ((event: NightlyRecorded) => Promise<void>) | undefined {
  const on = listeners.filter((listener): listener is (event: NightlyRecorded) => Promise<void> => listener !== undefined);
  if (on.length === 0) return undefined;
  return async (event) => { for (const listener of on) await listener(event); };
}

/**
 * The environment reasons a set of auto-fix codes comes to. Empty unless the codes are ONLY about the environment: a code that is the change's fault, a test that also fails on the original code, or a fault
 * that is not yet decided means the task is not "Blocked by environment" (the same order as the result classifier: code wins).
 */
export function blockedReasonsOf(codes: readonly AutoFixCode[]): TestingBlockedReason[] {
  const reasons = new Set<TestingBlockedReason>();
  for (const code of codes) {
    const rule = RESULT_RULES[code];
    if (rule.kind === "code" || rule.kind === "original_fails" || rule.kind === "unclear") return [];
    if (rule.kind === "environment") reasons.add(rule.reason);
  }
  return [...reasons];
}

/** Attempts at a health update that failed: the state may be stored and its card not yet opened, and a repeat does the card again. */
export const HEALTH_NOTE_ATTEMPTS = 3;
async function retried<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await run(); } catch (error) { if (attempt >= HEALTH_NOTE_ATTEMPTS) throw error; }
  }
}

/** For the auto-fix runner: when it gives up on a task and the faults are the environment's, the project's blocked-task count goes up. Advisory: the caller ignores a failure. */
export function blockedByEnvironmentHook(deps: TestEnvDeps, env: NodeJS.ProcessEnv = process.env): ((task: { taskId: string; orgId?: OrgId | undefined; project: string }, codes: readonly AutoFixCode[]) => Promise<void>) | undefined {
  if (!healthWiringOn(env)) return undefined;
  const ports = healthPortsOf(deps);
  return async (task, codes) => {
    const orgId = task.orgId;
    if (orgId === undefined) return;
    for (const reason of blockedReasonsOf(codes)) await retried(() => noteBlockedTask(deps, ports, { orgId, project: task.project, taskId: task.taskId, reason }));
  };
}

/** For the approval route: an approved (so proved) revision brings a project that needs repair back to healthy. */
export function setupProvedHook(deps: TestEnvDeps, env: NodeJS.ProcessEnv = process.env): ((orgId: OrgId, project: string) => Promise<void>) | undefined {
  if (!healthWiringOn(env)) return undefined;
  const ports = healthPortsOf(deps);
  return async (orgId, project) => { await retried(() => noteSetupProved(deps, ports, { orgId, project })); };
}

