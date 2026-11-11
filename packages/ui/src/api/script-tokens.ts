// Script tokens (UX5b): the settings calls. Every write is sent once from the browser session (never retried here): a made token is shown once, so a repeat would only be refused.
import { CreatedScriptTokenReaderSchema, RevokedScriptTokenReaderSchema, ScriptTokenListReaderSchema, type ScriptTokenPermission } from "@agentx/cloud-contracts/web";
import { createApiClient } from "./client.js";
import type { AppHost } from "../host.js";

export const SCRIPT_TOKENS_PATH = "/v1/app/script-tokens";
export type ScriptTokenRow = ReturnType<typeof ScriptTokenListReaderSchema.parse>["tokens"][number];
export interface NewScriptToken { name: string; projects: string[]; permissions: ScriptTokenPermission[]; days: number }
const NEVER = { retry: "never" } as const;

export function createScriptTokensApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  list: () => api.get(SCRIPT_TOKENS_PATH, ScriptTokenListReaderSchema),
  create: async (input: NewScriptToken) => { const sent = await api.send("POST", SCRIPT_TOKENS_PATH, { requestId: crypto.randomUUID(), ...input }, CreatedScriptTokenReaderSchema, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); return sent.value; },
  revoke: async (tokenId: string) => { const sent = await api.send("DELETE", `${SCRIPT_TOKENS_PATH}/${encodeURIComponent(tokenId)}`, undefined, RevokedScriptTokenReaderSchema, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); return sent.value; },
 };
}
