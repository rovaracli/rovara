/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- parsed JSON is untyped */
// Review C1 (Opus): the synthesis kit runs on the administrator's computer BEFORE the approver sees anything, so it runs in an operating system sandbox with no network and no sockets, and is
// NOT run at all where there is none. The probe kit tries TCP, localhost HTTP, a Unix socket, the metadata address and DNS; the Linux path (bubblewrap) is checked by its arguments here and
// by the same probe test on the Linux CI job (T11 style), where `sandboxAvailable` is true.
import { link, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAtApproval } from "../../packages/cli/src/upgrade/bundle/build-at-approval.js";
import { NO_SANDBOX_MESSAGE, bwrapArguments, createNodeSynthRunner, macProfile, planSandbox, runKitProcess, type SandboxEnvironment, type SynthRunInput, type SynthRunner } from "../../packages/cli/src/upgrade/bundle/synth-run.js";
import type { BuiltBundle } from "../support/bundle-fixture.js";
import { EnterpriseWorld, SETTINGS_ENT } from "../support/enterprise-approval-world.js";
import { sandboxAvailable, testRunner, unsandboxedRunner } from "../support/kit-runner.js";

const made: BuiltBundle[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((bundle) => bundle.cleanup()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const build = async (world: EnterpriseWorld, runner: SynthRunner) => {
  const verified = await world.verify();
  try {
    return await buildAtApproval({ bundle: verified, settings: SETTINGS_ENT(), runner });
  } finally {
    await verified.cleanup();
  }
};
const INPUT: SynthRunInput = { entry: "/kit/synth.mjs", kitDir: "/kit", contextFile: "/work/context.json", outDir: "/out", workDir: "/work" };
const env = (overrides: Partial<SandboxEnvironment>): SandboxEnvironment => ({ platform: "linux", find: () => undefined, realHome: "/home/admin", nodeBinary: "/usr/local/bin/node", ...overrides });

describe("which sandbox, and none means no run", () => {
  it("macOS: sandbox-exec with a profile that denies all network (sockets included), writes outside the two directories, and the credential directories", () => {
    const plan = planSandbox(INPUT, env({ platform: "darwin", find: (name) => (name === "sandbox-exec" ? "/usr/bin/sandbox-exec" : undefined) }));
    expect(plan?.kind).toBe("sandbox-exec");
    const profile = plan!.args[1]!;
    expect(plan!.args[0]).toBe("-p");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/work") (subpath "/out")');
    for (const directory of [".aws", ".ssh", ".docker"]) expect(profile).toContain(`(deny file-read* (subpath "/home/admin/${directory}"))`);
    expect(() => macProfile({ workDir: '/w"x', outDir: "/o" }, undefined)).toThrow(/sandbox profile cannot carry/);
  });

  it("Linux: bubblewrap with every namespace unshared, an empty environment, and no socket directory or Docker socket mounted", () => {
    const plan = planSandbox(INPUT, env({ find: (name) => (name === "bwrap" ? "/usr/bin/bwrap" : undefined) }));
    expect(plan?.kind).toBe("bwrap");
    const args = bwrapArguments(INPUT, "/opt/node/bin/node", { HOME: "/work" });
    expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--clearenv", "--die-with-parent", "--new-session"]));
    expect(args).not.toContain("--share-net");
    const mounted = args.flatMap((arg, index) => (["--bind", "--ro-bind", "--ro-bind-try"].includes(arg) ? [args[index + 1]!] : []));
    expect(mounted.sort()).toEqual(["/bin", "/kit", "/lib", "/lib64", "/opt/node/bin", "/out", "/sbin", "/usr", "/work"]);
    for (const path of mounted) expect(path).not.toMatch(/^\/(var|run)/);
    expect(args).toEqual(expect.arrayContaining(["--setenv", "HOME", "/work"]));
  });

  it("finds no sandbox on other systems, or on Linux without bubblewrap, and then the kit is not started", async () => {
    expect(planSandbox(INPUT, env({ platform: "win32" }))).toBeUndefined();
    expect(planSandbox(INPUT, env({ platform: "freebsd" }))).toBeUndefined();
    expect(planSandbox(INPUT, env({ platform: "linux", find: () => undefined }))).toBeUndefined();
    const world = await EnterpriseWorld.create(made, { kit: { recordInputs: true } });
    const runner = createNodeSynthRunner(env({ platform: "linux", find: () => undefined }));
    expect(runner.sandbox).toBe("none");
    await expect(build(world, runner)).rejects.toThrow(NO_SANDBOX_MESSAGE);
  });
});

describe("a probe kit cannot reach anything", () => {
  const servers: Server[] = [];
  const reachable = async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const hits = { tcp: 0, unix: 0 };
    const sockets: Array<{ destroy(): void }> = [];
    const tcp = createServer((socket) => { hits.tcp += 1; sockets.push(socket); socket.destroy(); });
    const unix = createServer((socket) => { hits.unix += 1; sockets.push(socket); socket.destroy(); });
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const socketPath = join(dir, "docker.sock");
    await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
    servers.push(tcp, unix);
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([tcp, unix].map((server) => new Promise((resolve) => server.close(resolve)))); });
    return { hits, tcpPort: (tcp.address() as { port: number }).port, socketPath };
  };
  const probed = async (runner: SynthRunner) => {
    const target = await reachable();
    const world = await EnterpriseWorld.create(made, { kit: { probe: { tcpPort: target.tcpPort, unixSocket: target.socketPath } } });
    const built = await build(world, runner);
    const foundation = JSON.parse(built.files.find((f) => f.file === "built/templates/foundation.template.json")!.body.toString("utf8"));
    return { probe: foundation.Metadata.Probe as Record<string, string>, hits: target.hits };
  };

  it("positive control: without a sandbox the same probe connects (so the probe really measures something)", async () => {
    const { probe, hits } = await probed(unsandboxedRunner);
    expect(probe).toMatchObject({ tcp: "connected", unix: "connected" });
    // (The HTTP request is counted by the server too: it connected, though the server hung up on it.)
    expect(hits.tcp).toBeGreaterThanOrEqual(2);
    expect(hits.unix).toBe(1);
  });

  it.runIf(sandboxAvailable)("in the sandbox every attempt fails: TCP, localhost HTTP, a Unix socket, the metadata address, DNS; the servers see nothing", async () => {
    const { probe, hits } = await probed(testRunner);
    expect(probe).toEqual({ tcp: "blocked", unix: "blocked", imds: "blocked", fetch: "blocked", dns: "blocked" });
    expect(hits).toEqual({ tcp: 0, unix: 0 });
  });
});

