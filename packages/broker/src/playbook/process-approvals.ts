// "How we work" (H4): the person who asked for a change to a project's process cannot confirm it themselves. A pending change whose subject is a process layer (an agent marked
// `purpose: "process"`) is confirmed by someone else who can approve changes in the project, unless the person who asked is the only one who could (a project of one): then they may,
// on the confirmation page with a fresh sign-in as always, and the `process.published` audit event says so (`selfConfirmedSoleOwner`). The eligible approvers are those of the
// `agent_publish` rule, read now: the owner, a project maintainer with `manage_agents`, an org owner or admin. Declining your own request is not a confirmation and is never refused.
import { PROCESS_SELF_CONFIRM_MESSAGE, agentXError } from "@rovara-code/contracts";
import { orgRoleOf } from "../agents/access.js";
import { sameMember } from "../agents/lifecycle.js";
import type { AnyApprovalRecord, ApprovalCaller, ApprovalDecisionGuard, ApprovalDependencies } from "../agents/approvals-store.js";
import type { AgentRecord } from "../agents/store.js";

/** What the guard needs from the agent changes: who is asked about an agent's change, and whether a person may decide this record now (the `agent_publish` rule). */
export interface ProcessApprovalRules {
  candidatesOf(deps: ApprovalDependencies, agent: AgentRecord): Promise<readonly string[]>;
  mayDecide(deps: ApprovalDependencies, record: AnyApprovalRecord, caller: ApprovalCaller): Promise<boolean>;
}

/** The process layer a pending change is about, if it is about one; undefined for every other record. */
async function processLayerOf(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<AgentRecord | undefined> {
  if (record.kind !== "change") return undefined;
  const agentId = (record.subject as { agentId?: unknown }).agentId;
  if (typeof agentId !== "string") return undefined;
  const agent = await deps.store.get(record.orgId, agentId);
  return agent?.purpose === "process" ? agent : undefined;
}

/** Whether the person who is deciding is the person who asked. */
async function isRequester(deps: ApprovalDependencies, record: AnyApprovalRecord, developerId: string): Promise<boolean> {
  return record.kind === "change" && typeof record.requestedBy === "string" && await sameMember(deps, record.orgId, record.requestedBy, developerId);
}

/** Whether anyone but the requester can approve this change now (each candidate is checked by the rule itself, read live). */
async function anotherApproverExists(deps: ApprovalDependencies, rules: ProcessApprovalRules, agent: AgentRecord, record: AnyApprovalRecord): Promise<boolean> {
  for (const developerId of await rules.candidatesOf(deps, agent)) {
    if (await isRequester(deps, record, developerId)) continue;
    const orgRole = await orgRoleOf(deps, record.orgId, developerId);
    if (orgRole !== undefined && await rules.mayDecide(deps, record, { orgId: record.orgId, developerId, orgRole })) return true;
  }
  return false;
}

/** The guard registered with the approvals: refuses (PROCESS_SELF_CONFIRM, 403) a requester's own confirmation while someone else could confirm. */
export function processSelfConfirmGuard(rules: ProcessApprovalRules): ApprovalDecisionGuard {
  return async (deps, caller, record, decision) => {
    if (decision !== "APPROVE") return;
    const agent = await processLayerOf(deps, record);
    if (agent === undefined || !await isRequester(deps, record, caller.developerId)) return;
    if (await anotherApproverExists(deps, rules, agent, record)) throw agentXError("PROCESS_SELF_CONFIRM", PROCESS_SELF_CONFIRM_MESSAGE);
  };
}

/**
 * For the `process.published` event of a confirmed publish: whether the person who confirmed is the person who asked. The guard lets that happen only when they were the only eligible
 * approver, so a true here is the sole-owner confirmation. False for an ordinary agent, a record with no requester and anyone else.
 */
export async function confirmedBySoleOwner(deps: ApprovalDependencies, agent: Pick<AgentRecord, "purpose">, record: AnyApprovalRecord, decidedBy: string): Promise<boolean> {
  return agent.purpose === "process" && await isRequester(deps, record, decidedBy);
}
