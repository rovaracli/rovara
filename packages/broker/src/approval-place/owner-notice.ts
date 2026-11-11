// Approval place (U4, owner decision Q7): when someone other than the task's owner decides the plan, the owner is told. Three records, none of which can fail the decision: the decision itself names who decided and in what seat
// (`PROJECT_ADMIN`), the audit ledger records the place and the seat (`approval.place_decided`), and, when the owner has Slack linked, a direct message goes through the same pending-row mechanism the attention sweep uses
// (`TASK_ATTENTION_DM`, posted once by the notifier). The words are fixed: the decider's display name (flattened, no markup) and the task's title are the only other text.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, hideEmailAddresses } from "@rovara-code/contracts";
import { ATTENTION_DM_PK } from "../notifications/attention.js";
import { DeveloperSignInStore } from "../developer/store.js";

const DM_KEEP_SECONDS = 2 * 86_400;
const NAME_MAX = 60;
const TITLE_MAX = 100;
const flat = (text: string, max: number): string => {
  const one = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...hideEmailAddresses(one)];
  return (chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
};

export interface OwnerNoticeDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  signInTableName?: string | undefined;
  now(): number;
  log?(entry: Record<string, unknown>): void;
}

/** The sentence the owner reads. Pure, so a test can read it. */
export function ownerDecisionText(input: { deciderName: string; answer: "approve" | "request_changes" | "reject"; title: string; link: string | undefined }): string {
  const did = input.answer === "approve" ? "approved" : input.answer === "reject" ? "rejected" : "asked for changes to";
  const link = input.link === undefined ? "" : ` <${input.link}|Open it in Rovara>`;
  return `${flat(input.deciderName, NAME_MAX)} ${did} the plan for your task "${flat(input.title, TITLE_MAX)}".${link}`;
}

/**
 * Tells the owner, best effort: returns whether a message was queued. Never throws. No Slack link, no message (the decision record and the audit still say it). One message per decision (`requestId`), so a replay tells nobody twice.
 */
export async function noticeOwnerOfDecision(deps: OwnerNoticeDependencies, input: { orgId: string; ownerDeveloperId: string; requestId: string; deciderName: string; answer: "approve" | "request_changes" | "reject"; title: string; link: string | undefined }): Promise<boolean> {
  try {
    if (deps.signInTableName === undefined) return false;
    const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.signInTableName, nameTableName: deps.tableName, now: () => deps.now() });
    const slackUserId = (await store.slackUserIdsOf(input.ownerDeveloperId))[0];
    if (slackUserId === undefined) return false;
    const nowMs = deps.now();
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk: ATTENTION_DM_PK, sk: `${input.orgId}#${input.ownerDeveloperId}#decided#${input.requestId}`, entityType: "TASK_ATTENTION_DM", status: "PENDING", orgId: input.orgId, slackUserId,
        text: ownerDecisionText(input), at: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + DM_KEEP_SECONDS,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return true;
  } catch (error) {
    try { (deps.log ?? ((entry) => console.log(JSON.stringify({ component: "broker", ...entry }))))({ event: "approval_place.owner_notice_failed", error: error instanceof Error ? error.name : "unknown" }); } catch { /* nothing more can be done */ }
    return false;
  }
}
