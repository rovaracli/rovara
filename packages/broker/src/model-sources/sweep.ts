// Company AI sources (Plan 3 Task 24b, fix rounds 1 and 2): the scheduled sweep (every 5 minutes, on the settlement job list). A change touches the record,
// the proxy and an egress item with no transaction across them, so this finds what a crash or a lost race left and puts it right:
//   - an egress owner whose source the record does not have (a removal that died before its release, or an org that closed) is released, and a live
//     endpoint's egress item is made to be its record's host alone (a host it moved away from is dropped; the live host is never wiped);
//   - a registration in the proxy that no record names is removed, but only when it has been seen twice, at least ten minutes apart: an add registers
//     with the proxy BEFORE its record commits, so one sighting may be an add in flight. The record is read again, consistently, just before;
//   - an endpoint whose models or credential point at a host other than its record's (a key beside a host it was not saved for) is, on the same two
//     sightings, removed from the proxy, registered again with no key, and marked as having none;
//   - a removal whose tombstone is still in the record is finished.
// The orgs with a record are walked from a saved cursor, so a run that runs out of time carries on where it stopped. Every call that can wait on the
// proxy or the table is bounded by the run's time budget, so a slow proxy cannot take the spend sweep's time.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ModelSource, OrgId } from "@agentx/contracts";
import type { ModelAccess } from "../model-proxy/access.js";
import { listEgressItems, putEgressDomains } from "../org/egress-domains.js";
import { releaseSource, viaProxy, type ModelSourceCleanupDependencies } from "./release.js";
import type { StoredModelSources } from "./store.js";

export interface ModelSourceSweepDependencies extends Omit<ModelSourceCleanupDependencies, "access"> {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  access: Pick<ModelAccess, "removeSource" | "listSources" | "upsertSource">;
  log?: (entry: Record<string, unknown>) => void;
}

export interface ModelSourceSweepReport {
  /** False when the time ran out before every org had been walked; the next run carries on. */
  complete: boolean;
  /** Egress owners released or corrected. */
  released: number;
  /** Registrations removed. */
  removed: number;
  /** Endpoints whose key was dropped because the proxy pointed them at another host. */
  rebound: number;
  /** Tombstones finished. */
  finished: number;
  /** Things that failed and stay for the next run. */
  failed: number;
}

/** What the settlement run gives this sweep: the spend sweep that follows keeps its own 20 of the function's 30 seconds. */
export const MODEL_SOURCE_SWEEP_BUDGET_MS = 5_000;

const SWEEP_PK = "MODEL_SOURCES_SWEEP";
const CURSOR_KEY = { pk: SWEEP_PK, sk: "CURSOR" } as const;
const strayKey = (orgId: string, sourceId: string) => ({ pk: SWEEP_PK, sk: `ORPHAN#${orgId}#${sourceId}` });
const mismatchKey = (orgId: string, sourceId: string) => ({ pk: SWEEP_PK, sk: `MISMATCH#${orgId}#${sourceId}` });
/** How long a registration with no record, or with another host than its record's, must have been seen before it is acted on. */
export const STRAY_AFTER_MS = 10 * 60_000;
const ORGS_PER_PAGE = 25;

class SweepTimeout extends Error {
  constructor() {
    super("the sweep ran out of time");
    this.name = "SweepTimeout";
  }
}

const hostOf = (source: ModelSource): string | undefined => (source.kind === "endpoint" ? new URL(source.baseUrl).hostname : undefined);
/** Whether any host a registration points at is not the record's. Hosts the proxy does not show are not a mismatch. */
const pointsElsewhere = (hosts: readonly string[] | undefined, host: string): boolean => (hosts ?? []).some((candidate) => candidate !== host);

