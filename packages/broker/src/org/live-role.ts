// Enterprise foundations, I2: the company role a person holds NOW, read from the member record, for the surfaces that do not go through the route dispatcher (Slack, the
// approval page, GitHub reviews, task paths). The dispatcher holds an Auditor to a short allow-list; these surfaces ask here instead, and a person who is not a writer
// (the Auditor, or a role this release does not know) is refused. A person with no member record has no role: the caller decides what that means for its surface.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, agentXError, isWriterOrgRole, orgMemberKey, type OrgId, type OrgRole, type WriterOrgRole } from "@agentx/contracts";

type DocumentClient = { send(command: unknown): Promise<unknown> };

/** The person's role on record: `undefined` when there is no member record, else the stored value as it is (not parsed), so an unreadable role is not mistaken for none. */
export async function liveStoredRole(deps: { documentClient: DocumentClient; tableName: string }, orgId: OrgId, developerId: string): Promise<{ present: false } | { present: true; role: unknown }> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item === undefined ? { present: false } : { present: true, role: response.Item["role"] };
}

export const NOT_A_WRITER_MESSAGE = "Your company role can read the audit log and nothing else.";

/** How many merges a person's id is followed through (the same bound as the agent access rules). */
export const MERGE_HOPS = 8;

/** `start`, then the person each id was merged into. Refuses (FORBIDDEN) when the chain loops or is longer than MERGE_HOPS: an identity that cannot be traced to its survivor is not served. */
async function mergeChain(deps: { documentClient: DocumentClient; signInTableName: string }, start: string): Promise<string[]> {
  const ids = [start];
  for (let hop = 0; hop <= MERGE_HOPS; hop += 1) {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.signInTableName, Key: { pk: `DEVELOPER#${ids[ids.length - 1]!}`, sk: "META" }, ConsistentRead: true })) as { Item?: { mergedInto?: unknown } };
    const next = response.Item?.mergedInto;
    if (typeof next !== "string" || next === "") return ids;
    if (ids.includes(next) || hop === MERGE_HOPS) throw agentXError("FORBIDDEN", "this person's identity merges could not be followed to one person; ask an admin");
    ids.push(next);
  }
  return ids;
}

/**
 * The ids a person answers to: their own, then the person each was merged into (a Slack identity linked to another sign-in is merged into it), then the developer their identity is linked to
 * NOW and whoever that developer was merged into. The last matters after an unlink and a relink: the relink writes the link back without restoring the merge the unlink dropped, so the
 * link itself says who the identity belongs to. Later ids are the more current ones (the survivor wins).
 */
export async function personIds(deps: { documentClient: DocumentClient; signInTableName?: string | undefined }, developerId: string): Promise<string[]> {
  if (deps.signInTableName === undefined) return [developerId];
  const table = { documentClient: deps.documentClient, signInTableName: deps.signInTableName };
  const ids = await mergeChain(table, developerId);
  const link = (await deps.documentClient.send(new GetCommand({ TableName: deps.signInTableName, Key: { pk: `SIGNIN_IDENTITY#${developerId}`, sk: "META" }, ConsistentRead: true })) as { Item?: { developerId?: unknown; unlinkedFrom?: unknown } }).Item;
  if (link !== undefined && link.unlinkedFrom === undefined && typeof link.developerId === "string" && link.developerId !== developerId && !ids.includes(link.developerId)) {
    for (const id of await mergeChain(table, link.developerId)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The person's writer role now, or `undefined` when they have no member record under any id they answer to. Throws FORBIDDEN when ANY of their records holds a role that is not a
 * writer's: the Auditor, or a role this release does not know. (A person with an Auditor record under one id and a member record under another is refused, not given the member's.)
 */
export async function liveWriterRole(deps: { documentClient: DocumentClient; tableName: string; signInTableName?: string | undefined }, orgId: OrgId, developerId: string): Promise<WriterOrgRole | undefined> {
  let found: WriterOrgRole | undefined;
  for (const id of await personIds(deps, developerId)) {
    const stored = await liveStoredRole(deps, orgId, id);
    if (!stored.present) continue;
    if (!isWriterOrgRole(stored.role)) throw agentXError("FORBIDDEN", NOT_A_WRITER_MESSAGE);
    // Each id is followed to the person it was merged into, so a later record is the more current one: the survivor's role wins over a stale merged-away record's.
    found = stored.role;
  }
  return found;
}

/**
 * The person's role now, whatever it is, for a surface that only READS (a task answer, a read-only view with no tools): `undefined` when they have no member record under any id they answer
 * to, the survivor's record winning. A record whose role is missing or not one this release knows is refused (FORBIDDEN) as unreadable; the Auditor is allowed here, and only here.
 */
export async function liveReadRole(deps: { documentClient: DocumentClient; tableName: string; signInTableName?: string | undefined }, orgId: OrgId, developerId: string): Promise<OrgRole | undefined> {
  let found: OrgRole | undefined;
  for (const id of await personIds(deps, developerId)) {
    const stored = await liveStoredRole(deps, orgId, id);
    if (!stored.present) continue;
    const role = OrgRoleSchema.safeParse(stored.role);
    if (!role.success) throw agentXError("FORBIDDEN", "your company role could not be read");
    found = role.data;
  }
  return found;
}
