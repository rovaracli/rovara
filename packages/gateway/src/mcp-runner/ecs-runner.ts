// Stdio MCP host redesign (T6), design sections 2, 6 and 7: the ECS task runner. It starts, describes, lists and stops the Fargate tasks that hold customer code, through the narrow
// `EcsApi` below (the real ECS client is adapted to it by the broker's main.ts, so this file imports no cloud SDK and is tested against a fake).
//
// What it holds to, whatever it is asked:
//   - the task definition family always starts with `rovara-mcp-`, and the task runs in the configured cluster, in the configured (runner) subnets, with no public address;
//   - the task's only per-task values are environment overrides for named containers, and nothing else is overridden: no command, no image, no role, no user;
//   - a task is tagged with its server, its purpose and its approval, so the controller can find and stop leftovers from the cloud's records alone;
//   - no interactive shell into a task (`enableExecuteCommand: false`).
import { RUNNER_FAMILY_PREFIX, RUNNER_PURPOSES, type RunnerPurpose, type RunnerTaskInfo, type RunnerTaskSpec, type RunnerTaskStatus, type StopReason, type TaskRunner } from "./task-runner.js";

export const ECS_TAG = { server: "rovara:server", purpose: "rovara:purpose", approval: "rovara:approval", family: "rovara:family" } as const;
/** `startedBy` is `rovara-mcp-<instance id>`: it says which controller instance started a task, so one instance never judges the tasks of another that is alive. */
export const ECS_STARTED_BY_PREFIX = "rovara-mcp-";

export interface EcsRunTaskInput {
  cluster: string;
  taskDefinition: string;
  count: 1;
  launchType: "FARGATE";
  startedBy: string;
  enableExecuteCommand: false;
  networkConfiguration: { awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: "DISABLED" } };
  overrides: { containerOverrides: Array<{ name: string; environment: Array<{ name: string; value: string }> }> };
  tags: Array<{ key: string; value: string }>;
}

export interface EcsTaskDescription {
  taskArn: string;
  /** PROVISIONING, PENDING, ACTIVATING, RUNNING, DEACTIVATING, STOPPING, DEPROVISIONING, STOPPED. */
  lastStatus: string;
  startedAt?: Date | undefined;
  createdAt?: Date | undefined;
  tags: Array<{ key: string; value: string }>;
  /** Who started the task, as given to RunTask. */
  startedBy?: string | undefined;
  /** The task definition revision it runs (its ARN). The family in it, not a tag, says what kind of task it is. */
  taskDefinitionArn?: string | undefined;
  /** The private IPv4 address of the task's network interface, when it has one. */
  privateIpv4?: string | undefined;
  /** Exit codes of the containers that stopped, by name. */
  exitCodes?: Record<string, number | undefined> | undefined;
}

export interface EcsApi {
  runTask(input: EcsRunTaskInput): Promise<{ taskArns: string[]; failureCount: number }>;
  stopTask(input: { cluster: string; taskArn: string; reason: string }): Promise<void>;
  describeTasks(input: { cluster: string; taskArns: string[] }): Promise<EcsTaskDescription[]>;
  /** The ARNs of every task in the cluster that is not stopped, whoever started it. Pages are followed by the adapter. */
  listTaskArns(input: { cluster: string }): Promise<string[]>;
}

export interface EcsRunnerConfig {
  api: EcsApi;
  cluster: string;
  /** The runner subnets (no NAT, no internet route). */
  subnets: readonly string[];
  /** Used by an install task, which has no security group of its own. A serve or probe task is never started in it. */
  defaultSecurityGroupId: string;
  /** The port the bridge listens on. */
  bridgePort?: number;
  /** This controller instance: a random id of this process. It is in `startedBy`. */
  instanceId: string;
  /** The static install task family (default `rovara-mcp-install`). */
  installFamily?: string;
}

