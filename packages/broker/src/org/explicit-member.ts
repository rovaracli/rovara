// Owner decision 86 (a task person is a Rovara MEMBER) and the Slack explicit-membership rule (switch `sm`, lane U2): one answer to "is this person an explicit, current member of the
// company, and may they write". Leaf module, so the task person checks (broker and dispatcher) and the Slack routes can share it.
//
// The rule: follow the person's id through the people they were merged into (a Slack identity linked to another sign-in is merged into it; the sign-in row's `mergedInto`), and read the
// member record of the SURVIVOR (the last id). A stale record under an earlier id gives nothing. No record: not a member (a Slack user who never joined the company, whatever channels they
// are in). A record whose role is not a writer's (the Auditor, a role this release does not know), under any id they answer to: refused, like `listProjectMembers` leaves them out. The same
// walk and the same refusals as `liveWriterRole` (org/live-role.ts), which also follows a pending identity link through a table the dispatcher cannot read; a link with no merge is, here,
// no membership (fail closed).
import { agentXError, type OrgId, type WriterOrgRole } from "@agentx/contracts";
import { MERGE_HOPS, survivorRole } from "./live-role.js";

export interface ExplicitMemberDependencies {
  /** The table holding the org's member rows (the State table). Read consistently, one key at a time. */
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** A person's sign-in row, for `mergedInto`; `undefined` when there is none. */
  developerRecord(developerId: string): Promise<{ mergedInto?: unknown } | undefined>;
}

/**
 * The person's role in the company now: a writer's role, or `undefined` when they have no member record (as the survivor of their merges). Throws FORBIDDEN when a record they answer to
 * holds a role that is not a writer's, or when their merges loop or run past MERGE_HOPS (an identity that cannot be traced to one person is not served).
 */
export async function explicitMemberRole(deps: ExplicitMemberDependencies, orgId: OrgId, developerId: string): Promise<WriterOrgRole | undefined> {
  const ids = [developerId];
  for (let hops = 0; ; hops += 1) {
    const merged = (await deps.developerRecord(ids[ids.length - 1]!))?.mergedInto;
    const next = typeof merged === "string" && merged !== "" ? merged : undefined;
    if (next === undefined) break;
    if (ids.includes(next) || hops >= MERGE_HOPS) throw agentXError("FORBIDDEN", "this person's identity could not be followed to one person; ask an admin");
    ids.push(next);
  }
  const role = await survivorRole(deps, orgId, ids, false);
  return role === undefined ? undefined : (role as WriterOrgRole);
}
