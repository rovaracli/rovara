// Stdio MCP host redesign, task T4: the two programs a runner task runs (fetch-main, serve-main): their settings, their refusals, and the whole chain with stub setpriv and
// prlimit programs, so the real command line is run (a macOS machine has neither).
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeBundle } from "../../../packages/gateway/src/mcp-runner/bundle.js";
import { main as fetchMain, readFetchConfig } from "../../../packages/broker/src/mcp-runner/fetch-main.js";
import { readServeConfig, start as startServe, startFailureFields } from "../../../packages/broker/src/mcp-runner/serve-main.js";
import { main as installMain, rootRefusalLine } from "../../../packages/broker/src/mcp-runner/install-main.js";
import { RootRefusedError } from "../../../packages/gateway/src/mcp-runner/identity.js";
import { createBridge } from "../../../packages/gateway/src/mcp-runner/bridge.js";

const TOKEN = "t".repeat(43);
const FIXTURE = resolve("tests/support/stdio-runner-fixture.mjs");
let work: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "mains-test-")); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(work, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

const serveEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  MCP_RUNNER_TOKEN: TOKEN, MCP_BUNDLE_HASH: "a".repeat(64), MCP_PACKAGE_NAME: "@acme/sim-mcp", MCP_SERVER_ARGS: '["--read-only"]', MCP_SECRET_ENV: '["JIRA_TOKEN"]', MCP_MEMORY_MIB: "512", PORT: "8080", ...over,
});

describe("T4 serve-main: settings", () => {
  it("takes the confinement programs from the image only: the environment cannot replace setpriv, prlimit or node", () => {
    const config = readServeConfig(serveEnv({ MCP_SETPRIV: "/tmp/evil", MCP_PRLIMIT: "/tmp/evil", MCP_NODE: "/tmp/evil" }));
    expect(config.tools).toEqual({ setpriv: "/usr/bin/setpriv", prlimit: "/usr/bin/prlimit", node: "/usr/local/bin/node" });
  });
  it("reads the task's settings, with the defaults for the image's paths", () => {
    expect(readServeConfig(serveEnv())).toEqual({
      token: TOKEN, bundleHash: "a".repeat(64), packageName: "@acme/sim-mcp", args: ["--read-only"], secretEnv: ["JIRA_TOKEN"], memoryMiB: 512, port: 8080,
      bundleDir: "/bundle", homeDir: "/home/server", tmpDir: "/tmp", tools: { setpriv: "/usr/bin/setpriv", prlimit: "/usr/bin/prlimit", node: "/usr/local/bin/node" },
    });
    expect(readServeConfig(serveEnv({ MCP_SERVER_ARGS: undefined, MCP_SECRET_ENV: undefined }))).toMatchObject({ args: [], secretEnv: [] });
  });
  it("refuses a setting that is missing or not valid", () => {
    const bad: Array<Record<string, string | undefined>> = [
      { MCP_RUNNER_TOKEN: undefined }, { MCP_RUNNER_TOKEN: "short" }, { MCP_RUNNER_TOKEN: "t".repeat(42) }, { MCP_BUNDLE_HASH: undefined }, { MCP_BUNDLE_HASH: "A".repeat(64) }, { MCP_BUNDLE_HASH: "a".repeat(63) },
      { MCP_PACKAGE_NAME: undefined }, { MCP_PACKAGE_NAME: "Bad Name" }, { MCP_SERVER_ARGS: "not json" }, { MCP_SERVER_ARGS: '["a b"]' }, { MCP_SERVER_ARGS: '"x"' }, { MCP_SERVER_ARGS: '["a","b","c","d","e","f","g","h","i"]' },
      { MCP_SECRET_ENV: "not json" }, { MCP_SECRET_ENV: '["PATH"]' }, { MCP_SECRET_ENV: '["NODE_OPTIONS"]' }, { MCP_SECRET_ENV: '["lower"]' }, { MCP_SECRET_ENV: '["AWS_SECRET_ACCESS_KEY"]' },
      { MCP_MEMORY_MIB: undefined }, { MCP_MEMORY_MIB: "100" }, { MCP_MEMORY_MIB: "4096" }, { MCP_MEMORY_MIB: "abc" }, { PORT: "0" }, { PORT: "70000" }, { PORT: "x" },
    ];
    for (const over of bad) expect(() => readServeConfig(serveEnv(over)), JSON.stringify(over)).toThrow();
  });
});

