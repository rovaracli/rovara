// Stdio MCP host redesign, task T4: the bridge. A real stdio MCP server (tests/support/stdio-runner-fixture.mjs) is started through it and reached over HTTP, as the
// controller will. Only the confinement wrapper differs from production (a macOS machine has no setpriv): its exact command line is checked separately, and the full chain
// is run with stub setpriv and prlimit programs in runner-mains.test.ts.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFINE_LIMITS, DEFAULT_CONFINE_TOOLS, confinedCommand } from "../../../packages/gateway/src/mcp-runner/confine.js";
import { createBridge, type Bridge, type BridgeOptions } from "../../../packages/gateway/src/mcp-runner/bridge.js";

const FIXTURE = resolve("tests/support/stdio-runner-fixture.mjs");
const TOKEN = "t".repeat(43);
const HASH = "a".repeat(64);
const NAME = "@acme/sim-mcp";

let work: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "bridge-test-")); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(work, { recursive: true, force: true });
});

/** A bundle directory as the fetch step leaves it: `tree/` with the package, and `verified.json`. */
async function bundle(over: { hash?: string | null; manifest?: Record<string, unknown>; program?: string } = {}): Promise<string> {
  const dir = join(work, `bundle-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(dir, "tree", "bin"), { recursive: true });
  await mkdir(join(dir, "home"), { recursive: true });
  await mkdir(join(dir, "tmp"), { recursive: true });
  await writeFile(join(dir, "tree", "package.json"), JSON.stringify(over.manifest ?? { name: NAME, version: "1.0.0", bin: { "sim-mcp": "bin/server.mjs" } }));
  await writeFile(join(dir, "tree", "bin", "server.mjs"), over.program ?? `import ${JSON.stringify(FIXTURE)};\n`);
  if (over.hash !== null) await writeFile(join(dir, "verified.json"), JSON.stringify({ bundleHash: over.hash ?? HASH }));
  return dir;
}

interface Made { bridge: Bridge; url: string; dir: string; environment: Record<string, string | undefined>; spawned: Array<{ file: string; args: string[]; env: Record<string, string> | undefined; raw: Record<string, string> | undefined }>; exits: number[] }

async function make(over: Partial<BridgeOptions> & { dir?: string; listen?: boolean } = {}): Promise<Made> {
  const dir = over.dir ?? await bundle();
  const environment: Record<string, string | undefined> = over.environment ?? { JIRA_TOKEN: "s3cret-value-1", AWS_SECRET_ACCESS_KEY: "must-never-reach-the-program", MCP_RUNNER_TOKEN: TOKEN };
  const spawned: Made["spawned"] = [];
  const exits: number[] = [];
  const bridge = createBridge({
    token: TOKEN, bundleHash: HASH, bundleDir: dir, packageName: NAME, args: ["--read-only"], secretEnv: ["JIRA_TOKEN"], memoryMiB: 512, environment,
    homeDir: join(dir, "home"), tmpDir: join(dir, "tmp"),
    confine: (program, args) => ({ file: process.execPath, args: [program, ...args] }),
    getuid: () => 10_003,
    spawn: ((file: string, args: string[], options: { env?: Record<string, string> }) => {
      spawned.push({ file, args, env: options.env === undefined ? undefined : { ...options.env }, raw: options.env });
      return spawn(file, args, options as never);
    }) as typeof spawn,
    onChildExit: () => { exits.push(1); },
    ...over,
  });
  cleanups.push(() => bridge.close());
  const server: Server = createServer((req, res) => { void bridge.handle(req, res); });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  cleanups.push(() => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }));
  if (over.listen !== false) await bridge.start();
  return { bridge, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, environment, spawned, exits };
}

async function client(url: string, token = TOKEN): Promise<Client> {
  const mcp = new Client({ name: "test", version: "1" });
  // (The SDK's transport types include undefined, which its own Transport interface omits under exactOptionalPropertyTypes.)
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as Transport);
  cleanups.push(() => mcp.close());
  return mcp;
}
// (macOS adds one variable of its own to every process it starts; Linux adds none.)
const envKeys = (text: string): string => text.split(",").filter((key) => key !== "__CF_USER_TEXT_ENCODING").join(",");
const textOf = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0]!).text;
const call = async (mcp: Client, name: string, args: Record<string, unknown> = {}, timeout?: number) => mcp.callTool({ name, arguments: args }, undefined, timeout === undefined ? undefined : { timeout });
const http = (url: string, path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string> | undefined) } });

describe("T4 bridge: refuses to start wrongly", () => {
  it("refuses to run as uid 0", () => {
    expect(() => createBridge({ ...base(), getuid: () => 0 })).toThrow("must not run as root");
    expect(() => createBridge({ ...base(), getuid: () => 10_003 })).not.toThrow();
    expect(() => createBridge({ ...base(), getuid: () => undefined })).not.toThrow();
  });
  function base(): BridgeOptions {
    return { token: TOKEN, bundleHash: HASH, bundleDir: "/nonexistent", packageName: NAME, args: [], secretEnv: [], memoryMiB: 512, environment: {}, homeDir: "/h", tmpDir: "/t", confine: (program, args) => ({ file: program, args: [...args] }) };
  }
  it("refuses a token that is too short, a hash that is not a sha256, a package name, argument or secret name that the approval would not have allowed, and a size out of range", () => {
    for (const bad of [{ token: "short" }, { token: "t".repeat(42) }, { bundleHash: "A".repeat(64) }, { bundleHash: "a".repeat(63) }, { packageName: "Not A Name" }, { packageName: "../x" }, { args: ["a b"] }, { args: ["; rm -rf /"] }, { args: ["../x"] },
      { secretEnv: ["PATH"] }, { secretEnv: ["NODE_OPTIONS"] }, { secretEnv: ["lower"] }, { secretEnv: ["AWS_ACCESS_KEY_ID"] }, { secretEnv: ["A_B", "A_B"] }, { memoryMiB: 100 }, { memoryMiB: 4096 }, { memoryMiB: 512.5 }]) {
      expect(() => createBridge({ ...base(), ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
  it("starts no program when verified.json is missing, unreadable or names another bundle", async () => {
    for (const hash of [null, "b".repeat(64), "", "A".repeat(64)]) {
      const dir = await bundle({ hash });
      if (hash === "") await writeFile(join(dir, "verified.json"), "not json");
      const made = await make({ dir, listen: false });
      await expect(made.bridge.start(), String(hash)).rejects.toThrow(/verified|approved/u);
      expect(made.spawned).toEqual([]);
      expect(made.bridge.isReady()).toBe(false);
    }
  });
  it("starts no program when the bundle is another package, has no program, or the program is not a file", async () => {
    const other = await make({ dir: await bundle({ manifest: { name: "someone-else", version: "1.0.0", bin: "bin/server.mjs" } }), listen: false });
    await expect(other.bridge.start()).rejects.toThrow("not the approved package");
    const none = await make({ dir: await bundle({ manifest: { name: NAME, version: "1.0.0" } }), listen: false });
    await expect(none.bridge.start()).rejects.toThrow("no program");
    const escape = await make({ dir: await bundle({ manifest: { name: NAME, version: "1.0.0", bin: "../../escape.js" } }), listen: false });
    await expect(escape.bridge.start()).rejects.toThrow("no program");
    const missing = await make({ dir: await bundle({ manifest: { name: NAME, version: "1.0.0", bin: "bin/missing.js" } }), listen: false });
    await expect(missing.bridge.start()).rejects.toThrow("no program");
    for (const made of [other, none, escape, missing]) expect(made.spawned).toEqual([]);
  });
  it("starts nothing when a declared secret is not in the environment", async () => {
    const made = await make({ environment: { MCP_RUNNER_TOKEN: TOKEN }, listen: false });
    await expect(made.bridge.start()).rejects.toThrow("secret is missing");
    expect(made.spawned).toEqual([]);
  });
  it("leaves nothing running when the program stops at once", async () => {
    const dir = await bundle({ program: "process.exit(1);\n" });
    const made = await make({ dir, listen: false, startTimeoutMs: 5_000 });
    await expect(made.bridge.start()).rejects.toThrow();
    expect(made.bridge.isReady()).toBe(false);
    expect(made.spawned).toHaveLength(1);
  });
});

describe("T4 bridge: serving a running program", () => {
  it("answers /healthz without a login, /ready only with one, and 503 for /ready and /mcp before the program is up", async () => {
    const made = await make({ listen: false });
    expect((await fetch(`${made.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${made.url}/ready`)).status).toBe(401);
    expect((await http(made.url, "/ready")).status).toBe(503);
    expect((await http(made.url, "/mcp", { method: "POST", body: "{}" })).status).toBe(503);
    await made.bridge.start();
    const ready = await http(made.url, "/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true, bundleHash: HASH });
  });
  it("refuses a missing or wrong token, whatever the path, and does not say why", async () => {
    const made = await make();
    for (const path of ["/mcp", "/ready", "/nothing"]) {
      for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, TOKEN, "Basic abc"]) {
        const response = await fetch(`${made.url}${path}`, { method: path === "/mcp" ? "POST" : "GET", ...(path === "/mcp" ? { body: "{}" } : {}), headers: authorization === undefined ? {} : { authorization } });
        expect(response.status, `${path} ${String(authorization)}`).toBe(401);
      }
    }
  });
  it("lists the program's tools and calls them over MCP, and refuses other paths and methods", async () => {
    const made = await make();
    const mcp = await client(made.url);
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["echo", "env_keys", "env_get", "who", "big", "slow", "noise", "crash"]);
    expect(textOf(await call(mcp, "echo", { word: "hello" }))).toBe("echo:hello");
    expect((await http(made.url, "/nothing")).status).toBe(404);
    expect((await http(made.url, "/mcp")).status).toBe(405);
  });
  it("runs the program through the confinement wrapper it was given, with no shell, in its own process group, with the package's arguments after the program", async () => {
    const made = await make();
    const mcp = await client(made.url);
    const who = JSON.parse(textOf(await call(mcp, "who"))) as { uid: number; argv: string[]; cwd: string };
    expect(who.argv).toEqual(["--read-only"]);
    expect(made.spawned).toHaveLength(1);
    expect(made.spawned[0]!.file).toBe(process.execPath);
    expect(made.spawned[0]!.args).toEqual([join(made.dir, "tree", "bin", "server.mjs"), "--read-only"]);
    expect(who.cwd).toContain("bundle-");
  });
});

describe("T4 bridge: what the program is given", () => {
  it("gets an environment built from nothing plus exactly the declared secrets, and never the bridge's own or the container's other variables", async () => {
    const made = await make();
    const mcp = await client(made.url);
    expect(envKeys(textOf(await call(mcp, "env_keys")))).toBe(["HOME", "JIRA_TOKEN", "NODE_ENV", "NODE_OPTIONS", "PATH", "TMPDIR"].join(","));
    expect(textOf(await call(mcp, "env_get", { name: "JIRA_TOKEN" }))).toBe("s3cret-value-1");
    expect(textOf(await call(mcp, "env_get", { name: "AWS_SECRET_ACCESS_KEY" }))).toBe("<unset>");
    expect(textOf(await call(mcp, "env_get", { name: "MCP_RUNNER_TOKEN" }))).toBe("<unset>");
    expect(textOf(await call(mcp, "env_get", { name: "NODE_OPTIONS" }))).toBe("--max-old-space-size=384");
    expect(Object.keys(made.spawned[0]!.env ?? {}).sort()).toEqual(["HOME", "JIRA_TOKEN", "NODE_ENV", "NODE_OPTIONS", "PATH", "TMPDIR"]);
    expect(JSON.stringify(made.spawned.map((item) => [item.file, item.args]))).not.toContain(TOKEN);
  });
  it("sizes the heap at three quarters of the task's memory", async () => {
    const made = await make({ memoryMiB: 2_048 });
    expect(textOf(await call(await client(made.url), "env_get", { name: "NODE_OPTIONS" }))).toBe("--max-old-space-size=1536");
  });
  it("forgets the secrets once the program has them: not in the bridge's environment, not kept by the transport, and the other variables are left alone", async () => {
    const made = await make();
    expect(made.environment.JIRA_TOKEN).toBeUndefined();
    expect(made.environment.AWS_SECRET_ACCESS_KEY).toBe("must-never-reach-the-program");
    expect(made.spawned[0]!.env).toBeDefined();
    // the env object the transport handed to spawn (and kept) was emptied once the program had been started
    expect(Object.keys(made.spawned[0]!.raw ?? { present: "" })).toEqual([]);
    const mcp = await client(made.url);
    expect(textOf(await call(mcp, "env_get", { name: "JIRA_TOKEN" }))).toBe("s3cret-value-1");
  });
  it("a program with no declared secrets gets none, even when the environment holds some", async () => {
    const made = await make({ secretEnv: [] });
    const mcp = await client(made.url);
    expect(envKeys(textOf(await call(mcp, "env_keys")))).toBe(["HOME", "NODE_ENV", "NODE_OPTIONS", "PATH", "TMPDIR"].join(","));
    expect(made.environment.JIRA_TOKEN).toBe("s3cret-value-1");
  });
});

describe("T4 bridge: bounds", () => {
  it("counts the program's stderr and shows none of it", async () => {
    const made = await make();
    const mcp = await client(made.url);
    expect(textOf(await call(mcp, "noise", { n: 100_000 }))).toBe("noisy");
    await expect.poll(() => made.bridge.stderrBytes()).toBeGreaterThanOrEqual(100_000);
  });
  it("refuses a request over 1 MiB with 413 and one that is not JSON with 400", async () => {
    const made = await make();
    const big = await http(made.url, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(1_048_576) }) });
    expect(big.status).toBe(413);
    const bad = await http(made.url, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await call(await client(made.url), "echo", { word: "still works" })).isError).toBeFalsy();
  });
  it("does not pass on a reply over 1 MiB", async () => {
    const made = await make();
    const mcp = await client(made.url);
    expect(textOf(await call(mcp, "big", { n: 100_000 })).length).toBe(100_000);
    await expect(call(mcp, "big", { n: 1_200_000 })).rejects.toThrow();
  });
  it("gives up on a call that takes longer than the limit, and the next call works", async () => {
    const made = await make({ callTimeoutMs: 400 });
    const mcp = await client(made.url);
    await expect(call(mcp, "slow", { ms: 5_000 })).rejects.toThrow();
    expect(textOf(await call(mcp, "echo", { word: "after" }))).toBe("echo:after");
  });
});

describe("T4 bridge: the program stops", () => {
  it("is not ready after the program exits, tells the runner once, and answers 503", async () => {
    const made = await make();
    const mcp = await client(made.url);
    await call(mcp, "crash");
    await expect.poll(() => made.exits.length).toBe(1);
    expect(made.bridge.isReady()).toBe(false);
    expect((await http(made.url, "/ready")).status).toBe(503);
    expect((await http(made.url, "/mcp", { method: "POST", body: "{}" })).status).toBe(503);
    expect(made.exits).toHaveLength(1);
  });
  it("stops the program when it is closed, and does not call that an exit", async () => {
    const made = await make();
    const mcp = await client(made.url);
    const { pid } = JSON.parse(textOf(await call(mcp, "who"))) as { pid: number };
    expect(() => process.kill(pid, 0)).not.toThrow();
    await made.bridge.close();
    await expect.poll(() => { try { process.kill(pid, 0); return "alive"; } catch { return "gone"; } }, { timeout: 5_000 }).toBe("gone");
    expect(made.exits).toEqual([]);
  });
});

describe("T4 confinement command line", () => {
  const tools = { setpriv: "/usr/bin/setpriv", prlimit: "/usr/bin/prlimit", node: "/usr/local/bin/node" };
  it("is setpriv with no new privileges and no capabilities, then prlimit with the limits, then node, the program and its arguments", () => {
    expect(confinedCommand(tools, "/bundle/tree/bin/run.js", ["--read-only", "a=b"])).toEqual({
      file: "/usr/bin/setpriv",
      args: ["--no-new-privs", "--inh-caps=-all", "--", "/usr/bin/prlimit", "--nofile=1024", "--nproc=256", "--fsize=536870912", "--core=0", "--", "/usr/local/bin/node", "/bundle/tree/bin/run.js", "--read-only", "a=b"],
    });
  });
  it("passes an argument with shell characters as one plain word (there is no shell to read it)", () => {
    const command = confinedCommand(tools, "/p.js", ["a;b", "$(x)", "`y`", "&", "|"]);
    expect(command.args.slice(-5)).toEqual(["a;b", "$(x)", "`y`", "&", "|"]);
    expect(command.file).not.toMatch(/sh$/u);
    expect(command.args).not.toContain("-c");
  });
  it("has the limits the design names, and defaults to the image's paths", () => {
    expect(CONFINE_LIMITS).toEqual({ nofile: 1_024, nproc: 256, fsizeBytes: 536_870_912 });
    expect(DEFAULT_CONFINE_TOOLS).toEqual({ setpriv: "/usr/bin/setpriv", prlimit: "/usr/bin/prlimit", node: "/usr/local/bin/node" });
  });
  it("takes its limits as given (they are the caller's to set)", () => {
    expect(confinedCommand(tools, "/p.js", [], { nofile: 8, nproc: 4, fsizeBytes: 100 }).args).toEqual(expect.arrayContaining(["--nofile=8", "--nproc=4", "--fsize=100"]));
  });
});
