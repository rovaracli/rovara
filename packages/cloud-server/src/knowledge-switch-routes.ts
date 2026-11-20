// L4-JA7 (journey audit B7), Cloud's half: the company's "Knowledge stays in Rovara" and a project's "local coding tools can fetch lessons", passed to Rovara Code as the signed-in person with their own token.
// Rovara Code owns the rule and the data; Cloud passes the call through and shows Code's answer in its own fixed shape.
//
//   GET /v1/app/company/lessons/local-tools                       Code GET /v1/dev/company/lessons/local-tools                    { stays }                                  an owner or admin of the company
//   PUT /v1/app/company/lessons/local-tools  { stays }            Code PUT /v1/dev/company/lessons/local-tools                    { stays }                                  an owner or admin of the company
//   GET /v1/app/projects/{p}/lessons/local-tools                  Code GET /v1/dev/projects/{p}/lessons/local-tools               { enabled, own?, reason?, preset, companyStays, canChange }
//   PUT /v1/app/projects/{p}/lessons/local-tools  { enabled }     Code PUT /v1/dev/projects/{p}/lessons/local-tools               the same; the project's admin, or a company owner or admin
//
// Rules:
//   - Code decides who the person is (their company from live membership), their role and who may change what; Cloud adds no rule that could widen it. Cloud sends no company, person, role or query: the path names
//     the project (a name in Cloud's shared project grammar; Code checks its own and answers 404 for any other), the body is checked here and only `{ stays }` or `{ enabled }` goes on (a body with anything else is refused without asking Code).
//   - Code's answer is rebuilt in this fixed shape: a missing or wrongly typed field makes the whole read unreadable (503), never a guess. A `reason` a newer Code added is left out (the screen then says nothing about why).
//   - Code's own words never reach the browser: every refusal is Cloud's fixed sentence. Code answers 404 "route not found", 405 or 501 while it does not serve the routes: that is "not connected yet" (501 NOT_ON_CODE_YET),
//     which the settings screens read as "hide the setting".
//   - The logs say what was done (the status of a refusal; whether a setting was changed to on or off), never a person, a project or anything the person wrote.
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import { PROJECT, dev, isRecord } from "./lessons-routes.js";
import type { Route, RouteAnswer } from "./routes.js";