describe("T4 serve-main: starting", () => {
  it("refuses to run as uid 0 before it listens or reads the bundle, and removes the token from the environment first", async () => {
    const port = await freePort();
    const env = serveEnv({ PORT: String(port), MCP_BUNDLE_DIR: join(work, "nowhere") });
    await expect(startServe({ env, getuid: () => 0 })).rejects.toThrow("must not run as root");
    await expect(startServe({ env: serveEnv({ PORT: String(port), MCP_BUNDLE_DIR: join(work, "nowhere") }), getuid: () => 10_003, getgid: () => 0 })).rejects.toThrow("must not run as root");
    expect(env.MCP_RUNNER_TOKEN).toBeUndefined();
    // nothing listens on the port
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
  it("starts nothing, and listens on nothing afterwards, when the volume holds no verified bundle", async () => {
    const port = await freePort();
    const dir = join(work, "volume");
    await mkdir(dir);
    await expect(startServe({ env: serveEnv({ PORT: String(port), MCP_BUNDLE_DIR: dir }), getuid: () => 10_003 })).rejects.toThrow("verified");
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("runs the program through setpriv, then prlimit, then node, with the real command line, and serves it", async () => {
    const dir = join(work, "volume");
    await mkdir(join(dir, "tree", "bin"), { recursive: true });
    await mkdir(join(dir, "home"));
    await mkdir(join(dir, "tmp"));
    await writeFile(join(dir, "tree", "package.json"), JSON.stringify({ name: "@acme/sim-mcp", version: "1.0.0", bin: "bin/server.mjs" }));
    await writeFile(join(dir, "tree", "bin", "server.mjs"), `import ${JSON.stringify(FIXTURE)};\n`);
    await writeFile(join(dir, "verified.json"), JSON.stringify({ bundleHash: "a".repeat(64) }));
    const log = join(work, "calls.log");
    // Stubs that record their command line, drop their own options up to `--`, and run the rest.
    const stub = (name: string): string => `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(log)}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`;
    const setpriv = join(work, "setpriv");
    const prlimit = join(work, "prlimit");
    await writeFile(setpriv, stub("setpriv"));
    await writeFile(prlimit, stub("prlimit"));
    await chmod(setpriv, 0o755);
    await chmod(prlimit, 0o755);
    const port = await freePort();
    const exits: number[] = [];
    const env = serveEnv({ PORT: String(port), MCP_BUNDLE_DIR: dir, MCP_HOME_DIR: join(dir, "home"), MCP_TMP_DIR: join(dir, "tmp"), JIRA_TOKEN: "s3cret", AWS_SECRET_ACCESS_KEY: "nope" });
    // (The tools are a test seam of start(); the environment is not one.)
    const { bridge, server } = await startServe({ env, getuid: () => 10_003, getgid: () => 10_003, tools: { setpriv, prlimit, node: process.execPath }, onChildExit: () => { exits.push(1); } });
    cleanups.push(async () => { await bridge.close(); await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); });

    const mcp = new Client({ name: "t", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as Transport);
    cleanups.push(() => mcp.close());
    const get = async (name: string) => ((await mcp.callTool({ name: "env_get", arguments: { name } })) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(await get("JIRA_TOKEN")).toBe("s3cret");
    expect(await get("AWS_SECRET_ACCESS_KEY")).toBe("<unset>");
    expect(await get("MCP_RUNNER_TOKEN")).toBe("<unset>");

    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines).toEqual([
      `setpriv --no-new-privs --inh-caps=-all -- ${prlimit} --nofile=1024 --nproc=256 --fsize=536870912 --core=0 -- ${process.execPath} ${join(dir, "tree", "bin", "server.mjs")} --read-only`,
      `prlimit --nofile=1024 --nproc=256 --fsize=536870912 --core=0 -- ${process.execPath} ${join(dir, "tree", "bin", "server.mjs")} --read-only`,
    ]);
    // the token is gone from the environment, and so are the secret values
    expect(env.MCP_RUNNER_TOKEN).toBeUndefined();
    expect(env.JIRA_TOKEN).toBeUndefined();
    expect(exits).toEqual([]);
  });
});

describe("T4 fetch-main", () => {
  let bundleBytes: Buffer;
  let bundleHash: string;
  const controller = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}` || req.url !== `/bundles/${bundleHash}`) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-length": bundleBytes.length });
    res.end(bundleBytes);
  });
  let url = "";
  beforeAll(async () => { await new Promise<void>((done) => controller.listen(0, "127.0.0.1", done)); url = `http://127.0.0.1:${(controller.address() as AddressInfo).port}/`; });
  afterAll(() => { controller.close(); controller.closeAllConnections(); });
  beforeEach(async () => {
    const tree = join(work, "src");
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, "package.json"), "{}");
    const file = join(work, "b.tar");
    bundleHash = (await writeBundle(tree, file)).bundleHash;
    bundleBytes = await readFile(file);
  });

  const env = (over: Record<string, string | undefined> = {}) => ({ MCP_CONTROLLER_URL: url, MCP_RUNNER_TOKEN: TOKEN, MCP_BUNDLE_HASH: bundleHash, MCP_BUNDLE_DIR: join(work, "volume"), ...over });

  it("reads its settings and refuses what is missing or not valid", () => {
    expect(readFetchConfig(env())).toMatchObject({ controllerUrl: url, token: TOKEN, bundleHash, destination: join(work, "volume") });
    for (const over of [{ MCP_CONTROLLER_URL: undefined }, { MCP_CONTROLLER_URL: "" }, { MCP_RUNNER_TOKEN: undefined }, { MCP_RUNNER_TOKEN: "short" }, { MCP_RUNNER_TOKEN: "t".repeat(42) }, { MCP_BUNDLE_HASH: undefined }, { MCP_BUNDLE_HASH: "x" }]) {
      expect(() => readFetchConfig(env(over)), JSON.stringify(over)).toThrow();
    }
  });
  it("fetches and unpacks the bundle, prints one line with no token in it, and exits 0", async () => {
    await mkdir(join(work, "volume"));
    const lines: string[] = [];
    const environment = env();
    expect(await fetchMain({ env: environment, getuid: () => 10_002, write: (line) => lines.push(line) })).toBe(0);
    expect(lines).toEqual([JSON.stringify({ component: "mcp-fetch", ok: true })]);
    expect((await readdir(join(work, "volume"))).sort()).toEqual(["tree", "verified.json"]);
    expect(environment.MCP_RUNNER_TOKEN).toBeUndefined();
  });
  it("exits 1 with a fixed code when the bundle is wrong or the settings are bad, leaving the volume empty", async () => {
    await mkdir(join(work, "volume"));
    const lines: string[] = [];
    expect(await fetchMain({ env: env({ MCP_BUNDLE_HASH: "b".repeat(64) }), getuid: () => 10_002, write: (line) => lines.push(line) })).toBe(1);
    expect(await fetchMain({ env: env({ MCP_BUNDLE_HASH: "x" }), getuid: () => 10_002, write: (line) => lines.push(line) })).toBe(1);
    expect(await fetchMain({ env: env(), getuid: () => 0, write: (line) => lines.push(line) })).toBe(1);
    expect(await fetchMain({ env: env(), getuid: () => 10_002, getgid: () => 0, write: (line) => lines.push(line) })).toBe(1);
    expect(lines.map((line) => (JSON.parse(line) as { code: string }).code)).toEqual(["refused", "bad_request", "root", "root"]);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(await readdir(join(work, "volume"))).toEqual([]);
  });
});

describe("fix round 1, S6: a root refusal says it is one (the Linux job reads the code)", () => {
  it("is a RootRefusedError with the code `root` and the same message as before, from the bridge and the install program", async () => {
    const error = new RootRefusedError("the bridge");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "root", message: "the bridge must not run as root", name: "RootRefusedError" });
    // (the install program reads the class from the built package, a second copy of the module in this test, so it is recognised by its name and code)
    await expect(installMain({ env: {}, getuid: () => 0, write: () => undefined })).rejects.toMatchObject({ name: "RootRefusedError", code: "root", message: "the install task must not run as root" });
    await expect(installMain({ env: {}, getuid: () => 10_002, getgid: () => 0, write: () => undefined })).rejects.toMatchObject({ code: "root" });
    expect(() => createBridge({ token: "t".repeat(43), bundleHash: "a".repeat(64), bundleDir: "/x", packageName: "p", args: [], secretEnv: [], memoryMiB: 512, environment: {}, homeDir: "/h", tmpDir: "/t", confine: (f, a) => ({ file: f, args: [...a] }), getuid: () => 0, getgid: () => 0 })).toThrow(RootRefusedError);
    expect(() => createBridge({ token: "t".repeat(43), bundleHash: "a".repeat(64), bundleDir: "/x", packageName: "p", args: [], secretEnv: [], memoryMiB: 512, environment: {}, homeDir: "/h", tmpDir: "/t", confine: (f, a) => ({ file: f, args: [...a] }), getuid: () => 10_003, getgid: () => 0 })).toThrow(expect.objectContaining({ code: "root" }));
  });
  it("puts the code on the last line of the serve program and the install program only for a root refusal, never for another failure", async () => {
    const refusal = await installMain({ env: {}, getuid: () => 0, write: () => undefined }).catch((error: unknown) => error);
    expect(startFailureFields(refusal)).toEqual({ code: "root" });
    for (const other of [new Error("the bridge must not run as root"), new Error("anything"), "text", undefined, null]) expect(startFailureFields(other)).toEqual({});
    expect(JSON.parse(rootRefusalLine(refusal)!)).toEqual({ component: "mcp-install", ok: false, code: "root" });
    for (const other of [new Error("the install task must not run as root"), new Error("x"), "root", undefined]) expect(rootRefusalLine(other)).toBeUndefined();
  });
  it("keeps the programs' last-line handlers on those helpers (the Linux job reads what they print)", async () => {
    const serve = await readFile("packages/broker/src/mcp-runner/serve-main.ts", "utf8");
    expect(serve).toContain('log("bridge.start_failed", startFailureFields(error))');
    const install = await readFile("packages/broker/src/mcp-runner/install-main.ts", "utf8");
    expect(install).toContain("const line = rootRefusalLine(error);");
    expect(install).toContain("if (line !== undefined) process.stdout.write(");
    const controller = await readFile("packages/broker/src/mcp-host/main.ts", "utf8");
    expect(controller).toContain("error instanceof RootRefusedError ? { code: error.code } : {}");
    const job = await readFile("tests/linux/mcp-runner/mcp-runner-linux.test.ts", "utf8");
    for (const wanted of ["serve.stdout).toContain('\"code\":\"root\"'", "installed.stdout).toContain('{\"component\":\"mcp-install\",\"ok\":false,\"code\":\"root\"}')", "serveControl.stdout).not.toContain", "installControl.stdout).not.toContain", "out.stderr).toContain('\"code\":\"root\"')"]) {
      expect(job.replaceAll("\\", ""), wanted).toContain(wanted.replaceAll("\\", ""));
    }
  });
});
