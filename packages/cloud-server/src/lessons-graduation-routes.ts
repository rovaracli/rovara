// Lessons phase 4 (L4-LP4G): "Make this permanent?", the tidy card, draft tasks and "Both, in different places", each answered from Code's lessons API
// (contract v0 `lessons.graduation` ... `lessons.checkDraft.dismiss`) as the signed-in person. Code decides everything: the company (from live membership), who may decide
// (a script token never does), the week's one card, the second person and the audit. Cloud checks the shape of what it forwards field by field (only the fields Code
// takes, fixed words for every target, bounded plain paths, ids matched against the same patterns as Code), keeps Code's answers to the fields the screens draw, and passes
// Code's refusals through in Code's own sentences. Nothing here widens what Code takes, and nothing here starts a task: a draft task is text a person starts themselves.
import type { Route } from "./routes.js";
import { PROJECT, LESSON_ID, badRequest, body, count, dev, fixed, isRecord, list, num, ok, postTo, some, strings, text, version } from "./lessons-routes.js";

export const GRADUATION_TARGETS = ["rule", "check", "skill"] as const;
type Target = (typeof GRADUATION_TARGETS)[number];
export const PATHS_MAX = 20;
export const PATH_MAX = 200;
export const TIDY_IDS_MAX = 10;
const DRAFTS_MAX = 20;
export const REQUEST_MAX = 4000;
const LESSON_RE = new RegExp(`^${LESSON_ID}$`, "u");
const DRAFT_ID = "(chk_[0-9a-f]{16})";
const RULE_ID = "(rule_[0-9a-f]{16})";
const RULES_MAX = 50;
const RULE_RE = new RegExp(`^${RULE_ID}$`, "u");
const DRAFT_RE = new RegExp(`^${DRAFT_ID}$`, "u");
const TASK_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** A plain relative glob: no leading slash, no `..` step, and only the characters Code takes in a rule's path (letters, digits and . _ - / * ? @ + ~). */
const GLOB_CHARS = /^[A-Za-z0-9._@+~*?/-]+$/u;
export const plainGlob = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= PATH_MAX && GLOB_CHARS.test(value) && !value.startsWith("/") && !value.split("/").includes("..");
const lessonId = (value: unknown): string | undefined => (typeof value === "string" && LESSON_RE.test(value) ? value : undefined);
const tier = (value: unknown): 0 | 1 | 2 => (value === 0 || value === 1 || value === 2 ? value : 1);

/** A body's path list: 1 to 20 distinct plain globs, or undefined when it is not one. */
function pathList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > PATHS_MAX || !value.every(plainGlob)) return undefined;
  return new Set(value).size === value.length ? value : undefined;
}

// ---- What Code sends, as the screens draw it ----
const known = (value: unknown): Target[] => [...new Set(list(value, 10).flatMap((one) => { const target = fixed(one, GRADUATION_TARGETS); return target === undefined ? [] : [target]; }))];

/** The week's card, or undefined when Code sent none (or one this build cannot draw: no id, version, title or known target). */
function card(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const id = lessonId(raw["lessonId"]), at = version(raw["version"]), title = text(raw["title"], 80);
  if (id === undefined || at === undefined || title === undefined || title === "") return undefined;
  // A target a newer Code added is left out; the suggestion is always one of the offered targets.
  const suggested = fixed(raw["target"], GRADUATION_TARGETS), offered = known(raw["targets"]);
  const targets = suggested !== undefined && !offered.includes(suggested) ? [suggested, ...offered] : offered;
  const target = suggested ?? targets[0];
  if (target === undefined) return undefined;
  const needs = isRecord(raw["needs"]) ? raw["needs"] : {};
  // The lesson's own paths, each once. A card whose paths Code sent but none of which can be drawn is left out, never shown as "the whole project".
  const sentPaths = strings(raw["paths"], PATHS_MAX, PATH_MAX), paths = [...new Set(sentPaths.filter(plainGlob))];
  if (sentPaths.length > 0 && paths.length === 0) return undefined;
  return {
    lessonId: id, version: at, title, description: text(raw["description"], 160) ?? "", type: text(raw["type"], 40) ?? "", tier: tier(raw["tier"]),
    target, targets: [target, ...targets.filter((one) => one !== target)],
    paths, tasks: count(raw["tasks"]), days: count(raw["days"]),
    // 2 or more people reads as 2: a count a newer Code raised is never shown as one person.
    needs: { required: typeof needs["required"] === "number" && needs["required"] >= 2 ? 2 : 1, have: count(needs["have"]), you: needs["you"] === true },
  };
}

