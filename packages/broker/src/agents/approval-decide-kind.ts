// Plan 3, Task 21a-wiring (PF21, R68): the `apr` kind of approval on the confirmation page. 21a-presence built the page, the tickets and the
// session around a seam (`DecideKind`); this registers what is behind it for every approval the broker keeps: write approvals (Task 21),
// step approvals and change approvals (agent publishes, connector widenings, comment-trigger opt-outs, ...).
//
// `inspect` is `mayDecide`: the same live evaluation `decideApproval` makes (the record's registered approver rule, or its id list through the
// member's role on the run's project), plus the member's LIVE org membership. The candidates stored on the record are never consulted (R68).
// `decide` is `decideApproval` as that member, with the session's proof, under a request id derived from the session so a retry replays.
import { createHash } from "node:crypto";
import { ApprovalIdSchema, agentXError, type AuditProof } from "@agentx/contracts";
import type { ConfirmView, DecideInspection, DecideKind, DecideOutcome, DecideTarget } from "../developer/decide-kinds.js";
import { orgRoleOf, type AgentCaller } from "./access.js";
import { decideApproval, getAnyApproval, mayDecideApproval, runOfApproval, shownText, type AnyApprovalRecord, type ApprovalDependencies } from "./approvals.js";
import { WRITE_APPROVER_RULE } from "./write-gate.js";

const NAME_MAX = 80;
const OPEN_AGAIN = "Open the approval again from Rovara.";

