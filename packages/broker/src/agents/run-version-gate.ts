// Plan 3 final fix wave, owner decision 2026-10-22 (option D), access I-3: running an older version of an agent.
//
// A run uses the version that runs now unless one is named. A named version that is not the current one runs at once when it is no looser than the current
// one (`versionSafety`, the comparison a publish makes). A looser one waits for the agent's owner: the start answers
// `202 { status: "NEEDS_OWNER_APPROVAL", confirmUrl, changes }` and makes a change approval (`agent_run_version`) that holds exactly the run asked for. The owner
// confirms it on the page with a fresh sign-in (no token decides); then the run starts once, as the person who asked, through the same start as any run. Declining
// or letting it expire starts nothing. The start itself refuses a looser version that is not approved (roster.ts), so this is the only way to one.
import { agentXError, isBuiltinAgentId, recipeDigest, type AgentId, type OrgId, type RunInput, type WorkOrigin } from "@rovara-code/contracts";
import { requireAgentAccess, type AgentCaller } from "./access.js";
import { registerApprovalSubjectHandler, type AgentChangeSubject, type ApprovalDependencies, type ApprovalRecord } from "./approvals.js";
import { agentApprovers, orgAdminApprovers, requireActiveForConfirmation, resolveRecipe, versionSafety, waitForPerson } from "./changes.js";
import { requireAgentEnabled } from "./guardrails.js";
import { resolveAgentForTask, type RosterDependencies } from "./roster.js";
import { readRunRequest } from "./runs.js";

/** What a start that waits for the owner answers (the route's 202 body). */
export interface WaitingForOwner { confirmUrl: string; changes: string[] }

export const NEEDS_OWNER_APPROVAL = "NEEDS_OWNER_APPROVAL";

/** The run a person asked for, as the gate needs it. `version` is the one named; the gate only acts on a published version number. */
export interface RunVersionRequest {
  requestId: string;
  project: string;
  agent: { agentId: AgentId; version?: number | "draft" };
  input: RunInput;
  origin: WorkOrigin;
}

/**
 * Whether the run asked for waits for the agent's owner. Answers undefined when it does not: no version was named, it is a draft, it is the current version or one
 * no looser than it, or the run already started (a repeat of the request is answered by the start). Otherwise everything the start would check is checked first with
 * the version check waived (the project, the roster, the guardrails, `use` on the agent), so a run that could not start is refused as it would be and no approval
 * is asked for it; then the approval is made (once per request id) and the answer says where the owner confirms it.
 */
export async function gateRunVersion(deps: RosterDependencies, caller: AgentCaller, request: RunVersionRequest): Promise<WaitingForOwner | undefined> {
  const version = request.agent.version;
  if (typeof version !== "number") return undefined;
  // The run was already started (the owner approved it, or the first answer was repeated): the start answers it, whatever the versions or the roster are now.
  if (await readRunRequest(deps, caller.orgId, request.requestId) !== undefined) return undefined;
  const { agent } = await requireAgentAccess(deps, caller, request.agent.agentId, "use");
  const custom = "owner" in agent ? agent : undefined;
  const { current, safety } = await versionSafety(deps, caller.orgId, request.agent.agentId, version, custom);
  if (safety.kind !== "less_safe" || current === undefined) return undefined;
  const resolved = await resolveAgentForTask(deps, caller, { project: request.project, agent: { agentId: request.agent.agentId, version }, versionApproved: true });
  if (custom !== undefined) requireActiveForConfirmation(custom);
  const name = custom === undefined ? deps.store.builtinName(request.agent.agentId) : custom.name;
  const unit = custom === undefined ? "the version your company uses" : "the version that runs now";
  const subject: AgentChangeSubject = {
    kind: "agent_run_version", agentId: request.agent.agentId, version, digest: recipeDigest(resolved.recipe), expectedCurrentVersion: current,
    project: request.project, runRequestId: request.requestId, origin: request.origin, input: request.input,
  };
  const changes = [`Runs version ${String(version)} of ${name} on ${request.project}, which is less safe than ${unit} (version ${String(current)})`, ...safety.changes];
  const approvers = custom === undefined ? await orgAdminApprovers(deps, caller.orgId) : await agentApprovers(deps, custom, "agent_publish");
  const waiting = await waitForPerson(deps, caller, request.requestId, subject, changes, approvers);
  if (waiting.applied) throw agentXError("CONFIG_INVALID", "this run was already decided");
  return { confirmUrl: waiting.confirmUrl, changes: waiting.changes };
}

// ---- what confirming does

const stale = (message: string) => agentXError("AGENT_REVISION_CONFLICT", message);

/**
 * Starts the run the owner approved, once. It is checked again as it was shown: the version that runs now is still what the comparison was made against and
 * the version asked for still has the recipe that was shown; anything else is stale and starts nothing. The run's own request id makes a repeat of this (the
 * sweep drives a handler again after a crash) answer the run that started, so it is never started twice; and a run that already started is done, whatever
 * changed after it.
 */
async function confirmRunVersion(deps: ApprovalDependencies, record: ApprovalRecord): Promise<void> {
  if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
  const subject = record.subject as Extract<AgentChangeSubject, { kind: "agent_run_version" }>;
  const orgId: OrgId = record.orgId;
  if (await readRunRequest(deps, orgId, subject.runRequestId) !== undefined) return;
  const custom = isBuiltinAgentId(subject.agentId) ? undefined : await deps.store.get(orgId, subject.agentId);
  if (custom === undefined && !isBuiltinAgentId(subject.agentId)) throw agentXError("NOT_FOUND", "no agent has that ID");
  if (custom !== undefined && custom.status === "archived") throw agentXError("AGENT_UNAVAILABLE", `${custom.name} is archived, so it can't start new work.`);
  if (custom === undefined) await requireAgentEnabled(deps, orgId, subject.agentId);
  const { current } = await versionSafety(deps, orgId, subject.agentId, subject.version, custom);
  if (current !== subject.expectedCurrentVersion) throw stale("The version that runs now changed after this was asked. Start the run again.");
  const recipe = custom === undefined ? deps.store.builtinRecipe(subject.agentId, subject.version) : await resolveRecipe(deps, orgId, subject.agentId, subject.version);
  if (recipeDigest(recipe) !== subject.digest) throw stale("That version changed after this was asked. Start the run again.");
  if (deps.startApprovedRun === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "starting runs is not set up in this deployment");
  await deps.startApprovedRun({
    orgId, requestId: subject.runRequestId, project: subject.project, agent: { agentId: subject.agentId, version: subject.version }, input: subject.input, origin: subject.origin,
    developerId: record.requestedBy,
  });
}

/** Registers the handler for `agent_run_version`. Safe to call more than once. */
export function registerRunVersionApproval(): void {
  registerApprovalSubjectHandler("agent_run_version", confirmRunVersion);
}
