// Collaborator project role (W11, A-23/A-26, experience decisions 14 and 36, owner answer Q8): Cloud's project roles are maintainer, contributor, COLLABORATOR and viewer. A collaborator (a PM, a designer,
// support) reads the project's work like a viewer, answers the questions a task raises and may approve a LOW-risk PRODUCT decision while the project allows it (`approvalPlaceDecision`, approval-place.ts);
// a collaborator never starts coding work, approves a plan or code, merges, changes settings or sees spend.
//
// UPSTREAM OWED (owed-upstream.json, app-projects/project-roles entry): Rovara Code's `ProjectRoleSchema` (vendor/rovara-code/packages/contracts/src/app-projects.ts) is maintainer, contributor, viewer, and
// the vendor copy is read-only, so this file SHADOWS the names below until a Code lane adds `collaborator` and the pin moves past it:
//   ProjectRoleSchema, ProjectRole, ProjectPermission, PROJECT_PERMISSIONS, projectAllows                                  the role and the permission table, with the collaborator row and two new permissions
//   ProjectMemberSchema, ProjectMember, ProjectMembersResponseSchema, ProjectMembersResponse,                              the people routes, which must name a collaborator
//   PutProjectMemberBodySchema, PutProjectMemberBody, ProjectMemberChangeResponseSchema, ProjectMemberChangeResponse
//
// How the shadow stays safe while the rest of Cloud still speaks Code's three roles (the "floor"): every place that is not about collaborators keeps Code's `ProjectRole` and is handed the collaborator's
// FLOOR, `viewer` (`projectRoleFloor`). The collaborator row of the table below gives exactly the viewer's answer for every one of Code's permissions (tests/contract/collaborator-role.test.ts proves it for
// each), so the floor can never let a collaborator do more than a viewer anywhere the new code does not look. What a collaborator may do beyond a viewer is asked ONLY through the two new permissions.
// A response field the app already reads (`myRole`, a member's `role`) stays the three-valued role there, with the collaborator's floor; the exact role is in an additive field (`myProjectRole`,
// `projectRole`), so today's pages keep parsing and show a collaborator what a viewer is shown until the UI lane reads the new field.
//
// Browser-safe: zod and Code's contracts only.
import { z } from "zod";
import { PROJECT_PERMISSIONS as CODE_PROJECT_PERMISSIONS, ProjectMemberSourceSchema, ProjectRoleSchema as CodeProjectRoleSchema, type ProjectPermission as CodeProjectPermission, type ProjectRole as CodeProjectRole } from "@rovara-code/contracts";

export const ProjectRoleSchema = z.enum(["maintainer", "contributor", "collaborator", "viewer"]);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

/**
 * Code's permissions, plus two that only Cloud's roles ask:
 *   answer_questions             answer a question a task raised for people (a product decision's question). Not a decision: it settles nothing.
 *   approve_product_decisions    approve a PRODUCT decision (wording, a UX option, a scope question). The role may; the decision's own rule (`approvalPlaceDecision`) still decides by risk and the project's
 *                                switch: a collaborator only a LOW one while `collaboratorApprovals` is on. A task's owner decides their own task's product decisions as its owner, not through this permission.
 *   comment                      comment on a task's session and page (decision 103). The roles that could already comment there (a maintainer, a contributor) and a collaborator; never a viewer.
 *   ask                          use the live Ask about a task it can view (decisions 103 and 104), with its rates and its charge to the company's spend like anyone's: a maintainer, a contributor and a
 *                                collaborator. It opens the Ask only, never steering or any other `use` action.
 * None of these ever counts toward a code review, a merge rule or CODEOWNERS: those read the code host's reviews only.
 */
export type ProjectPermission = CodeProjectPermission | "answer_questions" | "approve_product_decisions" | "comment" | "ask";

export const PROJECT_PERMISSIONS: Record<ProjectRole, ReadonlyArray<ProjectPermission>> = {
  maintainer: [...CODE_PROJECT_PERMISSIONS.maintainer, "answer_questions", "approve_product_decisions", "comment", "ask"],
  // Decision 104: a contributor also uses the live Ask on a task it can view.
  contributor: [...CODE_PROJECT_PERMISSIONS.contributor, "answer_questions", "comment", "ask"],
  // A viewer's own permissions, and the two new ones. Never `start_tasks` (owner answer Q8: ask, answer, approve low-risk product decisions; the conservative reading of decision 14's "can start work").
  // Decision 103: a collaborator also comments and uses the live Ask (charged and capped like anyone's).
  collaborator: [...CODE_PROJECT_PERMISSIONS.viewer, "answer_questions", "approve_product_decisions", "comment", "ask"],
  viewer: [...CODE_PROJECT_PERMISSIONS.viewer],
};

export function projectAllows(role: ProjectRole, action: ProjectPermission): boolean {
  return PROJECT_PERMISSIONS[role].includes(action);
}

/** The three-valued role Code's contracts and every place that is not about collaborators understand: a collaborator's floor is a viewer (it may do nothing there a viewer may not). */
export function projectRoleFloor(role: ProjectRole): CodeProjectRole {
  return role === "collaborator" ? "viewer" : role;
}

/** The order the people list shows roles in. */
export const PROJECT_ROLE_ORDER: Record<ProjectRole, number> = { maintainer: 0, contributor: 1, collaborator: 2, viewer: 3 };

/** One person in a project, as `GET /v1/app/projects/{name}/members` lists them. `role` is the floor (Code's three roles, what today's pages read); `projectRole` the exact role. */
export const ProjectMemberSchema = z.object({
  developerId: z.string(),
  name: z.string(),
  email: z.string().optional(),
  role: CodeProjectRoleSchema,
  projectRole: ProjectRoleSchema.optional(),
  source: ProjectMemberSourceSchema,
  grantedBy: z.object({ developerId: z.string(), name: z.string() }).optional(),
});
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const ProjectMembersResponseSchema = z.object({ members: z.array(ProjectMemberSchema) });
export type ProjectMembersResponse = z.infer<typeof ProjectMembersResponseSchema>;

/** `PUT /v1/app/projects/{name}/members/{developerId}`: a maintainer gives a member of the org a role in the project, a collaborator among them. */
export const PutProjectMemberBodySchema = z.object({ requestId: z.string().uuid(), role: ProjectRoleSchema }).strict();
export type PutProjectMemberBody = z.infer<typeof PutProjectMemberBodySchema>;
export const ProjectMemberChangeResponseSchema = z.object({ member: z.object({ developerId: z.string(), role: CodeProjectRoleSchema, projectRole: ProjectRoleSchema.optional() }) });
export type ProjectMemberChangeResponse = z.infer<typeof ProjectMemberChangeResponseSchema>;
