// Stdio MCP host redesign, task T6: the ECS runner. Whatever the controller asks, a task is started only in the runner subnets with no public address, in a `rovara-mcp-` family, with
// only environment overrides, and is tagged so it can be found again from the cloud's records.
import { describe, expect, it } from "vitest";
import { ECS_STARTED_BY, ECS_TAG, ecsTaskRunner, type EcsApi, type EcsRunTaskInput, type EcsTaskDescription } from "../../../packages/gateway/src/mcp-runner/ecs-runner.js";
import type { RunnerTaskSpec } from "../../../packages/gateway/src/mcp-runner/task-runner.js";

const ARN = (id: string) => `arn:aws:ecs:us-east-1:111111111111:task/rovara-mcp/${id.padEnd(32, "0")}`;
const SUBNETS = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"];
const DEFAULT_SG = "sg-0cccccccccccccccc";
const OWN_SG = "sg-0dddddddddddddddd";

function fakeApi(over: Partial<EcsApi> = {}) {
  const runs: EcsRunTaskInput[] = [];
  const stops: Array<{ cluster: string; taskArn: string; reason: string }> = [];
  const described: EcsTaskDescription[] = [];
  const api: EcsApi = {
    runTask: async (input) => { runs.push(input); return { taskArns: [ARN("a1")], failureCount: 0 }; },
    stopTask: async (input) => { stops.push(input); },
    describeTasks: async ({ taskArns }) => described.filter((task) => taskArns.includes(task.taskArn)),
    listTaskArns: async () => described.map((task) => task.taskArn),
    ...over,
  };
  return { api, runs, stops, described };
}
const runnerOf = (api: EcsApi) => ecsTaskRunner({ api, cluster: "rovara-mcp", subnets: SUBNETS, defaultSecurityGroupId: DEFAULT_SG });
const spec = (over: Partial<RunnerTaskSpec> = {}): RunnerTaskSpec => ({
  purpose: "serve", serverId: "mcpsim000001", approval: "a".repeat(12), family: "rovara-mcp-serve-mcpsim000001", securityGroupId: OWN_SG, size: { cpu: 256, memoryMiB: 512 },
  containers: { fetch: { MCP_RUNNER_TOKEN: "t".repeat(43), MCP_BUNDLE_HASH: "b".repeat(64) }, server: { MCP_RUNNER_TOKEN: "t".repeat(43), PORT: "8080" } }, ...over,
});
const described = (over: Partial<EcsTaskDescription> = {}): EcsTaskDescription => ({
  taskArn: ARN("a1"), lastStatus: "RUNNING", createdAt: new Date(1_000), startedAt: new Date(2_000), privateIpv4: "10.0.3.7",
  tags: [{ key: ECS_TAG.server, value: "mcpsim000001" }, { key: ECS_TAG.purpose, value: "serve" }, { key: ECS_TAG.approval, value: "a".repeat(12) }, { key: ECS_TAG.family, value: "rovara-mcp-serve-mcpsim000001" }], ...over,
});

