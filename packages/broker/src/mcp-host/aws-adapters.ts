// Stdio MCP host redesign (T6): the real AWS clients behind the gateway's narrow interfaces (`EcsApi`, `BundleObjectApi`). The gateway holds the rules; these only translate. Nothing here
// is called in a test against AWS: the tests pass fake SDK classes.
import { DescribeSecretCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  AuthorizeSecurityGroupEgressCommand, AuthorizeSecurityGroupIngressCommand, CreateSecurityGroupCommand, DeleteSecurityGroupCommand, DescribeSecurityGroupsCommand, RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand, type EC2Client, type IpPermission,
} from "@aws-sdk/client-ec2";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { BundleObjectApi, DescribedGroup, Ec2GroupApi, EcsApi, EcsDefinitionApi, EcsTaskDescription, GroupRule, RunnerTaskDefinition } from "@agentx/gateway";

/** The part of `@aws-sdk/client-ecs` this uses. The module is loaded by name at start-up (the infrastructure task adds it to the dependencies and the image). */
export interface EcsSdk {
  ECSClient: new (config: Record<string, unknown>) => { send(command: unknown): Promise<EcsResponse> };
  RunTaskCommand: new (input: Record<string, unknown>) => unknown;
  StopTaskCommand: new (input: Record<string, unknown>) => unknown;
  DescribeTasksCommand: new (input: Record<string, unknown>) => unknown;
  ListTasksCommand: new (input: Record<string, unknown>) => unknown;
  RegisterTaskDefinitionCommand: new (input: Record<string, unknown>) => unknown;
  DeregisterTaskDefinitionCommand: new (input: Record<string, unknown>) => unknown;
  DescribeTaskDefinitionCommand: new (input: Record<string, unknown>) => unknown;
  ListTaskDefinitionsCommand: new (input: Record<string, unknown>) => unknown;
  ListTaskDefinitionFamiliesCommand: new (input: Record<string, unknown>) => unknown;
}

/** The fields of ECS's answers that are read here. */
export interface EcsResponse {
  tasks?: Array<{
    taskArn?: string; lastStatus?: string; startedAt?: Date; createdAt?: Date; tags?: Array<{ key?: string; value?: string }>;
    startedBy?: string; taskDefinitionArn?: string;
    attachments?: Array<{ type?: string; details?: Array<{ name?: string; value?: string }> }>; containers?: Array<{ name?: string; exitCode?: number }>;
  }>;
  failures?: unknown[];
  taskArns?: string[];
  nextToken?: string;
  taskDefinition?: { taskDefinitionArn?: string } & Record<string, unknown>;
  tags?: Array<{ key?: string; value?: string }>;
  taskDefinitionArns?: string[];
  families?: string[];
}

const MAX_LIST_PAGES = 20;

export function ecsApiFromSdk(sdk: EcsSdk, client: InstanceType<EcsSdk["ECSClient"]>): EcsApi {
  return {
    async runTask(input) {
      const out = await client.send(new sdk.RunTaskCommand({ ...input }));
      return { taskArns: (out.tasks ?? []).map((task) => task.taskArn).filter((arn): arn is string => typeof arn === "string"), failureCount: (out.failures ?? []).length };
    },
    async stopTask(input) {
      await client.send(new sdk.StopTaskCommand({ cluster: input.cluster, task: input.taskArn, reason: input.reason.slice(0, 250) }));
    },
    async describeTasks(input) {
      const out = await client.send(new sdk.DescribeTasksCommand({ cluster: input.cluster, tasks: input.taskArns, include: ["TAGS"] }));
      return (out.tasks ?? []).map((task): EcsTaskDescription => {
        const interfaceDetails = (task.attachments ?? []).find((attachment) => attachment.type === "ElasticNetworkInterface")?.details ?? [];
        const exitCodes: Record<string, number | undefined> = {};
        for (const container of task.containers ?? []) if (container.name !== undefined) exitCodes[container.name] = container.exitCode;
        return {
          taskArn: String(task.taskArn), lastStatus: String(task.lastStatus), startedAt: task.startedAt, createdAt: task.createdAt, startedBy: task.startedBy, taskDefinitionArn: task.taskDefinitionArn,
          tags: (task.tags ?? []).filter((tag): tag is { key: string; value: string } => typeof tag.key === "string" && typeof tag.value === "string"),
          privateIpv4: interfaceDetails.find((detail) => detail.name === "privateIPv4Address")?.value, exitCodes,
        };
      });
    },
    async listTaskArns(input) {
      const arns: string[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const out = await client.send(new sdk.ListTasksCommand({ cluster: input.cluster, desiredStatus: "RUNNING", ...(nextToken === undefined ? {} : { nextToken }) }));
        arns.push(...(out.taskArns ?? []));
        nextToken = out.nextToken;
        if (nextToken === undefined) return arns;
      }
      // More pages than a controller should ever see: the list is not trusted to be complete, so it is not used to decide what is a leftover.
      throw new Error("too many tasks to list");
    },
  };
}

