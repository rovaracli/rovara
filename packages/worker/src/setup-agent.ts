// Setup agent (design setup-test-health 3.1-3.2 and 12, task SH7): the worker's half of the setup run that RUNS things. This module is the part that can be built and tested without the model session:
// the sandbox the commands run in and the rules around it, the shell the agent gets, the check that tracked files were left alone, and the reading of the final answer. The session itself is created
// by the caller (run-task.ts, SH14) with `setupAgentSessionParts`, and the journal and the limits are SH8 (`SetupAgentHooks` is where they plug in).
//
// What is enforced here, in code, and does not depend on what the model was told:
//   - the setup sandbox is the R56 task sandbox, started through a Docker seam that REFUSES a `docker run` with an environment variable, an env file, an extra mount, the Docker socket, a capability,
//     a network other than the task network, a different user or any flag it does not know; and refuses a `docker exec` that passes a credential-shaped variable (by name or by value). The
//     sandbox therefore holds no secret: none is ever given to it;
//   - the tools are read, grep, find, ls and bash. There is no write tool and no edit tool;
//   - after every command, `git` (run by the worker in a throw-away repository, so the repository's own config cannot run anything in the worker) says whether a tracked file changed, the index
//     changed, or HEAD moved. If so the run ends `changed_repository_files`, no later command runs, and there is no proposal;
//   - a command that downloads code and runs it is marked in the journal record (`flagged`); the proposal reader flags it again and never turns it into an item;
//   - a command has a time limit even when the model names none;
//   - the answer is read by the draft's reader (`readSetupProposalAnswer`): bounded, redacted, cited, secrets by name only. Repository text and command output are data.
import { agentXError, isCredentialKey, redactText, remoteCodeReason, type SetupProposal, type SetupRunEndWord } from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { runIsolatedGit } from "./isolated-repository.js";
import type { CollectedProcess, CollectedProcessOptions } from "./collected-process.js";
import { asksForCodeChange } from "./setup-agent-prompt.js";
import { SETUP_AGENT_MAX_OUTPUT_TOKENS } from "./setup-agent-journal.js";
import { readSetupProposalAnswer, type SetupDraftRepository } from "./setup-draft.js";
import { TASK_SANDBOX_NETWORK, TASK_SANDBOX_USER, TaskSandbox, type TaskSandboxOptions } from "./task-sandbox.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";

/** The agent's tools: read-only file tools and the shell. No write tool, no edit tool. Passed to the session as `agentTools`. */
export const SETUP_AGENT_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;

/** One command's longest run when the model names no time limit, in seconds. The wall clock of the whole run is the governor's (SH8). */
export const SETUP_COMMAND_DEFAULT_TIMEOUT_SECONDS = 1_800;
/** The most a model may ask for one command, in seconds. */
export const SETUP_COMMAND_MAX_TIMEOUT_SECONDS = 3_600;
/** Bytes of redacted output a command record keeps (the journal's tail). */
export const SETUP_COMMAND_TAIL_BYTES = 4_096;
/** What a refused command prints, in fixed words. */
export const SETUP_COMMAND_REFUSED_TEXT = "Rovara did not run this command because the setup run has ended.";
const CAPTURE_BYTES = 64 * 1024;

// ---- no credential reaches the sandbox

/**
 * Names that read as credentials by the key rule or the AWS prefix but are not: the region, and pi's session identifiers (`PI_SESSION_ID` and `PI_SESSION_FILE`, which pi puts in its shell's
 * environment). They are exempt from the NAME rules only; a credential-shaped VALUE under any name is still found.
 */
const NON_SECRET_NAMES = new Set(["AWS_REGION", "AWS_DEFAULT_REGION", "PI_SESSION_ID", "PI_SESSION_FILE"]);

/**
 * The names of the variables that look like credentials, by the project's own key rule (`isCredentialKey`), by an AWS prefix, or because the value has a credential shape that `redactText` would
 * redact (a key, a token, a private key, a URL with a password). Names only, in the order given: a value is never returned.
 */
export function credentialShapedVariables(environment: Readonly<Record<string, string | undefined>>): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const pair = `${name}=${value}`;
    const byName = !NON_SECRET_NAMES.has(name) && (isCredentialKey(name) || name.startsWith("AWS_"));
    if (byName || redactText(value) !== value || (!NON_SECRET_NAMES.has(name) && redactText(pair) !== pair)) names.push(name);
  }
  return names;
}

const ALLOWED_RUN_FLAGS: ReadonlyMap<string, number> = new Map([
  ["--detach", 0], ["--name", 1], ["--label", 1], ["--network", 1], ["--user", 1], ["--cpus", 1], ["--memory", 1], ["--memory-swap", 1], ["--pids-limit", 1],
  ["--cap-drop", 1], ["--security-opt", 1], ["--volume", 1], ["--tmpfs", 1], ["--workdir", 1], ["--entrypoint", 1],
]);

