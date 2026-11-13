// TE-B1-fresh (DECISIONS 163b D2): the fresh, NOT SEALED check round. The final checks of a task run in a NEW container started on a clean export of the candidate commit, never in the agent's working sandbox.
//
// What this module guarantees (each has a test):
//   - THE CHECKS RUN ON THE COMMIT. The round exports the candidate commit into a new worker-owned directory (fresh-check-sandbox.ts: no untracked or ignored file, no uncommitted edit, no hook, no agent-edited dependency folder) and starts a
//     NEW sandbox on it with the task sandbox's hardening, on the `agentx-task` network, the export as the only mount. A second round on the same task gets its own directory and container.
//   - IT NEVER FALLS BACK. If the export, the start, the setup or a helper fails, the round is "not run: ..." with a fixed sentence (never docker's or git's words), and `round` is not called. Nothing runs in the working sandbox, a dev container
//     or the host instead: the sealed round's own rule (check-round-runners.ts), kept here. The working sandbox is never touched, never joined to a network of this round and never paused (see below).
//   - THE SANDBOX IS REMOVED in `finally`, on success, failure and cancel, and so is the export. A runner kept after the round rejects.
//   - IT SAYS WHAT IT IS. The round's first progress line starts with "not sealed" (check-round-kind.ts). The word "sealed" is never printed for this round without "not" in front of it.
//   - DEPENDENCIES. A clean export has no installed dependencies. The project's own setup commands (`setup`, given by the caller: the worker does not know them at task time, see the seam in run-task.ts) run INSIDE the fresh sandbox, in
//     the round's time, before the first check; if they cannot finish the round is "not run: ... could not be prepared", never a failed check. Registry tokens are not given to this round.
//
// NOT PAUSED. The working sandbox is not paused during a fresh round: the `agentx-task` bridge has `enable_icc=false` (task-network.ts), so the working sandbox cannot connect to the fresh one, and a pause adds failure modes (a pause that
// fails, an unpause that is missed, a long round holding the agent's container frozen). The sealed round pauses because it shares a network with the working sandbox's helpers; this one does not.
//
// IT BECOMES THE SEALED ROUND by the chooser's input and nothing else (check-round-kind.ts): same export, same runners shape, same evidence input; only the sandbox, the network and the label differ. It does not touch `withSealedCheckRound` or
// check-sandbox.ts, and has no option that makes either "unsealed".
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { matchTestCommand, type ProjectCommand } from "@rovara-code/contracts";
import { tailCollector } from "./collected-process.js";
import { FRESH_ROUND_FIRST_LINE } from "./check-round-kind.js";
import { containerBashOperations, runContainerCommand, type ContainerExec } from "./devcontainer.js";
import { FRESH_NOT_RUN_SENTENCES, FreshQuiesceError, exportCandidateForFreshRound, freshSandboxArgProblems, freshSandboxRunArgs, freshSandboxSuffix, removeFreshExport, type FreshCandidateRepository, type FreshNotRunReason } from "./fresh-check-sandbox.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "./git.js";
import { sandboxCommandOptions } from "./task-sandbox.js";
import { ensureTaskNetwork } from "./task-network.js";
import { createDockerCli, taskContainerExec, type DockerCli } from "./swebench/containers.js";
import { CheckNotRunError, containedDirectory, withoutRootError, type CheckRunners } from "./verification/checks.js";

const SANDBOX_START_TIMEOUT_MS = 5 * 60_000;
const DOCKER_CALL_TIMEOUT_MS = 60_000;
/** All the project's setup commands together get at most this long (each also has its own timeout), out of the round's own budget. */
export const FRESH_SETUP_BUDGET_MS = 10 * 60_000;

/** F1-b's round helper (a model stand-in on a round network) plugs in here. Empty until F1-b lands: the round then works for projects that make no model call. */
export interface FreshRoundHelper {
  name: string;
  /** Starts after the sandbox is up and before the first check. Resolves to its stop function, which runs after the round whatever the round did. */
  start(input: { container: string; signal: AbortSignal }): Promise<() => Promise<void>>;
}
export interface FreshRoundHooks {
  helpers?: readonly FreshRoundHelper[];
  /** F1-a's exact residual ("not sealed; model hosts blocked by name only", from `evidenceLinesFor`): passed in, printed second, never written here. */
  residualLine?: string;
}

