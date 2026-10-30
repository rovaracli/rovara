// v1.2 learning loop: the company-wide walk (design §3.5). There is no index of a company's PROJECT_LEARNING partitions, so the jobs that must reach all of them (closeOrg, person
// erase, the retention sweep) walk the project catalog instead: 25 projects a page, a job per project, and a resume point in the org-level LEARNING_WALK item.
//
// The catalog keeps archived projects: archiving writes the project's META only (project-archive.ts) and nothing deletes a catalog entry, so an archived project's partition is reached.
//
// A run stops when it has made `writes` item writes, its own cursor writes included (default 1,000), has run `millis` (default 20 s) or has visited `projects`. It stops with `status: "running"` and the next run
// goes on after the last finished project. A job that stops inside a project (`"partial"`) leaves the cursor where it was, so the next run repeats that project: jobs must be
// idempotent. Writes to the walk item are conditional on its `version`, so two overlapping runs cannot both move the cursor; the loser stops with `busy`.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXNameSchema, LearningWalkKindSchema, agentXError, learningWalkKey, orgProjectCatalogPk, type OrgId } from "@agentx/contracts";
import { readLearningPartition, type LearningDeps } from "./store.js";

export const WALK_CATALOG_PAGE = 25;
export const WALK_DEFAULT_WRITES = 1000;
export const WALK_DEFAULT_MILLIS = 20_000;

/**
 * The index of open walks. A walk's own item lives in its company's partition, so nothing can list the companies that have a walk to finish; a closed company and an erased person
 * make no further requests, so a walk that stopped at its budget needs something that finds it. One small item per running `close` / `erase#` walk (`sk` = `<orgId>#<kind>`) is written
 * when the walk starts, before its own item, and deleted when it finishes; the scheduled run (`resumeOpenLearningWalks`) reads this partition. It holds no text. An entry whose walk item is
 * gone (a crash between the two deletes) is removed by that run once it is `WALK_INDEX_STALE_MS` old; a younger one may belong to a walk that is just starting.
 */
export const WALK_INDEX_PK = "LEARNING_WALKS_OPEN";
export const WALK_INDEX_STALE_MS = 15 * 60_000;
export const walkIndexKey = (orgId: OrgId, kind: string) => ({ pk: WALK_INDEX_PK, sk: `${orgId}#${kind}` });
/** `sweep` is the retention sweep's own lap, driven by the reconciler; only the walks that must be finished are indexed. */
export const isIndexedWalkKind = (kind: string) => kind === "close" || kind.startsWith("erase#");

export interface WalkLimits { writes?: number; millis?: number; projects?: number }

export interface WalkBudget {
  /** Counts item writes a job made. */
  spend(count?: number): void;
  /** True once the run has used its writes or its time: a job should stop and answer `"partial"`. */
  exhausted(): boolean;
  writes(): number;
}

export type ProjectJob = (input: { orgId: OrgId; project: string; budget: WalkBudget }) => Promise<"done" | "partial">;
export interface WalkResult { status: "done" | "running" | "busy"; projectsDone: number; projectsThisRun: number; writes: number }

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Learning cleanup could not run. It will be tried again.");
const isConditionFailure = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

interface WalkRow { status: "running" | "done"; afterProject: string | undefined; projectsDone: number; version: number }

function rowOf(item: Record<string, unknown>): WalkRow {
  const version = item["version"], done = item["projectsDone"], after = item["afterProject"];
  if (typeof version !== "number" || !Number.isInteger(version) || typeof done !== "number" || !Number.isInteger(done) || (item["status"] !== "running" && item["status"] !== "done")) throw unavailable();
  return { status: item["status"], afterProject: typeof after === "string" ? after : undefined, projectsDone: done, version };
}

/**
 * Runs (or resumes) the `kind` walk, calling `job` for each project of the company in catalog order. `kind` is `close`, `sweep` or `erase#<developerId>`. A finished `close` or
 * `erase` walk deletes its item; a finished `sweep` is marked done, and the next run starts a new lap.
 */
