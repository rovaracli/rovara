// A fake Docker and a fake agent for the function runner's sandbox controller tests (slice 4, lane W1). Nothing starts a process: `launcher.start` makes an in-memory container whose "agent" answers the controller's
// frames through a handler the test gives it, and `docker.run` answers kill, rm and inspect on those containers. It records every argument list and can be told to fail, hang or die.
import type { AgentFrame, WorkerFrame } from "../../packages/worker/src/function-runner/codec.js";
import type { SandboxExit, SandboxLauncher, SandboxProcess } from "../../packages/worker/src/function-runner/launcher.js";
import type { DockerControl } from "../../packages/worker/src/function-runner/controller.js";

export interface FakeContainer {
  name: string;
  args: string[];
  running: boolean;
  oom: boolean;
  frames: WorkerFrame[];
  emit(frame: AgentFrame): void;
  /** Writes raw bytes to the agent's stdout (a hostile or broken agent). */
  emitRaw(bytes: Buffer): void;
  /** Ends the container as the kernel or the function would (the docker client exits with `code`). */
  die(code: number, options?: { oom?: boolean }): void;
}

export type AgentBehavior = (frame: WorkerFrame, container: FakeContainer) => void;

export interface FakeSandboxHostOptions {
  /** What the fake agent does with each frame. Default: answers every invoke with its payload echoed. */
  agent?: AgentBehavior;
  /** What the fake agent says when its sandbox starts. Default: `hello` then `ready`. */
  startup?: (container: FakeContainer) => void;
  /** `docker run` fails like a daemon error: the client exits 125 with this stderr and no container exists. */
  failRun?: string;
  /** Called for each `docker rm`; true makes it fail. */
  failRm?: (name: string) => boolean;
  /** Called for each `docker kill`; true makes it hang until `releaseHung()`. */
  hangKill?: (name: string) => boolean;
  idOf?: (name: string) => string;
  /** What `docker network inspect` knows. Default: one internal network, rovara-svc-0123456789ab, 10.20.30.0/24. */
  networks?: Record<string, { internal: boolean; subnet: string }>;
}

/** The files the controller writes: scratch folders and environment files, kept in memory. `written` keeps every environment file ever written (they are deleted once the sandbox is up). */
export function fakeSandboxFiles() {
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  const written: Array<{ path: string; content: string }> = [];
  return {
    dirs, files, written,
    makeScratchDir: (path: string): Promise<void> => { dirs.add(path); return Promise.resolve(); },
    removeScratchDir: (path: string): Promise<void> => { dirs.delete(path); return Promise.resolve(); },
    writeEnvFile: (path: string, content: string): Promise<void> => { files.set(path, content); written.push({ path, content }); return Promise.resolve(); },
    removeEnvFile: (path: string): Promise<void> => { files.delete(path); return Promise.resolve(); },
  };
}

/** The real agent's first two frames: hello, then ready once the runtime polls. */
export const helloReady = (container: FakeContainer): void => {
  container.emit({ type: "hello", proto: "agent/1", agent: "fake", version: "0" });
  container.emit({ type: "ready", initDurationMs: 5, logTail: "init output\n" });
};

/** A result frame for `frame` (an invoke); `payload` is base64. */
export const resultFor = (frame: WorkerFrame & { type: "invoke" }, change: Partial<Extract<AgentFrame, { type: "result" }>> = {}): AgentFrame => ({
  type: "result", requestId: frame.requestId, status: "ok", payload: frame.payload, logTail: `START RequestId: ${frame.requestId}\nhello\nEND RequestId: ${frame.requestId}\n`, durationMs: 3, billedDurationMs: 3, maxMemoryUsed: 20_000_000, ...change,
});

export const echoAgent: AgentBehavior = (frame, container) => {
  if (frame.type === "invoke") container.emit(resultFor(frame));
};

