// Convergence S0 WIRING (decision 129 pattern): the CHANNEL_TENANTS backfill of lane A8 (plugins/channel/slack-cloud/tenants-backfill.ts) as a data move, so it has a
// dry run, a resume file, a conflict report and a reverse like every other move, and so `slackSwitchReadiness` can ask a dry run how many rows it would still write.
//
// What moves: nothing is rewritten. Code lists a company's bindings across workspaces from one small partition, `ORG#<company>#CHANNEL_TENANTS` (one row per
// `slack/<team>`), which Cloud's own bind never wrote. The forward step puts the missing row for each (company, workspace) that holds a binding row (only when absent: a
// row Code's bind or an earlier run wrote is never touched; a workspace with several bound channels is one write, the later bindings find the row there). A dry run does not write, so it
// counts a missing workspace once per binding row: an upper bound, zero exactly when nothing is left to do. The reverse deletes exactly the rows the forward step marked (`backfilledBy`), conditional on the mark.
import { when, type StoredDocument } from "@rovara-code/contracts";
import type { DataMove, MoveContext, MovePage, MovePlan } from "../framework.js";
import { TENANT_BACKFILL_MARK, markedTenantRows, tenantRowKey, tenantsOfBindingRows } from "../../../plugins/channel/slack-cloud/tenants-backfill.js";

export interface ChannelTenantsOptions {
  /** Pages over the binding rows (`pk` `ORG#<company>#SLACK_BINDING#<team>`, `sk` `CHANNEL#<channel>`). */
  scanBindings: (context: MoveContext, cursor: string | undefined) => Promise<MovePage>;
  /** Pages over the tenant rows the forward step marked (items that hold `backfilledBy`). */
  scanMarked: (context: MoveContext, cursor: string | undefined) => Promise<MovePage>;
}

export const CHANNEL_TENANTS_MOVE_ID = "a8-channel-tenants";

export function channelTenantsBackfill(options: ChannelTenantsOptions): DataMove {
  return {
    id: CHANNEL_TENANTS_MOVE_ID,
    title: "CHANNEL_TENANTS rows for every bound Slack workspace (A8)",
    status: "ready",
    source: { forward: options.scanBindings, reverse: options.scanMarked },
    async plan(item: StoredDocument, direction, context: MoveContext): Promise<MovePlan> {
      if (direction === "reverse") {
        const [row] = markedTenantRows([item]);
        if (row === undefined) return { kind: "skip", reason: "not a row this move wrote" };
        return { kind: "write", steps: [{ kind: "delete", key: tenantRowKey(row.orgId, row.teamId), condition: when.eq("backfilledBy", TENANT_BACKFILL_MARK) }] };
      }
      const { pairs } = tenantsOfBindingRows([item]);
      const pair = pairs[0];
      if (pair === undefined) return { kind: "skip", reason: "not a binding row" };
      const key = `${pair.orgId}/${pair.teamId}`;
      if ((await context.store.get(tenantRowKey(pair.orgId, pair.teamId))) !== undefined) return { kind: "skip", reason: "the tenant row is there" };
      return { kind: "write", steps: [{ kind: "put", item: { ...tenantRowKey(pair.orgId, pair.teamId), entityType: "CHANNEL_TENANT", channel: "slack", tenant: pair.teamId, backfilledBy: TENANT_BACKFILL_MARK }, condition: when.absent() }], note: key };
    },
  };
}
