// Product decisions (W11, A-23, DN-6; experience decisions 14 and 36; owner answer Q8): a decision a task raises about the PRODUCT (a wording, a UX option, a scope question), with a risk tier, settled by
// the people the ONE approval-place rule allows (`approvalPlaceDecision`, kind `product`): the task's owner and the project's maintainers at any risk; a collaborator only a LOW one while the project's
// `collaboratorApprovals` switch is on. Contributors who do not own the task and viewers settle nothing. Anyone who may answer questions (`answer_questions`) or owns the task may add an answer (a note).
//
// What this never touches: the coding plan, a design, a merge. A product decision is its own record and an approval of one is stored with `class: "product"`; the merge readiness, the code host's reviews and
// CODEOWNERS read none of it (tests/contract/product-decisions.test.ts proves it). Plan and design approvals keep their own paths unchanged.
//
// Data, in the project's partition (every key from the caller's checked org, so another company's decision is never reached and reads as not found):
//   PRODUCT_DECISION#<pdq_id>            the decision: task, question, options, risk, status, revision, answers, the approval
//   (on the decision, `requests`)        every write request it took (id, who, a fingerprint of the body, what it did): a replay is found here. No separate request item and no expiry (no TTL use).
// Every write is ONE transaction: the decision (conditioned on the revision that was read, carrying its request record) and the audit pending item.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, projectPk, type OrgId } from "@rovara-code/contracts";
import {
  DEFAULT_RECENT_SIGN_IN_SETTING, PRODUCT_DECISIONS_LIST_MAX, PRODUCT_DECISION_ANSWERS_MAX, ProductDecisionDecideBodySchema, ProductDecisionIdSchema, ProductDecisionRaiseSchema, ProductDecisionViewSchema,
  approvalPlaceDecision, productDecisionRisk, projectAllows, type ApprovalDeciderRole, type ApprovalPlaceVerdict, type ProductDecisionRaise, type ProductDecisionView, type ProjectRole,
} from "@agentx/cloud-contracts";
import { projectMemberKey } from "@rovara-code/contracts";
import { auditOccurrence, auditProductDecisionAnswered, auditProductDecisionApproved, auditProductDecisionRaised } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent, type AuditRuntime } from "../audit/outbox.js";
import { isTaskOwner, taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import { collaboratorSwitchFence } from "../collaborators/approvals-setting.js";
import { nameResolverOf, replacementNames, shownNameOf } from "../developer/name-resolver.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { resolveTaskPeopleAccess } from "../developer/task-people.js";

export const PRODUCT_DECISION_SK_PREFIX = "PRODUCT_DECISION#";
/** Every write request a decision has taken (an answer or the approval), kept ON the decision so a replay is found without a separate expiring item: at most the answers plus one approval. */
const REQUESTS_KEPT = PRODUCT_DECISION_ANSWERS_MAX + 1;

export const PRODUCT_DECISION_NOT_FOUND = "that product decision was not found";
export const PRODUCT_DECISION_STALE = "this decision changed since you loaded it; reload and try again";
export const PRODUCT_DECISION_SETTLED = "this decision has already been made";
export const PRODUCT_DECISION_REQUEST_REUSED = "that request id was already used for a different change; use a new one";
export const PRODUCT_DECISION_ANSWER_FORBIDDEN = "a project viewer can't answer this; ask a maintainer to make you a collaborator";
export const PRODUCT_DECISION_ANSWERS_FULL = "this decision has as many answers as it can hold";
export const PRODUCT_DECISION_ARCHIVED = "this project is archived; restore it to answer or decide its product decisions";
/** The refusals of an approve, by the policy's reason. Fixed words; nothing of the decision or the person is echoed. */
export const PRODUCT_DECISION_REFUSALS: Record<string, string> = {
  role_not_allowed: "a maintainer or the task's owner decides this one",
  collaborator_approvals_off: "this project has turned off collaborator approvals: a maintainer or the task's owner decides here",
  fresh_sign_in_required: "a high-risk product decision is approved on its task page with a fresh sign-in",
};

export interface ProductDecisionDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  audit?: AuditRuntime;
  /** A merged-away developer id reads as its survivor when deciding whether the caller owns the task (take-overs). Absent: ids are compared as they are. */
  resolveMember?: ((developerId: string) => Promise<string>) | undefined;
  /**
   * Decision 97: when someone other than the task's owner or a co-owner settles a decision (the policy's `notifyOwner`), the owner is told who did. Best effort, after the commit: it never undoes the decision.
   * The route wires `noticeOwnerOfDecision`. Absent: nobody is told (a harness).
   */
  notifyOwner?: ((input: { orgId: OrgId; ownerDeveloperId: string; requestId: string; deciderName: string; title: string }) => Promise<unknown>) | undefined;
}

