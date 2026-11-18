import { TicketUpdatesPutBodySchema, TicketUpdatesViewSchema } from "@agentx/contracts";
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer } from "./routes.js";

const PROJECT = "([a-z][a-z0-9-]{0,62})";
export const INTAKE_UPDATES_WORDS = Object.freeze({
  forbidden: "Only project admins can change ticket update settings.",
  notFound: "project not found",
  stale: "Ticket update settings changed. Look again, then try once more.",
  notYet: "Ticket update settings aren't available on this Rovara yet.",
  unavailable: "Ticket update settings couldn't be read just now. Try again.",
  invalid: "Send valid ticket update settings.",
});
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
const A = Object.freeze({
  forbidden: answer(403, "FORBIDDEN", INTAKE_UPDATES_WORDS.forbidden),
  notFound: answer(404, "NOT_FOUND", INTAKE_UPDATES_WORDS.notFound),
  stale: answer(409, "CHANGE_STALE", INTAKE_UPDATES_WORDS.stale),
  notYet: answer(501, "NOT_ON_CODE_YET", INTAKE_UPDATES_WORDS.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", INTAKE_UPDATES_WORDS.unavailable),
  invalid: answer(400, "CONFIG_INVALID", INTAKE_UPDATES_WORDS.invalid),
});
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function refusal(error: unknown): RouteAnswer {
  if (!(error instanceof CodeError)) throw error;
  if (error.status === 405) return A.notYet;
  if (error.status === 404) {
    const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
    return body?.["code"] === "NOT_FOUND" && body["message"] === "route not found" ? A.notYet : A.notFound;
  }
  if (error.status === 403) return A.forbidden;
  if (error.status === 409) return A.stale;
  return A.unavailable;
}
async function callCode(run: () => Promise<unknown>): Promise<unknown> {
  try { return await run(); } catch (error) { return refusal(error); }
}
function isAnswer(value: unknown): value is RouteAnswer {
  return plain(value) && typeof value["status"] === "number" && plain(value["body"]);
}
function parsedAnswer(value: unknown): RouteAnswer {
  const parsed = TicketUpdatesViewSchema.safeParse(value);
  return parsed.success ? { status: 200, body: parsed.data } : A.unavailable;
}
export const INTAKE_UPDATES_ROUTES: Route[] = [
  {
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/intake/updates$`, "u"),
    answer: async ({ client, session, params }) => {
      const value = await callCode(() => client.json<unknown>(session, `/v1/app/projects/${encodeURIComponent(params[0]!)}/intake/updates`));
      return isAnswer(value) ? value : parsedAnswer(value);
    },
  },
  {
    method: "PUT", path: new RegExp(`^/projects/${PROJECT}/intake/updates$`, "u"),
    answer: async ({ client, session, params, body }) => {
      const request = TicketUpdatesPutBodySchema.safeParse(body);
      if (!request.success) return A.invalid;
      const value = await callCode(() => client.json<unknown>(session, `/v1/app/projects/${encodeURIComponent(params[0]!)}/intake/updates`, { method: "PUT", body: request.data }));
      return isAnswer(value) ? value : parsedAnswer(value);
    },
  },
];
