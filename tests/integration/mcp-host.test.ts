// Stdio MCP host redesign, task T6: the controller end to end. A real npm install against a local https registry (the install task's real program), a real fetch step and a real bridge
// running a real stdio server (the local runner runs the two containers' steps in this machine's processes), the broker's own port and prober talking to the controller over HTTP.
// No cloud and no network beyond this machine's loopback; the only thing not real is the confinement (no setpriv or prlimit on a developer's machine).
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerEntry, McpStdioProposal } from "@agentx/contracts";
import { createMcpController, type McpController } from "../../packages/gateway/src/mcp-controller.js";
import { directoryBundleStore } from "../../packages/gateway/src/mcp-runner/bundle-store.js";
import { localTaskRunner } from "../../packages/gateway/src/mcp-runner/local-runner.js";
import { McpProbeError, dynamoMcpServerStore, summariseProbe } from "../../packages/broker/src/context-sources/mcp-servers.js";
import { gatewayProber, gatewayServerPort, hostProbeClient } from "../../packages/broker/src/context-sources/server-port.js";
import { main as installMain } from "../../packages/broker/src/mcp-runner/install-main.js";
import { registryFor, toolsHashOf } from "../../packages/broker/src/mcp-host/main.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { startFixtureRegistry, type FixtureRegistry } from "../support/fixture-npm-registry.js";
import { NOW, ORG } from "../unit/context-sources/fixtures.js";

const FIXTURE = join(import.meta.dirname, "..", "support", "stdio-mcp-fixture.mjs");
const TOKEN = "t".repeat(48);
const NAME = "@acme/sim-mcp";
const proposal: McpStdioProposal = { registry: "npm", name: NAME, version: "1.4.2", args: [], destinations: [], secretEnv: ["JIRA_TOKEN"], size: { cpu: 256, memoryMiB: 512 } };

let work: string;
let registry: FixtureRegistry;
let controller: McpController;
let runner: ReturnType<typeof localTaskRunner>;
let brokerUrl = "";
let runnerUrl = "";
const servers: Server[] = [];
const table = new FakeDynamoDb();
const store = dynamoMcpServerStore({ documentClient: table, tableName: "state" });
let bundleHash = "";
let lockfileHash = "";
let integrity = "";
let installs = 0;

const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "mcp-host-"));
  process.env.MCP_HOST_SECRET_FOR_TEST = "must-not-reach-a-hosted-server";
  registry = await startFixtureRegistry(join(work, "registry"), [
    { name: NAME, version: "1.4.2", bin: { "sim-mcp": "bin/server.mjs" }, files: { "bin/server.mjs": { content: `import ${JSON.stringify(FIXTURE)};\n`, mode: 0o755 } } },
    { name: "git-direct", version: "1.0.0", bin: "i.js", dependencies: { thing: "github:acme/thing#main" }, files: { "i.js": "x" } },
  ]);
  const later: { controller?: McpController } = {};
  runnerUrl = await listen((req, res) => { void later.controller!.handleRunner(req, res); });
  brokerUrl = await listen((req, res) => { void later.controller!.handleBroker(req, res); });
  let counter = 0;
  runner = localTaskRunner({
    controllerUrl: runnerUrl, workRoot: join(work, "tasks"),
    installStep: async (environment) => {
      installs += 1;
      counter += 1;
      // The install task's real program, with the registry's own certificate authority and a work folder of its own.
      return installMain({ env: { ...environment, MCP_INSTALL_WORKDIR: join(work, `install-${counter}`), ROVARA_MCP_NPM_CAFILE: registry.caFile }, getuid: () => 10_002, getgid: () => 10_002, write: () => undefined, bootstrap: { delayMs: 20 } });
    },
    secrets: () => ({ JIRA_TOKEN: "s3cret-value" }),
  });
  controller = createMcpController({
    token: TOKEN, runner, bundles: directoryBundleStore(join(work, "bundles")), controllerUrl: runnerUrl, npmRegistry: registry.url, toolsHashOf, pollMs: 25, limits: { startMs: 30_000, installMs: 120_000 },
    registry: registryFor(store, ORG, async (serverId) => `secret/${serverId}`),
  });
  later.controller = controller;
}, 120_000);

afterAll(async () => {
  await controller.close();
  await runner.stopAll();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  await registry.close();
  await rm(work, { recursive: true, force: true });
  delete process.env.MCP_HOST_SECRET_FOR_TEST;
});

