// The nightly run's joints to the broker's own dependencies (NH-1). Every function here is undefined or inert while `nh` (with the test environment `ev`) is off, so the callers' flow is today's flow.
//   nightlyRunsOf         the ports a scheduler fire starts a night with (admit, head, start); undefined while the switches are off, which keeps the fire's answer `run_unavailable`
//   nightlyResultDeps     what the result route records with: the test-environment store and the coverage map store
//   s3CoverageMapStore    the coverage map store: the install's artifact bucket under its own prefix, one object per digest, per company and project
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ROVARA_CODE_AGENT_ID, canonicalJson } from "@agentx/contracts";
import { admitWork } from "../../spend/admission.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import { startAgentRun } from "../../agents/runs.js";
import type { TestEnvDeps } from "../../org/test-environment.js";
import { healthWiringOn } from "../../test-env/health-wiring.js";
import type { MapStore, NightlyRunPort } from "../../test-env/nightly.js";
import { nightlyMapKey } from "../../test-env/map-keys.js";
import { sweepAutomaticRuns, type AutomaticRunSweepReport } from "../../automatic-runs/end.js";
import { developerTaskIdentity } from "../../developer/task-records.js";
import { requireOrgId } from "../../org/resolve.js";
import { releaseIfFinished } from "./terminal-and-github-events.js";
import { startAutomaticRun, type AutomaticRunDependencies, type AutomaticRunInput, type AutomaticRunOutcome } from "../../automatic-runs/start.js";
import { nightlyRunPort } from "../../test-env/nightly-run.js";
import type { DeveloperTaskActions } from "../developer-task-actions.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { agentRouteDependencies, agentRunStarterFrom, brokerDependencies, developerTaskActions } from "./dependency-wiring.js";
import type { AwsBrokerInput } from "./definitions.js";
import { defaultBranchHeadOf, projectUsesRegistries, repositoryDefaultBranchOf } from "./nightly-head.js";

const MAP_READ_MAX_BYTES = 8 * 1_048_576 + 4_096;
const mapKey = nightlyMapKey;

export function s3CoverageMapStore(s3: { send(command: never): Promise<unknown> }, bucket: string): MapStore {
  return {
    async put(orgId, project, map) {
      const body = canonicalJson(map);
      const digest = createHash("sha256").update(body).digest("hex");
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: mapKey(orgId, project, digest), Body: body, ContentType: "application/json" }) as never);
      return digest;
    },
    async get(orgId, project, digest) {
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: mapKey(orgId, project, digest), Range: `bytes=0-${MAP_READ_MAX_BYTES - 1}` }) as never) as { Body?: { transformToString(encoding?: string): Promise<string> } };
        return object.Body === undefined ? undefined : JSON.parse(await object.Body.transformToString("utf8")) as unknown;
      } catch {
        return undefined;
      }
    },
  };
}

export function nightlyResultDeps(dependencies: AwsBrokerDependencies): TestEnvDeps & { maps: MapStore } {
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    maps: s3CoverageMapStore(dependencies.s3, dependencies.artifactBucketName),
  };
}

/**
 * What every automatic job starts its run with (the system owner of automatic runs, owner decision 2026-11-02): `startAutomaticRun` bound to this install's table, audit trail and shared run start. Undefined where runs cannot
 * be started (no agents). It checks NO switch: each job (the nightly run behind `nh`, a saved image's rebuild behind its own) decides whether it runs, and then starts through this. The saved-environments lane calls it
 * for a rebuild: `automaticRunStarterOf(...)?.({ orgId, project, job: "image_rebuild", requestId, agent, input, origin, setupApprovedBy })`.
 */
export function automaticRunStarterOf(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined): ((input: AutomaticRunInput) => Promise<AutomaticRunOutcome>) | undefined {
  const starter = agentRunStarterFrom(dependencies, tasks, agents);
  if (starter === undefined) return undefined;
  const deps: AutomaticRunDependencies = {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    startAgentRun: (request) => startAgentRun(starter, request),
  };
  return (input) => startAutomaticRun(deps, input);
}

/**
 * The session sweep's job for automatic runs: a run past its time is cancelled on its worker (as the task's own system identity, best effort), ended, its slot given back and the end audited. Never throws: a failure is
 * logged and the sweep's other jobs go on.
 */
export async function sweepAutomaticRunsOf(dependencies: AwsBrokerDependencies, now: () => number = Date.now): Promise<AutomaticRunSweepReport | "failed"> {
  const actions = developerTaskActions(dependencies);
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }));
  try {
    return await sweepAutomaticRuns({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }), log,
      cancelLive: async (task) => {
        const workspace = await actions.workspace(task.workspaceId);
        if (workspace.status !== "CLOSED" && workspace.activeOperationId != null) await actions.cancelRunning(developerTaskIdentity(task, requireOrgId(task.orgId)), workspace, () => []);
      },
      release: (taskId) => releaseIfFinished(dependencies, taskId),
    });
  } catch (error) {
    log({ event: "automatic_run.sweep_failed", error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

/** `automaticRunStarterOf` from the broker's input, as the other broker factories (`createAgentRunStarter`) are: what a test, or the saved-environments lane's rebuild job, builds its starter from. */
export function createAutomaticRunStarter(input: AwsBrokerInput): ReturnType<typeof automaticRunStarterOf> {
  const dependencies = brokerDependencies(input);
  const tasks = developerTaskActions(dependencies);
  return automaticRunStarterOf(dependencies, tasks, agentRouteDependencies(dependencies, tasks));
}

export function nightlyRunsOf(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies | undefined, env: NodeJS.ProcessEnv = process.env): NightlyRunPort | undefined {
  if (!healthWiringOn(env)) return undefined;
  const starter = agentRunStarterFrom(dependencies, tasks, agents);
  if (starter === undefined || agents === undefined) return undefined;
  const admission = dependencies.modelAccess === undefined ? undefined
    : { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: dependencies.modelAccess.access, now: Date.now, cloud: dependencies.cloud === true };
  return nightlyRunPort({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    // The same admission a task meets (the budget floor of every level the work counts against, the trial, the month's machine time), with the project as payer. An install without a model proxy has no budgets to read.
    admitProject: async ({ orgId, project }) => {
      if (admission === undefined) return;
      await admitWork(admission, { orgId, payer: { kind: "project", project }, project, agentId: ROVARA_CODE_AGENT_ID, agentName: "Rovara Code", path: "QUICK" });
    },
    defaultBranchOf: ({ orgId, project }) => repositoryDefaultBranchOf(dependencies, orgId, project),
    usesRegistries: ({ orgId, project }) => projectUsesRegistries(dependencies, orgId, project),
    headOf: ({ orgId, project, branch }) => defaultBranchHeadOf(dependencies, orgId, project, branch),
    startAgentRun: (request) => startAgentRun(starter, request),
  });
}
