// L4-MF1 (lead 4, missing Code features the Cloud website calls): two reads of the project page that had no route at all and answered 501 NOT_ON_CODE_YET.
//
//   GET  /v1/app/projects/{p}/environment-image -> Code GET /v1/app/projects/{p}/environment-image  (SavedEnvPanelSchema, contracts app-saved-env.ts), as the person
//   POST /v1/app/projects/{p}/start-preview     -> answered here: 200 { orgId, project, kind: "unknown" }                       (TaskStopStartPreviewSchema)
//
// The saved environment image read (Code PR "l4-env-image-read"): Code decides who may read, from the person's live project grant in their company, and answers
// one 404 "project not found" for a project they may not read, another company's project and a missing one alike. With saved environments off for the install
// (hosted today: no image registry) Code answers a plain 404 "Saved environments are off for this install", never made-up data; the panel shows nothing for it,
// as its own file says. Reset and the setting are NOT forwarded (Code serves neither on the deployed API; its panel answers canReset false).
//
// Rules for the read:
//   - Cloud adds no rule of its own that could widen Code's: no company, person or role check here, no fallback, no cached answer. It only refuses earlier, in fixed
//     words, a project name Code would never take. The browser's query never reaches Code; the project name goes only into Code's path.
//   - The answer is rebuilt from the panel's known fields only, each checked (fixed words for the health, the reasons and the failure; times as ISO times; whole
//     numbers), and it is refused whole when anything is off ("unreadable is refusal"). It carries no digest, repository, command, secret or free text.
//   - Until Code serves the route (an older Code's unknown-route 404 "route not found", the core host's "not on the core engine on this install yet" 404, or a 501) the
//     app gets 501 NOT_ON_CODE_YET in Cloud's fixed words. Code's "off" and "project not found" 404s reach the app as 404 in the same fixed words.
//
// Start preview (advisory, never a reservation): Rovara Code keeps no per-task spending stop (its calculator has no stored company default, ceiling, project or agent
// stop), and the budget engine and its caps stay Cloud's, so Cloud answers `unknown` until it computes the stop from its own spend settings. The page shows that
// plainly. Only a person who may use the project (Code's access check, made now, names it) gets an answer: any other project is the one 404; the company in the answer
// is the one Code's access check names, never the browser's. The body is `{}` (a request id and a path word are accepted, nothing else).
// cloud-server takes no package dependency, so the shapes are checked here by hand against contracts app-saved-env.ts (a unit test pins the words).
import { CodeError } from "./code-client.js";
import { companyCaller, refused } from "./company-caller.js";
import type { Route, RouteAnswer } from "./routes.js";

/** Code's project name pattern on this route (core-host dev-routes.ts SAVED_ENV_IMAGE). */
const CODE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** Cloud's own project name pattern (the start preview is answered from the person's project list). */
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** Code's fixed 404 words for these two answers (core-host dev-routes.ts SAVED_ENV_OFF, PROJECT_NOT_FOUND). */
const CODE_SAVED_ENV_OFF = "Saved environments are off for this install";
const CODE_PROJECT_NOT_FOUND = "project not found";

export const SAVED_ENV_REBUILD_REASONS = Object.freeze(["no_image", "key_changed", "max_age", "stale", "reset"] as const);
export const SAVED_ENV_FAILURES = Object.freeze([
  "not_proved", "not_approved", "not_fresh", "not_default_branch", "secrets_found", "unsafe_tree", "no_push_session", "build_failed", "push_failed", "digest_mismatch", "base_not_pinned", "prove_failed", "fresh_sandbox_failed",
  "wrong_commits", "wrong_manifest", "wrong_repository", "repository_mismatch", "failed",
] as const);
/** The top-level fields of SavedEnvPanelSchema. */
export const SAVED_ENV_PANEL_FIELDS = Object.freeze(["health", "image", "rebuild", "lastRebuildReason", "lastFailure", "canReset", "enabled", "canChangeSetting"] as const);

const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const SAVED_ENV_ANSWERS = Object.freeze({
  off: answer(404, "NOT_FOUND", CODE_SAVED_ENV_OFF),
  notFound: answer(404, "NOT_FOUND", CODE_PROJECT_NOT_FOUND),
  notYet: answer(501, "NOT_ON_CODE_YET", "Saved environments aren't available on this Rovara yet."),
  unreadable: answer(502, "RUNTIME_UNAVAILABLE", "The saved environment could not be read just now. Try again."),
  invalid: answer(400, "CONFIG_INVALID", "the request is not valid"),
  projectNotFound: answer(404, "PROJECT_NOT_FOUND", "That project doesn't exist, or you can't use it."),
});
const A = SAVED_ENV_ANSWERS;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const oneOf = (value: unknown, words: readonly string[]): boolean => typeof value === "string" && words.includes(value);
const when = (value: unknown): boolean => typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
const exactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