const prober = () => gatewayProber({ host: hostProbeClient({ url: brokerUrl, token: TOKEN }) });
const stdioServer = (serverId: string) => ({ kind: "registered_server" as const, serverId });
const entryOf = (serverId: string, tools: Awaited<ReturnType<ReturnType<typeof prober>["stdio"]>>["tools"], over: Partial<McpServerEntry> = {}): McpServerEntry => ({
  serverId, label: "Wiki", status: "approved", transport: { kind: "stdio", spec: { ...proposal, integrity, lockfileHash, bundleHash } }, probe: summariseProbe(tools, NOW),
  hasSecret: true, secretVersion: "v1", requestedBy: "dev1", requestedAt: "2026-11-01T10:00:00Z", ...over,
});
const portFor = (edition: "enterprise" | "public" = "enterprise") => gatewayServerPort({
  edition, connections: { read: async () => undefined, token: async () => undefined }, servers: store, stdioEnabled: true, mcpHost: { url: brokerUrl, token: TOKEN },
});
let tools: Awaited<ReturnType<ReturnType<typeof prober>["stdio"]>>["tools"] = [];

describe("T6 end to end: propose, approve, serve", () => {
  it("installs the package from the registry, tests it in a probe task, and answers with the tools and the hashes an approval binds", async () => {
    const probed = await prober().stdio(proposal);
    expect(probed.tools.map((tool) => tool.name).sort()).toEqual(["echo", "env_keys"]);
    integrity = probed.integrity;
    expect(integrity).toBe(registry.integrityOf(NAME, "1.4.2"));
    expect(probed.lockfileHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(probed.bundleHash).toMatch(/^[0-9a-f]{64}$/u);
    lockfileHash = probed.lockfileHash!;
    bundleHash = probed.bundleHash!;
    tools = probed.tools;
    // the stored bundle is the one whose hash is reported
    expect(createHash("sha256").update(await readFile(join(work, "bundles", `${bundleHash}.tar`))).digest("hex")).toBe(bundleHash);
    expect(installs).toBe(1);
    expect(runner.started().map((task) => task.spec.purpose)).toEqual(["install", "probe"]);
  }, 180_000);

  it("tests the pinned bundle again at approval, without installing again, and gets the same hashes and tools", async () => {
    const before = installs;
    const again = await prober().stdio({ ...proposal, integrity }, { lockfileHash, bundleHash });
    expect(again.bundleHash).toBe(bundleHash);
    expect(again.lockfileHash).toBe(lockfileHash);
    expect(summariseProbe(again.tools, NOW).toolsHash).toBe(summariseProbe(tools, NOW).toolsHash);
    expect(installs).toBe(before);
  }, 120_000);

  it("serves an approved server: the broker's port lists its tools and calls it, through the controller, a task, the bridge and the stdio server", async () => {
    await store.create(ORG, entryOf("mcpsim000001", tools));
    const port = portFor();
    const all = await port.listAll!(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(60_000));
    expect(all.map((tool) => tool.name).sort()).toEqual(["echo", "env_keys"]);
    const session = await port.open(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(60_000), ["echo"]);
    try {
      expect((await session.call("echo", { word: "hello" }, AbortSignal.timeout(20_000))).content?.[0]?.text).toBe("echo:hello");
    } finally {
      await session.close();
    }
    expect(controller.running()).toBe(1);
  }, 120_000);

  it("gives the server exactly its declared secret and nothing of the host's, the task's or the broker's", async () => {
    const port = portFor();
    const session = await port.open(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(60_000), ["env_keys"]);
    try {
      const keys = String((await session.call("env_keys", {}, AbortSignal.timeout(20_000))).content?.[0]?.text).split(",");
      expect(keys).toContain("JIRA_TOKEN");
      expect(keys).toContain("HOME");
      for (const forbidden of ["MCP_HOST_SECRET_FOR_TEST", "MCP_RUNNER_TOKEN", "MCP_HOST_TOKEN", "AWS_SECRET_ACCESS_KEY", "ROVARA_MCP_NPM_REGISTRY", "MCP_CONTROLLER_URL"]) expect(keys, forbidden).not.toContain(forbidden);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("starts ONE task for the server however many first requests arrive together, and none again while it is up", async () => {
    const port = portFor();
    const before = runner.started().filter((task) => task.spec.purpose === "serve").length;
    const lists = await Promise.all([1, 2, 3, 4].map(() => port.listAll!(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(60_000))));
    expect(lists.every((list) => list.length === 2)).toBe(true);
    expect(runner.started().filter((task) => task.spec.purpose === "serve").length).toBe(before);
  }, 120_000);

  it("turns away a missing or wrong token, an id the registry does not call approved, and a method the route does not take", async () => {
    const post = (path: string, headers: Record<string, string>) => fetch(`${brokerUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    expect((await post("/servers/mcpsim000001/mcp", {})).status).toBe(401);
    expect((await post("/servers/mcpsim000001/mcp", { authorization: `Bearer ${"x".repeat(40)}` })).status).toBe(401);
    expect((await post("/probe", {})).status).toBe(401);
    expect((await post("/servers/mcpunknown001/mcp", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await post("/servers/..%2F..%2Fetc/mcp", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await fetch(`${brokerUrl}/servers/mcpsim000001/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect((await fetch(`${brokerUrl}/healthz`)).status).toBe(200);
  });

  it("says the host is unavailable when there is none, or its token is wrong", async () => {
    await expect(gatewayProber({}).stdio(proposal)).rejects.toMatchObject({ code: "host_unavailable" });
    await expect(gatewayProber({ host: hostProbeClient({ url: brokerUrl, token: "wrong".repeat(10) }) }).stdio(proposal)).rejects.toBeInstanceOf(McpProbeError);
  });

  it("is not offered by Public: the port refuses a registered server there", async () => {
    await expect(portFor("public").open(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(5_000), ["echo"])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stops serving an entry the moment the registry stops calling it approved", async () => {
    await store.create(ORG, entryOf("mcpgone00001", tools));
    const port = portFor();
    const first = await port.open(ORG, stdioServer("mcpgone00001"), AbortSignal.timeout(60_000), ["echo"]);
    await first.close();
    await store.decide({ orgId: ORG, serverId: "mcpgone00001", from: "approved", to: "disabled", by: "admin", at: new Date(NOW).toISOString() });
    await expect(port.open(ORG, stdioServer("mcpgone00001"), AbortSignal.timeout(20_000), ["echo"])).rejects.toBeDefined();
  }, 120_000);

  it("stops a server whose tools are not the ones approved and serves nothing from it", async () => {
    const wrong = summariseProbe([{ name: "echo", inputSchema: { type: "object" } }], NOW);
    await store.create(ORG, entryOf("mcpchanged001", tools, { probe: wrong }));
    await expect(portFor().open(ORG, stdioServer("mcpchanged001"), AbortSignal.timeout(60_000), ["echo"])).rejects.toBeDefined();
    const tasks = runner.started().filter((task) => task.spec.serverId === "mcpchanged001");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.stoppedFor).toBe("tools_changed");
  }, 120_000);

  it("never runs a bundle that is not the approved one: bytes changed in the store are refused by the fetch step and no server starts", async () => {
    await store.create(ORG, entryOf("mcptamper0001", tools));
    const file = join(work, "bundles", `${bundleHash}.tar`);
    const original = await readFile(file);
    // only a server that is not up already is started again: stop the others' use of the bundle by tampering for a new server id
    await writeFile(file, Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([original[original.length - 1]! ^ 1])]));
    try {
      await expect(portFor().open(ORG, stdioServer("mcptamper0001"), AbortSignal.timeout(60_000), ["echo"])).rejects.toBeDefined();
    } finally {
      await writeFile(file, original);
    }
    const tamper = runner.started().filter((task) => task.spec.serverId === "mcptamper0001");
    expect(tamper.length).toBeGreaterThanOrEqual(1);
    // a positive control: with the bytes restored, the same server starts
    const session = await portFor().open(ORG, stdioServer("mcptamper0001"), AbortSignal.timeout(60_000), ["echo"]);
    await session.close();
  }, 180_000);
});

describe("T6 end to end: what the install refuses", () => {
  it("refuses a package with a git dependency before anything is installed, with the install's fixed reason, and starts no probe", async () => {
    const before = runner.started().filter((task) => task.spec.purpose === "probe").length;
    const response = await fetch(`${brokerUrl}/probe`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ spec: { ...proposal, name: "git-direct", version: "1.0.0" } }) });
    const body = await response.json() as { error?: string; install?: { code?: string; sentence?: string } };
    expect(body.error).toBe("host_refused");
    expect(body.install?.code).toBe("git_dependency");
    expect(body.install?.sentence).toContain("does not come from your registry");
    expect(runner.started().filter((task) => task.spec.purpose === "probe").length).toBe(before);
    await expect(prober().stdio({ ...proposal, name: "git-direct", version: "1.0.0" })).rejects.toMatchObject({ code: "host_refused" });
  }, 180_000);
  it("refuses a package whose tarball is not the checksum the admin typed, and shows the checksum it really has", async () => {
    const wrong = `sha512-${"B".repeat(86)}==`;
    const response = await fetch(`${brokerUrl}/install`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ spec: { ...proposal, integrity: wrong } }) });
    expect(await response.json()).toMatchObject({ ok: false, code: "integrity_mismatch", computedIntegrity: registry.integrityOf(NAME, "1.4.2") });
  }, 180_000);
});
