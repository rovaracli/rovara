// Owner decision 86 (a task person is a Rovara MEMBER) and the Slack explicit-membership rule (switch `sm`, lane U2): ONE answer to "is this person an explicit, current member of the
// company, and may they write", used by the task person checks (broker and dispatcher) and by the Slack routes (`slackRequesterStanding`), so the two cannot disagree.
//
// The rule (org/live-role.ts, the same two steps as `liveWriterRole`): walk the person's id (`personWalk`: the people they were merged into, and the developer their identity is linked to now),
// and read the member record of the SURVIVOR (the last id; `survivorStanding`). A stale record under an earlier id gives nothing. No record: not a member (a Slack user who never joined the
// company, whatever channels they are in). A record whose role is not a writer's (the Auditor, a role this release does not know), under any id they answer to, is refused (FORBIDDEN, unless
// `readOnly`). Walks that loop or run past MERGE_HOPS are refused: an identity that cannot be traced to one person is not served.
//
// The only difference between callers is how the sign-in table is read. The broker reads it itself (links included). The dispatcher may read only a developer's own row, projected, so it
// gives a reader that answers `DEVELOPER#<id>` rows from that port and finds no link row: a person who is linked to a member with no merge is, there, not a member (fail closed).
import { type OrgRole, type WriterOrgRole } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { personWalk, survivorStanding } from "./live-role.js";

export type SignInReader = (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>;

export interface ExplicitMemberDependencies {
  /** The table holding the org's member rows (the State table). Read consistently, one key at a time. */
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** One consistent read of the sign-in table, for merges and links. */
  readSignIn: SignInReader;
}

/** A reader of the sign-in table for a caller that can read only a developer's own row: `DEVELOPER#<id>` / META is answered from `developerRecord`, any other row (an identity link) is not there. */
export function signInReaderFromRecords(developerRecord: (developerId: string) => Promise<object | undefined>): SignInReader {
  return async (key) => {
    const match = key.sk === "META" ? /^DEVELOPER#([a-f0-9]{64})$/.exec(key.pk) : null;
    return match === null ? undefined : await developerRecord(match[1]!) as Record<string, unknown> | undefined;
  };
}

/**
 * The person's standing in the company now (role and which membership), or `undefined` when they have no member record as the survivor of their ids. `ids` is the walk when the caller has
 * already made it (one walk per request); otherwise it is made here. Refuses (FORBIDDEN) as the module says.
 */
export async function explicitMemberStanding(
  deps: ExplicitMemberDependencies,
  orgId: OrgId,
  developerId: string,
  options: { readOnly?: boolean; ids?: readonly string[] } = {},
): Promise<{ role: OrgRole; joinedAt: unknown } | undefined> {
  const ids = options.ids ?? (await personWalk({ documentClient: deps.documentClient, readSignIn: deps.readSignIn }, developerId)).ids;
  return survivorStanding(deps, orgId, ids, options.readOnly === true);
}

/** `explicitMemberStanding` for a writer: the role (owner, admin or member), or `undefined` when the person is no member. Throws FORBIDDEN for an Auditor or an unknown role. */
export async function explicitMemberRole(deps: ExplicitMemberDependencies, orgId: OrgId, developerId: string): Promise<WriterOrgRole | undefined> {
  return (await explicitMemberStanding(deps, orgId, developerId))?.role as WriterOrgRole | undefined;
}