export async function runLearningWalk(deps: LearningDeps, input: { orgId: OrgId; kind: string; job: ProjectJob; budget?: WalkLimits }): Promise<WalkResult> {
  const kind = LearningWalkKindSchema.safeParse(input.kind);
  if (!kind.success) throw agentXError("CONFIG_INVALID", "That cleanup is not one this system runs.");
  const key = learningWalkKey(input.orgId, kind.data);
  const limits = { writes: input.budget?.writes ?? WALK_DEFAULT_WRITES, millis: input.budget?.millis ?? WALK_DEFAULT_MILLIS, projects: input.budget?.projects ?? Number.POSITIVE_INFINITY };
  const startMs = deps.now();
  let spent = 0;
  const budget: WalkBudget = {
    spend: (count = 1) => { spent += count; },
    exhausted: () => spent >= limits.writes || deps.now() - startMs >= limits.millis,
    writes: () => spent,
  };

  const at = () => new Date(deps.now()).toISOString();
  const read = async () => (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  const fresh = (version: number, startedAt: string) => ({ ...key, entityType: "LEARNING_WALK", orgId: input.orgId, status: "running", startedAt, updatedAt: at(), projectsDone: 0, version });

  // Start, resume, or start a new lap after a finished one.
  let row: WalkRow;
  const stored = await read();
  try {
    if (stored === undefined) {
      if (isIndexedWalkKind(kind.data)) {
        await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...walkIndexKey(input.orgId, kind.data), entityType: "LEARNING_WALK_OPEN", orgId: input.orgId, kind: kind.data, since: at() } }));
      }
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: fresh(0, at()), ConditionExpression: "attribute_not_exists(pk)" }));
      row = { status: "running", afterProject: undefined, projectsDone: 0, version: 0 };
    } else {
      row = rowOf(stored);
      if (row.status === "done") {
        await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: fresh(row.version + 1, at()), ConditionExpression: "version = :seen", ExpressionAttributeValues: { ":seen": row.version } }));
        row = { status: "running", afterProject: undefined, projectsDone: 0, version: row.version + 1 };
      }
    }
  } catch (error) {
    if (isConditionFailure(error)) return { status: "busy", projectsDone: 0, projectsThisRun: 0, writes: 0 };
    throw error;
  }

  const catalogPk = orgProjectCatalogPk(input.orgId);
  let projectsThisRun = 0, projectsDone = row.projectsDone, scanAfter = row.afterProject;
  const result = (status: WalkResult["status"]): WalkResult => ({ status, projectsDone, projectsThisRun, writes: spent });

  for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": catalogPk, ":prefix": "PROJECT#" },
      ConsistentRead: true, Limit: WALK_CATALOG_PAGE, ...(scanAfter === undefined ? {} : { ExclusiveStartKey: { pk: catalogPk, sk: `PROJECT#${scanAfter}` } }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: unknown };
    const rows = page.Items ?? [];
    if (rows.length > WALK_CATALOG_PAGE) throw unavailable();
    for (const entry of rows) {
      const sk = typeof entry["sk"] === "string" ? entry["sk"] : "";
      const name = AgentXNameSchema.safeParse(sk.slice("PROJECT#".length));
      if (!name.success) continue; // not a name any partition could have been made for
      if (budget.exhausted() || projectsThisRun >= limits.projects) return result("running");
      const outcome = await input.job({ orgId: input.orgId, project: name.data, budget });
      if (outcome === "partial") return result("running");
      projectsThisRun += 1;
      projectsDone += 1;
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: key, UpdateExpression: "SET afterProject = :project, projectsDone = :done, updatedAt = :at, version = version + :one",
          ConditionExpression: "version = :seen", ExpressionAttributeValues: { ":project": name.data, ":done": projectsDone, ":at": at(), ":one": 1, ":seen": row.version },
        }));
      } catch (error) {
        if (isConditionFailure(error)) return result("busy");
        throw error;
      }
      row = { ...row, version: row.version + 1 };
      budget.spend(1); // the cursor write is an item write like any other
    }
    const lastSk = rows.at(-1)?.["sk"];
    if (typeof lastSk === "string") scanAfter = lastSk.slice("PROJECT#".length);
    if (page.LastEvaluatedKey === undefined) break;
    if (rows.length === 0) throw unavailable();
  }

  // The catalog is exhausted: the lap is complete.
  try {
    if (kind.data === "sweep") {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key, UpdateExpression: "SET #status = :done, updatedAt = :at, version = version + :one REMOVE afterProject", ConditionExpression: "version = :seen",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":done": "done", ":at": at(), ":one": 1, ":seen": row.version },
      }));
    } else {
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key, ConditionExpression: "version = :seen", ExpressionAttributeValues: { ":seen": row.version } }));
      if (isIndexedWalkKind(kind.data)) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: walkIndexKey(input.orgId, kind.data) }));
    }
  } catch (error) {
    if (isConditionFailure(error)) return result("busy");
    throw error;
  }
  return result("done");
}

/**
 * The job closeOrg runs on each project: deletes every item of the project's learning partition, whatever it is (expired and earlier-project items included), within the run's
 * write budget. A budget that ends inside the partition answers `"partial"`; the next run reads what is left from the start, so nothing is repeated.
 */
export function clearProjectPartitionJob(deps: LearningDeps, options: { before?: string } = {}): ProjectJob {
  return async ({ orgId, project, budget }) => {
    const before = options.before;
    if (before === undefined) {
      for (;;) {
        const page = await readLearningPartition(deps, { orgId, project }, { maxItems: 100, maxPages: 1, pageSize: 100 });
        if (page.items.length === 0) return "done";
        for (const item of page.items) {
          if (budget.exhausted()) return "partial";
          await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } }));
          budget.spend(1);
        }
      }
    }
    // A clear that runs after the project was archived must not touch what a project created again under the same name has written since: items written for a project created at
    // or after `before` stay. The partition is read forward by a cursor because those items are not deleted.
    let cursor: string | undefined;
    for (;;) {
      const page = await readLearningPartition(deps, { orgId, project }, { maxItems: 100, maxPages: 1, pageSize: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items) {
        const createdAt = item["projectCreatedAt"];
        if (typeof createdAt === "string" && createdAt >= before) continue;
        if (budget.exhausted()) return "partial";
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } }));
        budget.spend(1);
      }
      cursor = page.cursor;
      if (cursor === undefined) return "done";
    }
  };
}
