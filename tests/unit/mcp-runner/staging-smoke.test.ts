// Stdio MCP host redesign (T12): the staging smoke, against fakes. Nothing here calls AWS or a host. What is checked: each phase passes on a healthy world and fails on each way the world can be
// wrong; every AWS call goes through the staging guard; the token and the environment values are never printed; waits are bounded; and the command line does nothing without its two switches.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, STAGING_ACCOUNT, STAGING_GUARD_PATH, checkConfig, checkStagingTarget, guardedAws, main, phaseDisable, phaseIdle, phaseRestart, phaseStart, runPhase, type SmokeConfig, type SmokeDeps } from "../../staging/mcp-runner-smoke.js";

const TOKEN = "T".repeat(48);
const SERVER = "mcpself000001";
const config: SmokeConfig = {
  hostUrl: "https://mcp-host.staging.example.net", environment: "staging", hostToken: TOKEN, serverId: SERVER, cluster: "rovara-mcp-test", controllerService: "McpHostServiceX", runnerSubnets: ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"],
  installSecurityGroup: "sg-0123456789abcdef0", declaredEnv: ["SELF_TOKEN"], approved: { host: "fixture.staging.internal", port: 443 }, vpcProbe: { host: "10.42.9.9", port: 443 }, internetProbe: { host: "1.1.1.1", port: 443 },
};

interface World {
  clock: { now: number };
  tasks: string[];
  calls: string[][];
  logs: string[];
  fetches: Array<{ url: string; auth: string | null }>;
  selfcheck: Record<string, unknown>;
  coldStartMs: number;
  taskRole: string | undefined;
  containers: Array<Record<string, unknown>>;
  groupsOfEni: string[];
  egress: Array<Record<string, unknown>>;
  hostStatus: { warm: number; release: number; call: number };
  /** When set, the serve task disappears this long after the world starts being polled. */
  stopAfterMs: number | undefined;
  planted: { lastStatus: string; stoppedReason?: string; runningAfterMs: number; stopsAfterMs: number | undefined; plantedAt?: number; restartedAt?: number };
  failAws: (args: string[]) => boolean;
  /** The host name staging recorded for its MCP host (`rovaraMcpHostName` in the synth settings), or the whole parameter value when set. */
  recordedHost: string;
  settingsValue: string | undefined;
  /** What the signed-in account is, and what the cluster's ARN says. */
  account: string;
  clusterArn: string;
}

function healthy(): World {
  return {
    clock: { now: 1_000_000 }, tasks: ["arn:aws:ecs:us-west-2:111111111111:task/rovara-mcp-test/aaaa1111"], calls: [], logs: [], fetches: [],
    selfcheck: { live: true, credentials: { uriVariable: false, metadataStatus: 404 }, internet: "timeout", vpc: "timeout", approved: "connected", environment: ["HOME", "PATH", "SELF_TOKEN", "TMPDIR"] },
    coldStartMs: 41_000, taskRole: undefined,
    containers: [
      { name: "fetch", user: "10002:10002", readonlyRootFilesystem: true, linuxParameters: { capabilities: { drop: ["ALL"] } } },
      { name: "server", user: "10003:10003", readonlyRootFilesystem: true, linuxParameters: { capabilities: { drop: ["ALL"] } } },
    ],
    groupsOfEni: ["sg-0serve000000000001"], egress: [{ IpRanges: [{ CidrIp: "10.42.9.1/32" }] }],
    hostStatus: { warm: 202, release: 200, call: 200 }, stopAfterMs: undefined, planted: { lastStatus: "PENDING", runningAfterMs: 20_000, stopsAfterMs: 90_000 },
    failAws: () => false, recordedHost: "mcp-host.staging.example.net", settingsValue: undefined, account: "944937319445", clusterArn: "arn:aws:ecs:us-west-2:944937319445:cluster/rovara-mcp-test",
  };
}

