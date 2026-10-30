// v1.2 learning loop, B7: the cleanup jobs (design 3.5). They run on B1's catalog walk (walk.ts), so they reach every project of a company, archived ones included, and resume after a
// budget stop.
//
// - A company closes (`clearOrgLearning`, from `closeOrg`): every item of every learning partition is deleted. The close does not wait for a walk that is not finished; `resumeLearningWalks` finishes
//   it later, from the walk's own item.
// - A project is archived (`clearProjectLearning`, from the archive routes): its partition is deleted. A project created again under the same name sees nothing of the old one in any case
//   (every item carries `projectCreatedAt`, and reads ignore another project's items), so a clear that did not finish only leaves dead text until the TTL or the sweep removes it.
// - A person is erased (`eraseLearningSubject`, from the audit erase): in every project their corrections lose `text` and `githubUserId` and their `author` becomes `erased`; `rememberedBy` is
//   removed where it is them; an open suggestion holding one of their corrections is withdrawn and loses its text; their per-person rate items are deleted. Counts stay. A job that stops
//   part-way is repeated by the next run, so each step only acts on what is still to do. The suggestions are handled BEFORE the corrections are erased: once a correction says `erased` nothing
//   can tell whose it was, and a suggestion that held it could not be found again.
//
// Nothing here logs or returns text.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, learningWalkKey, projectLearningKey, type OrgId } from "@agentx/contracts";
import { learningItemKind, sameProject } from "./retention.js";
import { closeSuggestion, readLearningPartition, type LearningDeps } from "./store.js";
import { WALK_DEFAULT_MILLIS, WALK_DEFAULT_WRITES, WALK_INDEX_PK, WALK_INDEX_STALE_MS, clearProjectPartitionJob, isIndexedWalkKind, runLearningWalk, walkIndexKey, type ProjectJob, type WalkBudget, type WalkLimits, type WalkResult } from "./walk.js";

type Item = Record<string, unknown>;

/** What clearing one project in one go may spend: it is a single request's work, so it is bounded in writes and time. */
export const CLEAR_PROJECT_WRITES = 5000;
export const CLEAR_PROJECT_MILLIS = 25_000;
/** The erased marker a person's `author` becomes. */
export const ERASED_AUTHOR = "erased";

const isConditionFailure = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

// ---- closeOrg

/** Starts (or resumes) the `close` walk: deletes every item of every learning partition of the company, within the budget. `status: "running"` means a later call must go on. */
export function clearOrgLearning(deps: LearningDeps, orgId: OrgId, budget?: WalkLimits): Promise<WalkResult> {
  return runLearningWalk(deps, { orgId, kind: "close", job: clearProjectPartitionJob(deps), ...(budget === undefined ? {} : { budget }) });
}

// ---- project archive

/**
 * Deletes one project's learning partition, within `limits`, and answers how many writes it made. `before` keeps items written for a project created at or after it (see
 * `clearProjectPartitionJob`). `"partial"` means the budget ended first.
 */
export async function clearProjectWithin(deps: LearningDeps, orgId: OrgId, project: string, limits: { writes?: number; millis?: number; before?: string } = {}): Promise<{ status: "done" | "partial"; writes: number }> {
  const writes = limits.writes ?? CLEAR_PROJECT_WRITES, millis = limits.millis ?? CLEAR_PROJECT_MILLIS;
  const startMs = deps.now();
  let spent = 0;
  const budget: WalkBudget = {
    spend: (count = 1) => { spent += count; },
    exhausted: () => spent >= writes || deps.now() - startMs >= millis,
    writes: () => spent,
  };
  const status = await clearProjectPartitionJob(deps, limits.before === undefined ? {} : { before: limits.before })({ orgId, project, budget });
  return { status, writes: spent };
}

/** Deletes one project's learning partition, within `limits`. `"partial"` means the budget ended first (the rest is dead weight that the TTL and the sweep remove, or a later run of the clear). */
export async function clearProjectLearning(deps: LearningDeps, orgId: OrgId, project: string, limits: { writes?: number; millis?: number; before?: string } = {}): Promise<"done" | "partial"> {
  return (await clearProjectWithin(deps, orgId, project, limits)).status;
}

