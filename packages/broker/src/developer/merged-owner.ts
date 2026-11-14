// packages/broker/src/developer/merged-owner.ts
// 0.5.18 (Slack merged identity): a person whose Slack-only sign-in was merged into their web sign-in is the survivor from then on. A merged-away id must never be written as
// a task owner again, and a task that still names one (made before this fix, or before the merge drain ran) is seated as the survivor, never left "stale" for good.
//
// `mergeSurvivor` follows the sign-in record's `mergedInto` only: the field the merge writes, and the one the dispatcher can read too. A chain longer than MERGE_HOPS_MAX, or one that loops, is
// unreadable (undefined), never a guess.
//
// 0.5.18x (owner decision 183(d)): a Slack account LINKED to a web account behaves as if MERGED. `linkedPersonOf` (the Slack seat, the owner seat, the design card's requester, the Slack hand-on,
// the backfill) follows the first hop through `mergedInto`, else through the Slack identity's ACTIVE link (the "Sign in with Slack" link: the forward row keyed by the Slack identity, provider Slack,
// not unlinked, written only by the sign-in function), then merges to the survivor, bounded by MERGE_HOPS_MAX. It also gives the fence that first hop must still meet in a write
// (`seat-fence.ts`), so an unlink that commits first wins. The link is read every time and never stored.
//
// Following a merge never crosses a company: every caller checks that the survivor is a member of the task's (or the Slack team's) company before it seats them.

import type { TransactItems } from "../aws/developer-task-actions.js";

/** The longest merge chain followed (the same bound as `org/project-members.ts` and `agents/access.ts`). */
export const MERGE_HOPS_MAX = 5;

/** What the walk reads of a sign-in record. */
export type MergeRecordReader = (developerId: string) => Promise<{ mergedInto?: unknown } | undefined>;

/**
 * The end of `developerId`'s merge chain: the id itself when it was never merged, the survivor when it was. Undefined when the chain loops or is longer than MERGE_HOPS_MAX
 * (fail closed: the caller refuses, it never seats a guess).
 */
export async function mergeSurvivor(read: MergeRecordReader, developerId: string): Promise<string | undefined> {
  const seen = new Set<string>([developerId]);
  let current = developerId;
  for (let hop = 0; hop <= MERGE_HOPS_MAX; hop += 1) {
    const next = (await read(current))?.mergedInto;
    if (typeof next !== "string" || next === "") return current;
    if (seen.has(next) || hop === MERGE_HOPS_MAX) return undefined;
    seen.add(next);
    current = next;
  }
  return undefined;
}

/** What a person reads when a task's owner can no longer be seated: they are not a member of the company any more (removed, revoked, or merged into someone outside it). Never "stale". */
/** What a person reads when the task's owner is still a member but their company role cannot act on tasks (the Auditor), or cannot be read. */
export const TASK_OWNER_CANNOT_ACT_MESSAGE = "The task's owner can't act on tasks in this company with their current role, so Rovara can't act for them on this task. Ask a company admin to change their role or hand the task to someone else.";

export const TASK_OWNER_NOT_MEMBER_MESSAGE = "The task's owner is no longer a member of this company, so Rovara can't act for them on this task. Ask a company admin to hand the task to someone else, or start it again.";