function deps(world: World): SmokeDeps {
  const sleep = async (ms: number): Promise<void> => { world.clock.now += ms; };
  const start = world.clock.now;
  return {
    now: () => world.clock.now, sleep, log: (line) => { world.logs.push(line); },
    fetch: (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      world.fetches.push({ url, auth: init.headers.authorization ?? null });
      if (url.endsWith("/warm")) return new Response(JSON.stringify({ status: "starting" }), { status: world.hostStatus.warm });
      if (url.endsWith("/release")) return new Response(JSON.stringify({ status: "released" }), { status: world.hostStatus.release });
      world.clock.now += world.coldStartMs;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(world.selfcheck) }] } }), { status: world.hostStatus.call });
    }) as unknown as typeof fetch,
    async aws(args) {
      world.calls.push(args);
      if (world.failAws(args)) throw new Error("aws exited 254");
      const [service, command] = args;
      if (service === "ssm" && command === "get-parameter") return `${world.settingsValue ?? JSON.stringify({ context: { rovaraMcpHostName: world.recordedHost, rovaraStdioMcpServers: "true" } })}\n`;
      if (service === "sts" && command === "get-caller-identity") return `${world.account}\n`;
      if (service === "ecs" && command === "describe-clusters") return `${world.clusterArn}\n`;
      if (service === "ecs" && command === "list-tasks") {
        if (world.stopAfterMs !== undefined && world.clock.now - start >= world.stopAfterMs) world.tasks = [];
        return JSON.stringify({ taskArns: world.tasks });
      }
      if (service === "ecs" && command === "describe-tasks") {
        if (args.includes("smoke-plant-task")) {
          const p = world.planted;
          const age = world.clock.now - (p.plantedAt ?? world.clock.now);
          const lastStatus = p.restartedAt !== undefined && p.stopsAfterMs !== undefined && world.clock.now - p.restartedAt >= p.stopsAfterMs ? "STOPPED" : age >= p.runningAfterMs ? "RUNNING" : "PENDING";
          return JSON.stringify({ tasks: [{ lastStatus, ...(lastStatus === "STOPPED" ? { stoppedReason: p.stoppedReason ?? "leftover" } : {}) }] });
        }
        return JSON.stringify({ tasks: [{ taskDefinitionArn: "arn:aws:ecs:us-west-2:111111111111:task-definition/rovara-mcp-serve-mcpself000001:3", attachments: [{ details: [{ name: "networkInterfaceId", value: "eni-0123456789abcdef0" }] }] }] });
      }
      if (service === "ecs" && command === "describe-task-definition") return JSON.stringify({ taskDefinition: { ...(world.taskRole === undefined ? {} : { taskRoleArn: world.taskRole }), containerDefinitions: world.containers } });
      if (service === "ec2" && command === "describe-network-interfaces") return JSON.stringify({ NetworkInterfaces: [{ Groups: world.groupsOfEni.map((GroupId) => ({ GroupId })) }] });
      if (service === "ec2" && command === "describe-security-groups") return JSON.stringify({ SecurityGroups: [{ IpPermissionsEgress: world.egress }] });
      if (service === "ecs" && command === "run-task") { world.planted.plantedAt = world.clock.now; return JSON.stringify({ tasks: [{ taskArn: "smoke-plant-task" }] }); }
      if (service === "ecs" && command === "update-service") { world.planted.restartedAt = world.clock.now; return "{}"; }
      return "{}";
    },
  };
}

const failed = (report: { checks: Array<{ ok: boolean; name: string }> }): string[] => report.checks.filter((check) => !check.ok).map((check) => check.name);