function tidy(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const lessons = list(raw["lessons"], TIDY_IDS_MAX).filter(isRecord).flatMap((one) => {
    const id = lessonId(one["lessonId"]), title = text(one["title"], 80), at = version(one["version"]);
    return id === undefined || title === undefined || title === "" || at === undefined ? [] : [{ lessonId: id, version: at, title, type: text(one["type"], 40) ?? "", tasks: count(one["tasks"]), days: count(one["days"]) }];
  });
  return lessons.length === 0 ? undefined : { period: count(raw["period"]), lessons };
}

function drafts(raw: unknown): Array<Record<string, unknown>> {
  return list(raw, DRAFTS_MAX).filter(isRecord).flatMap((one) => {
    const id = text(one["id"], 40), lesson = lessonId(one["lessonId"]), title = text(one["title"], 80), request = text(one["request"], REQUEST_MAX + 1);
    // A draft with no title, no request or a request too long to show whole is left out: a person never copies a request that was cut short.
    if (id === undefined || !DRAFT_RE.test(id) || lesson === undefined || title === undefined || title === "" || request === undefined || request === "" || request.length > REQUEST_MAX) return [];
    return [{ id, lessonId: lesson, title, request, paths: strings(one["paths"], PATHS_MAX, PATH_MAX).filter(plainGlob), createdAt: num(one["createdAt"]) ?? 0 }];
  });
}

function rules(raw: unknown): Array<Record<string, unknown>> {
  return list(raw, RULES_MAX).filter(isRecord).flatMap((one) => {
    const id = text(one["id"], 40), words = text(one["text"], 600);
    if (id === undefined || !RULE_RE.test(id) || words === undefined || words === "") return [];
    return [{ id, text: words, paths: strings(one["paths"], PATHS_MAX, PATH_MAX).filter(plainGlob), repos: strings(one["repos"], 10, 200), fromLesson: lessonId(one["fromLesson"]) ?? "", createdAt: num(one["createdAt"]) ?? 0 }];
  });
}

/** The read. Only a person who decides sees a card, the tidy card, the drafts or the live team rules, whatever Code sent. */
export function graduationView(raw: unknown, project: string): Record<string, unknown> {
  const answer = isRecord(raw) ? raw : {};
  const canDecide = answer["canDecide"] === true;
  if (!canDecide) return { project, canDecide: false, drafts: [], rules: [] };
  return some({ project, canDecide, card: card(answer["card"]), tidy: tidy(answer["tidy"]), drafts: drafts(answer["drafts"]), rules: rules(answer["rules"]) });
}

function graduated(raw: unknown, project: string, id: string, asked: Target): Record<string, unknown> {
  const answer = isRecord(raw) ? raw : {};
  const target = fixed(answer["target"], GRADUATION_TARGETS) ?? asked;
  switch (answer["state"]) {
    case "done": return { project, lessonId: id, target, state: "done", ref: text(answer["ref"], 200) ?? "", already: answer["already"] === true };
    case "waiting": return { project, lessonId: id, target, state: "waiting", needs: "second_person" };
    case "drafted": return { project, lessonId: id, target: "skill", state: "drafted", name: text(answer["name"], 64) ?? "", version: version(answer["version"]) ?? 1 };
    // A state a newer Code added: nothing of it is kept, and the screen says to reload.
    default: return { project, lessonId: id, target, state: "unknown" };
  }
}

const NEEDS = ["nothing", "second_person", "group_member", "decision"] as const;
const STATUSES = ["active", "pending"] as const;

const lessonPath = (context: { params: string[] }) => [context.params[0]!, context.params[1]!] as const;

