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
/** What the controller puts in `startedBy`, so ListTasks returns its tasks and not the controller's own. */
export const ECS_STARTED_BY = "rovara-mcp-controller";

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
  /** The private IPv4 address of the task's network interface, when it has one. */
  privateIpv4?: string | undefined;
  /** Exit codes of the containers that stopped, by name. */
  exitCodes?: Record<string, number | undefined> | undefined;
}

export interface EcsApi {
  runTask(input: EcsRunTaskInput): Promise<{ taskArns: string[]; failureCount: number }>;
  stopTask(input: { cluster: string; taskArn: string; reason: string }): Promise<void>;
  describeTasks(input: { cluster: string; taskArns: string[] }): Promise<EcsTaskDescription[]>;
  /** The ARNs of the tasks this controller started (`startedBy`) that are not stopped. Pages are followed by the adapter. */
  listTaskArns(input: { cluster: string; startedBy: string }): Promise<string[]>;
}

export interface EcsRunnerConfig {
  api: EcsApi;
  cluster: string;
  /** The runner subnets (no NAT, no internet route). */
  subnets: readonly string[];
  /** Used when a task has no security group of its own (install tasks). */
  defaultSecurityGroupId: string;
  /** The port the bridge listens on. */
  bridgePort?: number;
}

const FAMILY = /^rovara-mcp-[A-Za-z0-9_-]{1,200}$/u;
const SERVER_TAG = /^(?:mcp[a-z0-9]{6,24}|install|probe[a-z0-9]{6,24})$/u;
const APPROVAL = /^(?:[0-9a-f]{12})?$/u;
const CONTAINER = /^[a-z][a-z0-9-]{0,63}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SUBNET = /^subnet-[0-9a-f]{8,17}$/u;
const SECURITY_GROUP = /^sg-[0-9a-f]{8,17}$/u;
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
  const port = config.bridgePort ?? 8_080;
  const owns = (task: EcsTaskDescription): boolean => TASK_ARN.test(task.taskArn) && RUNNER_PURPOSES.includes(tagValue(task.tags, ECS_TAG.purpose) as RunnerPurpose) && FAMILY.test(tagValue(task.tags, ECS_TAG.family) ?? "");

  return {
    async start(spec: RunnerTaskSpec): Promise<string> {
      if (!FAMILY.test(spec.family) || !spec.family.startsWith(RUNNER_FAMILY_PREFIX)) throw new Error("the task family is not allowed");
      if (!RUNNER_PURPOSES.includes(spec.purpose) || !SERVER_TAG.test(spec.serverId) || !APPROVAL.test(spec.approval)) throw new Error("the task's tags are not valid");
      if (spec.securityGroupId !== undefined && !SECURITY_GROUP.test(spec.securityGroupId)) throw new Error("the security group is not valid");
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
        cluster: config.cluster, taskDefinition: spec.family, count: 1, launchType: "FARGATE", startedBy: ECS_STARTED_BY, enableExecuteCommand: false,
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
      if (task === undefined || !owns(task)) return undefined;
      const state = statusOf(task.lastStatus);
      if (state === "stopped") {
        const codes = Object.values(task.exitCodes ?? {}).filter((code): code is number => typeof code === "number");
        return { state, ...(codes.find((code) => code !== 0) === undefined ? {} : { exitCode: codes.find((code) => code !== 0)! }) };
      }
      if (state === "pending") return { state };
      // The address comes from the cloud's description of the task, never from a request, and is a plain IPv4 address.
      const ip = task.privateIpv4;
      return ip !== undefined && IPV4.test(ip) ? { state, endpoint: `http://${ip}:${port}` } : { state };
    },

    async list(): Promise<RunnerTaskInfo[]> {
      const arns = (await config.api.listTaskArns({ cluster: config.cluster, startedBy: ECS_STARTED_BY })).filter((arn) => TASK_ARN.test(arn));
      const found: RunnerTaskInfo[] = [];
      // DescribeTasks takes 100 tasks at a time.
      for (let index = 0; index < arns.length; index += 100) {
        for (const task of await config.api.describeTasks({ cluster: config.cluster, taskArns: arns.slice(index, index + 100) })) {
          if (!owns(task)) continue;
          const state = statusOf(task.lastStatus);
          if (state === "stopped") continue;
          found.push({
            taskId: task.taskArn, purpose: tagValue(task.tags, ECS_TAG.purpose) as RunnerPurpose, serverId: tagValue(task.tags, ECS_TAG.server) ?? "", approval: tagValue(task.tags, ECS_TAG.approval) ?? "",
            family: tagValue(task.tags, ECS_TAG.family)!, startedAt: (task.startedAt ?? task.createdAt)?.getTime() ?? 0, state,
          });
        }
      }
      return found;
    },
  };
}
