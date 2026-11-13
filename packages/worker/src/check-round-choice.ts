// TE-B1-fresh: the ONE place the round kinds meet. It says which runners a task's official check rounds use and which its original-code rounds use; run-task.ts calls it at the three places it builds check runners.
// A source guard (tests/unit/worker-fresh-source-guards.test.ts) lets only this module import the fresh round, and no module may import both round kinds directly: the sealed round is reached through `withTestServices`, as before.
//
//   - A task with test services (a plan with dependencies) keeps TODAY'S sealed path for every round, whatever the kind says: `withTestServices`, untouched. A plan with dependencies is not moved to the fresh round, and a round that cannot
//     be sealed is not run unsealed in a fresh place either (the existing refusal stays where it is).
//   - `fresh_unsealed` gives the official rounds the fresh runners (fresh-check-round.ts). The rounds that run on the ORIGINAL code (the before results of the agent's commands, the test proof, the scanners' baseline) keep the working
//     runners: there is no candidate to export in them, and they are measurements, not the final check. Real model calls are not allowed in them (`realModelCallsAllowed("working")`).
//   - Anything else is today's behaviour: the working runners for both.
import type { ProjectCommand } from "@rovara-code/contracts";
import type { CheckRoundKind } from "./check-round-kind.js";
import { createFreshCheckRunners, type FreshRoundHooks } from "./fresh-check-round.js";
import type { FreshCandidateRepository } from "./fresh-check-sandbox.js";
import type { DockerCli } from "./swebench/containers.js";
import { withTestServices, type TestServicesRun } from "./test-services-run.js";
import type { CheckRunners } from "./verification/checks.js";

/**
 * The seam the company gate `freshCheckRound` opens (TE-A1's gates; the broker's read of the gate and the payload that carries it to the worker are not on this base: see run-task.ts `freshCheckRound`). It carries what the worker cannot know at
 * task time: the project's own setup commands (possibly none), which run inside the fresh sandbox before the first check, and the hooks F1-b/F1-c plug into.
 */
export interface FreshCheckRoundSeam {
  setup: readonly ProjectCommand[];
  setupBudgetMs?: number;
  hooks?: FreshRoundHooks;
}

/** What run-task knows about this task's fresh round. */
export interface FreshRoundWiring {
  seam: FreshCheckRoundSeam;
  docker: DockerCli;
  rootPath: string;
  taskId: string;
  image: string | undefined;
  candidate: () => Promise<readonly FreshCandidateRepository[]>;
  onProgress: (line: string) => void;
}

export interface RoundRunners {
  /** The kind the official rounds really are: `sealed` when test services run them, `fresh_unsealed` when the fresh runners do, otherwise `working`. */
  readonly kind: CheckRoundKind;
  /** The runners of the task's official (final) check rounds. */
  readonly final: CheckRunners;
  /** The runners of the rounds on the original code. */
  readonly before: CheckRunners;
}

export function checkRoundRunners(input: {
  kind: CheckRoundKind;
  testServices: TestServicesRun | undefined;
  /** The working sandbox's (or dev container's, or the local shell's) runners: today's. */
  base: CheckRunners;
  /** What the fresh round needs; absent when the gate is off (then the round is working). Nothing starts until a round does. */
  fresh: FreshRoundWiring | undefined;
}): RoundRunners {
  if (input.testServices !== undefined) {
    const sealed = withTestServices(input.testServices, input.base);
    return { kind: "sealed", final: sealed, before: sealed };
  }
  if (input.kind === "fresh_unsealed" && input.fresh !== undefined) {
    const { seam, ...wiring } = input.fresh;
    const final = createFreshCheckRunners({ ...wiring, setup: seam.setup, ...(seam.setupBudgetMs === undefined ? {} : { setupBudgetMs: seam.setupBudgetMs }), ...(seam.hooks === undefined ? {} : { hooks: seam.hooks }) });
    return { kind: "fresh_unsealed", final, before: input.base };
  }
  return { kind: "working", final: input.base, before: input.base };
}