describe("ECS runner: start", () => {
  it("starts exactly one Fargate task in the runner subnets with no public address, no shell, the server's own security group, tags and only environment overrides", async () => {
    const { api, runs } = fakeApi();
    expect(await runnerOf(api).start(spec())).toBe(ARN("a1"));
    expect(runs).toEqual([{
      cluster: "rovara-mcp", taskDefinition: "rovara-mcp-serve-mcpsim000001", count: 1, launchType: "FARGATE", startedBy: ECS_STARTED_BY, enableExecuteCommand: false,
      networkConfiguration: { awsvpcConfiguration: { subnets: SUBNETS, securityGroups: [OWN_SG], assignPublicIp: "DISABLED" } },
      overrides: { containerOverrides: [
        { name: "fetch", environment: [{ name: "MCP_RUNNER_TOKEN", value: "t".repeat(43) }, { name: "MCP_BUNDLE_HASH", value: "b".repeat(64) }] },
        { name: "server", environment: [{ name: "MCP_RUNNER_TOKEN", value: "t".repeat(43) }, { name: "PORT", value: "8080" }] },
      ] },
      tags: [{ key: ECS_TAG.server, value: "mcpsim000001" }, { key: ECS_TAG.purpose, value: "serve" }, { key: ECS_TAG.approval, value: "a".repeat(12) }, { key: ECS_TAG.family, value: "rovara-mcp-serve-mcpsim000001" }],
    }]);
    expect(Object.keys(runs[0]!.overrides)).toEqual(["containerOverrides"]);
    expect(Object.keys(runs[0]!.overrides.containerOverrides[0]!).sort()).toEqual(["environment", "name"]);
  });
  it("uses the default security group for a task with none of its own", async () => {
    const { api, runs } = fakeApi();
    await runnerOf(api).start(spec({ purpose: "install", serverId: "install", approval: "", family: "rovara-mcp-install", securityGroupId: undefined }));
    expect(runs[0]!.networkConfiguration.awsvpcConfiguration.securityGroups).toEqual([DEFAULT_SG]);
  });
  it("never starts a serve or probe task in the default group (the install task's): it needs the group made for its server", async () => {
    const { api, runs } = fakeApi();
    const runner = runnerOf(api);
    await expect(runner.start(spec({ securityGroupId: undefined }))).rejects.toThrow(/own security group/u);
    await expect(runner.start(spec({ purpose: "probe", serverId: "probe0123456789", family: "rovara-mcp-probe-probe0123456789", securityGroupId: undefined }))).rejects.toThrow(/own security group/u);
    expect(runs).toEqual([]);
  });
  it("refuses a family that is not rovara-mcp-, tags that are not valid, a security group that is not one, and environment that is not valid, before calling ECS", async () => {
    const { api, runs } = fakeApi();
    const runner = runnerOf(api);
    const bad: Array<Partial<RunnerTaskSpec>> = [
      { family: "other-family" }, { family: "rovara-mcp-" }, { family: "rovara-mcp-a b" }, { family: "rovara-mcp-x:1" }, { family: "rovara-mcpx-serve" },
      { serverId: "evil" }, { serverId: "mcp" }, { serverId: "install2" }, { approval: "xyz" }, { approval: "a".repeat(13) }, { purpose: "shell" as never },
      { securityGroupId: "sg-1" }, { securityGroupId: "default" },
      { containers: { "Bad Name": {} } }, { containers: { server: { lower: "x" } } }, { containers: { server: { PATH: "x", "A B": "y" } } }, { containers: { server: { MCP_X: "x".repeat(8_193) } } },
      { containers: { server: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`MCP_VAR_${index}`, "x"])) } },
    ];
    for (const over of bad) await expect(runner.start(spec(over)), JSON.stringify(over)).rejects.toThrow();
    expect(runs).toEqual([]);
  });
  it("throws, and stops anything that did start, when ECS did not start exactly one task", async () => {
    for (const result of [{ taskArns: [], failureCount: 1 }, { taskArns: [ARN("a1")], failureCount: 1 }, { taskArns: [ARN("a1"), ARN("a2")], failureCount: 0 }, { taskArns: ["not-an-arn"], failureCount: 0 }]) {
      const { api, stops } = fakeApi({ runTask: async () => result });
      await expect(runnerOf(api).start(spec()), JSON.stringify(result)).rejects.toThrow("did not start");
      expect(stops.map((stop) => stop.taskArn).sort(), JSON.stringify(result)).toEqual(result.taskArns.slice().sort());
    }
  });
  it("is built only with subnets and a security group that are real", () => {
    const { api } = fakeApi();
    for (const subnets of [[], ["x"], Array.from({ length: 17 }, () => SUBNETS[0]!)]) expect(() => ecsTaskRunner({ api, cluster: "c", subnets, defaultSecurityGroupId: DEFAULT_SG })).toThrow();
    expect(() => ecsTaskRunner({ api, cluster: "c", subnets: SUBNETS, defaultSecurityGroupId: "bad" })).toThrow();
  });
});

