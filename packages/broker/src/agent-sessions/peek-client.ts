// Live interaction A2, broker side: asks the dispatcher (synchronously) for a read-only look at the working tree of the worker that holds a task's workspace. Used by an Ask only; the answer is
// the tier-filtered diff of `ask-context.ts`, which redacts and cuts it again. Every failure (no workspace, a stopped or older worker, a timeout, an answer that does not parse) is `undefined`,
// and the caller uses the pull request's diff: a peek is never required, never retried, and never waits long. The invocation it builds holds no capability and no command (live-peek.ts).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "node:crypto";
import { DISPATCHER_PEEK_EVENT_KIND, DispatcherPeekReplySchema, PEEK_NO_CALLBACK_CAPABILITY, PEEK_PATCH_MAX_BYTES, type DispatcherPeekEvent, type PeekAnswer } from "@rovara-code/contracts";
import { taskPointerKey, type DeveloperTaskRecord } from "../developer/task-records.js";

/** A peek that has not answered in this long is given up (the dispatcher's own worker call is bounded at 10 s). */
export const PEEK_TIMEOUT_MS = 12_000;

export interface PeekClientDependencies {
  documentClient: { send(command: GetCommand): Promise<unknown> };
  tableName: string;
  /** Sends the event to the dispatcher Lambda and answers its decoded reply; rejects when it cannot. */
  invoke(event: DispatcherPeekEvent, options: { abortSignal: AbortSignal }): Promise<unknown>;
  newOperationId?: () => string;
}

export type PeekClient = (task: DeveloperTaskRecord) => Promise<PeekAnswer | undefined>;

type Item = Record<string, unknown>;

export function createPeekClient(deps: PeekClientDependencies): PeekClient {
  const read = async (key: { pk: string; sk: string }): Promise<Item | undefined> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
  return async (task) => {
    try {
      if (task.workspaceId === undefined) return undefined;
      const workspace = await read({ pk: `WORKSPACE#${task.workspaceId}`, sk: "META" });
      if (workspace === undefined || workspace["deploymentMode"] !== "ec2-ebs" || (workspace["status"] !== "BUSY" && workspace["status"] !== "READY")
        || typeof workspace["fence"] !== "number" || typeof workspace["projectRevision"] !== "number") return undefined;
      // The workspace is this task's own.
      if ((await read(taskPointerKey(task.workspaceId)))?.["taskId"] !== task.taskId) return undefined;
      const event: DispatcherPeekEvent = {
        kind: DISPATCHER_PEEK_EVENT_KIND,
        invocation: {
          protocolVersion: 1, kind: "peek", operationId: (deps.newOperationId ?? randomUUID)(), workspaceId: task.workspaceId, fence: workspace["fence"], projectRevision: workspace["projectRevision"],
          callbackCapability: PEEK_NO_CALLBACK_CAPABILITY, payload: { maxPatchBytes: PEEK_PATCH_MAX_BYTES },
        },
      };
      const reply = DispatcherPeekReplySchema.safeParse(await deps.invoke(event, { abortSignal: AbortSignal.timeout(PEEK_TIMEOUT_MS) }));
      return reply.success && reply.data.outcome === "peeked" ? reply.data.answer : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The dispatcher Lambda as a peek invoker: a direct request-response invoke. A function error, no payload or a payload that is not JSON rejects. */
export function lambdaPeekInvoker(client: { send(command: InvokeCommand, options?: { abortSignal?: AbortSignal }): Promise<{ FunctionError?: string | undefined; Payload?: Uint8Array | undefined }> }, functionArn: string): PeekClientDependencies["invoke"] {
  return async (event, options) => {
    const response = await client.send(new InvokeCommand({ FunctionName: functionArn, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(event), "utf8") }), { abortSignal: options.abortSignal });
    if (response.FunctionError !== undefined || response.Payload === undefined) throw new Error("the dispatcher did not answer a peek");
    return JSON.parse(Buffer.from(response.Payload).toString("utf8")) as unknown;
  };
}
