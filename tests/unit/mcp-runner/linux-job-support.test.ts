// Stdio MCP host redesign (T11): the parts of the Linux job that can be checked on any machine. The parsers that read the host's /proc, the hostile fixture's protocol and its dry mode (which
// does nothing but report), and the docker runner's command lines (against a fake docker). The job itself, with real containers, is tests/linux/mcp-runner/mcp-runner-linux.test.ts.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { descendantsOf, parentOf, parseLimits, parseStatus } from "../../linux/mcp-runner/proc-status.js";
import { dockerTaskRunner, ECS_FLAGS } from "../../linux/mcp-runner/docker-runner.js";

/** The flags written out, not read from the module under test. */
const ECS = ["--read-only", "--cap-drop", "ALL", "--init", "--network", "host"];

const STATUS = `Name:\tnode
Umask:\t0022
State:\tS (sleeping)
Uid:\t10003\t10003\t10003\t10003
Gid:\t10003\t10003\t10003\t10003
NoNewPrivs:\t1
CapInh:\t0000000000000000
CapPrm:\t0000000000000000
CapEff:\t0000000000000000
CapBnd:\t0000000000000000
CapAmb:\t0000000000000000
`;
const LIMITS = `Limit                     Soft Limit           Hard Limit           Units
Max cpu time              unlimited            unlimited            seconds
Max file size             536870912            536870912            bytes
Max core file size        0                    0                    bytes
Max processes             256                  256                  processes
Max open files            1024                 1024                 files
Max locked memory         8388608              8388608              bytes
`;

describe("T11: reading /proc", () => {
  it("reads the uids, no_new_privs and every capability set", () => {
    const status = parseStatus(STATUS);
    expect(status.uid).toEqual([10003, 10003, 10003, 10003]);
    expect(status.gid).toEqual([10003, 10003, 10003, 10003]);
    expect(status.noNewPrivs).toBe(1);
    expect(status.caps).toEqual({ CapInh: "0000000000000000", CapPrm: "0000000000000000", CapEff: "0000000000000000", CapBnd: "0000000000000000", CapAmb: "0000000000000000" });
  });
  it("reads a status with capabilities set, a root, and a status without no_new_privs, as they are", () => {
    const root = parseStatus("Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nCapEff:\t000001ffffffffff\n");
    expect(root.uid).toEqual([0, 0, 0, 0]);
    expect(root.caps.CapEff).toBe("000001ffffffffff");
    expect(root.noNewPrivs).toBeUndefined();
    expect(parseStatus("").uid).toEqual([]);
    expect(parseStatus("NoNewPrivs:\t0\n").noNewPrivs).toBe(0);
  });
  it("reads the limits table by name, soft and hard", () => {
    const limits = parseLimits(LIMITS);
    expect(limits["Max open files"]).toEqual({ soft: "1024", hard: "1024" });
    expect(limits["Max processes"]).toEqual({ soft: "256", hard: "256" });
    expect(limits["Max file size"]).toEqual({ soft: "536870912", hard: "536870912" });
    expect(limits["Max core file size"]).toEqual({ soft: "0", hard: "0" });
    expect(limits["Max cpu time"]).toEqual({ soft: "unlimited", hard: "unlimited" });
    expect(Object.keys(limits)).not.toContain("Limit");
  });
  it("finds the parent of a process whose name holds spaces and brackets", () => {
    expect(parentOf("1234 (tini (x) y) S 77 1234 1234 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 5 1000 100 18446744073709551615")).toBe(77);
    expect(parentOf("garbage")).toBeUndefined();
  });
  it("walks the tree below a process, not the process itself nor a stranger, and skips one that vanished", () => {
    const stats = new Map<number, string>([[100, "100 (init) S 1 1"], [101, "101 (bridge) S 100 1"], [102, "102 (setpriv) S 101 1"], [103, "103 (node) S 102 1"], [200, "200 (other) S 1 1"], [201, "201 (child of other) S 200 1"]]);
    const below = descendantsOf(100, [100, 101, 102, 103, 200, 201, 999], (pid) => stats.get(pid));
    expect(below.sort()).toEqual([101, 102, 103]);
    expect(descendantsOf(100, [], () => undefined)).toEqual([]);
  });
});

function talk(messages: unknown[]): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "..", "linux", "mcp-runner", "adversary-mcp.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)));
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

describe("T11: the hostile fixture server", () => {
  it("speaks enough MCP for the bridge: initialize, list its one tool, answer a call, ignore notifications", async () => {
    const replies = await talk([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "nope" },
    ]);
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "adversary" } } });
    expect(replies[1]).toMatchObject({ id: 2, result: { tools: [{ name: "attack", annotations: { readOnlyHint: true } }] } });
    expect(replies[2]).toMatchObject({ id: 3, error: { code: -32601 } });
  });
  it("in its dry mode only says what it would try: it touches no file, spawns nothing, and reports its own uid", async () => {
    const [reply] = await talk([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "attack", arguments: {} } }]);
    const report = JSON.parse(((reply!.result as { content: Array<{ text: string }> }).content[0]!).text) as Record<string, unknown>;
    expect(report.live).toBe(false);
    expect(report.plan).toEqual(["bundleWrite", "rootWrite", "setuid", "setgid", "chownToRoot", "otherProcesses", "workers", "bigFile"]);
    expect(report.uid).toBe(process.getuid?.());
    for (const attempted of ["bundleWrite", "rootWrite", "setuid", "workers", "bigFile"]) expect(report).not.toHaveProperty(attempted);
  });
  it("attacks only when asked to, with live: true (the file holds the one switch)", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "..", "linux", "mcp-runner", "adversary-mcp.mjs"), "utf8");
    expect(source).toContain("arguments?.live === true");
    expect(source).toContain("if (!live) return base;");
  });
});

