// Enterprise foundations, I2: the company role a person holds NOW, read from the member record, for the surfaces that do not go through the route dispatcher (Slack, the
// approval page, GitHub reviews, task paths). The dispatcher holds an Auditor to a short allow-list; these surfaces ask here instead, and a person who is not a writer
// (the Auditor, or a role this release does not know) is refused. A person with no member record has no role: the caller decides what that means for its surface.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, isWriterOrgRole, orgMemberKey, type OrgRole, type WriterOrgRole } from "@agentx/cloud-contracts";
import { agentXError, type OrgId } from "@rovara-code/contracts";

type DocumentClient = { send(command: unknown): Promise<unknown> };

/** The person's role on record: `undefined` when there is no member record, else the stored value as it is (not parsed), so an unreadable role is not mistaken for none. */
export async function liveStoredRole(deps: { documentClient: DocumentClient; tableName: string }, orgId: OrgId, developerId: string): Promise<{ present: false } | { present: true; role: unknown; joinedAt: unknown }> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item === undefined ? { present: false } : { present: true, role: response.Item["role"], joinedAt: response.Item["joinedAt"] };
}

export const NOT_A_WRITER_MESSAGE = "Your company role can read the audit log and nothing else.";

/** How many merges a person's id is followed through (the same bound as the agent access rules). */
export const MERGE_HOPS = 8;

/**
 * The ids a person answers to: their own, then the person each was merged into (a Slack identity linked to another sign-in is merged into it), then the developer their identity is linked to
 * NOW and whoever that developer was merged into. The last matters after an unlink and a relink: the relink writes the link back without restoring the merge the unlink dropped, so the
 * link itself says who the identity belongs to. Later ids are the more current ones (the survivor wins). ONE walk: the link counts as a hop, and the hop limit and the loop check cover the
 * merges and the link together. Refuses (FORBIDDEN) when the walk loops or is longer than MERGE_HOPS: an identity that cannot be traced to its survivor is not served.
 */
export async function personIds(deps: { documentClient: DocumentClient; signInTableName?: string | undefined }, developerId: string): Promise<string[]> {
  return (await personWalk(deps, developerId)).ids;
}

/** `personIds`, and the identity link's `unlinkedFrom` (the developer a Slack identity was unlinked from) from the same read of the link, so a caller needs one walk, not two. */
export async function personWalk(deps: { documentClient: DocumentClient; signInTableName?: string | undefined }, developerId: string): Promise<{ ids: string[]; unlinkedFrom: string | undefined }> {
  if (deps.signInTableName === undefined) return { ids: [developerId], unlinkedFrom: undefined };
  const read = async (key: { pk: string; sk: string }) => (await deps.documentClient.send(new GetCommand({ TableName: deps.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  const link = await read({ pk: `SIGNIN_IDENTITY#${developerId}`, sk: "META" });
  const unlinkedFrom = typeof link?.["unlinkedFrom"] === "string" ? link["unlinkedFrom"] : undefined;
  let pendingLink = link !== undefined && link["unlinkedFrom"] === undefined && typeof link["developerId"] === "string" && link["developerId"] !== developerId ? link["developerId"] : undefined;
  const ids = [developerId];
  for (let hops = 0; ; hops += 1) {
    const merged = (await read({ pk: `DEVELOPER#${ids[ids.length - 1]!}`, sk: "META" }))?.["mergedInto"];
    let next = typeof merged === "string" && merged !== "" ? merged : undefined;
    if (next === undefined && pendingLink !== undefined) {
      next = ids.includes(pendingLink) ? undefined : pendingLink;
      pendingLink = undefined;
    }
    if (next === undefined) return { ids, unlinkedFrom };
    if (ids.includes(next) || hops >= MERGE_HOPS) throw agentXError("FORBIDDEN", "this person's identity could not be followed to one person; ask an admin");
    ids.push(next);
  }
}

/**
 * The company role of a person whose ids were already walked (`personWalk`), read from the SURVIVOR's record only (the last id): a stale record under an earlier id gives no role, so a
 * duplicate that was once an admin is not an admin because the survivor has no record. `undefined` when the survivor has none. Every record under any id must still be readable and, unless
 * `readOnly`, a writer's: a record that is not (the Auditor, an unknown role, no role field) is refused whichever id holds it.
 */
export async function survivorRole(deps: { documentClient: DocumentClient; tableName: string }, orgId: OrgId, ids: readonly string[], readOnly: boolean): Promise<OrgRole | undefined> {
  return (await survivorStanding(deps, orgId, ids, readOnly))?.role;
}

/** `survivorRole`, with the `joinedAt` of the same record read, so a caller that asserts the record later (SY-7) asserts exactly what this read saw: the role and which membership it was. */
export async function survivorStanding(deps: { documentClient: DocumentClient; tableName: string }, orgId: OrgId, ids: readonly string[], readOnly: boolean): Promise<{ role: OrgRole; joinedAt: unknown } | undefined> {
  let found: { role: OrgRole; joinedAt: unknown } | undefined;
  for (const [index, id] of ids.entries()) {
    const stored = await liveStoredRole(deps, orgId, id);
    if (!stored.present) continue;
    if (readOnly) {
      const role = OrgRoleSchema.safeParse(stored.role);
      if (!role.success) throw agentXError("FORBIDDEN", "your company role could not be read");
      if (index === ids.length - 1) found = { role: role.data, joinedAt: stored.joinedAt };
    } else {
      if (!isWriterOrgRole(stored.role)) throw agentXError("FORBIDDEN", NOT_A_WRITER_MESSAGE);
      if (index === ids.length - 1) found = { role: stored.role, joinedAt: stored.joinedAt };
    }
  }
  return found;
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
