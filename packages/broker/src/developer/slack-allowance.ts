// Enterprise foundations I-6: in an edition with company group sign-in, the Slack ingress acts only for a person whose company sign-in still allows them.
//
// A Slack workspace user is not the person the identity provider groups name. So each allowed company sign-in leaves a short record here: this Slack user belongs to a
// person the mapping let in, until the end of that sign-in's session (the edition's cap). A refused sign-in removes it. The Slack ingress asks for it before it acts, so a
// person removed from the groups is refused in Slack within the cap at the latest, and at their next company sign-in attempt at the soonest.
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, orgPk, type OrgId } from "@agentx/contracts";

export const SLACK_NOT_ALLOWED_MESSAGE = "Sign in to Rovara with your company account first. This Slack account is not signed in to Rovara, or your access has ended.";

type DocumentClient = { send(command: unknown): Promise<unknown> };
const keyOf = (orgId: OrgId, slackUserId: string) => ({ pk: orgPk(orgId), sk: `SSO_SLACK#${slackUserId}` });

export interface SlackAllowanceStore {
  /** Records that this Slack user is the person `developerId`, whom the mapping let in, until `allowedUntil` (epoch seconds). */
  record(orgId: OrgId, slackUserId: string, developerId: string, allowedUntil: number): Promise<void>;
  /** Removes the record (the person's sign-in was refused). */
  revoke(orgId: OrgId, slackUserId: string): Promise<void>;
  /** The developer the Slack user is allowed as, or undefined when there is no current record. */
  allowedDeveloper(orgId: OrgId, slackUserId: string, nowMs: number): Promise<string | undefined>;
}

export function dynamoSlackAllowanceStore(input: { documentClient: DocumentClient; tableName: string }): SlackAllowanceStore {
  const { documentClient, tableName } = input;
  return {
    async record(orgId, slackUserId, developerId, allowedUntil) {
      await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...keyOf(orgId, slackUserId), entityType: "SSO_SLACK", developerId, allowedUntil, expiresAt: allowedUntil + 86_400 } }));
    },
    async revoke(orgId, slackUserId) {
      await documentClient.send(new DeleteCommand({ TableName: tableName, Key: keyOf(orgId, slackUserId) }));
    },
    async allowedDeveloper(orgId, slackUserId, nowMs) {
      const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: keyOf(orgId, slackUserId), ConsistentRead: true })) as { Item?: { developerId?: unknown; allowedUntil?: unknown } };
      const item = result.Item;
      if (item === undefined || typeof item.developerId !== "string" || typeof item.allowedUntil !== "number") return undefined;
      return item.allowedUntil * 1000 > nowMs ? item.developerId : undefined;
    },
  };
}

/** Refuses (FORBIDDEN, a fixed sentence) a Slack user the company sign-in does not currently allow. `isMember` says whether the person still has their membership. */
export async function requireSlackPersonAllowed(input: { store: SlackAllowanceStore | undefined; orgId: OrgId; slackUserId: string; nowMs: number; isMember: (developerId: string) => Promise<boolean> }): Promise<void> {
  const developerId = input.store === undefined ? undefined : await input.store.allowedDeveloper(input.orgId, input.slackUserId, input.nowMs);
  if (developerId === undefined || !await input.isMember(developerId)) throw agentXError("FORBIDDEN", SLACK_NOT_ALLOWED_MESSAGE);
}