/**
 * Whether `docker run` arguments make the sandbox the R56 shape and nothing more: only the flags the task sandbox uses, the task network, the sandbox user, all capabilities dropped, no new
 * privileges, a process limit, one mount of the workspace at its own path, and nothing that names the Docker socket. An environment variable (`--env`, `-e`, `--env-file`) is a flag this list does
 * not have, so it is refused with every other unknown flag. Throws `RUNTIME_UNAVAILABLE` with a fixed sentence (no argument is repeated, since an argument could be a secret).
 */
export function assertSetupSandboxRunArgs(args: readonly string[]): void {
  const refuse = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", "AgentX refused to start the setup sandbox: its container options are not the sandbox's"); };
  if (args[0] !== "run") return refuse();
  const seen = new Map<string, string[]>();
  let index = 1;
  for (; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("-")) break;
    const arity = ALLOWED_RUN_FLAGS.get(token);
    if (arity === undefined) return refuse();
    const value = arity === 0 ? "" : args[index + 1];
    if (value === undefined) return refuse();
    index += arity;
    seen.set(token, [...(seen.get(token) ?? []), value]);
  }
  if (index >= args.length) return refuse();
  if (args.some((argument) => argument.includes("docker.sock"))) return refuse();
  const one = (flag: string): string | undefined => (seen.get(flag)?.length === 1 ? seen.get(flag)![0] : undefined);
  if (one("--network") !== TASK_SANDBOX_NETWORK || one("--user") !== TASK_SANDBOX_USER) return refuse();
  if (!(seen.get("--cap-drop") ?? []).includes("ALL") || !(seen.get("--security-opt") ?? []).includes("no-new-privileges") || one("--pids-limit") === undefined) return refuse();
  const volumes = seen.get("--volume") ?? [];
  if (volumes.length !== 1) return refuse();
  const [source, target, ...extra] = volumes[0]!.split(":");
  if (extra.length > 0 || source === undefined || source !== target || !source.startsWith("/")) return refuse();
}

/**
 * The Docker seam of a setup sandbox. `run` must pass `assertSetupSandboxRunArgs`. `exec` must not pass a credential-shaped variable (`--env NAME=value`): it is refused by name, and the value is
 * never repeated. Everything else (inspect, network, rm) passes. Wraps the real Docker, or a fake in a test.
 */
export function guardedSetupDocker(docker: DockerCli = createDockerCli()): DockerCli {
  return {
    async run(args: readonly string[], options?: CollectedProcessOptions): Promise<CollectedProcess> {
      if (args[0] === "run") assertSetupSandboxRunArgs(args);
      if (args[0] === "exec") {
        const environment: Record<string, string> = {};
        for (let index = 1; index < args.length - 1; index += 1) {
          if (args[index] !== "--env" && args[index] !== "-e") continue;
          const pair = args[index + 1] ?? "";
          const cut = pair.indexOf("=");
          if (cut > 0) environment[pair.slice(0, cut)] = pair.slice(cut + 1);
        }
        const found = credentialShapedVariables(environment);
        if (found.length > 0) throw agentXError("RUNTIME_UNAVAILABLE", `AgentX refused to pass ${found.length === 1 ? "a credential-shaped variable" : "credential-shaped variables"} to the setup sandbox (${found.join(", ")})`);
      }
      return docker.run(args, options);
    },
    ...(docker.execBytes === undefined ? {} : { execBytes: docker.execBytes.bind(docker) }),
  };
}

/** The setup sandbox: the R56 task sandbox, through the guarded Docker seam. Nothing falls back to the local shell. */
export function createSetupSandbox(options: Omit<TaskSandboxOptions, "docker"> & { docker?: DockerCli }): TaskSandbox {
  return new TaskSandbox({ ...options, docker: guardedSetupDocker(options.docker) });
}

// ---- tracked files are left alone

export interface SetupAgentRepository extends SetupDraftRepository {
  /** The directory of the repository on the worker. */
  directory: string;
}

/** What the check found, in fixed words. */
export type TrackedFilesVerdict = { ok: true } | { ok: false; reason: "tracked_files_changed" | "head_moved" | "unreadable" };

/** Runs one git command in a repository without trusting its config; default: the worker's isolated git. A test gives a fake. */
export type SetupGit = (directory: string, args: readonly string[]) => Promise<string>;

const defaultGit: SetupGit = (directory, args) => runIsolatedGit(directory, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });

/**
 * Whether every repository is still at the commit it was cloned at, with no change to a tracked file in the work tree or the index. `git status --porcelain --untracked-files=no` lists a changed or
 * staged tracked path; `rev-parse HEAD` must equal the cloned commit. Untracked and ignored files (`node_modules`, build output) are the point of setup and are not looked at. A repository with no
 * recorded commit, or any git failure, is `unreadable`, which ends the run like a change: the check never passes on a guess.
 */
export async function checkTrackedFiles(repositories: ReadonlyArray<SetupAgentRepository>, git: SetupGit = defaultGit): Promise<TrackedFilesVerdict> {
  for (const repository of repositories) {
    if (repository.resolvedCommit === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(repository.resolvedCommit)) return { ok: false, reason: "unreadable" };
    try {
      const head = (await git(repository.directory, ["rev-parse", "--verify", "HEAD"])).trim();
      if (head !== repository.resolvedCommit) return { ok: false, reason: "head_moved" };
      if ((await git(repository.directory, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"])).trim() !== "") return { ok: false, reason: "tracked_files_changed" };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  return { ok: true };
}

// ---- the agent's shell

/** What one command left behind: the record SH8's journal keeps. The command is the model's text, redacted; the tail is redacted output. */
export interface SetupCommandRecord {
  command: string;
  /** The command downloads code and runs it (the same rule as the proposal's flag). */
  flagged: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  tail: string;
  startedAt: number;
  ticket?: unknown;
}

/** `ticket`: whatever the hook needs to match the command to its reservation; the shell hands it back unchanged in the record. */
export type SetupCommandDecision = { allow: true; ticket?: unknown } | { allow: false };

/** Where the journal and the governor (SH8) plug in. `beforeCommand` may refuse a command (a limit is used up); `afterCommand` sees every command that ran. */
export interface SetupAgentHooks {
  beforeCommand?(command: string, flagged: boolean): SetupCommandDecision | Promise<SetupCommandDecision>;
  afterCommand?(record: SetupCommandRecord): void | Promise<void>;
  /** The most seconds the next command may run (the wall clock that is left). The shell never gives a command more, whatever the model asked. */
  maxTimeoutSeconds?(): number;
  /** The shell ended the run because a command changed the repositories. */
  onEnded?(word: "changed_repository_files"): void;
}

export interface SetupAgentShell {
  operations: BashOperations;
  /** Why the run must end, once a command changed tracked files; undefined while it can go on. */
  ended(): Extract<SetupRunEndWord, "changed_repository_files"> | undefined;
  /** The check the shell makes after each command, run once more by the caller at the end. */
  verdict(): TrackedFilesVerdict | undefined;
}

export interface SetupAgentShellInput {
  base: BashOperations;
  hooks?: SetupAgentHooks;
  /** Called after each command, and decides whether tracked files are still untouched. Absent: not checked (a test of the rest). */
  checkFiles?: () => Promise<TrackedFilesVerdict>;
  now?: () => number;
}

/** The last `bytes` bytes of `text`, cut on a character boundary, redacted, and plain (control characters other than newline and tab become `?`). */
export function commandTail(text: string, bytes = SETUP_COMMAND_TAIL_BYTES): string {
  const redacted = redactText(text);
  const buffer = Buffer.from(redacted, "utf8");
  const cut = buffer.length > bytes ? buffer.subarray(buffer.length - bytes).toString("utf8").replace(/^�+/u, "") : redacted;
  return cut.replace(/[^\P{Cc}\n\t]/gu, "?");
}

/**
 * The agent's shell: pi's bash tool runs through it. A command runs only while the run can go on, and not when `beforeCommand` refuses it; it always has a time limit; its output is kept as a bounded,
 * redacted tail; `afterCommand` sees the record; and tracked files are checked after it. A refused command prints one fixed sentence and exits 126.
 */
export function setupAgentShell(input: SetupAgentShellInput): SetupAgentShell {
  const now = input.now ?? Date.now;
  let ended: "changed_repository_files" | undefined;
  let last: TrackedFilesVerdict | undefined;
  const operations: BashOperations = {
    async exec(command, cwd, options) {
      const flagged = remoteCodeReason(command) !== undefined;
      const refuse = async (): Promise<{ exitCode: number }> => { options.onData(Buffer.from(`${SETUP_COMMAND_REFUSED_TEXT}\n`)); return { exitCode: 126 }; };
      if (ended !== undefined) return refuse();
      const decision = await input.hooks?.beforeCommand?.(command, flagged);
      if (decision?.allow === false) return refuse();
      // A time limit always: the model's, up to the most, else the default.
      const requested = options.timeout !== undefined && options.timeout > 0 ? options.timeout : SETUP_COMMAND_DEFAULT_TIMEOUT_SECONDS;
      const left = input.hooks?.maxTimeoutSeconds?.();
      const timeout = Math.max(1, Math.min(requested, SETUP_COMMAND_MAX_TIMEOUT_SECONDS, left === undefined || !Number.isFinite(left) ? Infinity : Math.floor(left)));
      let captured = "";
      const startedAt = now();
      let exitCode: number | null = null;
      let timedOut = false;
      let failure: unknown;
      try {
        const result = await input.base.exec(command, cwd, {
          ...options,
          timeout,
          onData: (data) => {
            captured = (captured + data.toString("utf8")).slice(-CAPTURE_BYTES);
            options.onData(data);
          },
        });
        exitCode = result.exitCode;
      } catch (error) {
        failure = error;
        timedOut = error instanceof Error && error.message.startsWith("timeout:");
      }
      const record: SetupCommandRecord = {
        command: redactText(command), flagged, ...(decision?.allow === true && decision.ticket !== undefined ? { ticket: decision.ticket } : {}), exitCode, durationMs: Math.max(0, Math.round(now() - startedAt)), timedOut, tail: commandTail(captured), startedAt,
      };
      await input.hooks?.afterCommand?.(record);
      if (input.checkFiles !== undefined) {
        last = await input.checkFiles();
        if (!last.ok) {
          ended = "changed_repository_files";
          input.hooks?.onEnded?.("changed_repository_files");
          options.onData(Buffer.from("\nRovara found that this command changed the project's files, so the setup run has ended.\n"));
        }
      }
      if (failure !== undefined) throw failure instanceof Error ? failure : new Error("the command could not run");
      return { exitCode };
    },
  };
  return { operations, ended: () => ended, verdict: () => last };
}

/**
 * The parts of the session input the caller adds to its own (run-task.ts, SH14): the tools, the shell and the sandbox's file tools. The session runs as an IMPLEMENT-mode session narrowed to
 * these tools, so it has the shell and no write or edit tool.
 */
export function setupAgentSessionParts(input: { sandbox: TaskSandbox; shell: SetupAgentShell }): {
  workflowMode: "IMPLEMENT"; agentTools: readonly string[]; bashOperations: BashOperations; fileTools: ReturnType<TaskSandbox["fileOpsTarget"]>; sequentialTools: true; maxOutputTokens: number;
} {
  // Sequential tools: the governor counts a command when it is allowed, but one command at a time is also what the journal and the live view show. The output cap bounds what one turn can cost.
  return { workflowMode: "IMPLEMENT", agentTools: SETUP_AGENT_TOOLS, bashOperations: input.shell.operations, fileTools: input.sandbox.fileOpsTarget(), sequentialTools: true, maxOutputTokens: SETUP_AGENT_MAX_OUTPUT_TOKENS };
}

// ---- the final answer

export type SetupAgentOutcome =
  | { ok: true; end: "proposed" | "needs_code_change"; proposal: SetupProposal; answered: boolean; flaggedRan: number }
  | { ok: false; end: "changed_repository_files" | "infrastructure"; errors: string[] };

/**
 * Reads the run's final answer. A run that changed tracked files has no proposal (the verdict from the last check, run once more here by the caller, decides). Otherwise the answer is read by the draft's
 * reader, so every item is cited, every download-and-run command is flagged and never an item, and secrets are names only. A first line of `NEEDS CODE CHANGE:` ends the run `needs_code_change`,
 * and the proposal still holds what was learned. `flaggedRan` counts the commands the run ran that download code: the record shows them, whatever the proposal lists.
 */
export async function finishSetupAgent(input: {
  finalText: string;
  verdict: TrackedFilesVerdict | undefined;
  basedOnRevision: number;
  rootPath: string;
  repositories: ReadonlyArray<SetupDraftRepository>;
  metaRepo?: string | undefined;
  records: ReadonlyArray<Pick<SetupCommandRecord, "flagged">>;
}): Promise<SetupAgentOutcome> {
  if (input.verdict === undefined || !input.verdict.ok) return { ok: false, end: "changed_repository_files", errors: [input.verdict === undefined ? "the repositories were not checked" : input.verdict.reason] };
  const read = await readSetupProposalAnswer(input.finalText, {
    basedOnRevision: input.basedOnRevision, rootPath: input.rootPath, repositories: input.repositories, ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }),
  });
  if (!read.ok) return { ok: false, end: "infrastructure", errors: read.errors };
  return { ok: true, end: asksForCodeChange(input.finalText) ? "needs_code_change" : "proposed", proposal: read.proposal, answered: read.answered, flaggedRan: input.records.filter((record) => record.flagged).length };
}
