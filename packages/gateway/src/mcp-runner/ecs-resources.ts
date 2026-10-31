// Stdio MCP host redesign (T7), design sections 3, 6, 7, 8 and 9: what the controller makes for each server, and takes away again.
//
//   - a TASK DEFINITION family `rovara-mcp-serve-<serverId>` (or `rovara-mcp-probe-<id>` for one test), built here and nowhere else, so that every runner has exactly the shape the
//     design promises: no task role, a non-root user per container, a read-only root file system, every capability dropped, the bundle read-only in the server, the server waiting
//     for the fetch step to succeed, the image pinned by digest, and the server's secrets named (never their values);
//   - a SECURITY GROUP `rovara-mcp-<kind>-<id>` that holds only what the admin approved: the endpoints the task needs to start, the controller, and each approved destination's
//     resolved addresses as /32. EC2 gives a new group "all traffic out"; that rule is removed before anything else is added, and no rule here is ever 0.0.0.0/0.
// The cloud calls go through the narrow interfaces below (the real clients are adapted in the broker's aws-adapters.ts), so every rule is tested against a fake.
import { createHash } from "node:crypto";
import { RUNNER_FAMILY_PREFIX, serveFamily } from "./task-runner.js";
import type { ServerResources } from "../mcp-controller.js";

// ---------------------------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------------------------

export interface TaskDefinitionInput {
  family: string;
  /** The runner image, pinned by digest (`...@sha256:<64 hex>`). The controller refuses anything else. */
  image: string;
  executionRoleArn: string;
  logGroup: string;
  region: string;
  size: { cpu: number; memoryMiB: number };
  /** The secret's name or ARN in the secret store. Absent: the server declares no secrets. */
  secretRef?: string | undefined;
  secretEnv: readonly string[];
  tags: Record<string, string>;
}

/** The part of ECS's RegisterTaskDefinition input that this builds. Note what is NOT here: `taskRoleArn`. */
export interface RunnerTaskDefinition {
  family: string;
  networkMode: "awsvpc";
  requiresCompatibilities: ["FARGATE"];
  cpu: string;
  memory: string;
  executionRoleArn: string;
  runtimePlatform: { cpuArchitecture: "ARM64"; operatingSystemFamily: "LINUX" };
  volumes: Array<{ name: string }>;
  containerDefinitions: ContainerDefinition[];
  tags: Array<{ key: string; value: string }>;
}

interface ContainerDefinition {
  name: "fetch" | "server";
  image: string;
  essential: boolean;
  user: string;
  command: string[];
  readonlyRootFilesystem: true;
  linuxParameters: { capabilities: { drop: ["ALL"] }; initProcessEnabled: true };
  mountPoints: Array<{ sourceVolume: string; containerPath: string; readOnly: boolean }>;
  logConfiguration: { logDriver: "awslogs"; options: Record<string, string> };
  dependsOn?: Array<{ containerName: string; condition: "SUCCESS" }>;
  ulimits?: Array<{ name: "nofile"; softLimit: number; hardLimit: number }>;
  portMappings?: Array<{ containerPort: number; protocol: "tcp" }>;
  secrets?: Array<{ name: string; valueFrom: string }>;
}

const IMAGE_BY_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,300}@sha256:[0-9a-f]{64}$/u;
const EXECUTION_ROLE = /^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,200}$/u;
const SECRET_REF = /^(?:arn:aws(?:-[a-z]+)*:secretsmanager:[a-z0-9-]+:\d{12}:secret:)?agentx\/[A-Za-z0-9/_+=.@-]{1,300}$/u;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;
const NODE = "/usr/local/bin/node";

export const RUNNER_UID = { fetch: "10002:10002", server: "10003:10003" } as const;

