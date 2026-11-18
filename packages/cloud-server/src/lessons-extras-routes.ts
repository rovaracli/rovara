// L4-B12 K1: Cloud forwards the lessons extras as the signed-in person. Code owns membership, role checks and audit;
// each answer is rebuilt field by field so newer Code fields never become app data by accident.
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { PROJECT, LESSON_ID, badRequest, count, dev, isRecord, list, ok, postTo } from "./lessons-routes.js";

const notYet = (name: string): RouteAnswer => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: `${name} isn't available on this Rovara yet.` } } });
const unavailable = (name: string): RouteAnswer => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: `${name} is unavailable right now. Try again.` } } });
function refusal(error: unknown, name: string): RouteAnswer | undefined {
  if (!(error instanceof CodeError)) return undefined;
  const e = isRecord(error.body) && isRecord(error.body["error"]) ? error.body["error"] : undefined;
  if (error.status === 404 && e?.["code"] === "NOT_FOUND" && e["message"] === "route not found") return notYet(name);
  return { status: error.status, body: error.body ?? { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code could not answer." } } };
}
async function read(context: RouteContext, path: string, name: string, build: (raw: unknown) => Record<string, unknown>): Promise<RouteAnswer> {
  try { const raw = await context.client.json<unknown>(context.session, path);const answer = build(raw);return Object.keys(answer).length === 0 ? unavailable(name) : ok(answer); }
  catch (error) { return refusal(error, name) ?? unavailable(name); }
}
function item(raw: unknown, keep: readonly string[]): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keep) {
    const value = raw[key];
    if (key === "cause" || key === "status" || key === "setting") { if (typeof value === "string") out[key] = value; }
    else if (typeof value === "string") out[key] = value.slice(0, 300);
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 50).filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
    else if (isRecord(value)) {
      const nestedKeys = key === "repeat" ? ["matched", "back"] : key === "evidence" ? ["have", "needed", "unit"] : [];
      const nested = Object.fromEntries(nestedKeys.flatMap((nestedKey) => {
        const nestedValue = value[nestedKey];return typeof nestedValue === "string" || typeof nestedValue === "number" || typeof nestedValue === "boolean" ? [[nestedKey, nestedValue]] : [];
      }));
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
  }
  return out;
}
function weekly(raw: unknown, project: string): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw["weekly"]) || !Array.isArray(raw["weekly"]["needLook"]) || !Array.isArray(raw["weekly"]["picks"])) return {};
  const shape = (value: unknown) => list(value, 50).flatMap((one) => { const kept = item(one, ["id", "lessonId", "title", "cause", "area", "repeat", "status", "version"]);return kept === undefined || typeof (kept["lessonId"] ?? kept["id"]) !== "string" || typeof kept["title"] !== "string" ? [] : [kept]; });
  return { project, weekly: { needLook: shape(raw["weekly"]["needLook"]), picks: shape(raw["weekly"]["picks"]) } };
}
function summary(raw: unknown, project: string): Record<string, unknown> {
  if (!isRecord(raw) || typeof raw["on"] !== "boolean" || !["chosen", "pilot_default", "default"].includes(String(raw["source"])) || typeof raw["canChange"] !== "boolean") return {};
  return { project, on: raw["on"], source: raw["source"], canChange: raw["canChange"] };
}
function report(raw: unknown, project: string, kind: "replay" | "tuning" | "repeats"): Record<string, unknown> {
  if (!isRecord(raw) || raw["project"] !== project) return {};
  const fields = kind === "replay" ? ["tasks", "totals"] : kind === "tuning" ? ["windowDays", "ready", "message", "evidence", "suggestions", "note"] : ["month", "repeated", "corrections", "enoughData", "split", "unjudged", "truncated"];
  const out: Record<string, unknown> = { project };
  for (const field of fields) if (Object.hasOwn(raw, field)) {
    const value = raw[field];
    if (Array.isArray(value)) out[field] = value.slice(0, 100).flatMap((one) => { const kept = item(one, field === "tasks" ? ["taskId", "stage", "round", "actual", "replayed", "gained", "lost", "changed"] : ["setting", "status", "current", "suggested", "evidence", "message"]);return kept === undefined ? [] : [kept]; });
    else if (isRecord(value)) out[field] = item(value, field === "totals" ? ["changedTasks", "lessonsGained", "lessonsLost"] : field === "split" ? ["lessonLoaded", "lessonNotLoaded", "noLesson"] : ["have", "needed", "unit", "loaded", "notLoaded"]);
    else if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") out[field] = value;
  }
  const required = kind === "replay" ? ["tasks", "totals"] : kind === "tuning" ? ["windowDays", "ready", "suggestions"] : ["month", "repeated", "corrections", "enoughData", "split"];
  return required.every((field) => Object.hasOwn(out, field)) ? out : {};
}

