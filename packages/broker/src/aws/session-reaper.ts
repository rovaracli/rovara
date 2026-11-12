import { DescribeInstancesCommand, DescribeVolumesCommand, EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SESSION_MAX_LIFETIME_MS, type Ec2RuntimeBinding, type WorkspaceSession } from "@rovara-code/contracts";
import { installOrgIdFromEnvironment } from "../org/resolve.js";
import { requiredEnvironment } from "./lambda.js";
import { PRIVATE_ADDRESS_RECYCLE_PK } from "@agentx/cloud-contracts";
import { markComputeLost } from "./compute-lost.js";
import { failActiveOperation } from "./outbox-failure.js";
import { SessionManager, computeMeteringFromEnvironment, workspaceBinding } from "./sessions.js";

/** Idle stop and maximum compute lifetime (design in #76). */
export const IDLE_STOP_MS = 5 * 60_000;
export const MAX_LIFETIME_MS = SESSION_MAX_LIFETIME_MS;
const WORKER_PORT = 8080;
const PING_TIMEOUT_MS = 2_000;

/** Where a stopping session's instance and volume are. */
export interface StopProgress {
  /** Terminated or no longer found. */
  instanceGone: boolean;
  /** Still running or pending: the terminate has to be sent again. */
  instanceLive: boolean;
  volumeAvailable: boolean;
}

export interface ReaperReport {
  claimed: string[];
  skippedBusy: string[];
  lostRace: string[];
  stopped: string[];
  restarted: string[];
  stillStopping: string[];
  /** Owner decision 128: workers recycled because their company removed an internal address after they launched; present only where the recycle is wired. */
  privateAddressRecycled?: string[];
}

export interface ReaperDependencies {
  sessions: Pick<SessionManager, "listByState" | "claimStop" | "markStopped" | "ensureSession" | "markLost">;
  /** Whether the workspace has an operation in progress. */
  activeOperation: (workspaceId: string) => Promise<boolean>;
  /** GET /ping; resolves to the reported status, rejects when unreachable. */
  ping: (url: string) => Promise<string | undefined>;
  terminate: (instanceId: string) => Promise<void>;
  progress: (instanceId: string, volumeId: string) => Promise<StopProgress>;
  binding: (workspaceId: string) => Promise<Ec2RuntimeBinding | undefined>;
  emit: (metrics: Record<string, number>) => void;
  /**
   * Owner decision 128: each company's latest internal address removal (org id to epoch milliseconds; org/private-addresses.ts PRIVATE_ADDRESS_RECYCLE_PK), and the company a workspace belongs to. A READY worker of that
   * company launched before the removal still has the removed address open, so it is recycled at once: stopped like an idle one when it is idle; when it is busy (or a dispatch just took it), its instance is
   * terminated under its task and, in the same tick, the session is marked lost and the operation failed with the usual "compute was lost; retry" error, through the reconciler's own path (compute-lost.ts), so the
   * task's retry starts at once on a worker launched with the new list. Absent: nothing is recycled.
   */
  privateAddressRecycle?: {
    marks: () => Promise<Map<string, number>>;
    workspaceOrg: (workspaceId: string) => Promise<string | undefined>;
    /** The reconciler's own operation failure (outbox-failure.ts failActiveOperation), used through compute-lost.ts exactly as the reconciler uses it. */
    failActiveOperation: (workspaceId: string, error: string) => Promise<string | undefined>;
  };
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * The idle reaper (issue #85, flow 4 in #76), run every minute. It stops READY sessions idle over
 * five minutes or launched over 14 days ago, then finishes stopping sessions once their instance is
 * gone and their volume detached. It never changes the workspace's status.
 */
export function createReaperHandler(dependencies: ReaperDependencies) {
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify({ component: "session-reaper", ...entry })));
  return async (): Promise<ReaperReport> => {
    const now = (dependencies.now?.() ?? new Date()).getTime();
    const report: ReaperReport = { claimed: [], skippedBusy: [], lostRace: [], stopped: [], restarted: [], stillStopping: [] };

    const ready = await dependencies.sessions.listByState("READY");
    const recycled = dependencies.privateAddressRecycle === undefined ? undefined : await recyclePrivateAddressWorkers(dependencies, dependencies.privateAddressRecycle, ready, report, log);
    for (const session of ready) {
      if (recycled?.has(session.workspaceId) === true) continue;
      const idle = now - Date.parse(session.lastActivityAt!) > IDLE_STOP_MS;
      const expired = now - Date.parse(session.launchedAt!) > MAX_LIFETIME_MS;
      if (!idle && !expired) continue;
      // Never reaped while the broker sees work, or while the worker reports work the broker does not.
      if (await dependencies.activeOperation(session.workspaceId) || await isBusy(dependencies, session)) {
        report.skippedBusy.push(session.workspaceId);
        continue;
      }
      if (!(await dependencies.sessions.claimStop(session))) {
        // A dispatch touched the session or took the workspace first; it stays READY.
        report.lostRace.push(session.workspaceId);
        continue;
      }
      report.claimed.push(session.workspaceId);
      log({ event: "session.stop_claimed", workspaceId: session.workspaceId, generation: session.generation, reason: expired ? "lifetime" : "idle" });
      await terminate(dependencies, session, log);
    }

    for (const session of await dependencies.sessions.listByState("STOPPING")) {
      const progress = await dependencies.progress(session.instanceId!, session.volumeId!);
      if (progress.instanceLive) await terminate(dependencies, session, log);
      if (!progress.instanceGone || !progress.volumeAvailable) {
        report.stillStopping.push(session.workspaceId);
        continue;
      }
      const stopped = await dependencies.sessions.markStopped(session.workspaceId, session.generation);
      report.stopped.push(session.workspaceId);
      // Work that arrived while it was stopping starts the next generation at once.
      if ((stopped.waitingOutboxIds ?? []).length > 0) {
        const binding = await dependencies.binding(session.workspaceId);
        if (binding === undefined) {
          log({ event: "session.restart_skipped", workspaceId: session.workspaceId, reason: "no ec2-ebs binding" });
        } else {
          await dependencies.sessions.ensureSession({ workspaceId: session.workspaceId, binding });
          report.restarted.push(session.workspaceId);
        }
      }
    }

    // The STOPPING query runs after this tick's claims, so it already counts them.
    dependencies.emit({ SessionsStopped: report.stopped.length, SessionsStopping: report.stillStopping.length, ...(report.privateAddressRecycled === undefined ? {} : { SessionsPrivateAddressRecycled: report.privateAddressRecycled.length }) });
    return report;
  };
}