describe("T12 smoke: the start phase", () => {
  it("passes on a healthy world, and reports the measured cold start", async () => {
    const w = healthy();
    const report = await phaseStart(config, deps(w));
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "first call")!.detail).toContain("41000 ms");
  });
  it("fails each way the task can reach too much", async () => {
    const cases: Array<[string, (w: World) => void, string]> = [
      ["credentials variable", (w) => { w.selfcheck = { ...w.selfcheck, credentials: { uriVariable: true, metadataStatus: 404 } }; }, "no credentials variable"],
      ["credentials from the metadata endpoint", (w) => { w.selfcheck = { ...w.selfcheck, credentials: { uriVariable: false, metadataStatus: 200 } }; }, "no credentials from 169.254.170.2"],
      ["internet answers", (w) => { w.selfcheck = { ...w.selfcheck, internet: "connected" }; }, "the internet times out"],
      ["unapproved VPC address answers", (w) => { w.selfcheck = { ...w.selfcheck, vpc: "connected" }; }, "a VPC address that was not approved times out"],
      ["approved address does not answer", (w) => { w.selfcheck = { ...w.selfcheck, approved: "timeout" }; }, "the approved address answers"],
      ["a reserved variable", (w) => { w.selfcheck = { ...w.selfcheck, environment: ["PATH", "SELF_TOKEN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"] }; }, "environment holds only declared names"],
      ["a declared name missing", (w) => { w.selfcheck = { ...w.selfcheck, environment: ["PATH"] }; }, "environment holds only declared names"],
      ["no report at all", (w) => { w.selfcheck = {}; }, "no credentials variable"],
      ["a task role", (w) => { w.taskRole = "arn:aws:iam::111111111111:role/x"; }, "no task role"],
      ["a writable root", (w) => { w.containers = [{ ...w.containers[0]!, readonlyRootFilesystem: false }, w.containers[1]!]; }, "containers locked down"],
      ["a kept capability", (w) => { w.containers = [w.containers[0]!, { ...w.containers[1]!, linuxParameters: { capabilities: { drop: ["NET_RAW"] } } }]; }, "containers locked down"],
      ["root user", (w) => { w.containers = [{ ...w.containers[0]!, user: "0:0" }, w.containers[1]!]; }, "containers locked down"],
      ["a privileged container", (w) => { w.containers = [{ ...w.containers[0]!, privileged: true }, w.containers[1]!]; }, "containers locked down"],
      ["the whole internet in the group", (w) => { w.egress = [{ IpRanges: [{ CidrIp: "0.0.0.0/0" }] }]; }, "its own security group, no way out"],
      ["an IPv6 rule", (w) => { w.egress = [{ Ipv6Ranges: [{ CidrIpv6: "::/0" }] }]; }, "its own security group, no way out"],
      ["shared groups", (w) => { w.groupsOfEni = ["sg-0a", "sg-0b"]; }, "its own security group, no way out"],
      ["two tasks", (w) => { w.tasks = ["a", "b"]; }, "one serve task"],
      ["the host refuses the call", (w) => { w.hostStatus.call = 503; }, "first call"],
      ["a cold start that is too slow", (w) => { w.coldStartMs = LIMITS.coldStart + 1; }, "cold start within bound"],
    ];
    for (const [label, change, expected] of cases) {
      const w = healthy();
      change(w);
      const report = await phaseStart(config, deps(w));
      expect(report.ok, label).toBe(false);
      expect(failed(report), label).toContain(expected);
    }
  });
  it("fails, rather than pass, when the cloud cannot be read", async () => {
    const w = healthy();
    w.failAws = () => true;
    const report = await phaseStart(config, deps(w));
    expect(report.ok).toBe(false);
    expect(failed(report)).toContain("the task's shape");
  });
  it("sends the token only to the host, and the questions it asks the task are the configured addresses", async () => {
    const w = healthy();
    await phaseStart(config, deps(w));
    expect(w.fetches.every((request) => request.url.startsWith("https://mcp-host.staging.example.net/servers/mcpself000001/"))).toBe(true);
    expect(w.fetches.every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
  });
});

