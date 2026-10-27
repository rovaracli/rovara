import { StatusReply } from "./status-reply.js";

// The one place an answer becomes an HTTP reply: every object a route answers carries the gateway's `requestId` beside its own fields (a non-object is wrapped as `data`). A client
// that reads an answer with a strict schema therefore has to leave room for `requestId` (or read it with a `forwardReader`, which keeps unknown fields).
export function json(
  value: unknown,
  requestId: string,
  statusCode = 200,
): { statusCode: number; headers: Record<string, string>; body: string } {
  const body = value && typeof value === "object" ? { ...value, requestId } : { data: value, requestId };
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

/** What a route of the developer API (`/v1/dev`, `/v1/app`, `/v1/web`) returned, as the HTTP reply: a `StatusReply` keeps its status, anything else is a 200. */
export function developerReply(answer: unknown, requestId: string): ReturnType<typeof json> {
  return answer instanceof StatusReply ? json(answer.body, requestId, answer.statusCode) : json(answer, requestId);
}
