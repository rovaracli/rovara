// Slice 4, lane W3: the runner pipe's command, the link that dials it and redials, a real child process behind the docker launcher, and the helper environment.
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FunctionCodeStore } from "../../../packages/worker/src/function-runner/code-store.js";
import { createRunnerClient } from "../../../packages/worker/src/function-runner/runner-client.js";
import { runnerHelperEnv, runnerStoreMount } from "../../../packages/worker/src/function-runner/runner-helper-env.js";
import { FRONT_BINARY, PipeSpecError, dockerExecPipeLauncher, pipeArgProblems, pipeArgs, type PipeLauncher } from "../../../packages/worker/src/function-runner/runner-pipe.js";
import { startRunnerLink, type RunnerSession } from "../../../packages/worker/src/function-runner/runner-link.js";
import { FakePipe, fakeController, type FakeController } from "../../support/fake-runner-front.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const settings = { imageForRuntime: () => "img", agentHostPath: "/opt/agent", network: { mode: "none" as const } };
const HELPER = "rvi-abc123-h0123456789";
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describe("the pipe command", () => {
  it("is exec -i <helper> <front> runner-pipe and nothing else", () => {
    const args = pipeArgs({ helperContainer: HELPER });
    expect(args).toEqual(["exec", "-i", HELPER, FRONT_BINARY, "runner-pipe"]);
    expect(pipeArgProblems(args, { helperContainer: HELPER })).toEqual([]);
  });

  it("refuses a container name that could be a flag or a second word, and any argv that has grown", () => {
    for (const name of ["--privileged", "-u", "a b", "a;b", "", "A", "a/b", `x${"y".repeat(130)}`, "a\nb"]) expect(() => pipeArgs({ helperContainer: name })).toThrow(PipeSpecError);
    const good = pipeArgs({ helperContainer: HELPER });
    const spec = { helperContainer: HELPER };
    for (const bad of [[...good, "--env", "X=1"], ["exec", "-i", "--user", "root", ...good.slice(2)], ["exec", "-it", ...good.slice(2)], ["run", ...good.slice(1)], [...good.slice(0, 3), "/bin/sh", "runner-pipe"], [...good.slice(0, 4), "sh"], ["exec", "-i", "other", ...good.slice(3)]]) {
      expect(pipeArgProblems(bad, spec).length).toBeGreaterThan(0);
    }
  });

  it("starts only `docker exec -i`", () => {
    const launcher = dockerExecPipeLauncher({ dockerBinary: "/nonexistent/docker" });
    expect(() => launcher.start(["run", "-i", "x"])).toThrow(RangeError);
    expect(() => launcher.start(["exec", "x"])).toThrow(RangeError);
  });
});

describe("a real child process behind the launcher", () => {
  it("speaks runner/2 over stdin and stdout, and a closed child ends the connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runner-pipe-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const out = join(dir, "seen.json");
    // A stand-in for `docker`: it checks its argv, plays the front (hello, then one invoke for a function nobody registered), records what the worker answers, and exits.
    const script = join(dir, "fake-docker.js");
    await writeFile(script, `#!/usr/bin/env node
const fs = require("fs");
const frame = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
const argv = process.argv.slice(2);
const seen = { argv, frames: [] };
process.stdout.write(frame({ type: "hello", proto: "runner/2", front: "fake", version: "1" }));
let buf = Buffer.alloc(0), sent = false;
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const n = buf.readUInt32BE(0); seen.frames.push(JSON.parse(buf.subarray(4, 4 + n).toString())); buf = buf.subarray(4 + n);
    if (!sent) { sent = true; process.stdout.write(frame({ type: "invoke", id: "i1", name: "ghost", version: "$LATEST", requestId: "r1", payload: "e30=", timeoutMs: 1000, source: "direct" })); }
    else { fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(seen)); process.exit(0); }
  }
});
`);
    await chmod(script, 0o755);
    const store = new FunctionCodeStore({ root: join(dir, "store") });
    const run = await store.openRun("run-1");
    cleanups.push(() => run.close());
    const controller = fakeController();
    const pipe = dockerExecPipeLauncher({ dockerBinary: script }).start(pipeArgs({ helperContainer: HELPER }));
    const client = createRunnerClient({ pipe, controller, code: run, settings, limits: { stopRetryMs: 5 } });
    const end = await client.ended;
    expect(end).toMatchObject({ reason: "pipe_closed", handshaken: true, stopped: true });
    const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; frames: Array<Record<string, unknown>> };
    expect(seen.argv).toEqual(["exec", "-i", HELPER, FRONT_BINARY, "runner-pipe"]);
    expect(seen.frames[0]).toMatchObject({ type: "hello", proto: "runner/2" });
    expect(seen.frames[1]).toMatchObject({ type: "result", id: "i1", status: "unavailable", reason: "not_registered" });
    expect(existsSync(out)).toBe(true);
  });
});