/** Cloud's fixed words for these two settings. */
export const KNOWLEDGE_SWITCH_WORDS = Object.freeze({
  companyForbidden: "Only company owners and admins can change whether knowledge stays in Rovara.",
  projectForbidden: "Only this project's admins, and company owners and admins, can change this.",
  notFound: "project not found",
  notYet: "This setting isn't available on this Rovara yet.",
  unavailable: "That setting could not be reached just now. Try again in a moment.",
  invalid: "Choose on or off.",
  noRecord: "That could not be recorded, so nothing was changed. Try again.",
  signedOut: "Sign in to continue.",
});
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
const A = Object.freeze({
  companyForbidden: answer(403, "FORBIDDEN", KNOWLEDGE_SWITCH_WORDS.companyForbidden),
  projectForbidden: answer(403, "FORBIDDEN", KNOWLEDGE_SWITCH_WORDS.projectForbidden),
  notFound: answer(404, "NOT_FOUND", KNOWLEDGE_SWITCH_WORDS.notFound),
  notYet: answer(501, "NOT_ON_CODE_YET", KNOWLEDGE_SWITCH_WORDS.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", KNOWLEDGE_SWITCH_WORDS.unavailable),
  invalid: answer(400, "CONFIG_INVALID", KNOWLEDGE_SWITCH_WORDS.invalid),
  noRecord: answer(503, "AUDIT_UNAVAILABLE", KNOWLEDGE_SWITCH_WORDS.noRecord),
  signedOut: answer(401, "AUTH_REQUIRED", KNOWLEDGE_SWITCH_WORDS.signedOut),
});

const CODE_COMPANY = "/v1/dev/company/lessons/local-tools";
const codeProject = (project: string): string => `${dev(project)}/lessons/local-tools`;
export const LOCAL_TOOLS_REASONS = ["company_stays", "regulated", "project_setting"] as const;
export const LOCAL_TOOLS_PRESETS = ["standard", "regulated"] as const;
export interface LocalToolsRead { enabled: boolean; own?: boolean; reason?: (typeof LOCAL_TOOLS_REASONS)[number]; preset: (typeof LOCAL_TOOLS_PRESETS)[number]; companyStays: boolean; canChange: boolean }

/** The company's answer rebuilt as `{ stays }`, or undefined when it is not exactly a boolean. */
export function companyAnswer(value: unknown): { stays: boolean } | undefined {
  return isRecord(value) && typeof value["stays"] === "boolean" ? { stays: value["stays"] } : undefined;
}

/** A project's answer rebuilt from the fields the screen draws, or undefined when a needed one is missing or of the wrong type. An unknown `reason` is left out. */
export function projectAnswer(value: unknown): LocalToolsRead | undefined {
  if (!isRecord(value)) return undefined;
  const { enabled, own, reason, preset, companyStays, canChange } = value;
  if (typeof enabled !== "boolean" || typeof companyStays !== "boolean" || typeof canChange !== "boolean") return undefined;
  if (typeof preset !== "string" || !(LOCAL_TOOLS_PRESETS as readonly string[]).includes(preset)) return undefined;
  if (own !== undefined && typeof own !== "boolean") return undefined;
  const known = typeof reason === "string" && (LOCAL_TOOLS_REASONS as readonly string[]).includes(reason) ? reason as (typeof LOCAL_TOOLS_REASONS)[number] : undefined;
  return { enabled, ...(own === undefined ? {} : { own }), ...(known === undefined ? {} : { reason: known }), preset: preset as (typeof LOCAL_TOOLS_PRESETS)[number], companyStays, canChange };
}

const bodyOf = (body: unknown, key: "stays" | "enabled"): boolean | undefined => (isRecord(body) && Object.keys(body).length === 1 && typeof body[key] === "boolean" ? body[key] : undefined);

/** Code's refusal in Cloud's fixed words. */
export function knowledgeSwitchRefusal(error: CodeError, scope: "company" | "project"): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const body = isRecord(error.body) && isRecord(error.body["error"]) ? error.body["error"] : undefined;
  const code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  console.log(JSON.stringify({ event: "cloud.knowledge_switch_refused", scope, status: error.status }));
  if (error.status === 401) return A.signedOut;
  if (error.status === 405 || error.status === 501) return A.notYet;
  if (error.status === 404) return code === "NOT_FOUND" && body?.["message"] === "route not found" ? A.notYet : A.notFound;
  if (error.status === 403) return scope === "company" ? A.companyForbidden : A.projectForbidden;
  if (error.status === 400) return A.invalid;
  if (code === "AUDIT_UNAVAILABLE") return A.noRecord;
  return A.unavailable;
}

type Context = Parameters<Route["answer"]>[0];
async function pass(context: Context, scope: "company" | "project", path: string, init: { method?: string; body?: unknown } = {}): Promise<RouteAnswer> {
  let got: unknown;
  try {
    got = await context.client.json<unknown>(context.session, path, init);
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) return knowledgeSwitchRefusal(error, scope);
    throw error;
  }
  const rebuilt = scope === "company" ? companyAnswer(got) : projectAnswer(got);
  if (rebuilt === undefined) {
    console.log(JSON.stringify({ event: "cloud.knowledge_switch_unreadable", scope }));
    return A.unavailable;
  }
  if (init.method === "PUT") console.log(JSON.stringify({ event: "cloud.knowledge_switch_changed", scope, on: scope === "company" ? (rebuilt as { stays: boolean }).stays : (rebuilt as LocalToolsRead).enabled }));
  return { status: 200, body: rebuilt };
}

const nothingElse = (context: Context): boolean => [...context.query.keys()].length === 0;

export const KNOWLEDGE_SWITCH_ROUTES: Route[] = [
  { method: "GET", path: /^\/company\/lessons\/local-tools$/u, answer: async (context) => (nothingElse(context) ? pass(context, "company", CODE_COMPANY) : A.invalid) },
  {
    method: "PUT", path: /^\/company\/lessons\/local-tools$/u,
    answer: async (context) => {
      const stays = bodyOf(context.body, "stays");
      if (stays === undefined || !nothingElse(context)) return A.invalid;
      return pass(context, "company", CODE_COMPANY, { method: "PUT", body: { stays } });
    },
  },
  { method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/local-tools$`, "u"), answer: async (context) => (nothingElse(context) ? pass(context, "project", codeProject(context.params[0]!)) : A.invalid) },
  {
    method: "PUT", path: new RegExp(`^/projects/${PROJECT}/lessons/local-tools$`, "u"),
    answer: async (context) => {
      const enabled = bodyOf(context.body, "enabled");
      if (enabled === undefined || !nothingElse(context)) return A.invalid;
      return pass(context, "project", codeProject(context.params[0]!), { method: "PUT", body: { enabled } });
    },
  },
];