/** The task definition of a serve or probe task. Throws when an input is not allowed; nothing is registered from an input that was not checked. */
export function buildRunnerTaskDefinition(input: TaskDefinitionInput): RunnerTaskDefinition {
  if (!input.family.startsWith(RUNNER_FAMILY_PREFIX) || !/^rovara-mcp-[A-Za-z0-9_-]{1,200}$/u.test(input.family)) throw new Error("the family is not allowed");
  if (!IMAGE_BY_DIGEST.test(input.image)) throw new Error("the runner image must be pinned by digest");
  if (!EXECUTION_ROLE.test(input.executionRoleArn)) throw new Error("the execution role is not a role ARN");
  if (input.secretEnv.length > 0 && (input.secretRef === undefined || !SECRET_REF.test(input.secretRef) || input.secretRef.includes("..") || input.secretRef.includes("//"))) throw new Error("the secret's name is not allowed");
  if (input.secretEnv.length > 8 || !input.secretEnv.every((name) => SECRET_NAME.test(name))) throw new Error("the secret names are not allowed");
  if (![256, 512, 1024].includes(input.size.cpu) || ![512, 1024, 2048].includes(input.size.memoryMiB)) throw new Error("the size is not allowed");
  const logging = (name: string): ContainerDefinition["logConfiguration"] => ({ logDriver: "awslogs", options: { "awslogs-group": input.logGroup, "awslogs-region": input.region, "awslogs-stream-prefix": name } });
  const hardened = { capabilities: { drop: ["ALL"] as ["ALL"] }, initProcessEnabled: true as const };
  return {
    family: input.family,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: String(input.size.cpu),
    memory: String(input.size.memoryMiB),
    // The execution role pulls the image, writes logs and reads the secrets named below. There is NO task role: nothing in these containers has AWS credentials.
    executionRoleArn: input.executionRoleArn,
    runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
    volumes: [{ name: "bundle" }, { name: "home" }, { name: "tmp" }],
    containerDefinitions: [
      {
        name: "fetch", image: input.image, essential: false, user: RUNNER_UID.fetch, command: [NODE, "/opt/mcp-runner/fetch.mjs"], readonlyRootFilesystem: true, linuxParameters: hardened,
        mountPoints: [{ sourceVolume: "bundle", containerPath: "/bundle", readOnly: false }], logConfiguration: logging("fetch"),
      },
      {
        name: "server", image: input.image, essential: true, user: RUNNER_UID.server, command: [NODE, "/opt/mcp-runner/serve.mjs"], readonlyRootFilesystem: true, linuxParameters: hardened,
        dependsOn: [{ containerName: "fetch", condition: "SUCCESS" }],
        // The server cannot change the code it runs: the bundle is read-only here.
        mountPoints: [{ sourceVolume: "bundle", containerPath: "/bundle", readOnly: true }, { sourceVolume: "home", containerPath: "/home/server", readOnly: false }, { sourceVolume: "tmp", containerPath: "/tmp", readOnly: false }],
        ulimits: [{ name: "nofile", softLimit: 1_024, hardLimit: 1_024 }],
        portMappings: [{ containerPort: 8_080, protocol: "tcp" }],
        // The values are read by ECS at task start, with the execution role. The name is a JSON key of one secret; the value is never in this definition, a log or an override.
        ...(input.secretEnv.length === 0 ? {} : { secrets: input.secretEnv.map((name) => ({ name, valueFrom: `${input.secretRef}:${name}::` })) }),
        logConfiguration: logging("server"),
      },
    ],
    tags: Object.entries(input.tags).map(([key, value]) => ({ key, value })),
  };
}

export const definitionHash = (definition: RunnerTaskDefinition): string => createHash("sha256").update(JSON.stringify(definition)).digest("hex");

