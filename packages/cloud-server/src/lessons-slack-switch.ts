// L4-SRC-SL: the person's own "Don't learn from my Slack messages" switch, Cloud's half. A signed-in person reads and sets their OWN switch; Rovara Code owns the rule and the data (a row per person in their company),
// Cloud passes the call through as the person and shows Code's answer in its own fixed shape.
//
//   GET /v1/app/me/lessons-slack                 (the browser's GET /v1/web/me/lessons-slack)   Code's GET /v1/dev/me/lessons-slack as the person: { optOut: boolean }
//   PUT /v1/app/me/lessons-slack  { optOut }     (the browser's PUT /v1/web/me/lessons-slack)   Code's PUT /v1/dev/me/lessons-slack as the person: { optOut: boolean }
//
// Rules: the path and the query of the browser's request are never forwarded and name no person (Code reads the caller from the token Cloud holds for THIS sign-in); the body is checked here and only `{ optOut }` is passed
// on (anything else is refused, so a body can never name another person); Code's answer is rebuilt as `{ optOut }` and nothing else; Code's own words never pass through (a refusal is Cloud's fixed words). Code answers
// 404, 405 or 501 while it does not serve the route: that is "not connected yet" (501 NOT_ON_CODE_YET), which the account page reads as "hide the switch".
import { isCodeOutcomeUnknown, CodeError, type CodeClient } from "./code-client.js";
import { connectRefusal, isObject, type ConnectAnswer } from "./connect-flow.js";
import type { CodeSession } from "./sessions.js";

const CODE_LESSONS_SLACK = "/v1/dev/me/lessons-slack";

/** Cloud's fixed words for this switch. */
export const LESSONS_SLACK_WORDS = Object.freeze({
  notOnCode: "This setting isn't connected to Rovara Code yet.",
  unavailable: "That setting could not be reached just now. Try again in a moment.",
  signedOut: "Sign in to continue.",
  badBody: "Choose on or off.",
});

export interface LessonsSlackSwitchDeps {
  client: CodeClient;
  log: (event: Record<string, unknown>) => void;
}

export function createLessonsSlackSwitch(deps: LessonsSlackSwitchDeps) {
  const optOutOf = (body: unknown): boolean | undefined => (isObject(body) && Object.keys(body).length === 1 && typeof body.optOut === "boolean" ? body.optOut : undefined);

  async function pass(session: CodeSession, method: "GET" | "PUT", body?: { optOut: boolean }): Promise<ConnectAnswer> {
    let answer: unknown;
    try {
      answer = await deps.client.json<unknown>(session, CODE_LESSONS_SLACK, body === undefined ? { method } : { method, body });
    } catch (error) {
      if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
      if (!(error instanceof CodeError)) throw error;
      // A refusal is logged by status only (never Code's words).
      deps.log({ event: "cloud.lessons_slack_switch_refused", method, status: error.status, developerId: session.access.developerId });
      if (error.status === 401) return connectRefusal(401, "AUTH_REQUIRED", LESSONS_SLACK_WORDS.signedOut);
      if (error.status === 404 || error.status === 405 || error.status === 501) return connectRefusal(501, "NOT_ON_CODE_YET", LESSONS_SLACK_WORDS.notOnCode);
      return connectRefusal(503, "RUNTIME_UNAVAILABLE", LESSONS_SLACK_WORDS.unavailable);
    }
    // Code's answer is rebuilt as `{ optOut }`: any other field is dropped, never passed on and never a reason to refuse.
    const optOut = isObject(answer) && typeof answer.optOut === "boolean" ? answer.optOut : undefined;
    if (optOut === undefined) {
      deps.log({ event: "cloud.lessons_slack_switch_unreadable", method, developerId: session.access.developerId });
      return connectRefusal(503, "RUNTIME_UNAVAILABLE", LESSONS_SLACK_WORDS.unavailable);
    }
    return { status: 200, body: { optOut } };
  }

  return {
    /** GET /v1/app/me/lessons-slack */
    read(session: CodeSession): Promise<ConnectAnswer> { return pass(session, "GET"); },
    /** PUT /v1/app/me/lessons-slack: only `{ optOut: boolean }` is accepted and passed on. */
    async write(session: CodeSession, body: unknown): Promise<ConnectAnswer> {
      const optOut = optOutOf(body);
      if (optOut === undefined) return connectRefusal(400, "CONFIG_INVALID", LESSONS_SLACK_WORDS.badBody);
      return pass(session, "PUT", { optOut });
    },
    /** The app route this module answers (the path after /v1/web, which the app calls as /v1/app), or undefined. Only GET and PUT, only this exact path: nothing of the request but the checked switch is forwarded. */
    route(method: string, apiPath: string): ((session: CodeSession, sessionCookie: string, body: unknown) => Promise<ConnectAnswer>) | undefined {
      if (apiPath !== "/me/lessons-slack") return undefined;
      if (method === "GET") return (session) => this.read(session);
      if (method === "PUT") return (session, _id, body) => this.write(session, body);
      return undefined;
    },
  };
}

export type LessonsSlackSwitch = ReturnType<typeof createLessonsSlackSwitch>;
