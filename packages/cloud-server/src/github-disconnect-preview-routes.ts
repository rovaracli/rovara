import { z } from "zod";
import { AgentXNameSchema } from "@agentx/contracts";
import { CodeError, SignInEnded, MERGE_RECEIPT_CALL_MS, MERGE_RECEIPT_MAX_BYTES } from "./code-client.js";
import type { Route, RouteAnswer } from "./routes.js";

const ON_THE_WEBSITE_MESSAGE = "Do this on the Rovara website: the command line and AI tools cannot make this change.";
const Target = z.object({ installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const Input = z.object({ provider: z.literal("github"), operation: z.literal("disconnect"), target: Target }).strict();
const Unknown = z.object({ kind: z.literal("unknown"), reason: z.literal("not_projected") }).strict();
const Blockers = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), count: z.number().int().min(0).max(400), projects: z.array(AgentXNameSchema).max(400) }).strict().refine(row => row.count === row.projects.length && new Set(row.projects).size === row.projects.length && row.projects.every((name, index) => index === 0 || row.projects[index - 1]! < name)),
  z.object({ kind: z.literal("unknown"), reason: z.enum(["read_bound", "read_unavailable"]) }).strict(),
]);
const Reply = Input.extend({ checkedAt: z.iso.datetime(), snapshot: z.literal("non_atomic"), disconnectBlockers: Blockers, repositories: Unknown, runningTasks: Unknown, queuedTasks: Unknown }).strict();
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
const failure = (status: number, code: string, message = "GitHub disconnect preview is unavailable."): RouteAnswer => ({ status, body: { error: { code, message } } });
function refused(error: unknown): RouteAnswer {
  if (error instanceof SignInEnded) throw error;
  if (!(error instanceof CodeError)) return failure(503, "RUNTIME_UNAVAILABLE");
  if (error.status >= 200 && error.status < 300) return failure(502, "INVALID_RESPONSE");
  const parsed = ErrorBody.safeParse(error.body);
  if (parsed.success) {
    const { code, message } = parsed.data.error;
    if (error.status === 404 && code === "NOT_FOUND" && message === "That GitHub connection was not found.") return failure(404, code, message);
    if (error.status === 400 && code === "CONFIG_INVALID" && message === "That disconnect preview is invalid.") return failure(400, code, message);
    if (error.status === 403 && code === "FORBIDDEN" && (message === "Only a company owner can disconnect GitHub." || message === ON_THE_WEBSITE_MESSAGE)) return failure(403, code, message);
  }
  if (error.status === 401) return failure(401, "AUTH_REQUIRED", "Sign in to continue.");
  if (error.status === 403) return failure(403, "FORBIDDEN", "You cannot preview this connection.");
  if (error.status === 429) return failure(429, "RATE_LIMITED", "Please wait a moment and try again.");
  return failure(503, "RUNTIME_UNAVAILABLE");
}
export const GITHUB_DISCONNECT_PREVIEW_ROUTES: Route[] = [
  { method: "POST", path: /^\/github\/disconnect-preview$/u, answer: async context => {
    const input = Input.safeParse(context.body);
    if (!input.success || context.query.size !== 0) return failure(400, "CONFIG_INVALID", "That disconnect preview is invalid.");
    const deadlineMs = context.serverReadDeadline === undefined ? MERGE_RECEIPT_CALL_MS : context.serverReadDeadline - Date.now();
    if (deadlineMs <= 0) return failure(503, "RUNTIME_UNAVAILABLE");
    let value: unknown;
    try {
      value = await context.client.json<unknown>(context.session, "/v1/dev/company/connections/impact", {
        method: "POST", body: input.data, expectedStatus: 200, boundedRead: { deadlineMs, maxBytes: MERGE_RECEIPT_MAX_BYTES },
      });
    } catch (error) { return refused(error); }
    const reply = Reply.safeParse(value);
    return !reply.success || reply.data.target.installationId !== input.data.target.installationId ? failure(502, "INVALID_RESPONSE") : { status: 200, body: reply.data };
  } },
];
