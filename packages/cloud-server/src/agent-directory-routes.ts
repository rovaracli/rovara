// Lead 4 L4-MF3 (owner decision, 2026-11-17): the company-wide agent directory, answered from Rovara Code's directory route as the signed-in person, with their own token.
//
//   GET /v1/app/agents?scope=all|mine|shared|builtin  -> Code GET /v1/app/agents?scope=...   ({ agents: AgentView[] }, contracts agent-web-views.ts AgentDirectoryResponseSchema)
//
// Rules:
//   - Only a company owner or administrator reads it. Cloud asks Code who the person is and their role in their company NOW (the access check, never the stored sign-in, a cookie or the browser);
//     anyone else gets one fixed 403 without Code being asked for the directory. Code checks the same rule itself on every call (its live membership), so Cloud's check only refuses earlier:
//     nothing here can widen what Code allows.
//   - The browser never names a company, a person or a Code id. Only `scope` (one of the four words, once) goes into Code's query; a project's list (`project=`) is not served; any other query is refused
//     without asking Code.
//   - Every agent is rebuilt field by field from what Code sent (an unknown field is dropped, never passed on) and must read: an id, status or access outside its set, a developer id that is not a
//     hash, a number out of bounds, a control character in a name, a repeated agent id or more agents than Code's bound is "unreadable", and the whole read is refused (never a shorter list).
//   - Agent names and descriptions are untrusted data: plain characters here, drawn by the app as text.
//   - Code's refusals reach the app as Cloud's fixed sentences, never Code's own text and never an echo of the browser's input or the cause. Until Code serves the route, its fixed unknown-route 404
//     reads "isn't available on this Rovara yet" (501 NOT_ON_CODE_YET).
// cloud-server takes no package dependency, so the shape is checked here by hand against contracts agent-web-views.ts (the limits are repeated and a unit test pins them).
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const AGENT_DIRECTORY_WORDS = Object.freeze({
  forbidden: "Only an owner or an administrator of the company can see the company's agents.",
  invalid: "That is not an agent view this directory offers.",
  notYet: "The agent directory isn't available on this Rovara yet.",
  projectNotHere: "A project's agent list isn't available yet.",
  unavailable: "The agent directory could not be read just now. Try again.",
});
const W = AGENT_DIRECTORY_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const AGENT_DIRECTORY_ANSWERS = Object.freeze({
  forbidden: answer(403, "FORBIDDEN", W.forbidden),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  projectNotHere: answer(501, "NOT_ON_CODE_YET", W.projectNotHere),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
});
const A = AGENT_DIRECTORY_ANSWERS;

export const AGENT_SCOPES = Object.freeze(["all", "mine", "shared", "builtin"] as const);
/** Code's bound on the custom agents one answer lists (500) plus the six built-ins. */
export const AGENT_DIRECTORY_LIMIT = 506;
const BUILTIN_IDS = ["rovara-code", "ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"] as const;
const AGENT_ID = /^agt_[0-9a-z]{20}$/u;
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const NEWLINES_OK = /^(?:[^\p{Cc}\p{Cf}]|[\n\t])*$/u;
const LEVELS = ["none", "view", "use", "edit", "manage"] as const;
const STATUSES = ["active", "archived"] as const;
export const AGENT_LIMITS = Object.freeze({ name: 200, description: 2000, line: 300, version: 1_000_000, usd: 1_000_000_000 } as const);

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const oneOf = <T extends string>(value: unknown, words: readonly T[]): value is T => typeof value === "string" && (words as readonly string[]).includes(value);
const line = (value: unknown, max: number, min = 1): value is string => typeof value === "string" && value.length >= min && value.length <= max && !CONTROL.test(value);
const prose = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && NEWLINES_OK.test(value);
const whole = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const usd = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= AGENT_LIMITS.usd;
const when = (value: unknown): value is string => typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));

/** Not a readable answer: the whole read is refused, never a part of it. */
export class Unreadable extends Error {}
function need<T>(ok: boolean, value: T): T { if (!ok) throw new Unreadable(); return value; }
const rec = (value: unknown): Plain => need(plain(value), value as Plain);
const opt = <T>(value: unknown, check: (one: unknown) => boolean, key: string): Record<string, T> => (value === undefined ? {} : { [key]: need(check(value), value as T) });
const agentIdOk = (value: unknown): boolean => oneOf(value, BUILTIN_IDS) || (typeof value === "string" && AGENT_ID.test(value));
const versionOk = (value: unknown): boolean => whole(value, 1, AGENT_LIMITS.version);

const developerIdOf = (value: unknown): string => need(typeof value === "string" && DEVELOPER_ID.test(value), value as string);

function ownerOf(value: unknown): Plain {
  const f = rec(value);
  if (f["kind"] === "member") return { kind: "member", developerId: developerIdOf(f["developerId"]) };
  return { kind: "project", project: need(f["kind"] === "project" && typeof f["project"] === "string" && PROJECT_NAME.test(f["project"]), f["project"]) };
}