/** Who may decide a record, for "Only <who> can decide this.": words, never an id, and never a list of the people it was first asked of. */
async function whoMayDecide(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<string> {
  if (record.kind === "write") return `${shownText(record.owner.name, NAME_MAX)} or a project maintainer`;
  if (record.approvers.kind === "rule") {
    switch (record.approvers.rule) {
      case WRITE_APPROVER_RULE: {
        const run = await runOfApproval(deps, record);
        return run === undefined ? "a project maintainer" : `${shownText(run.owner.name, NAME_MAX)} or a project maintainer`;
      }
      case "org_admin": return "an organization owner or admin";
      case "agent_publish":
      case "agent_manager": return "the agent's owner, a maintainer of its project, or an organization owner or admin";
      case "project_settings": return "a maintainer of this project";
      default: return "the people it was asked of";
    }
  }
  return "the people it was asked of";
}

async function nameOf(deps: ApprovalDependencies, developerId: string | undefined): Promise<string> {
  if (developerId === undefined) return "a teammate";
  try {
    const record = await deps.signInStore.getDeveloper(developerId);
    return shownText(record?.displayName ?? "a teammate", NAME_MAX) || "a teammate";
  } catch {
    return "a teammate";
  }
}

const TITLES: Record<string, string> = {
  agent_publish: "Publish an agent",
  agent_rollback: "Roll an agent back",
  builtin_adopt: "Use a new version of a built-in agent",
  agent_share: "Share an agent with the whole company",
  guardrails: "Relax the company's agent guardrails",
  connector_widen: "Let a project's connector make changes",
  opt_out: "Let agents comment in a repository whose workflows act on comments",
};

const fact = (label: string, value: string) => ({ label, value });

/** What the page shows for an open record: the people and project it concerns, the words of what it does, and for a write the exact call. */
async function viewOf(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<ConfirmView> {
  const expires = fact("Expires", record.expiresAt);
  if (record.kind === "write") {
    return {
      title: "An agent wants to make a change",
      facts: [
        ...(record.agent === undefined ? [] : [fact("Agent", record.agent.name)]),
        fact("Project", record.project), fact("Run", record.subject.taskId), fact("Step", record.subject.stepId), fact("Run owner", record.owner.name),
        fact("Connector", `${record.connector} (${record.connectorType})`), fact("Kind of action", record.class === "merge" ? "Merge" : "Change"), expires,
      ],
      paragraphs: [record.summary],
      call: { connector: record.connector, tool: record.tool, arguments: record.arguments },
    };
  }
  if (record.kind === "step") {
    const run = await runOfApproval(deps, record);
    return {
      title: "A run is waiting for you",
      facts: [...(run === undefined ? [] : [fact("Project", run.project), fact("Run owner", run.owner.name)]), expires],
      paragraphs: [record.prompt],
    };
  }
  const subject = record.subject;
  const facts = [fact("Asked by", await nameOf(deps, record.requestedBy))];
  if (subject.kind === "opt_out") {
    facts.push(fact("Project", subject.project), fact("Repository", subject.repository), fact("Reviewed workflows", subject.files.join("\n")), fact("Digest of what was reviewed", subject.expectedDigest), fact("Reason", subject.reason));
  } else if (subject.kind === "connector_widen") {
    facts.push(fact("Project", subject.project), fact("Connector", subject.name), fact("Project revision it applies to", String(subject.expectedRevision)));
  }
  facts.push(expires);
  return { title: TITLES[subject.kind] ?? "Confirm a change", facts, paragraphs: record.changes };
}

async function callerOf(deps: ApprovalDependencies, target: DecideTarget, proof?: AuditProof): Promise<AgentCaller | undefined> {
  const orgRole = await orgRoleOf(deps, target.orgId, target.developerId);
  return orgRole === undefined ? undefined : { orgId: target.orgId, developerId: target.developerId, orgRole, ...(proof === undefined ? {} : { decideProof: proof }) };
}

/** A decision's request id from its session: one session decides one approval, so the same session always names the same request (R18). */
export function requestIdFor(proof: AuditProof, approvalId: string): string {
  const hex = createHash("sha256").update(`rovara-page-decision|${proof.kind === "fresh_sign_in" ? proof.sessionRef : ""}|${approvalId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/** What the page says once a decision is made: in words, from what the record ended as. */
function outcomeOf(record: AnyApprovalRecord | undefined, decision: "approve" | "decline"): DecideOutcome {
  if (decision === "decline" || record?.status === "DECLINED") {
    return { message: record?.kind === "write" ? "Declined. The action did not run." : "Declined. Nothing was changed." };
  }
  switch (record?.status) {
    case "APPROVED_FAILED":
      return { title: "Approved, but it did not go through", message: shownText(record.failure ?? "Rovara could not carry it out.", 400) };
    case "APPROVED_DONE": return { message: record.kind === "write" ? "Approved. The action ran." : "Approved. The change was applied." };
    case "APPROVED": return { message: "Approved. The run will go on." };
    default: return { message: "Approved. Rovara is finishing it and will record the result." };
  }
}

export function approvalDecideKind(deps: ApprovalDependencies): DecideKind {
  async function inspect(target: DecideTarget): Promise<DecideInspection> {
    const id = ApprovalIdSchema.safeParse(target.approvalId);
    if (!id.success) return { status: "not_found" };
    // The member must be in the org NOW: a session or ticket from before they left is not enough (presence review).
    const caller = await callerOf(deps, target);
    if (caller === undefined) return { status: "not_found" };
    const record = await getAnyApproval(deps, target.orgId, id.data);
    if (record === undefined) return { status: "not_found" };
    // Who may decide is asked first, so a person who may not learns nothing about how it ended.
    if (!await mayDecideApproval(deps, caller, record)) return { status: "forbidden", who: await whoMayDecide(deps, record) };
    if (record.status === "EXPIRED") return { status: "expired", at: record.expiresAt };
    if (record.status !== "PENDING") return { status: "decided", by: await nameOf(deps, record.decidedBy), at: record.decidedAt ?? record.expiresAt };
    // The sweep ends an approval whose time ran out within minutes; until it does, the page treats it as ended.
    if (Date.parse(record.expiresAt) <= deps.now()) return { status: "expired", at: record.expiresAt };
    return { status: "open", view: await viewOf(deps, record) };
  }

  async function decide(target: DecideTarget, decision: "approve" | "decline", proof: AuditProof): Promise<DecideOutcome> {
    // Only the page's fresh sign-in decides (R66): a proof of any other kind is refused here, whatever called.
    if (proof.kind !== "fresh_sign_in") throw agentXError("FORBIDDEN", `Decisions are made on the confirmation page. ${OPEN_AGAIN}`);
    const id = ApprovalIdSchema.safeParse(target.approvalId);
    const caller = id.success ? await callerOf(deps, target, proof) : undefined;
    if (!id.success || caller === undefined) throw agentXError("NOT_FOUND", "approval not found");
    const body = { requestId: requestIdFor(proof, target.approvalId), decision: decision === "approve" ? "APPROVE" : "DECLINE" };
    await decideApproval(deps, caller, id.data, body);
    return outcomeOf(await getAnyApproval(deps, target.orgId, id.data), decision);
  }

  return { inspect, decide };
}