/** Who is deciding: their checked org, their id and name, and their LIVE exact role on the project (the route reads it on every request). */
export interface ProductDecisionCaller { orgId: OrgId; developerId: string; name: string; role: ProjectRole | undefined }

type Item = Record<string, unknown>;
const decisionKey = (orgId: OrgId, project: string, decisionId: string) => ({ pk: projectPk(orgId, project), sk: `${PRODUCT_DECISION_SK_PREFIX}${decisionId}` });
const requestOf = (decision: Item, requestId: string): { fingerprint?: unknown } | undefined =>
  (Array.isArray(decision["requests"]) ? (decision["requests"] as Array<{ id?: unknown; fingerprint?: unknown }>) : []).find((request) => request.id === requestId);
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cancelled = (error: unknown) => error instanceof Error && error.name === "TransactionCanceledException";

async function getItem(deps: Pick<ProductDecisionDeps, "documentClient" | "tableName">, k: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: k, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** The decision a raise of `requestId` on `taskId` makes: the same request always names the same decision, so a retried raise makes one. */
export function productDecisionIdOf(orgId: OrgId, taskId: string, requestId: string): string {
  return `pdq_${createHash("sha256").update(`rovara-product-decision|${orgId}|${taskId}|${requestId}`).digest("base64url").slice(0, 24)}`;
}

/** The task, only when it is this org's and this project's (task partitions are global, so the org is re-checked on the item). Anything else is no task. */
async function taskOf(deps: Pick<ProductDecisionDeps, "documentClient" | "tableName">, orgId: OrgId, project: string, taskId: string): Promise<DeveloperTaskRecord | undefined> {
  const item = await getItem(deps, taskKey(taskId)) as (DeveloperTaskRecord & Item) | undefined;
  return item !== undefined && item.orgId === orgId && item.project === project ? item : undefined;
}

/**
 * Raises a product decision on a task (the task side calls this; there is no route that raises one from outside). The task must be this org's and this project's. Retrying the same `requestId` answers
 * the decision it made; the same id with another question is CONFIG_INVALID. The decision and its audit event are one transaction.
 */
export async function raiseProductDecision(deps: ProductDecisionDeps, input: { orgId: OrgId; project: string; taskId: string; requestId: string; raise: ProductDecisionRaise; raisedBy: { kind: "member"; id: string } | { kind: "system"; id: "rovara" } }): Promise<{ decisionId: string }> {
  const parsed = ProductDecisionRaiseSchema.safeParse(input.raise);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "decision"}: is not a valid product decision`);
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(input.requestId)) throw agentXError("CONFIG_INVALID", "requestId: a request id of 8 to 64 letters, digits, - or _");
  if (await taskOf(deps, input.orgId, input.project, input.taskId) === undefined) throw agentXError("NOT_FOUND", "that task was not found");
  const decisionId = productDecisionIdOf(input.orgId, input.taskId, input.requestId);
  const fingerprint = sha(parsed.data);
  // M2: the stored risk is never below the fixed floor (the plan's risk; never low for a sensitive path), whatever the raiser asked. Option ids are assigned, so no words reach an id or a fact.
  const risk = productDecisionRisk(parsed.data);
  const options = parsed.data.options.map((label, index) => ({ id: `o${String(index + 1)}`, label }));
  const at = iso(deps.now());
  const event = await tryAuditEvent(deps, () => auditProductDecisionRaised({
    orgId: input.orgId, actor: input.raisedBy, occurredAt: at, occurrence: auditOccurrence("product_decision", decisionId), taskId: input.taskId, decisionId, risk, options: options.length,
  }));
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
        ...decisionKey(input.orgId, input.project, decisionId), entityType: "PRODUCT_DECISION", orgId: input.orgId, project: input.project, taskId: input.taskId, decisionId,
        question: parsed.data.question, options, risk, status: "open", revision: 1, raisedAt: at, raiseFingerprint: fingerprint, answers: [],
      } } },
      ...(event === undefined ? [] : auditPending(deps, event)),
    ] }));
  } catch (error) {
    if (!cancelled(error)) throw error;
    const existing = await getItem(deps, decisionKey(input.orgId, input.project, decisionId));
    if (existing?.["raiseFingerprint"] === fingerprint) return { decisionId };
    throw agentXError("CONFIG_INVALID", PRODUCT_DECISION_REQUEST_REUSED);
  }
  if (event !== undefined) await flushAuditEvents(deps, [event]);
  return { decisionId };
}

/**
 * The caller's standing on this decision for the approval-place rule. A maintainer is `maintainer`. The task's owner is `owner` while their live role may still start work (a viewer or collaborator who once
 * started it decides by their role now). Otherwise their project role; no role is `none`.
 */
async function standingOf(deps: ProductDecisionDeps, caller: ProductDecisionCaller, decision: Item): Promise<ApprovalDeciderRole> {
  const role = caller.role;
  if (role === undefined) return "none";
  if (role === "maintainer") return "maintainer";
  if (projectAllows(role, "start_tasks")) {
    const task = await taskOf(deps, caller.orgId, decision["project"] as string, decision["taskId"] as string);
    if (task !== undefined && await isTaskOwner(task, caller.developerId, deps.resolveMember)) return "owner";
    // A co-owner (an `owner` entry of the task's People list) is a co-owner. Anything that cannot be read is not (fail closed).
    if (task !== undefined) {
      const people = await resolveTaskPeopleAccess({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, task, caller.developerId).catch(() => undefined);
      if (people?.role === "owner") return "co-owner";
    }
  }
  return role;
}

/** What the policy says to an approve by this standing, now. The project's switch is read live for a collaborator only (nobody else depends on it). */
async function approveVerdict(deps: ProductDecisionDeps, caller: ProductDecisionCaller, decision: Item, standing: ApprovalDeciderRole, fence?: { check?: Item }): Promise<ApprovalPlaceVerdict> {
  let collaboratorApprovals = false;
  if (standing === "collaborator") {
    const read = await collaboratorSwitchFence(deps, caller.orgId, decision["project"] as string);
    collaboratorApprovals = read.enabled;
    if (fence !== undefined) fence.check = read.check;
  }
  // Decided in the browser (the routes are browser-only). A high one needs the fresh sign-in step, which this route does not take yet: it is refused (fail closed), never approved without it.
  return approvalPlaceDecision({
    kind: "product", risk: decision["risk"] as "low" | "medium" | "high", answer: "approve", place: "browser", decider: { role: standing, linked: true },
    settings: { recentSignIn: DEFAULT_RECENT_SIGN_IN_SETTING, collaboratorApprovals }, freshSignIn: false, nowMs: deps.now(),
  });
}

const canAnswer = (role: ProjectRole | undefined, standing: ApprovalDeciderRole): boolean => standing === "owner" || standing === "co-owner" || (role !== undefined && projectAllows(role, "answer_questions"));

/** The names a decision shows, each as the person is shown now (an erased person reads as "A former member"). */
async function withShownNames(deps: ProductDecisionDeps, orgId: OrgId, item: Item): Promise<Item> {
  const answers = (Array.isArray(item["answers"]) ? item["answers"] : []) as Array<{ by: { developerId: string; name: string }; at: string }>;
  const approved = item["approved"] as { by: { developerId: string; name: string }; at: string } | undefined;
  const ids = [...answers.map((answer) => answer.by.developerId), ...(approved === undefined ? [] : [approved.by.developerId])];
  if (ids.length === 0) return item;
  const replaced = await replacementNames(nameResolverOf(deps, orgId), ids);
  const shown = (by: { developerId: string; name: string }, at: string) => ({ ...by, name: shownNameOf(by.name, by.developerId, replaced, at) });
  return {
    ...item, answers: answers.map((answer) => ({ ...answer, by: shown(answer.by, answer.at) })),
    ...(approved === undefined ? {} : { approved: { ...approved, by: shown(approved.by, approved.at) } }),
  };
}

async function viewOf(deps: ProductDecisionDeps, caller: ProductDecisionCaller, stored: Item): Promise<ProductDecisionView> {
  const item = await withShownNames(deps, caller.orgId, stored);
  const standing = await standingOf(deps, caller, item);
  const open = item["status"] === "open";
  const verdict = open ? await approveVerdict(deps, caller, item, standing) : undefined;
  const refusal = verdict === undefined || verdict.allowed ? undefined
    : verdict.reason === "collaborator_approvals_off" || verdict.reason === "role_not_allowed" || verdict.reason === "fresh_sign_in_required" ? verdict.reason : "role_not_allowed" as const;
  return ProductDecisionViewSchema.parse({
    decisionId: item["decisionId"], taskId: item["taskId"], project: item["project"], question: item["question"], options: item["options"], risk: item["risk"], status: item["status"], revision: item["revision"],
    raisedAt: item["raisedAt"], answers: item["answers"] ?? [], ...(item["approved"] === undefined ? {} : { approved: item["approved"] }),
    you: { canAnswer: open && canAnswer(caller.role, standing), canApprove: verdict?.allowed === true, ...(refusal === undefined ? {} : { approveRefusal: refusal }) },
  });
}

/** The project's product decisions, open first, newest first within each, at most PRODUCT_DECISIONS_LIST_MAX. Anyone who can see the project may read them (the route has checked that). */
export async function listProductDecisions(deps: ProductDecisionDeps, caller: ProductDecisionCaller, project: string): Promise<ProductDecisionView[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": projectPk(caller.orgId, project), ":prefix": PRODUCT_DECISION_SK_PREFIX },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []).filter((item) => item["entityType"] === "PRODUCT_DECISION" && item["orgId"] === caller.orgId));
    start = page.LastEvaluatedKey;
  } while (start !== undefined && items.length < 500);
  const ordered = items.sort((a, b) => (a["status"] === b["status"] ? String(b["raisedAt"]).localeCompare(String(a["raisedAt"])) : a["status"] === "open" ? -1 : 1)).slice(0, PRODUCT_DECISIONS_LIST_MAX);
  return Promise.all(ordered.map((item) => viewOf(deps, caller, item)));
}

/**
 * `POST /v1/app/projects/{name}/product-decisions/{decisionId}`: answer it (a note, settles nothing) or approve one option (settles it, by the approval-place rule). A decision of another org or project, or
 * none, is NOT_FOUND. The body names the revision it read (another: CHANGE_STALE). The same request id again answers the decision as it is and writes nothing; with another body it is CONFIG_INVALID.
 */
export async function decideProductDecision(deps: ProductDecisionDeps, caller: ProductDecisionCaller, project: string, decisionId: string, rawBody: unknown): Promise<ProductDecisionView> {
  if (!ProductDecisionIdSchema.safeParse(decisionId).success) throw agentXError("NOT_FOUND", PRODUCT_DECISION_NOT_FOUND);
  const parsed = ProductDecisionDecideBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: is not a valid answer or approval`);
  const body = parsed.data;
  const key = decisionKey(caller.orgId, project, decisionId);
  const fingerprint = sha({ by: caller.developerId, decisionId, body });
  const decision = await getItem(deps, key);
  if (decision === undefined || decision["entityType"] !== "PRODUCT_DECISION" || decision["orgId"] !== caller.orgId) throw agentXError("NOT_FOUND", PRODUCT_DECISION_NOT_FOUND);

  const earlier = requestOf(decision, body.requestId);
  if (earlier !== undefined) {
    if (earlier["fingerprint"] !== fingerprint) throw agentXError("CONFIG_INVALID", PRODUCT_DECISION_REQUEST_REUSED);
    return viewOf(deps, caller, decision);
  }
  if (decision["status"] !== "open") throw agentXError("CHANGE_STALE", PRODUCT_DECISION_SETTLED);
  if ((await readProjectMeta(deps, caller.orgId, project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", PRODUCT_DECISION_ARCHIVED);
  if (body.expectedRevision !== decision["revision"]) throw agentXError("CHANGE_STALE", PRODUCT_DECISION_STALE);

  const standing = await standingOf(deps, caller, decision);
  const revision = Number(decision["revision"]) + 1;
  const at = iso(deps.now());
  const taskId = decision["taskId"] as string;
  const risk = decision["risk"] as string;
  const actor = { kind: "member" as const, id: caller.developerId };
  const occurrence = auditOccurrence("product_decision", decisionId, body.requestId);
  const requests = [...(Array.isArray(decision["requests"]) ? decision["requests"] as unknown[] : []), { id: body.requestId, by: caller.developerId, fingerprint, action: body.action, revision }].slice(-REQUESTS_KEPT);
  let update: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown>; ExpressionAttributeNames?: Record<string, string> };
  let event;
  const fences: Item[] = [];
  let notify = false;
  if (body.action === "answer") {
    if (!canAnswer(caller.role, standing)) throw agentXError("FORBIDDEN", PRODUCT_DECISION_ANSWER_FORBIDDEN);
    const answers = Array.isArray(decision["answers"]) ? decision["answers"] : [];
    if (answers.length >= PRODUCT_DECISION_ANSWERS_MAX) throw agentXError("CONFIG_INVALID", PRODUCT_DECISION_ANSWERS_FULL);
    update = { UpdateExpression: "SET answers = list_append(if_not_exists(answers, :none), :answer), revision = :next, requests = :requests", ExpressionAttributeValues: { ":requests": requests, ":none": [], ":answer": [{ by: { developerId: caller.developerId, name: caller.name.slice(0, 200) }, text: body.text, at }], ":next": revision } };
    event = await tryAuditEvent(deps, () => auditProductDecisionAnswered({ orgId: caller.orgId, actor, occurredAt: at, occurrence, taskId, decisionId, risk, revision }));
  } else {
    const options = (Array.isArray(decision["options"]) ? decision["options"] : []) as Array<{ id?: unknown }>;
    if (!options.some((option) => option.id === body.optionId)) throw agentXError("CONFIG_INVALID", "optionId: not one of this decision's options");
    const fence: { check?: Item } = {};
    const verdict = await approveVerdict(deps, caller, decision, standing, fence);
    if (!verdict.allowed) throw agentXError("FORBIDDEN", PRODUCT_DECISION_REFUSALS[verdict.reason] ?? PRODUCT_DECISION_REFUSALS["role_not_allowed"]!);
    // The policy allowed exactly these standings for a product approve; recorded as the policy saw them, with `class: product` so no code rule can mistake it for a code approval.
    const role = standing === "owner" || standing === "co-owner" ? "owner" : standing === "maintainer" ? "maintainer" : "collaborator";
    notify = verdict.notifyOwner;
    // The approve applies only while what it was decided from still holds: the project's switch as read (for a collaborator) and the approver's own grant row as read (their role).
    if (fence.check !== undefined) fences.push(fence.check);
    const grant = await grantFence(deps, caller, project);
    if (grant !== undefined) fences.push(grant);
    update = {
      UpdateExpression: "SET #status = :approved, approved = :record, revision = :next, requests = :requests", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":requests": requests, ":approved": "approved", ":record": { optionId: body.optionId, by: { developerId: caller.developerId, name: caller.name.slice(0, 200) }, role, at, class: "product" }, ":next": revision },
    };
    event = await tryAuditEvent(deps, () => auditProductDecisionApproved({ orgId: caller.orgId, actor, occurredAt: at, occurrence, taskId, decisionId, risk, role, optionId: body.optionId, revision }));
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: deps.tableName, Key: key, ...update, ConditionExpression: "revision = :seen AND #st = :open",
        ExpressionAttributeNames: { ...(update.ExpressionAttributeNames ?? {}), "#st": "status" }, ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ":seen": decision["revision"], ":open": "open" } } },
      ...fences,
      ...(event === undefined ? [] : auditPending(deps, event)),
    ] }));
  } catch (error) {
    if (!cancelled(error)) throw error;
    // The decision changed, or the same request id got in first: read again. A replay answers as above; anything else is stale.
    const now = await getItem(deps, key);
    if (now !== undefined && requestOf(now, body.requestId)?.fingerprint === fingerprint) return viewOf(deps, caller, now);
    throw agentXError("CHANGE_STALE", PRODUCT_DECISION_STALE);
  }
  if (event !== undefined) await flushAuditEvents(deps, [event]);
  if (notify) await tellOwner(deps, caller, decision, body.requestId);
  return viewOf(deps, caller, (await getItem(deps, key)) ?? decision);
}

