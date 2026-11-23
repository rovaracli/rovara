import { z } from "zod";
const time = z.number().int().nonnegative().max(8_640_000_000_000_000);
const model = z.object({ name: z.string(), id: z.string(), state: z.enum(["ready", "not_enabled", "refused", "not_found", "no_quota", "unavailable"]) });
export const bedrockView = z.object({ revision: z.number().int().nonnegative(), canChange: z.boolean(),
 connection: z.object({ connected: z.boolean(), connectedAt: time, updatedAt: time, refusedAt: time.optional(), roleArn: z.string(), region: z.string(), allowGlobal: z.boolean(), checkedAt: time, models: z.array(model), productModels: z.array(z.object({ id: z.string(), state: z.string() })), notEnabledSteps: z.string().optional(), quotaSteps: z.string().optional() }).nullable(),
 removedUntil: time.nullable(), usage: z.string() });
export type BedrockView = z.infer<typeof bedrockView>;
export const bedrockSetup = z.object({ companyId: z.string(), region: z.string(), externalId: z.string().regex(/^rvb-[0-9a-f]{40}$/u), brokerRoleArn: z.string(), templateUrl: z.string().url(), presets: z.record(z.string(), z.string()) });
export const bedrockCommand = z.object({ companyId: z.string(), command: z.string(), cloudShellUrl: z.string().url(), stackName: z.string() });
