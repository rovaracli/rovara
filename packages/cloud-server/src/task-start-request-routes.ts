import { z } from "zod";
import { AgentXNameSchema, StartDeveloperTaskRequestSchema } from "@agentx/contracts";
import { CodeError, SignInEnded, SERVER_READ_CALL_MS, SERVER_READ_MAX_BYTES } from "./code-client.js";
import type { Route, RouteAnswer } from "./routes.js";

const RequestId = StartDeveloperTaskRequestSchema.shape.requestId;
const base = { requestId: RequestId, operation: z.literal("start"), checkedAt: z.iso.datetime() };
const Reply = z.discriminatedUnion("outcome", [
  z.object({ ...base, outcome: z.literal("confirmed"), task: z.object({ taskId: z.uuid(), project: AgentXNameSchema, createdAt: z.iso.datetime() }).strict() }).strict(),
  z.object({ ...base, outcome: z.literal("unknown") }).strict(),
]);
// Loose on purpose (F3-A0): a newer Code may add envelope fields (reason, writes) or error codes. Only code and message are read; anything else passes through unread.
const ErrorBody = z.looseObject({ error: z.looseObject({ code: z.string(), message: z.string() }) });
const failure = (status: number, code: string, message = "Start status is unavailable."): RouteAnswer => ({ status, body: { error: { code, message } } });
const unavailable = () => failure(503, "RUNTIME_UNAVAILABLE");
function refused(error: unknown): RouteAnswer {
  if (error instanceof SignInEnded) throw error;
  if (!(error instanceof CodeError)) return unavailable();
  if (error.status >= 200 && error.status < 300) return failure(502, "INVALID_RESPONSE");
  const parsed = ErrorBody.safeParse(error.body);
  if (parsed.success) {
    const { code, message } = parsed.data.error;
    if (error.status === 404 && code === "TASK_NOT_FOUND" && message === "That task is unavailable.") return failure(404, code, message);
    if (error.status === 400 && code === "CONFIG_INVALID" && message === "That start request is invalid.") return failure(400, code, message);
  }
  if (error.status === 401) return failure(401, "AUTH_REQUIRED", "Sign in to continue.");
  if (error.status === 403) return failure(403, "FORBIDDEN", "You cannot read this start request.");
  if (error.status === 429) return failure(429, "RATE_LIMITED", "Please wait a moment and try again.");
  return unavailable();
}
export const TASK_START_REQUEST_ROUTES: Route[] = [
  { method: "GET", path: /^\/task-start-requests\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu, answer: async context => {
    const id = RequestId.safeParse(context.params[0]);
    if (!id.success || context.query.size !== 0 || context.body !== undefined) return failure(400, "CONFIG_INVALID", "That start request is invalid.");
    const deadlineMs = context.serverReadDeadline === undefined ? SERVER_READ_CALL_MS : context.serverReadDeadline - Date.now();
    if (deadlineMs <= 0) return unavailable();
    let value: unknown;
    try {
      value = await context.client.json<unknown>(context.session, `/v1/dev/tasks/start-requests/${id.data}`, {
        method: "GET", expectedStatus: 200, boundedRead: { deadlineMs, maxBytes: SERVER_READ_MAX_BYTES },
      });
    } catch (error) { return refused(error); }
    const reply = Reply.safeParse(value);
    return !reply.success || reply.data.requestId !== id.data ? failure(502, "INVALID_RESPONSE") : { status: 200, body: reply.data };
  } },
  // No captures: reject raw aliases before the handler's capture decoding.
  { method: "GET", path: /^\/task-start-requests(?:\/.*)?$/u, answer: async () => failure(400, "CONFIG_INVALID", "That start request is invalid.") },
];
