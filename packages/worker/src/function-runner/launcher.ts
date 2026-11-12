// The seam between the controller and a real `docker run -i` client process (slice 4, lane W1). Tests give the controller a fake launcher; production gives it `dockerRunLauncher`.

import { spawn } from "node:child_process";

export interface SandboxExit {
  /** The docker client's exit code (the container's, when docker passes it through; 125 to 127 are docker's own errors). Null when killed by a signal. */
  code: number | null;
  signal: string | null;
}

/** One running `docker run -i` client: stdin and stdout are the agent's pipe. */
export interface SandboxProcess {
  /** Writes bytes to the agent. Resolves when they are flushed; rejects when the pipe is closed. */
  write(data: Buffer): Promise<void>;
  onStdout(listener: (chunk: Buffer) => void): void;
  /** The docker client's own stderr. The controller keeps only a short tail, for a start failure. */
  onStderr(listener: (chunk: Buffer) => void): void;
  /** Resolves once the process has ended AND everything it wrote to stdout has been delivered to the listeners. */
  readonly exited: Promise<SandboxExit>;
  /** SIGKILLs the docker client (the container itself is ended by name). Idempotent. */
  kill(): void;
}

export interface SandboxLauncher {
  /** Starts `docker <args>`. The controller has already checked `args` against the allow-list. */
  start(args: readonly string[]): SandboxProcess;
}

export interface DockerRunLauncherOptions {
  dockerBinary?: string;
}

/** The docker client gets only what it needs to find the daemon, never the worker's own environment. */
function clientEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

export function dockerRunLauncher(options: DockerRunLauncherOptions = {}): SandboxLauncher {
  const binary = options.dockerBinary ?? "docker";
  return {
    start(args) {
      if (args[0] !== "run" || !args.includes("-i")) throw new RangeError("the sandbox launcher starts `docker run -i` only");
      const child = spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"], env: clientEnvironment() });
      const stdoutListeners: Array<(chunk: Buffer) => void> = [];
      const stderrListeners: Array<(chunk: Buffer) => void> = [];
      child.stdout.on("data", (chunk: Buffer) => { for (const listener of stdoutListeners) listener(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { for (const listener of stderrListeners) listener(chunk); });
      child.stdin.on("error", () => undefined);
      const exited = new Promise<SandboxExit>((resolve) => {
        // `close` comes after stdout has ended, so every frame has been delivered by then. `error` (no docker binary) resolves as a docker error.
        child.on("close", (code, signal) => resolve({ code, signal }));
        child.on("error", () => resolve({ code: 127, signal: null }));
      });
      return {
        write: (data) => new Promise<void>((resolve, reject) => {
          if (child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error("closed")); return; }
          child.stdin.write(data, (error) => { if (error) reject(error); else resolve(); });
        }),
        onStdout: (listener) => { stdoutListeners.push(listener); },
        onStderr: (listener) => { stderrListeners.push(listener); },
        exited,
        kill: () => { if (!child.killed) child.kill("SIGKILL"); },
      };
    },
  };
}
