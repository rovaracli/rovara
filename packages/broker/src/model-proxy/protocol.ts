// The wire format between ModelAccessInvoker (broker) and the ModelAccessFunction handler (ruling R28).
import { OrgIdSchema, type AgentXErrorCode } from "@agentx/contracts";
import { z } from "zod";

const DeveloperIdSchema = z.string().min(1).max(256);
const BudgetSchema = z.number().finite().min(0).max(1_000_000);
/** LiteLLM's token id for a key: the lowercase hex SHA-256 of it. */
const KeyIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);
/** A task re-mints about once an hour of work; a week-long task is under 200 keys. */
const MAX_KEY_IDS = 500;
/** A key lives for at most a week; task keys are minted per task or turn. */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export const ModelAccessRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsertOrg"), args: z.object({ orgId: OrgIdSchema, monthlyBudgetUsd: BudgetSchema }).strict() }).strict(),
  z.object({ op: z.literal("upsertMember"), args: z.object({ orgId: OrgIdSchema, developerId: DeveloperIdSchema, monthlyBudgetUsd: BudgetSchema }).strict() }).strict(),
  z.object({ op: z.literal("spend"), args: z.object({ orgId: OrgIdSchema, developerId: DeveloperIdSchema }).strict() }).strict(),
  z.object({ op: z.literal("orgSpend"), args: z.object({ orgId: OrgIdSchema }).strict() }).strict(),
  z.object({ op: z.literal("keySpend"), args: z.object({ keyIds: z.array(KeyIdSchema).max(MAX_KEY_IDS) }).strict() }).strict(),
  z.object({
    op: z.literal("mintKey"),
    args: z.object({
      orgId: OrgIdSchema,
      developerId: DeveloperIdSchema.optional(),
      purpose: z.enum(["task", "turn"]),
      refId: z.string().min(1).max(256),
      maxBudgetUsd: BudgetSchema,
      ttlSeconds: z.number().int().min(1).max(MAX_TTL_SECONDS),
    }).strict(),
  }).strict(),
  z.object({ op: z.literal("revokeKey"), args: z.object({ key: z.string().min(1).max(512) }).strict() }).strict(),
]);
export type ModelAccessRequest = z.infer<typeof ModelAccessRequestSchema>;

export const SpendFiguresSchema = z.object({ spentUsd: z.number().finite(), limitUsd: z.number().finite() }).strict();
export const SpendResultSchema = z.object({ member: SpendFiguresSchema, org: SpendFiguresSchema }).strict();
export const KeySpendResultSchema = z.number().finite().min(0);
export const MintedKeyResultSchema = z.object({ key: z.string().min(1), expiresAt: z.number().finite() }).strict();

export type ModelAccessResponse =
  | { ok: true; result: unknown }
  | { ok: false; code: AgentXErrorCode; message: string };