const FAMILY = /^rovara-mcp-[A-Za-z0-9_-]{1,200}$/u;
const SERVER_TAG = /^(?:mcp[a-z0-9]{6,24}|install|probe[a-z0-9]{6,24})$/u;
const APPROVAL = /^(?:[0-9a-f]{12})?$/u;
const CONTAINER = /^[a-z][a-z0-9-]{0,63}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SUBNET = /^subnet-[0-9a-f]{8,17}$/u;
const SECURITY_GROUP = /^sg-[0-9a-f]{8,17}$/u;
const REVISION_ARN = /^arn:aws(?:-[a-z]+)*:ecs:[a-z0-9-]+:\d{12}:task-definition\/(rovara-mcp-[A-Za-z0-9_-]{1,200}):[1-9]\d{0,8}$/u;
const INSTANCE_ID = /^[A-Za-z0-9]{8,64}$/u;
const TASK_DEFINITION_ARN = /^arn:aws(?:-[a-z]+)*:ecs:[a-z0-9-]+:\d{12}:task-definition\/(rovara-mcp-[A-Za-z0-9_-]{1,200}):\d+$/u;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const TASK_ARN = /^arn:aws(?:-[a-z]+)*:ecs:[a-z0-9-]+:\d{12}:task\/[A-Za-z0-9_-]{1,255}\/[0-9a-f]{8,64}$/u;
const MAX_ENV_VALUE_BYTES = 8_192;
const MAX_ENV_PER_CONTAINER = 16;

function tagValue(tags: ReadonlyArray<{ key: string; value: string }>, key: string): string | undefined {
  return tags.find((tag) => tag.key === key)?.value;
}

function statusOf(raw: string): "pending" | "running" | "stopped" {
  if (raw === "RUNNING") return "running";
  if (raw === "PROVISIONING" || raw === "PENDING" || raw === "ACTIVATING") return "pending";
  return "stopped";
}

