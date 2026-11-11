// Lane A: reviewed creation's historical outcome. Bearer delivery is deliberately separate.
import { z } from "zod";
import { OrgIdSchema } from "@rovara-code/contracts";
/** `sendEmail` (UX1): also email the link to `email`, through the install's existing sign-in notice sender; only with an email destination. */
export const ReviewedInviteCreateBodySchema = z.object({ requestId: z.string().uuid(), role: z.enum(["admin", "member"]), email: z.string().trim().email().max(254).transform(value => value.toLowerCase()).optional(), sendEmail: z.literal(true).optional() }).strict()
  .refine(body => body.sendEmail !== true || body.email !== undefined, { message: "an invite is emailed only to a colleague email", path: ["sendEmail"] });
export const InviteCreateReceiptSchema = z.object({ orgId: OrgIdSchema, requestId: z.string().uuid(), inviteId: z.string().uuid(), role: z.enum(["admin", "member"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime() }).strict();
/** How the emailed copy went (UX1): `sent`; `not_set_up` (this install has no email sender, so the link is copy-only); `failed` (the link still works: copy it); `limited` (the company's daily email cap, or this address was emailed today: copy it). Absent when no email was asked for. */
export const InviteEmailOutcomeSchema = z.enum(["sent", "not_set_up", "failed", "limited"]);
export const ReviewedInviteCreateResponseSchema = z.object({ receipt: InviteCreateReceiptSchema, inviteUrl: z.string().url().optional(), email: InviteEmailOutcomeSchema.optional() });
