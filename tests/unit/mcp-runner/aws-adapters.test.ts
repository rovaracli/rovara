// Stdio MCP host redesign, task T6: the adapters from the real AWS clients to the gateway's narrow interfaces, with fake SDK classes (nothing here reaches AWS).
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { secretArnResolver, bundleObjectApiFromS3, ec2GroupApiFromSdk, ecsApiFromSdk, ecsDefinitionApiFromSdk, type EcsSdk } from "../../../packages/broker/src/mcp-host/aws-adapters.js";

function fakeSdk(responses: Record<string, (input: Record<string, unknown>) => unknown>) {
  const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
  const make = (name: string) => Object.defineProperty(class { constructor(readonly input: Record<string, unknown>) {} }, "name", { value: name });
  const classes = Object.fromEntries(["RunTask", "StopTask", "DescribeTasks", "ListTasks", "RegisterTaskDefinition", "DeregisterTaskDefinition", "DescribeTaskDefinition", "ListTaskDefinitions", "ListTaskDefinitionFamilies"].map((name) => [`${name}Command`, make(`${name}Command`)]));
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
    expect(await ecsApiFromSdk(paged.sdk, paged.client).listTaskArns({ cluster: "c" })).toEqual(["arn:1", "arn:2", "arn:3"]);
    expect(paged.sent.map((call) => call.input)).toEqual([
      { cluster: "c", desiredStatus: "RUNNING" }, { cluster: "c", desiredStatus: "RUNNING", nextToken: "t1" }, { cluster: "c", desiredStatus: "RUNNING", nextToken: "t2" },
    ]);
    const endless = fakeSdk({ ListTasksCommand: () => ({ taskArns: ["arn:x"], nextToken: "more" }) });
    await expect(ecsApiFromSdk(endless.sdk, endless.client).listTaskArns({ cluster: "c" })).rejects.toThrow("too many");
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


describe("ECS task definition adapter (T7)", () => {
  const FAMILY = "rovara-mcp-serve-mcpsim000001";
  const arn = (family: string, revision: number) => `arn:aws:ecs:us-east-1:111111111111:task-definition/${family}:${revision}`;
  it("finds the newest revision of exactly this family (a family that starts the same is not it) and returns the definition as ECS describes it", async () => {
    const { sdk, client, sent } = fakeSdk({
      ListTaskDefinitionsCommand: () => ({ taskDefinitionArns: [arn(`${FAMILY}x`, 9), arn(FAMILY, 3), arn(FAMILY, 2)] }),
      DescribeTaskDefinitionCommand: () => ({ taskDefinition: { family: FAMILY, revision: 3 } }),
    });
    expect(await ecsDefinitionApiFromSdk(sdk, client).latestRevision(FAMILY)).toEqual({ arn: arn(FAMILY, 3), definition: { family: FAMILY, revision: 3 } });
    expect(sent[0]).toMatchObject({ command: "ListTaskDefinitionsCommand", input: { familyPrefix: FAMILY, status: "ACTIVE", sort: "DESC" } });
    expect(sent[1]).toMatchObject({ command: "DescribeTaskDefinitionCommand", input: { taskDefinition: arn(FAMILY, 3) } });
  });
  it("has no latest revision for a family with none", async () => {
    const { sdk, client } = fakeSdk({ ListTaskDefinitionsCommand: () => ({ taskDefinitionArns: [arn(`${FAMILY}x`, 1)] }) });
    expect(await ecsDefinitionApiFromSdk(sdk, client).latestRevision(FAMILY)).toBeUndefined();
  });
  it("registers a definition as given and returns its ARN, and fails when ECS gives none", async () => {
    const ok = fakeSdk({ RegisterTaskDefinitionCommand: () => ({ taskDefinition: { taskDefinitionArn: arn(FAMILY, 1) } }) });
    const definition = { family: FAMILY, networkMode: "awsvpc" } as never;
    expect(await ecsDefinitionApiFromSdk(ok.sdk, ok.client).register(definition)).toBe(arn(FAMILY, 1));
    expect(ok.sent[0]!.input).toMatchObject({ family: FAMILY, networkMode: "awsvpc" });
    expect(ok.sent[0]!.input).not.toHaveProperty("taskRoleArn");
    const none = fakeSdk({});
    await expect(ecsDefinitionApiFromSdk(none.sdk, none.client).register(definition)).rejects.toThrow();
  });
  it("deregisters every ACTIVE revision of the family and no other, and takes a revision that is already inactive as done", async () => {
    const { sdk, client, sent } = fakeSdk({ ListTaskDefinitionsCommand: () => ({ taskDefinitionArns: [arn(FAMILY, 2), arn(`${FAMILY}x`, 1), arn(FAMILY, 1)] }) });
    await ecsDefinitionApiFromSdk(sdk, client).deregisterAll(FAMILY);
    expect(sent.filter((call) => call.command === "DeregisterTaskDefinitionCommand").map((call) => call.input.taskDefinition)).toEqual([arn(FAMILY, 2), arn(FAMILY, 1)]);
    const inactive = fakeSdk({ ListTaskDefinitionsCommand: () => ({ taskDefinitionArns: [arn(FAMILY, 1)] }), DeregisterTaskDefinitionCommand: () => { throw Object.assign(new Error("inactive"), { name: "ClientException" }); } });
    await expect(ecsDefinitionApiFromSdk(inactive.sdk, inactive.client).deregisterAll(FAMILY)).resolves.toBeUndefined();
    const denied = fakeSdk({ ListTaskDefinitionsCommand: () => ({ taskDefinitionArns: [arn(FAMILY, 1)] }), DeregisterTaskDefinitionCommand: () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } });
    await expect(ecsDefinitionApiFromSdk(denied.sdk, denied.client).deregisterAll(FAMILY)).rejects.toThrow("denied");
  });
  it("review M2: IAM can only allow DeregisterTaskDefinition on \"*\" (no resource type), so the adapter itself never names a definition outside the controller's own families", async () => {
    const foreign = ["foundation-worker", "rovara-mcp", "rovara-mcpx-serve-a", "rovara-mcp-", "rovara-mcp-serve-a/../../worker", "rovara-mcp-serve-a.*", "rovara-mcp-serve a", "", "ROVARA-MCP-serve-a", `rovara-mcp-${"a".repeat(201)}`];
    for (const family of foreign) {
      const { sdk, client, sent } = fakeSdk({ ListTaskDefinitionsCommand: () => ({ taskDefinitionArns: [arn("foundation-worker", 1), arn(family, 1)] }), ListTaskDefinitionFamiliesCommand: () => ({ families: [family] }) });
      const api = ecsDefinitionApiFromSdk(sdk, client);
      await expect(api.deregisterAll(family), JSON.stringify(family)).rejects.toThrow(/not allowed/u);
      await expect(api.latestRevision(family), JSON.stringify(family)).rejects.toThrow(/not allowed/u);
      await expect(api.register({ family } as never), JSON.stringify(family)).rejects.toThrow(/not allowed/u);
      expect(sent, JSON.stringify(family)).toEqual([]);
    }
    for (const prefix of ["", "rovara", "rovara-mcp", "foundation-"]) {
      const { sdk, client, sent } = fakeSdk({});
      await expect(ecsDefinitionApiFromSdk(sdk, client).listFamilies(prefix), prefix).rejects.toThrow(/not allowed/u);
      expect(sent, prefix).toEqual([]);
    }
  });
  it("review M2: whatever the cloud lists, only revisions of the named own family are deregistered", async () => {
    const own = "rovara-mcp-probe-mcpnew000001";
    const { sdk, client, sent } = fakeSdk({ ListTaskDefinitionsCommand: () => ({ taskDefinitionArns: [arn("foundation-worker", 7), arn(own, 2), arn(`${own}-other`, 1), arn(own, 1), "arn:aws:ecs:us-east-1:111111111111:task-definition/rovara-mcp-probe-mcpnew000001"] }) });
    await ecsDefinitionApiFromSdk(sdk, client).deregisterAll(own);
    const deregistered = sent.filter((call) => call.command === "DeregisterTaskDefinitionCommand").map((call) => String(call.input.taskDefinition));
    expect(deregistered).toEqual([arn(own, 2), arn(own, 1)]);
    expect(deregistered.every((target) => /\/rovara-mcp-[A-Za-z0-9_-]+:\d+$/u.test(target))).toBe(true);
  });
  it("lists families by prefix, across pages, and refuses endless pages", async () => {
    let page = 0;
    const paged = fakeSdk({ ListTaskDefinitionFamiliesCommand: () => { page += 1; return { families: [`rovara-mcp-serve-a${page}`, `other-${page}`], nextToken: page < 2 ? "t" : undefined }; } });
    expect(await ecsDefinitionApiFromSdk(paged.sdk, paged.client).listFamilies("rovara-mcp-serve-")).toEqual(["rovara-mcp-serve-a1", "rovara-mcp-serve-a2"]);
    const endless = fakeSdk({ ListTaskDefinitionFamiliesCommand: () => ({ families: ["rovara-mcp-serve-a"], nextToken: "more" }) });
    await expect(ecsDefinitionApiFromSdk(endless.sdk, endless.client).listFamilies("rovara-mcp-serve-")).rejects.toThrow("too many");
    expect(endless.sent).toHaveLength(20);
    const arns = fakeSdk({ ListTaskDefinitionsCommand: () => ({ taskDefinitionArns: [arn(FAMILY, 1)], nextToken: "more" }) });
    await expect(ecsDefinitionApiFromSdk(arns.sdk, arns.client).latestRevision(FAMILY)).rejects.toThrow("too many");
  });
});