describe("limits on a runaway kit and on what it leaves behind (review M1)", () => {
  it("stops a kit that prints more than 64 KiB, and one that never ends", async () => {
    await expect(build(await EnterpriseWorld.create(made, { kit: { printBytes: 70_000 } }), unsandboxedRunner)).rejects.toThrow(/printed too much/);
    const hang: SynthRunner = { confined: false, sandbox: "none (test only)", run: (input) => runKitProcess(input, undefined, { timeMs: 1_500 }) };
    await expect(build(await EnterpriseWorld.create(made, { kit: { hang: true } }), hang)).rejects.toThrow(/ran too long/);
  });

  const tampering = (how: "hard" | "symbolic"): SynthRunner => ({
    confined: false, sandbox: "none (test only)",
    async run(input) {
      await runKitProcess(input, undefined);
      const runtime = join(input.outDir, "templates", "runtime.template.json");
      const slack = join(input.outDir, "templates", "slack.template.json");
      await rm(runtime);
      if (how === "hard") await link(slack, runtime); else await symlink(slack, runtime);
    },
  });
  it("refuses an output file with another name on the disk (a hard link) and a link", async () => {
    await expect(build(await EnterpriseWorld.create(made), tampering("hard"))).rejects.toThrow(/not a plain file/);
    await expect(build(await EnterpriseWorld.create(made), tampering("symbolic"))).rejects.toThrow(/link or a special file/);
  });
});

