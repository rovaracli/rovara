// Test environment (wire-testenv): what a verification (CHECKS) run is told about the environment the task pinned: which of its commands are the environment's checks, how to select tests, the round budget, and
// the tests that failed in the last nightly. The worker applies it (worker/src/verification/test-env-plan.ts); this only builds it, and builds it only when it can stand behind it.
//
// The plan is built when ALL of these hold, and not at all otherwise (the run then goes out exactly as it did without an environment):
//   - the switch is on, and the task pinned a revision that a task may use (`usableTestEnvironment` is run again for THAT revision: it is read from the store, not from the pin, so a pin cannot name an environment
//     the rules above would refuse);
//   - the pinned digest is the environment's own digest (a pin written for other contents is not used);
//   - the run's first commands are the environment's checks, in order (`taskWorkflowCheckPolicy` puts them first; a task whose policy was edited since reads as "not the environment's" and runs as it is).
// A coverage map is not sent: no run produces one yet, and a map of any size would not fit a dispatch. Without it a selection by coverage map runs the whole check and says why.
import { EDITION_ENV_VAR, agentXError, testEnvDigest, type OrgId, type ProjectCommand, type TestEnvTaskPlan } from "@agentx/contracts";
import { DEPENDENCY_PLAN_REFUSAL_WORDS, taskDependencyPlansOf, type ServiceCatalogSource } from "./dependency-plan.js";
import { lastNightlyFailures } from "./nightly.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { selectionFieldsAreSafe } from "./prove-from-setup-check.js";
import { readTestEnvPin, usableTestEnvironment } from "./usable.js";
import { testEnvironmentEnabled } from "./switch.js";
import { testServicesEnabled } from "./test-services-switch.js";

const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);

/** `serviceCatalog` is the release's signed catalog (`serviceCatalogSourceOf`). Without one, a run with dependencies is refused, never planned without them. */
export type TestEnvPlanDeps = TestEnvDeps & { serviceCatalog?: ServiceCatalogSource | undefined };

export async function testEnvPlanFor(
  deps: TestEnvPlanDeps, input: { orgId: OrgId; project: string; taskId: string; readiness: readonly ProjectCommand[] }, env: NodeJS.ProcessEnv = process.env,
): Promise<TestEnvTaskPlan | undefined> {
  if (!testEnvironmentEnabled(env) || input.readiness.length === 0) return undefined;
  const pin = await readTestEnvPin(deps, input.orgId, input.project, input.taskId);
  if (pin === undefined || pin.unused !== undefined) return undefined;
  const found = await usableTestEnvironment(deps, input.orgId, input.project, pin.revision, env);
  if (!found.ok || testEnvDigest(found.environment.environment) !== pin.digest) return undefined;
  const body = found.environment.environment;
  // The narrowing rule again, at dispatch: an environment approved before the rule, or by any path that skipped it, never sends `{tests}` to a command that is not a test runner (the run then goes out as without an environment).
  if (!selectionFieldsAreSafe(body)) return undefined;
  const checks = body.repos.flatMap((repo) => repo.checks);
  if (checks.length === 0 || input.readiness.length < checks.length || !checks.every((check, index) => sameCommand(check.command, input.readiness[index]!))) return undefined;
  // Test services (slice 1): the dependencies this run starts, pinned from the signed catalog. Only with the switch `tx` on (the usable check above already refuses the environment otherwise). A dependency that cannot be
  // pinned REFUSES the run, in fixed words: running the checks without a dependency the environment lists would only fail its tests in a confusing way.
  let dependencies: TestEnvTaskPlan["dependencies"];
  if (body.dependencies !== undefined && body.dependencies.length > 0) {
    if (!testServicesEnabled(env)) return undefined;
    const catalog = await Promise.resolve(deps.serviceCatalog?.()).catch(() => undefined);
    const planned = taskDependencyPlansOf({ body, catalog, edition: env[EDITION_ENV_VAR] === "enterprise" ? "enterprise" : "public", projectId: input.project });
    if (!planned.ok) throw agentXError("RUNTIME_UNAVAILABLE", DEPENDENCY_PLAN_REFUSAL_WORDS[planned.reason]);
    dependencies = planned.dependencies;
  }
  const failures = await lastNightlyFailures(deps, input.orgId, input.project).catch(() => []);
  return {
    revision: found.environment.revision, digest: pin.digest, roundBudgetMin: body.roundBudgetMin,
    selection: { method: body.selection.method, ...(body.selection.declared === undefined ? {} : { declared: body.selection.declared }), alwaysRun: body.selection.alwaysRun, fullSuiteOn: body.selection.fullSuiteOn },
    checks: checks.map((check) => ({ id: check.id, kind: check.kind, ...(check.coveragePath === undefined ? {} : { coveragePath: check.coveragePath }), ...(check.selectArgs === undefined ? {} : { selectArgs: check.selectArgs }) })),
    ...(failures.length === 0 ? {} : { lastNightlyFailures: failures.slice(0, 500) }),
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}
