// Stdio MCP host redesign, task T11: the runner image on a real Linux host (the CI job `mcp-runner-linux`). It runs only there: it needs Docker, the built runner image (ROVARA_MCP_RUNNER_IMAGE)
// and, for the controller check, the pinned node image (ROVARA_CI_IMAGE_NODE_BUILD) and a built repository. Everywhere else it skips.
//
// What it proves that no test on a developer's machine can (design section 14):
//   - the processes are confined as promised, read from the HOST's /proc: not root, no_new_privs, no capabilities, the resource limits;
//   - a hostile package cannot write its own code or the root file system, gain a uid, fork without bound, write a huge file, or read other users' processes;
//   - the install task's real program installs from a registry and the tree it leaves can be read in full by uid 10003 (open item I-C);
//   - the bridge, fetch, install and controller refuse to run as root;
//   - a bundle with the wrong bytes is refused by fetch and the server does not start from it.
// The controller and the registry are the real ones, on this host's loopback; the tasks are real containers started the way ECS starts them (docker-runner.ts).
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerEntry, McpStdioProposal } from "@agentx/contracts";
import { createMcpController, type McpController } from "../../../packages/gateway/src/mcp-controller.js";
import { directoryBundleStore } from "../../../packages/gateway/src/mcp-runner/bundle-store.js";
import { dynamoMcpServerStore, summariseProbe } from "../../../packages/broker/src/context-sources/mcp-servers.js";
import { gatewayProber, hostProbeClient } from "../../../packages/broker/src/context-sources/server-port.js";
import { registryFor, toolsHashOf } from "../../../packages/broker/src/mcp-host/main.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { startFixtureRegistry, type FixtureRegistry } from "../../support/fixture-npm-registry.js";
import { NOW, ORG } from "../../unit/context-sources/fixtures.js";
import { dockerTaskRunner, ECS_FLAGS, realDocker } from "./docker-runner.js";
import { descendantsOf, parseLimits, parseStatus } from "./proc-status.js";

const IMAGE = process.env.ROVARA_MCP_RUNNER_IMAGE;
const NODE_IMAGE = process.env.ROVARA_CI_IMAGE_NODE_BUILD;
const execFileAsync = promisify(execFile);
const NODE = "/usr/local/bin/node";
const TOKEN = "t".repeat(48);
const NAME = "@acme/adversary";
const SERVER_ID = "mcpadv000001";
const proposal: McpStdioProposal = { registry: "npm", name: NAME, version: "1.0.0", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } };

