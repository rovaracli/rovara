// Plan 3 Task 21: the approval routes. `GET /v1/app/approvals?status=PENDING` lists the approvals that name the caller; `GET /v1/app/approvals/{id}` shows
// one (with the full stored arguments of a write) to an approver or anyone who can view its task, and answers 404 to everyone else; `POST
// /v1/app/approvals/{id}/decide` decides one of any kind. Deciding is reached only through Task 21a's presence guard (`ApprovalDependencies.requireDecide`):
// a CLI or MCP token gets REAUTH_REQUIRED with the page link from it, a browser needs a fresh sign-in on the confirmation page. Without the guard wired
// the decide route does not exist. `POST /v1/app/approvals/{id}/confirm-link` mints the ticketed link for a person who may decide it; a plain read never mints.
import { z } from "zod";
import { AgentXError, ApprovalIdSchema, agentXError } from "@agentx/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { orgRoleOf, type AgentCaller } from "./access.js";
import {
  confirmUrlFor, decideApproval, getAnyApproval, listApprovalsFor, mayDecideApproval, runOfApproval,
  type AnyApprovalRecord, type ApprovalDependencies, type ApprovalStatus,
} from "./approvals.js";
import { endOfFailure, settleSession, type DecisionEnd } from "../developer/decide-session.js";
import { sameMember } from "./lifecycle.js";
import { requestIdFor } from "./approval-decide-kind.js";
import { decideWriteApproval } from "./write-gate.js";
import { chosenOwnerNames, withChosenOwnerName } from "../agent-sessions/owner-names.js";

const APPROVALS_PATH = /^\/v1\/app\/approvals(?:\/([^/]+)(?:\/(decide|confirm-link))?)?$/;
// Only PENDING approvals are in a person's list: a record that ended PENDING is taken out of it.
const STATUSES = ["PENDING"] as const satisfies readonly ApprovalStatus[];
const StatusQuerySchema = z.enum(STATUSES);

const notFound = () => agentXError("NOT_FOUND", "approval not found");

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

/**
 * Release 0.4.18: a run's owner is named by the name they chose, read by the stored owner's id (an approval made before the rename stored the name they had then). One BatchGetItem
 * for the whole list; best effort (a failed read shows the stored name); the name is email-safe, as everywhere. Only the views use it, so a list costs one read, not one per record.
 */
export async function withChosenOwners(deps: Pick<ApprovalDependencies, "documentClient" | "tableName">, records: AnyApprovalRecord[]): Promise<AnyApprovalRecord[]> {
  const owners = records.flatMap((record) => (record.kind === "change" || record.owner === undefined ? [] : [record.owner.developerId]));
  const names = await chosenOwnerNames(deps, owners, records[0]?.orgId);
  if (names.size === 0) return records;
  return records.map((record) => (record.kind === "change" || record.owner === undefined ? record : { ...record, owner: withChosenOwnerName(record.owner, names) }));
}

