// L4-JA (journey audit B11): Rovara skills, the project's "Skills" screen. Code (L4-AK3, #1034) drafts a skill from a proven lesson, keeps its versions, needs TWO different eligible people to approve a version before it is
// used, and lets one who decides edit (a new version, with no approvals) or retire it. Until now nothing in Cloud could list, edit, approve or retire one. Each route here is answered from Code's lessons API as the signed-in person:
//
//   GET  /v1/app/projects/{p}/skills                  -> Code GET  /v1/dev/projects/{p}/skills                          the skills (newest version of each) and `canDecide`
//   GET  /v1/app/projects/{p}/skills/{skill}          -> Code GET  /v1/dev/projects/{p}/skills?name={skill}             that skill with the text of its newest version and, when Code can read it back, its form
//   PUT  /v1/app/projects/{p}/skills/{skill}          -> Code PUT  /v1/dev/projects/{p}/skills/{skill}                  { expectedVersion, description, when, steps, doneWhen?, why? }: a NEW version, no approvals
//   POST /v1/app/projects/{p}/skills/{skill}/approve  -> Code POST /v1/dev/projects/{p}/skills/{skill}/approve         { version }: one of the two people a version needs
//   POST /v1/app/projects/{p}/skills/{skill}/retire   -> Code POST /v1/dev/projects/{p}/skills/{skill}/retire          {}
//
// Code decides everything: the company (from live membership), who is on the project, who may decide (a maintainer of the project or a company owner or admin: the approver directory), that the same person cannot approve a
// version twice, that a version needs two different people, the 32 KB limit and the audit. There is NO step-up here: the role check is Code's. Cloud only checks the shape of what it forwards (the fields Code takes, bounded) and
// keeps Code's answer to the fields the screen draws (a skill that does not read is left out, never half drawn); Code's refusals pass through in Code's own sentences. Until Code serves the routes, its fixed unknown-route 404 reads
// "isn't available on this Rovara yet" (501 NOT_ON_CODE_YET) and the screen is not offered.
import { CodeError } from "./code-client.js";
import { PROJECT, badRequest, body, count, dev, isRecord, list, ok, some } from "./lessons-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** Code's limits (contracts rovara-skills.ts and the lessons API's edit body), repeated here because cloud-server takes no package dependency; a unit test pins them. */
export const SKILL_LIMITS = Object.freeze({ description: 200, when: 2_000, step: 4_000, steps: 12, note: 2_000, version: 1_000_000, textBytes: 32_768, longBytes: 8_192, approvers: 2 });
/** Code's words for a skill over 8 KB (`ROVARA_SKILL_LONG_NOTE`), kept word for word and never anything else. */
export const SKILL_LONG_NOTE = "This skill is long. Consider splitting it into smaller skills.";
const SKILLS_MAX = 200;
const CONTENT_CHARS = 70_000;

const SKILL_PATH = `/projects/${PROJECT}/skills`;
const NAME = "([a-z0-9][a-z0-9-]{0,63})";

const notYet: RouteAnswer = Object.freeze({ status: 501, body: Object.freeze({ error: Object.freeze({ code: "NOT_ON_CODE_YET", message: "Skills aren't available on this Rovara yet." }) }) });
const unreadable: RouteAnswer = Object.freeze({ status: 502, body: Object.freeze({ error: Object.freeze({ code: "RUNTIME_UNAVAILABLE", message: "Couldn't read the skills just now. Try again." }) }) });
/** What a Code whose core engine does not serve a route yet says (core-host/dev-routes.ts NOT_ON_THE_CORE_YET). */
const CORE_NOT_YET = "That is not on the core engine on this install yet.";

/** Code's exact unknown-route 404 means "not on Code yet"; any other refusal is Code's own and passes through. */
function absent(error: unknown): boolean {
  if (!(error instanceof CodeError) || error.status !== 404 || !isRecord(error.body) || !isRecord(error.body["error"])) return false;
  const inner = error.body["error"];
  return inner["code"] === "NOT_FOUND" && (inner["message"] === "route not found" || inner["message"] === CORE_NOT_YET);
}
async function viaCode<T>(run: () => Promise<T>): Promise<T | RouteAnswer> {
  try { return await run(); } catch (error) { if (absent(error)) return notYet; throw error; }
}
const refusal = (value: unknown): value is RouteAnswer => isRecord(value) && typeof value["status"] === "number" && "body" in value;

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
/** Words as they are drawn: hidden control and format characters are left out (a line break stays where a text may hold one). */
const plainWords = (value: unknown, max: number, lines = false): string | undefined => (typeof value === "string" ? value.slice(0, max).replace(CONTROL, (one) => (lines && one === "\n" ? one : "")) : undefined);
/** Words of a form: refused (not cut short) when over the bound an edit takes, so a form is never shown shorter than it is. */
const whole = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length <= max ? plainWords(value, max) : undefined);
const versionOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= SKILL_LIMITS.version ? value : undefined);

