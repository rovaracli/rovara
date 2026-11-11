// Plan 3, Task 21a-wiring (hand-off 1, ruled): who may decide an approval is the BROKER's question, not the sign-in function's. The sign-in
// function runs the decide flow (tickets, the fresh sign-in, Cognito), but it holds no grant on approvals, projects or roles, and a second copy of
// the evaluation in another role would drift from `decideApproval` (R68). So its kinds ask the broker, over a direct invoke:
//   request  { kind: "decide-inspect", orgId, developerId, approvalId }   (schema-checked on both sides, nothing else accepted)
//   answer   { status: "open" } | { status: "forbidden", who } | { status: "decided", by, at } | { status: "expired", at } | { status: "not_found" }
// The answer never carries the approval, its arguments or the page's view. Any invoke error, timeout or answer that does not fit is an error,
// and the flow fails closed on it (a 503 page, no ticket, no Cognito call). The broker evaluates everything again on the real decision.
// WHO MAY ASK is enforced by IAM on the caller's side, not by the broker: a direct invoke carries no caller identity, so the broker answers any
// principal that can invoke it. Only the DeveloperIdentity role is granted `lambda:InvokeFunction` for this purpose (infra/lib/developer-signin.ts);
// the other roles that can invoke the broker (the Slack ingress and the recovery jobs) are trusted functions that build their own typed events. The
// answer is one word plus display names, never an approval.
// The event shape is unreachable from HTTP: an API Gateway event has `requestContext` and `routeKey`, and `isDecideInspectEvent` refuses anything that does.
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { OrgIdSchema } from "@rovara-code/contracts";
import { z } from "zod";
import { mayDecide, type DecideInspection, type DecideKind, type DecideKinds } from "./decide-kinds.js";

const INVOKE_TIMEOUT_MS = 8_000;
const Words = z.string().min(1).max(200);

export const DecideInspectRequestSchema = z.object({
  kind: z.literal("decide-inspect"),
  orgId: OrgIdSchema,
  developerId: z.string().regex(/^[a-f0-9]{64}$/),
  approvalId: z.string().regex(/^(?:apr|spr)_[0-9a-z]{20}$/),
}).strict();
export type DecideInspectRequest = z.infer<typeof DecideInspectRequestSchema>;

export const DecideInspectAnswerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("forbidden"), who: Words }).strict(),
  z.object({ status: z.literal("decided"), by: Words, at: Words }).strict(),
  z.object({ status: z.literal("expired"), at: Words }).strict(),
  z.object({ status: z.literal("open") }).strict(),
]);
export type DecideInspectAnswer = z.infer<typeof DecideInspectAnswerSchema>;

/** The event as the broker's handler sees it before its fields are checked (`answerDecideInspect` does that). */
export interface DecideInspectEvent { kind: "decide-inspect" }

/** Whether the event is a direct invoke asking `decide-inspect` (valid or not): never an HTTP API event, which carries `requestContext`. */
export function isDecideInspectEvent(event: unknown): event is DecideInspectEvent {
  if (typeof event !== "object" || event === null) return false;
  const fields = event as Record<string, unknown>;
  return fields.kind === "decide-inspect" && !("requestContext" in fields) && !("routeKey" in fields) && !("rawPath" in fields) && !("headers" in fields);
}

/** The broker's side: the same `mayDecide` the page uses, reduced to the one word (and the words) the sign-in function needs. */
export async function answerDecideInspect(kinds: DecideKinds, event: unknown): Promise<{ statusCode: number; body: DecideInspectAnswer | { error: "invalid_request" } }> {
  const request = DecideInspectRequestSchema.safeParse(event);
  if (!request.success) return { statusCode: 400, body: { error: "invalid_request" } };
  const inspection = await mayDecide(kinds, { orgId: request.data.orgId, developerId: request.data.developerId, approvalId: request.data.approvalId });
  switch (inspection.status) {
    case "open": return { statusCode: 200, body: { status: "open" } };
    case "forbidden": return { statusCode: 200, body: { status: "forbidden", who: inspection.who.slice(0, 200) } };
    case "decided": return { statusCode: 200, body: { status: "decided", by: inspection.by.slice(0, 200), at: inspection.at.slice(0, 200) } };
    case "expired": return { statusCode: 200, body: { status: "expired", at: inspection.at.slice(0, 200) } };
    default: return { statusCode: 200, body: { status: "not_found" } };
  }
}

/**
 * The sign-in function's kinds: `inspect` asks the broker; `decide` is never done here (decisions are made by the broker, on the page). The `spr`
 * prefix is asked too, so the broker alone says it is not found until Task 32 registers it there.
 */
export function brokerDecideKinds(input: { invoke(request: DecideInspectRequest): Promise<unknown> }): DecideKinds {
  const kind: DecideKind = {
    async inspect(target): Promise<DecideInspection> {
      const answer = DecideInspectAnswerSchema.safeParse(await input.invoke({ kind: "decide-inspect", orgId: target.orgId, developerId: target.developerId, approvalId: target.approvalId }));
      if (!answer.success) throw new Error("the broker's answer to decide-inspect was not understood");
      // The sign-in function only ever looks at `status`; the page's view is the broker's.
      return answer.data.status === "open" ? { status: "open", view: { title: "", facts: [] } } : answer.data;
    },
    decide(): Promise<never> {
      return Promise.reject(new Error("decisions are made by the broker on the confirmation page, not by the sign-in function"));
    },
  };
  return { apr: kind, spr: kind };
}

/** Invokes the broker function and waits for its `{ statusCode, body }`; a function error, a non-200 answer or a body that is not JSON throws. */
export function lambdaInspectInvoker(lambda: { send(command: unknown, options?: unknown): Promise<unknown> }, functionName: string): (request: DecideInspectRequest) => Promise<unknown> {
  return async (request) => {
    const response = await lambda.send(
      new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(request)) }),
      { abortSignal: AbortSignal.timeout(INVOKE_TIMEOUT_MS) },
    ) as { FunctionError?: string; Payload?: Uint8Array };
    if (response.FunctionError !== undefined || response.Payload === undefined) throw new Error("the broker did not answer decide-inspect");
    const result = JSON.parse(new TextDecoder().decode(response.Payload)) as { statusCode?: unknown; body?: unknown };
    if (result.statusCode !== 200 || typeof result.body !== "string") throw new Error("the broker refused decide-inspect");
    // The broker's answers carry its envelope's `requestId`; the answer itself is the rest.
    const { requestId: _requestId, ...answer } = JSON.parse(result.body) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's, not the answer's
    return answer;
  };
}
