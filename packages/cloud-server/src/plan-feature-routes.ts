// Lead 4 PCF: the plan card's feature controls ("Change", "No feature", "Create") on the web app's own address (`/v1/web/...`), answered by Rovara Code as the signed-in person. Cloud is a pass-through: Code
// decides who may (the plan's approver who may file the task; a live company owner or admin makes a feature) and its refusals reach the app unchanged. What Cloud adds is only this:
//   - the task id in the path must be a task id (a uuid): nothing else is ever put in the address Cloud sends to Code, and the body is rebuilt from the two fields the page sends (never forwarded as it came);
//   - Code's answer is read against the shape the page expects and rebuilt from the fields it names (a feature's name is made one inert line again); an answer that does not read is one fixed refusal;
//   - making a feature is refused here, in fixed words and without asking Code, for anyone who is not a company owner or admin (Code checks again on its own route);
//   - no company, role or person comes from the browser: the company is Code's own (the signed-in person's live membership).
// Cloud's server keeps no runtime dependency on zod or the contracts package, so the checks are written out; the app's readers are packages/contracts/src/app-plan-feature.ts (a test reads every answer through them).
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route } from "./routes.js";

const TASK_ID = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const FEATURE_ID = /^ft_[a-f0-9]{20}$/u;
const SOURCES = ["moved", "chosen", "confirmed_at_plan", "tracker", "inherited"] as const;
export const PLAN_FEATURE_CHOICES_MAX = 50;
const NAME_MAX = 80;

/** Every answer these routes give other than success or Code's own refusal. Fixed words: nothing the request carried and nothing Code worded is echoed. */
export const PLAN_FEATURE_WORDS = Object.freeze({
  notAdmin: { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner or admin can make a feature." } } },
  badBody: { status: 400, body: { error: { code: "CONFIG_INVALID", message: "That request isn't in the shape this page sends." } } },
  unreadable: { status: 502, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent an answer Cloud couldn't read." } } },
});

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hasOnly = (value: Obj, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

/** A name as the page draws it: one inert line, at most `NAME_MAX` characters; undefined when nothing readable is left. */
export function inertName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim());
  return cleaned.length === 0 ? undefined : cleaned.slice(0, NAME_MAX).join("");
}

/** Code's list of features to pick from, as the page reads it; undefined when it is not one. An entry that does not read is left out; a list that is too long or not a list is refused whole. */
export function projectChoices(value: unknown): { features: Array<{ id: string; name: string }>; canCreate: boolean } | undefined {
  if (!isObj(value) || !Array.isArray(value["features"]) || value["features"].length > PLAN_FEATURE_CHOICES_MAX || typeof value["canCreate"] !== "boolean") return undefined;
  const features = (value["features"] as unknown[]).flatMap((entry): Array<{ id: string; name: string }> => {
    if (!isObj(entry) || typeof entry["id"] !== "string" || !FEATURE_ID.test(entry["id"])) return [];
    const name = inertName(entry["name"]);
    return name === undefined ? [] : [{ id: entry["id"], name }];
  });
  return { features, canCreate: value["canCreate"] };
}

/** Code's answer to a filing, as the page reads it; undefined when it is not one, or names another task than the one asked about. */
export function projectFiled(value: unknown, taskId: string): { task: { taskId: string; feature: { id: string; source: string } | null } } | undefined {
  if (!isObj(value) || !isObj(value["task"]) || value["task"]["taskId"] !== taskId) return undefined;
  const feature = value["task"]["feature"];
  if (feature === null) return { task: { taskId, feature: null } };
  if (!isObj(feature) || typeof feature["id"] !== "string" || !FEATURE_ID.test(feature["id"]) || !(SOURCES as readonly string[]).includes(feature["source"] as string)) return undefined;
  return { task: { taskId, feature: { id: feature["id"], source: feature["source"] as string } } };
}

/** Code's answer to making a feature. */
export function projectMade(value: unknown): { feature: { id: string; name: string } } | undefined {
  if (!isObj(value) || !isObj(value["feature"]) || typeof value["feature"]["id"] !== "string" || !FEATURE_ID.test(value["feature"]["id"])) return undefined;
  const name = inertName(value["feature"]["name"]);
  return name === undefined ? undefined : { feature: { id: value["feature"]["id"], name } };
}

export const PLAN_FEATURE_ROUTES: Route[] = [
  {
    // GET /v1/web/tasks/{task}/feature-choices: the open features the person may file the task under (Code answers 404 to anyone who may not file it).
    method: "GET", path: new RegExp(`^/tasks/${TASK_ID}/feature-choices$`, "u"),
    answer: async (context) => {
      const taskId = context.params[0]!.toLowerCase();
      const projected = projectChoices(await context.client.json<unknown>(context.session, `/v1/app/tasks/${taskId}/feature-choices`));
      return projected === undefined ? PLAN_FEATURE_WORDS.unreadable : { status: 200, body: projected };
    },
  },
  {
    // POST /v1/web/tasks/{task}/feature { feature: id | null }: file the task under a feature, or under "No feature" (null).
    method: "POST", path: new RegExp(`^/tasks/${TASK_ID}/feature$`, "u"),
    answer: async (context) => {
      const taskId = context.params[0]!.toLowerCase();
      const body = context.body;
      if (!isObj(body) || !hasOnly(body, ["feature"]) || !Object.hasOwn(body, "feature") || !(body["feature"] === null || (typeof body["feature"] === "string" && FEATURE_ID.test(body["feature"])))) return PLAN_FEATURE_WORDS.badBody;
      const projected = projectFiled(await context.client.json<unknown>(context.session, `/v1/app/tasks/${taskId}/feature`, { method: "POST", body: { feature: body["feature"] } }), taskId);
      return projected === undefined ? PLAN_FEATURE_WORDS.unreadable : { status: 200, body: projected };
    },
  },
  {
    // POST /v1/web/org/report/features { name }: make a feature, for the plan card's "Create". A company owner or admin only.
    method: "POST", path: /^\/org\/report\/features$/u,
    answer: async (context) => {
      const who = await companyCaller(context);
      if (refused(who)) return who;
      if (!isCompanyAdmin(who.companyRole)) return PLAN_FEATURE_WORDS.notAdmin;
      const body = context.body;
      const name = isObj(body) && hasOnly(body, ["name"]) ? inertName(body["name"]) : undefined;
      if (name === undefined || (typeof (body as Obj)["name"] === "string" && Array.from((body as Obj)["name"] as string).length > NAME_MAX)) return PLAN_FEATURE_WORDS.badBody;
      const projected = projectMade(await context.client.json<unknown>(context.session, "/v1/app/org/report/features", { method: "POST", body: { name } }));
      return projected === undefined ? PLAN_FEATURE_WORDS.unreadable : { status: 201, body: projected };
    },
  },
];
