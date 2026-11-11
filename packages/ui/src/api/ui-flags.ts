// Runtime per-company UI flags (lane U5). The admin calls of Settings > New screens, and the names the flag store reads.
// Every write is sent once from the browser session: a refusal is thrown as an `ApiError` for the screen to show and is never repeated here.
import type { z } from "zod";
import { UiFlagsAdminAnswerReaderSchema, type UiFlagsBody } from "@agentx/cloud-contracts/web";
import { createApiClient } from "./client.js";
import type { AppHost } from "../host.js";

// The shapes and the names are the server's contract (`packages/cloud-contracts/src/ui-flags.ts`); they are re-exported here so the flag store, the screen and the tests keep one import path.
// The admin answer's readers ignore unknown fields (a newer server); `forcedOff` on a row says the install's operator holds the flag off.
export { UI_FLAG_NAMES } from "@agentx/cloud-contracts/web";
export type { UiFlagName, UiFlagState, UiFlagsBody } from "@agentx/cloud-contracts/web";
/** What the READER returns: a flag name or state a newer server adds reads as `unknown` (the screen hides the row of an unknown name and shows an unknown state as Off). */
export type UiFlagsAdminAnswer = z.output<typeof UiFlagsAdminAnswerReaderSchema>;
export type UiFlagAdminRow = UiFlagsAdminAnswer["flags"][number];

export const UI_FLAGS_PATH = "/v1/app/org/ui-flags";
const NEVER = { retry: "never" } as const;

export function createUiFlagsApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  read: (): Promise<UiFlagsAdminAnswer> => api.get(UI_FLAGS_PATH, UiFlagsAdminAnswerReaderSchema),
  change: async (body: UiFlagsBody): Promise<UiFlagsAdminAnswer> => { const sent = await api.send("PUT", UI_FLAGS_PATH, body, UiFlagsAdminAnswerReaderSchema, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); return sent.value; },
 };
}
