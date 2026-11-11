// Plan 2, Task 19: the approved egress domains reach the cell's DNS firewall. The firewall's rule group holds a second ALLOW list, "ProjectAllowList",
// between the default allow list (priority 100) and the block-everything rule (200); this module keeps that list equal to `approvedUnion`.
// It is the one union spec 002 assigns to the firewall layer; giving each workspace only its own project's additions needs the per-project egress
// proxy, which comes after launch.
//
// Every write that changes the union adds one to the sync marker's `dirtySeq` (see `EGRESS_SYNC_KEY`). A run reads the marker, then the union, sends
// the union, and clears the marker only if `dirtySeq` is still what it read, so a change made meanwhile keeps it dirty and is sent next time.
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetFirewallDomainListCommand, UpdateFirewallDomainsCommand, type Route53ResolverClient } from "@aws-sdk/client-route53resolver";
import { DEFAULT_AGENT_ALLOW_DOMAINS, EGRESS_DOMAINS_PK, EGRESS_SYNC_KEY, EgressSyncMarkerSchema, PROJECT_REVISION_SK_PREFIX, isAllowedDomain, orgOfProjectPk, projectPk, type OrgId, type OrgKey } from "@rovara-code/contracts";
import { reconcileProjectEgress } from "../org/project-archive.js";
import { RECONCILE_READ_CONCURRENCY, settleBounded } from "../org/settle-bounded.js";
import { approvedUnion, listEgressItems, putEgressDomains, readEgressDomains, type EgressDomainsDependencies } from "../org/egress-domains.js";

/** Route 53 Resolver's UpdateFirewallDomains: "There is a limit of 1000 domains per request" (API reference, UpdateFirewallDomains, Domains). */
export const FIREWALL_DOMAINS_PER_CALL = 1000;

/**
 * What an empty union is replaced with: a domain list may not be empty on a REPLACE, and `.invalid` is reserved (RFC 2606) so it can never
 * name a real site.
 */
export const EMPTY_UNION_SENTINEL = "none.invalid";

/** Set once the legacy backfill has run to the end: `{ completedAt, projects }`. Its sort key does not start with `ORG#`, so no egress query reads it. */
export const EGRESS_BACKFILL_KEY: OrgKey = { pk: EGRESS_DOMAINS_PK, sk: "BACKFILL" };

/*
 * Limits worth knowing. Each chunk of 1000 may wait up to MAX_POLLS seconds for the list to settle, and the broker has 30 seconds, so an INLINE sync
 * (the one an approval triggers) can finish only about two chunks, a union of about 2,000 domains; past that the approval's answer can time out. That
 * is safe: the change is already stored, the marker stays dirty, and the scheduled run (its own 30 seconds, then retried every 5 minutes) finishes the
 * sync. Fifty domains a project makes that many domains a 40-project cell, far past launch. If a union grows near it, split the sync into one chunk
 * per invocation instead of raising the timeout.
 */

/** After an update the list reads UPDATING until Resolver has applied it; a second update meanwhile would be refused. Polled this often, this many times. */
// Ten seconds at most: an approval waits for this inside the broker's 30 second request, and a run that gives up is retried by the schedule.
const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 10;

export interface SyncCellAllowListDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  resolver: Pick<Route53ResolverClient, "send">;
  /** The "ProjectAllowList" domain list's id (AGENT_PROJECT_ALLOW_LIST_ID). */
  listId: string;
  now: () => Date;
  /** Waits between status reads; tests pass a quick one. */
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event: `egress.${event}`, ...fields }));

interface Marker { dirtySeq: number | undefined; syncedSeq: number; syncedListId: string | undefined }

async function readMarker(deps: Pick<SyncCellAllowListDependencies, "documentClient" | "tableName">): Promise<Marker | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: EGRESS_SYNC_KEY, ConsistentRead: true })) as { Item?: unknown };
  if (response.Item === undefined) return undefined;
  const parsed = EgressSyncMarkerSchema.partial().safeParse(response.Item);
  if (!parsed.success) throw new Error("the egress sync marker could not be read");
  return { dirtySeq: parsed.data.dirtySeq, syncedSeq: parsed.data.syncedSeq ?? 0, syncedListId: parsed.data.syncedListId };
}

