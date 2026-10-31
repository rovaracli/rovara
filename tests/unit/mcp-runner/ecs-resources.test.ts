// Stdio MCP host redesign, task T7: what the controller makes for each server. The task definition has exactly the shape the design promises (no task role, non-root, read-only root,
// every capability dropped, the bundle read-only in the server, the image pinned by digest); the security group holds only what the admin approved, as /32 addresses; nothing is
// left behind when something fails.
import { describe, expect, it } from "vitest";
import {
  MAX_EGRESS_RULES, buildRunnerTaskDefinition, definitionMatches, ecsServerResources, ruleKey, runnerGroupRules,
  type DescribedGroup, type Ec2GroupApi, type EcsDefinitionApi, type EcsResourcesConfig, type GroupRule, type ResolvedDestination, type RunnerTaskDefinition, type TaskDefinitionInput,
} from "../../../packages/gateway/src/mcp-runner/ecs-resources.js";

const IMAGE = `111111111111.dkr.ecr.us-east-1.amazonaws.com/rovara-mcp-runner@sha256:${"a".repeat(64)}`;
const ROLE = "arn:aws:iam::111111111111:role/rovara-mcp-execution";
const SECRET = "arn:aws:secretsmanager:us-east-1:111111111111:secret:agentx/test/org-connectors/org_aaaaaaaaaaaaaaaaaaaa/mcpsim000001-AbCdEf";
const ENDPOINTS = { endpointGroupIds: ["sg-0eeeeeeeeeeeeeeee", "sg-0ffffffffffffffff"], s3PrefixListId: "pl-0123456789abcdef0", controllerGroupId: "sg-0123456789abcdef0", controllerPort: 8443 };
const ID = "mcpsim000001";

const input = (over: Partial<TaskDefinitionInput> = {}): TaskDefinitionInput => ({
  family: `rovara-mcp-serve-${ID}`, image: IMAGE, executionRoleArn: ROLE, logGroup: "/rovara/mcp-runner", region: "us-east-1", size: { cpu: 256, memoryMiB: 512 }, secretRef: SECRET, secretEnv: ["JIRA_TOKEN", "API_KEY"],
  tags: { "rovara:server": ID }, ...over,
});

