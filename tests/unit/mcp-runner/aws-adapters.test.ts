// Stdio MCP host redesign, task T6: the adapters from the real AWS clients to the gateway's narrow interfaces, with fake SDK classes (nothing here reaches AWS).
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { bundleObjectApiFromS3, ecsApiFromSdk, type EcsSdk } from "../../../packages/broker/src/mcp-host/aws-adapters.js";

function fakeSdk(responses: Record<string, (input: Record<string, unknown>) => unknown>) {
  const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
  const make = (name: string) => Object.defineProperty(class { constructor(readonly input: Record<string, unknown>) {} }, "name", { value: name });
  const classes = { RunTaskCommand: make("RunTaskCommand"), StopTaskCommand: make("StopTaskCommand"), DescribeTasksCommand: make("DescribeTasksCommand"), ListTasksCommand: make("ListTasksCommand") };
  const sdk = {
    ...classes,
    ECSClient: class { async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> { sent.push({ command: command.constructor.name, input: command.input }); return responses[command.constructor.name]?.(command.input) ?? {}; } },
  } as unknown as EcsSdk;
  return { sdk, sent, client: new sdk.ECSClient({}) };
}

describe("ECS adapter", () => {
  it("runs a task and counts what ECS reports as failures", async () => {
    const { sdk, client, sent } = fakeSdk({ RunTaskCommand: () => ({ tasks: [{ taskArn: "arn:one" }, {}], failures: [{ reason: "x" }] }) });
    const result = await ecsApiFromSdk(sdk, client).runTask({ cluster: "c", taskDefinition: "f", count: 1, launchType: "FARGATE", startedBy: "s", enableExecuteCommand: false, networkConfiguration: { awsvpcConfiguration: { subnets: ["s"], securityGroups: ["g"], assignPublicIp: "DISABLED" } }, overrides: { containerOverrides: [] }, tags: [] });
    expect(result).toEqual({ taskArns: ["arn:one"], failureCount: 1 });
    expect(sent[0]!.input).toMatchObject({ enableExecuteCommand: false, count: 1 });
  });
  it("stops a task with a reason of at most 250 characters", async () => {
    const { sdk, client, sent } = fakeSdk({});
    await ecsApiFromSdk(sdk, client).stopTask({ cluster: "c", taskArn: "arn:one", reason: "r".repeat(400) });
    expect(sent[0]).toEqual({ command: "StopTaskCommand", input: { cluster: "c", task: "arn:one", reason: "r".repeat(250) } });
  });
  it("describes tasks with their tags, address and exit codes", async () => {
    const { sdk, client, sent } = fakeSdk({ DescribeTasksCommand: () => ({ tasks: [{
      taskArn: "arn:one", lastStatus: "STOPPED", createdAt: new Date(1), tags: [{ key: "a", value: "b" }, { key: "no-value" }],
      attachments: [{ type: "Other", details: [{ name: "privateIPv4Address", value: "9.9.9.9" }] }, { type: "ElasticNetworkInterface", details: [{ name: "subnetId", value: "subnet-1" }, { name: "privateIPv4Address", value: "10.0.0.5" }] }],
      containers: [{ name: "fetch", exitCode: 0 }, { name: "server", exitCode: 1 }, { exitCode: 3 }],
    }] }) });
    const [task] = await ecsApiFromSdk(sdk, client).describeTasks({ cluster: "c", taskArns: ["arn:one"] });
    expect(task).toMatchObject({ taskArn: "arn:one", lastStatus: "STOPPED", tags: [{ key: "a", value: "b" }], privateIpv4: "10.0.0.5", exitCodes: { fetch: 0, server: 1 } });
    expect(sent[0]!.input).toMatchObject({ include: ["TAGS"] });
  });
  it("follows the list pages, and refuses a list that has more pages than a controller should ever see", async () => {
    let page = 0;
    const paged = fakeSdk({ ListTasksCommand: () => { page += 1; return { taskArns: [`arn:${page}`], nextToken: page < 3 ? `t${page}` : undefined }; } });
    expect(await ecsApiFromSdk(paged.sdk, paged.client).listTaskArns({ cluster: "c", startedBy: "s" })).toEqual(["arn:1", "arn:2", "arn:3"]);
    expect(paged.sent.map((call) => call.input)).toEqual([
      { cluster: "c", startedBy: "s", desiredStatus: "RUNNING" }, { cluster: "c", startedBy: "s", desiredStatus: "RUNNING", nextToken: "t1" }, { cluster: "c", startedBy: "s", desiredStatus: "RUNNING", nextToken: "t2" },
    ]);
    const endless = fakeSdk({ ListTasksCommand: () => ({ taskArns: ["arn:x"], nextToken: "more" }) });
    await expect(ecsApiFromSdk(endless.sdk, endless.client).listTaskArns({ cluster: "c", startedBy: "s" })).rejects.toThrow("too many");
    expect(endless.sent).toHaveLength(20);
  });
});

describe("bundle bucket adapter", () => {
  const client = (handlers: Record<string, (input: Record<string, unknown>) => unknown>) => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    return { sent, client: { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => { sent.push({ name: command.constructor.name, input: command.input }); const handler = handlers[command.constructor.name]; if (handler === undefined) return {}; return handler(command.input); } } as never };
  };
  it("puts with the length and the bucket, and gets the body", async () => {
    const fake = client({ GetObjectCommand: () => ({ Body: Readable.from(Buffer.from("x")), ContentLength: 1 }) });
    const api = bundleObjectApiFromS3(fake.client, "bucket");
    await api.put({ key: "bundles/a", body: Readable.from(Buffer.from("x")), size: 1 });
    expect(fake.sent[0]).toMatchObject({ name: "PutObjectCommand", input: { Bucket: "bucket", Key: "bundles/a", ContentLength: 1 } });
    expect((await api.get("bundles/a"))?.size).toBe(1);
  });
  it("takes a missing object as missing and any other error as an error", async () => {
    const missing = bundleObjectApiFromS3(client({ GetObjectCommand: () => { throw Object.assign(new Error("m"), { name: "NoSuchKey" }); }, HeadObjectCommand: () => { throw Object.assign(new Error("m"), { name: "NotFound" }); } }).client, "bucket");
    expect(await missing.get("k")).toBeUndefined();
    expect(await missing.head("k")).toBe(false);
    const denied = bundleObjectApiFromS3(client({ GetObjectCommand: () => { throw Object.assign(new Error("d"), { name: "AccessDenied" }); }, HeadObjectCommand: () => { throw Object.assign(new Error("d"), { name: "Forbidden" }); } }).client, "bucket");
    await expect(denied.get("k")).rejects.toThrow("d");
    await expect(denied.head("k")).rejects.toThrow("d");
    expect(await bundleObjectApiFromS3(client({}).client, "bucket").head("k")).toBe(true);
  });
});
