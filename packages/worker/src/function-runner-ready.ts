// Slice 4, lane C1: whether THIS worker can run the function runner, read from what boot-stage2.sh left in the worker's environment and from the image's own runner pre-pull list. Nothing here calls Docker or the network.
//
// The worker offers `task.testServices.functions.v2` only when ALL of these hold (each one fails closed, with a fixed reason, and nothing else about the worker changes):
//   1. root's boot wrote AGENTX_FUNCTION_RUNNER=ready (it installed the pinned gVisor, registered the `runsc` Docker runtime, ran a sandbox smoke test, extracted the agent and pulled every runner image);
//   2. the runtime name is exactly `runsc` and the agent is at exactly the path the boot installs it (an environment that says anything else is refused);
//   3. test services are configured and the emulator is offered (the runner serves the emulator's Lambda; without it there is nothing to serve);
//   4. no runner repository is named as not pulled (`AGENTX_TEST_SERVICES_NOT_PULLED`), and the image's `function-runner-prepull.json` is valid, holds the agent and at least one runtime image, and every image in it is
//      linux/arm64 and pinned by digest.
// FOR W1 (the runner controller's wiring): the broker's delivery gate (`ec2-delivery.ts`) is NOT the only guard. A worker that takes an `aws.functions` plan (a dependency whose `aws.functions.runner` is set) must refuse it ITSELF, with a
// fixed sentence and before it starts anything, when `functionRunnerReadiness().ready` is false: a plan can reach a worker whose boot note changed after it advertised (a withheld restart, a stale /ping), and a worker that
// parsed the field must never run the plan with the stubs and no runner. Nothing consumes `aws.functions` in the worker yet; the check belongs in the same change that first does.
// The image for a runtime is then `<registry>/rovara-catalog/<env>/<repository>@sha256:<digest>`: no tag can be built.
import { readFileSync } from "node:fs";
import { TEST_SERVICES_AWS_PLAN_FEATURE } from "@rovara-code/contracts";
import {
  FUNCTION_RUNNER_AGENT_HOST_PATH, FUNCTION_RUNNER_AGENT_ID, FUNCTION_RUNNER_ENVIRONMENT, FUNCTION_RUNNER_GVISOR, FUNCTION_RUNNER_REPOSITORIES, FunctionRunnerPrepullListSchema, TEST_SERVICES_FUNCTIONS_PLAN_FEATURE,
  functionRunnerImageReference, type FunctionRunnerPrepullList,
} from "@agentx/cloud-contracts";
import { TEST_SERVICES_ENV_ENVIRONMENT, TEST_SERVICES_REGISTRY_ENVIRONMENT, notPulledRepositories } from "./test-services-run.js";

/** The list the image carries beside `prepull.json` (the same relative place from `src/` and from `dist/`). */
export const FUNCTION_RUNNER_PREPULL_LIST_URL = new URL("../service-catalog/function-runner-prepull.json", import.meta.url);
export const FUNCTION_RUNNER_PREPULL_LIST_MAX_BYTES = 16 * 1024;

export type FunctionRunnerReadiness =
  | { ready: true; runtime: string; agentHostPath: string; list: FunctionRunnerPrepullList; imageForRuntime: (runtime: string) => string | undefined }
  | { ready: false; reason: "off" | "not_ready" | "bad_environment" | "not_pulled" | "no_list" | "no_emulator" };

/** Reads the readiness. Never throws. `env` is the worker's environment; `listFile` is the runner pre-pull list. */
export function functionRunnerReadiness(env: NodeJS.ProcessEnv = process.env, listFile: URL | string = FUNCTION_RUNNER_PREPULL_LIST_URL): FunctionRunnerReadiness {
  const state = env[FUNCTION_RUNNER_ENVIRONMENT.state];
  if (state === undefined || state === "") return { ready: false, reason: "off" };
  if (state !== "ready") return { ready: false, reason: "not_ready" };
  if (env[FUNCTION_RUNNER_ENVIRONMENT.runtime] !== FUNCTION_RUNNER_GVISOR.dockerRuntime || env[FUNCTION_RUNNER_ENVIRONMENT.agent] !== FUNCTION_RUNNER_AGENT_HOST_PATH) return { ready: false, reason: "bad_environment" };
  const registry = env[TEST_SERVICES_REGISTRY_ENVIRONMENT];
  const catalogEnv = env[TEST_SERVICES_ENV_ENVIRONMENT];
  if (registry === undefined || catalogEnv === undefined) return { ready: false, reason: "bad_environment" };
  const missing = notPulledRepositories(env);
  if (missing === "all" || FUNCTION_RUNNER_REPOSITORIES.some((repository) => missing.has(repository))) return { ready: false, reason: "not_pulled" };
  let list: FunctionRunnerPrepullList;
  try {
    const text = readFileSync(listFile, "utf8");
    if (Buffer.byteLength(text) > FUNCTION_RUNNER_PREPULL_LIST_MAX_BYTES) return { ready: false, reason: "no_list" };
    list = FunctionRunnerPrepullListSchema.parse(JSON.parse(text));
  } catch {
    return { ready: false, reason: "no_list" };
  }
  if (!list.images.some((image) => image.id === FUNCTION_RUNNER_AGENT_ID) || list.images.length < 2) return { ready: false, reason: "no_list" };
  const install = { registry, env: catalogEnv };
  const imageForRuntime = (runtime: string): string | undefined => {
    try { return functionRunnerImageReference(list, runtime, install); } catch { return undefined; }
  };
  return { ready: true, runtime: FUNCTION_RUNNER_GVISOR.dockerRuntime, agentHostPath: FUNCTION_RUNNER_AGENT_HOST_PATH, list, imageForRuntime };
}

/** The feature to add to /ping: only when the runner is ready AND the worker already offers the emulator (`advertised` is what `testServicesAdvertisedFeatures` returned). */
export function functionRunnerAdvertisedFeatures(advertised: readonly string[], env: NodeJS.ProcessEnv = process.env, listFile: URL | string = FUNCTION_RUNNER_PREPULL_LIST_URL): Array<typeof TEST_SERVICES_FUNCTIONS_PLAN_FEATURE> {
  if (!advertised.includes(TEST_SERVICES_AWS_PLAN_FEATURE)) return [];
  return functionRunnerReadiness(env, listFile).ready ? [TEST_SERVICES_FUNCTIONS_PLAN_FEATURE] : [];
}
