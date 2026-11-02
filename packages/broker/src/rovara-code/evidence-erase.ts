// Proof and evidence (wire-proof fix round 1): deleting what the evidence path stored, when a person is erased, a project is archived or a company closes. Two kinds of object live under a task's workspace:
//   private/<owner>/<workspace>/evidence-pack/<task>/<digest>.json   the pack (test names, check labels, paths)
//   private/<owner>/<workspace>/evidence/<task>/<sha256>            output tails (and any artifact the capture lane adds)
// The tails and the pack both carry the `evidence-std` retention tag (30 days by default), so they expire on their own on a stack whose bucket has the rule; this is the deletion that does not wait for it. It is
// NOT behind the proof switch: evidence kept while the switch was on is erased after it was turned off too, and with nothing stored the walk finds nothing (one list call per workspace).
//
// Cost and resumption (fix round 2). An install that never kept evidence pays one read: the first pack an org keeps writes a marker (`markEvidenceStored`) BEFORE anything is stored, and an erase for an org with no
// marker is complete at once. When there is something to erase the walk goes a page of the scope at a time, a few scopes in parallel, and keeps a CURSOR in the State table after each page, so a pass that runs out
// of time (or hits a failed delete) is continued by the next call from where it stopped, never from the start. That item is also the PENDING record: the scheduled run (`resumeEvidenceErase`, in the broker's every-minute recovery run, which every install has and which gives it a budget of its own) finishes any erase a caller did not, so a company close or a project archive, which cannot wait or be repeated, never leaves evidence behind. A caller that CAN be repeated (the person
// erase) throws when the pass did not finish, and its request is repeated.
// Only keys under the exact prefixes above are ever listed or deleted; an owner or workspace id that is not a plain id is refused, so no id can widen a prefix.
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { WORKSPACE_PROJECT_INDEX, orgProjectCatalogPk, workspaceProjectIndexValue, type OrgId } from "@agentx/contracts";
import { taskKey } from "../developer/task-records.js";

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** The prefixes of one task's evidence in a workspace; `taskId` undefined is every task's in that workspace. Undefined when an id is not a plain id. */
export function evidencePrefixesOf(scope: { ownerKey: string; workspaceId: string; taskId?: string | undefined }): string[] | undefined {
  if (!PLAIN.test(scope.ownerKey) || !PLAIN.test(scope.workspaceId) || (scope.taskId !== undefined && !PLAIN.test(scope.taskId))) return undefined;
  const base = `private/${scope.ownerKey}/${scope.workspaceId}`;
  const tail = scope.taskId === undefined ? "/" : `/${scope.taskId}/`;
  return [`${base}/evidence-pack${tail}`, `${base}/evidence${tail}`];
}

const PAGE = 50;
const PARALLEL = 10;
const PENDING_PK = "EVIDENCE_ERASE_PENDING";
const STORED_PK = (orgId: string): string => `EVIDENCE_STORED#${orgId}`;

export interface EvidenceErasePorts {
  s3: Pick<S3Client, "send">;
  artifactBucketName: string;
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now?: (() => number) | undefined;
  /** The most milliseconds one call spends (default 20 s). */
  maxMs?: number | undefined;
}

export type EraseKind = "person" | "project" | "workspace";

export interface EvidenceErase {
  /** The evidence of every task the person created or owns. */
  person(orgId: OrgId, developerId: string): Promise<void>;
  /** The evidence of every workspace of the project. */
  project(orgId: OrgId, project: string): Promise<void>;
  /** The evidence of every project of the company. */
  workspace(orgId: OrgId): Promise<void>;
  /** Continues the erase named by a pending record, within `budgetMs`. True when it finished. */
  resume(pending: PendingErase, budgetMs: number): Promise<boolean>;
}

export interface PendingErase { orgId: OrgId; kind: EraseKind; scopeKey: string }

const unfinished = (): Error => Object.assign(new Error("evidence erase did not finish"), { name: "EvidenceEraseUnfinished" });

