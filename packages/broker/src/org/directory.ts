// Company directory privacy and exact-email lookup (owner option A, 2026-10-26).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgMemberLookupBodySchema, OrgRoleSchema, agentXError, normalizeEmail, orgEmailKey, orgMemberKey, orgScoped, type OrgRole } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { DeveloperSignInStore } from "../developer/store.js";
import { takeRateAt } from "../developer/page-comments.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "developer" | "orgs" | "now">;
async function item(deps: Deps, table: string, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
 const answer = await deps.documentClient.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };return answer.Item;
}
async function liveDirectoryRole(deps: Deps, caller: DeveloperCaller): Promise<unknown> {
 const member = await item(deps, deps.tableName, orgMemberKey(caller.orgId, caller.developerId));
 if (member === undefined || member.orgId !== caller.orgId || member.developerId !== caller.developerId) throw agentXError("FORBIDDEN", "You don't have permission to view company members.");
 return member.role;
}
const storeOf = (deps: Deps) => new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now });
export async function listOrganizationMembers(deps: Deps, caller: DeveloperCaller) {
 if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "Organizations are not available.");
 const role = await liveDirectoryRole(deps, caller), full = role === "owner" || role === "admin";
 const records = await deps.orgs.listMembers(caller.orgId), store = storeOf(deps);
 const developers = await store.getDevelopers(records.map(member => member.developerId));
 records.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.developerId.localeCompare(b.developerId));
 const listed: Array<{ developerId: string; name: string; role: OrgRole | "unknown"; email?: string; joinedAt?: string; identities?: string[] }> = [];
 // Bound concurrent reads. Restricted requests never read sign-in identity rows.
 for (let at = 0; at < records.length; at += 8) {
  const page = await Promise.all(records.slice(at, at + 8).map(async member => {
   const record = developers.get(member.developerId), parsedRole = OrgRoleSchema.safeParse(member.role);
   const publicFields = { developerId: member.developerId, name: record?.displayName ?? "Unknown", role: parsedRole.success ? parsedRole.data : "unknown" as const };
   if (!full) return publicFields;
   const identities = await store.identitiesOf(member.developerId), email = record?.email ?? identities.find(identity => identity.email !== undefined)?.email;
   const methods = identities.length > 0 ? identities.map(identity => identity.provider) : record === undefined ? [] : [record.provider];
   return { ...publicFields, ...(email === undefined ? {} : { email }), joinedAt: member.joinedAt, identities: [...new Set(methods)] };
  }));listed.push(...page);
 }
 return { members: full ? listed : listed.sort((a, b) => a.name.localeCompare(b.name) || a.developerId.localeCompare(b.developerId)) };
}
export async function lookupOrganizationMember(deps: Deps, caller: DeveloperCaller, body: unknown) {
 await liveDirectoryRole(deps, caller);
 const parsed = OrgMemberLookupBodySchema.safeParse(body);
 if (!parsed.success) throw agentXError("CONFIG_INVALID", "Enter a complete email address.");
 const allowed = await takeRateAt(deps, { pk: orgScoped(caller.orgId, "DIRECTORY_LOOKUP"), sk: caller.developerId }, 20, 60_000);
 if (!allowed) throw agentXError("TOO_MANY_REQUESTS", "Too many person lookups. Try again shortly.");
 const normalized = normalizeEmail(parsed.data.email), none = { match: null };
 if (!normalized.ascii) return none;
 const pointer = await item(deps, deps.tableName, orgEmailKey(normalized.email));
 if (pointer?.orgId !== caller.orgId || typeof pointer.developerId !== "string" || !/^[a-f0-9]{64}$/.test(pointer.developerId)) return none;
 const candidate = pointer.developerId, member = await item(deps, deps.tableName, orgMemberKey(caller.orgId, candidate));
 if (member?.orgId !== caller.orgId || member.developerId !== candidate) return none;
 const membership = await deps.orgs?.orgForDeveloper(candidate);if (membership?.orgId !== caller.orgId) return none;
 const store = storeOf(deps), record = await store.getDeveloper(candidate);if (record === undefined || record.revoked) return none;
 const identities = await store.identitiesOf(candidate), emails = [record.email, ...identities.map(identity => identity.email)];
 if (!emails.some(email => email !== undefined && normalizeEmail(email).ascii && normalizeEmail(email).email === normalized.email)) return none;
 return { match: { developerId: candidate, name: record.displayName } };
}
