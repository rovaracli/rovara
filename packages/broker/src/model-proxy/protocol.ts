// The wire format between ModelAccessInvoker (broker) and the ModelAccessFunction handler (ruling R28).
import { ModelSourceSchema, OrgIdSchema, type AgentXErrorCode } from "@agentx/contracts";
import { z } from "zod";

const DeveloperIdSchema = z.string().min(1).max(256);
const BudgetSchema = z.number().finite().min(0).max(1_000_000);
/** LiteLLM's token id for a key: the lowercase hex SHA-256 of it. */
const KeyIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);
/** A task re-mints about once an hour of work; a week-long task is under 200 keys. */
const MAX_KEY_IDS = 500;
/** A key lives for at most a week; task keys are minted per task or turn. */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A source id as the store generates it (`src_` and 20 characters). */
const SourceIdSchema = z.string().regex(/^src_[0-9a-z]{20}$/u);
const TagValueSchema = z.string().min(1).max(256);
const MintTagsSchema = z.object({
  taskId: TagValueSchema.optional(),
  operationId: TagValueSchema.optional(),
  stepId: TagValueSchema.optional(),
  agentId: TagValueSchema,
  chainId: TagValueSchema.optional(),
  chainRunId: TagValueSchema.optional(),
  project: TagValueSchema.optional(),
  payerKind: z.enum(["member", "project", "agent", "chain"]),
  payerId: TagValueSchema,
  source: TagValueSchema,
  origin: TagValueSchema,
}).strict();
/** One key never needs more models than an org can have sources times their models, and a handful is the norm. */
const MAX_KEY_MODELS = 50;

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
      models: z.array(z.string().min(1).max(512)).min(1).max(MAX_KEY_MODELS).optional(),
      tags: MintTagsSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    op: z.literal("upsertSource"),
    args: z.object({ orgId: OrgIdSchema, source: ModelSourceSchema, apiKey: z.string().min(1).max(4096).optional() }).strict(),
  }).strict(),
  z.object({ op: z.literal("removeSource"), args: z.object({ orgId: OrgIdSchema, sourceId: SourceIdSchema }).strict() }).strict(),
  z.object({ op: z.literal("listSources"), args: z.object({}).strict() }).strict(),
  z.object({ op: z.literal("checkEndpoint"), args: z.object({ url: z.string().min(1).max(2048) }).strict() }).strict(),
  z.object({ op: z.literal("checkSource"), args: z.object({ orgId: OrgIdSchema, sourceId: SourceIdSchema }).strict() }).strict(),
  z.object({ op: z.literal("auditKeys"), args: z.object({ budgetMs: z.number().int().min(1).max(60_000).optional() }).strict() }).strict(),
  z.object({ op: z.literal("revokeKey"), args: z.object({ key: z.string().min(1).max(512) }).strict() }).strict(),
  z.object({ op: z.literal("blockKey"), args: z.object({ keyId: KeyIdSchema }).strict() }).strict(),
]);
export type ModelAccessRequest = z.infer<typeof ModelAccessRequestSchema>;

export const SpendFiguresSchema = z.object({ spentUsd: z.number().finite(), limitUsd: z.number().finite() }).strict();
export const SpendResultSchema = z.object({ member: SpendFiguresSchema, org: SpendFiguresSchema }).strict();
export const KeySpendResultSchema = z.number().finite().min(0);
export const SourceCheckResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), health: z.enum(["healthy", "unknown"]) }).strict(),
  z.object({ ok: z.literal(false), message: z.string().max(500) }).strict(),
]);
/** Every registered source, at most as many as a thousand orgs of ten sources hold. */
export const RegisteredSourcesResultSchema = z.array(z.object({ orgId: OrgIdSchema, sourceId: SourceIdSchema, hosts: z.array(z.string().min(1).max(253)).max(20).optional() }).strict()).max(10_000);
export const KeyAuditResultSchema = z.object({ checked: z.number().int().min(0), blocked: z.number().int().min(0), truncated: z.boolean() }).strict();
export const MintedKeyResultSchema = z.object({ key: z.string().min(1), expiresAt: z.number().finite() }).strict();

export type ModelAccessResponse =
  | { ok: true; result: unknown }
  | { ok: false; code: AgentXErrorCode; message: string };