describe("EC2 security group adapter (T7)", () => {
  function ec2(responses: Record<string, (input: Record<string, any>) => unknown> = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const sent: Array<{ command: string; input: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, any> }) => { sent.push({ command: command.constructor.name, input: command.input }); return responses[command.constructor.name]?.(command.input) ?? {}; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { sent, api: ec2GroupApiFromSdk(client as never) };
  }
  it("creates a group in the VPC with its tags, and fails when EC2 gives no id", async () => {
    const ok = ec2({ CreateSecurityGroupCommand: () => ({ GroupId: "sg-0123456789abcdef0" }) });
    expect(await ok.api.createGroup({ name: "rovara-mcp-serve-x", description: "d", vpcId: "vpc-1", tags: { "rovara:server": "mcpx" } })).toBe("sg-0123456789abcdef0");
    expect(ok.sent[0]!.input).toMatchObject({ GroupName: "rovara-mcp-serve-x", VpcId: "vpc-1", TagSpecifications: [{ ResourceType: "security-group", Tags: [{ Key: "rovara:server", Value: "mcpx" }] }] });
    await expect(ec2().api.createGroup({ name: "n", description: "d", vpcId: "v", tags: {} })).rejects.toThrow();
  });
  it("finds groups by all of their tags and reads TCP single-port rules, counting any other rule as foreign", async () => {
    const { api, sent } = ec2({ DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [
      { GroupId: "sg-1", Tags: [{ Key: "a", Value: "b" }, { Key: "novalue" }], IpPermissionsEgress: [
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "10.1.2.3/32" }], UserIdGroupPairs: [{ GroupId: "sg-2" }], PrefixListIds: [{ PrefixListId: "pl-1" }] },
        { IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }, { IpProtocol: "tcp", FromPort: 1, ToPort: 1024, IpRanges: [{ CidrIp: "10.0.0.0/8" }] }, { IpProtocol: "tcp", FromPort: 443, ToPort: 443, Ipv6Ranges: [{ CidrIpv6: "::/0" }] },
      ], IpPermissions: [{ IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, UserIdGroupPairs: [{ GroupId: "sg-3" }] }] },
      { Tags: [] },
    ] }) });
    const [group, ...rest] = await api.describeGroups({ tags: { "rovara:managed": "rovara-mcp", "rovara:server": "mcpx" }, vpcId: "vpc-1", name: "rovara-mcp-serve-mcpx" });
    expect(rest).toEqual([]);
    expect(group).toEqual({
      groupId: "sg-1", tags: { a: "b" }, foreignRules: 3,
      egress: [{ port: 443, target: { kind: "cidr", cidr: "10.1.2.3/32" } }, { port: 443, target: { kind: "group", groupId: "sg-2" } }, { port: 443, target: { kind: "prefixList", prefixListId: "pl-1" } }],
      ingress: [{ port: 8080, target: { kind: "group", groupId: "sg-3" } }],
    });
    expect(sent[0]!.input.Filters).toEqual([{ Name: "tag:rovara:managed", Values: ["rovara-mcp"] }, { Name: "tag:rovara:server", Values: ["mcpx"] }, { Name: "vpc-id", Values: ["vpc-1"] }, { Name: "group-name", Values: ["rovara-mcp-serve-mcpx"] }]);
  });
  it("revokes both default 'all traffic out' rules of a new group, IPv4 and IPv6, and takes a rule that is not there as done", async () => {
    const { api, sent } = ec2();
    await api.revokeDefaultEgress("sg-1");
    expect(sent).toEqual([
      { command: "RevokeSecurityGroupEgressCommand", input: { GroupId: "sg-1", IpPermissions: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] } },
      { command: "RevokeSecurityGroupEgressCommand", input: { GroupId: "sg-1", IpPermissions: [{ IpProtocol: "-1", Ipv6Ranges: [{ CidrIpv6: "::/0" }] }] } },
    ]);
    const missing = ec2({ RevokeSecurityGroupEgressCommand: () => { throw Object.assign(new Error("none"), { name: "InvalidPermission.NotFound" }); } });
    await expect(missing.api.revokeDefaultEgress("sg-1")).resolves.toBeUndefined();
    expect(missing.sent).toHaveLength(2);
    const denied = ec2({ RevokeSecurityGroupEgressCommand: () => { throw Object.assign(new Error("denied"), { name: "UnauthorizedOperation" }); } });
    await expect(denied.api.revokeDefaultEgress("sg-1")).rejects.toThrow("denied");
  });
  it("authorizes and revokes TCP rules for one port in the right direction, for a host, a group and a prefix list", async () => {
    const { api, sent } = ec2();
    const rules = [{ port: 443, target: { kind: "cidr" as const, cidr: "10.1.2.3/32" } }, { port: 8443, target: { kind: "group" as const, groupId: "sg-2" } }, { port: 443, target: { kind: "prefixList" as const, prefixListId: "pl-1" } }];
    await api.authorize({ groupId: "sg-1", direction: "egress", rules });
    await api.authorize({ groupId: "sg-1", direction: "ingress", rules: [rules[1]!] });
    await api.revoke({ groupId: "sg-1", direction: "egress", rules: [rules[0]!] });
    await api.revoke({ groupId: "sg-1", direction: "ingress", rules: [rules[1]!] });
    expect(sent.map((call) => call.command)).toEqual(["AuthorizeSecurityGroupEgressCommand", "AuthorizeSecurityGroupIngressCommand", "RevokeSecurityGroupEgressCommand", "RevokeSecurityGroupIngressCommand"]);
    expect(sent[0]!.input.IpPermissions).toEqual([
      { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "10.1.2.3/32" }] }, { IpProtocol: "tcp", FromPort: 8443, ToPort: 8443, UserIdGroupPairs: [{ GroupId: "sg-2" }] },
      { IpProtocol: "tcp", FromPort: 443, ToPort: 443, PrefixListIds: [{ PrefixListId: "pl-1" }] },
    ]);
  });
  it("deletes a group by id and lets the error through (a group in use says so)", async () => {
    const { api, sent } = ec2();
    await api.deleteGroup("sg-1");
    expect(sent[0]).toEqual({ command: "DeleteSecurityGroupCommand", input: { GroupId: "sg-1" } });
    const busy = ec2({ DeleteSecurityGroupCommand: () => { throw Object.assign(new Error("in use"), { name: "DependencyViolation" }); } });
    await expect(busy.api.deleteGroup("sg-1")).rejects.toMatchObject({ name: "DependencyViolation" });
  });
});

describe("secret ARN resolver (fix round 1, m3)", () => {
  const ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:agentx/test/org-connectors/org_a/mcpsim000001-AbCdEf";
  it("looks up the full ARN of the server's secret by name once, and remembers it", async () => {
    const sent: unknown[] = [];
    const resolve = secretArnResolver({ send: async (command: { input: unknown }) => { sent.push(command.input); return { ARN }; } } as never, (serverId) => `agentx/test/org-connectors/org_a/${serverId}`);
    expect(await resolve("mcpsim000001")).toBe(ARN);
    expect(await resolve("mcpsim000001")).toBe(ARN);
    expect(sent).toEqual([{ SecretId: "agentx/test/org-connectors/org_a/mcpsim000001" }]);
  });
  it("has no ARN when the secret does not say one, and lets a failed lookup fail", async () => {
    expect(await secretArnResolver({ send: async () => ({}) } as never, (id) => id)("mcpsim000001")).toBeUndefined();
    await expect(secretArnResolver({ send: async () => { throw new Error("denied"); } } as never, (id) => id)("mcpsim000001")).rejects.toThrow("denied");
  });
});