/** A worker launched within this long after a removal may have read the list before it: it is recycled too (once more at most; a launch takes seconds). */
export const RECYCLE_LAUNCH_MARGIN_MS = 2 * 60_000;

async function recyclePrivateAddressWorkers(
  dependencies: ReaperDependencies, recycle: NonNullable<ReaperDependencies["privateAddressRecycle"]>, ready: readonly WorkspaceSession[], report: ReaperReport, log: (entry: Record<string, unknown>) => void,
): Promise<Set<string>> {
  const done = new Set<string>();
  report.privateAddressRecycled = [];
  let marks: Map<string, number>;
  try {
    marks = await recycle.marks();
  } catch (error) {
    // Unreadable: nothing is recycled this tick and the next tick asks again; logged loudly, never silently skipped.
    log({ event: "session.private_address_recycle_unreadable", level: "error", errorName: error instanceof Error ? error.name : "unknown" });
    return done;
  }
  if (marks.size === 0) return done;
  for (const session of ready) {
    let org: string | undefined;
    try { org = await recycle.workspaceOrg(session.workspaceId); } catch { org = undefined; }
    const removedAt = org === undefined ? undefined : marks.get(org);
    if (removedAt === undefined || session.launchedAt === undefined || Date.parse(session.launchedAt) > removedAt + RECYCLE_LAUNCH_MARGIN_MS) continue;
    done.add(session.workspaceId);
    report.privateAddressRecycled.push(session.workspaceId);
    const busy = await dependencies.activeOperation(session.workspaceId) || await isBusy(dependencies, session);
    if (!busy && await dependencies.sessions.claimStop(session)) {
      report.claimed.push(session.workspaceId);
      log({ event: "session.stop_claimed", workspaceId: session.workspaceId, generation: session.generation, reason: "private_address_removed" });
      await terminate(dependencies, session, log);
      continue;
    }
    // Busy (or a dispatch just took it): its task is interrupted. Access must stop now, not when the task ends. A terminate that fails leaves the session READY and the mark in place: the next tick tries again.
    try {
      await dependencies.terminate(session.instanceId!);
    } catch (error) {
      log({ event: "session.terminate_failed", workspaceId: session.workspaceId, instanceId: session.instanceId, error: error instanceof Error ? error.name : "unknown" });
      continue;
    }
    const lost = await markComputeLost({ sessions: dependencies.sessions, failActiveOperation: recycle.failActiveOperation }, session);
    log({ event: "session.private_address_recycle_interrupted", workspaceId: session.workspaceId, generation: session.generation, instanceId: session.instanceId, markedLost: lost.lost, ...(lost.lost && lost.operationId !== undefined ? { failedOperationId: lost.operationId } : {}) });
  }
  return done;
}

