// Lead 4 PCF: the plan card's feature-choice read on the web app's own address (`/v1/web/...`), answered by Rovara Code as the signed-in person. Filing and creation use the Cost and time actions. Code
// decides who may. What Cloud adds to this read is only this:
//   - the task id in the path must be a task id (a uuid): nothing else is ever put in the address Cloud sends to Code, and the body is rebuilt from the two fields the page sends (never forwarded as it came);
//   - Code's answer is read against the shape the page expects and rebuilt from the fields it names; an answer that does not read is one fixed refusal;
//   - no company, role or person comes from the browser: the company is Code's own (the signed-in person's live membership).
// Cloud's server keeps no runtime dependency on zod or the contracts package, so the checks are written out; the app's readers are packages/contracts/src/app-plan-feature.ts (a test reads every answer through them).
import type { Route } from "./routes.js";

const TASK_ID = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const FEATURE_ID = /^ft_[a-f0-9]{20}$/u;
export const PLAN_FEATURE_CHOICES_MAX = 50;

/** Fixed words for a feature-choice answer Cloud cannot read. */
export const PLAN_FEATURE_WORDS = Object.freeze({
  unreadable: { status: 502, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent an answer Cloud couldn't read." } } },
});

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** A feature name as the picker draws it: one inert line, at most 80 characters. */
function inertName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim());
  return cleaned.length === 0 ? undefined : cleaned.slice(0, 80).join("");
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
];
