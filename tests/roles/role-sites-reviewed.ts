// Enterprise foundations, task I2: the role checks that are not a plain owner/admin list, each read for what an Auditor gets there. An entry matches a source
// line of that file that contains `needle`. A line that changes is re-read: the entry goes stale and the test says so.
export interface ReviewedRoleSite { file: string; needle: string; why: string }

const LIFECYCLE = "reviewed-project-archive.ts `authority` is the one authority for archive, restore and working-branch save: an explicit three-way allow (owner, admin, member), so an Auditor is FORBIDDEN before any of these lines run.";
const DEFAULTS = "Defaults a MISSING membership record to member; a record that exists passes its own role through, so an Auditor stays an Auditor, and effectiveProjectRole gives an Auditor no project role.";

export const REVIEWED_ROLE_SITES: readonly ReviewedRoleSite[] = [
  // ---- defaults to member
  { file: "packages/broker/src/agent-sessions/shares.ts", needle: 'orgRole: caller.orgRole ?? "member"', why: "An absent role on a confirmation caller is a member; a present Auditor is passed through unchanged, and the route dispatcher never lets an Auditor reach a share." },
  { file: "packages/broker/src/aws/broker/admin-and-helpers.ts", needle: '?.role ?? "member"', why: DEFAULTS },
  { file: "packages/broker/src/aws/broker/sweeps-and-readiness.ts", needle: '?.role ?? "member"', why: DEFAULTS },
  { file: "packages/broker/src/aws/broker/workflow-e2e-verification.ts", needle: '?.role ?? "member"', why: DEFAULTS },
  { file: "packages/broker/src/aws/broker/workspace-preparation.ts", needle: '?.role ?? "member"', why: DEFAULTS },
  { file: "packages/broker/src/chains/routes.ts", needle: '?? "member"', why: DEFAULTS },
  // ---- the Rovara roles that are not the Auditor's to hold
  { file: "packages/broker/src/aws/developer-routes/organization.ts", needle: 'caller.orgRole === "admin" && target.role !== "member"', why: "An admin may remove members only. An Auditor target is not a member, so an admin cannot remove one; only an owner can (stricter, not looser)." },
  { file: "packages/broker/src/developer/join-page.ts", needle: 'role === "admin" ? "an admin" : "a member"', why: "Words for an invite's role. Invites are admin or member only (the store refuses any other), so the Auditor never reaches this sentence." },
  { file: "packages/broker/src/developer/server.ts", needle: 'org.role === "admin" ? "admin" : "member"', why: "The join page names the role of an INVITE, which is admin or member only; an Auditor is never given by an invite link." },
  { file: "packages/broker/src/org/store.ts", needle: 'input.role !== "admin" && input.role !== "member"', why: "Invite creation allows exactly admin and member and refuses any other role, the Auditor included." },
  // ---- not a Rovara role at all
  { file: "packages/broker/src/github-app.ts", needle: 'record.permission === "admin"', why: "GitHub repository permission and role_name, not a company role." },
  { file: "packages/broker/src/org/github-connection.ts", needle: 'body.role !== "admin"', why: "The person's role in a GitHub organization (GitHub's answer), not a company role." },
  { file: "packages/broker/src/org/github-install-requests.ts", needle: 'approver.role !== "admin"', why: "The approver's role in a GitHub organization (GitHub's answer), not a company role." },
  { file: "packages/broker/src/spend/admission.ts", needle: 'case "member":', why: "A budget scope kind (member, project, org), not a company role." },
  { file: "packages/broker/src/spend/requests.ts", needle: 'case "member": return `Your monthly AI budget', why: "A budget scope kind, not a company role." },
  { file: "packages/broker/src/spend/requests.ts", needle: 'case "member":', why: "A budget scope kind, not a company role." },
  { file: "packages/contracts/src/spend.ts", needle: 'case "member": return `MEMBER#', why: "A budget scope kind, not a company role." },
  // ---- project lifecycle (archive, restore, working branch): one authority with an explicit allow
  { file: "packages/broker/src/org/reviewed-project-archive.ts", needle: 'actor.role !== "owner" && actor.role !== "admin" && actor.role !== "member"', why: "The explicit three-way allow; the Auditor is refused here (FORBIDDEN), before anything else." },
  { file: "packages/broker/src/org/reviewed-project-archive.ts", needle: 'if (actor.role === "member") { const grant', why: LIFECYCLE },
  { file: "packages/broker/src/org/reviewed-project-archive.ts", needle: 'auth.actor.role === "member"', why: LIFECYCLE },
  { file: "packages/broker/src/org/reviewed-project-restore.ts", needle: 'auth.actor.role === "member"', why: LIFECYCLE },
  { file: "packages/broker/src/org/project-working-branch-save.ts", needle: 'auth.actor.role==="member"?read', why: LIFECYCLE },
  { file: "packages/broker/src/org/project-working-branch-save.ts", needle: 'if(auth.actor.role==="member")add("grant"', why: LIFECYCLE },
  // ---- approvals and role changes
  { file: "packages/broker/src/org/role-changes.ts", needle: 'change.role === "member" || change.role === "auditor"', why: "A demotion from owner or admin to member OR Auditor moves the approval-membership generation, so an approval the person made as an admin stops counting." },
  { file: "packages/broker/src/org/store.ts", needle: 'role === "member" || role === "auditor"', why: "The same demotion rule in the store's legacy role change." },
  { file: "packages/broker/src/org/second-person-evidence.ts", needle: 'role === "owner" || role === "admin" || role === "member"', why: "roleValid: exactly the three roles that can be a proposer, an approver or a second person. The Auditor is not one." },
  { file: "packages/broker/src/org/second-person-evidence.ts", needle: 'if (member.role === "member") {', why: "livePerson: the person was already checked with roleValid, so an Auditor has been refused (FORBIDDEN) before this line." },
  { file: "packages/broker/src/org/second-person-evidence.ts", needle: 'row.role !== "owner" && row.role !== "admin" && row.role !== "member") return;', why: "The roster skips every role that cannot be a second person, the Auditor included (tested: an Auditor never counts as eligible)." },
  { file: "packages/broker/src/org/second-person-evidence.ts", needle: 'if (row.role === "member") {', why: "Reached only for the three roles above: a member counts only with a maintainer grant." },
];
