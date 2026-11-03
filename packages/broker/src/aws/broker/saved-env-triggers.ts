// Saved project images (SV wiring): what makes the registry look at a project, and what starts the job it queues. Every trigger calls the registry's `checkRebuild`, which decides; a job it queues is started by
// `onQueued` here, the same way for all of them:
//   - a push to a project's default branch (the GitHub push event, `queueSavedEnvPush`);
//   - the project's nightly fire, before the night is started (`savedEnvBeforeNightly`), which also runs the deleted-project sweep (`sweepDeleted`) once per fire (a pass with nothing due is one read);
//   - the periodic poll in the five-minute session sweep (`runSavedEnvPoll`);
//   - the task-start check the registry already makes when a preparation is built (`savedEnvForPrepare`).
// Everything is inert while the `sv` switch is off or the registry is not installed, and nothing here throws into its caller: a trigger that fails is logged by name and the next one tries again.
import { NightlyFireSchema } from "@agentx/contracts";
import { abandonQueuedJob, checkRebuild, runPoll, sweepDeleted, type SavedEnvDeps } from "../../test-env/saved-env.js";
import { savedEnvEnabled } from "../../test-env/saved-env-switch.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { startSavedEnvRebuild, type SavedEnvBuildInputs } from "./saved-env-rebuild.js";

/** The projects one periodic pass looks at. */
export const SAVED_ENV_POLL_LIMIT = 10;
/** Why a start was refused for a reason that will not mend itself: the queued job is ended, so the project does not wait out its lease. */
const PERMANENT = new Set(["no_owner", "no_build_inputs", "approved_moved", "commits_mismatch", "no_project"]);

const log = (event: string, extra: Record<string, unknown> = {}): void => { console.log(JSON.stringify({ component: "broker", event, ...extra })); };

export type BuildInputsProvider = (orgId: string, project: string) => Promise<SavedEnvBuildInputs | undefined>;

/** The registry's `onQueued`: starts the job as a pinned preparation. A refusal that will not mend ends the job with its word. Never throws. */
export function savedEnvOnQueued(dependencies: () => AwsBrokerDependencies, inputs: BuildInputsProvider | undefined, env: NodeJS.ProcessEnv = process.env): NonNullable<SavedEnvDeps["onQueued"]> {
  return async (ids, job) => {
    try {
      const started = await startSavedEnvRebuild(dependencies(), ids, inputs, env);
      if (!started.started && PERMANENT.has(started.why)) {
        const deps = dependencies().savedEnvDeps;
        if (deps !== undefined) await abandonQueuedJob(deps, ids, job.jobId, started.why);
      }
      if (!started.started) log("saved_env.start_refused", { why: started.why });
    } catch (error) {
      log("saved_env.start_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  };
}

/** The periodic poll, over the registry's due projects. Off or not installed: nothing is read. */
export async function runSavedEnvPoll(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const deps = dependencies.savedEnvDeps;
  if (deps === undefined || !savedEnvEnabled(env)) return "off";
  try { return await runPoll(deps, SAVED_ENV_POLL_LIMIT); } catch (error) {
    log("saved_env.poll_failed", { error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

/** Before a project's nightly is started: its images are checked (the nightly trigger), and the deleted projects' registries are swept. The night is never held up or failed by this. */
export async function savedEnvBeforeNightly(dependencies: AwsBrokerDependencies, event: unknown, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const deps = dependencies.savedEnvDeps;
  if (deps === undefined || !savedEnvEnabled(env)) return;
  const fire = NightlyFireSchema.safeParse(event);
  try {
    if (fire.success) await checkRebuild(deps, { orgId: fire.data.orgId, projectId: fire.data.project }, "nightly");
    await sweepDeleted(deps);
  } catch (error) {
    log("saved_env.nightly_failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}

/** A push to the default branch of a project's repository: the registry is told (activity) and a rebuild is queued if one is due. */
export function savedEnvPushQueue(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): ((push: { orgId: string; project: string }) => Promise<unknown>) | undefined {
  const deps = dependencies.savedEnvDeps;
  if (deps === undefined || !savedEnvEnabled(env)) return undefined;
  return (push) => checkRebuild(deps, { orgId: push.orgId, projectId: push.project }, "push");
}