function agentOf(value: unknown): Plain {
  const f = rec(value);
  const updateAvailable = f["updateAvailable"] === undefined ? undefined : rec(f["updateAvailable"]);
  const base = f["extends"] === undefined ? undefined : rec(f["extends"]);
  return {
    agentId: need(agentIdOk(f["agentId"]), f["agentId"]), name: need(line(f["name"], AGENT_LIMITS.name), f["name"]), description: need(prose(f["description"], AGENT_LIMITS.description), f["description"]),
    builtin: need(typeof f["builtin"] === "boolean", f["builtin"]), access: need(oneOf(f["access"], LEVELS), f["access"]), status: need(oneOf(f["status"], STATUSES), f["status"]),
    latestVersion: need(whole(f["latestVersion"], 0, AGENT_LIMITS.version), f["latestVersion"]),
    ...(f["owner"] === undefined ? {} : { owner: ownerOf(f["owner"]) }),
    ...(f["accountable"] === undefined ? {} : { accountable: { developerId: developerIdOf(rec(f["accountable"])["developerId"]) } }),
    ...opt<number>(f["currentVersion"], versionOk, "currentVersion"), ...opt<number>(f["pinnedVersion"], versionOk, "pinnedVersion"), ...opt<number>(f["draftRevision"], versionOk, "draftRevision"),
    ...opt<number>(f["monthlyBudgetUsd"], usd, "monthlyBudgetUsd"), ...opt<number>(f["maxPerRunUsd"], usd, "maxPerRunUsd"),
    ...opt<string>(f["createdBy"], (one) => line(one, AGENT_LIMITS.line), "createdBy"), ...opt<string>(f["createdAt"], when, "createdAt"), ...opt<string>(f["updatedAt"], when, "updatedAt"),
    ...opt<boolean>(f["disabled"], (one) => typeof one === "boolean", "disabled"), ...opt<string>(f["needsLaterConnectors"], (one) => line(one, AGENT_LIMITS.line), "needsLaterConnectors"),
    ...(base === undefined ? {} : { extends: { agentId: need(agentIdOk(base["agentId"]), base["agentId"]), version: need(versionOk(base["version"]), base["version"]) } }),
    ...(updateAvailable === undefined ? {} : { updateAvailable: { from: need(versionOk(updateAvailable["from"]), updateAvailable["from"]), to: need(versionOk(updateAvailable["to"]), updateAvailable["to"]) } }),
  };
}

/** Code's directory answer rebuilt from its known fields; throws `Unreadable` for anything else. */
export function directoryAnswer(value: unknown): Plain {
  const body = rec(value);
  need(Array.isArray(body["agents"]) && body["agents"].length <= AGENT_DIRECTORY_LIMIT, body["agents"]);
  const agents = (body["agents"] as unknown[]).map(agentOf);
  need(new Set(agents.map((agent) => agent["agentId"])).size === agents.length, agents);
  return { agents };
}

/** Code's refusal in Cloud's fixed words. Only Code's exact unknown-route 404 means "not on Code yet". */
export function agentDirectoryRefusal(error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  if (error.status === 404) return body?.["code"] === "NOT_FOUND" && body["message"] === "route not found" ? A.notYet : A.unavailable;
  if (error.status === 403) return A.forbidden;
  if (error.status === 400) return A.invalid;
  return A.unavailable;
}

/** The view the query asks for: `scope` once, one of the four words, and nothing else; a project's list is not served. */
function scopeOf(query: URLSearchParams): { scope: (typeof AGENT_SCOPES)[number] } | { refusal: RouteAnswer } {
  if (query.has("project")) return { refusal: A.projectNotHere };
  const keys = [...query.keys()];
  if (keys.some((key) => key !== "scope") || query.getAll("scope").length > 1) return { refusal: A.invalid };
  const scope = query.get("scope") ?? "all";
  return oneOf(scope, AGENT_SCOPES) ? { scope } : { refusal: A.invalid };
}

async function read(context: RouteContext): Promise<RouteAnswer> {
  let who: Awaited<ReturnType<typeof companyCaller>>;
  try {
    who = await companyCaller(context);
  } catch (error) {
    if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
    if (error instanceof CodeError) return A.unavailable;
    throw error;
  }
  if (refused(who)) return who;
  // The role is Code's answer now. Anyone else is refused here without asking for the directory (Code refuses them too).
  if (!isCompanyAdmin(who.companyRole)) return A.forbidden;
  const at = scopeOf(context.query);
  if ("refusal" in at) return at.refusal;
  let got: unknown;
  try {
    got = await context.client.json<unknown>(context.session, `/v1/app/agents?scope=${at.scope}`);
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) return agentDirectoryRefusal(error);
    throw error;
  }
  try { return { status: 200, body: directoryAnswer(got) }; } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
}

export const AGENT_DIRECTORY_ROUTES: Route[] = [{ method: "GET", path: /^\/agents$/u, answer: read }];
