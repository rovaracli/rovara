// Insights: the viewer grant (decision 32). An admin gives a plain member the Insights viewer grant, or takes it away. The grant is two fields on the member's own record (`insightsViewer`, `insightsGrantedAt`: a flag and a time, no person id), never a role, and it widens nothing but the scope of the Insights reads (rows the person could not open stay metadata rows).
//   GET   an owner or admin (read live from the member record): who holds the grant, when it was given, who gave it (read from the audit ledger's `insights_access.granted` event for exactly that grant, and left out when none can be read: never guessed), and how many members could be given it;
//   POST  an owner or admin, from a live browser session only (the route checks it again here): { action: "grant" | "revoke", requestId, developerId }.
// One transaction holds the change, the actor's role check, the request item that makes a repeat of the same requestId answer the stored outcome and write nothing, and the audit item
// (`insights_access.granted` / `insights_access.revoked`, the member as target, no facts). The same requestId with a different body is refused (CONFIG_INVALID). A grant to an owner, an admin or an
// Auditor is refused; a grant to someone who is not a member is not found; a grant already held (or a revoke of one not held) is 200, changes no member and writes no audit event, but still takes the requestId (only the request item is written). The request item holds a
// fingerprint, never a person's id, and expires with the State table's TTL.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, OrgRoleSchema, agentXError, auditEventId, orgMemberKey, orgPk, orgScoped, type AuditEventInput, type InsightsAccess, type InsightsAccessBody, type OrgId } from "@agentx/contracts";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditDeps } from "../audit/outbox.js";
import { queryPartition } from "../agent-sessions/live.js";
import type { GrantLookup } from "./granters.js";
import { insightsNames, type InsightsNameDependencies } from "./names.js";
import { INSIGHTS_ADMIN_ONLY, grantHolds, readMemberRecord, type InsightsCaller, type InsightsScopeDependencies } from "./scope.js";

export const INSIGHTS_ACCESS_BROWSER_MESSAGE = "Use a live browser session to change who can see Insights.";
const REQUEST_MEMORY_SECONDS = 7 * 24 * 3600;
const MEMBERS_MAX = 10_000;

export interface InsightsAccessDependencies extends InsightsScopeDependencies, InsightsNameDependencies, AuditDeps {
  /** Who gave each grant, from the audit ledger. Without it (or when it cannot be read) the list shows the date only. */
  grantedBy?: GrantLookup | undefined;
}
type Item = Record<string, unknown>;

const requestKey = (orgId: OrgId, requestId: string) => ({ pk: orgScoped(orgId, "INSIGHTS_ACCESS_REQUEST"), sk: requestId });
const fingerprintOf = (orgId: string, actor: string, body: InsightsAccessBody): string => createHash("sha256").update([orgId, actor, body.action, body.developerId].join("\n")).digest("hex");

/** The caller's role NOW from their member record: only an owner or an admin passes. */
async function requireLiveAdmin(deps: InsightsAccessDependencies, caller: InsightsCaller): Promise<"owner" | "admin"> {
  const record = await readMemberRecord(deps, caller.orgId, caller.developerId);
  const role = OrgRoleSchema.safeParse(record?.["role"]);
  if (!role.success || (role.data !== "owner" && role.data !== "admin")) throw agentXError("FORBIDDEN", INSIGHTS_ADMIN_ONLY);
  return role.data;
}

/** Who holds the grant and how many members could be given it: every figure from the member records of the caller's company. */
export async function readInsightsAccess(deps: InsightsAccessDependencies, caller: InsightsCaller): Promise<InsightsAccess> {
  await requireLiveAdmin(deps, caller);
  return listAccess(deps, caller);
}

async function listAccess(deps: InsightsAccessDependencies, caller: InsightsCaller): Promise<InsightsAccess> {
  const members = await queryPartition(deps, orgPk(caller.orgId), { prefix: "MEMBER#", max: MEMBERS_MAX });
  const holders = members.items.filter((item) => grantHolds(item));
  const eligibleCount = members.items.filter((item) => item["role"] === "member" && !grantHolds(item)).length;
  const grants = holders.map((item) => ({ developerId: String(item["developerId"]), at: new Date(Date.parse(String(item["insightsGrantedAt"]))).toISOString() }));
  // Who gave each grant: the ledger's event for exactly this member at exactly this time. A ledger that cannot answer leaves the name out; nothing is guessed.
  let granters = new Map<string, string>();
  if (deps.grantedBy !== undefined && grants.length > 0) {
    try { granters = await deps.grantedBy(caller, grants); } catch { console.log(JSON.stringify({ component: "broker", event: "insights.granters_unavailable" })); }
  }
  const names = await insightsNames(deps, caller.orgId, [...grants.map((grant) => grant.developerId), ...granters.values()]);
  const viewers = grants.map((grant) => {
    const by = granters.get(grant.developerId);
    return { person: { id: grant.developerId, name: names.get(grant.developerId) ?? "Unknown" }, ...(by === undefined ? {} : { grantedBy: { id: by, name: names.get(by) ?? "Unknown" } }), grantedAt: grant.at };
  }).sort((a, b) => a.person.name.localeCompare(b.person.name) || a.person.id.localeCompare(b.person.id));
  return { viewers, eligibleCount };
}

