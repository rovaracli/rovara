import { SessionIdSchema, SessionLogEntryReadSchema, SessionLogResponseReaderSchema, type SessionLogResponse } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";

/**
 * The session page's "Decisions and answers" (L4-B5): the questions, answers and decisions of the session's task, read from Rovara Code's task log by Cloud as the signed-in person.
 * An entry of a kind or in a shape this page does not know (a newer Cloud) is left out here, so everything past this point holds strict entries.
 */
export function createSessionLogApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  read: async (id: string): Promise<SessionLogResponse> => {
   const raw = await api.get("/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id)) + "/log", SessionLogResponseReaderSchema);
   return { entries: raw.entries.flatMap(entry => { const strict = SessionLogEntryReadSchema.safeParse(entry); return strict.success ? [strict.data] : []; }) };
  },
 };
}
