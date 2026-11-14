// TE-B1-fresh: the ONE place the round kinds meet. It says which runners a task's official check rounds use and which its original-code rounds use; run-task.ts calls it at the three places it builds check runners.
// A source guard (tests/unit/worker-fresh-source-guards.test.ts) lets only this module import the fresh round, and no module may import both round kinds directly: the sealed round is reached through `withTestServices`, as before.
//
//   - A task with test services (a plan with dependencies) keeps TODAY'S sealed RUNNERS for every round, whatever the kind says: `withTestServices`, untouched. A plan with dependencies is not moved to the fresh round, and a round that cannot
//     be sealed is not run unsealed in a fresh place either (the existing refusal stays where it is). The LABEL comes from the chooser alone: `sealed` only when it said sealed (the self-test passed); otherwise `working`.
//   - Each runners object has its own kind (`runnersKind`): the original-code runners are `working` and never a place for a real model call. The fresh runners also hold the export the checks' reports are read from (`evidence`).
//   - `fresh_unsealed` gives the official rounds the fresh runners (fresh-check-round.ts). The rounds that run on the ORIGINAL code (the before results of the agent's commands, the test proof, the scanners' baseline) keep the working
//     runners: there is no candidate to export in them, and they are measurements, not the final check. Real model calls are not allowed in them (`realModelCallsAllowed("working")`).
//   - Anything else is today's behaviour: the working runners for both.
import type { ProjectCommand } from "@rovara-code/contracts";
import type { CheckRoundKind } from "./check-round-kind.js";
import { readFile } from "node:fs/promises";
import { assertFreshWorkspaceSafe, createFreshCheckRunners, restartWorkingSandbox, type FreshEvidenceSource, type FreshRoundHooks } from "./fresh-check-round.js";
import { FreshQuiesceError } from "./fresh-check-sandbox.js";
import type { FreshCandidateRepository } from "./fresh-check-sandbox.js";
import type { DockerCli } from "./swebench/containers.js";
import { withTestServices, type TestServicesRun } from "./test-services-run.js";
import { stopWorkspaceProcesses } from "./workspace-processes.js";
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
  /** Keep the export of each round for the evidence (only a CHECKS run that asked for evidence). */
  keepExport?: boolean | undefined;
  /** Stops what the agent left running before each round (H1b). */
  quiesce?: ((signal: AbortSignal) => Promise<void>) | undefined;
}

export interface RoundRunners {
  /** The kind of the official rounds, from the chooser's answer alone (M1): `sealed` only when the chooser said so, `fresh_unsealed` only when the fresh runners run them, otherwise `working`. */
  readonly kind: CheckRoundKind;
  /** The kind of the original-code rounds: `working`, or `sealed` when test services run those too (M3). Never `fresh_unsealed`. */
  readonly beforeKind: CheckRoundKind;
  /** The runners of the task's official (final) check rounds. */
  readonly final: CheckRunners;
  /** The runners of the rounds on the original code. */
  readonly before: CheckRunners;
  /** The last fresh round's export, where the checks' reports are read from (H1c); only for `fresh_unsealed`. */
  readonly evidence?: FreshEvidenceSource;
}

const KINDS = new WeakMap<object, CheckRoundKind>();
/** The kind a runners object was made for. Each runner has its own: a `before` runner is never `fresh_unsealed`, so `realModelCallsAllowed(runnersKind(before))` is false unless a sealed round runs it (M3). */
export function runnersKind(runners: CheckRunners): CheckRoundKind | undefined {
  return KINDS.get(runners);
}
function tagged(kind: CheckRoundKind, runners: CheckRunners): CheckRunners {
  // base runners may be shared (the same object is `working` for both rounds): the first tag stays unless a stricter one is asked for.
  if (!KINDS.has(runners)) KINDS.set(runners, kind);
  return runners;
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
    // A plan with dependencies keeps today's sealed path. The label comes from the chooser alone: `sealed` only when it said sealed; while the self-test is held it says working (or fresh, which a plan with dependencies is not moved to), and then the
    // round reports `working`, never `sealed`.
    const kind: CheckRoundKind = input.kind === "sealed" ? "sealed" : "working";
    const sealedRunners = withTestServices(input.testServices, input.base);
    KINDS.set(sealedRunners, kind);
    return { kind, beforeKind: kind, final: sealedRunners, before: sealedRunners };
  }
  if (input.kind === "fresh_unsealed" && input.fresh !== undefined) {
    const { seam, ...wiring } = input.fresh;
    const final = createFreshCheckRunners({ ...wiring, keepExport: wiring.keepExport === true, setup: seam.setup, ...(seam.setupBudgetMs === undefined ? {} : { setupBudgetMs: seam.setupBudgetMs }), ...(seam.hooks === undefined ? {} : { hooks: seam.hooks }) });
    KINDS.set(final, "fresh_unsealed");
    // the original-code rounds are working: never a place for a real model call
    KINDS.set(input.base, "working");
    return { kind: "fresh_unsealed", beforeKind: "working", final, before: input.base, evidence: final };
  }
  tagged("working", input.base);
  return { kind: "working", beforeKind: "working", final: input.base, before: input.base };
}

const YAMA_PTRACE_SCOPE = "/proc/sys/kernel/yama/ptrace_scope";

/** The kernel's yama ptrace_scope as a number, or undefined when it cannot be read or is not a number (no yama is "cannot be read"). `read` is a test seam. */
export async function ptraceScopeFromProc(read: () => Promise<string> = () => readFile(YAMA_PTRACE_SCOPE, "utf8")): Promise<number | undefined> {
  const text = await read().catch(() => undefined);
  if (text === undefined || !/^\s*\d+\s*$/u.test(text)) return undefined;
  return Number(text);
}

/**
 * H1b: what runs before every fresh round so nothing the agent left running can act during it: the worker's own leftover processes (workspace-processes.ts, as publication and CHECKS mode do), then the working sandbox is RESTARTED and checked from
 * the host (`restartWorkingSandbox`: the kernel kills every process of the sandbox, whatever it hides behind; the sandbox itself comes back for the agent's extra turn). It fails closed: a rejection makes the round "not run".
 *
 * PTRACE (the working sandbox's seccomp profile is Docker's default: this code defines none, so no ptrace or process_vm_* denial can be added here): the restart means nothing the agent started can outlive it, so ptrace between programs cannot keep a program
 * alive. Even so, a worker whose kernel lets same-user programs trace each other (yama ptrace_scope 0) or cannot say is refused for fresh rounds (`ptrace_unrestricted`), checked at each round before anything is restarted.
 */
export function quietWorkingPlace(input: { docker: DockerCli; rootPath: string; sandboxName: string | undefined; stopProcesses?: (rootPath: string) => Promise<unknown>; ptraceScope?: () => Promise<number | undefined> }): (signal: AbortSignal) => Promise<void> {
  return async (signal) => {
    assertFreshWorkspaceSafe();
    await (input.stopProcesses ?? ((root: string) => stopWorkspaceProcesses({ rootPath: root })))(input.rootPath);
    assertFreshWorkspaceSafe();
    const scope = await (input.ptraceScope ?? (() => ptraceScopeFromProc()))().catch(() => undefined);
    if (scope === undefined || !Number.isSafeInteger(scope) || scope < 1) throw new FreshQuiesceError("ptrace_unrestricted");
    assertFreshWorkspaceSafe();
    if (input.sandboxName !== undefined) await restartWorkingSandbox(input.docker, input.sandboxName, signal);
  };
}
