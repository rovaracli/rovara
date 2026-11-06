// Decision journey slice 3b: outside approvers decide on the card. An agent approval (`apr_`) or a spend request (`spr_`, a run_limit raise that needs someone else among them) is a decision card
// (`approve_request`) for exactly the people the confirmation page (`decide-web.ts`) lets decide it today: each card is listed only when the kind's own live evaluation (`DecideKind.inspect`, which runs
// `mayDecideApproval` / `mayDecideSpendRequest`) says "open" for this person, and every press inspects again before it decides.
//   where    the person's Home "Needs you"; the task page shows it to the people on the task who may decide it; anyone else who may decide it opens the card-only page `/app/decisions/approve_request/<id>`
//            (the card and its evidence: the confirmation page's own facts, nothing else of the task).
//   checks   the same as the confirmation page's: a signed-in browser (the web boundary's cookie and CSRF), a sign-in within the last 10 minutes (REAUTH_REQUIRED otherwise, said on the card), a writer's
//            live role (an Auditor decides nothing), and the kind's live eligibility; the decision goes through the kind's own `decide`, so the audit carries the fresh sign-in as its proof.
//   NOT changed: who may decide anything. decide-web stays one release as a redirect to the card (old links in Slack and email); its removal is for later.
import { createHash } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, openSpendRequestsKey } from "@agentx/contracts";
import type { DecideKind, DecideKinds, DecideTarget, ConfirmView } from "../../developer/decide-kinds.js";
import { kindPrefixOf } from "../../developer/decide-kinds.js";
import { listApprovalsFor, type AnyApprovalRecord, type ApprovalDependencies } from "../../agents/approvals.js";
import type { DecisionItem } from "../../decisions/project.js";
import { perform, type KindHandler } from "../../decisions/performer.js";
import type { PerformInput, PerformOutcome } from "../../decisions/routes.js";
import { freshSignInProofOf } from "../../design-review/route-facts.js";
import { liveWriterRole } from "../../org/live-role.js";
import { getSpendRequest } from "../../spend/requests.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

const APPROVALS_MAX = 100;
const SPEND_MAX = 100;
const PROBE_AT = "2000-01-01T00:00:00.000Z";
const LINE_MAX = 300;

/** The card-only page of an outside approval: the card and its evidence, nothing else of the task. */
export const outsideCardPath = (approvalId: string): string => `/app/decisions/approve_request/${approvalId}`;
/** What a press says when the person has not signed in recently. */
export const OUTSIDE_REAUTH_MESSAGE = "Sign in again to decide this. Decisions like this need a sign-in within the last 10 minutes.";

const cut = (value: string): string => (value.length > LINE_MAX ? `${value.slice(0, LINE_MAX - 1)}…` : value);
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** The evidence of the card, from the confirmation page's own view: its facts, its paragraphs and, for a write, the exact call. */
function detailsOf(view: ConfirmView): Array<{ title: string; lines: string[] }> {
  const groups: Array<{ title: string; lines: string[] }> = [{ title: "What is being decided", lines: view.facts.map((fact) => cut(`${fact.label}: ${fact.value}`)) }];
  if ((view.paragraphs ?? []).length > 0) groups.push({ title: "What it says", lines: (view.paragraphs ?? []).map(cut) });
  if (view.call !== undefined) groups.push({ title: "The call it makes", lines: [cut(`${view.call.connector} ${view.call.tool}${view.call.scope === undefined ? "" : ` (${view.call.scope})`}`), cut(JSON.stringify(view.call.arguments))] });
  return groups.filter((group) => group.lines.length > 0);
}

