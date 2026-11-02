// Setup and test health SH17 (M3, second Opus re-check): the second person's confirmation of a mark must have OPENED the page that lists the tests. "Opened" is recorded ONLY when the confirmation page is
// rendered for that person (`DecideKind.opened`, called by the page's GET), never by the eligibility checks that run before a decision (`inspect` is also called by the sign-in and session code and right before
// a decision, so recording there would make the rule vacuous). The rule is enforced as a decision guard, so every route that can decide the approval (the page, `POST /v1/app/approvals/{id}/decide`) meets it.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, approvalKey, type OrgId } from "@agentx/contracts";
import { registerApprovalDecisionGuard, type AnyApprovalRecord, type ApprovalDependencies } from "./approvals-store.js";

export const KNOWN_FAILING_OPEN_FIRST_MESSAGE = "Open this page and read the tests first, then confirm.";

const viewedKey = (orgId: OrgId, approvalId: string, developerId: string) => ({ pk: approvalKey(orgId, approvalId).pk, sk: `VIEWED#${developerId}` });
const needsReading = (record: AnyApprovalRecord): boolean => record.kind === "change" && record.subject.kind === "known_failing";

/** Records that this person was shown the page of this approval (a no-op for approvals whose confirmation does not need reading). */
export async function recordApprovalViewed(deps: ApprovalDependencies, record: AnyApprovalRecord, developerId: string): Promise<void> {
  if (!needsReading(record)) return;
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...viewedKey(record.orgId, record.approvalId, developerId), entityType: "APPROVAL_VIEWED", orgId: record.orgId, approvalId: record.approvalId, developerId, viewedAt: new Date(deps.now()).toISOString() } }));
}

async function wasViewed(deps: ApprovalDependencies, record: AnyApprovalRecord, developerId: string): Promise<boolean> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: viewedKey(record.orgId, record.approvalId, developerId), ConsistentRead: true })) as { Item?: unknown };
  return found.Item !== undefined;
}

registerApprovalDecisionGuard("known_failing_opened", async (deps, caller, record, decision) => {
  if (decision !== "APPROVE" || !needsReading(record)) return;
  if (!await wasViewed(deps, record, caller.developerId)) throw agentXError("CHANGE_STALE", KNOWN_FAILING_OPEN_FIRST_MESSAGE);
});
