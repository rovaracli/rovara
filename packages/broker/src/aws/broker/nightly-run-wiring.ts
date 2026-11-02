// The nightly run's joints to the broker's own dependencies (NH-1). Every function here is undefined or inert while `nh` (with the test environment `ev`) is off, so the callers' flow is today's flow.
//   nightlyRunsOf         the ports a scheduler fire starts a night with (admit, head, start); undefined while the switches are off, which keeps the fire's answer `run_unavailable`
//   nightlyResultDeps     what the result route records with: the test-environment store and the coverage map store
//   s3CoverageMapStore    the coverage map store: the install's artifact bucket under its own prefix, one object per digest, per company and project
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ROVARA_CODE_AGENT_ID, canonicalJson, type OrgId } from "@agentx/contracts";
import { admitWork } from "../../spend/admission.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import { resolveSurvivor } from "../../agents/access.js";
import { startAgentRun } from "../../agents/runs.js";
import type { TestEnvDeps } from "../../org/test-environment.js";
import { healthWiringOn } from "../../test-env/health-wiring.js";
import type { MapStore, NightlyRunPort } from "../../test-env/nightly.js";
import { nightlyRunPort } from "../../test-env/nightly-run.js";
import type { DeveloperTaskActions } from "../developer-task-actions.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { agentRunStarterFrom } from "./dependency-wiring.js";
import { defaultBranchHeadOf } from "./nightly-head.js";

const sha = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const MAP_READ_MAX_BYTES = 8 * 1_048_576 + 4_096;

/** One object per company, project and digest; the key holds no project name (a name could carry a character a key must not). */
const mapKey = (orgId: OrgId, project: string, digest: string): string => `nightly-maps/${sha([orgId, project]).slice(0, 40)}/${digest}.json`;

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
    resolveOwner: (orgId, developerId) => resolveSurvivor({ signInStore: agents.signInStore, ...(agents.resolveDeveloper === undefined ? {} : { resolveDeveloper: agents.resolveDeveloper }) }, orgId, developerId),
    headOf: ({ orgId, project, branch }) => defaultBranchHeadOf(dependencies, orgId, project, branch),
    startAgentRun: (request) => startAgentRun(starter, request),
  });
}