/** The form Code read back from a skill's text, or undefined (never half of one): every field within the bounds an edit takes. */
function formOf(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const description = whole(raw["description"], SKILL_LIMITS.description), when = whole(raw["when"], SKILL_LIMITS.when);
  const steps = Array.isArray(raw["steps"]) ? raw["steps"] : undefined;
  if (description === undefined || description === "" || when === undefined || when === "" || steps === undefined || steps.length < 1 || steps.length > SKILL_LIMITS.steps) return undefined;
  const written = steps.map((one) => whole(one, SKILL_LIMITS.step));
  if (written.some((one) => one === undefined || one === "")) return undefined;
  const doneWhen = raw["doneWhen"] === undefined ? undefined : whole(raw["doneWhen"], SKILL_LIMITS.note), why = raw["why"] === undefined ? undefined : whole(raw["why"], SKILL_LIMITS.note);
  if ((raw["doneWhen"] !== undefined && doneWhen === undefined) || (raw["why"] !== undefined && why === undefined)) return undefined;
  return some({ description, when, steps: written, doneWhen, why });
}

/** One skill as the screen draws it, or undefined for one Code sent that does not read (no valid name, no versions, a live version newer than the newest). */
export function skillRow(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const name = typeof raw["name"] === "string" && SKILL_NAME.test(raw["name"]) ? raw["name"] : undefined;
  const current = versionOf(raw["currentVersion"]), active = raw["activeVersion"] === undefined ? undefined : versionOf(raw["activeVersion"]);
  const description = plainWords(raw["description"], SKILL_LIMITS.description);
  if (name === undefined || current === undefined || description === undefined || (raw["activeVersion"] !== undefined && (active === undefined || active > current))) return undefined;
  if (typeof raw["retired"] !== "boolean" || typeof raw["approvedByYou"] !== "boolean") return undefined;
  const bytes = count(raw["bytes"]);
  return some({
    name, description, currentVersion: current, activeVersion: active, approvals: Math.min(count(raw["approvals"]), SKILL_LIMITS.approvers), approvedByYou: raw["approvedByYou"], retired: raw["retired"], bytes,
    // The long-skill note is Code's own sentence, kept word for word, and only when the skill is over 8 KB: no other note is ever drawn.
    note: raw["note"] === SKILL_LONG_NOTE && bytes > SKILL_LIMITS.longBytes ? SKILL_LONG_NOTE : undefined,
  });
}

/** The skills read: only a person Code names as one who decides is shown buttons (`canDecide`); a missing answer reads as "no". */
export function skillsView(raw: unknown, project: string): Record<string, unknown> | undefined {
  if (!isRecord(raw) || !Array.isArray(raw["skills"])) return undefined;
  const seen = new Set<string>();
  const skills = list(raw["skills"], SKILLS_MAX).flatMap((one) => {
    const row = skillRow(one);
    if (row === undefined || seen.has(row["name"] as string)) return [];
    seen.add(row["name"] as string);
    return [row];
  });
  return { project, canDecide: raw["canDecide"] === true, skills };
}

/** One skill with the text of its newest version (what a person approves), or undefined when Code sent none for this name. */
export function skillDetail(raw: unknown, project: string, name: string): Record<string, unknown> | undefined {
  if (!isRecord(raw) || !Array.isArray(raw["skills"]) || raw["skills"].length !== 1) return undefined;
  const one: unknown = raw["skills"][0];
  const row = skillRow(one);
  if (row === undefined || row["name"] !== name || !isRecord(one)) return undefined;
  const content = plainWords(one["content"], CONTENT_CHARS, true);
  if (content === undefined || content === "") return undefined;
  const form = formOf(one["form"]);
  return { project, canDecide: raw["canDecide"] === true, skill: some({ ...row, content, form }) };
}

/** The body of an edit, field by field as Code takes it, or undefined when it is not one. Nothing else is forwarded. */
export function editBody(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Object.keys(raw).some((key) => !["expectedVersion", "description", "when", "steps", "doneWhen", "why"].includes(key))) return undefined;
  const expectedVersion = versionOf(raw["expectedVersion"]);
  const trimmed = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim().length >= 1 && value.trim().length <= max && !/[\p{Cc}\p{Cf}]/u.test(value.replace(/\n/gu, " ")) ? value.trim() : undefined);
  const description = trimmed(raw["description"], SKILL_LIMITS.description), when = trimmed(raw["when"], SKILL_LIMITS.when);
  const steps = Array.isArray(raw["steps"]) && raw["steps"].length >= 1 && raw["steps"].length <= SKILL_LIMITS.steps ? raw["steps"].map((one) => trimmed(one, SKILL_LIMITS.step)) : undefined;
  const extra = (value: unknown): string | undefined | false => (value === undefined ? undefined : typeof value === "string" && value.length <= SKILL_LIMITS.note && !/[\p{Cc}\p{Cf}]/u.test(value.replace(/\n/gu, " ")) ? value : false);
  const doneWhen = extra(raw["doneWhen"]), why = extra(raw["why"]);
  if (expectedVersion === undefined || description === undefined || when === undefined || steps === undefined || steps.some((one) => one === undefined) || doneWhen === false || why === false) return undefined;
  return some({ expectedVersion, description, when, steps, doneWhen, why });
}
const EDIT_HELP = `An edit takes the version you read, a description (up to ${String(SKILL_LIMITS.description)} characters), when to use it, and 1 to ${String(SKILL_LIMITS.steps)} steps, and optionally when it is done and why.`;