describe("runner task definition", () => {
  const definition = buildRunnerTaskDefinition(input());
  const fetch = definition.containerDefinitions.find((container) => container.name === "fetch")!;
  const server = definition.containerDefinitions.find((container) => container.name === "server")!;

  it("has NO task role, so nothing in the task has AWS credentials; only an execution role, and a Fargate ARM64 awsvpc task of the approved size", () => {
    expect(definition).not.toHaveProperty("taskRoleArn");
    expect(JSON.stringify(definition)).not.toMatch(/taskRole/iu);
    expect(definition).toMatchObject({ family: `rovara-mcp-serve-${ID}`, networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"], cpu: "256", memory: "512", executionRoleArn: ROLE, runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" } });
  });
  it("runs each container as its own non-root user, with a read-only root, every capability dropped and an init process", () => {
    expect(fetch).toMatchObject({ user: "10002:10002", readonlyRootFilesystem: true, linuxParameters: { capabilities: { drop: ["ALL"] }, initProcessEnabled: true }, essential: false });
    expect(server).toMatchObject({ user: "10003:10003", readonlyRootFilesystem: true, linuxParameters: { capabilities: { drop: ["ALL"] }, initProcessEnabled: true }, essential: true });
    for (const container of definition.containerDefinitions) { expect(container.user).not.toMatch(/^0(?::|$)/u); expect(container.image).toBe(IMAGE); }
  });
  it("gives the server the bundle read-only, its own home and temp folders, and waits for the fetch step to succeed", () => {
    expect(server.mountPoints).toEqual([{ sourceVolume: "bundle", containerPath: "/bundle", readOnly: true }, { sourceVolume: "home", containerPath: "/home/server", readOnly: false }, { sourceVolume: "tmp", containerPath: "/tmp", readOnly: false }]);
    expect(fetch.mountPoints).toEqual([{ sourceVolume: "bundle", containerPath: "/bundle", readOnly: false }]);
    expect(server.dependsOn).toEqual([{ containerName: "fetch", condition: "SUCCESS" }]);
    expect(definition.volumes.map((volume) => volume.name).sort()).toEqual(["bundle", "home", "tmp"]);
  });
  it("starts the runner's own programs, limits open files, and listens on the bridge's port only", () => {
    expect(fetch.command).toEqual(["/usr/local/bin/node", "/opt/mcp-runner/fetch.mjs"]);
    expect(server.command).toEqual(["/usr/local/bin/node", "/opt/mcp-runner/serve.mjs"]);
    expect(server.ulimits).toEqual([{ name: "nofile", softLimit: 1024, hardLimit: 1024 }]);
    expect(server.portMappings).toEqual([{ containerPort: 8080, protocol: "tcp" }]);
    expect(fetch.portMappings).toBeUndefined();
  });
  it("names the server's secrets as keys of its one secret and never holds a value; the fetch step gets none", () => {
    expect(server.secrets).toEqual([{ name: "JIRA_TOKEN", valueFrom: `${SECRET}:JIRA_TOKEN::` }, { name: "API_KEY", valueFrom: `${SECRET}:API_KEY::` }]);
    expect(fetch.secrets).toBeUndefined();
    expect(buildRunnerTaskDefinition(input({ secretEnv: [], secretRef: undefined })).containerDefinitions.every((container) => container.secrets === undefined)).toBe(true);
  });
  it("logs to the runner log group with a stream prefix per container, and tags the definition", () => {
    expect(server.logConfiguration).toEqual({ logDriver: "awslogs", options: { "awslogs-group": "/rovara/mcp-runner", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "server" } });
    expect(definition.tags).toEqual([{ key: "rovara:server", value: ID }]);
  });
  it("refuses an image that is not pinned by digest, a family outside rovara-mcp-, a role that is not a role, secrets it cannot name, and a size Fargate does not offer", () => {
    const bad: Array<Partial<TaskDefinitionInput>> = [
      { image: "x/rovara-mcp-runner:latest" }, { image: `x@sha256:${"a".repeat(63)}` }, { image: `x@sha256:${"A".repeat(64)}` }, { image: "" },
      { family: "other-serve" }, { family: "rovara-mcp-" }, { family: "rovara-mcp-a b" },
      { executionRoleArn: "arn:aws:iam::111111111111:user/me" }, { executionRoleArn: "role" },
      { secretRef: undefined }, { secretRef: "other/secret" }, { secretRef: "agentx/test/org-connectors/org_aaaaaaaaaaaaaaaaaaaa/mcpsim000001" }, { secretRef: SECRET.replace("-AbCdEf", "") }, { secretRef: SECRET.replace("agentx/", "other/") }, { secretRef: SECRET.replace("secretsmanager", "ssm") }, { secretRef: `${SECRET}:x` }, { secretRef: "agentx/../x" }, { secretRef: "agentx//x" },
      { secretEnv: ["lower"] }, { secretEnv: ["PATH;x"] }, { secretEnv: Array.from({ length: 9 }, (_, index) => `NAME_${index}`) },
      { size: { cpu: 2048, memoryMiB: 512 } }, { size: { cpu: 256, memoryMiB: 4096 } },
    ];
    for (const over of bad) expect(() => buildRunnerTaskDefinition(input(over)), JSON.stringify(over)).toThrow();
  });
});

