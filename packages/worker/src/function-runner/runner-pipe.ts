// The transport of the runner client (slice 4, lane W3): `docker exec -i <local-aws helper> /usr/local/bin/rovara-aws-front runner-pipe`. `runner-pipe` joins its stdin and stdout to the front's unix socket inside the helper
// (ROVARA_AWS_RUNNER_SOCKET, mode 0600): no TCP port, no token, only whoever can `docker exec` (the worker) can speak to the front. The bytes on stdin and stdout are runner/2 frames (runner-frames.ts).
//
// ARGV. The one command is built from a typed spec (`PipeSpec`) and checked against an allow-list before the launcher sees it, like the sandbox controller's: `exec -i <container> <front binary> runner-pipe`, five arguments, no
// other flag (no --user, --env, --privileged, --workdir, -t). The container name is one this worker made for a helper (see `helperContainerName`): plain characters, never a flag. Nothing the front or a function says reaches it.
import { spawn } from "node:child_process";

export const FRONT_BINARY = "/usr/local/bin/rovara-aws-front";
/** The helper names service-helpers.ts makes: `<services network>-h<10 hex>`. Plain characters, never starts with a dash. */
const HELPER_CONTAINER = /^[a-z0-9][a-z0-9_.-]{0,126}$/u;

export class PipeSpecError extends Error {
  constructor(readonly reason: string) {
    super(`not a sound runner pipe: ${reason}`);
    this.name = "PipeSpecError";
  }
}

export interface PipeSpec {
  /** The local-aws helper's container name. */
  helperContainer: string;
}

export function validatePipeSpec(spec: PipeSpec): void {
  if (!HELPER_CONTAINER.test(spec.helperContainer)) throw new PipeSpecError("helper container name");
}

export function pipeArgs(spec: PipeSpec): string[] {
  validatePipeSpec(spec);
  return ["exec", "-i", spec.helperContainer, FRONT_BINARY, "runner-pipe"];
}

/** Everything wrong with `args` as the pipe command for `expected`; empty when sound. A structural check, independent of `pipeArgs`: it refuses every flag the command does not emit. */
export function pipeArgProblems(args: readonly string[], expected: PipeSpec): string[] {
  const problems: string[] = [];
  if (args.length !== 5) problems.push("argument count");
  if (args[0] !== "exec") problems.push("subcommand");
  if (args[1] !== "-i") problems.push("flags");
  if (args[2] !== expected.helperContainer || !HELPER_CONTAINER.test(args[2] ?? "")) problems.push("container");
  if (args[3] !== FRONT_BINARY) problems.push("program");
  if (args[4] !== "runner-pipe") problems.push("mode");
  return problems;
}

export interface PipeExit {
  /** The docker client's exit code; null when killed by a signal. */
  code: number | null;
  signal: string | null;
}

/** One running `docker exec -i` client: stdin and stdout are the runner pipe. */
export interface PipeProcess {
  /** Writes bytes to the front. Resolves when flushed; rejects when the pipe is closed. */
  write(data: Buffer): Promise<void>;
  onStdout(listener: (chunk: Buffer) => void): void;
  /** The docker client's own stderr. Only a short tail is ever kept, for a diagnosis. */
  onStderr(listener: (chunk: Buffer) => void): void;
  /** Stops reading stdout (the client's flow control: a package is arriving faster than the disk takes it). */
  pause(): void;
  resume(): void;
  /** Resolves once the process has ended AND everything it wrote to stdout has been delivered to the listeners. */
  readonly exited: Promise<PipeExit>;
  /** Closes stdin (the front sees the end of the stream), then SIGKILLs the docker client after a moment. Idempotent. */
  end(): void;
  /** SIGKILLs the docker client at once. Idempotent. */
  kill(): void;
}

export interface PipeLauncher {
  /** Starts `docker <args>`; the client has already checked `args` against the allow-list. */
  start(args: readonly string[]): PipeProcess;
}

/** The docker client gets only what it needs to find the daemon, never the worker's own environment. */
function clientEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

export interface DockerExecPipeLauncherOptions {
  dockerBinary?: string;
  /** How long after closing stdin the docker client is killed (default 2 s). */
  killAfterMs?: number;
}

export function dockerExecPipeLauncher(options: DockerExecPipeLauncherOptions = {}): PipeLauncher {
  const binary = options.dockerBinary ?? "docker";
  const killAfterMs = options.killAfterMs ?? 2_000;
  return {
    start(args) {
      if (args[0] !== "exec" || args[1] !== "-i") throw new RangeError("the runner pipe launcher starts `docker exec -i` only");
      const child = spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"], env: clientEnvironment() });
      const stdoutListeners: Array<(chunk: Buffer) => void> = [];
      const stderrListeners: Array<(chunk: Buffer) => void> = [];
      child.stdout.on("data", (chunk: Buffer) => { for (const listener of stdoutListeners) listener(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { for (const listener of stderrListeners) listener(chunk); });
      child.stdin.on("error", () => undefined);
      const exited = new Promise<PipeExit>((resolve) => {
        child.on("close", (code, signal) => resolve({ code, signal }));
        child.on("error", () => resolve({ code: 127, signal: null }));
      });
      const kill = (): void => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
      let ending = false;
      return {
        write: (data) => new Promise<void>((resolve, reject) => {
          if (child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error("closed")); return; }
          child.stdin.write(data, (error) => { if (error) reject(error); else resolve(); });
        }),
        onStdout: (listener) => { stdoutListeners.push(listener); },
        onStderr: (listener) => { stderrListeners.push(listener); },
        pause: () => { child.stdout.pause(); },
        resume: () => { child.stdout.resume(); },
        exited,
        end: () => {
          if (ending) return;
          ending = true;
          child.stdin.end();
          const timer = setTimeout(kill, killAfterMs);
          timer.unref();
          void exited.then(() => { clearTimeout(timer); });
        },
        kill,
      };
    },
  };
}
