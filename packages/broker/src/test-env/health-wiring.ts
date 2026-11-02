// Setup and test health SH28: the joints between the project health (health.ts) and the places that feed it. Every one is undefined, or does nothing, while the `nh` switch (and the test environment) is off, so the
// callers' flow is today's flow.
//   recordNightlyResultWithHealth  the nightly record, with the health listener (for the route that receives a nightly result)
//   blockedByEnvironmentHook       a task whose auto-fix gave up on environment faults (the end of "Blocked by environment")
//   setupProvedHook                an approved, proved environment revision
//   healthPortsOf                  the card and proposed-task ports (the card is SH17's: until it is hooked up, no card is opened)
import type { AutoFixCode, OrgId, TestingBlockedReason } from "@agentx/contracts";
import { RESULT_RULES } from "../verification/result.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { FIX_SETUP_CARDS_PENDING_SH17, noteBlockedTask, noteSetupProved, nightlyHealthListener, type HealthPorts } from "./health.js";
import { nightlyHealthEnabled } from "./health-switch.js";
import { recordNightlyResult, type MapStore } from "./nightly.js";
import { proposedFixTaskStore } from "./proposed-tasks.js";
import { testEnvironmentEnabled } from "./switch.js";

/** The ports the health logic calls: the Fix setup card (SH17's, not yet hooked up) and the real proposed-task store. */
export const healthPortsOf = (deps: TestEnvDeps): HealthPorts => ({ cards: FIX_SETUP_CARDS_PENDING_SH17, proposals: proposedFixTaskStore(deps) });

/** Both switches: no nightly health without the test environment it reads. */
export const healthWiringOn = (env: NodeJS.ProcessEnv = process.env): boolean => nightlyHealthEnabled(env) && testEnvironmentEnabled(env);

/** Records a finished nightly run; while `nh` is on the project's health follows it. With `nh` off this is `recordNightlyResult` exactly. */
export function recordNightlyResultWithHealth(deps: TestEnvDeps, maps: MapStore, input: { orgId: OrgId; project: string; result: unknown; coverageMap?: unknown }, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof recordNightlyResult> {
  return recordNightlyResult(deps, maps, input, nightlyHealthListener(deps, healthPortsOf(deps), env));
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

/** For the auto-fix runner: when it gives up on a task and the faults are the environment's, the project's blocked-task count goes up. Advisory: the caller ignores a failure. */
export function blockedByEnvironmentHook(deps: TestEnvDeps, env: NodeJS.ProcessEnv = process.env): ((task: { taskId: string; orgId?: OrgId | undefined; project: string }, codes: readonly AutoFixCode[]) => Promise<void>) | undefined {
  if (!healthWiringOn(env)) return undefined;
  const ports = healthPortsOf(deps);
  return async (task, codes) => {
    if (task.orgId === undefined) return;
    for (const reason of blockedReasonsOf(codes)) await noteBlockedTask(deps, ports, { orgId: task.orgId, project: task.project, taskId: task.taskId, reason });
  };
}

/** For the approval route: an approved (so proved) revision brings a project that needs repair back to healthy. */
export function setupProvedHook(deps: TestEnvDeps, env: NodeJS.ProcessEnv = process.env): ((orgId: OrgId, project: string) => Promise<void>) | undefined {
  if (!healthWiringOn(env)) return undefined;
  const ports = healthPortsOf(deps);
  return async (orgId, project) => { await noteSetupProved(deps, ports, { orgId, project }); };
}