describe("ECS runner: stop and describe", () => {
  it("stops a task with the reason, and takes a task that is already gone as stopped", async () => {
    const { api, stops } = fakeApi();
    await runnerOf(api).stop(ARN("a1"), "idle");
    expect(stops).toEqual([{ cluster: "rovara-mcp", taskArn: ARN("a1"), reason: "idle" }]);
    for (const name of ["InvalidParameterException", "ResourceNotFoundException"]) {
      await expect(runnerOf(fakeApi({ stopTask: async () => { throw Object.assign(new Error("gone"), { name }); } }).api).stop(ARN("a1"), "idle")).resolves.toBeUndefined();
    }
    await expect(runnerOf(fakeApi({ stopTask: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } }).api).stop(ARN("a1"), "idle")).rejects.toThrow("denied");
    await expect(runnerOf(api).stop("not-an-arn", "idle")).rejects.toThrow();
  });
  it("maps ECS states, and gives the bridge's address only for a running task with a plain IPv4 address", async () => {
    const { api, described: tasks } = fakeApi();
    const runner = runnerOf(api);
    tasks.push(described());
    expect(await runner.describe(ARN("a1"))).toEqual({ state: "running", endpoint: "http://10.0.3.7:8080" });
    for (const lastStatus of ["PROVISIONING", "PENDING", "ACTIVATING"]) { tasks[0] = described({ lastStatus }); expect(await runner.describe(ARN("a1")), lastStatus).toEqual({ state: "pending" }); }
    for (const lastStatus of ["DEACTIVATING", "STOPPING", "DEPROVISIONING", "STOPPED"]) { tasks[0] = described({ lastStatus }); expect((await runner.describe(ARN("a1")))?.state, lastStatus).toBe("stopped"); }
    tasks[0] = described({ lastStatus: "STOPPED", exitCodes: { fetch: 0, server: 137 } });
    expect(await runner.describe(ARN("a1"))).toEqual({ state: "stopped", exitCode: 137 });
    for (const privateIpv4 of [undefined, "300.1.1.1", "10.0.0.1:8080", "evil.example", "10.0.0.1/../x", "::1"]) { tasks[0] = described({ privateIpv4 }); expect(await runner.describe(ARN("a1")), String(privateIpv4)).toEqual({ state: "running" }); }
  });
  it("does not even ask ECS about an id that is not a task ARN", async () => {
    let asked = 0;
    const { api } = fakeApi({ describeTasks: async () => { asked += 1; return [described()]; } });
    expect(await runnerOf(api).describe("not-an-arn")).toBeUndefined();
    expect(asked).toBe(0);
  });
  it("does not know a task that is not one of this feature's (no tags, wrong purpose, a family outside rovara-mcp-) or an id that is not a task", async () => {
    const { api, described: tasks } = fakeApi();
    const runner = runnerOf(api);
    tasks.push(described({ tags: [] }));
    expect(await runner.describe(ARN("a1"))).toBeUndefined();
    tasks[0] = described({ tags: described().tags.map((tag) => (tag.key === ECS_TAG.purpose ? { ...tag, value: "shell" } : tag)) });
    expect(await runner.describe(ARN("a1"))).toBeUndefined();
    tasks[0] = described({ tags: described().tags.map((tag) => (tag.key === ECS_TAG.family ? { ...tag, value: "controller" } : tag)) });
    expect(await runner.describe(ARN("a1"))).toBeUndefined();
    expect(await runner.describe("nope")).toBeUndefined();
    expect(await runner.describe(ARN("zz"))).toBeUndefined();
  });
});

describe("ECS runner: list", () => {
  it("lists the controller's tasks that are not stopped, with their tags and times, and none of the others", async () => {
    const { api, described: tasks } = fakeApi();
    tasks.push(
      described(), described({ taskArn: ARN("a2"), lastStatus: "PENDING", startedAt: undefined, createdAt: new Date(5_000) }), described({ taskArn: ARN("a3"), lastStatus: "STOPPED" }),
      described({ taskArn: ARN("a4"), tags: [] }), described({ taskArn: ARN("a5"), tags: [{ key: ECS_TAG.purpose, value: "serve" }] }),
    );
    expect(await runnerOf(api).list()).toEqual([
      { taskId: ARN("a1"), purpose: "serve", serverId: "mcpsim000001", approval: "a".repeat(12), family: "rovara-mcp-serve-mcpsim000001", startedAt: 2_000, state: "running" },
      { taskId: ARN("a2"), purpose: "serve", serverId: "mcpsim000001", approval: "a".repeat(12), family: "rovara-mcp-serve-mcpsim000001", startedAt: 5_000, state: "pending" },
    ]);
  });
  it("asks only for the tasks this controller started, and describes them 100 at a time", async () => {
    const asked: Array<{ cluster: string; startedBy: string }> = [];
    const batches: number[] = [];
    const arns = Array.from({ length: 230 }, (_, index) => ARN(`b${index}`));
    const { api } = fakeApi({ listTaskArns: async (input) => { asked.push(input); return arns; }, describeTasks: async ({ taskArns }) => { batches.push(taskArns.length); return []; } });
    await runnerOf(api).list();
    expect(asked).toEqual([{ cluster: "rovara-mcp", startedBy: ECS_STARTED_BY }]);
    expect(batches).toEqual([100, 100, 30]);
  });
  it("lets a failing list fail, so nothing is judged a leftover from a list that could not be read", async () => {
    await expect(runnerOf(fakeApi({ listTaskArns: async () => { throw new Error("throttled"); } }).api).list()).rejects.toThrow("throttled");
  });
});
