// packages/broker/src/developer/merged-owner.ts
// 0.5.18 (Slack merged identity): a person whose Slack-only sign-in was merged into their web sign-in is the survivor from then on. A merged-away id must never be written as
// a task owner again, and a task that still names one (made before this fix, or before the merge drain ran) is seated as the survivor, never left "stale" for good.
//
// The walk follows the sign-in record's `mergedInto` only (the field the merge writes, and the one the dispatcher can read too), never an identity link: a Slack account that was linked
// without a developer of its own to merge keeps today's id. A chain is at most MERGE_HOPS_MAX long; a loop or a longer chain is unreadable (undefined), never a guess.
//
// Following a merge never crosses a company: every caller checks that the survivor is a member of the task's (or the Slack team's) company before it seats them.

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
export const TASK_OWNER_NOT_MEMBER_MESSAGE = "The task's owner is no longer a member of this company, so Rovara can't act for them on this task. Ask a company admin to hand the task to someone else, or start it again.";