describe("T11: the docker runner starts containers the way ECS does", () => {
  function fakeDocker() {
    const calls: string[][] = [];
    const docker = async (...args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "inspect") return "running 0";
      return "";
    };
    return { calls, docker };
  }
  const base = { purpose: "serve" as const, serverId: "mcpadv000001", approval: "a".repeat(12), family: "rovara-mcp-serve-mcpadv000001", taskDefinition: "x:1", size: { cpu: 256, memoryMiB: 512 } };
  it("gives every container a read-only root, no capabilities, an init process, and the user its role names", async () => {
    const { calls, docker } = fakeDocker();
    const runner = dockerTaskRunner({ image: "img:ci", caFile: "/tmp/ca.pem", docker, runLabel: "t" });
    const id = await runner.start({ ...base, containers: { fetch: { MCP_BUNDLE_HASH: "h" }, server: { MCP_PACKAGE_NAME: "p", PORT: "8080" } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const runs = calls.filter((args) => args[0] === "run");
    expect(runs).toHaveLength(2);
    for (const args of runs) {
      expect([...ECS_FLAGS]).toEqual(ECS);
      const at = args.indexOf("--read-only");
      expect(args.slice(at, at + ECS.length), args.join(" ")).toEqual(ECS);
      expect(args).not.toContain("--privileged");
      expect(args).not.toContain("--cap-add");
      expect(args).not.toContain("0");
    }
    const [fetch, server] = runs as [string[], string[]];
    expect(fetch[fetch.indexOf("--user") + 1]).toBe("10002:10002");
    expect(server[server.indexOf("--user") + 1]).toBe("10003:10003");
    // the server sees the bundle read-only, and gets the open-files limit ECS sets; the fetch step writes to it
    expect(fetch.some((arg) => /:\/bundle$/u.test(arg))).toBe(true);
    expect(server.some((arg) => /:\/bundle:ro$/u.test(arg))).toBe(true);
    expect(server).toContain("nofile=1024:1024");
    // the server is started only after fetch, and its port is its own
    expect(calls.findIndex((args) => args.includes("--user") && args[args.indexOf("--user") + 1] === "10003:10003")).toBeGreaterThan(calls.findIndex((args) => args.includes("--user") && args[args.indexOf("--user") + 1] === "10002:10002"));
    expect(server.some((arg) => /^PORT=\d+$/u.test(arg) && arg !== "PORT=8080")).toBe(true);
    expect((await runner.describe(id))?.state).toBe("running");
    await runner.stopAll();
    expect(calls.some((args) => args[0] === "rm")).toBe(true);
  });
  it("does not start the server when the fetch step fails", async () => {
    const calls: string[][] = [];
    const docker = async (...args: string[]): Promise<string> => { calls.push(args); if (args[0] === "run" && args.includes("10002:10002")) throw Object.assign(new Error("exit 1"), { stdout: '{"code":"hash_mismatch"}' }); return ""; };
    const runner = dockerTaskRunner({ image: "img:ci", caFile: "/tmp/ca.pem", docker, runLabel: "t" });
    const id = await runner.start({ ...base, containers: { fetch: {}, server: {} } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.filter((args) => args[0] === "run" && args.includes("10003:10003"))).toEqual([]);
    expect(await runner.describe(id)).toEqual({ state: "stopped", exitCode: 1 });
    expect(runner.started()[0]!.fetchOutput).toContain("hash_mismatch");
  });
  it("runs the install task as 10002 with the registry's authority mounted read-only", async () => {
    const { calls, docker } = fakeDocker();
    const runner = dockerTaskRunner({ image: "img:ci", caFile: "/tmp/ca.pem", docker, runLabel: "t" });
    await runner.start({ ...base, purpose: "install", serverId: "install", approval: "", family: "rovara-mcp-install", containers: { install: { MCP_BOOTSTRAP_NONCE: "n" } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const install = calls.find((args) => args[0] === "run")!;
    expect(install[install.indexOf("--user") + 1]).toBe("10002:10002");
    expect(install).toContain("/tmp/ca.pem:/ca.pem:ro");
    expect(install.at(-1)).toBe("/opt/mcp-runner/install.mjs");
    const at = install.indexOf("--read-only");
    expect(install.slice(at, at + ECS.length)).toEqual(ECS);
  });
  it("lists only tasks that are not stopped, as this runner's own", async () => {
    const { docker } = fakeDocker();
    const runner = dockerTaskRunner({ image: "img:ci", caFile: "/tmp/ca.pem", docker, runLabel: "t" });
    const id = await runner.start({ ...base, containers: { fetch: {}, server: {} } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await runner.list()).map((task) => [task.taskId, task.owner])).toEqual([[id, "dockerci"]]);
    await runner.stop(id, "idle");
    expect(await runner.list()).toEqual([]);
    expect(runner.started()[0]!.stoppedFor).toBe("idle");
  });
});
