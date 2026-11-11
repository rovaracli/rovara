// Insights: who gave a grant, read from the audit ledger and not from the member record (the record holds no other person's id). The ledger's `insights_access.granted` event, by action, over the
// time range of the grants asked about, through the indexed reader (which re-checks that the reader is a live owner or admin and answers from canonical records only). An event counts for a grant
// only when it names exactly that member as its target AND was made at exactly the time the grant was written (`insightsGrantedAt`), so a later or earlier grant of the same person never lends its
// granter to another. Anything the ledger cannot answer (a page fails, the index is behind, the range holds more than the pages read) leaves the member out of the answer: the list then shows the
// date without a name. Never guessed.
import { AuditIndexedQuerySchema } from "@agentx/cloud-contracts";
import { readIndexedAudit } from "../audit/indexed-reader.js";
import type { AuditExportClientDeps } from "../audit/export.js";
import type { InsightsCaller } from "./scope.js";

/** The grants asked about: the member and the exact time (ISO) the grant was written. Answers member id to the id of the person who gave it, for the grants it could settle. */
export type GrantLookup = (caller: InsightsCaller, grants: ReadonlyArray<{ developerId: string; at: string }>) => Promise<Map<string, string>>;

/** The most pages of 100 events one list reads. */
const PAGES_MAX = 10;
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;

export function ledgerGrantLookup(ledger: AuditExportClientDeps): GrantLookup {
  return async (caller, grants) => {
    const found = new Map<string, string>();
    const orgRole: "owner" | "admin" | undefined = caller.orgRole === "owner" ? "owner" : caller.orgRole === "admin" ? "admin" : undefined;
    if (grants.length === 0 || orgRole === undefined) return found;
    const wanted = new Map(grants.map((grant) => [`${grant.developerId}|${grant.at}`, grant.developerId]));
    const times = grants.map((grant) => Date.parse(grant.at));
    const reader = { orgId: caller.orgId, developerId: caller.developerId, orgRole };
    let cursor: string | undefined;
    for (let page = 0; page < PAGES_MAX; page += 1) {
      const query = AuditIndexedQuerySchema.parse({ filterVersion: "1", action: "insights_access.granted", from: new Date(Math.min(...times)).toISOString(), limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      const answer = await readIndexedAudit(ledger, reader, query);
      for (const { record } of answer.records) {
        if (record.action !== "insights_access.granted" || record.orgId !== caller.orgId || record.target.kind !== "member" || record.actor.kind !== "member" || !DEVELOPER_ID.test(record.actor.id)) continue;
        const grant = wanted.get(`${record.target.id}|${new Date(Date.parse(record.occurredAt)).toISOString()}`);
        if (grant !== undefined) found.set(grant, record.actor.id);
      }
      cursor = answer.nextCursor;
      if (cursor === undefined || found.size === wanted.size) break;
    }
    return found;
  };
}