/** The bundle bucket, through the three S3 calls the store makes. */
export function bundleObjectApiFromS3(client: Pick<S3Client, "send">, bucket: string): BundleObjectApi {
  return {
    async put(input) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: input.key, Body: input.body, ContentLength: input.size, ContentType: "application/x-tar" }));
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return out.Body === undefined ? undefined : { size: Number(out.ContentLength ?? 0), stream: out.Body as Readable };
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === "NoSuchKey") return undefined;
        throw error;
      }
    },
    async head(key) {
      try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "NotFound" || name === "NoSuchKey") return false;
        throw error;
      }
    },
  };
}

/** The task definitions of the per-server families (T7). `latestRevision` reads the definition hash from the revision's tag, so a definition is registered only when it changed. */
export function ecsDefinitionApiFromSdk(sdk: EcsSdk, client: InstanceType<EcsSdk["ECSClient"]>): EcsDefinitionApi {
  const listArns = async (family: string): Promise<string[]> => {
    const arns: string[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const out = await client.send(new sdk.ListTaskDefinitionsCommand({ familyPrefix: family, status: "ACTIVE", sort: "DESC", ...(nextToken === undefined ? {} : { nextToken }) }));
      // familyPrefix matches by prefix: only the family itself is this server's.
      arns.push(...(out.taskDefinitionArns ?? []).filter((arn) => new RegExp(`/${family}:\\d+$`, "u").test(arn)));
      nextToken = out.nextToken;
      if (nextToken === undefined) return arns;
    }
    throw new Error("too many task definitions to list");
  };
  return {
    async latestRevision(family) {
      const [arn] = await listArns(family);
      if (arn === undefined) return undefined;
      const out = await client.send(new sdk.DescribeTaskDefinitionCommand({ taskDefinition: arn }));
      return { arn, definition: out.taskDefinition };
    },
    async register(definition: RunnerTaskDefinition) {
      const out = await client.send(new sdk.RegisterTaskDefinitionCommand({ ...definition }));
      const arn = out.taskDefinition?.taskDefinitionArn;
      if (arn === undefined) throw new Error("the task definition was not registered");
      return arn;
    },
    async deregisterAll(family) {
      for (const arn of await listArns(family)) {
        try { await client.send(new sdk.DeregisterTaskDefinitionCommand({ taskDefinition: arn })); } catch (error) {
          if ((error as { name?: unknown } | null)?.name !== "ClientException") throw error;
        }
      }
    },
    async listFamilies(prefix) {
      const families: string[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const out = await client.send(new sdk.ListTaskDefinitionFamiliesCommand({ familyPrefix: prefix, status: "ACTIVE", ...(nextToken === undefined ? {} : { nextToken }) }));
        families.push(...(out.families ?? []).filter((family) => family.startsWith(prefix)));
        nextToken = out.nextToken;
        if (nextToken === undefined) return families;
      }
      throw new Error("too many task definition families to list");
    },
  };
}

const permissionOf = (rule: GroupRule): IpPermission => ({
  IpProtocol: "tcp", FromPort: rule.port, ToPort: rule.port,
  ...(rule.target.kind === "cidr" ? { IpRanges: [{ CidrIp: rule.target.cidr }] } : rule.target.kind === "group" ? { UserIdGroupPairs: [{ GroupId: rule.target.groupId }] } : { PrefixListIds: [{ PrefixListId: rule.target.prefixListId }] }),
});

