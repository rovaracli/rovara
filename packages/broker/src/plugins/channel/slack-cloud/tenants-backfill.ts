// Convergence lane A8 (H2): the one stored-format addition the channel point needs from Cloud's Slack rows, and its reverse. NOT RUN by this lane (owner gate G-DATA).
//
// What moves: nothing. The binding rows Cloud writes today (`ORG#<company>#SLACK_BINDING#<team>`, `CHANNEL#<channel>`, attributes `teamId`/`channelId`/`projectName`/`updatedAt`) are already the keys and attributes Code's
// company-scoped binding functions read (`orgChannelBindingKey`, `readChannelBindingItem`); `tests/unit/cloud-slack-channel-keys.test.ts` pins that, with a second company.
// What is new: Code lists a company's bindings across tenants from one small partition, `ORG#<company>#CHANNEL_TENANTS` (one row per `<channel>/<tenant>`), and it is written when a space is bound through Code's
// `bindChannelSpace`. Cloud's own bind path does not write it. So for the channel point to list the bindings that exist, each (company, workspace) that has a binding needs its row. The forward step puts it
// (only when absent, so it never rewrites a row); the reverse deletes exactly the rows the forward step marked (`backfilledBy`), and nothing else.
import { orgScoped, when, type DocumentStore, type OrgId } from "@rovara-code/contracts";

export const TENANT_BACKFILL_MARK = "a8-slack-tenants";

const BINDING_PK = /^ORG#(org_[0-9a-z]{20})#SLACK_BINDING#(T[A-Z0-9]{2,31})$/u;

type Row = { pk?: unknown; sk?: unknown };

/** Which (company, workspace) pairs hold at least one binding row, from the rows a scan found. Rows that are not bindings, or whose key does not read, are skipped and counted. */
export function tenantsOfBindingRows(rows: Iterable<Row>): { pairs: Array<{ orgId: OrgId; teamId: string }>; skipped: number } {
  const seen = new Map<string, { orgId: OrgId; teamId: string }>();
  let skipped = 0;
  for (const row of rows) {
    const matched = typeof row.pk === "string" && typeof row.sk === "string" && row.sk.startsWith("CHANNEL#") ? BINDING_PK.exec(row.pk) : null;
    if (matched === null) { skipped += 1; continue; }
    seen.set(`${matched[1]!}/${matched[2]!}`, { orgId: matched[1] as OrgId, teamId: matched[2]! });
  }
  return { pairs: [...seen.values()], skipped };
}

export const tenantRowKey = (orgId: OrgId, teamId: string): { pk: string; sk: string } => ({ pk: orgScoped(orgId, "CHANNEL_TENANTS"), sk: `slack/${teamId}` });

export interface BackfillCounts { written: number; alreadyThere: number; skipped: number }

/** Forward: puts the missing tenant row of each pair. Idempotent; a row that is there (from Code's bind, or an earlier run) is left as it is. */
export async function backfillSlackTenants(store: DocumentStore, rows: Iterable<Row>): Promise<BackfillCounts> {
  const { pairs, skipped } = tenantsOfBindingRows(rows);
  const counts: BackfillCounts = { written: 0, alreadyThere: 0, skipped };
  for (const { orgId, teamId } of pairs) {
    const result = await store.put({ item: { ...tenantRowKey(orgId, teamId), entityType: "CHANNEL_TENANT", channel: "slack", tenant: teamId, backfilledBy: TENANT_BACKFILL_MARK }, condition: when.absent() });
    if (result.applied) counts.written += 1; else counts.alreadyThere += 1;
  }
  return counts;
}

/** Reverse: deletes the rows the forward step wrote (marked). A row Code's bind wrote (no mark) is never touched. */
export async function undoBackfillSlackTenants(store: DocumentStore, rows: Iterable<Row>): Promise<{ deleted: number; kept: number }> {
  const { pairs } = tenantsOfBindingRows(rows);
  let deleted = 0;
  let kept = 0;
  for (const { orgId, teamId } of pairs) {
    const result = await store.delete({ key: tenantRowKey(orgId, teamId), condition: when.eq("backfilledBy", TENANT_BACKFILL_MARK) });
    if (result.applied) deleted += 1; else kept += 1;
  }
  return { deleted, kept };
}