describe.runIf(process.platform === "linux" && IMAGE !== undefined)("the MCP runner image on Linux", () => {
  const image = IMAGE!;
  let work: string;
  let registry: FixtureRegistry;
  let controller: McpController;
  let runner: ReturnType<typeof dockerTaskRunner>;
  let brokerUrl = "";
  let runnerUrl = "";
  const servers: Server[] = [];
  const table = new FakeDynamoDb();
  const store = dynamoMcpServerStore({ documentClient: table, tableName: "state" });
  const runLabel = `${process.pid}-${Date.now().toString(36)}`;
  let hashes: { integrity: string; lockfileHash: string; bundleHash: string } | undefined;

  const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> => {
    const server = createServer(handler);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`${brokerUrl}/servers/${SERVER_ID}/mcp`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(170_000),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    // The bridge answers JSON (or one server-sent event); take the JSON-RPC result either way.
    const json = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}";
    const result = JSON.parse(json) as { result?: { content?: Array<{ text?: string }> } };
    return JSON.parse(result.result?.content?.[0]?.text ?? "null") as unknown;
  };
  /** A one-off container of the image, started with the ECS flags, as `user`. Returns the exit code, stdout and stderr. */
  async function run(user: string, args: string[], extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const out = await execFileAsync("docker", ["run", "--rm", ...ECS_FLAGS, "--user", user, ...extra, image, ...args], { timeout: 120_000 });
      return { code: 0, stdout: out.stdout, stderr: out.stderr };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "mcp-runner-linux-"));
    const source = await readFile(join(import.meta.dirname, "adversary-mcp.mjs"), "utf8");
    registry = await startFixtureRegistry(join(work, "registry"), [{ name: NAME, version: "1.0.0", bin: { adversary: "bin/adversary.mjs" }, files: { "bin/adversary.mjs": { content: source, mode: 0o755 } } }]);
    const later: { controller?: McpController } = {};
    runnerUrl = await listen((req, res) => { void later.controller!.handleRunner(req, res); });
    brokerUrl = await listen((req, res) => { void later.controller!.handleBroker(req, res); });
    runner = dockerTaskRunner({ image, caFile: registry.caFile, runLabel });
    controller = createMcpController({
      token: TOKEN, runner, bundles: directoryBundleStore(join(work, "bundles")), controllerUrl: runnerUrl, npmRegistry: registry.url, toolsHashOf, pollMs: 500, limits: { startMs: 120_000, installMs: 240_000 },
      registry: registryFor(store, ORG, async (id) => `secret/${id}`),
    });
    later.controller = controller;
  }, 120_000);

  afterAll(async () => {
    await controller?.close();
    await runner?.stopAll();
    await Promise.all(servers.map((server) => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); })));
    await registry?.close();
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  }, 120_000);

  it("holds the image to its promises: no setuid file, no shell or git, what must be there, a non-root user, and it runs the way ECS runs it", async () => {
    const script = resolve("environments/mcp-runner/check-image.sh");
    const out = await execFileAsync("sh", [script, image], { timeout: 180_000 }).catch((error: { stdout?: string; stderr?: string }) => { throw new Error(`${error.stdout ?? ""}\n${error.stderr ?? ""}`); });
    expect(out.stdout).toContain("ok    no setuid or setgid file");
    expect(out.stdout).not.toContain("FAIL");
  }, 200_000);

  it("installs a package with the real install program in a container (uid 10002, read-only, no capabilities) and reports hashes", async () => {
    const probed = await gatewayProber({ host: hostProbeClient({ url: brokerUrl, token: TOKEN }) }).stdio(proposal);
    expect(probed.tools.map((tool) => tool.name)).toEqual(["attack"]);
    expect(probed.integrity).toBe(registry.integrityOf(NAME, "1.0.0"));
    hashes = { integrity: probed.integrity, lockfileHash: probed.lockfileHash!, bundleHash: probed.bundleHash! };
    expect(hashes.bundleHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(createHash("sha256").update(await readFile(join(work, "bundles", `${hashes.bundleHash}.tar`))).digest("hex")).toBe(hashes.bundleHash);
    await store.create(ORG, {
      serverId: SERVER_ID, label: "Adversary", status: "approved", transport: { kind: "stdio", spec: { ...proposal, ...hashes } }, probe: summariseProbe(probed.tools, NOW),
      requestedBy: "dev1", requestedAt: "2026-11-01T10:00:00Z",
    } satisfies McpServerEntry);
  }, 300_000);

  it("leaves a tree that uid 10003 can read in full from the read-only bundle volume (open item I-C)", async () => {
    // Starting the server runs fetch (uid 10002) and leaves the bundle volume; a separate container as 10003 then walks every file and folder.
    const dry = await call("attack", { live: false }) as { uid: number; gid: number };
    expect(dry).toMatchObject({ uid: 10003, gid: 10003 });
    const task = runner.started().find((item) => item.spec.purpose === "serve")!;
    const volume = runner.volumeOf(task.taskId)!;
    const walk = `const fs=require("fs"),p=require("path");let files=0,folders=0,failed=[];function go(d){folders+=1;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())go(f);else if(e.isFile()){try{fs.readFileSync(f);files+=1;}catch(x){failed.push(x.code);}}}}try{go("/bundle/tree");}catch(x){failed.push(x.code);}console.log(JSON.stringify({files,folders,failed}));`;
    const out = await run("10003:10003", [NODE, "-e", walk], ["-v", `${volume}:/bundle:ro`]);
    expect(out.code).toBe(0);
    const result = JSON.parse(out.stdout.trim().split("\n").pop()!) as { files: number; folders: number; failed: string[] };
    expect(result.failed).toEqual([]);
    expect(result.files).toBeGreaterThan(0);
    // and it cannot be written by the server's user
    const write = await run("10003:10003", [NODE, "-e", `try{require("fs").writeFileSync("/bundle/pwned","x");console.log("WROTE")}catch(e){console.log(e.code)}`], ["-v", `${volume}:/bundle:ro`]);
    expect(write.stdout.trim()).toBe("EROFS");
  }, 300_000);

  it("runs the server confined: not root, no_new_privs, no capabilities, and the limits the bridge sets (read from the host's /proc)", async () => {
    const task = runner.started().find((item) => item.spec.purpose === "serve")!;
    const container = runner.containerOf(task.taskId)!;
    const init = Number(await realDocker("inspect", "-f", "{{.State.Pid}}", container));
    expect(init).toBeGreaterThan(1);
    const pids = (await readdir("/proc")).filter((entry) => /^[0-9]+$/u.test(entry)).map(Number);
    const readStat = (pid: number): string | undefined => { try { return readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; } };
    const below = descendantsOf(init, pids, readStat);
    // The package's own process is the descendant that runs the adversary's program.
    const program = (await Promise.all(below.map(async (pid) => ({ pid, cmd: await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "") })))).find((item) => item.cmd.includes("adversary.mjs"));
    expect(program, `no process below ${init} runs adversary.mjs: ${below.join(",")}`).toBeDefined();
    const pid = program!.pid;
    const status = parseStatus(await readFile(`/proc/${pid}/status`, "utf8"));
    expect(status.uid).toEqual([10003, 10003, 10003, 10003]);
    expect(status.gid).toEqual([10003, 10003, 10003, 10003]);
    expect(status.noNewPrivs).toBe(1);
    for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] as const) expect(status.caps[name], name).toBe("0000000000000000");
    const limits = parseLimits(await readFile(`/proc/${pid}/limits`, "utf8"));
    expect(limits["Max open files"]).toEqual({ soft: "1024", hard: "1024" });
    expect(limits["Max processes"]).toEqual({ soft: "256", hard: "256" });
    expect(limits["Max file size"]).toEqual({ soft: "536870912", hard: "536870912" });
    expect(limits["Max core file size"]).toEqual({ soft: "0", hard: "0" });
    // the bridge itself (the process that started the package) is not root either, and holds no capability; no_new_privs is set on the package it starts, not on the bridge
    const bridgeProcess = (await Promise.all(below.map(async (item) => ({ pid: item, cmd: await readFile(`/proc/${item}/cmdline`, "utf8").catch(() => "") })))).find((item) => item.cmd.includes("serve.mjs"));
    expect(bridgeProcess, `no process below ${init} runs serve.mjs`).toBeDefined();
    const bridge = parseStatus(await readFile(`/proc/${bridgeProcess!.pid}/status`, "utf8"));
    expect(bridge.uid).toEqual([10003, 10003, 10003, 10003]);
    expect(bridge.gid).toEqual([10003, 10003, 10003, 10003]);
    for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] as const) expect(bridge.caps[name], `bridge ${name}`).toBe("0000000000000000");
    expect((await readlink(`/proc/${pid}/exe`)).endsWith("/node")).toBe(true);
  }, 120_000);

  it("stops a hostile package at every step it tries", async () => {
    const report = await call("attack", { live: true }) as {
      bundleWrite: { ok: boolean; code?: string }; rootWrite: { ok: boolean; code?: string }; setuid: { ok: boolean; code?: string }; setgid: { ok: boolean; code?: string }; chownToRoot: { ok: boolean; code?: string };
      otherProcesses: { visible: number; foreignUid: number; environRead: number; rootEntered: number };
      workers: { created: number; firstError: string | null; attempts: number };
      bigFile: { writtenBytes: number | null; code: string | null; signal: string | null; fileBytes: number };
    };
    // its own code is read-only, and so is the root file system
    expect(report.bundleWrite).toEqual({ ok: false, code: "EROFS" });
    expect(report.rootWrite).toEqual({ ok: false, code: "EROFS" });
    // it cannot become anyone else
    expect(report.setuid).toEqual({ ok: false, code: "EPERM" });
    expect(report.setgid).toEqual({ ok: false, code: "EPERM" });
    expect(report.chownToRoot).toEqual({ ok: false, code: "EPERM" });
    // it sees only this container's processes, and cannot read the environment or the files of one it does not own
    expect(report.otherProcesses.environRead).toBe(0);
    expect(report.otherProcesses.rootEntered).toBe(0);
    // a fork bomb meets the process limit before it reaches 300
    expect(report.workers.firstError).not.toBeNull();
    expect(report.workers.created).toBeLessThan(report.workers.attempts);
    // a file larger than the limit is refused (EFBIG) or the writer is killed by the signal; either way the file is no larger than 512 MiB
    expect(report.bigFile.code === "EFBIG" || report.bigFile.signal === "SIGXFSZ").toBe(true);
    expect(report.bigFile.fileBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
  }, 200_000);

  it("refuses to run as root: the bridge, fetch and install programs", async () => {
    const env = ["-e", `MCP_RUNNER_TOKEN=${"t".repeat(43)}`, "-e", `MCP_BUNDLE_HASH=${"a".repeat(64)}`, "-e", "MCP_CONTROLLER_URL=http://127.0.0.1:9", "-e", "MCP_PACKAGE_NAME=@acme/adversary", "-e", "MCP_MEMORY_MIB=512"];
    // Each program says WHY it stopped. A catch-all line (a missing setting, an unreachable controller, an empty volume) would be printed in this run too, so the checks read the root code, and a
    // control run as the right user must stop for another reason and NOT print it: remove the root check from a program and its test below fails.
    const serve = await run("0:0", [NODE, "/opt/mcp-runner/serve.mjs"], env);
    expect(serve.code).not.toBe(0);
    expect(serve.stdout).toContain('"event":"bridge.start_failed"');
    expect(serve.stdout).toContain('"code":"root"');
    const serveControl = await run("10003:10003", [NODE, "/opt/mcp-runner/serve.mjs"], env);
    expect(serveControl.code).not.toBe(0);
    expect(serveControl.stdout).toContain('"event":"bridge.start_failed"');
    expect(serveControl.stdout).not.toContain('"code":"root"');
    const fetched = await run("0:0", [NODE, "/opt/mcp-runner/fetch.mjs"], env);
    expect(fetched.code).not.toBe(0);
    expect(fetched.stdout).toContain('"code":"root"');
    const installed = await run("0:0", [NODE, "/opt/mcp-runner/install.mjs"], env);
    expect(installed.code).not.toBe(0);
    expect(installed.stdout).toContain('{"component":"mcp-install","ok":false,"code":"root"}');
    const installControl = await run("10002:10002", [NODE, "/opt/mcp-runner/install.mjs"], env);
    expect(installControl.code).not.toBe(0);
    expect(installControl.stdout).not.toContain('"code":"root"');
    const groupInstall = await run("10002:0", [NODE, "/opt/mcp-runner/install.mjs"], env);
    expect(groupInstall.code).not.toBe(0);
    expect(groupInstall.stdout).toContain('"code":"root"');
    // and as a half-way root (uid 10003 with group 0)
    const group = await run("10003:0", [NODE, "/opt/mcp-runner/fetch.mjs"], env);
    expect(group.code).not.toBe(0);
    expect(group.stdout).toContain('"code":"root"');
  }, 200_000);

  it.runIf(NODE_IMAGE !== undefined)("refuses to run the controller as root, before it reads any setting", async () => {
    const out = await execFileAsync("docker", ["run", "--rm", "--user", "0:0", "--read-only", "--cap-drop", "ALL", "--network", "none", "-v", `${resolve(".")}:/repo:ro`, NODE_IMAGE!, "node", "/repo/packages/broker/dist/mcp-host/main.js"], { timeout: 120_000 })
      .then(() => ({ code: 0, stderr: "" }), (error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, stderr: error.stderr ?? "" }));
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('"event":"start_failed"');
    expect(out.stderr).toContain('"code":"root"');
    expect(out.stderr).toContain("must not run as root");
  }, 150_000);

  it("refuses a bundle with the wrong bytes, leaves nothing in the volume, and a server started from that volume does not run", async () => {
    const wanted = createHash("sha256").update("the approved bundle").digest("hex");
    const wrong = randomBytes(2048);
    const nonce = randomBytes(32).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    const fake = await listen((req, res) => {
      if (req.method === "POST" && req.url === "/bootstrap") { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ token })); }); return; }
      if (req.method === "GET" && req.url === `/bundles/${wanted}`) { res.writeHead(200, { "content-type": "application/x-tar", "content-length": String(wrong.length) }); res.end(wrong); return; }
      res.writeHead(404); res.end();
    });
    const volume = `rovara-mcp-ci-${runLabel}-tamper`;
    await realDocker("volume", "create", "--label", `rovara.mcp-ci=${runLabel}`, volume);
    try {
      const fetched = await run("10002:10002", [NODE, "/opt/mcp-runner/fetch.mjs"], ["-v", `${volume}:/bundle`, "-e", `MCP_CONTROLLER_URL=${fake}`, "-e", `MCP_BOOTSTRAP_NONCE=${nonce}`, "-e", `MCP_BUNDLE_HASH=${wanted}`]);
      expect(fetched.code).not.toBe(0);
      expect(fetched.stdout).toContain('"code":"hash_mismatch"');
      const listing = await run("10002:10002", [NODE, "-e", `console.log(JSON.stringify(require("fs").readdirSync("/bundle")))`], ["-v", `${volume}:/bundle:ro`]);
      expect(JSON.parse(listing.stdout.trim())).toEqual([]);
      // the server container, started from the empty volume, does not serve (the bridge needs the verified marker)
      const server = await run("10003:10003", [NODE, "/opt/mcp-runner/serve.mjs"], [
        "-v", `${volume}:/bundle:ro`, "-e", `MCP_RUNNER_TOKEN=${token}`, "-e", `MCP_BUNDLE_HASH=${wanted}`, "-e", "MCP_PACKAGE_NAME=@acme/adversary", "-e", "MCP_MEMORY_MIB=512", "-e", "PORT=18081",
      ]);
      expect(server.code).not.toBe(0);
      expect(server.stdout).toContain("bridge.start_failed");
    } finally {
      await realDocker("volume", "rm", "-f", volume).catch(() => undefined);
    }
  }, 200_000);
});
