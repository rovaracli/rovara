// A sealed check round (test services, slice 1, s1-sealed T1; design test-services.md 4.0.2 and 8; deferred check TS-SEAL-3). The one place an official check round gets its runners when the task has test services:
// the round's checks run in the SEALED check sandbox, by `docker exec --env-file` with the run's connection variables, and the working sandbox is off the services network for the whole round.
//
// What this module guarantees (each has a test):
//   - THE CHECK SANDBOX STARTS ONLY THROUGH `startCheckSandbox`, INSIDE `withDetachedWorking` (TS-SEAL-3). `withSealedCheckRound` is `withDetachedWorking` and nothing else starts the sandbox: the working sandbox is detached
//     and proved gone first, the sandbox starts, the round runs, then the sandbox is REMOVED and the working sandbox is attached again, also when the round fails or is cancelled. the plan's own run arguments are run by no other path
//     (a source guard in the tests looks for one).
//   - A CHECK NEVER RUNS ANYWHERE ELSE. The runners are built with `createCheckRunners({ sealed })`, which has no fallback to the working sandbox, a devcontainer or the host. Their `exec` is bound to this round: once the
//     round is over (the sandbox is removed) it rejects, so a runner kept by mistake cannot start a command in a later, unsealed place.
//   - THE RUN'S VARIABLES COME LAST AND NEVER LEAVE A FILE. Each exec gets the variables as `--env-file <path>` (a 0600 file on the run's tmpfs, written for that exec and removed when it returns: service-env.ts
//     `withServiceEnvFile`); the path is the only thing on the command line. A command's own `env` can add variables, but a name the run sets is dropped from it: Docker lets `--env` win over `--env-file`, so the repository's
//     own `DATABASE_URL` or `AWS_ENDPOINT_URL` must not reach the exec (service-env.ts, "FOR TS30").
//   - NOTHING THE CHECKS PRINT KEEPS A SECRET: stdout, stderr and error messages go through the run's redactor (case-insensitive, every spelling of each registered value) before they are kept.
//
// What it does not do: start or reset the helpers (the ServiceRunner), write the files of `checkSandboxPlan` (`writeCheckSandboxFiles`, the caller does, before the round), start the sealed DNS helper
// (`plan.dnsHelperRunArgs`, the caller does, with the helpers), or read the name server's record (`buildServiceUsageRecord`, service-usage-record.ts, after the round and before the services stop).
import { randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { ContainerExec } from "./devcontainer.js";
import { withDetachedWorking, type CheckSandboxPlan } from "./check-sandbox.js";
import { withServiceEnvFile, type ServiceEnvironment, type ServiceRedactor } from "./service-env.js";
import type { HelperFiles } from "./service-helpers.js";
import type { DockerCli } from "./swebench/containers.js";
import { createCheckRunners, runChecks, type CheckPlan, type CheckRound, type CheckRunners } from "./verification/checks.js";

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export interface SealedExecInput {
  docker: DockerCli;
  /** The check sandbox's container name (`CheckSandboxPlan.sandboxName`). */
  container: string;
  /** The run's directory seam (service-env.ts `createRunDirectoryFiles`): the env files are written through it. */
  files: HelperFiles;
  /** The check sandbox's variables: `buildServiceEnvironment({ sandbox: "check", ... })`. */
  environment: ServiceEnvironment;
  /** True while the round is running. The seam rejects when it is false. */
  live(): boolean;
}

/**
 * `docker exec [--env-file F] [--env K=V ...] <check sandbox> <command>`. A name in `environment` is taken out of the command's own `env` first, so the run's value is the only one the exec gets.
 * Rejects (fixed sentence) when the round is over.
 */
export function sealedContainerExec(input: SealedExecInput): ContainerExec {
  if (!CONTAINER_NAME.test(input.container)) throw agentXError("CONFIG_INVALID", "not a plan of a sealed check sandbox");
  const owned = new Set(input.environment.entries.map(([name]) => name));
  const prefix = randomUUID().replace(/-/gu, "").slice(0, 16);
  let counter = 0;
  return async (command, options) => {
    if (!input.live()) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed check sandbox is not running");
    counter += 1;
    const own = Object.entries(options.env ?? {}).filter(([name]) => !owned.has(name));
    return withServiceEnvFile(input.files, `chk-${prefix}-${String(counter)}`, input.environment, (envFileArgs) => input.docker.run([
      "exec",
      ...envFileArgs,
      ...own.flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      input.container, ...command,
    ], {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    }));
  };
}

export interface SealedCheckRoundInput {
  docker: DockerCli;
  /** `checkSandboxPlan(...)`: the sandbox, its names and files. The caller has written the plan's files (`writeCheckSandboxFiles`) and started the DNS helper. */
  plan: CheckSandboxPlan;
  /** The workspace root the checks run in (the same as the plan's `rootPath`). */
  rootPath: string;
  files: HelperFiles;
  /** `buildServiceEnvironment({ sandbox: "check", ... })`. */
  environment: ServiceEnvironment;
  /** `createServiceRedactor(helperSecretValues(...))`: applied to everything the checks print. */
  redactor: ServiceRedactor;
  /** Put the run's helpers back before the round's first check (`freshHelpers`); see `CheckRunners.freshServices`. Runs after the working sandbox is detached and the check sandbox is up. */
  freshServices?: CheckRunners["freshServices"];
  /** Put the `between_checks` helpers back between two checks (`resetForNextCheck`); see `CheckRunners.resetBetweenChecks`. */
  resetBetweenChecks?: CheckRunners["resetBetweenChecks"];
}

/**
 * Runs `round` with the runners of a sealed round. This is `withDetachedWorking` (check-sandbox.ts) with the check sandbox started inside it: the working sandbox leaves the services network (and is proved gone),
 * the check sandbox starts, `round` runs with runners whose every command is a `docker exec --env-file` into it, then the sandbox is removed and the working sandbox is attached again, whatever `round` did.
 * Throws when the working sandbox cannot be detached or the check sandbox cannot start or be removed (then `round` is not run, or the working sandbox stays detached): a round that cannot be sealed is not run unsealed.
 */
export async function withSealedCheckRound<T>(input: SealedCheckRoundInput, round: (runners: CheckRunners) => Promise<T>): Promise<T> {
  return withDetachedWorking(input.docker, input.plan, async (start) => {
    await start();
    let live = true;
    const exec = sealedContainerExec({ docker: input.docker, container: input.plan.sandboxName, files: input.files, environment: input.environment, live: () => live });
    const runners: CheckRunners = {
      ...createCheckRunners({ rootPath: input.rootPath, sealed: { exec, redact: (text) => input.redactor.text(text) } }),
      ...(input.freshServices === undefined ? {} : { freshServices: input.freshServices }),
      ...(input.resetBetweenChecks === undefined ? {} : { resetBetweenChecks: input.resetBetweenChecks }),
    };
    try {
      return await round(runners);
    } finally {
      live = false;
    }
  });
}

/**
 * One official check round, sealed: `runChecks` over `plan` with the runners of `withSealedCheckRound`. The normal round (`run-task.ts`) and the CHECKS retry call this when the task has test services, and the TESTPROOF
 * rerun on the original code calls it again: each call is its own round with a fresh check sandbox, and `freshServices` puts the helpers back first.
 */
export function runSealedCheckRound(input: SealedCheckRoundInput, plan: CheckPlan, options: { budgetMs: number; signal: AbortSignal; now?: () => number }): Promise<CheckRound> {
  return withSealedCheckRound(input, (runners) => runChecks(plan, runners, options));
}