/** What the archive request itself may spend on the clear: one page of deletes. The rest is finished by the scheduled run, so archiving answers quickly whatever the project holds. */
export const ARCHIVE_INLINE_WRITES = 100;
export const ARCHIVE_INLINE_MILLIS = 2_000;

/**
 * The archive routes' clear: ONE bounded page inline. A project with more than that leaves an entry in the index of open walks (`clear#<project>`, with the moment of the archive), and
 * `resumeOpenLearningWalks` goes on from there at the next scheduled run. Items written for a project created again after the archive are never deleted by it.
 */
export async function clearArchivedProjectLearning(deps: LearningDeps, orgId: OrgId, project: string, inline: { writes?: number; millis?: number } = {}): Promise<"done" | "partial"> {
  const before = new Date(deps.now()).toISOString();
  const status = await clearProjectLearning(deps, orgId, project, { writes: inline.writes ?? ARCHIVE_INLINE_WRITES, millis: inline.millis ?? ARCHIVE_INLINE_MILLIS, before });
  if (status === "partial") {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName, Item: { ...walkIndexKey(orgId, `clear#${project}`), entityType: "LEARNING_WALK_OPEN", orgId, kind: `clear#${project}`, project, before, since: before },
    }));
  }
  return status;
}

// ---- person erase

/** Erases one person's learning data in every project of the company. `status: "running"` means a repeat of the request goes on. */
export function eraseLearningSubject(deps: LearningDeps, orgId: OrgId, developerId: string, budget?: WalkLimits): Promise<WalkResult> {
  return runLearningWalk(deps, { orgId, kind: `erase#${developerId}`, job: eraseProjectJob(deps, developerId), ...(budget === undefined ? {} : { budget }) });
}

const PAGE = 100;
const PAGES_MAX = 60;

async function eachPage(deps: LearningDeps, orgId: OrgId, project: string, prefix: string, visit: (item: Item) => Promise<"go" | "stop"> | "go" | "stop"): Promise<"done" | "stopped"> {
  let cursor: string | undefined;
  for (let pages = 0; pages < PAGES_MAX; pages += 1) {
    const page = await readLearningPartition(deps, { orgId, project }, { prefix, ...(cursor === undefined ? {} : { cursor }), maxItems: PAGE, maxPages: 1, pageSize: PAGE });
    for (const item of page.items) if (await visit(item) === "stop") return "stopped";
    cursor = page.cursor;
    if (cursor === undefined) return "done";
  }
  return "done";
}

