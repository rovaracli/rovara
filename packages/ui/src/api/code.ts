import { PROCESS_START_REFUSED_MESSAGE, ProjectOverviewProjectSchema, SessionIdSchema, TaskResponseReaderSchema } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient, type Reader, type SendResult } from "./client.js";
import { ApiError } from "./errors.js";

/** The longest request the route takes (the same limit the other start forms show). */
export const CODE_TEXT_MAX = 4000;

type Answer = ReturnType<typeof TaskResponseReaderSchema.parse>;
/** What starting work answers: the task, and the session to open (absent only on a legacy answer that has no session). */
export type StartedCode = Answer & { sessionId?: string; sessionUrl?: string };

/** The route's answer: the task, plus `sessionId` and `sessionUrl` beside it. A session id that is not one is left out, never guessed. */
export const StartedCodeReader: Reader<StartedCode> = { parse(value: unknown): StartedCode {
 const answer = TaskResponseReaderSchema.parse(value), body = value as { sessionId?: unknown; sessionUrl?: unknown };
 const session = SessionIdSchema.safeParse(body.sessionId ?? (answer.task as { sessionId?: unknown }).sessionId);
 if (!session.success) return answer;
 return { ...answer, sessionId: session.data, ...(typeof body.sessionUrl === "string" && body.sessionUrl.length <= 2048 ? { sessionUrl: body.sessionUrl } : {}) };
} };

/** Plain words for the route's fixed error codes. Anything else keeps the (already length-limited) message the server sent. */
const MESSAGES: Readonly<Record<string, string>> = {
 PROCESS_UNAVAILABLE: PROCESS_START_REFUSED_MESSAGE,
 PROJECT_NOT_FOUND: "This project wasn't found, or you no longer have access.",
 NOT_FOUND: "This project wasn't found, or you no longer have access.",
 FORBIDDEN: "You don't have permission to start work on this project.",
 CONFIG_INVALID: "Rovara couldn't read that request. Describe the work in 4000 characters or fewer.",
 IDEMPOTENCY_CONFLICT: "That request was already sent with different text. Start it again.",
 RUNTIME_UNAVAILABLE: "Rovara can't start work right now. Try again shortly.",
};

/** `POST /v1/app/projects/{project}/code`: describe the work and the project's own process runs it. */
export function createCodeApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  /** One request id per attempt at the same text: pass the same `requestId` to retry it. */
  async startCode(project: string, text: string, requestId: string = crypto.randomUUID()): Promise<SendResult<StartedCode>> {
   const name = ProjectOverviewProjectSchema.shape.name.parse(project);
   if (!text.trim() || text.length > CODE_TEXT_MAX) throw new ApiError(400, "INVALID_INPUT", "Describe the work in 4000 characters or fewer.");
   try { return await api.send("POST", "/v1/app/projects/" + encodeURIComponent(name) + "/code", { requestId, input: { text } }, StartedCodeReader); }
   catch (failure) {
    const message = failure instanceof ApiError ? MESSAGES[failure.code] : undefined;
    throw failure instanceof ApiError && message !== undefined ? new ApiError(failure.status, failure.code, message) : failure;
   }
  },
 };
}