/**
 * The marker is dirty when a change is newer than the last sync, or when that sync filled another list (the project list was replaced, so it is
 * empty and the clean marker would leave it so), or when it carries no `dirtySeq` at all and has not been synced into this list (written before
 * the counter existed).
 */
const isDirty = (marker: Marker, listId: string): boolean => marker.syncedListId !== listId || (marker.dirtySeq ?? 0) > marker.syncedSeq;

/** Waits until the list has applied the last update; false when it did not in time or the update failed. */
async function listSettled(deps: SyncCellAllowListDependencies): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const { FirewallDomainList } = await deps.resolver.send(new GetFirewallDomainListCommand({ FirewallDomainListId: deps.listId }));
    if (FirewallDomainList?.Status === "COMPLETE") return true;
    if (FirewallDomainList?.Status !== "UPDATING" && FirewallDomainList?.Status !== "IMPORTING") return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * Makes the firewall's project allow list exactly the approved union, when the sync marker says it is not. One REPLACE with the first chunk of
 * the sorted union, then an ADD for each further chunk of `FIREWALL_DOMAINS_PER_CALL`, each after the list has finished the one before. An empty
 * union is the single `EMPTY_UNION_SENTINEL`. `domains` is how many real domains were sent (0 when the marker was clean and nothing was).
 *
 * The marker is cleared only with the condition that `dirtySeq` is still what was read. When that fails, a change landed (it keeps the marker
 * dirty by itself) or another run cleared it first, in which case this run may have left an older union in the list; it then adds one to
 * `dirtySeq` so the marker is dirty again and the next run puts it right. Either way the result is `{ ok: false }`.
 *
 * Any failure (Resolver, DynamoDB) leaves the marker as it was and returns `{ ok: false }`; the schedule runs it again.
 */
export async function syncCellAllowList(deps: SyncCellAllowListDependencies): Promise<{ ok: boolean; domains: number }> {
  try {
    // The marker first, then the union: a change written after this read has a higher `dirtySeq` and keeps the marker dirty.
    const marker = await readMarker(deps);
    if (marker === undefined || !isDirty(marker, deps.listId)) return { ok: true, domains: 0 };
    // The last line of defence: a domain the firewall must never serve (`*` would open the cell) is dropped here whatever stored it.
    const approved = await approvedUnion(deps);
    const union = approved.filter(isAllowedDomain);
    if (union.length !== approved.length) log("domains_dropped", { dropped: approved.length - union.length, examples: approved.filter((domain) => !isAllowedDomain(domain)).slice(0, 5) });
    const domains = union.length === 0 ? [EMPTY_UNION_SENTINEL] : union;
    for (let start = 0; start < domains.length; start += FIREWALL_DOMAINS_PER_CALL) {
      await deps.resolver.send(new UpdateFirewallDomainsCommand({
        FirewallDomainListId: deps.listId,
        Operation: start === 0 ? "REPLACE" : "ADD",
        Domains: domains.slice(start, start + FIREWALL_DOMAINS_PER_CALL),
      }));
      if (!(await listSettled(deps))) {
        log("sync_unsettled", { domains: union.length });
        return { ok: false, domains: 0 };
      }
    }
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName,
        Key: EGRESS_SYNC_KEY,
        UpdateExpression: "SET syncedAt = :now, syncedSeq = :seq, syncedListId = :list",
        // A marker that never had a counter is cleared while it still has none.
        ConditionExpression: marker.dirtySeq === undefined ? "attribute_not_exists(dirtySeq)" : "dirtySeq = :seq",
        ExpressionAttributeValues: { ":now": deps.now().toISOString(), ":seq": marker.dirtySeq ?? 0, ":list": deps.listId },
      }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
      // Only when another run has already cleared the marker over this one (a change landing leaves it dirty by itself).
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName,
        Key: EGRESS_SYNC_KEY,
        UpdateExpression: "SET dirtySeq = dirtySeq + :one",
        ConditionExpression: "attribute_exists(syncedSeq) AND dirtySeq <= syncedSeq",
        ExpressionAttributeValues: { ":one": 1 },
      })).catch((reaction: unknown) => {
        if (!(reaction instanceof Error) || reaction.name !== "ConditionalCheckFailedException") throw reaction;
      });
      log("sync_superseded", { domains: union.length });
      return { ok: false, domains: 0 };
    }
    log("synced", { domains: union.length });
    return { ok: true, domains: union.length };
  } catch (error) {
    log("sync_failed", { error: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "" });
    return { ok: false, domains: 0 };
  }
}

