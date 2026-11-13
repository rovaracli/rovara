// Convergence S0 WIRING (open question S0-Q1): Cloud's `ChannelWork`, and the intake that feeds the core's channel sink from Cloud's Slack queue.
//
// The core's channel sink checks a message (the company of the workspace, the person behind the Slack account, the project of the channel) and hands what passed to a
// `ChannelWork`. Code's own is inside its unexported local composition (local/app/chat.ts) and serves one owner; Cloud's serves the company's people:
//   message  starts a task on the core for the person the sink named, as that person (lane A6's identity adapter gives the principal), with the Slack thread
//            remembered so what the task later needs is told there; the same Slack event starts one task whatever number of times it is delivered (the request id is
//            made from the event id), exactly as the queue's own redelivery needs.
//   decide   asks the core's decision gate with the chat credential of Slack (`chat-slack`, which Cloud's approvers adapter names): a Slack press decides low and
//            medium plans inside the company's window and never anything higher (A6 gaps G1/G7, owner decision 144 for the card itself), and the gate says which.
// `quick:` and `full:` at the start of a message choose the path, as today's ingress reads them; with neither, the core's Understand step chooses where it runs, and where
// it does not the start is refused for want of a path (the Quick or Full question card is the 143b lane's).
import { createHash } from "node:crypto";
import { recordTaskThread, type ChannelWork } from "@rovara-code/broker/core/channel";
import { taskSessionId } from "@rovara-code/broker/core/sessions";
import type { ChannelDecision, ChannelInboundSink, DocumentStore, OrgId, Principal, SlackRequestMessage } from "@rovara-code/contracts";
import { inboundFromQueuedSlackRequest } from "../../plugins/channel/slack-cloud/index.js";
import { CHAT_SLACK_METHOD } from "../adapters/people/methods.js";

type Log = (entry: Record<string, unknown>) => void;

/** What the work needs of the core's task flow (`TaskFlow.start`), as a function so a test can give a stand-in. */
export type StartTask = (caller: { principal: Principal; client: string }, request: { project: string; instructions: string; requestId: string; workflow: true; workflowPath?: "QUICK" | "FULL" }) => Promise<{ task: { taskId: string } }>;

/** What the work needs of the decision gate (`DecisionGate.decide`). */
export interface DecideOnGate {
  decide(request: {
    companyId: OrgId; kind: string; subjectId: string; requestId: string; outcome: "approve" | "reject" | "request_changes";
    seen: { revision: number; artifactDigest: string };
    credentials: Array<{ method: string; token: string; claimedAccount: { provider: string; tenant: string; accountId: string } }>; reason?: string;
  }): Promise<{ status: "refused"; reason: string } | { status: string }>;
}

export interface CloudChannelWorkDeps {
  store: Pick<DocumentStore, "put">;
  now: () => number;
  start: StartTask;
  gate: DecideOnGate;
  /** The person as the core knows them (lane A6's `identity.getPrincipal`): undefined for anyone who is not of this company. */
  principalOf: (orgId: OrgId, personId: string) => Promise<Principal | undefined>;
  log?: Log;
}

const OUTCOME = { APPROVE: "approve", REJECT: "reject", REQUEST_CHANGES: "request_changes", SKIP: undefined } as const;

/** A UUID made from a text, so the same Slack event always asks for the same start (Code's `uuidOf`, chat.ts). */
export function requestIdOf(text: string): string {
  const hex = createHash("sha256").update(`chat-start\0${text}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The chat-slack credential's token: the press fields A6's issuer reads (`adapters/people/issuers.ts` `SlackPressTokenSchema`, strict JSON), from the fields the channel sink already
 * verified (the actor's workspace is the conversation's, which `createChannelSink` checks before any work is done). A channel adapter's ActorRef carries no Enterprise Grid ids, so both are
 * empty and equal, which the issuer's own rule takes as "no enterprise"; an Enterprise Grid install needs them carried (DEFERRED S3-SLACK-ENTERPRISE-GRID).
 */
export function slackPressToken(decision: Pick<ChannelDecision, "actor" | "conversation">): string {
  return JSON.stringify({ userId: decision.actor.userId, userTeamId: decision.actor.tenant, workspaceTeamId: decision.conversation.tenant, enterpriseId: "", userEnterpriseId: "" });
}

export function createCloudChannelWork(deps: CloudChannelWorkDeps): ChannelWork {
  const log: Log = deps.log ?? (() => undefined);
  return {
    async message({ orgId, message, projectName, personId }) {
      const principal = await deps.principalOf(orgId, personId);
      if (principal === undefined) { log({ event: "slack_work.not_a_member" }); return; }
      const path = /^(quick|full):\s*/iu.exec(message.text);
      const started = await deps.start({ principal, client: "slack" }, {
        project: projectName, instructions: path === null ? message.text : message.text.slice(path[0].length), requestId: requestIdOf(`slack/${message.eventId}`), workflow: true,
        ...(path === null ? {} : { workflowPath: path[1]!.toLowerCase() === "full" ? "FULL" as const : "QUICK" as const }),
      });
      await recordTaskThread({ store: deps.store, orgId, now: deps.now }, { sessionId: taskSessionId(started.task.taskId), conversation: message.conversation, personId });
    },
    async decide({ orgId, card, decision, personId }) {
      const outcome = OUTCOME[decision.decision];
      if (outcome === undefined || (await deps.principalOf(orgId, personId)) === undefined) return { status: "refused" as const, reason: "invalid" };
      const result = await deps.gate.decide({
        companyId: orgId, kind: card.subject.type, subjectId: card.subject.id, requestId: card.requestId, outcome, seen: { revision: card.revision, artifactDigest: card.artifactDigest },
        credentials: [{ method: CHAT_SLACK_METHOD, token: slackPressToken(decision), claimedAccount: { provider: decision.actor.channel, tenant: decision.actor.tenant, accountId: decision.actor.userId } }], ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      });
      return result.status === "refused" ? { status: "refused" as const, reason: (result as { reason: string }).reason } : { status: "decided" as const };
    },
  };
}

/** The intake of Cloud's Slack request queue: each queued request becomes the sink's message (A8's `inboundFromQueuedSlackRequest`). Throws what the sink throws, so the queue retries. */
export function createSlackIntake(sink: Pick<ChannelInboundSink, "message">): (message: SlackRequestMessage) => Promise<void> {
  return (message) => sink.message(inboundFromQueuedSlackRequest(message));
}
