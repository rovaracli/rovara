// Live interaction A2, dispatcher side: the broker may not sign a worker call (only the dispatcher holds the signing permission), so an Ask that wants the running task's working tree invokes the
// dispatcher Lambda directly (not through the queue) with a `task-peek` event, and this module answers it on the same request. It checks the invocation is exactly a `peek` for a workspace that is
// up now (same fence, ec2 worker, session READY), asks the worker's /ping for `task.peek.v1`, signs one short-lived token, posts the invocation, and returns the worker's answer after checking its
// shape. It never starts compute (an Ask is not a reason to wake a stopped worker), writes nothing, and repeats no worker text: every refusal is a fixed word, and the caller falls back to the
// pull request's diff.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DispatcherPeekReplySchema, PEEK_FEATURE, PeekAnswerSchema, WORKER_INVOKE_AUTHORIZATION_SCHEME, workerInvokeToken, workerInvokeTokenPayload, workspaceSessionKey, type DispatcherPeekReply } from "@rovara-code/contracts";
import { WorkerInvocationSchema } from "@agentx/cloud-contracts";

const WORKER_PORT = 8080;
const TOKEN_LIFETIME_SECONDS = 60;

export interface PeekDispatchDependencies {
  documentClient: { send(command: GetCommand): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** KMS Sign, ECDSA_SHA_256 over the message bytes; returns the DER signature. */
  sign: (message: Uint8Array) => Promise<Uint8Array>;
  post: (url: string, init: { authorization: string; body: string }) => Promise<{ status: number; body: string }>;
  /** The invocation features the worker lists on /ping; rejects when it does not answer. */
  workerFeatures: (url: string) => Promise<readonly string[]>;
}

type Item = Record<string, unknown>;

/** Answers one `task-peek` event. Never throws: every failure is a fixed word in the reply. */
export function createPeekDispatch(deps: PeekDispatchDependencies) {
  const read = async (key: { pk: string; sk: string }): Promise<Item | undefined> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
  return async function peek(event: unknown): Promise<DispatcherPeekReply> {
    try {
      const invocation = WorkerInvocationSchema.safeParse((event as { invocation?: unknown } | null)?.invocation);
      // Only a `peek` invocation is ever signed here; the event cannot be used to sign any other kind.
      if (!invocation.success || invocation.data.kind !== "peek") return { outcome: "invalid" };
      const peekInvocation = invocation.data;
      const workspace = await read({ pk: `WORKSPACE#${peekInvocation.workspaceId}`, sk: "META" });
      if (workspace === undefined || workspace["deploymentMode"] !== "ec2-ebs" || (workspace["status"] !== "BUSY" && workspace["status"] !== "READY")) return { outcome: "not_running" };
      if (workspace["fence"] !== peekInvocation.fence) return { outcome: "stale" };
      // Only a worker that is up: a stopped or starting one is never woken for an Ask.
      const session = await read(workspaceSessionKey(peekInvocation.workspaceId));
      if (session?.["state"] !== "READY" || typeof session["privateIp"] !== "string" || typeof session["generation"] !== "number") return { outcome: "no_worker" };
      const base = `http://${session["privateIp"]}:${WORKER_PORT}`;
      if (!(await deps.workerFeatures(`${base}/ping`)).includes(PEEK_FEATURE)) return { outcome: "old_worker" };
      const payload = workerInvokeTokenPayload({
        workspaceId: peekInvocation.workspaceId, generation: session["generation"], operationId: peekInvocation.operationId, fence: peekInvocation.fence,
        expiresAt: Math.floor(deps.now() / 1_000) + TOKEN_LIFETIME_SECONDS, purpose: "WORKSPACE",
      });
      const signature = await deps.sign(Buffer.from(payload, "ascii"));
      const response = await deps.post(`${base}/invocations`, { authorization: `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, signature)}`, body: JSON.stringify(peekInvocation) });
      if (response.status >= 300) return { outcome: "unavailable" };
      const answer = PeekAnswerSchema.safeParse(JSON.parse(response.body));
      if (!answer.success || answer.data.outcome !== "peeked") return { outcome: "unavailable" };
      return DispatcherPeekReplySchema.parse({ outcome: "peeked", answer: answer.data });
    } catch {
      return { outcome: "unavailable" };
    }
  };
}