/** A definition as ECS describes it back: the fields we set, plus the defaults ECS fills in. */
function describedAs(definition: RunnerTaskDefinition): Record<string, unknown> {
  return {
    ...JSON.parse(JSON.stringify(definition)) as Record<string, unknown>, status: "ACTIVE", taskDefinitionArn: "arn:x", revision: 1, compatibilities: ["EC2", "FARGATE"],
    containerDefinitions: definition.containerDefinitions.map((container) => ({ ...JSON.parse(JSON.stringify(container)) as Record<string, unknown>, cpu: 0, environment: [], volumesFrom: [], portMappings: container.portMappings?.map((mapping) => ({ ...mapping, hostPort: mapping.containerPort })) ?? [], systemControls: [] })),
  };
}

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- the tests edit a described definition freely */
describe("a revision is run only if it is exactly what the controller would register", () => {
  const built = buildRunnerTaskDefinition(input());
  const tampered = (change: (described: Record<string, any>) => void): unknown => { const described = describedAs(built) as Record<string, any>; change(described); return described; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  it("accepts the definition as ECS describes it back, defaults and all", () => {
    expect(definitionMatches(built, describedAs(built))).toBe(true);
  });
  it("refuses every change that would change what runs", () => {
    const changes: Array<[string, (described: Record<string, any>) => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["a task role", (d) => { d.taskRoleArn = "arn:aws:iam::111111111111:role/admin"; }],
      ["another execution role", (d) => { d.executionRoleArn = "arn:aws:iam::111111111111:role/other"; }],
      ["another image", (d) => { d.containerDefinitions[1].image = d.containerDefinitions[1].image.replace(/a{64}/u, "c".repeat(64)); }],
      ["another image in the fetch step", (d) => { d.containerDefinitions[0].image = "evil/image@sha256:" + "d".repeat(64); }],
      ["another command", (d) => { d.containerDefinitions[1].command = ["/bin/sh"]; }],
      ["an entry point", (d) => { d.containerDefinitions[1].entryPoint = ["/bin/sh", "-c"]; }],
      ["environment", (d) => { d.containerDefinitions[1].environment = [{ name: "NODE_OPTIONS", value: "--require /x" }]; }],
      ["root", (d) => { d.containerDefinitions[1].user = "0"; }],
      ["a writable root file system", (d) => { d.containerDefinitions[1].readonlyRootFilesystem = false; }],
      ["privilege", (d) => { d.containerDefinitions[1].privileged = true; }],
      ["capabilities kept", (d) => { d.containerDefinitions[1].linuxParameters.capabilities.drop = []; }],
      ["a writable bundle", (d) => { d.containerDefinitions[1].mountPoints[0].readOnly = false; }],
      ["another secret", (d) => { d.containerDefinitions[1].secrets[0].valueFrom = "arn:aws:secretsmanager:us-east-1:111111111111:secret:agentx/other-AbCdEf:JIRA_TOKEN::"; }],
      ["a dependency added to the fetch step", (d) => { d.containerDefinitions[0].dependsOn = [{ containerName: "server", condition: "START" }]; }],
      ["a missing dependency", (d) => { delete d.containerDefinitions[1].dependsOn; }],
      ["an extra container", (d) => { d.containerDefinitions.push({ ...d.containerDefinitions[0], name: "sidecar" }); }],
      ["a missing container", (d) => { d.containerDefinitions.pop(); }],
      ["another size", (d) => { d.cpu = "1024"; }],
      ["another network mode", (d) => { d.networkMode = "host"; }],
      ["a host volume", (d) => { d.volumes.push({ name: "host", host: { sourcePath: "/" } }); }],
      ["a volume with a host path", (d) => { d.volumes[0] = { name: "bundle", host: { sourcePath: "/" } }; }],
      ["a PID mode", (d) => { d.pidMode = "host"; }],
      ["a working directory", (d) => { d.containerDefinitions[1].workingDirectory = "/"; }],
      ["security options", (d) => { d.containerDefinitions[1].dockerSecurityOptions = ["no-new-privileges:false"]; }],
    ];
    for (const [name, change] of changes) expect(definitionMatches(built, tampered(change)), name).toBe(false);
    expect(definitionMatches(built, undefined)).toBe(false);
    expect(definitionMatches(built, "x")).toBe(false);
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
describe("runner security group rules", () => {
  const jira: ResolvedDestination = { host: "jira.corp.example", port: 443, addresses: ["10.1.2.3", "10.1.2.4"] };
  it("allows the endpoints a task needs to start, S3, the controller, and each approved destination's addresses as /32, and lets only the controller in", () => {
    const rules = runnerGroupRules(ENDPOINTS, [jira]);
    expect(rules.egress.map(ruleKey)).toEqual([
      "tcp:443:group:sg-0eeeeeeeeeeeeeeee", "tcp:443:group:sg-0ffffffffffffffff", "tcp:443:pl:pl-0123456789abcdef0", "tcp:8443:group:sg-0123456789abcdef0", "tcp:443:cidr:10.1.2.3/32", "tcp:443:cidr:10.1.2.4/32",
    ]);
    expect(rules.ingress.map(ruleKey)).toEqual(["tcp:8080:group:sg-0123456789abcdef0"]);
  });
  it("holds no rule for the internet or a range: every cidr is one host, and none is 0.0.0.0", () => {
    const rules = runnerGroupRules(ENDPOINTS, [jira]);
    for (const rule of [...rules.egress, ...rules.ingress]) if (rule.target.kind === "cidr") expect(rule.target.cidr).toMatch(/^\d+\.\d+\.\d+\.\d+\/32$/u);
    expect(JSON.stringify(rules)).not.toContain("0.0.0.0");
  });
  it("refuses an address that is not a plain IPv4 host, no addresses, too many, a bad port, and a destination list that does not fit in a group", () => {
    const dest = (addresses: string[], port = 443): ResolvedDestination => ({ host: "h", port, addresses });
    for (const bad of [dest(["0.0.0.0"]), dest(["10.0.0.0/8"]), dest(["::1"]), dest(["jira.corp.example"]), dest(["10.1.2"]), dest(["256.1.1.1"]), dest([]), dest(Array.from({ length: 9 }, (_, index) => `10.0.0.${index + 1}`)), dest(["10.0.0.1"], 0), dest(["10.0.0.1"], 70000), dest(["10.0.0.1"], 1.5)]) {
      expect(() => runnerGroupRules(ENDPOINTS, [bad]), JSON.stringify(bad)).toThrow();
    }
    const many = Array.from({ length: 8 }, (_, d) => dest(Array.from({ length: 8 }, (_unused, a) => `10.${d}.0.${a + 1}`), 1000 + d));
    expect(() => runnerGroupRules(ENDPOINTS, many)).toThrow(/more rules/u);
    expect(MAX_EGRESS_RULES).toBeLessThan(60);
  });
  it("refuses endpoint groups, a prefix list, a controller group or a port that are not valid", () => {
    for (const bad of [{ endpointGroupIds: ["x"] }, { s3PrefixListId: "pl-" }, { controllerGroupId: "default" }, { controllerPort: 0 }, { controllerPort: 70000 }]) expect(() => runnerGroupRules({ ...ENDPOINTS, ...bad }, []), JSON.stringify(bad)).toThrow();
  });
  it("counts the same rule once", () => {
    const rules = runnerGroupRules(ENDPOINTS, [jira, { ...jira, host: "jira2.corp.example" }]);
    expect(rules.egress).toHaveLength(6);
  });
});

// A fake cloud: groups and task definitions in memory, every call recorded in order.
function fakeCloud() {
  const calls: string[] = [];
  const groups = new Map<string, DescribedGroup & { name: string; vpcId?: string }>();
  const revisions = new Map<string, Array<{ arn: string; definition: RunnerTaskDefinition; described: unknown }>>();
  let counter = 0;
  const failAt = { step: "", times: 0 };
  const behaviour = { keepIpv6Default: false, vpcOf: "vpc-0123456789abcdef0" };
  const describeFilters: Array<{ tags: Record<string, string>; vpcId?: string | undefined; name?: string | undefined }> = [];
  const trip = (step: string): void => { if (failAt.step === step && failAt.times > 0) { failAt.times -= 1; throw Object.assign(new Error(step), { name: step === "deleteGroup" ? "DependencyViolation" : "Error" }); } };
  const matches = (group: DescribedGroup, tags: Record<string, string>): boolean => Object.entries(tags).every(([key, value]) => group.tags[key] === value);
  const rulesLabel = (rules: GroupRule[]): string => rules.map(ruleKey).join(",");
  const ec2: Ec2GroupApi = {
    async createGroup(args) {
      calls.push(`createGroup:${args.name}`); trip("createGroup");
      counter += 1;
      const groupId = `sg-${String(counter).padStart(17, "0")}`;
      // EC2 gives a new group "all traffic out"
      // and, in a VPC that has IPv6, "all traffic out" to ::/0 as well (a rule this model cannot express, so it counts as foreign)
      groups.set(groupId, { groupId, name: args.name, vpcId: args.vpcId, tags: args.tags, egress: [{ port: -1, target: { kind: "cidr", cidr: "0.0.0.0/0" } }], ingress: [], foreignRules: 1 });
      return groupId;
    },
    async describeGroups(filter) {
      describeFilters.push(filter);
      return [...groups.values()].filter((group) => matches(group, filter.tags) && (filter.vpcId === undefined || group.vpcId === filter.vpcId) && (filter.name === undefined || group.name === filter.name)).map((group) => ({ ...group, egress: [...group.egress], ingress: [...group.ingress] }));
    },
    async revokeDefaultEgress(groupId) { calls.push("revokeDefaultEgress"); trip("revokeDefaultEgress"); const group = groups.get(groupId)!; group.egress = []; group.foreignRules = behaviour.keepIpv6Default ? 1 : 0; },
    async authorize({ groupId, direction, rules }) { calls.push(`authorize:${direction}:${rulesLabel(rules)}`); trip(`authorize:${direction}`); const group = groups.get(groupId)!; (direction === "egress" ? group.egress : group.ingress).push(...rules); },
    async revoke({ groupId, direction, rules }) {
      calls.push(`revoke:${direction}:${rulesLabel(rules)}`);
      const group = groups.get(groupId)!;
      const drop = new Set(rules.map(ruleKey));
      if (direction === "egress") group.egress = group.egress.filter((rule) => !drop.has(ruleKey(rule))); else group.ingress = group.ingress.filter((rule) => !drop.has(ruleKey(rule)));
    },
    async deleteGroup(groupId) { calls.push(`deleteGroup:${groupId}`); trip("deleteGroup"); groups.delete(groupId); },
  };
  const definitions: EcsDefinitionApi = {
    async latestRevision(family) { const latest = revisions.get(family)?.at(-1); return latest === undefined ? undefined : { arn: latest.arn, definition: latest.described }; },
    async register(definition) {
      calls.push(`register:${definition.family}`);
      const list = revisions.get(definition.family) ?? [];
      const arn = `arn:aws:ecs:us-east-1:111111111111:task-definition/${definition.family}:${list.length + 1}`;
      list.push({ arn, definition, described: describedAs(definition) });
      revisions.set(definition.family, list);
      return arn;
    },
    async deregisterAll(family) { calls.push(`deregisterAll:${family}`); revisions.delete(family); },
    async listFamilies(prefix) { return [...revisions.keys()].filter((family) => family.startsWith(prefix)); },
  };
  return { ec2, definitions, calls, groups, revisions, failAt, behaviour, describeFilters };
}

function setup(over: Partial<EcsResourcesConfig> = {}) {
  const cloud = fakeCloud();
  const changes: Array<{ serverId: string; added: string[]; removed: string[] }> = [];
  const resolved: ResolvedDestination[] = [{ host: "jira.corp.example", port: 443, addresses: ["10.1.2.3"] }];
  const state = { resolved, refuse: false };
  const resources = ecsServerResources({
    definitions: cloud.definitions, groups: cloud.ec2, vpcId: "vpc-0123456789abcdef0", image: IMAGE, executionRoleArn: ROLE, logGroup: "/rovara/mcp-runner", region: "us-east-1", endpoints: ENDPOINTS,
    resolveDestinations: async () => { if (state.refuse) throw new Error("outside the ranges"); return state.resolved; }, onEgressChange: (change) => changes.push(change), deleteRetryMs: 1, deleteRetries: 3, ...over,
  });
  return { ...cloud, resources, changes, state, ensureServe: () => resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET }) };
}
const spec = { name: "@acme/sim-mcp", args: [] as string[], secretEnv: ["JIRA_TOKEN"], destinations: [{ host: "jira.corp.example", port: 443 }], size: { cpu: 256, memoryMiB: 512 }, bundleHash: "b".repeat(64) };

describe("per-server resources: ensure", () => {
  it("makes the group empty-handed (default egress revoked FIRST), then adds the ingress and the egress, then registers the definition", async () => {
    const w = setup();
    const made = await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    expect(made).toEqual({ family: `rovara-mcp-serve-${ID}`, taskDefinition: `arn:aws:ecs:us-east-1:111111111111:task-definition/rovara-mcp-serve-${ID}:1`, securityGroupId: "sg-00000000000000001" });
    expect(w.groups.get("sg-00000000000000001")!.foreignRules).toBe(0);
    expect(w.calls.slice(0, 4).map((call) => call.split(":").slice(0, 2).join(":"))).toEqual([`createGroup:rovara-mcp-serve-${ID}`, "revokeDefaultEgress", "authorize:ingress", "authorize:egress"]);
    expect(w.calls.at(-1)).toBe(`register:rovara-mcp-serve-${ID}`);
    const group = w.groups.get("sg-00000000000000001")!;
    expect(group.egress.map(ruleKey)).toContain("tcp:443:cidr:10.1.2.3/32");
    expect(group.egress.some((rule) => rule.target.kind === "cidr" && rule.target.cidr === "0.0.0.0/0")).toBe(false);
    expect(group.tags).toEqual({ "rovara:managed": "rovara-mcp", "rovara:server": ID, "rovara:purpose": "serve" });
    expect(w.changes).toEqual([{ serverId: ID, added: ["10.1.2.3:443"], removed: [] }]);
  });
  it("registers a definition with the server's secrets, size and the image digest", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec: { ...spec, size: { cpu: 512, memoryMiB: 1024 } }, secretRef: SECRET });
    const registered = w.revisions.get(`rovara-mcp-serve-${ID}`)![0]!;
    expect(registered.definition).toMatchObject({ cpu: "512", memory: "1024" });
    expect(registered.definition).not.toHaveProperty("taskRoleArn");
    expect(registered.definition.containerDefinitions[1]!.secrets).toEqual([{ name: "JIRA_TOKEN", valueFrom: `${SECRET}:JIRA_TOKEN::` }]);
  });
  it("does not register the definition again, or touch the group, when nothing changed", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    const before = w.calls.length;
    const again = await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    expect(again.securityGroupId).toBe("sg-00000000000000001");
    expect(w.calls.length).toBe(before);
    expect(w.revisions.get(`rovara-mcp-serve-${ID}`)).toHaveLength(1);
  });
  it("runs the revision it checked: a newer revision someone else registered (here with a task role) is not run, a new checked one is registered and its ARN is returned", async () => {
    const w = setup();
    const first = await w.ensureServe();
    expect(first.taskDefinition).toMatch(/:1$/u);
    // someone with ecs:RegisterTaskDefinition adds revision 2 of the family with a task role
    const family = `rovara-mcp-serve-${ID}`;
    const evil = { ...describedAs(w.revisions.get(family)![0]!.definition), taskRoleArn: "arn:aws:iam::111111111111:role/admin" };
    w.revisions.get(family)!.push({ arn: `arn:aws:ecs:us-east-1:111111111111:task-definition/${family}:2`, definition: w.revisions.get(family)![0]!.definition, described: evil });
    const second = await w.ensureServe();
    expect(second.taskDefinition).toMatch(/:3$/u);
    expect(w.revisions.get(family)!.at(-1)!.described).not.toHaveProperty("taskRoleArn");
    // and a matching latest revision is reused as it is
    expect((await w.ensureServe()).taskDefinition).toBe(second.taskDefinition);
  });
  it("registers a new revision when the definition changed (another size, another image)", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    await w.resources.ensure({ kind: "serve", id: ID, spec: { ...spec, size: { cpu: 512, memoryMiB: 1024 } }, secretRef: SECRET });
    expect(w.revisions.get(`rovara-mcp-serve-${ID}`)).toHaveLength(2);
  });
  it("follows a destination whose address changed: the new address is allowed before the old one is taken away, and the change is told", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    w.calls.length = 0;
    w.state.resolved = [{ host: "jira.corp.example", port: 443, addresses: ["10.1.2.9"] }];
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    expect(w.calls).toEqual(["authorize:egress:tcp:443:cidr:10.1.2.9/32", "revoke:egress:tcp:443:cidr:10.1.2.3/32"]);
    expect(w.changes.at(-1)).toEqual({ serverId: ID, added: ["10.1.2.9:443"], removed: ["10.1.2.3:443"] });
    expect(w.groups.get("sg-00000000000000001")!.egress.map(ruleKey)).not.toContain("tcp:443:cidr:10.1.2.3/32");
  });
  it("brings a group that has a rule it should not have back to the wanted rules", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    w.groups.get("sg-00000000000000001")!.egress.push({ port: 22, target: { kind: "cidr", cidr: "10.9.9.9/32" } });
    w.groups.get("sg-00000000000000001")!.ingress.push({ port: 22, target: { kind: "cidr", cidr: "10.9.9.9/32" } });
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    const group = w.groups.get("sg-00000000000000001")!;
    expect(group.egress.map(ruleKey)).not.toContain("tcp:22:cidr:10.9.9.9/32");
    expect(group.ingress.map(ruleKey)).toEqual(["tcp:8080:group:sg-0123456789abcdef0"]);
  });
  it("replaces a group that holds rules it did not make (a half-made group whose clean-up failed, or a hand edit) instead of stalling the server on it", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    w.groups.get("sg-00000000000000001")!.foreignRules = 1;
    const made = await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    expect(made.securityGroupId).toBe("sg-00000000000000002");
    expect(w.groups.has("sg-00000000000000001")).toBe(false);
    expect(w.groups.get("sg-00000000000000002")!.foreignRules).toBe(0);
  });
  it("does not replace such a group while a task still uses it: it says so and the server does not start in it", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    w.groups.get("sg-00000000000000001")!.foreignRules = 1;
    w.failAt.step = "deleteGroup"; w.failAt.times = 10;
    await expect(w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET })).rejects.toThrow();
    expect(w.groups.has("sg-00000000000000001")).toBe(true);
  });
  it("uses a group only when its tags, its VPC and its exact name all match, and refuses two matches", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    // a group with the right tags in another VPC, and one with the right tags and another name, are not this server's group
    w.groups.set("sg-elsewhere", { ...w.groups.get("sg-00000000000000001")!, groupId: "sg-elsewhere", vpcId: "vpc-other", egress: [] });
    w.groups.set("sg-renamed", { ...w.groups.get("sg-00000000000000001")!, groupId: "sg-renamed", name: "other-name", egress: [] });
    expect((await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET })).securityGroupId).toBe("sg-00000000000000001");
    await w.resources.release("serve", ID);
    expect(w.groups.has("sg-elsewhere")).toBe(true);
    expect(w.groups.has("sg-renamed")).toBe(true);
    expect(w.describeFilters.at(-1)).toEqual({ tags: { "rovara:managed": "rovara-mcp", "rovara:server": ID, "rovara:purpose": "serve" }, vpcId: "vpc-0123456789abcdef0", name: `rovara-mcp-serve-${ID}` });
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    const mine = [...w.groups.values()].find((group) => group.name === `rovara-mcp-serve-${ID}` && group.vpcId === "vpc-0123456789abcdef0")!;
    w.groups.set("sg-twin", { ...mine, groupId: "sg-twin" });
    await expect(w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET })).rejects.toThrow(/more than one/u);
    await expect(w.resources.release("serve", ID)).rejects.toThrow(/more than one/u);
  });
  it("does not start in a group that still holds a default rule (IPv6 all out): it reads the group back, deletes it and says so", async () => {
    const w = setup();
    w.behaviour.keepIpv6Default = true;
    await expect(w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET })).rejects.toThrow(/wanted rules/u);
    expect(w.groups.size).toBe(0);
    expect(w.revisions.size).toBe(0);
  });
  it("reads an updated group back too, and refuses it if it is not exactly the wanted rules", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    w.state.resolved = [{ host: "jira.corp.example", port: 443, addresses: ["10.1.2.9"] }];
    const revoke = w.ec2.revoke.bind(w.ec2);
    w.ec2.revoke = async (args) => { if (args.direction === "egress") return; await revoke(args); };
    await expect(w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET })).rejects.toThrow(/wanted rules/u);
  });
  it("makes nothing when a destination is refused", async () => {
    const w = setup();
    w.state.refuse = true;
    await expect(w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET })).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });
  it("makes nothing when a resolved address is not a plain IPv4 host", async () => {
    const w = setup();
    w.state.resolved = [{ host: "h", port: 443, addresses: ["10.0.0.0/8"] }];
    await expect(w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET })).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });
  it("deletes the group it just made when any step of filling it fails, so no group is left with the default 'all traffic out'", async () => {
    for (const step of ["revokeDefaultEgress", "authorize:ingress", "authorize:egress"]) {
      const w = setup();
      w.failAt.step = step; w.failAt.times = 1;
      await expect(w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET }), step).rejects.toThrow();
      expect(w.groups.size, step).toBe(0);
      expect(w.revisions.size, step).toBe(0);
    }
  });
  it("makes a probe's resources under a family and group of their own", async () => {
    const w = setup();
    const made = await w.resources.ensure({ kind: "probe", id: "probe0123456789", spec, secretRef: SECRET });
    expect(made.family).toBe("rovara-mcp-probe-probe0123456789");
    expect([...w.groups.values()][0]!.tags["rovara:purpose"]).toBe("probe");
  });
  it("refuses an id that is not a server's or a probe's, and an image that is not pinned", async () => {
    const w = setup();
    for (const id of ["../x", "evil", "mcp", "probe12"]) await expect(w.resources.ensure({ kind: id.startsWith("probe") ? "probe" : "serve", id, spec, secretRef: SECRET }), id).rejects.toThrow();
    await expect(w.resources.ensure({ kind: "serve", id: "probe0123456789", spec, secretRef: SECRET })).rejects.toThrow();
    expect(() => setup({ image: "x:latest" })).toThrow(/digest/u);
    expect(w.calls).toEqual([]);
  });
});