export function fakeSandboxHost(options: FakeSandboxHostOptions = {}) {
  const containers = new Map<string, FakeContainer>();
  /** Every container ever started, by name, kept after removal. */
  const everStarted: FakeContainer[] = [];
  const runArgs: string[][] = [];
  const controlCalls: string[][] = [];
  const hung: Array<() => void> = [];
  const agent = options.agent ?? echoAgent;
  const decoderOf = () => {
    let pending = Buffer.alloc(0);
    return (chunk: Buffer): WorkerFrame[] => {
      pending = Buffer.concat([pending, chunk]);
      const frames: WorkerFrame[] = [];
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const length = pending.readUInt32BE(0);
        frames.push(JSON.parse(pending.subarray(4, 4 + length).toString("utf8")) as WorkerFrame);
        pending = pending.subarray(4 + length);
      }
      return frames;
    };
  };

  const launcher: SandboxLauncher = {
    start(args) {
      runArgs.push([...args]);
      const stdout: Array<(chunk: Buffer) => void> = [];
      const stderr: Array<(chunk: Buffer) => void> = [];
      let resolveExit!: (exit: SandboxExit) => void;
      const exited = new Promise<SandboxExit>((resolve) => { resolveExit = resolve; });
      let done = false;
      // Output the agent has written but the controller has not been handed yet. A real pipe keeps what was written before the process ended and delivers it before `close`, so ending the process flushes this queue
      // first. (The fake used to drop it once `done` was set: an answer followed by an exit within one event-loop turn was lost, which no real docker client does.)
      const unsent: Buffer[] = [];
      const deliver = (chunk: Buffer): void => { for (const listener of stdout) listener(chunk); };
      const end = (exit: SandboxExit): void => {
        if (done) return;
        for (const chunk of unsent.splice(0)) deliver(chunk);
        done = true;
        setImmediate(() => resolveExit(exit));
      };
      const send = (bytes: Buffer): void => { unsent.push(bytes); setImmediate(() => { const next = unsent.shift(); if (next !== undefined) deliver(next); }); };
      const name = args[args.indexOf("--name") + 1]!;
      const container: FakeContainer = {
        name, args: [...args], running: true, oom: false, frames: [],
        emit: (frame) => { if (done) return; const body = Buffer.from(JSON.stringify(frame)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); send(Buffer.concat([header, body])); },
        emitRaw: (bytes) => { if (!done) send(bytes); },
        die: (code, dieOptions) => { if (!container.running) return; container.running = false; container.oom = dieOptions?.oom === true; end({ code, signal: null }); },
      };
      const decode = decoderOf();
      const process: SandboxProcess = {
        write(data) {
          if (done) return Promise.reject(new Error("closed"));
          for (const frame of decode(data)) { container.frames.push(frame); setImmediate(() => { if (!done) agent(frame, container); }); }
          return Promise.resolve();
        },
        onStdout: (listener) => { stdout.push(listener); },
        onStderr: (listener) => { stderr.push(listener); },
        exited,
        kill: () => end({ code: null, signal: "SIGKILL" }),
      };
      if (options.failRun !== undefined) {
        setImmediate(() => { for (const listener of stderr) listener(Buffer.from(options.failRun!)); });
        end({ code: 125, signal: null });
        return process;
      }
      containers.set(name, container);
      everStarted.push(container);
      (options.startup ?? helloReady)(container);
      return process;
    },
  };

  const docker: DockerControl = {
    async run(args) {
      controlCalls.push([...args]);
      const name = args.at(-1)!;
      const container = containers.get(name);
      const missing = { exitCode: 1, stdout: "", stderr: `Error response from daemon: No such container: ${name}` };
      if (args[0] === "network" && args[1] === "inspect") {
        const known = options.networks ?? { "rovara-svc-0123456789ab": { internal: true, subnet: "10.20.30.0/24" } };
        const network = known[name];
        if (network === undefined) return { exitCode: 1, stdout: "", stderr: `Error: No such network: ${name}` };
        return { exitCode: 0, stdout: `${String(network.internal)} ${network.subnet} \n`, stderr: "" };
      }
      if (args[0] === "kill") {
        if (options.hangKill?.(name) === true) await new Promise<void>((resolve) => { hung.push(resolve); });
        if (container === undefined) return missing;
        container.die(137);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rm") {
        if (options.failRm?.(name) === true) return { exitCode: 1, stdout: "", stderr: "Error response from daemon: cannot remove container" };
        if (container === undefined) return missing;
        container.die(137);
        containers.delete(name);
        return { exitCode: 0, stdout: `${name}\n`, stderr: "" };
      }
      if (args[0] === "inspect") {
        if (container === undefined) return missing;
        if (args.includes("{{.Id}}")) return { exitCode: 0, stdout: `${options.idOf?.(name) ?? name.replace(/^rovara-fn-/u, "").padEnd(64, "a")}\n`, stderr: "" };
        return { exitCode: 0, stdout: `${JSON.stringify({ Running: container.running, ExitCode: container.running ? 0 : 137, OOMKilled: container.oom })}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    },
  };

  return { docker, launcher, containers, everStarted, runArgs, controlCalls, releaseHung: () => { for (const release of hung.splice(0)) release(); } };
}