export interface EcsDefinitionApi {
  /** The newest ACTIVE revision of a family, and the hash of the definition it was made from (its `rovara:definition` tag). */
  latestRevision(family: string): Promise<{ arn: string; definitionHash?: string | undefined } | undefined>;
  register(definition: RunnerTaskDefinition): Promise<string>;
  /** Deregisters every ACTIVE revision of a family. A family that is gone is not an error. */
  deregisterAll(family: string): Promise<void>;
  /** The families with this prefix that have an ACTIVE revision. */
  listFamilies(prefix: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------------------------
// Security groups
// ---------------------------------------------------------------------------------------------

export type RuleTarget = { kind: "cidr"; cidr: string } | { kind: "group"; groupId: string } | { kind: "prefixList"; prefixListId: string };
/** A TCP rule for one port. These are the only rules a runner group ever holds. */
export interface GroupRule { port: number; target: RuleTarget }

export interface DescribedGroup { groupId: string; tags: Record<string, string>; egress: GroupRule[]; ingress: GroupRule[]; /** Rules that are not a TCP rule for one port (any protocol, a range, IPv6). */ foreignRules: number }

export interface Ec2GroupApi {
  createGroup(input: { name: string; description: string; vpcId: string; tags: Record<string, string> }): Promise<string>;
  /** The groups that match ALL of the filter: the tags, and the VPC and the exact group name when given. */
  describeGroups(filter: { tags: Record<string, string>; vpcId?: string | undefined; name?: string | undefined }): Promise<DescribedGroup[]>;
  /** Removes the "all traffic" egress rules EC2 puts on a new group: to 0.0.0.0/0 and, in a VPC with IPv6, to ::/0. A rule that is not there is fine. */
  revokeDefaultEgress(groupId: string): Promise<void>;
  authorize(input: { groupId: string; direction: "egress" | "ingress"; rules: GroupRule[] }): Promise<void>;
  revoke(input: { groupId: string; direction: "egress" | "ingress"; rules: GroupRule[] }): Promise<void>;
  /** Throws an error named `DependencyViolation` while a network interface still uses the group. */
  deleteGroup(groupId: string): Promise<void>;
}

export interface ResolvedDestination { host: string; port: number; addresses: string[] }

export interface EndpointRules {
  /** The security groups of the VPC interface endpoints a task needs to start (ecr.api, ecr.dkr, secretsmanager, logs). */
  endpointGroupIds: readonly string[];
  /** The S3 gateway endpoint's prefix list (image layers). */
  s3PrefixListId: string;
  /** The controller's security group, and the port the controller's runner listener has. */
  controllerGroupId: string;
  controllerPort: number;
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const GROUP_ID = /^sg-[0-9a-f]{8,17}$/u;
const PREFIX_LIST_ID = /^pl-[0-9a-f]{8,17}$/u;
/** A security group holds 60 rules per direction by default. */
export const MAX_EGRESS_RULES = 50;

export const ruleKey = (rule: GroupRule): string => `tcp:${rule.port}:${rule.target.kind === "cidr" ? `cidr:${rule.target.cidr}` : rule.target.kind === "group" ? `group:${rule.target.groupId}` : `pl:${rule.target.prefixListId}`}`;

/** What a runner's group holds. Every address is one IPv4 host (/32); there is no rule for a range, a name, or the internet. */
export function runnerGroupRules(endpoints: EndpointRules, destinations: readonly ResolvedDestination[]): { egress: GroupRule[]; ingress: GroupRule[] } {
  for (const id of endpoints.endpointGroupIds) if (!GROUP_ID.test(id)) throw new Error("an endpoint security group is not valid");
  if (!GROUP_ID.test(endpoints.controllerGroupId) || !PREFIX_LIST_ID.test(endpoints.s3PrefixListId) || !Number.isInteger(endpoints.controllerPort) || endpoints.controllerPort < 1 || endpoints.controllerPort > 65_535) throw new Error("the controller's group or the prefix list is not valid");
  const egress: GroupRule[] = [
    ...endpoints.endpointGroupIds.map((groupId): GroupRule => ({ port: 443, target: { kind: "group", groupId } })),
    { port: 443, target: { kind: "prefixList", prefixListId: endpoints.s3PrefixListId } },
    { port: endpoints.controllerPort, target: { kind: "group", groupId: endpoints.controllerGroupId } },
  ];
  for (const destination of destinations) {
    if (!Number.isInteger(destination.port) || destination.port < 1 || destination.port > 65_535) throw new Error("a destination port is not valid");
    if (destination.addresses.length === 0 || destination.addresses.length > 8) throw new Error("a destination must resolve to between 1 and 8 addresses");
    for (const address of destination.addresses) {
      // Only an IPv4 host address becomes a rule. A range, a name, an IPv6 address, and 0.0.0.0 are refused, so the group can never be wider than the admin's approval.
      if (!IPV4.test(address) || address === "0.0.0.0") throw new Error("a destination address is not a plain IPv4 address");
      egress.push({ port: destination.port, target: { kind: "cidr", cidr: `${address}/32` } });
    }
  }
  const unique = [...new Map(egress.map((rule) => [ruleKey(rule), rule])).values()];
  if (unique.length > MAX_EGRESS_RULES) throw new Error("the approved destinations need more rules than a security group holds");
  // Nothing reaches a runner except the controller, on the bridge's port.
  return { egress: unique, ingress: [{ port: 8_080, target: { kind: "group", groupId: endpoints.controllerGroupId } }] };
}

// ---------------------------------------------------------------------------------------------
// The resources of a server
// ---------------------------------------------------------------------------------------------

export const SERVE_PREFIX = `${RUNNER_FAMILY_PREFIX}serve-`;
export const PROBE_PREFIX = `${RUNNER_FAMILY_PREFIX}probe-`;
export const MANAGED_TAG = "rovara:managed";
export const MANAGED_VALUE = "rovara-mcp";

export interface EcsResourcesConfig {
  definitions: EcsDefinitionApi;
  groups: Ec2GroupApi;
  /** The runner subnets' VPC. */
  vpcId: string;
  image: string;
  executionRoleArn: string;
  logGroup: string;
  region: string;
  endpoints: EndpointRules;
  /** Looks up each destination and applies the install's rules (inside the private ranges, outside Rovara's network, not on the never-called list). Throws when any is refused. */
  resolveDestinations: (destinations: ReadonlyArray<{ host: string; port: number }>) => Promise<ResolvedDestination[]>;
  /** Told when a server's allowed addresses changed: host names only, never anything secret. */
  onEgressChange?: (change: { serverId: string; added: string[]; removed: string[] }) => void;
  /** How long to wait between tries to delete a group a stopped task has not released yet, and how many tries. */
  deleteRetryMs?: number;
  deleteRetries?: number;
}

const idOf = (kind: "serve" | "probe", family: string): string => family.slice((kind === "serve" ? SERVE_PREFIX : PROBE_PREFIX).length);
const SERVE_ID = /^mcp[a-z0-9]{6,24}$/u;
const PROBE_ID = /^probe[0-9a-f]{10}$/u;

export function ecsServerResources(config: EcsResourcesConfig): ServerResources {
  // The image is checked when this is built, so a misconfigured install fails to start rather than at the first server.
  if (!IMAGE_BY_DIGEST.test(config.image)) throw new Error("the runner image must be pinned by digest");
  const retries = config.deleteRetries ?? 6;
  const retryMs = config.deleteRetryMs ?? 5_000;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const tagsOf = (kind: "serve" | "probe", id: string): Record<string, string> => ({ [MANAGED_TAG]: MANAGED_VALUE, "rovara:server": id, "rovara:purpose": kind });

  const nameOf = (kind: "serve" | "probe", id: string): string => `rovara-mcp-${kind}-${id}`;
  /** The one group of a server: matched by its tags AND its VPC AND its exact name. More than one match is not guessed at. */
  async function findGroup(kind: "serve" | "probe", id: string): Promise<DescribedGroup | undefined> {
    const found = await config.groups.describeGroups({ tags: tagsOf(kind, id), vpcId: config.vpcId, name: nameOf(kind, id) });
    if (found.length > 1) throw new Error("more than one security group matches this server");
    return found[0];
  }
  /** Deletes a group, waiting (a few tries) for a stopped task to let go of it. A group that is already gone is deleted. */
  async function deleteGroupPatiently(groupId: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try { await config.groups.deleteGroup(groupId); return; } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "InvalidGroup.NotFound") return;
        // A stopped task releases its network interface after a while; until then the group is in use.
        if (name !== "DependencyViolation" || attempt + 1 >= retries) throw error;
        await sleep(retryMs);
      }
    }
  }
  async function removeGroup(kind: "serve" | "probe", id: string): Promise<void> {
    const group = await findGroup(kind, id);
    if (group !== undefined) await deleteGroupPatiently(group.groupId);
  }
  /** The group holds exactly the wanted rules and nothing else (in particular no default rule that was left). */
  function exactlyWanted(group: DescribedGroup | undefined, wanted: { egress: GroupRule[]; ingress: GroupRule[] }): boolean {
    if (group === undefined || group.foreignRules > 0) return false;
    const same = (left: GroupRule[], right: GroupRule[]): boolean => left.length === right.length && new Set(left.map(ruleKey)).size === left.length && right.every((rule) => left.some((other) => ruleKey(other) === ruleKey(rule)));
    return same(group.egress, wanted.egress) && same(group.ingress, wanted.ingress);
  }