type Key = Record<string, unknown>;
interface Progress { cursor?: Key | undefined; projectNext?: number | undefined }

/** Marks that this org has kept evidence. Written before the first object is stored, once per process per org (the write is conditional, so a repeat changes nothing). */
const marked = new Set<string>();
export async function markEvidenceStored(ports: Pick<EvidenceErasePorts, "documentClient" | "tableName">, orgId: string): Promise<void> {
  const id = `${ports.tableName}|${orgId}`;
  if (marked.has(id)) return;
  try {
    await ports.documentClient.send(new PutCommand({ TableName: ports.tableName, Item: { pk: STORED_PK(orgId), sk: "META", entityType: "EVIDENCE_STORED", orgId }, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
  }
  marked.add(id);
}

/** Whether this org has ever kept evidence. Nothing marked means nothing to erase. */
export async function evidenceStoredIn(ports: Pick<EvidenceErasePorts, "documentClient" | "tableName">, orgId: string): Promise<boolean> {
  const read = await ports.documentClient.send(new GetCommand({ TableName: ports.tableName, Key: { pk: STORED_PK(orgId), sk: "META" }, ConsistentRead: true })) as { Item?: unknown };
  return read.Item !== undefined;
}

/** Deletes every key under `prefix`: a page is listed from the start, deleted, and listed again until a listing is empty. Returns whether it finished before `stop`; a delete the store reports an error for is not finished. */
async function deletePrefix(ports: EvidenceErasePorts, prefix: string, stop: number): Promise<boolean> {
  const now = ports.now ?? Date.now;
  for (;;) {
    if (now() >= stop) return false;
    const page = await ports.s3.send(new ListObjectsV2Command({ Bucket: ports.artifactBucketName, Prefix: prefix })) as { Contents?: Array<{ Key?: string }> };
    const keys = (page.Contents ?? []).flatMap((object) => (object.Key !== undefined && object.Key.startsWith(prefix) ? [object.Key] : []));
    if (keys.length === 0) return true;
    const deleted = await ports.s3.send(new DeleteObjectsCommand({ Bucket: ports.artifactBucketName, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })) as { Errors?: unknown[] };
    if ((deleted.Errors?.length ?? 0) > 0) return false;
  }
}

/** `work` over `items`, `PARALLEL` at a time; every item is attempted. */
async function inBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length; at += PARALLEL) out.push(...(await Promise.all(items.slice(at, at + PARALLEL).map(work))));
  return out;
}

type Scope = { ownerKey: string; workspaceId: string; taskId?: string | undefined };

export function createEvidenceErase(ports: EvidenceErasePorts): EvidenceErase {
  const now = ports.now ?? Date.now;
  const query = (input: Record<string, unknown>) => ports.documentClient.send(new QueryCommand({ TableName: ports.tableName, ...input })) as Promise<{ Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Key }>;
  const pendingKey = (p: PendingErase) => ({ pk: PENDING_PK, sk: `${p.orgId}|${p.kind}|${p.scopeKey}` });
  async function load(p: PendingErase): Promise<Progress & { exists: boolean }> {
    const read = await ports.documentClient.send(new GetCommand({ TableName: ports.tableName, Key: pendingKey(p), ConsistentRead: true })) as { Item?: { cursor?: Key; projectNext?: number } };
    return { cursor: read.Item?.cursor, projectNext: read.Item?.projectNext, exists: read.Item !== undefined };
  }
  const save = (p: PendingErase, progress: Progress) => ports.documentClient.send(new PutCommand({ TableName: ports.tableName, Item: { ...pendingKey(p), entityType: "EVIDENCE_ERASE_PENDING", orgId: p.orgId, kind: p.kind, scopeKey: p.scopeKey, ...(progress.cursor === undefined ? {} : { cursor: progress.cursor }), ...(progress.projectNext === undefined ? {} : { projectNext: progress.projectNext }) } }));
  const clear = (p: PendingErase) => ports.documentClient.send(new DeleteCommand({ TableName: ports.tableName, Key: pendingKey(p) }));

  /** Erases the scopes one page names; false when any prefix did not finish (the page is then done again from the cursor it started at). */
  async function eraseScopes(scopes: readonly Scope[], stop: number): Promise<boolean> {
    const results = await inBatches(scopes.flatMap((scope) => evidencePrefixesOf(scope) ?? []), (prefix) => deletePrefix(ports, prefix, stop));
    return results.every(Boolean);
  }

  /** Walks one query a page at a time from `progress.cursor`, saving the cursor after each page. True when the whole query was done. */
  async function walk(p: PendingErase, progress: Progress, stop: number, page: (start: Key | undefined) => Promise<{ scopes: Scope[]; next: Key | undefined }>): Promise<boolean> {
    let cursor = progress.cursor;
    for (;;) {
      const { scopes, next } = await page(cursor);
      if (!(await eraseScopes(scopes, stop))) { await save(p, { ...progress, cursor }); return false; }
      cursor = next;
      if (cursor === undefined) return true;
      progress.cursor = cursor;
      await save(p, progress);
      if (now() >= stop) return false;
    }
  }

  const workspacePage = (orgId: OrgId, project: string) => async (start: Key | undefined) => {
    const read = await query({ IndexName: WORKSPACE_PROJECT_INDEX.name, KeyConditionExpression: "#project = :project", ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": workspaceProjectIndexValue(orgId, project) }, Limit: PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }) });
    const scopes = (read.Items ?? []).flatMap((item): Scope[] => (typeof item.ownerKey === "string" && typeof item.id === "string" ? [{ ownerKey: item.ownerKey, workspaceId: item.id }] : []));
    return { scopes, next: read.LastEvaluatedKey };
  };
  const personPage = (orgId: OrgId, developerId: string) => async (start: Key | undefined) => {
    const read = await query({ KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${developerId}`, ":prefix": "TASK#" }, ConsistentRead: true, Limit: PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }) });
    const found = await inBatches((read.Items ?? []).filter((row) => row.orgId === orgId && typeof row.taskId === "string"), async (row): Promise<Scope[]> => {
      const task = ((await ports.documentClient.send(new GetCommand({ TableName: ports.tableName, Key: taskKey(row.taskId as string), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
      return task !== undefined && task.orgId === orgId && typeof task.ownerKey === "string" && typeof task.workspaceId === "string" ? [{ ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId: row.taskId as string }] : [];
    });
    return { scopes: found.flat(), next: read.LastEvaluatedKey };
  };

  async function projectsOf(orgId: OrgId): Promise<string[]> {
    const names: string[] = [];
    let start: Key | undefined;
    do {
      const read = await query({ KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgProjectCatalogPk(orgId), ":prefix": "PROJECT#" }, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) });
      for (const item of read.Items ?? []) if (typeof item.sk === "string") names.push(item.sk.slice("PROJECT#".length));
      start = read.LastEvaluatedKey;
    } while (start !== undefined && names.length < 5_000);
    if (start !== undefined) throw unfinished();
    return names;
  }

  /** A read that is tried once more when it fails (a transient fault), then fails for good. */
  const twice = async <T>(read: () => Promise<T>): Promise<T> => { try { return await read(); } catch { return read(); } };
  /** The pending record, written only if there is none (a cursor an earlier pass saved is never overwritten). Best effort: it runs on a path that is already failing. */
  const ensureRecord = async (p: PendingErase): Promise<void> => {
    try { await ports.documentClient.send(new PutCommand({ TableName: ports.tableName, Item: { ...pendingKey(p), entityType: "EVIDENCE_ERASE_PENDING", orgId: p.orgId, kind: p.kind, scopeKey: p.scopeKey }, ConditionExpression: "attribute_not_exists(pk)" })); } catch { /* the first fault is the one that is reported */ }
  };

  /** One erase, continued from its saved cursor. True when finished (its record is gone). */
  async function run(p: PendingErase, budgetMs: number): Promise<boolean> {
    // An org that never kept evidence has nothing to erase: one read, no lists. The two reads before the record exists are tried twice, and when one still fails the record is written first (a close or an archive
    // swallows the error, so without a record nothing would resume the erase); with no marker the resume finds nothing to do and clears it.
    let stored: boolean;
    try { stored = await twice(() => evidenceStoredIn(ports, p.orgId)); } catch (error) { await ensureRecord(p); throw error; }
    if (!stored) { await clear(p); return true; }
    const stop = now() + budgetMs;
    let progress: Awaited<ReturnType<typeof load>>;
    try { progress = await twice(() => load(p)); } catch (error) { await ensureRecord(p); throw error; }
    // The pending record is written BEFORE any work, so a pass that dies anywhere (not only one that runs out of time) is found and finished by the scheduled run.
    if (!progress.exists) await save(p, {});
    let done: boolean;
    if (p.kind === "person") done = await walk(p, progress, stop, personPage(p.orgId, p.scopeKey));
    else if (p.kind === "project") done = await walk(p, progress, stop, workspacePage(p.orgId, p.scopeKey));
    else {
      const projects = await projectsOf(p.orgId);
      let cursor = progress.cursor;
      done = true;
      for (let next = progress.projectNext ?? 0; next < projects.length; next += 1) {
        // The walk saves {projectNext, cursor} after each page, so a pass that stops mid-project continues in that project.
        if (!(await walk(p, { projectNext: next, cursor }, stop, workspacePage(p.orgId, projects[next]!)))) { done = false; break; }
        cursor = undefined;
        if (next + 1 < projects.length) {
          await save(p, { projectNext: next + 1 });
          if (now() >= stop) { done = false; break; }
        }
      }
    }
    if (done) await clear(p);
    return done;
  }

  const required = async (p: PendingErase) => { if (!(await run(p, ports.maxMs ?? 20_000))) throw unfinished(); };
  return {
    person: (orgId, developerId) => required({ orgId, kind: "person", scopeKey: developerId }),
    project: (orgId, project) => required({ orgId, kind: "project", scopeKey: project }),
    workspace: (orgId) => required({ orgId, kind: "workspace", scopeKey: "-" }),
    resume: (pending, budgetMs) => run(pending, budgetMs),
  };
}

/**
 * The erases a caller left unfinished, finished within `millis` (the scheduled run). Each is continued from its cursor. All pending records are paged through, not only the first page: records that keep failing cannot
 * starve the later ones, and each record gets at most half of the time that is left, so one slow erase cannot take the whole run either.
 */
export async function resumeEvidenceErase(ports: EvidenceErasePorts, erase: Pick<EvidenceErase, "resume">, limits: { millis: number; max?: number }): Promise<{ pending: number; finished: number }> {
  const now = ports.now ?? Date.now;
  const stop = now() + limits.millis;
  let seen = 0;
  let finished = 0;
  let start: Key | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const read = await ports.documentClient.send(new QueryCommand({ TableName: ports.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": PENDING_PK }, Limit: limits.max ?? 20, ...(start === undefined ? {} : { ExclusiveStartKey: start }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Key };
    const items = read.Items ?? [];
    seen += items.length;
    for (const item of items) {
      const left = stop - now();
      if (left < 500) return { pending: seen, finished };
      if (typeof item.orgId !== "string" || typeof item.scopeKey !== "string" || (item.kind !== "person" && item.kind !== "project" && item.kind !== "workspace")) continue;
      try { if (await erase.resume({ orgId: item.orgId, kind: item.kind, scopeKey: item.scopeKey }, Math.max(500, Math.floor(left / 2)))) finished += 1; } catch { /* the next run goes on from the cursor */ }
    }
    start = read.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return { pending: seen, finished };
}