export interface FreshCheckRoundInput {
  docker: DockerCli;
  /** The WORKING root (canonical). */
  rootPath: string;
  taskId: string;
  /** The task sandbox's image (`AGENTX_SANDBOX_IMAGE`); none is "not run". */
  image: string | undefined;
  /** The candidate as it is now: each repository's commit and tree (read again for every round). */
  candidate: () => Promise<readonly FreshCandidateRepository[]>;
  /**
   * The candidate the checks were PLANNED for: the commit and tree of each repository as the caller recorded them before the round (the verification extension's `candidateBefore`, a CHECKS run's own). The round exports and checks exactly
   * these: if `candidate()` gives anything else (a program that survived moved HEAD to another commit for the export and back afterwards), or nothing was recorded, the round is "not run".
   */
  pinned: () => readonly FreshPinnedCandidate[] | undefined;
  /** The project's setup commands, possibly none. Run in the fresh sandbox before the round. */
  setup: readonly ProjectCommand[];
  setupBudgetMs?: number;
  signal?: AbortSignal;
  /**
   * Stops whatever the agent left running before anything is read or started (H1b): the host's leftover processes, and the working sandbox, which is restarted and checked from the host. It runs first, every round. A rejection is "not run"
   * (a `FreshQuiesceError` names its own reason, any other error is `quiesce_failed`); the round never starts over a program that may still act.
   */
  quiesce?: ((signal: AbortSignal) => Promise<void>) | undefined;
  /**
   * When given, the export of a round that RAN (and whose container was removed cleanly, so nothing can still write to it) is NOT removed: it is handed to this callback, and the caller reads the checks' reports from it (H1c: evidence comes from
   * the export, never from the working tree) and then removes it with `removeFreshExport`. Absent: the export is removed with the sandbox.
   */
  retainExport?: (directory: string) => void;
  hooks?: FreshRoundHooks;
  /** Where the round's first line goes (the task's progress events). */
  onProgress?: (line: string) => void;
  log?: (event: Record<string, unknown>) => void;
  // test seams
  environment?: NodeJS.ProcessEnv;
  hostCpus?: number;
  hostMemoryBytes?: number;
  ensureNetwork?: (docker: DockerCli) => Promise<void>;
}

/** One repository of the recorded candidate. */
export interface FreshPinnedCandidate { repositoryId: string; commitSha: string; treeSha: string }

/** The same repositories at the same commits and trees (order and extra fields do not matter). */
function samePinned(current: readonly FreshPinnedCandidate[], pinned: readonly FreshPinnedCandidate[]): boolean {
  if (current.length !== pinned.length || pinned.length === 0) return false;
  const key = (item: FreshPinnedCandidate) => `${item.repositoryId}\0${item.commitSha}\0${item.treeSha}`;
  const wanted = new Set(pinned.map(key));
  const seen = new Set(current.map(key));
  // a duplicate on either side is refused: two copies of one repository are not two repositories
  return wanted.size === pinned.length && seen.size === current.length && current.every((item) => wanted.has(key(item)));
}

export type FreshRoundResult<T> = { kind: "ran"; value: T } | { kind: "not_run"; reason: FreshNotRunReason; sentence: string };

function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "worker", ...event }));
}