/** Code's panel, kept to its own fields, or undefined when anything does not read. Never a part of it. */
export function savedEnvPanel(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  // Unknown fields are refused whole (not dropped): a newer Code's change is read when this file is, never half-shown.
  if (!exactly(raw, SAVED_ENV_PANEL_FIELDS)) return undefined;
  if (!oneOf(raw["health"], ["never_proved", "healthy", "needs_repair"]) || typeof raw["canReset"] !== "boolean") return undefined;
  if (raw["enabled"] !== undefined && typeof raw["enabled"] !== "boolean") return undefined;
  if (raw["canChangeSetting"] !== undefined && typeof raw["canChangeSetting"] !== "boolean") return undefined;
  const image = raw["image"], rebuild = raw["rebuild"], failure = raw["lastFailure"];
  if (image !== undefined && !(isRecord(image) && exactly(image, ["builtAt", "ageDays", "status"]) && when(image["builtAt"]) && Number.isSafeInteger(image["ageDays"]) && (image["ageDays"] as number) >= 0 && oneOf(image["status"], ["ready", "stale"]))) return undefined;
  if (rebuild !== undefined && !(isRecord(rebuild) && exactly(rebuild, ["state", "reason"]) && oneOf(rebuild["state"], ["queued", "running"]) && oneOf(rebuild["reason"], SAVED_ENV_REBUILD_REASONS))) return undefined;
  if (raw["lastRebuildReason"] !== undefined && !oneOf(raw["lastRebuildReason"], SAVED_ENV_REBUILD_REASONS)) return undefined;
  if (failure !== undefined && !(isRecord(failure) && exactly(failure, ["at", "reason"]) && when(failure["at"]) && oneOf(failure["reason"], SAVED_ENV_FAILURES))) return undefined;
  return Object.fromEntries(SAVED_ENV_PANEL_FIELDS.filter((field) => raw[field] !== undefined).map((field) => [field, raw[field]]));
}

/** Code's 404 messages that mean "this Code does not serve the route yet" (an older Code's unknown route, the core host's "not on the core engine on this install yet"). */
const CODE_NOT_YET: ReadonlySet<string> = new Set(["route not found", "That is not on the core engine on this install yet."]);
function notYetFromCode(error: CodeError): boolean {
  if (error.status === 501) return true;
  if (error.status !== 404) return false;
  const said = codeMessage(error);
  return said !== undefined && said.code === "NOT_FOUND" && typeof said.message === "string" && CODE_NOT_YET.has(said.message);
}

/** Code's body for a CodeError, if it is the standard `{ error: { code, message } }`. */
function codeMessage(error: CodeError): { code: unknown; message: unknown } | undefined {
  const body = isRecord(error.body) && isRecord(error.body["error"]) ? error.body["error"] : undefined;
  return body === undefined ? undefined : { code: body["code"], message: body["message"] };
}

export const SAVED_ENV_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/environment-image$/u,
    answer: async ({ client, session, params }) => {
      const project = params[0]!;
      if (!CODE_PROJECT_NAME.test(project)) return A.notFound;
      let raw: unknown;
      try {
        raw = await client.json<unknown>(session, `/v1/app/projects/${encodeURIComponent(project)}/environment-image`);
      } catch (error) {
        if (error instanceof CodeError) {
          if (notYetFromCode(error)) return A.notYet;
          const said = error.status === 404 ? codeMessage(error) : undefined;
          // Code's own two 404s, in Cloud's fixed words (the same words); any other 404 reads as a missing project.
          if (said !== undefined && said.code === "NOT_FOUND" && said.message === CODE_SAVED_ENV_OFF) return A.off;
          if (error.status === 404) return A.notFound;
        }
        throw error;
      }
      const panel = savedEnvPanel(raw);
      return panel === undefined ? A.unreadable : { status: 200, body: panel };
    },
  },
  {
    method: "POST", path: /^\/projects\/([^/]+)\/start-preview$/u,
    answer: async (context) => {
      const project = context.params[0]!;
      if (!PROJECT_NAME.test(project)) return A.projectNotFound;
      const body = context.body === undefined || context.body === null ? {} : context.body;
      if (!isRecord(body) || !exactly(body, ["requestId", "path"]) || (body["requestId"] !== undefined && !(typeof body["requestId"] === "string" && UUID.test(body["requestId"]))) || (body["path"] !== undefined && !oneOf(body["path"], ["QUICK", "FULL"]))) return A.invalid;
      const who = await companyCaller(context);
      if (refused(who)) return who;
      // Only a project the person may use (their project list, from Code's access check made now); anything else is the one 404.
      if (!who.access.projects.some((one) => one.name === project)) return A.projectNotFound;
      return { status: 200, body: { orgId: who.companyId, project, kind: "unknown" } };
    },
  },
];
