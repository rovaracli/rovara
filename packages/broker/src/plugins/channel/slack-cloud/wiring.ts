// Convergence lane A8 (H1): the Slack channel adapter's sink and its registration. Nothing here is called by a live path.
//
//   companyOf   the company a Slack workspace is bound to (`SLACK_TEAM#<team>`, the broker's own read: `OrgStore.orgForSlackTeam`). An unbound workspace is nobody's, so the sink runs nothing (today: `slack_team_not_bound`, ignored).
//   personOf    the SAME rule today's Slack routes use, `slackRequesterStanding` (0.5.14, switch `sm`): the explicit, current member of THIS company, merged ids followed, a removed or banned person refused, a Slack account
//               of another company refused, and nobody who is merely in the bound workspace. The rule is passed in as `standingOf` and answers the person's id, or throws; a throw (or an id of another shape) is "nobody", so the
//               sink tells the account how to link instead. Channel membership is never a reason to answer.
//   bindings    read from the company-scoped binding keys (`ORG#<company>#SLACK_BINDING#<team>`/`CHANNEL#<channel>`), which are the rows Cloud writes today.
import { createChannelSink, type ChannelWork } from "@rovara-code/broker/core/channel";
import type { createAdapterRegistry } from "@rovara-code/broker/ports";
import { inboundFromSlackRequest, type ActorRef, type ChannelInboundSink, type DocumentStore, type InboundMessage, type OrgId, type SlackRequestMessage } from "@rovara-code/contracts";
import { CloudSlackChannel, type CloudSlackOptions } from "./adapter.js";

type Registry = Pick<ReturnType<typeof createAdapterRegistry>, "register">;

export interface CloudSlackSinkDeps {
  adapter: CloudSlackChannel;
  store: DocumentStore;
  now: () => number;
  work: ChannelWork;
  /** `OrgStore.orgForSlackTeam`. */
  orgOfTeam: (teamId: string) => Promise<OrgId | undefined>;
  /** `slackRequesterStanding` reduced to the person it names: the survivor's developer id, or a throw for anyone it refuses. */
  standingOf: (orgId: OrgId, slackUserId: string) => Promise<string>;
  linkWords: (code: string) => string;
  log?: (entry: Record<string, unknown>) => void;
}

const DEVELOPER_ID = /^[a-f0-9]{64}$/u;

export function createCloudSlackSink(deps: CloudSlackSinkDeps): ChannelInboundSink {
  return createChannelSink({
    channel: "slack",
    adapter: deps.adapter,
    store: deps.store,
    // Never used: `companyOf` answers for every workspace, and an unbound one is nobody's.
    orgId: "org_00000000000000000000",
    companyOf: async ({ tenant }) => deps.orgOfTeam(tenant).catch(() => undefined),
    personOf: async (orgId: OrgId, actor: ActorRef) => {
      try {
        const id = await deps.standingOf(orgId, actor.userId);
        return DEVELOPER_ID.test(id) ? id : undefined;
      } catch {
        return undefined;
      }
    },
    now: deps.now,
    work: deps.work,
    linkWords: deps.linkWords,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });
}

/** What today's ingress hands its request queue, as the sink takes it. */
export const inboundFromQueuedSlackRequest = (message: SlackRequestMessage): InboundMessage => inboundFromSlackRequest(message);

/** Registers the adapter at the channel point under the name `slack`. Nothing starts: no live path is switched. */
export function registerCloudSlackChannel(registry: Registry, options: CloudSlackOptions): CloudSlackChannel {
  const adapter = new CloudSlackChannel(options);
  registry.register("channel", "slack", adapter);
  return adapter;
}
