// Owner decision 2026-11-02: reviews now default to a model from a different company, for every company at once. A company sees one notice on How we work, and a company owner or admin can dismiss it for the whole
// company. The dismissal is one record (`ORG#<org>` / settings `REVIEW_DEFAULT_NOTICE`), written in the same transaction as its audit event, so a dismissal the ledger cannot take does not happen. Any member reads.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ReviewDefaultNoticeAnswerSchema, agentXError, type OrgId, type ReviewDefaultNoticeAnswer } from "@rovara-code/contracts";
import { orgSettingsKey, type AuditEventInput } from "@agentx/cloud-contracts";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditOccurrence, auditReviewDefaultNoticeDismissed } from "../audit/events.js";
import { auditedWrite } from "../playbook/project-settings-audit.js";
import type { AuditRuntime } from "../audit/outbox.js";

export const REVIEW_DEFAULT_NOTICE_PATH = "/v1/app/org/review-default-notice";
export interface ReviewDefaultNoticeDeps { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now(): number; audit?: AuditRuntime | undefined }
export interface ReviewDefaultNoticeCaller { orgId: OrgId; developerId: string; orgRole: string }

/** Only a company owner or admin dismisses it for everybody; the live role of this request decides. */
export const canDismissReviewDefaultNotice = (orgRole: string): boolean => orgRole === "owner" || orgRole === "admin";

async function dismissed(deps: ReviewDefaultNoticeDeps, orgId: OrgId): Promise<boolean> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgSettingsKey(orgId, "REVIEW_DEFAULT_NOTICE"), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return found.Item !== undefined;
}

export async function readReviewDefaultNotice(deps: ReviewDefaultNoticeDeps, caller: ReviewDefaultNoticeCaller): Promise<ReviewDefaultNoticeAnswer> {
  return ReviewDefaultNoticeAnswerSchema.parse({ dismissed: await dismissed(deps, caller.orgId), canDismiss: canDismissReviewDefaultNotice(caller.orgRole) });
}

/** Dismisses it for the company. Dismissing again changes nothing and audits nothing (the first dismissal is the event). */
export async function dismissReviewDefaultNotice(deps: ReviewDefaultNoticeDeps, caller: ReviewDefaultNoticeCaller): Promise<ReviewDefaultNoticeAnswer> {
  if (!canDismissReviewDefaultNotice(caller.orgRole)) throw agentXError("FORBIDDEN", "Only a company owner or admin can dismiss this notice.");
  if (deps.audit === undefined) throw agentXError("AUDIT_UNAVAILABLE", "Dismissing this notice requires the audit ledger.");
  if (await dismissed(deps, caller.orgId)) return readReviewDefaultNotice(deps, caller);
  const at = new Date(deps.now()).toISOString();
  const audited = await auditedWrite({ audit: deps.audit }, (): AuditEventInput[] => [auditReviewDefaultNoticeDismissed({ orgId: caller.orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: auditOccurrence(caller.orgId, "review-default-notice") })]);
  if (audited.items.length !== 1 || audited.events.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Dismissing this notice requires the audit ledger.");
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: { ...orgSettingsKey(caller.orgId, "REVIEW_DEFAULT_NOTICE"), entityType: "REVIEW_DEFAULT_NOTICE", orgId: caller.orgId, dismissedBy: caller.developerId, dismissedAt: at }, ConditionExpression: "attribute_not_exists(pk)" } },
      ...audited.items,
    ] }));
  } catch (error) {
    // Somebody dismissed it a moment ago: their dismissal and audit event stand, this one is the same answer.
    if (error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException") && await dismissed(deps, caller.orgId)) return readReviewDefaultNotice(deps, caller);
    throw error;
  }
  await flushAuditEvents({ audit: deps.audit }, [...audited.events]);
  return readReviewDefaultNotice(deps, caller);
}