  return {
    async ensure({ kind, id, spec, secretRef }) {
      if (!(kind === "serve" ? SERVE_ID : PROBE_ID).test(id)) throw new Error("the id is not allowed");
      const family = kind === "serve" ? serveFamily(id) : `${PROBE_PREFIX}${id}`;
      // 1. The destinations, resolved and checked now (and again at every start, so a changed address is noticed).
      const resolved = await config.resolveDestinations(spec.destinations);
      const wanted = runnerGroupRules(config.endpoints, resolved);
      // 2. The security group: made empty, then filled; or an existing one brought to exactly the wanted rules.
      let existing = await findGroup(kind, id);
      // A group with a rule this controller did not make (a half-made group whose clean-up failed, or one edited by hand) is replaced, not trusted and not left to stall the server.
      if (existing !== undefined && existing.foreignRules > 0) { await deleteGroupPatiently(existing.groupId); existing = undefined; }
      let groupId: string;
      if (existing === undefined) {
        groupId = await config.groups.createGroup({ name: nameOf(kind, id), description: `Rovara MCP runner ${kind} ${id}`, vpcId: config.vpcId, tags: tagsOf(kind, id) });
        try {
          await config.groups.revokeDefaultEgress(groupId);
          await config.groups.authorize({ groupId, direction: "ingress", rules: wanted.ingress });
          await config.groups.authorize({ groupId, direction: "egress", rules: wanted.egress });
          // Read it back: no task starts in a group that does not hold exactly what was wanted.
          if (!exactlyWanted(await findGroup(kind, id), wanted)) throw new Error("the security group does not hold the wanted rules");
        } catch (error) {
          // A group that could not be made exactly right is not left behind.
          await config.groups.deleteGroup(groupId).catch(() => undefined);
          throw error;
        }
        config.onEgressChange?.({ serverId: id, added: resolved.flatMap((item) => item.addresses.map((address) => `${address}:${item.port}`)), removed: [] });
      } else {
        groupId = existing.groupId;
        const have = new Map(existing.egress.map((rule) => [ruleKey(rule), rule]));
        const want = new Map(wanted.egress.map((rule) => [ruleKey(rule), rule]));
        const add = [...want.entries()].filter(([key]) => !have.has(key)).map(([, rule]) => rule);
        const drop = [...have.entries()].filter(([key]) => !want.has(key)).map(([, rule]) => rule);
        const haveIngress = new Set(existing.ingress.map(ruleKey));
        const addIngress = wanted.ingress.filter((rule) => !haveIngress.has(ruleKey(rule)));
        const dropIngress = existing.ingress.filter((rule) => !wanted.ingress.some((other) => ruleKey(other) === ruleKey(rule)));
        // New rules first, then the stale ones: the group is never narrower than both for a moment, and never wider than the two together.
        if (addIngress.length > 0) await config.groups.authorize({ groupId, direction: "ingress", rules: addIngress });
        if (add.length > 0) await config.groups.authorize({ groupId, direction: "egress", rules: add });
        if (dropIngress.length > 0) await config.groups.revoke({ groupId, direction: "ingress", rules: dropIngress });
        if (drop.length > 0) await config.groups.revoke({ groupId, direction: "egress", rules: drop });
        const cidrs = (rules: GroupRule[]): string[] => rules.flatMap((rule) => (rule.target.kind === "cidr" ? [`${rule.target.cidr.replace("/32", "")}:${rule.port}`] : []));
        if (add.length > 0 || drop.length > 0) config.onEgressChange?.({ serverId: id, added: cidrs(add), removed: cidrs(drop) });
        if (!exactlyWanted(await findGroup(kind, id), wanted)) throw new Error("the security group does not hold the wanted rules");
      }
      // 3. The task definition: registered when there is none or the definition changed (a new image, size or secret), and left alone otherwise.
      const definition = buildRunnerTaskDefinition({
        family, image: config.image, executionRoleArn: config.executionRoleArn, logGroup: config.logGroup, region: config.region, size: spec.size, secretRef, secretEnv: spec.secretEnv,
        tags: { [MANAGED_TAG]: MANAGED_VALUE, "rovara:server": id, "rovara:purpose": kind },
      });
      const hash = definitionHash(definition);
      const latest = await config.definitions.latestRevision(family);
      if (latest?.definitionHash !== hash) {
        await config.definitions.register({ ...definition, tags: [...definition.tags, { key: "rovara:definition", value: hash }] });
      }
      return { family, securityGroupId: groupId };
    },

    async release(kind, id) {
      if (!(kind === "serve" ? SERVE_ID : PROBE_ID).test(id)) throw new Error("the id is not allowed");
      await config.definitions.deregisterAll(kind === "serve" ? serveFamily(id) : `${PROBE_PREFIX}${id}`);
      await removeGroup(kind, id);
    },

    async list() {
      const found = new Map<string, { kind: "serve" | "probe"; id: string }>();
      for (const kind of ["serve", "probe"] as const) {
        for (const family of await config.definitions.listFamilies(kind === "serve" ? SERVE_PREFIX : PROBE_PREFIX)) {
          const id = idOf(kind, family);
          if ((kind === "serve" ? SERVE_ID : PROBE_ID).test(id)) found.set(`${kind}:${id}`, { kind, id });
        }
      }
      for (const group of await config.groups.describeGroups({ tags: { [MANAGED_TAG]: MANAGED_VALUE }, vpcId: config.vpcId })) {
        const kind = group.tags["rovara:purpose"];
        const id = group.tags["rovara:server"];
        if ((kind === "serve" || kind === "probe") && id !== undefined && (kind === "serve" ? SERVE_ID : PROBE_ID).test(id)) found.set(`${kind}:${id}`, { kind, id });
      }
      return [...found.values()];
    },
  };
}

