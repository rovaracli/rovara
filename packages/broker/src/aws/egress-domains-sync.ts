// Plan 2, Task 19: the approved egress domains reach the cell's DNS firewall. The firewall's rule group holds a second ALLOW list, "ProjectAllowList",
// between the default allow list (priority 100) and the block-everything rule (200); this module keeps that list equal to `approvedUnion`.
// It is the one union spec 002 assigns to the firewall layer; giving each workspace only its own project's additions needs the per-project egress
// proxy, which comes after launch.
//
// Every write that changes the union adds one to the sync marker's `dirtySeq` (see `EGRESS_SYNC_KEY`). A run reads the marker, then the union, sends
// the union, and clears the marker only if `dirtySeq` is still what it read, so a change made meanwhile keeps it dirty and is sent next time.
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetFirewallDomainListCommand, UpdateFirewallDomainsCommand, type Route53ResolverClient } from "@aws-sdk/client-route53resolver";
import {
  DEFAULT_AGENT_ALLOW_DOMAINS,
  EGRESS_DOMAINS_PK,
  EGRESS_SYNC_KEY,
  EgressSyncMarkerSchema,
  orgOfProjectPk,
  projectPk,
  type OrgId,
  type OrgKey,
} from "@agentx/contracts";
import { approvedUnion, putEgressDomains, readEgressDomains, type EgressDomainsDependencies } from "../org/egress-domains.js";
import { projectIsActive } from "../org/project-settings.js";

/** Route 53 Resolver's UpdateFirewallDomains: "There is a limit of 1000 domains per request" (API reference, UpdateFirewallDomains, Domains). */
export const FIREWALL_DOMAINS_PER_CALL = 1000;

/**
 * What an empty union is replaced with: a domain list may not be empty on a REPLACE, and `.invalid` is reserved (RFC 2606) so it can never
 * name a real site.
 */
export const EMPTY_UNION_SENTINEL = "none.invalid";

/** Set once the legacy backfill has run to the end: `{ completedAt, projects }`. Its sort key does not start with `ORG#`, so no egress query reads it. */
export const EGRESS_BACKFILL_KEY: OrgKey = { pk: EGRESS_DOMAINS_PK, sk: "BACKFILL" };

/** After an update the list reads UPDATING until Resolver has applied it; a second update meanwhile would be refused. Polled this often, this many times. */
const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 15;

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

async function readMarker(deps: Pick<SyncCellAllowListDependencies, "documentClient" | "tableName">): Promise<{ dirtySeq: number; syncedSeq: number } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: EGRESS_SYNC_KEY, ConsistentRead: true })) as { Item?: unknown };
  if (response.Item === undefined) return undefined;
  const parsed = EgressSyncMarkerSchema.partial().safeParse(response.Item);
  if (!parsed.success) throw new Error("the egress sync marker could not be read");
  return { dirtySeq: parsed.data.dirtySeq ?? 0, syncedSeq: parsed.data.syncedSeq ?? 0 };
}

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
    if (marker === undefined || marker.dirtySeq <= marker.syncedSeq) return { ok: true, domains: 0 };
    const union = await approvedUnion(deps);
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
        UpdateExpression: "SET syncedAt = :now, syncedSeq = :seq",
        ConditionExpression: "dirtySeq = :seq",
        ExpressionAttributeValues: { ":now": deps.now().toISOString(), ":seq": marker.dirtySeq },
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

/** The newest revision's allowed domains of every project that has some, as `{ orgId, project, domains }`; one page at a time of the whole table, once. */
async function projectsWithStoredDomains(deps: Pick<EgressDomainsDependencies, "documentClient" | "tableName">): Promise<Array<{ orgId: OrgId; project: string; domains: string[] }>> {
  const newest = new Map<string, { sk: string; domains: string[] }>();
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new ScanCommand({
      TableName: deps.tableName,
      FilterExpression: "begins_with(sk, :revision)",
      ProjectionExpression: "pk, sk, #definition.#network",
      ExpressionAttributeNames: { "#definition": "definition", "#network": "network" },
      ExpressionAttributeValues: { ":revision": PROJECT_SK_PREFIX },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ pk?: unknown; sk?: unknown; definition?: { network?: { allowedDomains?: unknown } } }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (typeof item.pk !== "string" || typeof item.sk !== "string" || orgOfProjectPk(item.pk) === undefined) continue;
      const listed = item.definition?.network?.allowedDomains;
      const domains = Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === "string") : [];
      const seen = newest.get(item.pk);
      if (seen === undefined || item.sk > seen.sk) newest.set(item.pk, { sk: item.sk, domains });
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return [...newest.entries()].flatMap(([pk, { domains }]) => {
    const orgId = orgOfProjectPk(pk)!;
    const project = pk.slice(`ORG#${orgId}#PROJECT#`.length);
    return domains.length === 0 || projectPk(orgId, project) !== pk ? [] : [{ orgId, project, domains }];
  });
}

/**
 * Task 18 Minor 1. A domain stored on a project before approvals existed has no egress item, so it read "waiting for Rovara" with no request
 * for staff to answer. Once, on Rovara Cloud, this asks for every such project's newest stored domains through `putEgressDomains` as the
 * system: each becomes a pending request staff see. Nothing is approved, so nothing reaches the firewall.
 *
 * Chosen over an operator step because the scheduled sync already runs on every cloud install, so no one has to remember it. It reads the whole
 * table once (a filtered Scan) and then writes a marker so it never runs again. A project that already has an item is skipped: it has been
 * saved since approvals existed, and its item, not the older stored revision, is the truth. An archived project's item starts inactive. If
 * it stops partway the marker is not written and the next run finishes (the writes are idempotent).
 */
export async function backfillLegacyEgress(deps: EgressDomainsDependencies): Promise<{ ran: boolean; projects: number }> {
  if (!deps.cloud) return { ran: false, projects: 0 };
  const done = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: EGRESS_BACKFILL_KEY, ConsistentRead: true })) as { Item?: unknown };
  if (done.Item !== undefined) return { ran: false, projects: 0 };
  let projects = 0;
  for (const { orgId, project, domains } of await projectsWithStoredDomains(deps)) {
    const owner = { kind: "project", project } as const;
    if (await readEgressDomains(deps, orgId, owner) !== undefined) continue;
    const asked = [...new Set(domains)].filter((domain) => !DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain));
    if (asked.length === 0) continue;
    await putEgressDomains(deps, orgId, owner, asked, undefined, { ownerActive: await projectIsActive(deps, orgId, project) });
    projects += 1;
  }
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...EGRESS_BACKFILL_KEY, entityType: "EGRESS_BACKFILL", completedAt: deps.now().toISOString(), projects },
  }));
  log("backfilled", { projects });
  return { ran: true, projects };
}

/**
 * The scheduled run (every 5 minutes): the one-off legacy backfill, then the sync. A backfill failure does not stop the sync (the firewall must
 * follow approvals either way) but makes the result `{ ok: false }` so the run is seen to have failed and tried again.
 */
export async function runEgressDomainsSync(deps: EgressDomainsDependencies): Promise<{ ok: boolean; domains: number; backfilled: number }> {
  let backfilled = 0;
  let backfillOk = true;
  try {
    backfilled = (await backfillLegacyEgress(deps)).projects;
  } catch (error) {
    backfillOk = false;
    log("backfill_failed", { error: error instanceof Error ? error.name : "UnknownError" });
  }
  const synced = await deps.sync();
  return { ok: synced.ok && backfillOk, domains: synced.domains ?? 0, backfilled };
}