const at = (context: RouteContext): { project: string; name: string } => ({ project: context.params[0]!, name: context.params[1]! });

export const SKILLS_ROUTES: Route[] = [
  {
    // GET …/skills: the project's skills and whether the person may decide.
    method: "GET", path: new RegExp(`^${SKILL_PATH}$`, "u"),
    answer: async (context) => {
      const project = context.params[0]!;
      const got = await viaCode(() => context.client.json<unknown>(context.session, `${dev(project)}/skills`));
      if (refusal(got)) return got;
      const view = skillsView(got, project);
      return view === undefined ? unreadable : ok(view);
    },
  },
  {
    // GET …/skills/{skill}: one skill with the text of its newest version.
    method: "GET", path: new RegExp(`^${SKILL_PATH}/${NAME}$`, "u"),
    answer: async (context) => {
      const { project, name } = at(context);
      const got = await viaCode(() => context.client.json<unknown>(context.session, `${dev(project)}/skills?name=${encodeURIComponent(name)}`));
      if (refusal(got)) return got;
      const view = skillDetail(got, project, name);
      return view === undefined ? unreadable : ok(view);
    },
  },
  {
    // PUT …/skills/{skill}: an edit is a new version with no approvals; the live version stays live. Code checks the person, the 32 KB limit and that the version read is still the newest.
    method: "PUT", path: new RegExp(`^${SKILL_PATH}/${NAME}$`, "u"),
    answer: async (context) => {
      const forwarded = editBody(body(context));
      if (forwarded === undefined) return badRequest(EDIT_HELP);
      const { project, name } = at(context);
      const got = await viaCode(() => context.client.json<unknown>(context.session, `${dev(project)}/skills/${name}`, { method: "PUT", body: forwarded }));
      if (refusal(got)) return got;
      const raw = isRecord(got) ? got : {};
      const made = versionOf(raw["version"]);
      return made === undefined || raw["name"] !== name ? unreadable : ok(some({ project, name, version: made, note: raw["note"] === SKILL_LONG_NOTE ? SKILL_LONG_NOTE : undefined }));
    },
  },
  {
    // POST …/skills/{skill}/approve: one of the TWO different people a version needs. Code refuses the same person twice, a version that is no longer the newest, and anyone who may not decide.
    method: "POST", path: new RegExp(`^${SKILL_PATH}/${NAME}/approve$`, "u"),
    answer: async (context) => {
      const given = body(context);
      const version = versionOf(given["version"]);
      if (version === undefined || Object.keys(given).some((key) => key !== "version")) return badRequest("An approval takes the version you read.");
      const { project, name } = at(context);
      const got = await viaCode(() => context.client.json<unknown>(context.session, `${dev(project)}/skills/${name}/approve`, { method: "POST", body: { version } }));
      if (refusal(got)) return got;
      const raw = isRecord(got) ? got : {};
      const approvals = typeof raw["approvals"] === "number" && Number.isInteger(raw["approvals"]) && raw["approvals"] >= 0 && raw["approvals"] <= 10 ? raw["approvals"] : undefined;
      return approvals === undefined || typeof raw["live"] !== "boolean" || raw["name"] !== name ? unreadable : ok({ project, name, version, approvals, live: raw["live"] });
    },
  },
  {
    // POST …/skills/{skill}/retire: a person who decides takes the skill out of use at once; its versions stay as they were. No body.
    method: "POST", path: new RegExp(`^${SKILL_PATH}/${NAME}/retire$`, "u"),
    answer: async (context) => {
      const given = body(context);
      if (Object.keys(given).length > 0) return badRequest("Retiring a skill takes no fields.");
      const { project, name } = at(context);
      const got = await viaCode(() => context.client.json<unknown>(context.session, `${dev(project)}/skills/${name}/retire`, { method: "POST", body: {} }));
      if (refusal(got)) return got;
      return isRecord(got) && got["retired"] === true && got["name"] === name ? ok({ project, name, retired: true }) : unreadable;
    },
  },
];
