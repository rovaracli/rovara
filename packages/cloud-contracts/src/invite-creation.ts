// Lane A: reviewed creation's historical outcome. Bearer delivery is deliberately separate.
import { z } from "zod";
import { AgentXNameSchema, OrgIdSchema } from "@rovara-code/contracts";
/**
 * The project roles an invite may carry: the same three as Code's `ProjectRoleSchema` (held equal by tests/contract/invite-project-roles.test.ts). Spelled out here so the
 * browser's invite and member screens, which load at start-up through `developer-web.ts`, do not pull Code's whole app-projects module into the initial bundle.
 */
export const InviteProjectRoleSchema = z.enum(["maintainer", "contributor", "viewer"]);
/**
 * A-31 (srv/project-people): the project an invite also adds the person to, and their role in it. An owner or admin may name any active project of the company and any project role;
 * a maintainer of the project (a company member) may name only that project, only `contributor` or `viewer`, and only on a `member` invite. An admin invite names no project (an admin
 * already maintains every project). On accept the person joins the company and the project together; an invite whose project was archived or removed since joins the company only.
 */
export const InviteProjectSchema = z.object({ name: AgentXNameSchema, role: InviteProjectRoleSchema }).strict();
export type InviteProject = z.infer<typeof InviteProjectSchema>;
/** Why an accepted invite added no project membership (the person still joined the company): the project was archived, or is no longer there. */
export const InviteProjectNoteSchema = z.enum(["project_archived", "project_gone"]);
export type InviteProjectNote = z.infer<typeof InviteProjectNoteSchema>;
export const INVITE_PROJECT_ROLES_FOR_MAINTAINERS = ["contributor", "viewer"] as const;
/** `sendEmail` (UX1): also email the link to `email`, through the install's existing sign-in notice sender; only with an email destination. */
export const ReviewedInviteCreateBodySchema = z.object({ requestId: z.string().uuid(), role: z.enum(["admin", "member"]), email: z.string().trim().email().max(254).transform(value => value.toLowerCase()).optional(), sendEmail: z.literal(true).optional(), project: InviteProjectSchema.optional() }).strict()
  .refine(body => body.sendEmail !== true || body.email !== undefined, { message: "an invite is emailed only to a colleague email", path: ["sendEmail"] })
  .refine(body => body.project === undefined || body.role === "member", { message: "an admin already maintains every project, so an admin invite names no project", path: ["project"] });
export const InviteCreateReceiptSchema = z.object({ orgId: OrgIdSchema, requestId: z.string().uuid(), inviteId: z.string().uuid(), role: z.enum(["admin", "member"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), project: InviteProjectSchema.optional() }).strict();
/** How the emailed copy went (UX1): `sent`; `not_set_up` (this install has no email sender, so the link is copy-only); `failed` (the link still works: copy it); `limited` (the company's daily email cap, or this address was emailed today: copy it). Absent when no email was asked for. */
export const InviteEmailOutcomeSchema = z.enum(["sent", "not_set_up", "failed", "limited"]);
export const ReviewedInviteCreateResponseSchema = z.object({ receipt: InviteCreateReceiptSchema, inviteUrl: z.string().url().optional(), email: InviteEmailOutcomeSchema.optional() });