/** The job the erase walk runs on each project. Idempotent: a correction already erased is not touched again. */
export function eraseProjectJob(deps: LearningDeps, developerId: string): ProjectJob {
  return async ({ orgId, project, budget }) => {
    const state = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectLearningKey(orgId, project, "STATE"), ConsistentRead: true })) as { Item?: Item }).Item;
    const statePc = typeof state?.["projectCreatedAt"] === "string" ? state["projectCreatedAt"] : undefined;

    // 1. Read their corrections (reads only): which ids are theirs, and which items need a write.
    const mine = new Set<string>();
    const work: Item[] = [];
    await eachPage(deps, orgId, project, "CORRECTION#", (item) => {
      const theirs = item["author"] === developerId, remembered = item["rememberedBy"] === developerId;
      if (theirs && typeof item["id"] === "string") mine.add(item["id"]);
      if (theirs || remembered) work.push(item);
      return "go";
    });

    // 2. Withdraw the open suggestions that hold one of their corrections, before any of those corrections stops saying whose it is.
    if (mine.size > 0) {
      const open: Item[] = [];
      await eachPage(deps, orgId, project, "SUGGESTION#", (item) => {
        if (item["status"] === "open" && Array.isArray(item["correctionIds"]) && item["correctionIds"].some((id) => typeof id === "string" && mine.has(id))) open.push(item);
        return "go";
      });
      for (const item of open) {
        if (budget.exhausted()) return "partial";
        const id = String(item["id"]);
        if (statePc !== undefined && sameProject(item["projectCreatedAt"], statePc)) {
          let done = false;
          let seen = item;
          for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
            const closed = await closeSuggestion(deps, { orgId, project, projectCreatedAt: statePc }, { id, expectedRevision: Number(seen["revision"]), status: "withdrawn" });
            done = closed.ok || closed.reason !== "stale";
            if (!done) seen = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] }, ConsistentRead: true })) as { Item?: Item }).Item ?? seen;
          }
          if (!done) return "partial";
        } else {
          // A suggestion of an earlier project: no counter of the present project to move, only the text to remove.
          try {
            await deps.documentClient.send(new UpdateCommand({
              TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] }, UpdateExpression: "SET #status = :withdrawn REMOVE proposedText, dismissNote",
              ConditionExpression: "attribute_exists(pk) AND #status = :open", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":withdrawn": "withdrawn", ":open": "open" },
            }));
          } catch (error) {
            if (!isConditionFailure(error)) throw error;
          }
        }
        budget.spend(1);
      }
    }

    // 3. Their per-person rate items.
    const ratePrefix = `RATE#${developerId}#`;
    let rateStopped = false;
    await eachPage(deps, orgId, project, "RATE#", async (item) => {
      if (typeof item["sk"] !== "string" || !item["sk"].startsWith(ratePrefix) || learningItemKind(item["sk"]).kind !== "RATE") return "go";
      if (budget.exhausted()) { rateStopped = true; return "stop"; }
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } }));
      budget.spend(1);
      return "go";
    });
    if (rateStopped) return "partial";

    // 4. The corrections themselves.
    for (const item of work) {
      if (budget.exhausted()) return "partial";
      const theirs = item["author"] === developerId, remembered = item["rememberedBy"] === developerId;
      const removes = [...(theirs ? ["#text", "githubUserId"] : []), ...(remembered ? ["rememberedBy"] : [])];
      const conditions = [...(theirs ? ["#author = :dev"] : []), ...(remembered ? ["rememberedBy = :dev"] : [])];
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] },
          UpdateExpression: `${theirs ? "SET #author = :erased " : ""}REMOVE ${removes.join(", ")}`,
          ConditionExpression: `attribute_exists(pk) AND ${conditions.join(" AND ")}`,
          ...(theirs ? { ExpressionAttributeNames: { "#author": "author", "#text": "text" } } : {}),
          ExpressionAttributeValues: { ":dev": developerId, ...(theirs ? { ":erased": ERASED_AUTHOR } : {}) },
        }));
      } catch (error) {
        // Changed since it was read (forgotten, expired, or already erased by a racing run): the next run looks again.
        if (!isConditionFailure(error)) throw error;
      }
      budget.spend(1);
    }
    return "done";
  };
}

// ---- finishing walks that were left running

/**
 * Finishes the `close` and `erase#<developerId>` walks of a company that were left `running` (a budget stop, a crash). Called from the reconciler or any later request; `sweep` is the
 * retention sweep's and is not touched. Answers the result of each walk it ran.
 */
export async function resumeLearningWalks(deps: LearningDeps, orgId: OrgId, budget?: WalkLimits): Promise<Array<{ kind: string; result: WalkResult }>> {
  const pk = learningWalkKey(orgId, "close").pk;
  const found = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, Limit: 50,
  })) as { Items?: Item[] };
  const results: Array<{ kind: string; result: WalkResult }> = [];
  for (const item of found.Items ?? []) {
    const kind = item["sk"];
    if (typeof kind !== "string" || item["status"] !== "running") continue;
    if (kind === "close") results.push({ kind, result: await clearOrgLearning(deps, orgId, budget) });
    else if (kind.startsWith("erase#")) results.push({ kind, result: await eraseLearningSubject(deps, orgId, kind.slice("erase#".length), budget) });
  }
  return results;
}

// ---- the scheduled resume (Cloud)

/** Index entries read a page at a time; at most this many pages a tick, so a pile of entries that cannot be finished never makes the tick read the whole table. */
const INDEX_PAGE = 25;
const INDEX_PAGES_MAX = 4;

export interface ResumeReport {
  /** Walks this tick ran. */
  walks: number;
  /** Of those, how many finished, stopped at the budget, or lost a race to another run. */
  done: number;
  running: number;
  busy: number;
  /** Walks that threw (the error name is logged, nothing else); they stay in the index for the next tick. */
  failed: number;
  /** Index entries whose walk is gone and that were removed. */
  stale: number;
  /** Item writes the walks made. */
  writes: number;
}