async function isBusy(dependencies: ReaperDependencies, session: WorkspaceSession): Promise<boolean> {
  try {
    return await dependencies.ping(`http://${session.privateIp}:${WORKER_PORT}/ping`) === "HealthyBusy";
  } catch {
    // An unreachable worker is doing no work; stopping it frees the instance (the reconciler, #86,
    // handles one that stays unreachable while in use).
    return false;
  }
}

async function terminate(dependencies: ReaperDependencies, session: WorkspaceSession, log: (entry: Record<string, unknown>) => void): Promise<void> {
  try {
    await dependencies.terminate(session.instanceId!);
  } catch (error) {
    // Left STOPPING; the next tick sends the terminate again.
    log({ event: "session.terminate_failed", workspaceId: session.workspaceId, instanceId: session.instanceId, error: error instanceof Error ? error.name : "unknown" });
  }
}

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration));
const ec2 = new EC2Client(awsClientConfiguration);
const sfn = new SFNClient(awsClientConfiguration);
const tableName = process.env.STATE_TABLE_NAME ?? "";

export const handler = createReaperHandler({
  sessions: new SessionManager({
    documentClient,
    tableName,
    ...computeMeteringFromEnvironment(documentClient, tableName),
    executions: {
      provisionerArn: process.env.PROVISIONER_ARN ?? "",
      deleterArn: process.env.DELETER_ARN ?? "",
      async start(input) {
        return (await sfn.send(new StartExecutionCommand(input))).executionArn!;
      },
    },
  }),
  async activeOperation(workspaceId) {
    const item = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true }))).Item;
    return typeof item?.activeOperationId === "string";
  },
  async ping(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    const body = await response.json() as { status?: unknown };
    return typeof body.status === "string" ? body.status : undefined;
  },
  async terminate(instanceId) {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  },
  async progress(instanceId, volumeId) {
    let state: string | undefined;
    try {
      const response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      state = response.Reservations?.[0]?.Instances?.[0]?.State?.Name;
    } catch (error) {
      if (!(error instanceof Error && error.name === "InvalidInstanceID.NotFound")) throw error;
    }
    const volume = (await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }))).Volumes?.[0];
    return {
      instanceGone: state === undefined || state === "terminated",
      instanceLive: state === "running" || state === "pending" || state === "stopped" || state === "stopping",
      volumeAvailable: volume?.State === "available",
    };
  },
  binding: (workspaceId) => workspaceBinding(documentClient, tableName, installOrgIdFromEnvironment(), workspaceId),
  privateAddressRecycle: {
    async marks() {
      const marks = new Map<string, number>();
      let start: Record<string, unknown> | undefined;
      do {
        const page = await documentClient.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": PRIVATE_ADDRESS_RECYCLE_PK }, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }));
        for (const item of page.Items ?? []) if (typeof item.orgId === "string" && typeof item.removedAt === "number") marks.set(item.orgId, item.removedAt);
        start = page.LastEvaluatedKey;
      } while (start !== undefined);
      return marks;
    },
    failActiveOperation: (workspaceId, error) => failActiveOperation(documentClient, tableName, workspaceId, error),
    async workspaceOrg(workspaceId) {
      const item = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true }))).Item;
      return typeof item?.orgId === "string" ? item.orgId : undefined;
    },
  },
  emit(metrics) {
    // CloudWatch embedded metric format: Lambda turns this stdout line into metrics.
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: requiredEnvironment("AGENTX_METRICS_NAMESPACE"), Dimensions: [[]], Metrics: Object.keys(metrics).map((Name) => ({ Name, Unit: "Count" })) }],
      },
      component: "session-reaper",
      event: "metric",
      ...metrics,
    }));
  },
});
