// Live steer, dispatcher side: delivers a `steer` outbox item (written by `live-steer.ts`) to the worker that runs the step, and tells the message when the worker's session took it.
// It never starts compute (a message is not a reason to wake a stopped worker), never touches an operation record, and is bounded: the dispatcher's own attempt limit ends the retries, and an
// item that cannot be delivered only ends `FAILED` (the message stays queued, as a note for the next step). A `not_running` or stale answer is final and leaves the message as a note.
// No log line, event or error holds the message's text (the worker's own error body is never repeated).
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { LIVE_STEER_FEATURE, LiveSteerAnswerSchema, WORKER_INVOKE_AUTHORIZATION_SCHEME, agentXError, liveSteerOperationId, workerInvokeToken, workerInvokeTokenPayload, workspaceSessionKey } from "@rovara-code/contracts";
import { type WorkerInvocation } from "@agentx/cloud-contracts";
import type { DurableOutboxRecord } from "../aws/lambda.js";
import { deliverSteerLive, steerStillQueued, type SteerDependencies } from "./steer.js";

/** The worker's port, and how long its token lives: the same as every other delivery (ec2-delivery.ts). */
const WORKER_PORT = 8080;
const TOKEN_LIFETIME_SECONDS = 60;

export interface LiveSteerDispatchDependencies extends Pick<SteerDependencies, "documentClient" | "tableName" | "now" | "log"> {
  /** KMS Sign, ECDSA_SHA_256 over the message bytes; returns the DER signature. */
  sign: (message: Uint8Array) => Promise<Uint8Array>;
  post: (url: string, init: { authorization: string; body: string }) => Promise<{ status: number; body: string }>;
  /** The invocation features the worker lists on /ping; rejects when it does not answer. */
  workerFeatures: (url: string) => Promise<readonly string[]>;
}

const FieldsSchema = z.object({ orgId: z.string().min(1), sessionId: z.string().min(1), messageId: z.string().regex(/^msg_[0-9a-z]{20}$/), taskId: z.string().uuid() }).strict();
type SteerInvocation = Extract<WorkerInvocation, { kind: "steer" }>;

export type LiveSteerFinish = "steered" | "not_running" | "stale" | "no_worker" | "old_worker" | "invalid";

export function createLiveSteerDispatch(deps: LiveSteerDispatchDependencies) {
  const read = async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const outbox = (record: Pick<DurableOutboxRecord, "id">) => ({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX" });
  const finish = async (record: DurableOutboxRecord, outcome: LiveSteerFinish): Promise<void> => {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: outbox(record), UpdateExpression: "SET #status = :delivered, deliveredAt = :now, liveSteerOutcome = :outcome",
      ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":delivered": "DELIVERED", ":now": new Date(deps.now()).toISOString(), ":outcome": outcome },
    }));
  };
  return {
    /**
     * Gives the item's message to the worker. Answers once it is final (finished, with the message `delivered` when the worker's session took it); throws, for the dispatcher's bounded retry,
     * when the worker cannot be asked or its session is not open yet.
     */
    async deliver(record: DurableOutboxRecord, invocation: SteerInvocation): Promise<LiveSteerFinish> {
      const fields = FieldsSchema.safeParse((record as { liveSteer?: unknown }).liveSteer);
      const { payload } = invocation;
      // An item that is not what it says (a mismatched id, another operation's invocation) is never sent anywhere.
      if (!fields.success || fields.data.messageId !== payload.messageId || record.operationId !== invocation.operationId || record.workspaceId !== invocation.workspaceId
        || invocation.operationId !== liveSteerOperationId(payload.messageId) || record.deploymentMode !== "ec2-ebs") {
        await finish(record, "invalid");
        return "invalid";
      }
      const { orgId, sessionId, messageId, taskId } = fields.data;
      // The message may have been answered already (the step read its note, the session ended), and the step it was for may be over: then it is only a note.
      if (!await steerStillQueued(deps, orgId, sessionId, messageId)) { await finish(record, "stale"); return "stale"; }
      const workspace = await read({ pk: `WORKSPACE#${record.workspaceId}`, sk: "META" });
      if (workspace?.["status"] !== "BUSY" || workspace["activeOperationId"] !== payload.targetOperationId || workspace["fence"] !== invocation.fence) { await finish(record, "stale"); return "stale"; }
      // Only a worker that is up: a stopped or starting one is never woken for a message.
      const session = await read(workspaceSessionKey(record.workspaceId));
      if (session?.["state"] !== "READY" || typeof session["privateIp"] !== "string" || typeof session["generation"] !== "number") { await finish(record, "no_worker"); return "no_worker"; }
      const base = `http://${session["privateIp"]}:${WORKER_PORT}`;
      if (!(await deps.workerFeatures(`${base}/ping`)).includes(LIVE_STEER_FEATURE)) { await finish(record, "old_worker"); return "old_worker"; }
      const payloadToken = workerInvokeTokenPayload({
        workspaceId: record.workspaceId, generation: session["generation"], operationId: invocation.operationId, fence: invocation.fence,
        expiresAt: Math.floor(deps.now() / 1_000) + TOKEN_LIFETIME_SECONDS, purpose: "WORKSPACE",
      });
      const signature = await deps.sign(Buffer.from(payloadToken, "ascii"));
      const response = await deps.post(`${base}/invocations`, { authorization: `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payloadToken, signature)}`, body: JSON.stringify(invocation) });
      // The worker's own words are never repeated: a refusal is a fixed code with its status.
      if (response.status >= 300) throw agentXError("RUNTIME_UNAVAILABLE", `the worker did not take the live message (HTTP ${response.status})`);
      let answer: z.infer<typeof LiveSteerAnswerSchema>;
      try { answer = LiveSteerAnswerSchema.parse(JSON.parse(response.body)); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "the worker's answer to a live message could not be read"); }
      if (answer.outcome === "not_ready") throw agentXError("RUNTIME_UNAVAILABLE", "the step's session is not open yet");
      if (answer.outcome === "steered") await deliverSteerLive(deps, orgId, sessionId, messageId, taskId);
      await finish(record, answer.outcome);
      return answer.outcome;
    },
    /** The dispatcher gave up (its attempts are used): only the item ends `FAILED`. The message stays queued and its note is read by the next step; no operation is touched. */
    async fail(record: DurableOutboxRecord): Promise<void> {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: outbox(record), UpdateExpression: "SET #status = :failed, failedAt = :now, #error = :error",
        ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: { ":failed": "FAILED", ":now": new Date(deps.now()).toISOString(), ":error": "RUNTIME_UNAVAILABLE: the live message could not be delivered" },
      }));
    },
  };
}
