// Design review stage, DR7 slice B: the broker's own functions behind the round's ports. Everything that reaches outside the design-review folder (the code hosts, the context-tools route, the model proxy, the ledger, the
// artifact store) is gathered here, so `round-start.ts` and `round-record.ts` read no store and call no host by themselves and the tests can give them fakes.
import { randomUUID } from "node:crypto";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { DESIGN_REVIEW_ARTIFACT, ModelSelectionSchema, PER_TASK_BUDGET_USD, metaRepositoryOf, type ModelSelection, type OrgId } from "@agentx/contracts";
import { queryAllItems } from "../aws/admin-reads.js";
import type { OperationRecord } from "../aws/cancellation.js";
import type { AwsBrokerDependencies } from "../aws/broker/definitions.js";
import { requireRecordProject } from "../aws/broker/dependency-wiring.js";
import { contextToolsDependencies } from "../aws/broker/context-tools.js";
import { hostOfRepository } from "../aws/broker/repository-hosts.js";
import { githubScopeOf } from "../aws/broker/scope-helpers.js";
import { callContextTool } from "../context-sources/routes.js";
import { readObjectText } from "../developer/plan-artifacts.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { readSpendPolicy } from "../spend/settings.js";
import { supersedeKeys, type LedgerDependencies } from "../spend/ledger.js";
import { taskRunRoomUsd } from "../spend/admission.js";
import { readDesignReviewLock } from "./lock.js";
import { mcpItemReaderOf, type PacketReaders } from "./packet.js";
import { designReviewProxyCheck } from "./proxy-check.js";
import { originOf } from "./round-inputs.js";
import type { DesignReviewRoundPorts, RoundSourceReaders } from "./round-ports.js";
import type { RoundRecordPorts } from "./round-record.js";

/** The most of a design-review result that is read back: the artifact limit. A result cut short is not valid JSON and counts as no result. */
const RESULT_READ_MAX_BYTES = 5_000_001;

/** The readers of one task's packet sources: the code host the repository's record names (a repository on any registered host is read from that host), and the context-tools route for MCP items. A reader that cannot answer throws or answers nothing, and the source is left out. */
async function sourceReadersOf(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, operationId: string): Promise<RoundSourceReaders> {
  if (task.orgId === undefined || task.startingRevision === undefined) return { readers: { readRepoFile: async () => undefined, readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: false }) }, repositoryNames: [], origin: [] };
  const orgId = task.orgId;
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  const repositories = project.definition.repositories;
  const meta = metaRepositoryOf(project.definition);
  const scope = await githubScopeOf(dependencies, task);
  const fileAt = async (record: (Parameters<typeof hostOfRepository>[1] & { url: string }) | undefined, path: string, commit: string, maxBytes: number): Promise<string | undefined> =>
    record === undefined ? undefined : hostOfRepository(dependencies, record).fileAtRevision({ url: record.url }, path, commit, scope, { maxBytes });
  const context = contextToolsDependencies(dependencies);
  const configured = context === undefined ? [] : (await context.sources(orgId, task.project)).sources.filter((source) => source.stages.includes("PLAN_CRITIQUE"));
  const origin = originOf(task.origin, configured);
  const fetchMcpItem: PacketReaders["fetchMcpItem"] = context === undefined ? async () => ({ ok: false }) : mcpItemReaderOf(
    (request) => callContextTool(context, { orgId, task, operation: { id: operationId, workflowMode: "PLAN_CRITIQUE" } }, request),
    { sources: configured, now: Date.now, newRequestId: randomUUID, origin },
  );
  return {
    readers: {
      readRepoFile: async ({ repo, path, commit, maxBytes }) => { const record = repositories.find((candidate) => candidate.name === repo); return fileAt(record, path, commit, maxBytes); },
      readMetaFile: async ({ path, commit, maxBytes }) => fileAt(meta, path, commit, maxBytes),
      fetchMcpItem,
    },
    repositoryNames: repositories.map((repository) => repository.name), origin,
  };
}