/** The runners of a fresh round: the same commands the working sandbox runs (`runContainerCommand`, `containerBashOperations`, the same NODE_ENV and Python user site settings), through `exec` into the fresh container. */
async function createFreshRunners(rootPath: string, exec: ContainerExec): Promise<CheckRunners> {
  const commandOptions = sandboxCommandOptions(rootPath);
  const operations = containerBashOperations(exec, commandOptions);
  const root = await realpath(resolve(rootPath)).catch(() => resolve(rootPath));
  return {
    async runProjectCommand(command, signal) {
      if (signal.aborted) throw new Error("aborted");
      try {
        const result = await runContainerCommand(exec, root, command, signal, commandOptions);
        if (signal.aborted) throw new Error("aborted");
        return { exitCode: result.exitCode, timedOut: result.timedOut === true, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        throw withoutRootError(error, root);
      }
    },
    async runAgentCommand(replay, timeoutMs, signal) {
      if (signal.aborted) throw new Error("aborted");
      if (matchTestCommand(replay) !== replay) throw new CheckNotRunError("AgentX replays only a simple test command, and this is not one.");
      const cd = /^cd (\S+) && (.+)$/s.exec(replay);
      const command = cd === null ? replay : cd[2]!;
      const cwd = cd === null ? root : await containedDirectory(root, cd[1]!, true);
      const output = tailCollector();
      try {
        // The AgentX git identity only: the worker's own environment is not copied into the fresh sandbox.
        const { exitCode } = await operations.exec(command, cwd, { onData: (data) => output.add(data), signal, timeout: timeoutMs / 1_000, env: { ...AGENTX_GIT_IDENTITY_ENVIRONMENT } });
        return { exitCode, timedOut: false, output: output.text() };
      } catch (error) {
        if (signal.aborted) throw new Error("aborted", { cause: error });
        if (error instanceof Error && error.message.startsWith("timeout:")) return { exitCode: null, timedOut: true, output: output.text() };
        throw withoutRootError(error, root);
      }
    },
  };
}

/**
 * Runs `round` in a fresh check sandbox made from a clean export of the candidate commit, then removes the sandbox and the export. Resolves `{ kind: "not_run" }` (and does not call `round`) when the export, the start, the setup
 * or a helper fails. A throw from `round` (and a cancel that makes it throw) is rethrown after the cleanup.
 */
export async function withFreshCheckRound<T>(input: FreshCheckRoundInput, round: (runners: CheckRunners) => Promise<T>): Promise<FreshRoundResult<T>> {
  const notRun = (reason: FreshNotRunReason): FreshRoundResult<T> => ({ kind: "not_run", reason, sentence: FRESH_NOT_RUN_SENTENCES[reason] });
  const signal = input.signal ?? new AbortController().signal;
  const log = input.log ?? logEvent;
  // The first line is printed whatever happens next, a round that cannot start included (L6).
  input.onProgress?.(FRESH_ROUND_FIRST_LINE);
  if (input.hooks?.residualLine !== undefined) input.onProgress?.(input.hooks.residualLine);
  if (input.image === undefined || input.image === "") return notRun("no_image");
  if (signal.aborted) return notRun("stopped");
  const root = resolve(input.rootPath);
  let exportDirectory: string | undefined;
  let name: string | undefined;
  let live = false;
  const stops: Array<() => Promise<void>> = [];
  let roundDone = false;
  try {
    if (input.quiesce !== undefined) {
      try { await input.quiesce(signal); } catch (error) { return notRun(signal.aborted ? "stopped" : error instanceof FreshQuiesceError ? error.reason : "quiesce_failed"); }
    }
    try { await (input.ensureNetwork ?? ensureTaskNetwork)(input.docker); } catch { return notRun("sandbox_failed"); }
    const repositories = await input.candidate().catch(() => undefined);
    if (repositories === undefined) return notRun("export_failed");
    const pinned = input.pinned();
    if (pinned === undefined || !samePinned(repositories, pinned)) return notRun("candidate_moved");
    const exported = await exportCandidateForFreshRound({ rootPath: root, taskId: input.taskId, repositories, signal });
    if (!exported.ok) return notRun(exported.reason);
    exportDirectory = exported.directory;
    if (exported.skipped.length > 0) log({ event: "fresh-check-round.export.skipped", taskId: input.taskId, symlinksAndSubmodules: exported.skipped.length });
    const containerName = `agentx-fresh-${input.taskId.replace(/[^a-zA-Z0-9_.-]/gu, "-").slice(0, 40)}-${freshSandboxSuffix()}`;
    const runInput = { name: containerName, taskId: input.taskId, image: input.image, rootPath: root, exportDirectory,
      ...(input.hostCpus === undefined ? {} : { hostCpus: input.hostCpus }), ...(input.hostMemoryBytes === undefined ? {} : { hostMemoryBytes: input.hostMemoryBytes }), ...(input.environment === undefined ? {} : { environment: input.environment }) };
    const args = freshSandboxRunArgs(runInput);
    if (freshSandboxArgProblems(args, runInput).length > 0) return notRun("sandbox_failed");
    // Named before the start: a start that half-worked is removed too.
    name = containerName;
    const started = await input.docker.run(args, { timeoutMs: SANDBOX_START_TIMEOUT_MS, signal }).catch(() => undefined);
    if (started === undefined || started.exitCode !== 0) return notRun(signal.aborted ? "stopped" : "sandbox_failed");
    live = true;
    const raw = taskContainerExec(input.docker, containerName);
    const exec: ContainerExec = (command, options) => {
      if (!live) return Promise.reject(new Error("the fresh check sandbox is not running"));
      return raw(command, options);
    };
    // The project's setup, inside the fresh sandbox, within its budget.
    const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(input.setupBudgetMs ?? FRESH_SETUP_BUDGET_MS)]);
    for (const command of input.setup) {
      const result = await runContainerCommand(exec, root, command, setupSignal, sandboxCommandOptions(root)).catch(() => undefined);
      if (result === undefined || result.exitCode !== 0 || result.timedOut === true) return notRun(signal.aborted ? "stopped" : "not_prepared");
    }
    try {
      for (const helper of input.hooks?.helpers ?? []) stops.push(await helper.start({ container: containerName, signal }));
    } catch { return notRun("sandbox_failed"); }
    const value = await round(await createFreshRunners(root, exec));
    roundDone = true;
    return { kind: "ran", value };
  } finally {
    live = false;
    for (const stop of stops.reverse()) await stop().catch(() => undefined);
    const removed = name === undefined ? true : await removeContainer(input.docker, name, input.taskId, log);
    if (exportDirectory !== undefined) {
      // Kept for the evidence only when the round ran and nothing can still be writing to it.
      if (roundDone && removed && input.retainExport !== undefined) input.retainExport(exportDirectory);
      else await removeFreshExport(root, exportDirectory).catch(() => log({ event: "fresh-check-round.export-remove.failed", taskId: input.taskId }));
    }
  }
}

