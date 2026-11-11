// Rovara Code (Plan 6 Task 14): which member of an org a GitHub account is, and the other way round. An approval on GitHub counts only when Rovara can tell whose it is
// (a requester's own approval does not count when self-approval is off), so the link is a positive identification: one GitHub account to one member of the org, and
// one member to one account. Both directions are written in one transaction. The items live in the org's own partitions.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { githubMemberKey, memberGithubKey, orgScoped, type OrgId } from "@rovara-code/contracts";

export interface GithubMemberDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

const GITHUB_USER_ID = /^[1-9][0-9]{0,19}$/;
const isConditional = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

async function get(deps: GithubMemberDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}

/** The member the GitHub account is linked to in this org, or undefined. A link item that does not name the org it is in is not one. */
export async function memberForGithubUser(deps: GithubMemberDependencies, orgId: OrgId, githubUserId: string): Promise<string | undefined> {
  if (!GITHUB_USER_ID.test(githubUserId)) return undefined;
  const item = await get(deps, githubMemberKey(orgId, githubUserId));
  return item !== undefined && item["orgId"] === orgId && item["githubUserId"] === githubUserId && typeof item["developerId"] === "string" ? item["developerId"] : undefined;
}

/** The GitHub account the member linked in this org, or undefined. */
export async function githubUserOfMember(deps: GithubMemberDependencies, orgId: OrgId, developerId: string): Promise<string | undefined> {
  const item = await get(deps, memberGithubKey(orgId, developerId));
  return item !== undefined && item["orgId"] === orgId && item["developerId"] === developerId && typeof item["githubUserId"] === "string" ? item["githubUserId"] : undefined;
}

/**
 * Links the account and the member, both ways, in one transaction. An account already linked to another member, or a member already linked to another account, is not
 * moved ("taken"): the first link stands until it is removed. A repeat of the same link changes nothing.
 */
export async function linkGithubMember(deps: GithubMemberDependencies, orgId: OrgId, developerId: string, githubUserId: string): Promise<"linked" | "taken"> {
  if (!GITHUB_USER_ID.test(githubUserId)) throw new Error("a GitHub user id is a positive whole number");
  const at = new Date(deps.now()).toISOString();
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: deps.tableName, Item: { ...githubMemberKey(orgId, githubUserId), entityType: "GITHUB_MEMBER", orgId, githubUserId, developerId, linkedAt: at },
        ConditionExpression: "attribute_not_exists(pk) OR developerId = :developer", ExpressionAttributeValues: { ":developer": developerId },
      } },
      { Put: {
        TableName: deps.tableName, Item: { ...memberGithubKey(orgId, developerId), entityType: "MEMBER_GITHUB", orgId, githubUserId, developerId, linkedAt: at },
        ConditionExpression: "attribute_not_exists(pk) OR githubUserId = :github", ExpressionAttributeValues: { ":github": githubUserId },
      } },
    ] }));
    return "linked";
  } catch (error) {
    if (isConditional(error)) return "taken";
    throw error;
  }
}

/** Removes the member's link, both ways, when it is still the one read (a link made since is not removed). Returns whether anything was removed. */
export async function unlinkGithubMember(deps: GithubMemberDependencies, orgId: OrgId, developerId: string): Promise<boolean> {
  const githubUserId = await githubUserOfMember(deps, orgId, developerId);
  if (githubUserId === undefined) return false;
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Delete: { TableName: deps.tableName, Key: memberGithubKey(orgId, developerId), ConditionExpression: "githubUserId = :github", ExpressionAttributeValues: { ":github": githubUserId } } },
      { Delete: { TableName: deps.tableName, Key: githubMemberKey(orgId, githubUserId), ConditionExpression: "attribute_not_exists(pk) OR developerId = :developer", ExpressionAttributeValues: { ":developer": developerId } } },
    ] }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/**
 * The first tracking pass of an org links the members who signed in with GitHub before the links were kept (the sign-in store knows them; this table did not). `members` are
 * the org's members with the GitHub account each has, from the sign-in store; once an org's backfill ran it is marked done and not run again. Returns how many were linked.
 */
export async function backfillGithubMembers(
  deps: GithubMemberDependencies,
  orgId: OrgId,
  members: () => Promise<ReadonlyArray<{ developerId: string; githubUserId: string }>>,
): Promise<number> {
  const marker = { pk: orgScoped(orgId, "GITHUB_MEMBER_BACKFILL"), sk: "META" };
  if ((await get(deps, marker)) !== undefined) return 0;
  let linked = 0;
  for (const member of await members()) if (GITHUB_USER_ID.test(member.githubUserId) && await linkGithubMember(deps, orgId, member.developerId, member.githubUserId) === "linked") linked += 1;
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: {
    TableName: deps.tableName, Item: { ...marker, entityType: "GITHUB_MEMBER_BACKFILL", orgId, doneAt: new Date(deps.now()).toISOString(), linked }, ConditionExpression: "attribute_not_exists(pk)",
  } }] })).catch((error: unknown) => { if (!isConditional(error)) throw error; });
  return linked;
}