describe("T12 smoke: the idle, disable and restart phases", () => {
  it("idle passes when the task goes within the idle time, fails when it never goes, and fails when there is nothing to wait for", async () => {
    const stops = healthy();
    stops.stopAfterMs = 11 * 60_000;
    const report = await phaseIdle(config, deps(stops));
    expect(report.ok).toBe(true);
    expect(report.checks[0]!.detail).toMatch(/after (?:6[5-9]\d{4}|[67]\d{5}) ms/u);
    const stays = healthy();
    expect((await phaseIdle(config, deps(stays))).ok).toBe(false);
    expect(stays.clock.now - 1_000_000).toBeLessThanOrEqual(LIMITS.idleStop + LIMITS.poll);
    const none = healthy();
    none.tasks = [];
    expect(failed(await phaseIdle(config, deps(none)))).toEqual(["a task to wait for"]);
  });
  it("disable passes when the task is gone within 60 s, the host released it and a call is refused; fails otherwise", async () => {
    const good = healthy();
    good.stopAfterMs = 20_000;
    good.hostStatus.call = 404;
    const report = await phaseDisable(config, deps(good));
    expect(failed(report)).toEqual([]);
    const slow = healthy();
    slow.stopAfterMs = 120_000;
    slow.hostStatus.call = 404;
    expect(failed(await phaseDisable(config, deps(slow)))).toContain("the task stops within 60 s of Turn off");
    const served = healthy();
    served.stopAfterMs = 10_000;
    expect(failed(await phaseDisable(config, deps(served)))).toContain("a call to a turned-off server is refused");
    const stuck = healthy();
    stuck.stopAfterMs = 10_000;
    stuck.hostStatus.call = 404;
    stuck.hostStatus.release = 409;
    expect(failed(await phaseDisable(config, deps(stuck)))).toContain("the host released it");
  });
  it("restart plants a leftover with the install family, restarts the controller, and passes only when the leftover is stopped as a leftover", async () => {
    const w = healthy();
    const report = await phaseRestart(config, deps(w));
    expect(failed(report)).toEqual([]);
    const run = w.calls.find((args) => args[1] === "run-task")!;
    expect(run).toContain("rovara-mcp-install");
    expect(run[run.indexOf("--started-by") + 1]).toBe("smoke-plant");
    expect(run.join(" ")).toContain("assignPublicIp=DISABLED");
    expect(run.join(" ")).toContain("securityGroups=[sg-0123456789abcdef0]");
    expect(w.calls.some((args) => args[1] === "update-service" && args.includes("--force-new-deployment") && args.includes("McpHostServiceX"))).toBe(true);
    // stopped for another reason: not a pass
    const other = healthy();
    other.planted.stoppedReason = "Essential container exited";
    expect(failed(await phaseRestart(config, deps(other)))).toContain("the new controller stops the leftover");
    // never stopped: not a pass, bounded, and the planted task is stopped by hand
    const never = healthy();
    never.planted.stopsAfterMs = undefined;
    const bounded = await phaseRestart(config, deps(never));
    expect(failed(bounded)).toContain("the new controller stops the leftover");
    expect(never.calls.some((args) => args[1] === "stop-task" && args.includes("smoke-plant-task"))).toBe(true);
    expect(never.clock.now - 1_000_000).toBeLessThanOrEqual(LIMITS.plantRunning + LIMITS.restartStop + 3 * LIMITS.poll + 20_000);
  });
  it("restart stops its planted task and fails when it never reaches RUNNING, and fails when it cannot be planted", async () => {
    const slow = healthy();
    slow.planted.runningAfterMs = 10 * 60_000;
    const report = await phaseRestart(config, deps(slow));
    expect(failed(report)).toEqual(["a planted leftover task"]);
    expect(slow.calls.some((args) => args[1] === "stop-task")).toBe(true);
    expect(slow.calls.some((args) => args[1] === "update-service")).toBe(false);
    const cannot = healthy();
    cannot.failAws = (args) => args[1] === "run-task";
    expect(failed(await phaseRestart(config, deps(cannot)))).toEqual(["a planted leftover task"]);
  });
});