describe("per-server resources: release and list", () => {
  it("deregisters the definition and deletes the group", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    await w.resources.release("serve", ID);
    expect(w.revisions.size).toBe(0);
    expect(w.groups.size).toBe(0);
  });
  it("waits for a stopped task to let go of the group, a few times, and then says so", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    w.failAt.step = "deleteGroup"; w.failAt.times = 2;
    await w.resources.release("serve", ID);
    expect(w.calls.filter((call) => call.startsWith("deleteGroup"))).toHaveLength(3);
    expect(w.groups.size).toBe(0);
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    w.failAt.step = "deleteGroup"; w.failAt.times = 10;
    await expect(w.resources.release("serve", ID)).rejects.toThrow();
    expect(w.groups.size).toBe(1);
  });
  it("takes a group that is already gone as deleted, and releases a server that has nothing", async () => {
    const w = setup();
    await expect(w.resources.release("serve", ID)).resolves.toBeUndefined();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    w.ec2.deleteGroup = async () => { throw Object.assign(new Error("gone"), { name: "InvalidGroup.NotFound" }); };
    await expect(w.resources.release("serve", ID)).resolves.toBeUndefined();
  });
  it("lists the servers and probes that have a definition or a group, once each", async () => {
    const w = setup();
    await w.resources.ensure({ kind: "serve", id: ID, spec, secretRef: SECRET });
    await w.resources.ensure({ kind: "probe", id: "probe0123456789", spec, secretRef: SECRET });
    // a group whose definition is gone, and a definition whose group is gone
    w.groups.set("sg-orphan", { groupId: "sg-orphan", name: "x", vpcId: "vpc-0123456789abcdef0", tags: { "rovara:managed": "rovara-mcp", "rovara:server": "mcporphan0001", "rovara:purpose": "serve" }, egress: [], ingress: [], foreignRules: 0 });
    w.groups.set("sg-other", { groupId: "sg-other", name: "x", vpcId: "vpc-0123456789abcdef0", tags: { "rovara:managed": "rovara-mcp", "rovara:server": "evil", "rovara:purpose": "serve" }, egress: [], ingress: [], foreignRules: 0 });
    w.revisions.set("rovara-mcp-serve-mcpnogroup001", []);
    w.revisions.set("rovara-mcp-serve-notanid", []);
    const listed = await w.resources.list!();
    expect(w.describeFilters.at(-1)).toEqual({ tags: { "rovara:managed": "rovara-mcp" }, vpcId: "vpc-0123456789abcdef0" });
    expect(listed.map((item) => `${item.kind}:${item.id}`).sort()).toEqual(["probe:probe0123456789", "serve:mcpnogroup001", "serve:mcporphan0001", `serve:${ID}`]);
  });
});