/** `docker rm --force`, once more if it fails; a container that cannot be removed is logged, since it keeps the export mounted. */
async function removeContainer(docker: DockerCli, name: string, taskId: string, log: (event: Record<string, unknown>) => void): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await docker.run(["rm", "--force", name], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => ({ exitCode: -1, stdout: "", stderr: "" }));
    if (result.exitCode === 0 || /no such container/iu.test(result.stderr)) return true;
  }
  log({ event: "fresh-check-round.remove.failed", container: name, taskId });
  return false;
}

/**
 * Stops everything the agent left running in the WORKING sandbox by RESTARTING it (`docker restart --time 0`): the kernel kills every process of a PID namespace when its PID 1 exits, so nothing the agent started (a thread whose main
 * thread has exited, a fork-hopper that wins a listing race, a program that hides its name) can survive, and nothing needs to be found first. The container, its volume, its masks and its network stay as they are, so the agent's next turn
 * finds the same sandbox.
 *
 * IS A RESTART SAFE? Nothing the worker depends on lives in the sandbox's memory across a round: a command is its own `docker exec` in its own process group (no session or shell is kept), the file tools run one helper per call, the Python user
 * site and every file are on the volume, the container's own writable layer survives a restart, and the masks are empty tmpfs mounts made again at start. Test services are not combined with a fresh round (a plan with dependencies keeps its sealed
 * path), so no service is attached to the sandbox.
 *
 * THE VERDICT COMES FROM THE HOST, never from the container: after the restart the sandbox's state and the host's process listing of it (`docker top`, host-side PIDs) must show exactly tini (the PID `State.Pid` names) and one child of it, `sleep infinity`.
 * Anything else, or an answer that cannot be read, rejects, and the round is not run.
 */
export async function restartWorkingSandbox(docker: DockerCli, container: string, signal?: AbortSignal): Promise<void> {
  const fail = (): never => { throw new Error("programs the agent left running could not be stopped"); };
  const options = { timeoutMs: DOCKER_CALL_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) };
  const restarted = await docker.run(["restart", "--time", "0", container], options).catch(() => undefined);
  if (restarted === undefined || restarted.exitCode !== 0) return fail();
  const state = await docker.run(["inspect", "--format", "{{.State.Running}} {{.State.Pid}}", container], options).catch(() => undefined);
  const stateMatch = state === undefined || state.exitCode !== 0 ? null : /^true (\d+)\s*$/u.exec(state.stdout);
  const tini = stateMatch === null ? 0 : Number(stateMatch[1]);
  if (!Number.isSafeInteger(tini) || tini < 2) return fail();
  const top = await docker.run(["top", container, "-eo", "pid,ppid,args"], options).catch(() => undefined);
  if (top === undefined || top.exitCode !== 0) return fail();
  const lines = top.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== 3 || !/^PID\s+PPID\s+/iu.test(lines[0]!)) return fail();
  const rows = lines.slice(1).map((line) => /^(\d+)\s+(\d+)\s+(.*)$/u.exec(line));
  if (rows.some((row) => row === null)) return fail();
  const found = rows as RegExpExecArray[];
  // by PID, not by order: tini is the row of the container's PID 1 (host PID `State.Pid`) and runs `sleep infinity`; the other row is its one child, the sleep
  const tiniRows = found.filter((row) => Number(row[1]) === tini);
  const otherRows = found.filter((row) => Number(row[1]) !== tini);
  const isTini = tiniRows.length === 1 && /(^|\/)tini(\s|$)/u.test(tiniRows[0]![3]!);
  const isSleep = otherRows.length === 1 && Number(otherRows[0]![2]) === tini && otherRows[0]![3]!.trim() === "sleep infinity";
  if (!isTini || !isSleep) return fail();
}