describe("the runner link", () => {
  interface Made { launcher: PipeLauncher; pipes: FakePipe[]; sessions: Array<{ controller: FakeController; closed: boolean }>; argvs: Array<readonly string[]> }
  function made(options: { helloAfterDial?: (index: number) => boolean } = {}): { made: Made; open: () => Promise<RunnerSession> } {
    const state: Made = { pipes: [], sessions: [], argvs: [], launcher: { start: (args) => { state.argvs.push(args); const pipe = new FakePipe(); state.pipes.push(pipe); if (options.helloAfterDial?.(state.pipes.length - 1) !== false) setTimeout(() => { pipe.send({ type: "hello", proto: "runner/2" }); }, 0); return pipe; } } };
    const open = async (): Promise<RunnerSession> => {
      const root = await mkdtemp(join(tmpdir(), "runner-link-"));
      const run = await new FunctionCodeStore({ root }).openRun(`run-${String(state.sessions.length)}`);
      const entry = { controller: fakeController(), closed: false };
      state.sessions.push(entry);
      return { controller: entry.controller, code: run, settings, close: async () => { entry.closed = true; await run.close(); await rm(root, { recursive: true, force: true }); } };
    };
    return { made: state, open };
  }

  it("dials the helper, and dials again with a fresh session when the pipe breaks mid-round", async () => {
    const { made: m, open } = made();
    const link = startRunnerLink({ helperContainer: HELPER, launcher: m.launcher, openSession: open, retryBaseMs: 5, limits: { stopRetryMs: 5, handshakeMs: 300 } });
    cleanups.push(() => link.close());
    while (link.state !== "connected") await wait(5);
    expect(m.argvs[0]).toEqual(["exec", "-i", HELPER, FRONT_BINARY, "runner-pipe"]);
    m.pipes[0]!.die();
    while (m.pipes.length < 2 || link.state !== "connected") await wait(5);
    expect(link.dials).toBe(2);
    // The first connection's sandboxes were stopped and its session closed before the second began; the second has its own controller.
    expect(m.sessions[0]).toMatchObject({ closed: true });
    expect(m.sessions[0]!.controller.stopAllCalls).toBe(1);
    expect(m.sessions[1]!.controller).not.toBe(m.sessions[0]!.controller);
    expect(m.sessions[1]!.controller.stopAllCalls).toBe(0);
    await link.close();
    expect(link.state).toBe("stopped");
    expect(m.sessions[1]).toMatchObject({ closed: true });
    expect(m.sessions[1]!.controller.stopAllCalls).toBe(1);
  });

  it("gives up after the dials that never got a hello", async () => {
    const { made: m, open } = made({ helloAfterDial: () => false });
    const link = startRunnerLink({ helperContainer: HELPER, launcher: m.launcher, openSession: open, retryBaseMs: 2, retryMaxMs: 4, maxFailedDials: 3, limits: { handshakeMs: 20, stopRetryMs: 5 } });
    cleanups.push(() => link.close());
    expect(await link.ended).toBe("failed");
    expect(link.dials).toBe(3);
    expect(m.sessions.every((session) => session.closed)).toBe(true);
  });

  it("counts a session that will not open as a failed dial, and stops cleanly when closed while connecting", async () => {
    let tries = 0;
    const link = startRunnerLink({ helperContainer: HELPER, launcher: { start: () => { throw new Error("no docker"); } }, openSession: () => { tries += 1; return Promise.reject(new Error("no scratch")); }, retryBaseMs: 2, maxFailedDials: 2 });
    expect(await link.ended).toBe("failed");
    expect(tries).toBe(2);
    const { made: m, open } = made({ helloAfterDial: () => false });
    const second = startRunnerLink({ helperContainer: HELPER, launcher: m.launcher, openSession: open, retryBaseMs: 50, limits: { handshakeMs: 5_000 } });
    await wait(20);
    await second.close();
    expect(second.state).toBe("stopped");
    expect(m.sessions[0]!.closed).toBe(true);
  });

  it("refuses to start for a container name that is not a helper's", () => {
    const { made: m, open } = made();
    expect(() => startRunnerLink({ helperContainer: "--privileged", launcher: m.launcher, openSession: open })).toThrow(PipeSpecError);
  });
});

describe("the helper's environment", () => {
  it("gives the socket in /tmp and a disk-backed store with the front's default cap", () => {
    expect(runnerHelperEnv({ store: { kind: "disk" } })).toEqual(["ROVARA_AWS_RUNNER_SOCKET=/tmp/rovara-runner/runner.sock", "ROVARA_AWS_RUNNER_STORE_DIR=/rovara-runner-store", "ROVARA_AWS_RUNNER_STORE_MAX_BYTES=268435456"]);
    expect(runnerStoreMount("/run/rovara/scratch/store-1")).toEqual(["-v", "/run/rovara/scratch/store-1:/rovara-runner-store:rw,nosuid,nodev,noexec"]);
  });

  it("caps a store that lives in the 64 MiB tmpfs at 32 MiB, and refuses a larger one", () => {
    expect(runnerHelperEnv({ store: { kind: "tmpfs" } })).toContain("ROVARA_AWS_RUNNER_STORE_MAX_BYTES=33554432");
    expect(runnerHelperEnv({ store: { kind: "tmpfs", maxBytes: 8 * 1024 * 1024 } })).toContain("ROVARA_AWS_RUNNER_STORE_DIR=/tmp/rovara-runner-store");
    expect(() => runnerHelperEnv({ store: { kind: "tmpfs", maxBytes: 64 * 1024 * 1024 } })).toThrow(RangeError);
    expect(() => runnerHelperEnv({ store: { kind: "disk", maxBytes: 10 } })).toThrow(RangeError);
  });

  it("builds the mount only from a plain absolute path", () => {
    for (const bad of ["relative", "/a:b", "/a,b", "/a/../b", "/a//b", "/a b", ""]) expect(() => runnerStoreMount(bad)).toThrow(RangeError);
  });
});
