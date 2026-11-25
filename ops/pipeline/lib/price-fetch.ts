// L6: the gateway's daily price fetch, seen from the pipeline (BETA-CLOUD-PLAN 3.6). Freshness is read from the price-fetch task's own log group: the task logs
// `price_fetched` only after BOTH sources fetched and the snapshot saved (packages/model-gateway/src/process.ts runPriceFetch), so one such event inside the
// window means every source is that fresh. The names (cluster, task, schedule rule, log group) carry generated suffixes, so they are read from the gateway stack's
// resources through the CDK deploy role (the release role cannot list stack resources); the one-off run copies the schedule target's network settings and passes
// no overrides, no tags and no execute-command, as the release role's policy requires (BETA-RELEASE-ROLE-PREP.md 2.2).
import { stackName } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { StageError } from "../types.ts";
import type { PipelineEnv, Ports } from "../types.ts";

export const PRICE_MAX_AGE_MS = 48 * 3_600_000;
export const TASK_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 15_000;

export interface PriceFetchResources { cluster: string; taskDefinition: string; rule: string; logGroup: string }

interface Resource { LogicalResourceId?: string; ResourceType?: string; PhysicalResourceId?: string }

const one = (resources: readonly Resource[], type: string, prefix: string, what: string): string => {
  const found = resources.filter((r) => r.ResourceType === type && (r.LogicalResourceId ?? "").startsWith(prefix) && typeof r.PhysicalResourceId === "string" && r.PhysicalResourceId !== "");
  if (found.length !== 1) throw new StageError("REFUSED", `expected exactly one ${what} in the gateway stack, found ${found.length}`);
  return found[0]!.PhysicalResourceId!;
};

/** Reads the gateway stack's resources (list-stack-resources: the CLI pages through all of them; describe-stack-resources stops at 100) as the CDK deploy role (STUB for a read-only port; asked of L2 in L2-STAGE-CLI-INTERFACE.md "Questions from L6"). */
export async function locatePriceFetch(ports: Ports, config: PipelineConfig, env: PipelineEnv, region: string, exec8: string): Promise<PriceFetchResources> {
  const account = await ports.sts.account();
  const role = `arn:aws:iam::${account}:role/cdk-${config.bootstrapQualifier}-deploy-role-${account}-${region}`;
  const assumed = (await ports.aws.json(["sts", "assume-role", "--role-arn", role, "--role-session-name", `rovara-pipeline-price-${exec8}`])) as { Credentials?: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string } } | null;
  if (assumed?.Credentials === undefined) throw new StageError("FAILED", "the CDK deploy role gave no credentials");
  const stack = stackName(config, env, "gateway");
  const doc = (await ports.aws.json(["cloudformation", "list-stack-resources", "--stack-name", stack], {
    profile: null,
    env: { AWS_ACCESS_KEY_ID: assumed.Credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: assumed.Credentials.SecretAccessKey, AWS_SESSION_TOKEN: assumed.Credentials.SessionToken },
  })) as { StackResourceSummaries?: Resource[] } | null;
  const resources = doc?.StackResourceSummaries ?? [];
  return {
    cluster: one(resources, "AWS::ECS::Cluster", "", "ECS cluster"),
    taskDefinition: one(resources, "AWS::ECS::TaskDefinition", "PriceFetchTask", "price-fetch task definition"),
    rule: one(resources, "AWS::Events::Rule", "PriceFetchSchedule", "price-fetch schedule rule"),
    logGroup: one(resources, "AWS::Logs::LogGroup", "PriceFetchLogs", "price-fetch log group"),
  };
}

/** The newest `price_fetched` event at or after `sinceMs` (epoch ms), or null. */
export async function newestFetch(ports: Ports, logGroup: string, sinceMs: number): Promise<number | null> {
  const doc = (await ports.aws.json(["logs", "filter-log-events", "--log-group-name", logGroup, "--filter-pattern", '{ $.event = "price_fetched" }', "--start-time", String(sinceMs)])) as { events?: Array<{ timestamp?: number }> } | null;
  const stamps = (doc?.events ?? []).map((e) => e.timestamp).filter((t): t is number => typeof t === "number");
  return stamps.length === 0 ? null : Math.max(...stamps);
}

interface Target { Arn?: string; EcsParameters?: { LaunchType?: string; NetworkConfiguration?: { awsvpcConfiguration?: { Subnets?: string[]; SecurityGroups?: string[]; AssignPublicIp?: string } } } }

/** One run of the price-fetch task with the schedule's own network settings; resolves when the task stopped with exit code 0. */
/** `clientToken` makes a CLI retry of the same run-task call return the same task instead of starting a second one. */
export async function runPriceFetchOnce(ports: Ports, resources: PriceFetchResources, clientToken: string, log: (line: string) => void): Promise<void> {
  const targets = (await ports.aws.json(["events", "list-targets-by-rule", "--rule", resources.rule])) as { Targets?: Target[] } | null;
  const target = targets?.Targets?.[0];
  const net = target?.EcsParameters?.NetworkConfiguration?.awsvpcConfiguration;
  if (target === undefined || typeof target.Arn !== "string" || net === undefined || (net.Subnets ?? []).length === 0) throw new StageError("REFUSED", "the price-fetch schedule has no ECS target with network settings to copy");
  if (!target.Arn.endsWith(`/${resources.cluster}`)) throw new StageError("REFUSED", "the price-fetch schedule targets a different cluster than the gateway stack's: not running anything there");
  const network = JSON.stringify({ awsvpcConfiguration: { subnets: net.Subnets, securityGroups: net.SecurityGroups ?? [], assignPublicIp: net.AssignPublicIp ?? "DISABLED" } });
  const started = (await ports.aws.json(["ecs", "run-task", "--cluster", target.Arn, "--task-definition", resources.taskDefinition, "--launch-type", target.EcsParameters?.LaunchType ?? "FARGATE", "--count", "1", "--client-token", clientToken, "--network-configuration", network])) as { tasks?: Array<{ taskArn?: string }>; failures?: Array<{ reason?: string }> } | null;
  const taskArn = started?.tasks?.[0]?.taskArn;
  if (typeof taskArn !== "string") throw new StageError("FAILED", `ECS did not start the price-fetch task: ${(started?.failures ?? []).map((f) => f.reason ?? "unknown").join(", ") || "no reason given"}`);
  log(`price fetch task started; waiting for it to stop`);
  const begun = ports.clock.now().getTime();
  for (;;) {
    const doc = (await ports.aws.json(["ecs", "describe-tasks", "--cluster", target.Arn, "--tasks", taskArn])) as { tasks?: Array<{ lastStatus?: string; stoppedReason?: string; containers?: Array<{ exitCode?: number; reason?: string }> }> } | null;
    const task = doc?.tasks?.[0];
    if (task?.lastStatus === "STOPPED") {
      const container = task.containers?.[0];
      if (container?.exitCode === 0) return;
      throw new StageError("FAILED", `the price-fetch task stopped with exit code ${container?.exitCode ?? "none"} (${container?.reason ?? task.stoppedReason ?? "no reason given"})`);
    }
    if (ports.clock.now().getTime() - begun > TASK_TIMEOUT_MS) throw new StageError("FAILED", "the price-fetch task did not stop within 20 minutes");
    await ports.clock.sleep(POLL_MS);
  }
}
