// Slack on the core's channel point (area 20): lane A8's CloudSlackChannel and createCloudSlackSink, wired here the way the S0 root still has to wire them
// (the product root owes all three; this file is the test-side stand-in):
//   (1) inboundFromQueuedSlackRequest: the message today's ingress queues becomes the sink's InboundMessage;
//   (2) a ChannelWork for Cloud: a message starts a task on the core and records the task's thread; a decision goes through the core's decision gate with
//       the chat credential (Code's own is local/app/chat.ts, inside the unexported local composition, S0-Q1); here it mirrors that file;
//   (3) the CHANNEL_TENANTS row, written by A8's own backfill (backfillSlackTenants) over the Cloud-shaped binding row, as the backfill run would.
// Cloud's Web API is a recording fetch. The local composition has one owner, so the started task is the owner's (the sink's person check still runs).
import { localOwnerPrincipal } from "@rovara-code/broker/ports";
import { IMPLICIT_COMPANY_ID, type ChannelEvent, type OrgId } from "@rovara-code/contracts";
import { createCloudChannelWork, createSlackIntake } from "../../../../packages/broker/src/cloud/app/slack-work.js";
import { CloudSlackChannel, createCloudSlackSink } from "../../../../packages/broker/src/plugins/channel/slack-cloud/index.js";
import { backfillSlackTenants } from "../../../../packages/broker/src/plugins/channel/slack-cloud/tenants-backfill.js";
import type { CoreContext } from "../core-context.js";
import { outcome } from "./outcomes.js";

export const SLACK_TEAM = "T0BSHLLUGBD";
export const SLACK_CHANNEL = "C0123456789";
const SLACK_THREAD = "1695500000.000001";
const SLACK_USER = "U0MAYA001";
const MEMBER = "d".repeat(64);
const ORG = IMPLICIT_COMPANY_ID as OrgId;

interface SlackState { delivered: ChannelEvent[]; calls: string[] }
const state = new WeakMap<CoreContext, SlackState>();

export async function slackStartOnCore(ctx: CoreContext): Promise<string[]> {
  if ((await ctx.api("/v1/admin/projects", { method: "POST", body: ctx.project })).status !== 201) throw new Error("the core refused the project");
  // The binding row exactly as Cloud's bind writes it today, then A8's backfill over it.
  const binding = { pk: `ORG#${ORG}#SLACK_BINDING#${SLACK_TEAM}`, sk: `CHANNEL#${SLACK_CHANNEL}`, entityType: "SLACK_BINDING", teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, projectName: "payments", updatedAt: ctx.clock.now().toISOString() };
  await ctx.store.put({ item: binding });
  await backfillSlackTenants(ctx.store, [binding]);
  const seen: SlackState = { delivered: [], calls: [] };
  state.set(ctx, seen);
  const recordingFetch: typeof fetch = async (input) => {
    seen.calls.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname);
    return Response.json({ ok: true, ts: "1695500001.000001", channel: SLACK_CHANNEL });
  };
  const adapter = new CloudSlackChannel({ projects: ["payments"], botToken: async () => ["xoxb", "parity", "not", "a", "token"].join("-"), serves: async (team) => team === SLACK_TEAM, fetch: recordingFetch });
  const deliver = adapter.deliver.bind(adapter);
  adapter.deliver = async (event) => { seen.delivered.push(event); await deliver(event); };
  // The channel point may change after the registry is sealed (Code's rule): the adapter is registered as `slack`, so the core's own sends reach it too.
  ctx.runtime.registry.register("channel", "slack", adapter);
  let startedTask: string | undefined;
  const now = () => ctx.clock.now().getTime();
  // Cloud's ChannelWork as the root builds it (cloud/app/slack-work.ts). The local composition has one owner, so the person is the owner and the start is the core's own.
  const work = createCloudChannelWork({
    store: ctx.store, now,
    start: async (caller, request) => { const started = await ctx.runtime.app.flow.start(caller, request); startedTask = started.task.taskId; return started; },
    principalOf: async () => localOwnerPrincipal(),
    gate: { decide: () => Promise.resolve({ status: "refused", reason: "not_open" }) },
  });
  const sink = createCloudSlackSink({
    adapter, store: ctx.store, now, work,
    orgOfTeam: async (team) => (team === SLACK_TEAM ? ORG : undefined),
    standingOf: async (_org, userId) => { if (userId !== SLACK_USER) throw new Error("not a member"); return MEMBER; },
    linkWords: (code) => `Link with code ${code}.`,
    log: () => undefined,
  });
  await createSlackIntake(sink)({ version: 1, eventId: "EvParity0001", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: SLACK_THREAD }, userId: SLACK_USER, text: "quick: Add a greet(name) function", receivedAt: ctx.clock.now().toISOString() });
  if (startedTask === undefined) return [outcome("slack", "start:refused")];
  ctx.task.taskId = startedTask;
  const record = await ctx.readTask();
  ctx.task.workspaceId = typeof record?.workspaceId === "string" ? record.workspaceId : "";
  const prepare = await ctx.take();
  await ctx.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: ctx.task.base }] } });
  return [outcome("slack", "start:task_started")];
}

/** Whether a plan card reached the thread: the core's `approval_request` event (core/channel/cards.ts postApprovalCard). */
export function slackApproveOnCore(ctx: CoreContext): string[] {
  const seen = state.get(ctx);
  const card = seen?.delivered.some((event) => event.type === "approval_request") === true;
  return [outcome("slack", card ? "approve:card_offered" : "approve:no_card")];
}