const PROJECT_SK_PREFIX = "REV#";

/** How long the scheduled run lets the backfill work after the sync, of the broker's 30 seconds. */
export const BACKFILL_BUDGET_MS = 15_000;

export interface BackfillOptions {
  /** When to stop (epoch milliseconds on `clock`): the backfill resumes from its cursor on the next run. No deadline: it runs to the end. */
  deadline?: number;
  clock?: () => number;
  /** The most items one Scan page reads; DynamoDB's own 1 MB page when absent. */
  pageSize?: number;
}

interface ProjectDomains { orgId: OrgId; project: string; domains: string[] }

const isKey = (value: unknown): value is { pk: string; sk: string } =>
  typeof value === "object" && value !== null && typeof (value as { pk?: unknown }).pk === "string" && typeof (value as { sk?: unknown }).sk === "string";

/**
 * Task 18 Minor 1. A domain stored on a project before approvals existed has no egress item, so it read "waiting for Rovara" with no request
 * for staff to answer. On Rovara Cloud this asks for every such project's newest stored domains through `putEgressDomains` as the system: each
 * becomes a pending request staff see. Nothing is approved, so nothing reaches the firewall.
 *
 * Chosen over an operator step because the scheduled sync already runs on every cloud install, so no one has to remember it. It reads the table
 * with a filtered Scan, a project at a time (a project's revisions are contiguous in a Scan, and a project is processed only once all of them
 * are read), and it is time-bounded and resumable (final review M6): when `deadline` passes it stops after the last whole project, saves a
 * cursor on its marker, and the next run carries on from it. The scheduled run calls it AFTER the sync, so a large table can never starve the
 * sync. The marker gets `completedAt` only when the Scan reaches its end, and the backfill never runs again after. A project that already has an
 * item is skipped: it has been saved since approvals existed, and its item, not the older stored revision, is the truth. An archived project's
 * item starts inactive. If it stops partway the next run finishes (the writes are idempotent).
 */