/**
 * Finishes the `close` and `erase#<developerId>` walks that stopped at their budget, for ANY company. A closed company and an erased person make no further requests, so this is what
 * resumes them: the broker's 5-minute settlement run calls it. It reads the index of open walks (walk.ts) and runs each walk with what is left of ONE budget (writes and time) shared by
 * the whole tick; the walk's own cursor makes the next tick go on where this one stopped. A walk that throws is logged by error name and does not stop the others. An entry whose walk item
 * is gone (finished, or never written) starts nothing and is removed once it is `WALK_INDEX_STALE_MS` old.
 */
export async function resumeOpenLearningWalks(deps: LearningDeps, limits: { writes?: number; millis?: number } = {}, log: (entry: Record<string, unknown>) => void = () => undefined): Promise<ResumeReport> {
  const writes = limits.writes ?? WALK_DEFAULT_WRITES, millis = limits.millis ?? WALK_DEFAULT_MILLIS;
  const startMs = deps.now();
  const report: ResumeReport = { walks: 0, done: 0, running: 0, busy: 0, failed: 0, stale: 0, writes: 0 };
  let after: Record<string, unknown> | undefined;
  for (let pages = 0; pages < INDEX_PAGES_MAX; pages += 1) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": WALK_INDEX_PK }, ConsistentRead: true, Limit: INDEX_PAGE,
      ...(after === undefined ? {} : { ExclusiveStartKey: after }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const entry of page.Items ?? []) {
      const left = { writes: writes - report.writes, millis: millis - (deps.now() - startMs) };
      if (left.writes <= 0 || left.millis <= 0) return report;
      const org = OrgIdSchema.safeParse(entry["orgId"]);
      const kind = entry["kind"];
      if (!org.success || typeof kind !== "string") continue;
      const orgId = org.data;
      if (kind.startsWith("clear#")) {
        // An archived project's clear that did not finish inline: the entry is the whole record (no walk item), and the clear reads the partition from the start each time.
        const project = entry["project"], before = entry["before"];
        if (typeof project !== "string" || typeof before !== "string") continue;
        try {
          report.walks += 1;
          const cleared = await clearProjectWithin(deps, orgId, project, { ...left, before });
          report.writes += cleared.writes;
          if (cleared.status === "done") {
            await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: entry["pk"], sk: entry["sk"] } }));
            report.done += 1;
          } else report.running += 1;
        } catch (error) {
          report.failed += 1;
          log({ event: "learning.walk_resume_failed", kind: "clear", error: error instanceof Error ? error.name : "unknown" });
        }
        continue;
      }
      if (!isIndexedWalkKind(kind)) continue;
      try {
        const walk = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: learningWalkKey(orgId, kind), ConsistentRead: true })) as { Item?: Item }).Item;
        if (walk === undefined || walk["status"] !== "running") {
          const since = typeof entry["since"] === "string" ? Date.parse(entry["since"]) : Number.NaN;
          if (!(deps.now() - since < WALK_INDEX_STALE_MS)) {
            await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: entry["pk"], sk: entry["sk"] } }));
            report.stale += 1;
          }
          continue;
        }
        report.walks += 1;
        const result = kind === "close" ? await clearOrgLearning(deps, orgId, left) : await eraseLearningSubject(deps, orgId, kind.slice("erase#".length), left);
        report.writes += result.writes;
        if (result.status === "done") report.done += 1;
        else if (result.status === "busy") report.busy += 1;
        else report.running += 1;
      } catch (error) {
        report.failed += 1;
        log({ event: "learning.walk_resume_failed", kind: kind === "close" ? "close" : "erase", error: error instanceof Error ? error.name : "unknown" });
      }
    }
    after = page.LastEvaluatedKey;
    if (after === undefined) break;
  }
  return report;
}

// ---- wiring helpers

/**
 * The function for `AuditEraseDeps.eraseLearning`: runs the erase walk and answers only when it finished. A walk that stopped on its budget is an error so the erasure request is answered
 * "send the same request again", and that repeat resumes the walk.
 */
export function learningEraseHook(deps: LearningDeps, budget?: WalkLimits): (orgId: OrgId, developerId: string) => Promise<void> {
  return async (orgId, developerId) => {
    const result = await eraseLearningSubject(deps, orgId, developerId, budget);
    if (result.status !== "done") throw Object.assign(new Error("learning erase not finished"), { name: "LearningEraseUnfinished" });
  };
}