/** One consistent read of the sign-in table by key (`DEVELOPER#<id>` / `SIGNIN_IDENTITY#<id>`, sort key META or `IDENTITY#<key>`). */
export type SignInRead = (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>;

/** The person an id acts as now (see the header): the ids from the id to the survivor, a verified link's facts when the first hop was one, and the first hop's fence. */
export interface PersonPath {
  ids: string[];
  survivor: string;
  /** Set when the first hop was the Slack identity link (not a merge): the account it names and when it was made. */
  link?: { target: string; linkedAt: string | undefined };
  /** The conditions the first hop must still meet in a write that acts as the survivor (empty when there is no hop). */
  fence: TransactItems;
}
/** Why no person could be followed to: a loop or a chain past MERGE_HOPS_MAX, or a link row of the identity that is not a Slack link. */
export type PersonPathRefusal = "merge_chain_unreadable" | "link_unverified";

/** `developerId`'s person now, following merges and the active Slack link (see the header). Fails closed: a refusal, never a guess. */
export async function linkedPersonOf(read: SignInRead, developerId: string, signInTable: string): Promise<PersonPath | { refused: PersonPathRefusal }> {
  const [record, linkRow] = await Promise.all([read({ pk: `DEVELOPER#${developerId}`, sk: "META" }), read({ pk: `SIGNIN_IDENTITY#${developerId}`, sk: "META" })]);
  const merged = typeof record?.["mergedInto"] === "string" && record["mergedInto"] !== "" ? record["mergedInto"] : undefined;
  let first: string;
  let fence: TransactItems;
  let link: PersonPath["link"];
  if (merged !== undefined) {
    first = merged;
    fence = [{ ConditionCheck: { TableName: signInTable, Key: { pk: `DEVELOPER#${developerId}`, sk: "META" }, ConditionExpression: "#rvSeatMerged = :rvSeatMerged",
      ExpressionAttributeNames: { "#rvSeatMerged": "mergedInto" }, ExpressionAttributeValues: { ":rvSeatMerged": merged } } }];
  } else {
    const target = linkRow?.["developerId"];
    // No active link to another account (none, a tombstone, or a link to its own developer): the id is its own person.
    if (linkRow === undefined || linkRow["unlinkedFrom"] !== undefined || typeof target !== "string" || target === "" || target === developerId) {
      return { ids: [developerId], survivor: developerId, fence: [] };
    }
    // The row is keyed by the identity itself and only the sign-in function writes it (the broker has no write on the sign-in table): an active row of any provider but Slack is not a Slack link.
    if (linkRow["provider"] !== "slack") return { refused: "link_unverified" };
    first = target;
    link = { target, linkedAt: typeof linkRow["linkedAt"] === "string" ? linkRow["linkedAt"] : undefined };
    // The unlink marks the account it unlinked from (`identityUnlinked#<key>`) in its own transaction, and a re-link to that account clears it: a write holds only while the mark is absent.
    fence = [{ ConditionCheck: { TableName: signInTable, Key: { pk: `DEVELOPER#${target}`, sk: "META" }, ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#rvSeatUnlinked)",
      ExpressionAttributeNames: { "#rvSeatUnlinked": `identityUnlinked#${developerId}` } } }];
  }
  const ids = [developerId, first];
  for (;;) {
    if (ids.length - 1 > MERGE_HOPS_MAX) return { refused: "merge_chain_unreadable" };
    const next = (await read({ pk: `DEVELOPER#${ids.at(-1)!}`, sk: "META" }))?.["mergedInto"];
    if (typeof next !== "string" || next === "") break;
    if (ids.includes(next)) return { refused: "merge_chain_unreadable" };
    ids.push(next);
  }
  return { ids, survivor: ids.at(-1)!, ...(link === undefined ? {} : { link }), fence };
}

/** Whether a task made at `createdAt` may be handed on through `path`: a link only takes tasks made while it stood (a re-link to another account never takes the first account's tasks). */
export function handOnAllowedAt(path: PersonPath, createdAt: unknown): boolean {
  if (path.link === undefined) return true;
  const made = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  const linked = path.link.linkedAt === undefined ? Number.NaN : Date.parse(path.link.linkedAt);
  return Number.isFinite(made) && Number.isFinite(linked) && made >= linked;
}

/**
 * 0.5.18x (R31, review M-2): the person a Slack id acts as now (`linkedPersonOf`, read live): the web account its Slack account is merged into or linked to, else the Slack id itself. A path that
 * cannot be followed names nobody (undefined), never a guess. `signInTable` undefined (an install with no sign-in table): the Slack id.
 */
export async function slackPersonId(read: SignInRead, slackId: string, signInTable: string | undefined): Promise<string | undefined> {
  if (signInTable === undefined) return slackId;
  const path = await linkedPersonOf(read, slackId, signInTable);
  return "refused" in path ? undefined : path.survivor;
}