/** Where the checks' reports of the last fresh round are read from, and the way to remove them (H1c). */
export interface FreshEvidenceSource {
  /** Records the candidate the next round is for (see `FreshCheckRoundInput.pinned`); call it with the identity read just before the checks are run. */
  pin(candidate: readonly FreshPinnedCandidate[]): void;
  /** The export of the last round that ran (its container is gone), or undefined: a round that did not run, or whose container could not be removed, leaves none. */
  evidenceRoot(): string | undefined;
  /** Removes what `evidenceRoot` names. Idempotent. */
  releaseEvidence(): Promise<void>;
}

/**
 * The runners a task uses for its official rounds when the round is fresh: a round opens at `freshServices` (which `runChecks` calls first, every round) and closes at `endRound` (which it calls last, also on failure), so each
 * `runChecks` is its own fresh sandbox. `freshServices` never rejects: a round that could not start leaves every command refused with the fixed "not run" sentence (a `CheckNotRunError`, so the check is `not_run`, never failed).
 * A command outside a round is refused too. The original-code rounds (before results, the test proof) do NOT use these: they run on the original code, where there is nothing to export (run-task.ts, check-round-choice.ts).
 */
export function createFreshCheckRunners(input: Omit<FreshCheckRoundInput, "pinned" | "retainExport"> & {
  /** Keep each round's export for the evidence (a CHECKS run that asked for it); otherwise it is removed with the sandbox. */
  keepExport?: boolean;
}): CheckRunners & FreshEvidenceSource {
  let pinned: readonly FreshPinnedCandidate[] | undefined;
  let open: { runners: CheckRunners; release: () => void; done: Promise<unknown> } | undefined;
  let failure: string | undefined;
  // Each round has a number; a round that ended (endRound, or a newer start) while its sandbox was still starting releases it the moment it is handed over (L3).
  let epoch = 0;
  let retained: string[] = [];
  const releaseRetained = async (): Promise<void> => {
    const directories = retained;
    retained = [];
    for (const directory of directories) await removeFreshExport(resolve(input.rootPath), directory).catch(() => undefined);
  };
  const close = async (): Promise<void> => {
    const current = open;
    open = undefined;
    if (current === undefined) return;
    current.release();
    await current.done.catch(() => undefined);
  };
  const current = (): CheckRunners => {
    if (open === undefined) throw new CheckNotRunError(failure ?? "not run: the fresh check sandbox is not open");
    return open.runners;
  };
  return {
    async freshServices(signal) {
      epoch += 1;
      const mine = epoch;
      await close();
      await releaseRetained();
      failure = undefined;
      let release!: () => void;
      const closed = new Promise<void>((done) => { release = done; });
      let handOver!: (runners: CheckRunners | undefined) => void;
      const ready = new Promise<CheckRunners | undefined>((done) => { handOver = done; });
      const roundSignal = input.signal === undefined ? signal : AbortSignal.any([signal, input.signal]);
      const { keepExport, ...rest } = input;
      const done = withFreshCheckRound({ ...rest, signal: roundSignal, pinned: () => pinned, ...(keepExport === true ? { retainExport: (directory: string) => { retained.push(directory); } } : {}) }, async (runners) => { handOver(runners); await closed; }).then(
        (result) => { if (result.kind === "not_run") { failure = result.sentence; handOver(undefined); } },
        () => { failure = FRESH_NOT_RUN_SENTENCES.sandbox_failed; handOver(undefined); },
      );
      const runners = await ready;
      if (runners === undefined) { await done; return; }
      // The round was ended or replaced while the sandbox started: nothing may keep it.
      if (epoch !== mine) { release(); await done.catch(() => undefined); await releaseRetained(); return; }
      open = { runners, release, done };
    },
    async endRound() { epoch += 1; await close(); },
    pin(candidate) { pinned = candidate.map((item) => ({ repositoryId: item.repositoryId, commitSha: item.commitSha, treeSha: item.treeSha })); },
    evidenceRoot: () => retained.at(-1),
    releaseEvidence: releaseRetained,
    // async: a refusal is a rejection, as the other runners' are.
    runProjectCommand: async (command, signal) => current().runProjectCommand(command, signal),
    runAgentCommand: async (replay, timeoutMs, signal) => current().runAgentCommand(replay, timeoutMs, signal),
  };
}

/** The Docker CLI a fresh round uses when the caller has none. */
export const defaultFreshDocker = (): DockerCli => createDockerCli();