export function ecsTaskRunner(config: EcsRunnerConfig): TaskRunner {
  if (config.subnets.length === 0 || config.subnets.length > 16 || !config.subnets.every((subnet) => SUBNET.test(subnet))) throw new Error("the runner needs between 1 and 16 subnets");
  if (!SECURITY_GROUP.test(config.defaultSecurityGroupId)) throw new Error("the runner's default security group is not valid");
  if (!INSTANCE_ID.test(config.instanceId)) throw new Error("the instance id is not valid");
  const port = config.bridgePort ?? 8_080;
  const installFamily = config.installFamily ?? `${RUNNER_FAMILY_PREFIX}install`;
  const startedBy = `${ECS_STARTED_BY_PREFIX}${config.instanceId}`;
  /**
   * What kind of task this is, from the family of the revision it runs (the cloud's own record) and, for the details, its tags. A task in a `rovara-mcp-serve-`, `rovara-mcp-probe-` or
   * install family is ours however it was started and even if it has no tags; any other task (the controller's own service, say) is not.
   */
  const classify = (task: EcsTaskDescription): Omit<RunnerTaskInfo, "startedAt" | "state"> | undefined => {
    if (!TASK_ARN.test(task.taskArn)) return undefined;
    const family = (task.taskDefinitionArn === undefined ? undefined : TASK_DEFINITION_ARN.exec(task.taskDefinitionArn)?.[1]) ?? tagValue(task.tags, ECS_TAG.family);
    if (family === undefined || !FAMILY.test(family)) return undefined;
    const purpose: RunnerPurpose | undefined = family.startsWith("rovara-mcp-serve-") ? "serve" : family.startsWith("rovara-mcp-probe-") ? "probe" : family === installFamily ? "install" : undefined;
    if (purpose === undefined) return undefined;
    const idFromFamily = purpose === "install" ? "install" : family.slice(`rovara-mcp-${purpose}-`.length);
    const by = task.startedBy;
    return {
      taskId: task.taskArn, purpose, serverId: tagValue(task.tags, ECS_TAG.server) ?? idFromFamily, approval: tagValue(task.tags, ECS_TAG.approval) ?? "", family,
      owner: by !== undefined && by.startsWith(ECS_STARTED_BY_PREFIX) ? by.slice(ECS_STARTED_BY_PREFIX.length) : "",
    };
  };

  return {
    instanceId: config.instanceId,
    async start(spec: RunnerTaskSpec): Promise<string> {
      if (!FAMILY.test(spec.family) || !spec.family.startsWith(RUNNER_FAMILY_PREFIX)) throw new Error("the task family is not allowed");
      // A serve or probe task runs the exact revision the controller checked (its ARN, of this family). Only an install task may name a family: the infrastructure owns that one.
      const revision = REVISION_ARN.exec(spec.taskDefinition);
      if (revision !== null ? revision[1] !== spec.family : (spec.purpose !== "install" || spec.taskDefinition !== spec.family)) throw new Error("the task definition is not the checked revision");
      if (!RUNNER_PURPOSES.includes(spec.purpose) || !SERVER_TAG.test(spec.serverId) || !APPROVAL.test(spec.approval)) throw new Error("the task's tags are not valid");
      if (spec.securityGroupId !== undefined && !SECURITY_GROUP.test(spec.securityGroupId)) throw new Error("the security group is not valid");
      // A serve or probe task always has the group made for its server (the approved destinations only). The default group is the install task's, which reaches the registry: a task that
      // holds customer code never falls back to it.
      if (spec.purpose !== "install" && spec.securityGroupId === undefined) throw new Error("a serve or probe task needs its own security group");
      const containerOverrides = Object.entries(spec.containers).map(([name, variables]) => {
        if (!CONTAINER.test(name)) throw new Error("a container name is not valid");
        const entries = Object.entries(variables);
        if (entries.length > MAX_ENV_PER_CONTAINER) throw new Error("a container has too many variables");
        return { name, environment: entries.map(([variable, value]) => {
          if (!ENV_NAME.test(variable) || Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES) throw new Error("a variable is not valid");
          return { name: variable, value };
        }) };
      });
      const result = await config.api.runTask({
        cluster: config.cluster, taskDefinition: spec.taskDefinition, count: 1, launchType: "FARGATE", startedBy, enableExecuteCommand: false,
        networkConfiguration: { awsvpcConfiguration: { subnets: [...config.subnets], securityGroups: [spec.securityGroupId ?? config.defaultSecurityGroupId], assignPublicIp: "DISABLED" } },
        overrides: { containerOverrides },
        tags: [
          { key: ECS_TAG.server, value: spec.serverId }, { key: ECS_TAG.purpose, value: spec.purpose }, { key: ECS_TAG.approval, value: spec.approval }, { key: ECS_TAG.family, value: spec.family },
        ],
      });
      const arn = result.taskArns[0];
      if (arn === undefined || result.failureCount > 0 || result.taskArns.length !== 1 || !TASK_ARN.test(arn)) {
        // Anything started beyond the one asked for is stopped: a half-started pair would be a task nobody tracks.
        await Promise.all(result.taskArns.map((taskArn) => config.api.stopTask({ cluster: config.cluster, taskArn, reason: "failed" }).catch(() => undefined)));
        throw new Error("the task did not start");
      }
      return arn;
    },

    async stop(taskId: string, reason: StopReason): Promise<void> {
      if (!TASK_ARN.test(taskId)) throw new Error("the task id is not valid");
      try { await config.api.stopTask({ cluster: config.cluster, taskArn: taskId, reason }); } catch (error) {
        // A task that is already gone is stopped.
        if ((error as { name?: unknown } | null)?.name === "InvalidParameterException" || (error as { name?: unknown } | null)?.name === "ResourceNotFoundException") return;
        throw error;
      }
    },

    async describe(taskId: string): Promise<RunnerTaskStatus | undefined> {
      if (!TASK_ARN.test(taskId)) return undefined;
      const task = (await config.api.describeTasks({ cluster: config.cluster, taskArns: [taskId] })).find((item) => item.taskArn === taskId);
      if (task === undefined || classify(task) === undefined) return undefined;
      const state = statusOf(task.lastStatus);
      if (state === "stopped") {
        const codes = Object.values(task.exitCodes ?? {}).filter((code): code is number => typeof code === "number");
        return { state, ...(codes.find((code) => code !== 0) === undefined ? {} : { exitCode: codes.find((code) => code !== 0)! }) };
      }
      // The address comes from the cloud's description of the task, never from a request, and is a plain IPv4 address.
      const ip = task.privateIpv4;
      const address = ip !== undefined && IPV4.test(ip) ? ip : undefined;
      if (state === "pending") return { state, ...(address === undefined ? {} : { address }) };
      return address === undefined ? { state } : { state, address, endpoint: `http://${address}:${port}` };
    },

    async list(): Promise<RunnerTaskInfo[]> {
      const arns = (await config.api.listTaskArns({ cluster: config.cluster })).filter((arn) => TASK_ARN.test(arn));
      const found: RunnerTaskInfo[] = [];
      // DescribeTasks takes 100 tasks at a time.
      for (let index = 0; index < arns.length; index += 100) {
        for (const task of await config.api.describeTasks({ cluster: config.cluster, taskArns: arns.slice(index, index + 100) })) {
          const kind = classify(task);
          if (kind === undefined) continue;
          const state = statusOf(task.lastStatus);
          if (state === "stopped") continue;
          found.push({ ...kind, startedAt: (task.startedAt ?? task.createdAt)?.getTime() ?? 0, state });
        }
      }
      return found;
    },
  };
}
