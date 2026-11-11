// Lane A: configured monthly BASE settings only, never a usage or admission decision.
import { z } from "zod";
import { OrgIdSchema } from "@rovara-code/contracts";
export const AdminBudgetMicrodollarsSchema = z.number().int().min(0).max(1_000_000_000_000);
const limited = z.object({ kind: z.literal("limited"), microdollars: AdminBudgetMicrodollarsSchema, source: z.enum(["configured", "cloud_default"]) }).strict();
export const AdminMonthlyBaseLimitSchema = z.discriminatedUnion("kind", [limited, z.object({ kind: z.literal("unlimited"), source: z.literal("unset") }).strict()]);
export const AdminBudgetSettingsSchema = z.object({
 orgId: OrgIdSchema,
 checkedAt: z.string().datetime(),
 coverage: z.literal("monthly_base_settings_only"),
 orgMonthly: AdminMonthlyBaseLimitSchema,
 memberDefaultMonthly: AdminMonthlyBaseLimitSchema,
 memberOverrideCount: z.number().int().min(0).max(500),
 memberOverrideCoverage: z.literal("configured_only_membership_not_checked"),
 topUps: z.literal("not_checked"),
 usage: z.literal("not_checked"),
 enforcement: z.literal("not_checked"),
}).strict();
export type AdminBudgetSettings = z.infer<typeof AdminBudgetSettingsSchema>;
