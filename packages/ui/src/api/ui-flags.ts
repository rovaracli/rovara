// Runtime per-company UI flags (lane U5). The admin calls of Settings > New screens, and the names the flag store reads.
// Every write is sent once from the browser session: a refusal is thrown as an `ApiError` for the screen to show and is never repeated here.
import { z } from "zod";
import { createApiClient } from "./client.js";
import type { AppHost } from "../host.js";

// ---- LOCAL SCHEMAS: replace with the contract. ------------------------------------------------------------------------------------------------------------------------------------------
// These match docs `briefs/ui-flags-api.md` exactly. The server lane's `packages/contracts/src/ui-flags.ts` (exported from `@agentx/contracts/web`) owns the real ones
// (UI_FLAG_NAMES, UiFlagStateSchema, UiFlagsMapSchema, UiFlagsAdminAnswerReaderSchema, UiFlagsBodySchema). When that file is on the branch, delete this block and import those names here.
export const UI_FLAG_NAMES = ["look", "nav", "home", "work", "spending", "leadingHeader", "health", "setup", "insights", "publish", "billing", "agreement"] as const;
export type UiFlagName = (typeof UI_FLAG_NAMES)[number];
export const UiFlagStateSchema = z.enum(["on", "preview", "off"]);
export type UiFlagState = z.infer<typeof UiFlagStateSchema>;
/** One flag as the admin screen reads it. Unknown fields and a flag name this version does not know are tolerated (a newer server). */
const UiFlagAdminRowSchema = z.looseObject({ name: z.string(), label: z.string().max(80), summary: z.string().max(240), wired: z.boolean(), enabled: z.boolean(), forcedOff: z.boolean(), state: UiFlagStateSchema.catch("off") });
export const UiFlagsAdminAnswerReaderSchema = z.looseObject({ revision: z.number().int().min(0), previews: z.boolean(), flags: z.array(UiFlagAdminRowSchema).max(64), changedAt: z.string().optional() });
export type UiFlagsAdminAnswer = z.infer<typeof UiFlagsAdminAnswerReaderSchema>;
export type UiFlagAdminRow = UiFlagsAdminAnswer["flags"][number];
export interface UiFlagsBody { expectedRevision: number; flags?: Partial<Record<UiFlagName, boolean>>; previews?: boolean }
// ---- END LOCAL SCHEMAS -------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const UI_FLAGS_PATH = "/v1/app/org/ui-flags";
const NEVER = { retry: "never" } as const;

export function createUiFlagsApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  read: (): Promise<UiFlagsAdminAnswer> => api.get(UI_FLAGS_PATH, UiFlagsAdminAnswerReaderSchema),
  change: async (body: UiFlagsBody): Promise<UiFlagsAdminAnswer> => { const sent = await api.send("PUT", UI_FLAGS_PATH, body, UiFlagsAdminAnswerReaderSchema, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); return sent.value; },
 };
}