/** The approver's own grant row as read, as a ConditionCheck: a role changed (or removed) between the read and the write refuses the approve. A caller with no row (a company owner or admin, a channel member) has none to pin. */
async function grantFence(deps: ProductDecisionDeps, caller: ProductDecisionCaller, project: string): Promise<Item | undefined> {
  const key = projectMemberKey(caller.orgId, caller.developerId, project);
  const row = await getItem(deps, key);
  if (row === undefined) return undefined;
  const pinned = row["projectRole"] === undefined ? "attribute_not_exists(projectRole)" : "projectRole = :pr";
  return { ConditionCheck: { TableName: deps.tableName, Key: key, ConditionExpression: `#role = :r AND ${pinned}`, ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: { ":r": row["role"], ...(row["projectRole"] === undefined ? {} : { ":pr": row["projectRole"] }) } } };
}

/** Decision 97: tell the task's owner who settled their decision. Best effort: a failure is swallowed (the decision stands). */
async function tellOwner(deps: ProductDecisionDeps, caller: ProductDecisionCaller, decision: Item, requestId: string): Promise<void> {
  if (deps.notifyOwner === undefined) return;
  try {
    const task = await taskOf(deps, caller.orgId, decision["project"] as string, decision["taskId"] as string);
    const owner = task === undefined ? undefined : tryEffectiveTaskOwner(task);
    if (owner === undefined || owner.developerId === caller.developerId) return;
    await deps.notifyOwner({ orgId: caller.orgId, ownerDeveloperId: owner.developerId, requestId, deciderName: caller.name, title: typeof task?.title === "string" ? task.title : "a task" });
  } catch { /* the decision committed; the notice is best effort */ }
}
