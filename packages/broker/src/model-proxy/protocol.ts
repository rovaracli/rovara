// The wire format between ModelAccessInvoker (broker) and the ModelAccessFunction handler (ruling R28).
import { OrgIdSchema, type AgentXErrorCode } from "@agentx/contracts";
import { z } from "zod";

const DeveloperIdSchema = z.string().min(1).max(256);
const BudgetSchema = z.number().finite().min(0).max(1_000_000);
/** A key lives for at most a week; task keys are minted per task or turn. */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export const ModelAccessRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsertOrg"), args: z.object({ orgId: OrgIdSchema, monthlyBudgetUsd: BudgetSchema }).strict() }).strict(),
  z.object({ op: z.literal("upsertMember"), args: z.object({ orgId: OrgIdSchema, developerId: DeveloperIdSchema, monthlyBudgetUsd: BudgetSchema }).strict() }).strict(),
  z.object({ op: z.literal("spend"), args: z.object({ orgId: OrgIdSchema, developerId: DeveloperIdSchema }).strict() }).strict(),
  z.object({
    op: z.literal("mintKey"),
    args: z.object({
      orgId: OrgIdSchema,
      developerId: DeveloperIdSchema,
      purpose: z.enum(["task", "turn"]),
      refId: z.string().min(1).max(256),
      maxBudgetUsd: BudgetSchema,
      ttlSeconds: z.number().int().min(1).max(MAX_TTL_SECONDS),
    }).strict(),
  }).strict(),
  z.object({ op: z.literal("revokeKey"), args: z.object({ key: z.string().min(1).max(512) }).strict() }).strict(),
]);
export type ModelAccessRequest = z.infer<typeof ModelAccessRequestSchema>;

const SpendFiguresSchema = z.object({ spentUsd: z.number().finite(), limitUsd: z.number().finite() }).strict();
export const SpendResultSchema = z.object({ member: SpendFiguresSchema, org: SpendFiguresSchema }).strict();
export const MintedKeyResultSchema = z.object({ key: z.string().min(1), expiresAt: z.number().finite() }).strict();

export type ModelAccessResponse =
  | { ok: true; result: unknown }
  | { ok: false; code: AgentXErrorCode; message: string };