export async function backfillLegacyEgress(deps: EgressDomainsDependencies, options: BackfillOptions = {}): Promise<{ ran: boolean; projects: number }> {
  if (!deps.cloud) return { ran: false, projects: 0 };
  const clock = options.clock ?? Date.now;
  // A run always finishes one whole project before it looks at the clock, so a run that starts late still moves the cursor on.
  let progressed = false;
  const outOfTime = () => progressed && options.deadline !== undefined && clock() >= options.deadline;
  const marker = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: EGRESS_BACKFILL_KEY, ConsistentRead: true }))) as { Item?: { completedAt?: unknown; cursor?: unknown; projects?: unknown } };
  if (marker.Item?.completedAt !== undefined) return { ran: false, projects: 0 };
  const priorProjects = typeof marker.Item?.projects === "number" ? marker.Item.projects : 0;
  // Where the last run stopped: after the last item of the last whole project it processed.
  let committed: { pk: string; sk: string } | undefined = isKey(marker.Item?.cursor) ? marker.Item.cursor : undefined;
  let projects = 0;
  let finished = false;

  const askFor = async ({ orgId, project, domains }: ProjectDomains): Promise<boolean> => {
    const owner = { kind: "project", project } as const;
    if (await readEgressDomains(deps, orgId, owner) !== undefined) return false;
    // Stored domains are read lower case, as the project reads them; any the firewall must never serve is left out and logged, not asked about.
    const stored = [...new Set(domains.map((domain) => domain.toLowerCase()))];
    const valid = stored.filter(isAllowedDomain);
    if (valid.length !== stored.length) log("backfill_domains_dropped", { orgId, project, dropped: stored.length - valid.length });
    const asked = valid.filter((domain) => !DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain));
    if (asked.length === 0) return false;
    await putEgressDomains(deps, orgId, owner, asked);
    return true;
  };

  let group: { pk: string; newest: { sk: string; domains: string[] }; last: { pk: string; sk: string } } | undefined;
  /** Processes the group read so far, which is whole; false when out of time (nothing of it was processed). */
  const flush = async (): Promise<boolean> => {
    if (group === undefined) return true;
    if (outOfTime()) return false;
    const orgId = orgOfProjectPk(group.pk);
    if (orgId !== undefined && group.newest.domains.length > 0) {
      const project = group.pk.slice(`ORG#${orgId}#PROJECT#`.length);
      if (projectPk(orgId, project) === group.pk && await askFor({ orgId, project, domains: group.newest.domains })) projects += 1;
    }
    committed = group.last;
    group = undefined;
    progressed = true;
    return true;
  };

  try {
    let start: Record<string, unknown> | undefined = committed;
    scanning: for (;;) {
      const page = await deps.documentClient.send(new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: "begins_with(sk, :revision)",
        ProjectionExpression: "pk, sk, #definition.#network",
        ExpressionAttributeNames: { "#definition": "definition", "#network": "network" },
        ExpressionAttributeValues: { ":revision": PROJECT_SK_PREFIX },
        ConsistentRead: true,
        ...(options.pageSize === undefined ? {} : { Limit: options.pageSize }),
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Array<{ pk?: unknown; sk?: unknown; definition?: { network?: { allowedDomains?: unknown } } }>; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        if (typeof item.pk !== "string" || typeof item.sk !== "string" || orgOfProjectPk(item.pk) === undefined) continue;
        if (group !== undefined && group.pk !== item.pk && !await flush()) break scanning;
        const listed = item.definition?.network?.allowedDomains;
        const domains = Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === "string") : [];
        if (group === undefined || item.sk > group.newest.sk) group = { pk: item.pk, newest: { sk: item.sk, domains }, last: { pk: item.pk, sk: item.sk } };
        else group.last = { pk: item.pk, sk: item.sk };
      }
      start = page.LastEvaluatedKey;
      if (start === undefined) { finished = await flush(); break; }
      if (outOfTime()) break;
    }
  } finally {
    // Progress is kept whatever stopped the run (time, or a write that failed): the next run resumes after the last whole project.
    const done = finished && group === undefined;
    const written = projects > 0 || done || committed !== undefined;
    if (written) {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: {
          ...EGRESS_BACKFILL_KEY, entityType: "EGRESS_BACKFILL", projects: priorProjects + projects, updatedAt: deps.now().toISOString(),
          ...(done ? { completedAt: deps.now().toISOString() } : committed === undefined ? {} : { cursor: committed }),
        },
      })).catch((error: unknown) => log("backfill_progress_not_saved", { error: error instanceof Error ? error.name : "UnknownError" }));
    }
  }
  if (finished) log("backfilled", { projects: priorProjects + projects });
  return { ran: true, projects };
}

/**
 * An item written less than this long ago is left to the save that wrote it: a settings save writes the egress item and then its revision (ruling
 * C29), and a reconcile that read the revision between the two would undo the item.
 */
export const EGRESS_RECONCILE_GRACE_MS = 120_000;
/** Revision reads in flight at once. The repairs themselves go one at a time: each writes the sync marker, and two at once would meet in a conflict. */
export const EGRESS_RECONCILE_CONCURRENCY = RECONCILE_READ_CONCURRENCY;
/**
 * Items looked at in one run (follow-up N3), so a run's time stays bounded as projects grow. The window moves by the run's 5-minute slot, so
 * every item is reached within ceil(items / limit) runs.
 */
export const EGRESS_RECONCILE_PER_RUN = 1000;
const RUN_SLOT_MS = 300_000;

/** The allowed domains of a project's CURRENT (newest) revision, or undefined when it has none registered. Domains every project has are left out. */
async function currentRevisionDomains(deps: Pick<EgressDomainsDependencies, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<string[] | undefined> {
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    ProjectionExpression: "#definition.#network",
    ExpressionAttributeNames: { "#definition": "definition", "#network": "network" },
    ConsistentRead: true,
    Limit: 1,
    ScanIndexForward: false,
  })) as { Items?: Array<{ definition?: { network?: { allowedDomains?: unknown } } }> };
  const newest = page.Items?.[0];
  if (newest === undefined) return undefined;
  const listed = newest.definition?.network?.allowedDomains;
  const stored = Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === "string").map((domain) => domain.toLowerCase()) : [];
  return [...new Set(stored.filter((domain) => isAllowedDomain(domain) && !DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain)))];
}