/** What the round's start needs, from the broker's dependencies. */
export function designReviewPortsOf(dependencies: AwsBrokerDependencies): DesignReviewRoundPorts {
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  return {
    table, now: Date.now, proxy: () => designReviewProxyCheck(dependencies),
    price: (model) => { const price = listPricesPerMillion(model); return price === undefined ? undefined : { inputUsdPerMTok: price.input, outputUsdPerMTok: price.output, ...(price.cacheRead > 0 ? { cacheReadUsdPerMTok: price.cacheRead } : {}), ...(price.cacheWrite > 0 ? { cacheWriteUsdPerMTok: price.cacheWrite } : {}) }; },
    // A lock that cannot be read offers no raise at all (a ceiling of 0): never a looser rule than the company's.
    capCeilingUsd: async (orgId) => {
      const lock = await readDesignReviewLock(table, orgId).catch(() => ({ kind: "unreadable" as const }));
      return lock.kind === "lock" ? lock.lock.capCeilingUsd : lock.kind === "unreadable" ? 0 : undefined;
    },
    // What is left of the task's run limit, by the same arithmetic as the key mint's own (the stop-at limit and a test run's cap, less what the task's keys have spent).
    taskRoomUsd: async (task) => {
      if (dependencies.modelAccess === undefined || task.orgId === undefined) return 0;
      const runLimitUsd = task.budgetUsd ?? PER_TASK_BUDGET_USD;
      const testCapUsd = task.origin === "test_run" ? (await readSpendPolicy(dependencies, task.orgId)).perTestCapUsd : undefined;
      return taskRunRoomUsd({ access: dependencies.modelAccess.access }, {
        taskKeyIds: task.modelKeyIds ?? [], runLimitUsd, stopAtUsd: task.maxPerRunUsd === undefined ? runLimitUsd : Math.min(runLimitUsd, task.maxPerRunUsd),
        budgetBaselineUsd: task.budgetBaselineUsd ?? 0, ...(testCapUsd === undefined ? {} : { testCapUsd }),
      });
    },
    sourceReaders: (task, operationId) => sourceReadersOf(dependencies, task, operationId),
    plannerModel: async (task): Promise<ModelSelection | undefined> => {
      const operations = (await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#")).filter((item) => item.entityType === "OPERATION" && item.kind === "task" && item.workflowMode === "PLAN" && item.conversationId === task.conversationId);
      const planner = operations.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).at(-1);
      const model = ModelSelectionSchema.safeParse(planner?.model);
      return model.success ? model.data : undefined;
    },
  };
}

/** What recording a round needs, from the broker's dependencies. */
export function roundRecordPortsOf(dependencies: AwsBrokerDependencies): RoundRecordPorts {
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const access = dependencies.modelAccess?.access;
  const ledger: LedgerDependencies | undefined = dependencies.agents === undefined || access === undefined ? undefined : {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, access, now: Date.now, ...(dependencies.cloud === true ? { cloud: true } : {}),
  };
  return {
    table,
    keySpend: async (keyIds) => (access === undefined ? undefined : access.keySpend(keyIds)),
    // Block, settle and finalize every slot key (the proxy counts a request it had admitted before the block, the ledger releases the unspent hold). A key the ledger cannot close is blocked alone; one the proxy cannot block expires with its life.
    closeKeys: async (orgId: OrgId, keyIds) => {
      if (access === undefined || keyIds.length === 0) return;
      if (ledger !== undefined) {
        try { await supersedeKeys(ledger, orgId, keyIds); return; } catch { /* fall through to the plain block */ }
      }
      for (const keyId of keyIds) await access.blockKey(keyId).catch(() => undefined);
    },
    readResult: async (operation: OperationRecord) => {
      const artifacts = (await queryAllItems(dependencies, `WORKSPACE#${operation.workspaceId}`, "ARTIFACT#"))
        .filter((item) => item.operationId === operation.id && item.name === DESIGN_REVIEW_ARTIFACT)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
      const artifact = artifacts.at(-1);
      return artifact === undefined ? undefined : readObjectText(dependencies.s3, dependencies.artifactBucketName, String(artifact.objectKey), RESULT_READ_MAX_BYTES);
    },
  };
}

/** The route dependencies the broker's dispatch builds, with the design review's ports beside them (the round's start reads them from `designReview`). Everything else is the dependencies as they were. */
export function withDesignReviewPorts<T extends object>(dependencies: AwsBrokerDependencies, route: T): T & { designReview: DesignReviewRoundPorts } {
  return { ...route, designReview: designReviewPortsOf(dependencies) };
}