/** The smoke's source without its comment lines, so a check on what the code does is not fooled by a comment that names what it must not do. */
const code = async (): Promise<string> => (await readFile(join(import.meta.dirname, "..", "..", "staging", "mcp-runner-smoke.ts"), "utf8")).split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");

describe("T12 smoke: safety", () => {
  it("refuses a config that is not usable, before any call", async () => {
    const w = healthy();
    for (const bad of [{ hostUrl: "http://mcp-host.staging.example.net" }, { hostUrl: "nope" }, { serverId: "../x" }, { hostToken: "short" }, { runnerSubnets: [] }, { runnerSubnets: ["x"] }, { installSecurityGroup: "sg" }, { approved: { host: "", port: 443 } }, { vpcProbe: { host: "10.0.0.1", port: 0 } }]) {
      await expect(runPhase("start", { ...config, ...bad }, deps(w)), JSON.stringify(Object.keys(bad))).rejects.toThrow();
    }
    expect(w.calls).toEqual([]);
    expect(w.fetches).toEqual([]);
    expect(() => checkConfig(config)).not.toThrow();
  });
  it("prints names, counts and times only: never the token, and no environment value", async () => {
    const w = healthy();
    w.selfcheck = { ...(w.selfcheck as object), environment: ["SELF_TOKEN", "PATH"], leaked: "value-of-self-token-9f" };
    const out: string[] = [];
    const code = await main(["--run", "start"], { ROVARA_STAGING_SMOKE: "1", MCP_HOST_URL: config.hostUrl, MCP_HOST_TOKEN: TOKEN, SMOKE_SERVER_ID: SERVER, SMOKE_ENV: "staging", SMOKE_CLUSTER: config.cluster, SMOKE_CONTROLLER_SERVICE: config.controllerService, SMOKE_RUNNER_SUBNETS: config.runnerSubnets.join(","), SMOKE_INSTALL_SECURITY_GROUP: config.installSecurityGroup, SMOKE_DECLARED_ENV: "SELF_TOKEN", SMOKE_APPROVED: "fixture.staging.internal:443", SMOKE_VPC_PROBE: "10.42.9.9:443", SMOKE_INTERNET_PROBE: "1.1.1.1:443" }, { ...deps(w), log: (line) => { out.push(line); } });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("value-of-self-token-9f");
    expect(text).toContain("phase start: all checks passed");
  });
  it("does nothing without --run and ROVARA_STAGING_SMOKE=1 and a phase: no call, exit 2", async () => {
    const w = healthy();
    for (const [argv, env] of [[["start"], { ROVARA_STAGING_SMOKE: "1" }], [["--run"], { ROVARA_STAGING_SMOKE: "1" }], [["--run", "start"], {}], [["--run", "start"], { ROVARA_STAGING_SMOKE: "true" }], [["--run", "nonsense"], { ROVARA_STAGING_SMOKE: "1" }]] as const) {
      expect(await main(argv, env, deps(w)), JSON.stringify(argv)).toBe(2);
    }
    expect(w.calls).toEqual([]);
    expect(w.fetches).toEqual([]);
  });
  it("exits 1 when a check fails", async () => {
    const w = healthy();
    w.selfcheck = { ...(w.selfcheck as object), internet: "connected" };
    const env = { ROVARA_STAGING_SMOKE: "1", MCP_HOST_URL: config.hostUrl, MCP_HOST_TOKEN: TOKEN, SMOKE_SERVER_ID: SERVER, SMOKE_ENV: "staging", SMOKE_CLUSTER: config.cluster, SMOKE_CONTROLLER_SERVICE: config.controllerService, SMOKE_RUNNER_SUBNETS: config.runnerSubnets.join(","), SMOKE_INSTALL_SECURITY_GROUP: config.installSecurityGroup, SMOKE_APPROVED: "a.b:443", SMOKE_VPC_PROBE: "10.0.0.9:443", SMOKE_INTERNET_PROBE: "1.1.1.1:443" };
    expect(await main(["--run", "start"], env, deps(w))).toBe(1);
  });
  it("sends every AWS call through the staging guard as `aws ...`, with no profile, region or direct aws", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const fake = ((file: string, args: string[]) => {
      calls.push({ file, args });
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      const child = { stdout: { on: (event: string, fn: (chunk: Buffer) => void) => { if (event === "data") queueMicrotask(() => fn(Buffer.from("{}"))); } }, on: (event: string, fn: (...a: unknown[]) => void) => { (handlers[event] ??= []).push(fn); if (event === "close") queueMicrotask(() => queueMicrotask(() => fn(0))); } };
      return child;
    }) as unknown as typeof spawn;
    const aws = guardedAws("/home/x/.local/share/rovara-tools/staging-aws.sh", fake);
    await aws(["ecs", "list-tasks", "--cluster", "c"]);
    expect(calls).toEqual([{ file: "/home/x/.local/share/rovara-tools/staging-aws.sh", args: ["aws", "ecs", "list-tasks", "--cluster", "c"] }]);
    const source = await code();
    expect(source).not.toMatch(/spawn\("aws"|AWS_PROFILE|--profile|--region|get-secret-value|batch-get-secret-value/u);
    expect(source).toContain("staging-aws.sh");
  });
  const smokeEnv = { ROVARA_STAGING_SMOKE: "1", MCP_HOST_URL: config.hostUrl, MCP_HOST_TOKEN: TOKEN, SMOKE_SERVER_ID: SERVER, SMOKE_ENV: "staging", SMOKE_CLUSTER: config.cluster, SMOKE_CONTROLLER_SERVICE: config.controllerService, SMOKE_RUNNER_SUBNETS: config.runnerSubnets.join(","), SMOKE_INSTALL_SECURITY_GROUP: config.installSecurityGroup, SMOKE_DECLARED_ENV: "SELF_TOKEN", SMOKE_APPROVED: "fixture.staging.internal:443", SMOKE_VPC_PROBE: "10.42.9.9:443", SMOKE_INTERNET_PROBE: "1.1.1.1:443" };
  it("review M5: its first step asks which account is signed in and where the cluster is, and passes only for the staging account and a cluster in staging's region", async () => {
    const w = healthy();
    const ok = await checkStagingTarget(config, deps(w));
    expect(ok.every((check) => check.ok)).toBe(true);
    expect(w.calls.map((call) => call.slice(0, 2).join(" "))).toEqual(["sts get-caller-identity", "ecs describe-clusters", "ssm get-parameter"]);
    expect(STAGING_ACCOUNT).toBe("944937319445");
  });
  it("review M5: refuses to run any phase, with no host call and no other AWS call, when the account is not staging or the cluster is in another account or region", async () => {
    const wrong: Array<[string, (w: World) => void]> = [
      ["another account", (w) => { w.account = "111111111111"; }],
      ["an empty answer", (w) => { w.account = ""; }],
      ["the account with more after it", (w) => { w.account = "944937319445 111111111111"; }],
      ["a cluster in another account", (w) => { w.clusterArn = "arn:aws:ecs:us-west-2:111111111111:cluster/rovara-mcp-test"; }],
      ["a cluster in another region", (w) => { w.clusterArn = "arn:aws:ecs:us-east-1:944937319445:cluster/rovara-mcp-test"; }],
      ["another cluster", (w) => { w.clusterArn = "arn:aws:ecs:us-west-2:944937319445:cluster/other"; }],
      ["no such cluster", (w) => { w.clusterArn = "None"; }],
      ["a cluster that only ends the same way", (w) => { w.clusterArn = "arn:aws:ecs:us-west-2:944937319445:cluster/x/rovara-mcp-test"; }],
    ];
    for (const [label, change] of wrong) {
      const w = healthy();
      change(w);
      const out: string[] = [];
      expect(await main(["--run", "start"], smokeEnv, { ...deps(w), log: (line) => { out.push(line); } }), label).toBe(1);
      expect(w.fetches, label).toEqual([]);
      expect(w.calls.every((call) => (call[0] === "sts" && call[1] === "get-caller-identity") || (call[0] === "ecs" && call[1] === "describe-clusters") || (call[0] === "ssm" && call[1] === "get-parameter")), label).toBe(true);
      expect(out.join("\n"), label).toContain("FAIL");
      expect(out.join("\n"), label).not.toContain(TOKEN);
    }
    for (const failing of ["sts", "describe-clusters"]) {
      const w = healthy();
      w.failAws = (args) => args.includes(failing) || args[0] === failing;
      expect(await main(["--run", "start"], smokeEnv, deps(w)), failing).toBe(1);
      expect(w.fetches, failing).toEqual([]);
    }
  });
  it("review N2: the host the token is sent to must be the MCP host staging recorded for itself; any other address is refused before any phase, and the token is never sent", async () => {
    const wrongHosts = ["https://mcp-host.prod.example.net", "https://evil.example.net", "https://mcp-host.staging.example.net.evil.example", "https://sub.mcp-host.staging.example.net"];
    for (const hostUrl of wrongHosts) {
      const w = healthy();
      const out: string[] = [];
      expect(await main(["--run", "start"], { ...smokeEnv, MCP_HOST_URL: hostUrl }, { ...deps(w), log: (line) => { out.push(line); } }), hostUrl).toBe(1);
      expect(w.fetches, hostUrl).toEqual([]);
      expect(out.join("\n"), hostUrl).toContain("host");
      expect(out.join("\n")).not.toContain(TOKEN);
    }
    // the recorded name is read from the install's own settings through the guard, with the environment the operator names
    const w = healthy();
    expect(await main(["--run", "start"], smokeEnv, deps(w))).toBe(0);
    expect(w.calls.find((call) => call[0] === "ssm")).toEqual(["ssm", "get-parameter", "--name", "/agentx/staging/synth-settings", "--query", "Parameter.Value", "--output", "text"]);
  });
  it("review N2: refuses when staging recorded no host, the settings cannot be read or do not parse, or the environment name is not a plain name", async () => {
    for (const [label, change] of [
      ["no host recorded", (w: World) => { w.settingsValue = JSON.stringify({ context: {} }); }],
      ["not JSON", (w: World) => { w.settingsValue = "nonsense"; }],
      ["a host that is not a string", (w: World) => { w.settingsValue = JSON.stringify({ context: { rovaraMcpHostName: 5 } }); }],
      ["the read fails", (w: World) => { w.failAws = (args) => args[0] === "ssm"; }],
      ["the same host in another case is fine but a prefix is not", (w: World) => { w.recordedHost = "mcp-host.staging.example.ne"; }],
    ] as const) {
      const w = healthy();
      change(w);
      expect(await main(["--run", "start"], smokeEnv, deps(w)), label).toBe(1);
      expect(w.fetches, label).toEqual([]);
    }
    const upper = healthy();
    upper.recordedHost = "MCP-Host.Staging.Example.Net";
    expect(await main(["--run", "start"], smokeEnv, deps(upper))).toBe(0);
    for (const environment of ["", "../x", "a b", "Staging", "x".repeat(40)]) {
      const w = healthy();
      await expect(main(["--run", "start"], { ...smokeEnv, SMOKE_ENV: environment }, deps(w)), environment).rejects.toThrow();
      expect(w.calls).toEqual([]);
    }
  });
  it("review M5: a real run always uses the staging guard in the owner's tools folder: no environment variable replaces it", async () => {
    const source = await code();
    expect(source).not.toContain("ROVARA_STAGING_AWS");
    expect(STAGING_GUARD_PATH).toBe(join(homedir(), ".local/share/rovara-tools/staging-aws.sh"));
    expect(source).toMatch(/guardedAws\(STAGING_GUARD_PATH\)/u);
  });
  it("never reads the host's token from AWS: it comes from the environment only", async () => {
    const source = await code();
    expect(source).toContain('need("MCP_HOST_TOKEN")');
    expect(source).not.toContain("secretsmanager");
  });
});

