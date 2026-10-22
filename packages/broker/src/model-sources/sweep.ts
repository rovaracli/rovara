// Company AI sources (Plan 3 Task 24b, fix round 1): the scheduled sweep (every 5 minutes, on the settlement job list). A change touches the record, the
// proxy and an egress item with no transaction across them, so this finds what a crash left and puts it right:
//   - an egress owner whose source the record does not have (a removal that died before its release, or an org that closed), and a live endpoint whose
//     egress item still lists a host it moved away from, are released;
//   - a registration in the proxy that no record names is removed, but only when it has been seen twice, at least ten minutes apart: an add registers
//     with the proxy BEFORE its record commits, so one sighting may be an add in flight;
//   - a removal whose tombstone is still in the record is finished.
// The orgs with a record are walked from a saved cursor, so a run that runs out of time carries on where it stopped.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { OrgId } from "@agentx/contracts";
import type { ModelAccess } from "../model-proxy/access.js";
import { listEgressItems, putEgressDomains } from "../org/egress-domains.js";
import { releaseSource, type ModelSourceCleanupDependencies } from "./release.js";
import type { StoredModelSources } from "./store.js";

export interface ModelSourceSweepDependencies extends Omit<ModelSourceCleanupDependencies, "access"> {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  access: Pick<ModelAccess, "removeSource" | "listSources">;
  log?: (entry: Record<string, unknown>) => void;
}

export interface ModelSourceSweepReport {
  /** False when the time ran out before every org had been walked; the next run carries on. */
  complete: boolean;
  /** Egress owners released. */
  released: number;
  /** Registrations removed. */
  removed: number;
  /** Tombstones finished. */
  finished: number;
  /** Things that failed and stay for the next run. */
  failed: number;
}

const SWEEP_PK = "MODEL_SOURCES_SWEEP";
const CURSOR_KEY = { pk: SWEEP_PK, sk: "CURSOR" } as const;
const candidateKey = (orgId: string, sourceId: string) => ({ pk: SWEEP_PK, sk: `ORPHAN#${orgId}#${sourceId}` });
/** How long a registration with no record must have been seen before it is taken for a stray. */
export const STRAY_AFTER_MS = 10 * 60_000;
const ORGS_PER_PAGE = 25;

export async function sweepModelSources(deps: ModelSourceSweepDependencies, options: { budgetMs: number }): Promise<ModelSourceSweepReport> {
  const started = deps.now();
  const deadline = started + options.budgetMs;
  const outOfTime = () => deps.now() >= deadline;
  const report: ModelSourceSweepReport = { complete: true, released: 0, removed: 0, finished: 0, failed: 0 };
  const log = deps.log ?? (() => undefined);
  const records = new Map<string, StoredModelSources | undefined>();
  // Records are read after the lists they are compared with, so a source in a list that was created before it has its record in what is read.
  const recordOf = async (orgId: OrgId): Promise<StoredModelSources | undefined> => {
    if (!records.has(orgId)) records.set(orgId, await deps.store.readIfAny(orgId));
    return records.get(orgId);
  };
  const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      report.failed += 1;
      log({ event: "model_sources.sweep_failed", step: what, error: error instanceof Error ? error.name : "unknown" });
    }
  };

  // Registrations: listed first, compared with the records below.
  let registered: Array<{ orgId: OrgId; sourceId: string }> = [];
  await attempt("list", async () => { registered = await deps.access.listSources(); });

  // Egress owners with no source, and a live endpoint's moved-away hosts.
  await attempt("egress", async () => {
    for (const item of await listEgressItems(deps.egress)) {
      if (item.owner.kind !== "model-source" || item.domains.length === 0) continue;
      const sourceId = item.owner.sourceId;
      const source = (await recordOf(item.orgId))?.sources.find((candidate) => candidate.sourceId === sourceId);
      let keep: string[] | undefined;
      if (source === undefined || source.kind !== "endpoint") keep = [];
      else {
        const host = new URL(source.baseUrl).hostname;
        if (item.domains.some((entry) => entry.domain !== host)) keep = item.domains.some((entry) => entry.domain === host) ? [host] : [];
      }
      if (keep === undefined) continue;
      if (outOfTime()) { report.complete = false; return; }
      await attempt("release-egress", async () => {
        await putEgressDomains(deps.egress, item.orgId, { kind: "model-source", sourceId }, keep);
        report.released += 1;
      });
    }
  });

  // Registrations no record names.
  await attempt("registrations", async () => {
    for (const { orgId, sourceId } of registered) {
      const record = await recordOf(orgId);
      const key = candidateKey(orgId, sourceId);
      if (record?.sources.some((source) => source.sourceId === sourceId) === true) continue;
      // A removal still owed is finished with its tombstone below.
      if (record?.removing.some((entry) => entry.sourceId === sourceId) === true) continue;
      const seen = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: { seenAt?: unknown } };
      const seenAt = typeof seen.Item?.seenAt === "number" ? seen.Item.seenAt : undefined;
      if (seenAt === undefined) {
        await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...key, entityType: "MODEL_SOURCE_STRAY", seenAt: started } }));
        continue;
      }
      if (started - seenAt < STRAY_AFTER_MS) continue;
      if (outOfTime()) { report.complete = false; return; }
      await attempt("remove-stray", async () => {
        await releaseSource(deps, orgId, sourceId);
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
        report.removed += 1;
      });
    }
    // A stray that is not registered any more, or that a record names now, is forgotten.
    const strays = new Set<string>();
    for (const { orgId, sourceId } of registered) if ((await recordOf(orgId))?.sources.some((source) => source.sourceId === sourceId) !== true) strays.add(candidateKey(orgId, sourceId).sk);
    const listed = (await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": SWEEP_PK, ":prefix": "ORPHAN#" },
    }))) as { Items?: Array<{ sk?: unknown }> };
    for (const item of listed.Items ?? []) {
      if (typeof item.sk === "string" && !strays.has(item.sk)) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: SWEEP_PK, sk: item.sk } }));
    }
  });

  // Removals still owed, org by org from the saved cursor.
  const saved = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: CURSOR_KEY, ConsistentRead: true }))) as { Item?: { cursor?: unknown } }).Item?.cursor;
  let cursor = typeof saved === "string" ? saved : undefined;
  let reachedEnd = false;
  while (!reachedEnd) {
    const page = await deps.store.listOrgs(cursor, ORGS_PER_PAGE);
    for (const orgId of page) {
      if (outOfTime()) {
        report.complete = false;
        if (cursor !== undefined) await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...CURSOR_KEY, entityType: "MODEL_SOURCES_SWEEP_CURSOR", cursor, at: new Date(deps.now()).toISOString() } }));
        return report;
      }
      await attempt("tombstones", async () => {
        for (const tombstone of (await deps.store.readIfAny(orgId))?.removing ?? []) {
          await releaseSource(deps, orgId, tombstone.sourceId);
          await deps.store.finishRemoval({ orgId, sourceId: tombstone.sourceId });
          report.finished += 1;
        }
      });
      cursor = orgId;
    }
    reachedEnd = page.length < ORGS_PER_PAGE;
  }
  if (saved !== undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: CURSOR_KEY }));
  return report;
}