export const GRADUATION_ROUTES: Route[] = [
  {
    // POST …/lessons/tidy/retire (`lessons.tidy.retire`, Code's `…/lessons/tidy/retire-chosen`): retire the chosen lessons, at most 10, each once. Listed before `…/lessons/{id}/retire`, which "tidy" would also match here.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/tidy/retire$`, "u"),
    answer: async (context) => {
      const raw = body(context)["ids"];
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > TIDY_IDS_MAX || !raw.every((one) => lessonId(one) !== undefined)) return badRequest(`Choose 1 to ${String(TIDY_IDS_MAX)} lessons to retire.`);
      const ids = raw as string[];
      if (new Set(ids).size !== ids.length) return badRequest("Choose each lesson once.");
      const project = context.params[0]!;
      const answer = await postTo(context, `${dev(project)}/lessons/tidy/retire-chosen`, { ids });
      const reply = isRecord(answer) ? answer : {};
      // Only a lesson that was asked for is ever reported as retired.
      const retired = [...new Set(list(reply["retired"], TIDY_IDS_MAX).flatMap((one) => (typeof one === "string" && ids.includes(one) ? [one] : [])))];
      return ok({ project, retired, skipped: count(reply["skipped"]) });
    },
  },
  {
    // POST …/lessons/tidy/later (`lessons.tidy.later`): Not now, no body.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/tidy/later$`, "u"),
    answer: async (context) => { const project = context.params[0]!; await postTo(context, `${dev(project)}/lessons/tidy/later`, {}); return ok({ project, closed: true }); },
  },
  {
    // GET …/lessons/graduation (`lessons.graduation`): the week's card, the tidy card and the draft tasks, for people who decide.
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/graduation$`, "u"),
    answer: async (context) => { const project = context.params[0]!; return ok(graduationView(await context.client.json<unknown>(context.session, `${dev(project)}/lessons/graduation`), project)); },
  },
  {
    // POST …/lessons/{id}/graduate (`lessons.graduate`): a rule (optional paths), a draft task to add a check, or a skill (optional name).
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/${LESSON_ID}/graduate$`, "u"),
    answer: async (context) => {
      const input = body(context), target = fixed(input["target"], GRADUATION_TARGETS);
      if (target === undefined) return badRequest("Make it a rule, a draft task or a skill.");
      const payload: Record<string, unknown> = { target };
      if (input["paths"] !== undefined) {
        const paths = pathList(input["paths"]);
        if (target !== "rule" || paths === undefined) return badRequest(`Paths are for a rule: 1 to ${String(PATHS_MAX)} plain relative paths, each up to ${String(PATH_MAX)} characters.`);
        payload["paths"] = paths;
      }
      if (input["name"] !== undefined) {
        if (target !== "skill" || typeof input["name"] !== "string" || !SKILL_NAME.test(input["name"])) return badRequest("A skill's name is lowercase letters, numbers and hyphens, up to 64 characters.");
        payload["name"] = input["name"];
      }
      const [project, id] = lessonPath(context);
      return ok(graduated(await postTo(context, `${dev(project)}/lessons/${id}/graduate`, payload), project, id, target));
    },
  },
  {
    // POST …/lessons/{id}/graduate-later (`lessons.graduateLater`): Not now, no body.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/${LESSON_ID}/graduate-later$`, "u"),
    answer: async (context) => { const [project, id] = lessonPath(context); await postTo(context, `${dev(project)}/lessons/${id}/graduate-later`, {}); return ok({ project, lessonId: id, later: true }); },
  },
  {
    // POST …/lessons/{id}/both-places (`lessons.bothPlaces`): both lessons are right, each in its own place; the waiting lesson is then kept as usual.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/${LESSON_ID}/both-places$`, "u"),
    answer: async (context) => {
      const input = body(context), at = version(input["version"]), cardPaths = pathList(input["cardPaths"]), otherPaths = pathList(input["otherPaths"]);
      if (at === undefined || cardPaths === undefined || otherPaths === undefined) return badRequest(`Both places take the version you read and 1 to ${String(PATHS_MAX)} plain relative paths for each lesson.`);
      const [project, id] = lessonPath(context);
      const answer = await postTo(context, `${dev(project)}/lessons/${id}/both-places`, { version: at, cardPaths, otherPaths });
      const reply = isRecord(answer) ? answer : {};
      return ok({
        project, lessonId: id, otherId: lessonId(reply["otherId"]) ?? "", cardPaths: strings(reply["cardPaths"], PATHS_MAX, PATH_MAX).filter(plainGlob), otherPaths: strings(reply["otherPaths"], PATHS_MAX, PATH_MAX).filter(plainGlob),
        version: version(reply["version"]) ?? at, status: fixed(reply["status"], STATUSES) ?? "unknown", needs: fixed(reply["needs"], NEEDS) ?? "unknown",
      });
    },
  },
  {
    // POST …/lessons/check-drafts/{draftId}/started (`lessons.checkDraft.started`): which of their own tasks the person started from the draft.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/check-drafts/${DRAFT_ID}/started$`, "u"),
    answer: async (context) => {
      const taskId = body(context)["taskId"];
      if (typeof taskId !== "string" || !TASK_RE.test(taskId)) return badRequest("Give the task's id (the long id in its page address).");
      const [project, draftId] = lessonPath(context);
      await postTo(context, `${dev(project)}/lessons/check-drafts/${draftId}/started`, { taskId });
      return ok({ project, draftId, status: "started" });
    },
  },
  {
    // POST …/lessons/rules/{ruleId}/retire (`lessons.rules.retire`): retire a live team rule, no body.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/rules/${RULE_ID}/retire$`, "u"),
    answer: async (context) => { const [project, ruleId] = lessonPath(context); await postTo(context, `${dev(project)}/lessons/rules/${ruleId}/retire`, {}); return ok({ project, ruleId, status: "retired" }); },
  },
  {
    // POST …/lessons/check-drafts/{draftId}/dismiss (`lessons.checkDraft.dismiss`): drop a draft, no body.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/check-drafts/${DRAFT_ID}/dismiss$`, "u"),
    answer: async (context) => { const [project, draftId] = lessonPath(context); await postTo(context, `${dev(project)}/lessons/check-drafts/${draftId}/dismiss`, {}); return ok({ project, draftId, status: "dismissed" }); },
  },
];
