// Lessons sweep (lane D): who a Slack thread reply's author is, for the lessons' subject source (`lesson-subject-source.ts`, `slackAuthor`). A reply is saved with a Slack workspace and user id and nothing else, so on its own it
// names nobody. The author counts as a Rovara person only through a VERIFIED link, and every step below fails closed (undefined = unknown = an outsider, never a member):
//   1. the ids are well formed (a bot id, a Slackbot id or anything not shaped like a Slack user is no one);
//   2. the Slack workspace is the one bound to the task's company (the binding the Slack ingress itself uses, read here without writing one): the same user id in another workspace is no one;
//   3. the Slack account has an ACTIVE identity link in the sign-in table (the link "Sign in with Slack" made after the person proved the account at Slack): for this issuer and this Slack user, not unlinked since, and
//      pointing at a developer. A Slack id nobody ever signed in with has no link row, so it names nobody; the id is never turned into a person by its shape;
//   4. the linked developer is followed through merges to the person they are now, and that person's sign-in record must exist and not be revoked.
// Whether that person is a MEMBER of the project is NOT decided here: the subject source reads their project role live (`standing`), exactly as for any other steerer.
// LP-2b (linked people, 0.5.18x, DECISIONS 183(d)): a task started from Slack while the Slack account is linked belongs to the linked web person from the start: the task record, ownership and the
// lessons subject all carry that person's id. Lessons from it stay attributed to that person after an unlink, and an erase of the person removes them (erase still checks both ids for older tasks).
// After an unlink, messages, replies and presses from that Slack account come from an outsider: they do not steer as the person, and a task they steer after the unlink is outsider-steered for
// lessons eligibility (a new reply is refused; a reply saved while linked is read through the link live, so it reads as an outsider's). Before any link, a Slack account names nobody (unchanged).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_OIDC_ISSUER, SlackUserIdSchema } from "@rovara-code/contracts";
import { slackTeamOrgKey } from "@agentx/cloud-contracts";
import { followMerges } from "../../agents/access.js";
import type { DeveloperSignInStore } from "../../developer/store.js";
import { ownerKeyForSubject } from "../lambda.js";

const SLACK_TEAM_ID = /^[TE][A-Z0-9]{2,31}$/u;

export interface LessonSlackAuthorDeps {
  /** The State table's client and name (the Slack workspace to company binding). */
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The sign-in table's store (identity links, developer records). */
  signIn: Pick<DeveloperSignInStore, "getIdentityLink" | "getDeveloper">;
}

/**
 * One subject build's memory of which company each Slack workspace is bound to, so the binding record is read once per workspace per build (a later build reads it again: a binding can change).
 * Make a new one per read of a task; never keep one across reads.
 */
export type SlackWorkspaceScope = Map<string, Promise<unknown>>;

/**
 * The developer the Slack account is verifiably linked to, in the task's company; undefined when anything cannot be proved. THROWS when a read fails (the caller treats that as unknown). With a `scope`,
 * the workspace's binding is read once for all the accounts asked with it.
 */
export function lessonSlackAuthor(deps: LessonSlackAuthorDeps): (input: { orgId: string; teamId: string; slackUserId: string }, scope?: SlackWorkspaceScope) => Promise<string | undefined> {
  return async ({ orgId, teamId, slackUserId }, scope) => {
    if (!SLACK_TEAM_ID.test(teamId) || !SlackUserIdSchema.safeParse(slackUserId).success) return undefined;
    const readBinding = async (): Promise<unknown> => (((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: slackTeamOrgKey(teamId), ConsistentRead: true }))) as { Item?: { orgId?: unknown } }).Item)?.orgId;
    let pending = scope?.get(teamId);
    if (pending === undefined) { pending = readBinding(); scope?.set(teamId, pending); }
    if ((await pending) !== orgId) return undefined;
    const identityKey = ownerKeyForSubject(SLACK_OIDC_ISSUER, slackUserId);
    const link = await deps.signIn.getIdentityLink(identityKey);
    if (link === undefined || link.provider !== "slack" || link.issuer !== SLACK_OIDC_ISSUER || link.subject !== slackUserId) return undefined;
    // An unlinked identity reads as no link, unless it was linked again to its own developer (the same rule as the sign-in store).
    if (link.unlinkedFrom !== undefined && link.developerId !== identityKey) return undefined;
    if (typeof link.developerId !== "string" || link.developerId.trim() === "") return undefined;
    const person = await followMerges(deps.signIn, link.developerId);
    const record = await deps.signIn.getDeveloper(person);
    // `followMerges` stops at a loop or the hop limit and hands back a record that was itself merged away: that is not "the person they are now", so it names nobody.
    return record === undefined || record.revoked || record.mergedInto !== undefined ? undefined : person;
  };
}