/** The card item of an open approval: the page's own view, the task it belongs to (when it has one) and a version of what is shown. */
function itemOf(approvalId: string, view: ConfirmView, meta: { createdAt: string; expiresAt?: string | undefined; taskId?: string | undefined; project?: string | undefined }): DecisionItem {
  return {
    kind: "approve_request", subjectId: approvalId, prefix: kindPrefixOf(approvalId) ?? "apr", project: meta.project ?? "Company", title: view.title, createdAt: meta.createdAt,
    ...(meta.expiresAt === undefined ? {} : { expiresAt: meta.expiresAt }), ...(meta.taskId === undefined ? {} : { taskId: meta.taskId }),
    openPath: outsideCardPath(approvalId), contentVersion: createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 40), details: detailsOf(view),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const taskOfApproval = (record: AnyApprovalRecord): string | undefined => (record.kind !== "change" && record.subject.kind === "agent_run" && UUID.test(record.subject.taskId) ? record.subject.taskId : undefined);

/** The outside approvals this person may decide now, as cards. Each candidate is inspected by its kind (live); a candidate that cannot be read is left out. */
export async function outsideItemsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller, kinds: DecideKinds): Promise<DecisionItem[]> {
  const agents = deps.agents as ApprovalDependencies | undefined;
  if (agents === undefined) return [];
  const found: DecisionItem[] = [];
  const target = (approvalId: string): DecideTarget => ({ orgId: caller.orgId, developerId: caller.developerId, approvalId });
  const now = deps.now();
  if (kinds.apr !== undefined) {
    const open = (await listApprovalsFor(agents, { orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole }, "PENDING").catch(() => [] as AnyApprovalRecord[]))
      .filter((record) => Date.parse(record.expiresAt) > now).slice(0, APPROVALS_MAX);
    for (const record of open) {
      try {
        const inspection = await kinds.apr.inspect(target(record.approvalId));
        if (inspection.status !== "open") continue;
        found.push(itemOf(record.approvalId, inspection.view, { createdAt: record.createdAt, expiresAt: record.expiresAt, taskId: taskOfApproval(record), project: textOf((record as unknown as Record<string, unknown>)["project"]) }));
      } catch { /* an approval that cannot be read is not a card */ }
    }
  }
  if (kinds.spr !== undefined) {
    const rows = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": openSpendRequestsKey(caller.orgId, PROBE_AT, "spr_0").pk }, ConsistentRead: true, Limit: SPEND_MAX,
    })).catch(() => ({ Items: [] })) as { Items?: Array<Record<string, unknown>> };
    for (const row of (rows.Items ?? []).slice(0, SPEND_MAX)) {
      const id = textOf(row["spendRequestId"]);
      if (id === undefined || row["orgId"] !== caller.orgId || kindPrefixOf(id) !== "spr") continue;
      try {
        const inspection = await kinds.spr.inspect(target(id));
        if (inspection.status !== "open") continue;
        // The request's own record says which task it belongs to (the open index row does not), so the task page shows the card to the deciders on the task.
        const record = await getSpendRequest(agents, caller.orgId, id) as unknown as Record<string, unknown> | undefined;
        const taskId = textOf(record?.["taskId"]);
        found.push(itemOf(id, inspection.view, { createdAt: textOf(record?.["createdAt"]) ?? textOf(row["createdAt"]) ?? new Date(now).toISOString(), expiresAt: textOf(record?.["expiresAt"]), taskId: taskId !== undefined && UUID.test(taskId) ? taskId : undefined, project: textOf(record?.["project"]) }));
      } catch { /* a request that cannot be read is not a card */ }
    }
  }
  return found;
}

/**
 * Approve and Decline of an outside approval's card: the confirmation page's checks, then the kind's own decision. Only from a signed-in browser, only after a recent sign-in, only by a writer the kind's live
 * evaluation still lets decide it. A refusal the kind gives is the kind's own words.
 */
export function outsideCardHandler(deps: DeveloperRouteDependencies, kinds: DecideKinds): KindHandler<DeveloperCaller> {
  const decide = (decision: "approve" | "decline") => (who: DeveloperCaller, input: PerformInput): Promise<PerformOutcome> => perform(async () => {
    const approvalId = input.item.subjectId;
    const prefix = kindPrefixOf(approvalId);
    const kind: DecideKind | undefined = prefix === undefined ? undefined : kinds[prefix];
    if (kind === undefined || input.item.kind !== "approve_request") return { kind: "refused", reason: "unsupported" };
    // The confirmation page's own guards: a browser, then a sign-in within the last 10 minutes (its proof goes on the decision's audit), then a writer's live role.
    if (who.browserSession !== true) throw agentXError("FORBIDDEN", "Decide this in the Rovara app.");
    const proof = await freshSignInProofOf({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: () => deps.now() }, who);
    if (proof === undefined) throw agentXError("REAUTH_REQUIRED", OUTSIDE_REAUTH_MESSAGE);
    await liveWriterRole({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName }, who.orgId, who.developerId);
    // Eligibility again, now (R68), never trusted from the list.
    const target: DecideTarget = { orgId: who.orgId, developerId: who.developerId, approvalId };
    const inspection = await kind.inspect(target);
    if (inspection.status === "forbidden") return { kind: "refused", reason: "forbidden" };
    if (inspection.status !== "open") return { kind: "refused", reason: "stale" };
    // The card the person is pressing on is the page they read: what a kind that needs it to have been opened records.
    await kind.opened?.(target);
    await kind.decide(target, decision, proof);
    return { kind: "done" };
  });
  return { approve: decide("approve"), reject: decide("decline") };
}
