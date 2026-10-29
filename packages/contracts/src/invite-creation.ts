// Lane A: reviewed creation's historical outcome. Bearer delivery is deliberately separate.
import { z } from "zod";
import { OrgIdSchema } from "./org.js";
export const ReviewedInviteCreateBodySchema = z.object({ requestId: z.string().uuid(), role: z.enum(["admin", "member"]), email: z.string().trim().email().max(254).transform(value => value.toLowerCase()).optional() }).strict();
export const InviteCreateReceiptSchema = z.object({ orgId: OrgIdSchema, requestId: z.string().uuid(), inviteId: z.string().uuid(), role: z.enum(["admin", "member"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime() }).strict();
export const ReviewedInviteCreateResponseSchema = z.object({ receipt: InviteCreateReceiptSchema, inviteUrl: z.string().url().optional() });