export async function sweepModelSources(deps: ModelSourceSweepDependencies, options: { budgetMs: number }): Promise<ModelSourceSweepReport> {
  const started = deps.now();
  const deadline = started + options.budgetMs;
  const outOfTime = () => deps.now() >= deadline;
  const report: ModelSourceSweepReport = { complete: true, released: 0, removed: 0, rebound: 0, finished: 0, failed: 0 };
  const log = deps.log ?? (() => undefined);
  const records = new Map<string, StoredModelSources | undefined>();
  // Records are read after the lists they are compared with, so a source in a list that was created before it has its record in what is read.
  const recordOf = async (orgId: OrgId): Promise<StoredModelSources | undefined> => {
    if (!records.has(orgId)) records.set(orgId, await deps.store.readIfAny(orgId));
    return records.get(orgId);
  };
  /** Waits for `work` no longer than the run has left; it keeps going in the background, but the run does not wait for it. */
  const within = async <T>(work: Promise<T>): Promise<T> => {
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new SweepTimeout();
    void work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new SweepTimeout()); }, remaining); });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      if (error instanceof SweepTimeout) {
        report.complete = false;
        return;
      }
      report.failed += 1;
      log({ event: "model_sources.sweep_failed", step: what, error: error instanceof Error ? error.name : "unknown" });
    }
  };
  const seenAtOf = async (key: { pk: string; sk: string }): Promise<number | undefined> => {
    const seen = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: { seenAt?: unknown } };
    return typeof seen.Item?.seenAt === "number" ? seen.Item.seenAt : undefined;
  };
  const sighted = (key: { pk: string; sk: string }, entityType: string) => deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...key, entityType, seenAt: started } }));
  const forget = (key: { pk: string; sk: string }) => deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));

  // Registrations: listed first, compared with the records below.
  let registered: Array<{ orgId: OrgId; sourceId: string; hosts?: string[] | undefined }> = [];
  await attempt("list", async () => { registered = await within(deps.access.listSources()); });

  // Egress owners with no source, and a live endpoint's item that is not its host alone.
  await attempt("egress", async () => {
    for (const item of await within(listEgressItems(deps.egress))) {
      if (item.owner.kind !== "model-source" || item.domains.length === 0) continue;
      const sourceId = item.owner.sourceId;
      const listed = (await recordOf(item.orgId))?.sources.find((candidate) => candidate.sourceId === sourceId);
      const listedHost = listed === undefined ? undefined : hostOf(listed);
      // Cheap test on what was listed; the decision below is made again on a fresh read.
      if (listedHost !== undefined && item.domains.length === 1 && item.domains[0]!.domain === listedHost) continue;
      if (outOfTime()) { report.complete = false; return; }
      await attempt("release-egress", async () => {
        const owner = { kind: "model-source", sourceId } as const;
        // The record read above is stale by now: a change may have committed its host since. It is read again, and a live endpoint's host is the one
        // thing that is never wiped: the item is made to be that host alone, which keeps the entry it has and asks for it only if it is missing.
        const source = (await deps.store.readIfAny(item.orgId))?.sources.find((candidate) => candidate.sourceId === sourceId);
        const host = source === undefined ? undefined : hostOf(source);
        await putEgressDomains(deps.egress, item.orgId, owner, host === undefined ? [] : [host]);
        report.released += 1;
      });
    }
  });

  // Registrations no record names, and endpoints the proxy points at another host.
  await attempt("registrations", async () => {
    for (const entry of registered) {
      const { orgId, sourceId } = entry;
      const record = await recordOf(orgId);
      const source = record?.sources.find((candidate) => candidate.sourceId === sourceId);
      if (source !== undefined) {
        const host = hostOf(source);
        if (host === undefined || !pointsElsewhere(entry.hosts, host)) continue;
        const key = mismatchKey(orgId, sourceId);
        const seenAt = await seenAtOf(key);
        if (seenAt === undefined) { await sighted(key, "MODEL_SOURCE_MISMATCH"); continue; }
        if (started - seenAt < STRAY_AFTER_MS) continue;
        if (outOfTime()) { report.complete = false; return; }
        await attempt("rebind", async () => {
          // A consistent read just before: the change that was in flight may have committed the proxy's host meanwhile.
          const fresh = (await deps.store.readIfAny(orgId))?.sources.find((candidate) => candidate.sourceId === sourceId);
          const freshHost = fresh === undefined ? undefined : hostOf(fresh);
          if (fresh === undefined || freshHost === undefined || !pointsElsewhere(entry.hosts, freshHost)) { await forget(key); return; }
          // Removing the source deletes its credential, so the key goes; it is registered again without one (a secret reference is read again), and the record says it has none.
          await viaProxy(() => deps.access.removeSource(orgId, sourceId));
          await viaProxy(() => deps.access.upsertSource({ orgId, source: fresh }));
          // N8: an endpoint that names a secret gets it back from the reference when it is registered again, so the record still says it has one.
          if (!(fresh.kind === "endpoint" && fresh.keyRef !== undefined)) await deps.store.dropCredential({ orgId, sourceId, by: "system" });
          await forget(key);
          report.rebound += 1;
        });
        continue;
      }
      // A removal still owed is finished with its tombstone below.
      if (record?.removing.some((tombstone) => tombstone.sourceId === sourceId) === true) continue;
      const key = strayKey(orgId, sourceId);
      const seenAt = await seenAtOf(key);
      if (seenAt === undefined) { await sighted(key, "MODEL_SOURCE_STRAY"); continue; }
      if (started - seenAt < STRAY_AFTER_MS) continue;
      if (outOfTime()) { report.complete = false; return; }
      await attempt("remove-stray", async () => {
        // A consistent read just before: a retry of the add that registered it may have committed its record since the one above.
        const fresh = await deps.store.readIfAny(orgId);
        if (fresh?.sources.some((candidate) => candidate.sourceId === sourceId) === true || fresh?.removing.some((tombstone) => tombstone.sourceId === sourceId) === true) {
          await forget(key);
          return;
        }
        await releaseSource(deps, orgId, sourceId);
        await forget(key);
        report.removed += 1;
      });
    }
    // A sighting of something that is gone, or that a record names rightly now, is forgotten.
    const current = new Set<string>();
    for (const entry of registered) {
      const source = (await recordOf(entry.orgId))?.sources.find((candidate) => candidate.sourceId === entry.sourceId);
      if (source === undefined) current.add(strayKey(entry.orgId, entry.sourceId).sk);
      else {
        const host = hostOf(source);
        if (host !== undefined && pointsElsewhere(entry.hosts, host)) current.add(mismatchKey(entry.orgId, entry.sourceId).sk);
      }
    }
    for (const prefix of ["ORPHAN#", "MISMATCH#"]) {
      const listed = (await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": SWEEP_PK, ":prefix": prefix },
      }))) as { Items?: Array<{ sk?: unknown }> };
      for (const item of listed.Items ?? []) {
        if (typeof item.sk === "string" && !current.has(item.sk)) await forget({ pk: SWEEP_PK, sk: item.sk });
      }
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
