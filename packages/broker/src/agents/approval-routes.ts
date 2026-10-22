// Plan 3 Task 21: the approval routes. `GET /v1/app/approvals?status=PENDING` lists the approvals that name the caller; `GET /v1/app/approvals/{id}` shows
// one (with the full stored arguments of a write) to an approver or anyone who can view its task, and answers 404 to everyone else; `POST
// /v1/app/approvals/{id}/decide` decides one of any kind. Deciding is reached only through Task 21a's presence guard (`WriteGateRuntime.requireDecide`):
// a CLI or MCP token gets REAUTH_REQUIRED with the page link from it, a browser needs a fresh sign-in on the confirmation page. Without the guard wired
// the decide route does not exist.
import { z } from "zod";
import { ApprovalIdSchema, agentXError } from "@agentx/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { orgRoleOf, type AgentCaller } from "./access.js";
import {
  confirmUrlFor, decideApproval, getAnyApproval, listApprovalsFor, mayDecideApproval, runOfApproval,
  type AnyApprovalRecord, type ApprovalDependencies, type ApprovalStatus,
} from "./approvals.js";
import { sameMember } from "./lifecycle.js";
import { decideWriteApproval } from "./write-gate.js";

const APPROVALS_PATH = /^\/v1\/app\/approvals(?:\/([^/]+)(?:\/(decide))?)?$/;
const STATUSES = ["PENDING", "EXECUTING", "APPROVED", "APPROVED_DONE", "APPROVED_FAILED", "DECLINED", "EXPIRED"] as const satisfies readonly ApprovalStatus[];
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

/** A record as a page lists it. The arguments of a write are shown only with `includeArguments` (to one approval's viewers, not in a list). */
export function approvalView(deps: Pick<ApprovalDependencies, "confirmOrigin">, record: AnyApprovalRecord, includeArguments = false): Record<string, unknown> {
  const common = {
    approvalId: record.approvalId, kind: record.kind, status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt, confirmUrl: confirmUrlFor(deps, record),
    ...(record.decidedBy === undefined ? {} : { decidedBy: record.decidedBy }), ...(record.decidedAt === undefined ? {} : { decidedAt: record.decidedAt }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  };
  if (record.kind === "write") {
    return {
      ...common, summary: record.summary, class: record.class, connector: record.connector, tool: record.tool, scope: record.scope, project: record.project,
      taskId: record.subject.taskId, stepId: record.subject.stepId, owner: { name: record.owner.name }, projectRevision: record.projectRevision, attempts: record.attempts ?? 0,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(includeArguments ? { arguments: record.arguments, argumentsHash: record.argumentsHash } : {}),
    };
  }
  if (record.kind === "step") return { ...common, prompt: record.prompt, subject: record.subject, ...(record.project === undefined ? {} : { project: record.project }) };
  return { ...common, changes: record.changes, subjectKind: record.subject.kind };
}

/** Whether `caller` is named by the record's approvers (an id or a candidate, each read as the member it stands for) or may decide it now. */
async function isApprover(deps: ApprovalDependencies, caller: AgentCaller, record: AnyApprovalRecord): Promise<boolean> {
  const named = record.approvers.kind === "ids" ? record.approvers.ids : record.approvers.candidates;
  if (named.includes(caller.developerId)) return true;
  for (const id of named) if (await sameMember(deps, record.orgId, id, caller.developerId)) return true;
  return mayDecideApproval(deps, caller, record);
}

/** Whether `caller` may look at the record: an approver, the person it was asked for, or anyone who can view its task. */
async function maySee(deps: ApprovalDependencies, caller: AgentCaller, record: AnyApprovalRecord): Promise<boolean> {
  if (await isApprover(deps, caller, record)) return true;
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
    return { approvals: (await listApprovalsFor(deps, caller, status.data)).map((record) => approvalView(deps, record)) };
  }
  if (action === undefined) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
    return { approval: approvalView(deps, await readVisible(deps, caller, rawId), true) };
  }
  if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
  const gate = deps.writeGate;
  if (gate?.requireDecide === undefined) throw agentXError("NOT_FOUND", "that isn't available yet");
  const body = jsonBody(request);
  // The guard says who is deciding: a browser session opened for this approval, signed in within the last 10 minutes. A token never gets past it.
  const authority = await gate.requireDecide(request, rawId);
  try {
    const orgRole = await orgRoleOf(deps, authority.orgId, authority.developerId);
    if (orgRole === undefined) throw notFound();
    const decider: AgentCaller = { orgId: authority.orgId, developerId: authority.developerId, orgRole, decideProof: authority.proof };
    const record = ApprovalIdSchema.safeParse(rawId).success ? await getAnyApproval(deps, decider.orgId, rawId) : undefined;
    if (record === undefined) throw notFound();
    return record.kind === "write" ? await decideWriteApproval(deps, decider, rawId, body) : await decideApproval(deps, decider, rawId, body);
  } finally {
    await authority.finish();
  }
}
