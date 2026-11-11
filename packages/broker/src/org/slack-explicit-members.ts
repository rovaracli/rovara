// Slack explicit membership (0.5.14, switch `sm`, owner decision Q5). Leaf module: the switch, and the one-time warning of the "warn" value.
//
// On a cloud install (one with an org resolver) a Slack person who has no explicit, current company membership used to be the IMPLICIT member of the company their Slack workspace is bound to:
// `slackRequesterStanding` ended with `role: "member"` for anyone it found no member record for (and the Slack service routes let a person with no company at all through the same way). The
// switch decides what that last step does:
//   "1" (the default, and an absent or unknown value: fail closed)  refuse, SLACK_ACCOUNT_NOT_LINKED, with the plain words in SLACK_NOT_A_MEMBER_NOTICE.
//   "warn"  today's access, plus one direct message per person (once) saying a membership will soon be needed.
//   "0"     today's behaviour exactly (the rollback).
// A removed or banned person is refused before this step in every mode, and a person merged into a member resolves to the survivor's record before it: this step only ever sees a person with no record.
// An install with no org resolver (a single-org install) has no company membership to ask for and is unchanged in every mode.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { BROKER_SETTINGS, INDEX_EXPIRY_ATTRIBUTE, orgScoped, type OrgId } from "@agentx/contracts";

export type SlackMemberRule = "require" | "warn" | "off";

/** The switch as the broker reads it: exactly "0" is off, exactly "warn" is warn, anything else (absent, "1", a value nobody set) requires the membership. */
export function slackMemberRule(env: NodeJS.ProcessEnv = process.env): SlackMemberRule {
  const value = env[BROKER_SETTINGS.slackExplicitMembers.variable];
  if (value === "0") return "off";
  if (value === "warn") return "warn";
  return "require";
}

/** The direct message a person in the "warn" window gets, once. Fixed words: nothing of the person's or the company's is in it. */
export const SLACK_MEMBER_WARNING_TEXT = "Heads up from Rovara: I answered you in Slack, but your Slack account is not yet a member of your company in Rovara. Soon I will only answer people who are. To keep using me, ask a Rovara admin to add you, or link your Slack account yourself: sign in to Rovara, open your account menu and choose Link your Slack account.";

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const MARKER_KEEP_SECONDS = 90 * 86_400;
const DM_KEEP_SECONDS = 2 * 86_400;

type DocumentClient = { send(command: unknown): Promise<unknown> };

/** Who was already warned: one row per person per company, kept 90 days (the warn window is short; a person is not warned twice inside it). */
export function slackMemberWarningKey(orgId: OrgId, slackUserId: string): { pk: string; sk: string } {
  return { pk: orgScoped(orgId, "SLACK_MEMBER_WARNING"), sk: slackUserId };
}

/**
 * The "warn" value's notice: the first time a person with no membership is served, writes their marker and a Slack direct message for the notifier (the same TASK_ATTENTION_DM row the
 * task notifications use, so no new stream rule is needed) in ONE transaction, so the message is queued exactly once however many requests race. Never throws and never delays or changes
 * the request: a warning that could not be written is only logged, and the person is warned on a later request.
 */
export async function warnImplicitSlackMember(deps: { documentClient: DocumentClient; tableName: string; now?: () => number }, orgId: OrgId, slackUserId: string): Promise<void> {
  if (!SLACK_USER_ID.test(slackUserId)) return;
  try {
    const marker = slackMemberWarningKey(orgId, slackUserId);
    // A cheap read first: after the first warning every later request ends here, with no write.
    const seen = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: marker, ConsistentRead: true })) as { Item?: unknown };
    if (seen.Item !== undefined) return;
    const nowMs = (deps.now ?? Date.now)();
    const at = new Date(nowMs).toISOString();
    const seconds = Math.floor(nowMs / 1000);
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: { ...marker, entityType: "SLACK_MEMBER_WARNING", orgId, at, [INDEX_EXPIRY_ATTRIBUTE]: seconds + MARKER_KEEP_SECONDS }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: {
        pk: "NOTIFY_DM", sk: `${orgId}#slack-member-warning#${slackUserId}`, entityType: "TASK_ATTENTION_DM", status: "PENDING", orgId, slackUserId, text: SLACK_MEMBER_WARNING_TEXT, at,
        [INDEX_EXPIRY_ATTRIBUTE]: seconds + DM_KEEP_SECONDS,
      }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    // A lost race (the marker is there now) is the normal end; anything else is logged by name only.
    const name = error instanceof Error ? error.name : "unknown";
    if (name !== "TransactionCanceledException") console.log(JSON.stringify({ event: "slack_member_warning.failed", errorName: name }));
  }
}
