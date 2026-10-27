import { logDeveloperEvent } from "../developer/log.js";
// Sparse org invite projection. Canonical records decide pending state; bearer material never leaves this module.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, AppOrgInvitesResponseSchema, OrgIdSchema, agentXError, orgInviteDirectoryKey, orgInviteKey, orgMemberKey, orgPk, orgScoped } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { takeRateAt } from "../developer/page-comments.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">;
const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema = z.object({ orgId: OrgIdSchema, inviteId: id, tokenHash: hash, entityType: z.literal("ORG_INVITE_DIRECTORY"), pk: z.string(), sk: z.string() });
const canonicalSchema = z.object({ orgId: OrgIdSchema, inviteId: id, tokenHash: hash, role: z.enum(["admin", "member"]), createdBy: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), email: z.string().max(254).email().optional(), acceptedAt: z.string().datetime().optional(), revokedAt: z.string().datetime().optional(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() });
const cursorSchema = z.object({ orgId: OrgIdSchema, after: id }).strict();
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The invite directory is unavailable. Try again.");
const invalid = () => agentXError("CONFIG_INVALID", "Refresh the invite directory and try again.");
async function get(deps: Deps, key: { pk: string; sk: string }) {
 const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };return result.Item;
}
export async function listOrganizationInvites(deps: Deps, caller: DeveloperCaller, url: URL) {
 try {
  const member = await get(deps, orgMemberKey(caller.orgId, caller.developerId));
  if (member?.orgId !== caller.orgId || member.developerId !== caller.developerId || (member.role !== "owner" && member.role !== "admin")) throw agentXError("FORBIDDEN", "Only company owners and admins can view invites.");
  const params = [...url.searchParams];
  if (new Set(params.map(([key]) => key)).size !== params.length || params.some(([key]) => key !== "limit" && key !== "cursor")) throw invalid();
  const rawLimit = url.searchParams.get("limit"), limit = rawLimit === null ? 25 : /^\d{1,2}$/.test(rawLimit) ? Number(rawLimit) : 0;
  if (limit < 1 || limit > 50) throw invalid();
  let start: { pk: string; sk: string } | undefined;
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) {
   if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor) || Buffer.from(cursor, "base64url").toString("base64url") !== cursor) throw invalid();
   let value: unknown;try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown; } catch { throw invalid(); }
   const parsed = cursorSchema.safeParse(value);if (!parsed.success || parsed.data.orgId !== caller.orgId) throw invalid();start = orgInviteDirectoryKey(caller.orgId, parsed.data.after);
  }
  if (!await takeRateAt(deps, { pk: orgScoped(caller.orgId, "INVITE_DIRECTORY_RATE"), sk: caller.developerId }, 20, 60_000)) throw agentXError("TOO_MANY_REQUESTS", "Too many invite checks. Try again shortly.");
  const page = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(caller.orgId), ":prefix": "INVITE_DIRECTORY#" }, ConsistentRead: true, Limit: limit, ...(start === undefined ? {} : { ExclusiveStartKey: start }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
  const rows = page.Items ?? [];if (rows.length > limit) throw unavailable();
  const invites: z.infer<typeof AppOrgInvitesResponseSchema>["invites"] = [];
  const nowMs = deps.now(), now = new Date(nowMs).toISOString();let unavailableCount = 0;
  const badEntry = (row: Record<string, unknown>, reason: "reference_invalid" | "reference_org_mismatch" | "reference_key_mismatch" | "canonical_missing" | "canonical_invalid" | "canonical_org_mismatch" | "canonical_reference_mismatch") => {
   unavailableCount++;const keyId = id.safeParse(row.pk === orgPk(caller.orgId) && typeof row.sk === "string" && row.sk.startsWith("INVITE_DIRECTORY#") ? row.sk.slice("INVITE_DIRECTORY#".length) : undefined);
   const publicId = keyId.success ? keyId : id.safeParse(row.inviteId), requestOrg = OrgIdSchema.safeParse(caller.orgId);
   try { logDeveloperEvent({ event: "org.invite_directory_entry_unavailable", level: "warn", ...(requestOrg.success ? { orgId: requestOrg.data } : {}), ...(publicId.success ? { inviteId: publicId.data } : {}), reason }); } catch { /* A warning sink must not make partial reads fail. */ }
   return undefined;
  };
  // Bound fanout as well as each page. Index rows contain no email or raw token.
  for (let at = 0; at < rows.length; at += 8) {
   const batch = await Promise.all(rows.slice(at, at + 8).map(async row => {
    const parsed = referenceSchema.safeParse(row);if (!parsed.success) return badEntry(row, "reference_invalid");const ref = parsed.data, key = orgInviteDirectoryKey(caller.orgId, ref.inviteId);
    if (ref.orgId !== caller.orgId) return badEntry(row, "reference_org_mismatch");
    if (ref.pk !== key.pk || ref.sk !== key.sk) return badEntry(row, "reference_key_mismatch");
    const record = await get(deps, orgInviteKey(ref.tokenHash));if (record === undefined) return badEntry(row, "canonical_missing");
    const canonical = canonicalSchema.safeParse(record);if (!canonical.success) return badEntry(row, "canonical_invalid");const invite = canonical.data;
    if (invite.orgId !== caller.orgId) return badEntry(row, "canonical_org_mismatch");
    if (invite.inviteId !== ref.inviteId || invite.tokenHash !== ref.tokenHash) return badEntry(row, "canonical_reference_mismatch");
    if (invite.revokedAt !== undefined || invite.acceptedAt !== undefined || Date.parse(invite.expiresAt) <= nowMs) return undefined;
    return { inviteId: invite.inviteId, revision: invite.revision ?? 0, role: invite.role, createdAt: invite.createdAt, expiresAt: invite.expiresAt, createdBy: invite.createdBy, destination: invite.email === undefined ? { kind: "link" as const } : { kind: "email" as const, label: `***@${invite.email.slice(invite.email.lastIndexOf("@") + 1)}` } };
   }));for (const invite of batch) if (invite !== undefined) invites.push(invite);
  }
  let nextCursor: string | undefined;
  if (page.LastEvaluatedKey !== undefined) {
   const last = page.LastEvaluatedKey, after = typeof last.sk === "string" && last.sk.startsWith("INVITE_DIRECTORY#") ? last.sk.slice("INVITE_DIRECTORY#".length) : undefined;
   if (last.pk !== orgPk(caller.orgId) || !id.safeParse(after).success) throw unavailable();nextCursor = Buffer.from(JSON.stringify({ orgId: caller.orgId, after })).toString("base64url");
  }
  return AppOrgInvitesResponseSchema.parse({ invites, unavailableCount, coverage: unavailableCount > 0 ? "indexed_only_partial" : "indexed_only", checkedAt: now, ...(nextCursor === undefined ? {} : { nextCursor }) });
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