const refusedTarget = (role: unknown) => agentXError("CONFIG_INVALID", role === "auditor" ? "An Auditor reads the audit log only." : role === "owner" || role === "admin" ? "That person already sees Insights." : "Only a member can be given Insights access.");

export async function changeInsightsAccess(deps: InsightsAccessDependencies, caller: InsightsCaller, body: InsightsAccessBody): Promise<InsightsAccess> {
  // Defence in depth: the route dispatcher refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", INSIGHTS_ACCESS_BROWSER_MESSAGE);
  const actorRole = await requireLiveAdmin(deps, caller);
  const orgId = caller.orgId;
  const fingerprint = fingerprintOf(orgId, caller.developerId, body);
  const read = async (key: { pk: string; sk: string }) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
  // A repeat of the same request answers the stored outcome (the list now) and writes nothing; the same id with another body is refused.
  const seen = await read(requestKey(orgId, body.requestId));
  if (seen !== undefined) {
    if (seen["fingerprint"] !== fingerprint) throw agentXError("CONFIG_INVALID", "requestId: already used for a different request");
    return listAccess(deps, caller);
  }
  const target = await readMemberRecord(deps, orgId, body.developerId);
  if (target === undefined) throw agentXError("NOT_FOUND", "Not found.");
  const held = grantHolds(target);
  if (body.action === "grant" && target["role"] !== "member") throw refusedTarget(target["role"]);
  const noop = body.action === "grant" ? held : target["insightsViewer"] === undefined;

  const now = deps.now();
  const at = new Date(now).toISOString();
  // The request item is written for a change AND for a no-op (a grant already held, a revoke of one not held): the id is then taken, so the same id with another body is refused and the same body replays.
  const requestItem = { Put: { TableName: deps.tableName, Item: { ...requestKey(orgId, body.requestId), entityType: "INSIGHTS_ACCESS_REQUEST", requestId: body.requestId, fingerprint, action: body.action, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + REQUEST_MEMORY_SECONDS }, ConditionExpression: "attribute_not_exists(pk)" } };
  // The actor is still the owner or admin they were read as.
  const actorCheck = { ConditionCheck: { TableName: deps.tableName, Key: orgMemberKey(orgId, caller.developerId), ConditionExpression: "attribute_exists(pk) AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": actorRole } } };
  const event: AuditEventInput = {
    eventId: auditEventId(body.action === "grant" ? "insights_access.granted" : "insights_access.revoked", body.requestId, orgId, caller.developerId, body.developerId),
    orgId, action: body.action === "grant" ? "insights_access.granted" : "insights_access.revoked",
    actor: { kind: "member", id: caller.developerId }, target: { kind: "member", id: body.developerId }, occurredAt: at,
  };
  let items: unknown[];
  if (noop) items = [actorCheck, requestItem];
  else {
    const put = auditPending(deps, event)[0]?.Put;
    if (put === undefined) throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    const change = body.action === "grant"
      ? {
        Update: {
          TableName: deps.tableName, Key: orgMemberKey(orgId, body.developerId),
          UpdateExpression: "SET insightsViewer = :yes, insightsGrantedAt = :at",
          // What was read is what is written over: a member who is still a plain member, with no grant (or the very stale one that was read).
          ConditionExpression: target["insightsViewer"] === undefined ? "attribute_exists(pk) AND #role = :member AND attribute_not_exists(insightsViewer)" : "attribute_exists(pk) AND #role = :member AND insightsGrantedAt = :seen",
          ExpressionAttributeNames: { "#role": "role" },
          ExpressionAttributeValues: { ":yes": true, ":at": at, ":member": "member", ...(target["insightsViewer"] === undefined ? {} : { ":seen": target["insightsGrantedAt"] }) },
        },
      }
      : {
        Update: {
          TableName: deps.tableName, Key: orgMemberKey(orgId, body.developerId),
          UpdateExpression: "REMOVE insightsViewer, insightsGrantedAt",
          ConditionExpression: "attribute_exists(pk) AND attribute_exists(insightsViewer)",
        },
      };
    items = [actorCheck, change, requestItem, { Put: put }];
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items as never }));
  } catch (error) {
    if (!(error instanceof Error) || (error.name !== "TransactionCanceledException" && error.name !== "TransactionConflictException")) throw error;
    // The transaction can be cancelled although an earlier try of the same request succeeded: read the request item again before deciding.
    const again = await read(requestKey(orgId, body.requestId));
    if (again?.["fingerprint"] === fingerprint) return listAccess(deps, caller);
    throw agentXError("CHANGE_STALE", "That person's record changed. Reload and try again.");
  }
  if (!noop) await flushAuditEvents(deps, [event]);
  return listAccess(deps, caller);
}
