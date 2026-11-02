// Live interaction A3: the glue between a queued Ask and the one hosted turn runner `main.ts` owns. Apart from `main.ts` (which starts the service when it is imported) so it can be tested:
//   - `accessRouteFor`: the model key of an Ask's turn is asked for on the Ask's own broker route (it names the Ask, so the broker checks the asker still "can use" the session), never on a Slack
//     thread's; a turn that is not an Ask the glue is running has no route and throws (it is never given a thread's);
//   - `runTurn`: runs the Ask's no-tools answer turn for the broker's context, remembering the Ask under the queue event's id while it runs and forgetting it afterwards, whatever happens.
import { SlackRequestMessageSchema, type AskRef, type AskTurnResult, type SlackRequestMessage } from "@agentx/contracts";
import type { TurnInput } from "./processor.js";
import { deterministicUuid, requestIdSequence } from "./ids.js";

export interface AskGlue {
  /** Where the model key of the turn for this queue event is asked for. Throws when no Ask is running for the event. */
  accessRouteFor(message: Pick<SlackRequestMessage, "eventId">): { orgId: AskRef["orgId"]; path: "/v1/asks/model-access"; body: { sessionId: string; askId: string } };
  /** The `runTurn` of `handleAsk` for one queue message; `handoff` aborts the turn. */
  runTurn(handoff?: AbortSignal): (input: { ref: AskRef; question: string; eventId: string; turn: AskTurnResult }) => Promise<string>;
  /** How many Asks have a turn running (for tests and logs). */
  running(): number;
}

export function createAskGlue(hosted: { runTurn(input: TurnInput, ask: AskRef): Promise<string> }): AskGlue {
  const turns = new Map<string, AskRef>();
  return {
    accessRouteFor(message) {
      const ref = turns.get(message.eventId);
      if (ref === undefined) throw new Error("no ask is running for this turn");
      return { orgId: ref.orgId, path: "/v1/asks/model-access", body: { sessionId: ref.sessionId, askId: ref.askId } };
    },
    runTurn: (handoff) => async ({ ref, question, eventId, turn }) => {
      // The turn needs a message-shaped record for its models and logs; its ids are placeholders, used nowhere that reaches Slack or the broker.
      const placeholder = SlackRequestMessageSchema.parse({ version: 1, eventId, thread: { teamId: "T0000000000", channelId: "C0000000000", threadTs: "1700000000.000000" }, userId: "U0000000000", text: question, receivedAt: new Date().toISOString() });
      turns.set(eventId, ref);
      try {
        return await hosted.runTurn({
          message: placeholder, subject: `ask:${ref.askId}`, workspaceId: turn.workspaceId, conversationId: deterministicUuid(`${ref.askId}:ask-conversation`),
          orchestratorInstructions: turn.orchestratorInstructions, requestId: requestIdSequence(eventId), turnNote: turn.taskContext, answerOnly: true,
          ...(handoff === undefined ? {} : { signal: handoff }),
        }, ref);
      } finally {
        turns.delete(eventId);
      }
    },
    running: () => turns.size,
  };
}