/** Rules as the cloud reports them: TCP rules for one port are `GroupRule`s, anything else is counted as foreign (the controller makes none, so it refuses a group that has any). */
function rulesOf(permissions: IpPermission[] | undefined): { rules: GroupRule[]; foreign: number } {
  const rules: GroupRule[] = [];
  let foreign = 0;
  for (const permission of permissions ?? []) {
    const port = permission.FromPort;
    if (permission.IpProtocol !== "tcp" || port === undefined || port !== permission.ToPort || (permission.Ipv6Ranges ?? []).length > 0) { foreign += 1; continue; }
    for (const range of permission.IpRanges ?? []) if (range.CidrIp !== undefined) rules.push({ port, target: { kind: "cidr", cidr: range.CidrIp } });
    for (const pair of permission.UserIdGroupPairs ?? []) if (pair.GroupId !== undefined) rules.push({ port, target: { kind: "group", groupId: pair.GroupId } });
    for (const list of permission.PrefixListIds ?? []) if (list.PrefixListId !== undefined) rules.push({ port, target: { kind: "prefixList", prefixListId: list.PrefixListId } });
  }
  return { rules, foreign };
}

/** The runner security groups (T7). Every group is found by its tags; the controller's role is scoped by the same tags (T8). */
export function ec2GroupApiFromSdk(client: Pick<EC2Client, "send">): Ec2GroupApi {
  return {
    async createGroup(input) {
      const out = await client.send(new CreateSecurityGroupCommand({
        GroupName: input.name, Description: input.description, VpcId: input.vpcId,
        TagSpecifications: [{ ResourceType: "security-group", Tags: Object.entries(input.tags).map(([Key, Value]) => ({ Key, Value })) }],
      }));
      if (out.GroupId === undefined) throw new Error("the security group was not created");
      return out.GroupId;
    },
    async describeGroups({ tags, vpcId, name }) {
      const out = await client.send(new DescribeSecurityGroupsCommand({ Filters: [
        ...Object.entries(tags).map(([key, value]) => ({ Name: `tag:${key}`, Values: [value] })),
        ...(vpcId === undefined ? [] : [{ Name: "vpc-id", Values: [vpcId] }]), ...(name === undefined ? [] : [{ Name: "group-name", Values: [name] }]),
      ] }));
      return (out.SecurityGroups ?? []).filter((group) => group.GroupId !== undefined).map((group): DescribedGroup => {
        const egress = rulesOf(group.IpPermissionsEgress);
        const ingress = rulesOf(group.IpPermissions);
        return {
          groupId: group.GroupId!, tags: Object.fromEntries((group.Tags ?? []).filter((tag) => tag.Key !== undefined && tag.Value !== undefined).map((tag) => [tag.Key!, tag.Value!])),
          egress: egress.rules, ingress: ingress.rules, foreignRules: egress.foreign + ingress.foreign,
        };
      });
    },
    async revokeDefaultEgress(groupId) {
      // A new group has "all traffic out" to 0.0.0.0/0 and, in a VPC that has an IPv6 range, to ::/0. Both go; a rule that is not there is fine.
      for (const permission of [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }, { IpProtocol: "-1", Ipv6Ranges: [{ CidrIpv6: "::/0" }] }]) {
        try { await client.send(new RevokeSecurityGroupEgressCommand({ GroupId: groupId, IpPermissions: [permission] })); } catch (error) {
          if ((error as { name?: unknown } | null)?.name !== "InvalidPermission.NotFound") throw error;
        }
      }
    },
    async authorize({ groupId, direction, rules }) {
      const input = { GroupId: groupId, IpPermissions: rules.map(permissionOf) };
      if (direction === "egress") await client.send(new AuthorizeSecurityGroupEgressCommand(input)); else await client.send(new AuthorizeSecurityGroupIngressCommand(input));
    },
    async revoke({ groupId, direction, rules }) {
      const input = { GroupId: groupId, IpPermissions: rules.map(permissionOf) };
      if (direction === "egress") await client.send(new RevokeSecurityGroupEgressCommand(input)); else await client.send(new RevokeSecurityGroupIngressCommand(input));
    },
    async deleteGroup(groupId) {
      await client.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
    },
  };
}

/** The full ARN of a server's secret (its name plus the random suffix), which ECS needs to read one key of it. Looked up once per server and remembered. */
export function secretArnResolver(client: Pick<SecretsManagerClient, "send">, nameOf: (serverId: string) => string): (serverId: string) => Promise<string | undefined> {
  const known = new Map<string, string>();
  return async (serverId) => {
    const cached = known.get(serverId);
    if (cached !== undefined) return cached;
    const out = await client.send(new DescribeSecretCommand({ SecretId: nameOf(serverId) }));
    if (out.ARN === undefined) return undefined;
    known.set(serverId, out.ARN);
    return out.ARN;
  };
}
