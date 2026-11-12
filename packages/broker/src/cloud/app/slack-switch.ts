// Convergence S0: what must hold before Cloud's Slack moves onto Code's channel point (A8's CloudSlackChannel). DEFERRED A8-SLACK-CHANNEL-SWITCH-ON and
// A8-SWITCH-ON-REFUSAL-WORDS.
//
//  - The ORG#<org>#CHANNEL_TENANTS rows exist for every bound Slack team: the backfill (a data move, migrations/plugins) has run to zero, or Cloud's bind
//    writes the row itself. `slackSwitchReadiness` refuses while a dry run would still move rows.
//  - A person Cloud refuses keeps today's words. The core's channel sink answers an unlinked person with a channel link code, which Cloud cannot redeem.
//    `slackRefusalReply` maps the core's refusal to the reply Cloud sends today, and never lets a link code through.
import { SLACK_NOT_A_MEMBER_NOTICE } from "@agentx/cloud-contracts";
import { REMOVED_FROM_ORG_MESSAGE } from "../../org/sign-in.js";

/** Why the core's channel sink would not act for a Slack person. `unlinked`: no developer for the Slack account. */
export type SlackRefusal = "unlinked" | "not_a_member" | "banned" | "removed";

export interface SlackReply {
  code: "SLACK_ACCOUNT_NOT_LINKED" | "REMOVED_FROM_ORG";
  text: string;
}

/** Cloud's reply to a refused Slack person: exactly what Cloud's own path answers today. Never a channel link code. */
export function slackRefusalReply(refusal: SlackRefusal): SlackReply {
  switch (refusal) {
    case "unlinked":
    case "not_a_member":
      return { code: "SLACK_ACCOUNT_NOT_LINKED", text: SLACK_NOT_A_MEMBER_NOTICE };
    case "banned":
    case "removed":
      return { code: "REMOVED_FROM_ORG", text: REMOVED_FROM_ORG_MESSAGE };
  }
}

/** True for a text the core would send that holds a channel link code (Code's `rovara link <code>` offer). Cloud drops such a reply. */
export function holdsChannelLinkCode(text: string): boolean {
  return /\blink code\b|\brovara link\b/i.test(text);
}

export interface SlackSwitchFacts {
  /** What a dry run of the CHANNEL_TENANTS backfill would still move (0: done). */
  tenantsBackfillPending: number;
  /** Cloud's bind writes the CHANNEL_TENANTS row itself (then the backfill only covers old bindings). */
  bindWritesTenants: boolean;
  /** The inbound queue is wired into the sink (sink.message / sink.decision). */
  inboundWired: boolean;
}

export function slackSwitchReadiness(facts: SlackSwitchFacts): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (facts.tenantsBackfillPending > 0) blockers.push(`the CHANNEL_TENANTS backfill would still move ${facts.tenantsBackfillPending} rows`);
  if (!facts.bindWritesTenants) blockers.push("Cloud's Slack bind does not write the CHANNEL_TENANTS row yet");
  if (!facts.inboundWired) blockers.push("inboundFromQueuedSlackRequest is not wired into the channel sink");
  return { ready: blockers.length === 0, blockers };
}
