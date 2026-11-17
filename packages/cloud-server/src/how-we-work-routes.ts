// The project page's How we work tab (staging walkthrough 2026-11-17, item 4): its one read, answered from Rovara Code's own route as the signed-in person,
// with their own token.
//
//   GET /v1/app/projects/{p}/how-we-work  ->  Code GET /v1/app/projects/{p}/how-we-work  (HowWeWorkViewSchema, contracts how-we-work.ts)
//
// Code serves it read only (code/next packages/broker/src/core-host/dev-routes.ts PLAYBOOK, scope "full"): Code decides who may read, from the person's live
// project grant, and answers one 404 "project not found" for a project they may not read, another company's project and a missing one alike.
//
// Rules:
//   - Cloud adds no rule of its own that could widen Code's: no company, person or role check here, no fallback, no cached answer. It only refuses earlier, in
//     fixed words, a project name Code would never take (Code's own name pattern), so such a name never reaches Code.
//   - The browser's query never reaches Code; the project name goes only into Code's path.
//   - Code's answer must name THIS project, or it is refused whole ("unreadable is refusal"). Only the view's own top-level fields go on; the app reads the
//     whole view with the contract's strict reader (HowWeWorkViewReaderSchema) and draws every text as plain text.
//   - Until Code serves the route (an older Code's unknown-route 404 "route not found", or the core host's "not on the core engine on this install yet" 404),
//     the app gets 501 NOT_ON_CODE_YET in Cloud's fixed words. Every other refusal of Code reaches the app as Code worded it (the handler does that).
// cloud-server takes no package dependency, so the field names are repeated from contracts how-we-work.ts; a unit test pins them.
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer } from "./routes.js";

/** Code's project name pattern on this route (dev-routes.ts PLAYBOOK). */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** The top-level fields of HowWeWorkViewSchema. */
export const HOW_WE_WORK_FIELDS = Object.freeze(["project", "playbookRevision", "process", "stages", "rules", "modelsEditable"] as const);
/** Code's 404 messages that mean "this Code does not serve the route yet". */
const CODE_NOT_YET: ReadonlySet<string> = new Set(["route not found", "That is not on the core engine on this install yet."]);

const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const HOW_WE_WORK_ANSWERS = Object.freeze({
  notFound: answer(404, "NOT_FOUND", "project not found"),
  notYet: answer(501, "NOT_ON_CODE_YET", "How we work isn't available on this Rovara yet."),
  unreadable: answer(502, "RUNTIME_UNAVAILABLE", "How we work could not be read just now. Try again."),
});
const A = HOW_WE_WORK_ANSWERS;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a Code refusal says the route is not served yet (and nothing else). */
export function codeNotYet(error: CodeError): boolean {
  if (error.status === 501) return true;
  if (error.status !== 404) return false;
  const body = isRecord(error.body) && isRecord(error.body["error"]) ? error.body["error"] : undefined;
  return body !== undefined && body["code"] === "NOT_FOUND" && typeof body["message"] === "string" && CODE_NOT_YET.has(body["message"]);
}

/** Code's view, kept to its own fields, or undefined when it does not name `project`. */
export function howWeWorkView(raw: unknown, project: string): Record<string, unknown> | undefined {
  if (!isRecord(raw) || raw["project"] !== project) return undefined;
  return Object.fromEntries(HOW_WE_WORK_FIELDS.filter((field) => Object.hasOwn(raw, field)).map((field) => [field, raw[field]]));
}

export const HOW_WE_WORK_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/how-we-work$/u,
    answer: async ({ client, session, params }) => {
      const project = params[0]!;
      if (!PROJECT_NAME.test(project)) return A.notFound;
      let raw: unknown;
      try {
        raw = await client.json<unknown>(session, `/v1/app/projects/${encodeURIComponent(project)}/how-we-work`);
      } catch (error) {
        if (error instanceof CodeError && codeNotYet(error)) return A.notYet;
        throw error;
      }
      const view = howWeWorkView(raw, project);
      return view === undefined ? A.unreadable : { status: 200, body: view };
    },
  },
];
