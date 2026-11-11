// srv/needs-broker-ui-2 item 9: `GET /v1/app/org/approvals/pending-summary`, for an org owner or admin only (their role is read from the member record now, never from the token): how many approvals
// of the company wait, and the newest page of them. Read-only: it decides nothing and writes nothing, and it does not use the approver lists (`APPROVER#` items) or any decide path.
//
// Where the approvals come from: the open index (`OPEN_APPROVALS`, written for every approval while it is open; the expiry sweep reads it). It is one partition for every company on the install, in
// the order approvals expire, so a request reads at most `ORG_PENDING_SCAN_MAX` of its items and looks at a record only when the item names the CALLER'S company (the key and the item must both
// say so); another company's items are skipped without being read. A record that is not PENDING, has expired, or belongs to another org is not counted. If the index is longer than the scan, the
// answer says `truncated` and its `total` may be short.
//
// What each row says is what the approval's confirmation page says: its title (`confirmTitleOf`), the people it names by display name, the time it was asked and the page's bare link. Never a
// subject, arguments, a digest or a diff.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ORG_PENDING_APPROVALS_MAX, OrgPendingApprovalItemSchema, OrgPendingApprovalsSummarySchema, type OrgPendingApprovalItem, type OrgPendingApprovalsSummary } from "@agentx/cloud-contracts";
import { agentXError } from "@rovara-code/contracts";
import { orgRoleOf, type AgentCaller } from "./access.js";
import { confirmTitleOf } from "./approval-decide-kind.js";
import { withChosenOwners } from "./approval-routes.js";
import { confirmUrlFor, getAnyApproval, mayDecideApproval, shownPersonName, type AnyApprovalRecord, type ApprovalDependencies } from "./approvals.js";
import { DUE_SK } from "./approvals-store.js";

/** The most open-index items one request reads. */
export const ORG_PENDING_SCAN_MAX = 500;
const PAGE = 100;
const READS_AT_ONCE = 10;
const NAME_MAX = 80;
const SUBJECT_KIND_MAX = 60;
const TITLE_MAX = 200;

export const ORG_PENDING_FORBIDDEN = "Only an org owner or admin can see the company's pending approvals.";

async function proposerOf(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<string | undefined> {
  if (record.kind !== "change") return record.owner === undefined ? undefined : shownPersonName(record.owner, NAME_MAX) || undefined;
  if (record.requestedBy === undefined) return undefined;
  try {
    const person = await deps.signInStore.getDeveloper(record.requestedBy);
    return person === undefined ? undefined : shownPersonName({ developerId: record.requestedBy, name: person.displayName }, NAME_MAX) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One summary row from what the record says. A word longer than the contract allows is trimmed (the title) or left off (the change's kind), and a row that still is not valid is dropped (`undefined`):
 * one odd row never fails the whole summary.
 */
export function summaryRowOf(fields: { approvalId: string; kind: OrgPendingApprovalItem["kind"]; subjectKind?: string; title: string; proposedBy?: string; createdAt: string; confirmUrl: string }): OrgPendingApprovalItem | undefined {
  const { subjectKind, title, ...rest } = fields;
  const parsed = OrgPendingApprovalItemSchema.safeParse({
    ...rest, ...(subjectKind !== undefined && subjectKind.length <= SUBJECT_KIND_MAX ? { subjectKind } : {}),
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}\u2026` : title,
  });
  return parsed.success ? parsed.data : undefined;
}

export async function orgPendingApprovals(deps: ApprovalDependencies, caller: AgentCaller): Promise<OrgPendingApprovalsSummary> {
  // The live role, from the member record: a token that still says "admin" for someone demoted gets nothing.
  const role = await orgRoleOf(deps, caller.orgId, caller.developerId);
  if (role !== "owner" && role !== "admin") throw agentXError("FORBIDDEN", ORG_PENDING_FORBIDDEN);
  const { orgId } = caller;

  // The company's open items, in index order, each named once.
  const wanted: string[] = [];
  const known = new Set<string>();
  let start: Record<string, unknown> | undefined;
  let read = 0;
  let truncated = false;
  scan: for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "OPEN_APPROVALS" }, ConsistentRead: true, Limit: PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (read >= ORG_PENDING_SCAN_MAX) { truncated = true; break scan; }
      read += 1;
      const parts = DUE_SK.exec(String(item["sk"]));
      if (parts === null || parts[2] !== orgId || item["orgId"] !== orgId || item["approvalId"] !== parts[3] || known.has(parts[3]!)) continue;
      known.add(parts[3]!);
      wanted.push(parts[3]!);
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }

  // Their records: only PENDING ones that have not expired, are this company's, and the CALLER could decide now (`mayDecideApproval`, as the confirm page and the decide route ask): an approval whose
// rule refuses an admin (a card decision, a session share with the company, a take-over: each only its own person confirms) is neither listed nor counted. An approval that names its people (a run's step or
// write: its owner or a project maintainer) stays listed for an owner or admin, who oversee the company's waiting work; the page still asks the real question when they open it.
  const now = deps.now();
  const open: AnyApprovalRecord[] = [];
  for (let from = 0; from < wanted.length; from += READS_AT_ONCE) {
    const records = await Promise.all(wanted.slice(from, from + READS_AT_ONCE).map((id) => getAnyApproval(deps, orgId, id as never)));
    const live = records.filter((record): record is AnyApprovalRecord => record !== undefined && record.orgId === orgId && record.status === "PENDING" && Date.parse(record.expiresAt) > now);
    const mine = await Promise.all(live.map((record) => record.approvers.kind === "rule" ? mayDecideApproval(deps, caller, record).catch(() => false) : true));
    live.forEach((record, index) => { if (mine[index] === true) open.push(record); });
  }
  open.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || (left.approvalId < right.approvalId ? 1 : -1));

  const first = await withChosenOwners(deps, open.slice(0, ORG_PENDING_APPROVALS_MAX));
  const approvals: OrgPendingApprovalItem[] = [];
  for (const record of first) {
    const proposedBy = await proposerOf(deps, record);
    const item = summaryRowOf({
      approvalId: record.approvalId, kind: record.kind, ...(record.kind === "change" ? { subjectKind: record.subject.kind } : {}), title: confirmTitleOf(record),
      ...(proposedBy === undefined ? {} : { proposedBy }), createdAt: record.createdAt, confirmUrl: confirmUrlFor(deps, record),
    });
    if (item !== undefined) approvals.push(item);
  }
  return OrgPendingApprovalsSummarySchema.parse({ total: open.length, approvals, ...(truncated ? { truncated: true as const } : {}) });
}
