import { createHash } from "node:crypto";
import type { AuditProof } from "@agentx/contracts";
// Design review stage, DR7 slice C: what the design review's routes read about a task, fresh for each request and never from the request body. Three things:
//   - the people: who is a member of the project and may approve (maintainers, admins, owners), who never may (Auditors and viewers), through the same live roster the second-person approvals read
//     (`readApproverRoster`) and the project's member list. Groups have no store yet, so `groups` is left out and a group approver reads as nobody (`no_high_risk_approver`, fail closed);
//   - the areas the design touches: Understand's reasons PLUS every design version's own §6 `touches` (the union only ever raises a risk: a code left out lowers nothing);
//   - whether the caller signed in freshly (the session's own authentication time, not a body field).
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, orgPk, readDesignMeta, type DesignReason, type EditionPolicy, type OrgId, type WorkflowSnapshot } from "@agentx/contracts";
import { loadWorkflowDocument } from "../developer/plan-artifacts.js";
import { DeveloperSignInStore, isFreshSignIn } from "../developer/store.js";
import { listProjectMembers, type ProjectMembersDependencies } from "../org/project-members.js";
import { readApproverRoster } from "../org/second-person-evidence.js";
import type { DesignApproverDirectory } from "./approval.js";

export interface DesignFactsDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  signInTableName: string;
  now(): number;
  edition: EditionPolicy | undefined;
  members: ProjectMembersDependencies;
}

/** Nobody is eligible and the answer is not complete: every rule that reads it refuses (`eligibility_unavailable`). */
const NOBODY = { complete: false, membershipVersion: 0, ownerIds: [] as string[], eligibleIds: [] as string[], lastEligibleLossAtMs: null };

/** The org members whose role is Auditor: they hold no project role, but a group may name them, so they are listed as people who never approve. */
async function auditorIds(deps: Pick<DesignFactsDeps, "documentClient" | "tableName">, orgId: OrgId): Promise<string[]> {
  const found: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "MEMBER#" }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      const role = OrgRoleSchema.safeParse(item["role"]);
      if (typeof item["developerId"] === "string" && role.success && role.data === "auditor") found.push(item["developerId"]);
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return found;
}

/**
 * The directory the approval, skip, spend and answer rules read, for one project, now. `projectMemberIds`: everyone with a project role that can act (maintainers, contributors; org owners and admins count as maintainers);
 * `notApproverIds`: viewers and Auditors; `people`: the live roster with its membership generation (the commit is fenced with that generation). A roster that cannot be read is incomplete, never empty-but-complete.
 */
export async function readDesignDirectory(deps: DesignFactsDeps, orgId: OrgId, project: string): Promise<DesignApproverDirectory> {
  const [people, rows, auditors] = await Promise.all([
    readApproverRoster({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.signInTableName, now: () => deps.now() }, { orgId, project }).catch(() => NOBODY),
    listProjectMembers(deps.members, orgId, project).catch(() => undefined),
    auditorIds(deps, orgId).catch(() => undefined),
  ]);
  // A member list or an Auditor list that cannot be read: the roster is made incomplete, so nothing that needs the directory goes through on a guess.
  if (rows === undefined || auditors === undefined) return { people: { ...people, complete: false }, projectMemberIds: [], notApproverIds: [] };
  return {
    people,
    projectMemberIds: rows.filter((row) => row.role !== "viewer").map((row) => row.developerId),
    notApproverIds: [...rows.filter((row) => row.role === "viewer").map((row) => row.developerId), ...auditors],
  };
}

/** Every design version's own §6 `touches`, together (a design that was sent back and rewritten keeps the earlier version's areas: the union only raises). A version that cannot be read adds nothing. */
export async function readDesignTouches(workflow: Pick<WorkflowSnapshot, "artifacts">, read: (objectKey: string, maxBytes: number) => Promise<string | undefined>): Promise<DesignReason[]> {
  const touches = new Set<DesignReason>();
  for (const artifact of workflow.artifacts.filter((entry) => entry.type === "design")) {
    try {
      const document = await loadWorkflowDocument(read, artifact, {});
      if (document === undefined) continue;
      const meta = readDesignMeta(document.markdown);
      if (meta.ok) for (const code of meta.meta.touches) touches.add(code);
    } catch { /* an unreadable version adds nothing */ }
  }
  return [...touches];
}

/** The text of the latest design document, checked against its digest. Undefined where it cannot be read. */
export async function readLatestDesignText(workflow: Pick<WorkflowSnapshot, "artifacts">, read: (objectKey: string, maxBytes: number) => Promise<string | undefined>): Promise<string | undefined> {
  const artifact = workflow.artifacts.filter((entry) => entry.type === "design").at(-1);
  if (artifact === undefined) return undefined;
  try { return (await loadWorkflowDocument(read, artifact, {}))?.markdown; } catch { return undefined; }
}

/**
 * Whether the caller signed in interactively within the last few minutes, by the platform's one rule (`isFreshSignIn`). The session is read from the store: a session that is not the caller's, that was revoked or that has
 * no readable authentication time is not fresh.
 */
export async function freshSignInOf(deps: Pick<DesignFactsDeps, "documentClient" | "tableName" | "signInTableName" | "now">, caller: { developerId: string; sessionId: string }): Promise<boolean> {
  return (await freshSignInProofOf(deps, caller)) !== undefined;
}

/**
 * The same rule, answering the audit proof of the recent sign-in (when it is recent): when the person signed in (`authTime`, not when they decided) and the SHA-256 of their session's id. A decision that
 * required the sign-in records it, as the confirmation page's decide session did.
 */
export async function freshSignInProofOf(deps: Pick<DesignFactsDeps, "documentClient" | "tableName" | "signInTableName" | "now">, caller: { developerId: string; sessionId: string }): Promise<AuditProof | undefined> {
  try {
    const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.signInTableName, nameTableName: deps.tableName, now: () => deps.now() });
    const session = await store.getSession(caller.sessionId);
    if (session === undefined || session.developerId !== caller.developerId || session.revokedAt !== undefined || session.authTime === undefined || !isFreshSignIn(session, deps.now())) return undefined;
    return { kind: "fresh_sign_in", method: "email_code", authTime: new Date(session.authTime).toISOString(), sessionRef: createHash("sha256").update(caller.sessionId, "utf8").digest("hex") };
  } catch { return undefined; }
}
