// Insights: the id a stuck-work row carries when the reader could NOT open the work. A metadata row must not hand out the session id or the spending request id (a session id is the key to its page,
// events and links on every other surface), so it carries an OPAQUE id: a keyed hash (HMAC-SHA256) of the company and the raw id, under a key derived from the install's own server secret (the same secret the
// session list cursor is sealed with, derived under its own label so no other use of it can recompute an id). It is stable (the same work reads the same on every request, for paging and for the screen's
// own bookkeeping), different in every company, and cannot be reversed or looked up in a table of ids without the key. Nothing builds a link from it. A row the reader can open carries the raw id.
import { createHmac } from "node:crypto";
import { agentXError, type OrgId } from "@rovara-code/contracts";

export const INSIGHTS_OPAQUE_PREFIX = "itm_";

/** The key the opaque ids are made with, derived from the install secret under its own label. Undefined or empty secret: refused (a list that cannot make opaque ids does not start). */
export function insightsRowKeyOf(serverSecret: string | undefined): string {
  if (serverSecret === undefined || serverSecret === "") throw agentXError("RUNTIME_UNAVAILABLE", "Stuck work can't be listed right now.");
  return createHmac("sha256", serverSecret).update("agentx:insights-row-id:v1").digest("hex");
}

/** The opaque id of one piece of work in one company: `itm_` and 32 hex digits. */
export const opaqueRowId = (rowKey: string, orgId: OrgId, rawId: string): string => `${INSIGHTS_OPAQUE_PREFIX}${createHmac("sha256", rowKey).update(`${orgId}\0${rawId}`, "utf8").digest("hex").slice(0, 32)}`;