describe("T12 smoke: the test-only selfcheck server", () => {
  const entry = join(import.meta.dirname, "..", "..", "staging", "selfcheck-mcp", "bin", "selfcheck.mjs");
  function talk(messages: unknown[], env: Record<string, string> = {}): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", reject);
      child.on("close", () => resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)));
      for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.end();
    });
  }
  const call = (args: Record<string, unknown>, env?: Record<string, string>) => talk([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "selfcheck", arguments: args } }], env)
    .then(([reply]) => JSON.parse(((reply!.result as { content: Array<{ text: string }> }).content[0]!).text) as Record<string, unknown>);

  it("is a package of its own with one program, a bin, no dependencies and no install steps", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "..", "..", "staging", "selfcheck-mcp", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: "@rovara-test/selfcheck-mcp", version: "1.0.0", type: "module", bin: { "selfcheck-mcp": "bin/selfcheck.mjs" } });
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "scripts", "gypfile"]) expect(manifest, field).not.toHaveProperty(field);
  });
  it("speaks enough MCP for the bridge and lists its one read-only tool", async () => {
    const replies = await talk([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toMatchObject({ id: 2, result: { tools: [{ name: "selfcheck", annotations: { readOnlyHint: true } }] } });
  });
  it("does nothing but list its plan unless the call says live: true", async () => {
    const report = await call({});
    expect(report).toEqual({ live: false, plan: ["credentials", "internet", "vpc", "approved", "environment"] });
  });
  it("live, tells which addresses answer, whether the metadata endpoint gives credentials, and the NAMES of its environment (never a value)", async () => {
    const { createServer } = await import("node:net");
    const listening = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const open = (listening.address() as { port: number }).port;
    const closed = await new Promise<number>((resolve) => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)); }); });
    try {
      const report = await call({ live: true, timeoutMs: 300, approved: { host: "127.0.0.1", port: open }, vpc: { host: "127.0.0.1", port: closed }, internet: { host: "not-an-address", port: 1 } }, { SELF_TOKEN: "value-of-self-token-9f" });
      expect(report.approved).toBe("connected");
      expect(report.vpc).toBe("refused");
      expect(report.internet).toBe("error");
      expect((report.credentials as { uriVariable: boolean; metadataStatus: unknown }).uriVariable).toBe(false);
      expect((report.credentials as { metadataStatus: unknown }).metadataStatus).not.toBe(200);
      expect(report.environment).toContain("SELF_TOKEN");
      expect(JSON.stringify(report)).not.toContain("value-of-self-token-9f");
    } finally {
      listening.close();
    }
  });
  it("says whether the credentials variable is set, without saying its value", async () => {
    const report = await call({ live: true, timeoutMs: 200 }, { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc" });
    expect((report.credentials as { uriVariable: boolean }).uriVariable).toBe(true);
    expect(JSON.stringify(report)).not.toContain("/v2/credentials/abc");
    expect(report.approved).toBe("not-asked");
  });
  it("bounds its own waits: a timeout asked for beyond 15 seconds, or not a whole number, is taken as 5 seconds", async () => {
    const source = await readFile(entry, "utf8");
    expect(source).toContain("args.timeoutMs <= 15_000 ? args.timeoutMs : 5_000");
  });
});