/** A record as a page lists it. The arguments of a write are shown only with `includeArguments` (to one approval's viewers, not in a list). */
export function approvalView(deps: Pick<ApprovalDependencies, "confirmOrigin">, record: AnyApprovalRecord, includeArguments = false): Record<string, unknown> {
  const common = {
    approvalId: record.approvalId, kind: record.kind, status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt, confirmUrl: confirmUrlFor(deps, record),
    ...(record.decidedBy === undefined ? {} : { decidedBy: record.decidedBy }), ...(record.decidedAt === undefined ? {} : { decidedAt: record.decidedAt }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  };
  if (record.kind === "write") {
    return {
      ...common, summary: record.summary, class: record.class, connector: record.connector, tool: record.tool, scope: record.scope, ...(record.repository === undefined ? {} : { repository: record.repository }), project: record.project,
      taskId: record.subject.taskId, stepId: record.subject.stepId, owner: { name: record.owner.name }, projectRevision: record.projectRevision, attempts: record.attempts ?? 0,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(includeArguments ? { arguments: record.arguments, argumentsHash: record.argumentsHash } : {}),
    };
  }
  if (record.kind === "step") return { ...common, prompt: record.prompt, subject: record.subject, ...(record.project === undefined ? {} : { project: record.project }) };
  return { ...common, changes: record.changes, subjectKind: record.subject.kind };
}

/** Whether `caller` may look at the record: they may decide it now (read live, not from the people it was first listed for), it was asked for them, or they can view its task. */
async function maySee(deps: ApprovalDependencies, caller: AgentCaller, record: AnyApprovalRecord): Promise<boolean> {
  if (await mayDecideApproval(deps, caller, record)) return true;
  if (record.kind === "change") return await sameMember(deps, record.orgId, record.requestedBy, caller.developerId);
  const run = await runOfApproval(deps, record);
  if (run === undefined) return false;
  const taskId = record.kind === "write" ? record.subject.taskId : (record.subject as { taskId?: unknown }).taskId;
  if (deps.writeGate?.canViewTask !== undefined && typeof taskId === "string") {
    return deps.writeGate.canViewTask(caller, { taskId, project: run.project, developerId: run.owner.developerId });
  }
  return sameMember(deps, record.orgId, run.owner.developerId, caller.developerId);
}

async function readVisible(deps: ApprovalDependencies, caller: AgentCaller, rawId: string): Promise<AnyApprovalRecord> {
  const id = ApprovalIdSchema.safeParse(rawId);
  const record = id.success ? await getAnyApproval(deps, caller.orgId, id.data) : undefined;
  // A record of another org, one that doesn't exist and one the caller may not see read the same.
  if (record === undefined || !await maySee(deps, caller, record)) throw notFound();
  return record;
}

export const isApprovalRoute = (pathname: string): boolean => APPROVALS_PATH.test(pathname);

/** `routeApprovalRequest(deps, caller, request, url)`: the approval routes. */
export async function routeApprovalRequest(deps: ApprovalDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const matched = APPROVALS_PATH.exec(url.pathname);
  if (matched === null) throw agentXError("NOT_FOUND", "route not found");
  const [, rawId, action] = matched;
  if (rawId === undefined) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
    const status = StatusQuerySchema.safeParse(url.searchParams.get("status") ?? "PENDING");
    if (!status.success) throw agentXError("CONFIG_INVALID", `status: one of ${STATUSES.join(", ")}`);
    const records = await withChosenOwners(deps, await listApprovalsFor(deps, caller, status.data));
    return { approvals: records.map((record) => approvalView(deps, record)) };
  }
  if (action === undefined) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
    // A read shows the bare link and mints nothing: tickets are limited, and a poll must not use them up (review I1).
    const [record] = await withChosenOwners(deps, [await readVisible(deps, caller, rawId)]);
    return { approval: approvalView(deps, record!, true) };
  }
  if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
  if (action === "confirm-link") return confirmLink(deps, caller, rawId);
  const requireDecide = deps.requireDecide;
  if (requireDecide === undefined) throw agentXError("NOT_FOUND", "that isn't available yet");
  // The CSRF field belongs to the guard (it checks it against the session), not to the decision: the decision's body takes only its own fields.
  const { csrf: _csrf, ...given } = jsonBody(request) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- checked by the guard
  // The guard says who is deciding: a browser session opened for this approval, signed in within the last 10 minutes. A token never gets past it.
  const authority = await requireDecide(request, rawId);
  // What came of the decision decides what happens to the session (M-d): refused before or by the decision, it is given back; made, it is spent;
  // a failure of ours after the decision began may have partly happened, so it stays spent.
  let end: DecisionEnd = "refused";
  try {
    const orgRole = await orgRoleOf(deps, authority.orgId, authority.developerId);
    if (orgRole === undefined) throw notFound();
    const decider: AgentCaller = { orgId: authority.orgId, developerId: authority.developerId, orgRole, decideProof: authority.proof };
    // A decision by a fresh sign-in has the request id its session names, as on the page; the client's is not used (a repeat by the same session replays).
    const body = authority.proof.kind === "fresh_sign_in" ? { ...given, requestId: requestIdFor(authority.proof, rawId) } : given;
    const record = ApprovalIdSchema.safeParse(rawId).success ? await getAnyApproval(deps, decider.orgId, rawId) : undefined;
    if (record === undefined) throw notFound();
    end = "failed";
    const result = record.kind === "write" ? await decideWriteApproval(deps, decider, rawId, body) : await decideApproval(deps, decider, rawId, body);
    end = "decided";
    return result;
  } catch (error) {
    if (end === "failed") end = endOfFailure(error);
    throw error;
  } finally {
    await settleSession(authority, end);
  }
}

/**
 * `POST /v1/app/approvals/{id}/confirm-link`: the link a person opens to decide, with a decide ticket minted for them when they may decide it now (what the
 * CLI's `approvals open` and the MCP tool call). Anyone else who can see the approval, an approval that is no longer open (decided, or past its time with the
 * sweep not yet there), a limit reached or any other error of ours gets the bare link, which the page's identify step handles; `ticketed` says which. A caller
 * who cannot see the approval at all gets the same 404 as a read. What is not ours (a store outage) is rethrown.
 */
async function confirmLink(deps: ApprovalDependencies, caller: AgentCaller, rawId: string): Promise<{ confirmUrl: string; ticketed: boolean }> {
  const record = await readVisible(deps, caller, rawId);
  const bare = { confirmUrl: confirmUrlFor(deps, record), ticketed: false };
  if (deps.mintConfirmUrl === undefined || record.status !== "PENDING" || Date.parse(record.expiresAt) <= deps.now() || !await mayDecideApproval(deps, caller, record)) return bare;
  try {
    return { confirmUrl: await deps.mintConfirmUrl(caller, record.approvalId), ticketed: true };
  } catch (error) {
    if (error instanceof AgentXError) return bare;
    throw error;
  }
}
