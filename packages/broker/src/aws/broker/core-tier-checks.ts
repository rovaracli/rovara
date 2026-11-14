// Part of the broker: the CoreTierChecks function's handler (S3-9 review H1c and M1). The lighter flow's tier pass makes customer-paid model calls that take up to 130 s each, so it never runs on the broker
// (30 s: a call cut off there leaves the provider's bill paid and nothing recorded, and the next tick would buy it again). It runs here, on a function of its own: 15 minutes, reserved concurrency 1 (one pass at a
// time for the whole install, so two passes never bill the same review twice), no async retries and a schedule with no retries (the next tick is the retry). The infrastructure is
// infra/lib/core-tier-checks.ts; the entry is `../core-tier-checks-entry.ts`.
//
// It answers ONE event, `{ source: "agentx.core-job", job: "tier-checks" }`, through the Cloud root built for this host (`createCloudCoreEntry({ host: "tier-checks" })`, which runs no other job), with the function's
// own time left as the cap of the pass (Lambda's `getRemainingTimeInMillis`). Anything else is refused and never run. A host that cannot be built is a misconfiguration: the handler throws, so the function's
// Errors alarm fires (as the LessonsWorker does, re-check R5), never a quiet skip.
import { isCoreJobEvent } from "../../cloud/app/jobs.js";
import { createCloudCoreEntry, type CloudCoreEntry } from "../../cloud/app/entry.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { installOrgId } from "./scope-helpers.js";

/** The job this function runs, and the only one. */
export const CORE_TIER_CHECKS_JOB = "tier-checks";

export type CoreTierChecksHost = Pick<CloudCoreEntry, "handleScheduledJob">;

export interface CoreTierChecksContext { getRemainingTimeInMillis?: () => number }

const logLine = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ component: "core_tier_checks", ...entry }));

/**
 * The Cloud root for this function, from the install's dependencies: the same wiring as the broker's (`cloudCore`, the reviewer ports, the ledger), built as the `tier-checks` host. It has no developer API
 * (`routes`): the tier pass reads and writes the task's own records, the code host and the model path, and decides nothing for a person. Undefined where the install gives no core inputs.
 */
export function coreTierChecksHostFrom(dependencies: AwsBrokerDependencies, options: { env?: NodeJS.ProcessEnv; now?: () => Date; log?: (entry: Record<string, unknown>) => void } = {}): CoreTierChecksHost | undefined {
  if (dependencies.cloudCore === undefined) return undefined;
  return createCloudCoreEntry({
    env: options.env ?? process.env, broker: dependencies, routes: () => undefined, inputs: dependencies.cloudCore, installCompanyId: installOrgId(dependencies),
    now: options.now ?? (() => new Date()), log: options.log ?? logLine, host: "tier-checks",
  });
}

/** The function's handler: the tier pass on its schedule's event, nothing else. `build` is asked once per container, on the first tier pass. */
export function createCoreTierChecksHandler(build: () => CoreTierChecksHost | undefined, log: (entry: Record<string, unknown>) => void = logLine) {
  let host: CoreTierChecksHost | undefined;
  return async (event: unknown, context?: CoreTierChecksContext): Promise<unknown> => {
    if (!isCoreJobEvent(event) || event.job !== CORE_TIER_CHECKS_JOB) {
      log({ event: "core_tier_checks.refused", reason: "not_the_tier_pass" });
      return { skipped: "not_this_host" };
    }
    host ??= build();
    if (host === undefined) {
      log({ event: "core_tier_checks.not_configured", level: "error" });
      throw new Error("the tier pass's function has no Cloud root (the install gives no core inputs)");
    }
    const remainingMs = context?.getRemainingTimeInMillis?.();
    return await host.handleScheduledJob(event, { remainingMs });
  };
}