/**
 * Final review I2. A settings save writes the egress item and then the revision, in that order; a save that stopped between the two, or whose
 * revision then failed to land, leaves an item that disagrees with the project's CURRENT revision. This compares every project item's domains with
 * its newest revision's and puts the item right through `putEgressDomains` as the system: a domain only the item holds is removed (audited), one only
 * the revision lists is asked for (pending on Rovara Cloud), and a status both agree on is kept. A project with no revision, an owner that is not a
 * project, and an item written within `EGRESS_RECONCILE_GRACE_MS` are left alone.
 *
 * Follow-up N3: the revision reads go `EGRESS_RECONCILE_CONCURRENCY` at a time and the repairs one at a time, and a run looks at no more than
 * `limit` items (a window that moves with the run's slot). One item failing does not stop the others; the run then throws.
 */
export async function reconcileEgressWithRevisions(deps: EgressDomainsDependencies, options: { limit?: number } = {}): Promise<{ repaired: number }> {
  const limit = Math.max(1, options.limit ?? EGRESS_RECONCILE_PER_RUN);
  const nowMs = deps.now().getTime();
  const due = (await listEgressItems(deps)).filter((item) => item.owner.kind === "project" && nowMs - Date.parse(item.updatedAt) >= EGRESS_RECONCILE_GRACE_MS);
  const start = due.length <= limit ? 0 : (Math.floor(nowMs / RUN_SLOT_MS) * limit) % due.length;
  const window = due.length <= limit ? due : [...due, ...due].slice(start, start + limit);
  const read = await settleBounded(window, EGRESS_RECONCILE_CONCURRENCY, (item) => {
    const owner = item.owner as Extract<typeof item.owner, { kind: "project" }>;
    return currentRevisionDomains(deps, item.orgId, owner.project);
  });
  let repaired = 0;
  let failed = 0;
  for (const [index, outcome] of read.entries()) {
    const item = window[index]!;
    try {
      if (outcome.status === "rejected") throw outcome.reason;
      const wanted = outcome.value;
      if (wanted === undefined) continue;
      const held = new Set(item.domains.map((entry) => entry.domain));
      if (held.size === wanted.length && wanted.every((domain) => held.has(domain))) continue;
      await putEgressDomains(deps, item.orgId, item.owner, wanted);
      repaired += 1;
      log("reconciled_with_revision", { orgId: item.orgId, project: (item.owner as { project: string }).project });
    } catch (error) {
      failed += 1;
      log("reconcile_with_revision_failed", { orgId: item.orgId, error: error instanceof Error ? error.name : "UnknownError" });
    }
  }
  if (failed > 0) throw new Error(`${String(failed)} egress item(s) could not be reconciled with their revision`);
  return { repaired };
}

/**
 * The scheduled run (every 5 minutes): the reconciles of project items with their META (Task 20) and with their current revision (I2), then the
 * sync, and only then the one-off legacy backfill, which stops when its time is up and resumes next run (final review M6). The sync comes before
 * the backfill so the firewall follows approvals whatever the backfill's size. A reconcile or backfill failure does not stop the sync but makes the
 * result `{ ok: false }`, so the run is seen to have failed and tried again.
 */
export async function runEgressDomainsSync(deps: EgressDomainsDependencies, options: { budgetMs?: number; clock?: () => number } = {}): Promise<{ ok: boolean; domains: number; backfilled: number }> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  // An archive or restore that stopped after its META write, or a save that stopped between its egress item and its revision: the items are
  // made to agree with their projects before the union is sent.
  // Follow-up N3: each in its own try, so a failure of one never skips the other.
  let reconciled = true;
  try {
    await reconcileProjectEgress({ documentClient: deps.documentClient, tableName: deps.tableName, egress: deps });
  } catch (error) {
    reconciled = false;
    log("reconcile_failed", { error: error instanceof Error ? error.name : "UnknownError" });
  }
  try {
    await reconcileEgressWithRevisions(deps);
  } catch (error) {
    reconciled = false;
    log("reconcile_with_revision_run_failed", { error: error instanceof Error ? error.name : "UnknownError" });
  }
  const synced = await deps.sync();
  let backfilled = 0;
  let backfillOk = true;
  try {
    backfilled = (await backfillLegacyEgress(deps, { deadline: started + (options.budgetMs ?? BACKFILL_BUDGET_MS), clock })).projects;
  } catch (error) {
    backfillOk = false;
    log("backfill_failed", { error: error instanceof Error ? error.name : "UnknownError" });
  }
  return { ok: synced.ok && backfillOk && reconciled, domains: synced.domains ?? 0, backfilled };
}