export const LESSONS_EXTRAS_ROUTES: Route[] = [
  { method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/weekly-summary$`, "u"), answer: (c) => read(c, `${dev(c.params[0]!)}/lessons/weekly-summary`, "Weekly summary", (r) => summary(r, c.params[0]!)) },
  { method: "PUT", path: new RegExp(`^/projects/${PROJECT}/lessons/weekly-summary$`, "u"), answer: async (c) => { const b = isRecord(c.body) ? c.body : {};if (typeof b["on"] !== "boolean") return badRequest("Choose whether weekly summary is on.");try { const raw = await c.client.json<unknown>(c.session, `${dev(c.params[0]!)}/lessons/weekly-summary`, { method: "PUT", body: { on: b["on"] } });const shaped = summary(raw, c.params[0]!);return Object.keys(shaped).length === 0 ? unavailable("Weekly summary") : ok(shaped); } catch (e) { return refusal(e, "Weekly summary") ?? unavailable("Weekly summary"); } } },
  { method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/weekly$`, "u"), answer: (c) => read(c, `${dev(c.params[0]!)}/lessons/weekly`, "This week's lessons", (r) => weekly(r, c.params[0]!)) },
  { method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/${LESSON_ID}/keep$`, "u"), answer: async (c) => { const project = c.params[0]!, lessonId = c.params[1]!;try { const raw = await postTo(c, `${dev(project)}/lessons/${lessonId}/keep`, {});return ok({ project, lessonId, kept: isRecord(raw) && raw["kept"] === true }); } catch (e) { return refusal(e, "Keeping a lesson") ?? unavailable("Keeping a lesson"); } } },
  { method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/mode/trial-offer$`, "u"), answer: async (c) => { const decision = isRecord(c.body) ? c.body["decision"] : undefined;if (decision !== "accept" && decision !== "not_now") return badRequest("Choose accept or not_now.");try { const raw = await postTo(c, `${dev(c.params[0]!)}/lessons/mode/trial-offer`, { decision });return ok({ project: c.params[0], ...(isRecord(raw) && typeof raw["mode"] === "string" ? { mode: raw["mode"] } : {}), decided: decision }); } catch (e) { return refusal(e, "The trial offer") ?? unavailable("The trial offer"); } } },
  { method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/replay$`, "u"), answer: async (c) => { const n = Number(c.query.get("tasks") ?? "10");if (!Number.isInteger(n) || n < 1 || n > 50) return badRequest("Choose 1 to 50 tasks.");return await read(c, `${dev(c.params[0]!)}/lessons/replay?tasks=${n}`, "Lesson replay", (r) => report(r, c.params[0]!, "replay")); } },
  { method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/tuning$`, "u"), answer: async (c) => await read(c, `${dev(c.params[0]!)}/lessons/tuning`, "Suggested settings", (r) => report(r, c.params[0]!, "tuning")) },
  { method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/repeats$`, "u"), answer: async (c) => await repeats(c, true) },
  { method: "GET", path: /^\/lessons\/repeats$/u, answer: async (c) => {
    const requested = c.query.get("month");if (requested !== null && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(requested)) return badRequest("Month must be YYYY-MM.");
    try {
      const raw = await c.client.json<unknown>(c.session, `/v1/dev/lessons/repeats${requested === null ? "" : `?month=${requested}`}`);
      if (!isRecord(raw) || raw["scope"] !== "company" || typeof raw["month"] !== "string" || typeof raw["repeated"] !== "number" || typeof raw["corrections"] !== "number" || typeof raw["enoughData"] !== "boolean" || !Array.isArray(raw["projects"])) return unavailable("Repeated corrections");
      return ok({ scope: "company", month: raw["month"], repeated: count(raw["repeated"]), corrections: count(raw["corrections"]), enoughData: raw["enoughData"], projects: raw["projects"].slice(0, 100).flatMap((one) => { const kept = item(one, ["project", "repeated", "corrections", "enoughData"]);return kept === undefined ? [] : [kept]; }), ...(typeof raw["unjudged"] === "number" ? { unjudged: count(raw["unjudged"]) } : {}), ...(typeof raw["truncated"] === "boolean" ? { truncated: raw["truncated"] } : {}) });
    } catch (e) { return refusal(e, "Repeated corrections") ?? unavailable("Repeated corrections"); }
  } },
];

function repeats(context: RouteContext, projectScoped: boolean): Promise<RouteAnswer> | RouteAnswer {
  const requested = context.query.get("month");if (requested !== null && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(requested)) return badRequest("Month must be YYYY-MM.");
  const project = projectScoped ? context.params[0]! : undefined;
  const path = project === undefined ? "/v1/dev/lessons/repeats" : `${dev(project)}/lessons/repeats`;
  return read(context, `${path}${requested === null ? "" : `?month=${requested}`}`, "Repeated corrections", (raw) => {
    if (!isRecord(raw)) return {};
    const answer = raw;
    const shaped = report(answer, project ?? "company", "repeats");
    return shaped;
  });
}
