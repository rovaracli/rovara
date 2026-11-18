// The lessons screens' routes (DEC 231: the inbox batch row, "Learned" in How we work, "Lessons used" on the task page), each answered from Code's
// lessons API (PrepLabsAI/Rovara#713, contract v0 `lessons.*`) as the signed-in person. Code decides everything: the company (from live membership),
// who may decide, the mode and the audit. Cloud checks the shape of what it forwards (only the fields Code takes, fixed words for every reason), keeps
// Code's answers to the fields the screens draw, and passes Code's refusals through as Code worded them: while Code's lessons are off, every route
// answers 404 LESSONS_SWITCHED_OFF "Lessons are off.", which the app shows as a calm off state.
//
// The inbox read is Cloud's own: it reads the proposed list of each project the person may use and answers one batch per project with the lessons
// this person may decide, the ones from their own corrections first.
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import type { LessonMeasureResponse } from "@agentx/contracts/code-contract-v0";

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const badRequest = (message: string): RouteAnswer => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message } } });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" ? value.slice(0, max) : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const count = (value: unknown): number => { const n = num(value); return n === undefined || n < 0 ? 0 : Math.floor(n); };
const some = (entries: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const strings = (value: unknown, max: number, each: number): string[] => list(value, max).flatMap((item) => (typeof item === "string" ? [item.slice(0, each)] : []));

const measureUnavailable: RouteAnswer = { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Lessons measure is unavailable right now. Try again." } } };
const measureDenied: RouteAnswer = { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a project maintainer, or a company owner or admin, can see the lessons measure." } } };
const measureNotFound: RouteAnswer = { status: 404, body: { error: { code: "NOT_FOUND", message: "No lessons measure is available for this project." } } };
const measureNotYet: RouteAnswer = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Lessons measure isn't available on this Rovara yet." } } };
const measureOff: RouteAnswer = { status: 404, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } } };
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** Code's measure (lessons/measure.ts LessonMeasure). `revertDetection` is "wired" since Code's revert watch counts reverts; an older Code said "not_wired". Either reads. */
function measureView(value: unknown, project: string): LessonMeasureResponse | undefined {
  if (!isRecord(value) || value["project"] !== project || !Number.isInteger(value["windowDays"]) || !isFiniteNumber(value["floor"]) || !Number.isInteger(value["loads"])
    || !(value["lessonsInUse"] === null || Number.isInteger(value["lessonsInUse"])) || !Number.isInteger(value["loadedLessons"]) || !Number.isInteger(value["loadedBelowFloor"])
    || !Number.isInteger(value["loadsWithBelowFloor"]) || !Number.isInteger(value["loadedNoMatch"]) || !(value["meanWordsLoaded"] === null || isFiniteNumber(value["meanWordsLoaded"]))
    || !(value["meanWordsLeftOut"] === null || isFiniteNumber(value["meanWordsLeftOut"])) || !Number.isInteger(value["loadsCapBound"]) || !Number.isInteger(value["leftOutAtOrAboveFloor"])
    || !(value["meanFitLoaded"] === null || isFiniteNumber(value["meanFitLoaded"])) || !(value["meanFitLeftOut"] === null || isFiniteNumber(value["meanFitLeftOut"]))
    || !isRecord(value["cleanMerge"]) || !Number.isInteger(value["cleanMerge"]["merged"]) || !Number.isInteger(value["cleanMerge"]["reverted"])
    || !Number.isInteger(value["cleanMerge"]["clean"]) || !(value["cleanMerge"]["rate"] === null || isFiniteNumber(value["cleanMerge"]["rate"]))
    || (value["revertDetection"] !== "not_wired" && value["revertDetection"] !== "wired") || typeof value["truncated"] !== "boolean" || !Number.isInteger(value["unreadable"])) return undefined;
  return {
    project, windowDays: value["windowDays"] as number, floor: value["floor"], loads: value["loads"] as number, lessonsInUse: value["lessonsInUse"] as number | null,
    loadedLessons: value["loadedLessons"] as number, loadedBelowFloor: value["loadedBelowFloor"] as number, loadsWithBelowFloor: value["loadsWithBelowFloor"] as number,
    loadedNoMatch: value["loadedNoMatch"] as number, meanWordsLoaded: value["meanWordsLoaded"], meanWordsLeftOut: value["meanWordsLeftOut"],
    loadsCapBound: value["loadsCapBound"] as number, leftOutAtOrAboveFloor: value["leftOutAtOrAboveFloor"] as number, meanFitLoaded: value["meanFitLoaded"],
    meanFitLeftOut: value["meanFitLeftOut"],
    cleanMerge: { merged: value["cleanMerge"]["merged"] as number, reverted: value["cleanMerge"]["reverted"] as number, clean: value["cleanMerge"]["clean"] as number, rate: value["cleanMerge"]["rate"] },
    revertDetection: value["revertDetection"], truncated: value["truncated"], unreadable: value["unreadable"] as number,
  };
}
function measureRefusal(error: CodeError): RouteAnswer {
  const body = isRecord(error.body) && isRecord(error.body["error"]) ? error.body["error"] : undefined;
  if (error.status === 403) return measureDenied;
  if (error.status === 405 || error.status === 404 && body?.["code"] === "NOT_FOUND" && body["message"] === "route not found") return measureNotYet;
  if (error.status === 404 && body?.["code"] === "LESSONS_SWITCHED_OFF") return measureOff;
  if (error.status === 404) return measureNotFound;
  return measureUnavailable;
}

/** A project name as Code takes it, a lesson id and a task id: anything else never reaches Code. */
const PROJECT = "([A-Za-z0-9][A-Za-z0-9._-]{0,99})";
const LESSON_ID = "([A-Za-z0-9_-]{4,64})";
const TASK_ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
export const REJECT_REASONS = ["wrong", "too_narrow", "duplicate", "not_useful", "other"] as const;
export const RETIRE_REASONS = ["outdated", "wrong", "harmful", "not_useful", "other"] as const;
export const LESSON_MODES = ["off", "suggest", "auto"] as const;
const LISTS = ["proposed", "approved", "retired"] as const;
export const DECISIONS_MAX = 20;
/** How many of the person's projects the inbox reads, and how many proposed lessons per project. */
export const INBOX_PROJECTS_MAX = 20;
const INBOX_LESSONS_MAX = 20;
const LESSONS_MAX = 50;

const dev = (project: string) => `/v1/dev/projects/${encodeURIComponent(project)}`;
const person = (raw: unknown) => (isRecord(raw) && typeof raw["name"] === "string" ? some({ name: raw["name"].slice(0, 80), you: raw["you"] === true ? true : undefined }) : undefined);
const people = (raw: unknown, max: number) => list(raw, max).flatMap((one) => { const view = person(one); return view === undefined ? [] : [view]; });

function citation(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw["kind"]) {
    case "code": {
      const repo = text(raw["repo"], 200), path = text(raw["path"], 500), startLine = num(raw["startLine"]), endLine = num(raw["endLine"]);
      if (repo === undefined || path === undefined || startLine === undefined || endLine === undefined) return undefined;
      return some({ kind: "code", repo, path, startLine, endLine, check: text(raw["check"], 20) ?? "unchecked", checkedAt: num(raw["checkedAt"]) });
    }
    case "pr": { const url = text(raw["url"], 300); return url !== undefined && url.startsWith("https://") ? { kind: "pr", url } : undefined; }
    case "task": { const taskId = text(raw["taskId"], 100); return taskId === undefined ? undefined : { kind: "task", taskId }; }
    case "record": return { kind: "record" };
    // A kind a newer Code added: kept as an "other" reference (the screens say "Another kind of reference"), never dropped and never read as one of the known kinds.
    default: return { kind: "other" };
  }
}

function needs(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  // 2 or more people reads as 2 (the screens say "two people"): a count a newer Code raised is never shown as one person.
  const required = typeof raw["required"] === "number" && raw["required"] >= 2 ? 2 : 1;
  return some({ required, have: count(raw["have"]), first: person(raw["first"]), firstAt: num(raw["firstAt"]), groups: strings(raw["groups"], 10, 100) });
}

/** Another lesson's id, as Code names it (a duplicate or a contradiction), or undefined. */
const lessonRef = (value: unknown): string | undefined => (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : undefined);

/** One lesson as the screens draw it (contract v0 `LessonItem`), or undefined for one Code sent without an id, a version or a title. */
export function lessonItem(raw: unknown): Record<string, unknown> | undefined {
  // A lesson without its version or its lapse time cannot be decided or warned about honestly: it is left out, never shown as "lapses now".
  if (!isRecord(raw) || typeof raw["id"] !== "string" || typeof raw["title"] !== "string" || num(raw["version"]) === undefined || num(raw["expiresAt"]) === undefined) return undefined;
  const scope = isRecord(raw["scope"]) ? raw["scope"] : {}, counters = isRecord(raw["counters"]) ? raw["counters"] : {};
  const tier = raw["tier"] === 0 || raw["tier"] === 1 || raw["tier"] === 2 ? raw["tier"] : 1;
  return some({
    id: raw["id"].slice(0, 64), version: num(raw["version"]), type: text(raw["type"], 40) ?? "", stages: strings(raw["stages"], 5, 40),
    title: raw["title"].slice(0, 80), description: text(raw["description"], 160) ?? "", body: text(raw["body"], 600) ?? "",
    scope: { repos: strings(scope["repos"], 10, 200), paths: strings(scope["paths"], 20, 200), languages: strings(scope["languages"], 10, 40) },
    tier, status: text(raw["status"], 20) ?? "unknown",
    counters: { loaded: count(counters["loaded"]), helpful: count(counters["helpful"]), harmful: count(counters["harmful"]) },
    createdAt: num(raw["createdAt"]) ?? 0, updatedAt: num(raw["updatedAt"]) ?? 0, expiresAt: num(raw["expiresAt"]), lastUsedAt: num(raw["lastUsedAt"]),
    citations: list(raw["citations"], 8).flatMap((one) => { const view = citation(one); return view === undefined ? [] : [view]; }),
    from: people(raw["from"], 20), measured: raw["measured"] === true, supportTasks: count(raw["supportTasks"]),
    needs: needs(raw["needs"]), rejectedReason: text(raw["rejectedReason"], 40), trial: text(raw["trial"], 20),
    possibleDuplicate: lessonRef(raw["possibleDuplicate"]), contradicts: lessonRef(raw["contradicts"]),
    usedInTasks: num(raw["usedInTasks"]) === undefined ? undefined : count(raw["usedInTasks"]),
    canApprove: raw["canApprove"] === true, canReject: raw["canReject"] === true, canRetire: raw["canRetire"] === true,
  });
}

function page(raw: unknown, project: string): Record<string, unknown> {
  const body = isRecord(raw) ? raw : {};
  const listed = LISTS.find((one) => one === body["list"]) ?? "approved";
  return some({
    project, list: listed, canDecide: body["canDecide"] === true,
    lessons: list(body["lessons"], LESSONS_MAX).flatMap((one) => { const view = lessonItem(one); return view === undefined ? [] : [view]; }),
    next: text(body["next"], 400), partial: body["partial"] === true ? true : undefined,
  });
}

const fixed = <T extends string>(value: unknown, words: readonly T[]): T | undefined => words.find((word) => word === value);
const version = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : undefined);

/** An edit of a lesson's text, trimmed to what Code takes; undefined when absent, `false` when malformed. */
function editOf(raw: unknown): { title: string; description: string; body: string } | undefined | false {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return false;
  const title = typeof raw["title"] === "string" ? raw["title"].trim() : "", description = typeof raw["description"] === "string" ? raw["description"].trim() : "", body = typeof raw["body"] === "string" ? raw["body"].trim() : "";
  if (title === "" || title.length > 80 || description.length > 160 || body === "" || body.length > 600) return false;
  return { title, description, body };
}

function decisionOf(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const lessonId = typeof raw["lessonId"] === "string" && new RegExp(`^${LESSON_ID}$`, "u").test(raw["lessonId"]) ? raw["lessonId"] : undefined, at = version(raw["version"]);
  if (lessonId === undefined || at === undefined) return undefined;
  if (raw["decision"] === "keep") { const edit = editOf(raw["edit"]); return edit === false ? undefined : { lessonId, version: at, decision: "keep", ...(edit === undefined ? {} : { edit }) }; }
  if (raw["decision"] === "drop") { const reason = fixed(raw["reason"], REJECT_REASONS); return reason === undefined ? undefined : { lessonId, version: at, decision: "drop", reason }; }
  return undefined;
}

/** Whether Code answered that its lessons are off (the switch, or no lessons wired for the company). */
export function lessonsOff(error: unknown): boolean {
  return error instanceof CodeError && error.status === 404 && isRecord(error.body) && isRecord(error.body["error"]) && error.body["error"]["code"] === "LESSONS_SWITCHED_OFF";
}

type Inbox = { kind: "off" } | { kind: "skip" } | { kind: "unavailable" } | { kind: "page"; body: Record<string, unknown> };

/** The inbox (`GET /v1/app/lessons/inbox`): each of the person's projects' proposed lessons that they may decide, one batch per project. */
async function inbox(context: RouteContext): Promise<RouteAnswer> {
  const projects = [...new Set(context.session.access.projects.map((one) => one.name))].sort().slice(0, INBOX_PROJECTS_MAX);
  const read = await Promise.all(projects.map(async (project): Promise<Inbox> => {
    try {
      return { kind: "page", body: page(await context.client.json<unknown>(context.session, `${dev(project)}/lessons?list=proposed&limit=${String(INBOX_LESSONS_MAX)}`), project) };
    } catch (error) {
      if (lessonsOff(error)) return { kind: "off" };
      // A project Code no longer lets the person read (removed, archived) is left out; any other failure is named, never hidden as "nothing to review".
      if (error instanceof CodeError && (error.status === 403 || error.status === 404)) return { kind: "skip" };
      if (error instanceof CodeError) return { kind: "unavailable" };
      throw error;
    }
  }));
  const off = read.filter((one) => one.kind === "off").length;
  if (projects.length > 0 && off === projects.length) return ok({ state: "off", batches: [], unavailable: [] });
  const fromYou = (lesson: Record<string, unknown>) => (lesson["from"] as Array<{ you?: true }>).some((one) => one.you === true);
  const soonest = (lessons: Array<Record<string, unknown>>) => Math.min(...lessons.map((lesson) => lesson["expiresAt"] as number));
  const batches = read.flatMap((one, index) => {
    if (one.kind !== "page") return [];
    const lessons = (one.body["lessons"] as Array<Record<string, unknown>>).filter((lesson) => lesson["canApprove"] === true || lesson["canReject"] === true)
      .sort((a, b) => Number(fromYou(b)) - Number(fromYou(a)) || (a["expiresAt"] as number) - (b["expiresAt"] as number));
    if (lessons.length === 0) return [];
    return [some({ project: projects[index]!, lessons, fromYou: lessons.filter(fromYou).length, partial: one.body["partial"] === true || one.body["next"] !== undefined ? true : undefined })];
  }).sort((a, b) => Number((b["fromYou"] as number) > 0) - Number((a["fromYou"] as number) > 0) || soonest(a["lessons"] as Array<Record<string, unknown>>) - soonest(b["lessons"] as Array<Record<string, unknown>>));
  return ok({ state: "on", batches, unavailable: projects.filter((_, index) => read[index]!.kind === "unavailable") });
}

// ---- Lead 4 L4-LP3W: the approved lessons by code area, and "Where Rovara learns from" (Code: lessons/areas, lessons/learning-sources) -------------------------------------------------------------------

/** The kinds of source one row stands for, with the words Cloud shows (Code's own words are never used; a test holds the keys equal to the contract's). */
export const LEARNING_SOURCES = [
  { key: "task_decisions", label: "Decisions in tasks", detail: "Send-backs and close reasons" },
  { key: "review_comments", label: "Review comments", detail: "Comments on Rovara's pull requests and its own review findings" },
  { key: "pr_edits", label: "Edits to Rovara's pull requests", detail: "Changes people make before merging" },
  { key: "remember", label: "Things people ask Rovara to remember", detail: "Notes people write on purpose" },
  { key: "after_merge", label: "After merge", detail: "Reverts and what happened to merged work" },
  { key: "ci", label: "Failing checks", detail: "Test and build failures. No log text is kept" },
] as const;
const SOURCE_KEYS: readonly string[] = LEARNING_SOURCES.map((one) => one.key);
/** The area tree is at most this deep and wide (Code's bounds; anything past them is dropped, never drawn). */
const AREA_DEPTH = 7, AREA_CHILDREN = 40, AREA_FILES = 20, AREA_REPOS = 30, AREA_NODES = 800;
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.@-]{1,100}$/u;
const REPO_QUERY = /^(?:\*|[A-Za-z0-9_.@-]{1,100})$/u;

/** One folder of the tree (a name, its path, its lessons and what is below it), or undefined when Code sent something that is not a plain folder. `budget` bounds the whole tree. */
function areaNode(raw: unknown, depth: number, budget: { nodes: number }): Record<string, unknown> | undefined {
  if (!isRecord(raw) || depth > AREA_DEPTH || budget.nodes <= 0) return undefined;
  const name = text(raw["name"], 100), path = text(raw["path"], 400);
  if (name === undefined || !SEGMENT.test(name) || path === undefined || !path.endsWith("/") || !path.slice(0, -1).split("/").every((part) => SEGMENT.test(part))) return undefined;
  budget.nodes -= 1;
  return some({
    name, path, lessons: count(raw["lessons"]),
    children: list(raw["children"], AREA_CHILDREN).flatMap((one) => { const node = areaNode(one, depth + 1, budget); return node === undefined ? [] : [node]; }),
    moreChildren: count(raw["moreChildren"]) > 0 ? count(raw["moreChildren"]) : undefined,
    files: areaFiles(raw["files"]), moreFiles: count(raw["moreFiles"]) > 0 ? count(raw["moreFiles"]) : undefined,
  });
}
const areaFiles = (raw: unknown): Array<{ name: string; lessons: number }> => list(raw, AREA_FILES).flatMap((one) => (isRecord(one) && typeof one["name"] === "string" && SEGMENT.test(one["name"]) ? [{ name: one["name"], lessons: count(one["lessons"]) }] : []));

/** Code's lessons-by-area answer for THIS project, rebuilt field by field. */
export function areasAnswer(raw: unknown, project: string): Record<string, unknown> {
  const body = isRecord(raw) ? raw : {};
  const budget = { nodes: AREA_NODES };
  const selection = isRecord(body["selection"]) ? body["selection"] : undefined;
  return some({
    project, total: count(body["total"]), wholeProject: count(body["wholeProject"]),
    repos: list(body["repos"], AREA_REPOS).flatMap((one) => {
      if (!isRecord(one)) return [];
      const repo = one["repo"] === null ? null : text(one["repo"], 200);
      if (repo === undefined || (repo !== null && !REPO_QUERY.test(repo))) return [];
      return [some({
        repo, lessons: count(one["lessons"]),
        children: list(one["children"], AREA_CHILDREN).flatMap((child) => { const node = areaNode(child, 1, budget); return node === undefined ? [] : [node]; }),
        moreChildren: count(one["moreChildren"]) > 0 ? count(one["moreChildren"]) : undefined, files: areaFiles(one["files"]), moreFiles: count(one["moreFiles"]) > 0 ? count(one["moreFiles"]) : undefined,
      })];
    }),
    partial: body["partial"] === true ? true : undefined,
    selection: selection === undefined ? undefined : some({
      whole: selection["whole"] === true ? true : undefined,
      repo: selection["whole"] === true ? undefined : selection["repo"] === null ? null : text(selection["repo"], 200),
      folder: selection["whole"] === true ? undefined : text(selection["folder"], 400) ?? "",
      lessons: list(selection["lessons"], AREA_LESSONS_MAX).flatMap((one) => { const view = lessonItem(one); return view === undefined ? [] : [view]; }),
      moreLessons: count(selection["moreLessons"]) > 0 ? count(selection["moreLessons"]) : undefined,
    }),
  });
}
const AREA_LESSONS_MAX = 50;

/** Code's "Where Rovara learns from" answer, in Cloud's own words: one row per known key, in order; a key Code does not send is a row of zeros, never invented counts. */
export function learningSourcesAnswer(raw: unknown, project: string): Record<string, unknown> {
  const body = isRecord(raw) ? raw : {};
  const rows = new Map(list(body["sources"], SOURCE_KEYS.length).filter(isRecord).flatMap((one) => (typeof one["key"] === "string" && SOURCE_KEYS.includes(one["key"]) ? [[one["key"], one] as const] : [])));
  return some({
    project, windowDays: 30, canPause: body["canPause"] === true,
    sources: LEARNING_SOURCES.map((words) => {
      const one = rows.get(words.key) ?? {};
      const example = isRecord(one["example"]) && typeof one["example"]["lessonId"] === "string" && new RegExp(`^${LESSON_ID}$`, "u").test(one["example"]["lessonId"]) && typeof one["example"]["title"] === "string"
        ? { lessonId: one["example"]["lessonId"], title: one["example"]["title"].slice(0, 80) } : undefined;
      return some({ key: words.key, label: words.label, detail: words.detail, seen: count(one["seen"]), suggested: count(one["suggested"]), kept: count(one["kept"]), paused: one["paused"] === true, example });
    }),
    partial: body["partial"] === true ? true : undefined,
  });
}

const body = (context: RouteContext): Record<string, unknown> => (isRecord(context.body) ? context.body : {});
const postTo = async (context: RouteContext, path: string, payload: unknown) => context.client.json<unknown>(context.session, path, { method: "POST", body: payload });

export const LESSONS_ROUTES: Route[] = [
  { method: "GET", path: /^\/lessons\/inbox$/u, answer: inbox },
  {
    // GET /v1/app/projects/{p}/lessons/areas: the approved lessons by code area (a tree), and the lessons at one node. Only repo (a name, or * for no repository), folder and whole=1 go on.
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/areas$`, "u"),
    answer: async (context) => {
      const forward = new URLSearchParams();
      const keys = [...context.query.keys()];
      if (new Set(keys).size !== keys.length || keys.some((key) => key !== "repo" && key !== "folder" && key !== "whole")) return badRequest("areas takes repo, folder and whole, once each.");
      const repo = context.query.get("repo"), folder = context.query.get("folder"), whole = context.query.get("whole");
      if (whole !== null) { if (whole !== "1" || repo !== null || folder !== null) return badRequest("whole is 1 and takes nothing else."); forward.set("whole", "1"); }
      else if (repo !== null) {
        if (!REPO_QUERY.test(repo)) return badRequest("repo is a repository name, or * for lessons that name no repository.");
        forward.set("repo", repo);
        if (folder !== null && folder !== "") { const clean = folder.replace(/^\/+|\/+$/gu, ""); if (clean.split("/").length > AREA_DEPTH || !clean.split("/").every((part) => SEGMENT.test(part))) return badRequest("folder is a plain folder path."); forward.set("folder", clean); }
      } else if (folder !== null) return badRequest("folder needs repo.");
      const project = context.params[0]!;
      const query = forward.toString();
      return ok(areasAnswer(await context.client.json<unknown>(context.session, `${dev(project)}/lessons/areas${query === "" ? "" : "?" + query}`), project));
    },
  },
  {
    // GET /v1/app/projects/{p}/lessons/learning-sources: "Where Rovara learns from". Nothing goes on.
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/learning-sources$`, "u"),
    answer: async (context) => {
      if ([...context.query.keys()].length > 0) return badRequest("learning-sources takes nothing.");
      const project = context.params[0]!;
      return ok(learningSourcesAnswer(await context.client.json<unknown>(context.session, `${dev(project)}/lessons/learning-sources`), project));
    },
  },
  {
    // PUT …/lessons/learning-sources/{key} { paused }: pause or resume one row. Code says who may; the body is exactly one boolean.
    method: "PUT", path: new RegExp(`^/projects/${PROJECT}/lessons/learning-sources/([a-z_]{1,40})$`, "u"),
    answer: async (context) => {
      const key = context.params[1]!;
      if (!SOURCE_KEYS.includes(key)) return badRequest("That is not a source Rovara learns from.");
      const raw = body(context);
      if (typeof raw["paused"] !== "boolean" || Object.keys(raw).length !== 1) return badRequest("Pause takes paused: true or false.");
      const project = context.params[0]!;
      const answer = await context.client.json<unknown>(context.session, `${dev(project)}/lessons/learning-sources/${key}`, { method: "PUT", body: { paused: raw["paused"] } });
      // Said only as Code confirmed it: an answer with no boolean is unreadable, never the requested state.
      if (!isRecord(answer) || typeof answer["paused"] !== "boolean") return { status: 502, body: { error: { code: "INVALID_RESPONSE", message: "Rovara returned an unreadable response. Reload this page." } } };
      return ok({ project, key, paused: answer["paused"] });
    },
  },
  {
    // GET /v1/app/projects/{p}/lessons (contract v0 `lessons.list`): one page of one list. Only list, since, limit and cursor go on.
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons$`, "u"),
    answer: async (context) => {
      const forward = new URLSearchParams();
      const listed = fixed(context.query.get("list") ?? "approved", LISTS);
      if (listed === undefined) return badRequest("list is proposed, approved or retired.");
      forward.set("list", listed);
      const limit = context.query.get("limit"), since = context.query.get("since"), cursor = context.query.get("cursor");
      if (limit !== null) { if (!/^[1-9][0-9]{0,2}$/u.test(limit) || Number(limit) > LESSONS_MAX) return badRequest("limit is 1 to 50."); forward.set("limit", limit); }
      if (since !== null) { if (!/^[0-9]{1,16}$/u.test(since)) return badRequest("since is a time in milliseconds."); forward.set("since", since); }
      if (cursor !== null) { if (!/^[A-Za-z0-9_-]{1,400}$/u.test(cursor)) return badRequest("That cursor isn't one this list gave."); forward.set("cursor", cursor); }
      const project = context.params[0]!;
      return ok(page(await context.client.json<unknown>(context.session, `${dev(project)}/lessons?${forward.toString()}`), project));
    },
  },
  {
    // POST …/lessons/decisions (`lessons.decisions`): Keep or Drop for 1 to 20 distinct proposed lessons; one result each, in the order sent.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/decisions$`, "u"),
    answer: async (context) => {
      const raw = body(context)["decisions"];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > DECISIONS_MAX) return badRequest(`Send 1 to ${String(DECISIONS_MAX)} decisions.`);
      const decisions = raw.map(decisionOf);
      if (decisions.some((one) => one === undefined)) return badRequest("Each decision is Keep (with an optional edit) or Drop with a reason, for the version you read.");
      if (new Set(decisions.map((one) => one!["lessonId"])).size !== decisions.length) return badRequest("Decide each lesson once.");
      const project = context.params[0]!;
      const answer = await postTo(context, `${dev(project)}/lessons/decisions`, { decisions });
      const results = list(isRecord(answer) ? answer["results"] : undefined, DECISIONS_MAX).filter(isRecord).map((one) => (one["ok"] === true
        ? { lessonId: text(one["lessonId"], 64) ?? "", ok: true, status: text(one["status"], 20) ?? "unknown" }
        : { lessonId: text(one["lessonId"], 64) ?? "", ok: false, code: text(one["code"], 60) ?? "FORBIDDEN", message: text(one["message"], 300) ?? "That was not accepted." }));
      return ok({ project, results });
    },
  },
  {
    // GET …/lessons/retire-requests (`lessons.retireRequests`): the open retire requests, for the people who decide.
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/retire-requests$`, "u"),
    answer: async (context) => {
      const project = context.params[0]!, answer = await context.client.json<unknown>(context.session, `${dev(project)}/lessons/retire-requests`);
      const raw = isRecord(answer) ? answer : {};
      return ok({
        project, more: raw["more"] === true,
        requests: list(raw["requests"], 100).filter(isRecord).flatMap((one) => {
          const lessonId = text(one["lessonId"], 64), title = text(one["title"], 80);
          return lessonId === undefined || title === undefined ? [] : [{ lessonId, title, status: text(one["status"], 20) ?? "unknown", by: text(one["by"], 80) ?? "a former member", at: num(one["at"]) ?? 0 }];
        }),
      });
    },
  },
  {
    // GET and PUT …/lessons/mode (`lessons.mode.get`, `lessons.mode.put`): off, suggest or auto; Code says who may change it.
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/mode$`, "u"),
    answer: async (context) => ok(modeOf(await context.client.json<unknown>(context.session, `${dev(context.params[0]!)}/lessons/mode`), context.params[0]!)),
  },
  {
    // GET …/lessons/measure (`lessons.measure`): Code gates this read to project maintainers and company admins. Only Code's named fields reach the app.
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/lessons/measure$`, "u"),
    answer: async (context) => {
      const project = context.params[0]!;
      let raw: unknown;
      try { raw = await context.client.json<unknown>(context.session, `${dev(project)}/lessons/measure`); }
      catch (error) { if (error instanceof CodeError) return measureRefusal(error);throw error; }
      const view = measureView(raw, project);
      return view === undefined ? measureUnavailable : ok(view);
    },
  },
  {
    method: "PUT", path: new RegExp(`^/projects/${PROJECT}/lessons/mode$`, "u"),
    answer: async (context) => {
      const mode = fixed(body(context)["mode"], LESSON_MODES);
      if (mode === undefined) return badRequest("The mode is off, suggest or auto.");
      return ok(modeOf(await context.client.json<unknown>(context.session, `${dev(context.params[0]!)}/lessons/mode`, { method: "PUT", body: { mode } }), context.params[0]!));
    },
  },
  {
    // POST …/lessons/{id}/approve (`lessons.approve`): Keep the version read, or an edit of it.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/${LESSON_ID}/approve$`, "u"),
    answer: async (context) => {
      const at = version(body(context)["version"]), edit = editOf(body(context)["edit"]);
      if (at === undefined || edit === false) return badRequest("Keep takes the version you read, and an edit with a title and the lesson's text.");
      const [project, lessonId] = [context.params[0]!, context.params[1]!];
      const answer = await postTo(context, `${dev(project)}/lessons/${lessonId}/approve`, { version: at, ...(edit === undefined ? {} : { edit }) });
      const raw = isRecord(answer) ? answer : {};
      return ok(some({ project, lessonId, status: text(raw["status"], 20) ?? "unknown", version: num(raw["version"]) ?? at, needs: needs(raw["needs"]) }));
    },
  },
  {
    // POST …/lessons/{id}/reject (`lessons.reject`): Drop, with a fixed reason.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/${LESSON_ID}/reject$`, "u"),
    answer: async (context) => {
      const at = version(body(context)["version"]), reason = fixed(body(context)["reason"], REJECT_REASONS);
      if (at === undefined || reason === undefined) return badRequest("Drop takes the version you read and a reason.");
      const [project, lessonId] = [context.params[0]!, context.params[1]!];
      await postTo(context, `${dev(project)}/lessons/${lessonId}/reject`, { version: at, reason });
      return ok({ project, lessonId, status: "rejected" });
    },
  },
  {
    // POST …/lessons/{id}/retire (`lessons.retire`): with a fixed reason.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/${LESSON_ID}/retire$`, "u"),
    answer: async (context) => {
      const reason = fixed(body(context)["reason"], RETIRE_REASONS);
      if (reason === undefined) return badRequest("Retire takes a reason.");
      const [project, lessonId] = [context.params[0]!, context.params[1]!];
      await postTo(context, `${dev(project)}/lessons/${lessonId}/retire`, { reason });
      return ok({ project, lessonId, status: "retired" });
    },
  },
  {
    // POST …/lessons/{id}/retire-request (`lessons.retireRequest`): anyone on the project asks the people who decide.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/lessons/${LESSON_ID}/retire-request$`, "u"),
    answer: async (context) => {
      const [project, lessonId] = [context.params[0]!, context.params[1]!];
      await postTo(context, `${dev(project)}/lessons/${lessonId}/retire-request`, {});
      return ok({ project, lessonId, requested: true });
    },
  },
  {
    // GET …/projects/{p}/tasks/{t}/lessons (`lessons.task`): the lessons the task was given, with why and the citation's state.
    method: "GET", path: new RegExp(`^/projects/${PROJECT}/tasks/${TASK_ID}/lessons$`, "u"),
    answer: async (context) => {
      const [project, taskId] = [context.params[0]!, context.params[1]!];
      const answer = await context.client.json<unknown>(context.session, `${dev(project)}/tasks/${taskId}/lessons`);
      return ok({
        project, taskId,
        lessons: list(isRecord(answer) ? answer["lessons"] : undefined, 100).filter(isRecord).flatMap((one) => {
          const lessonId = text(one["lessonId"], 64), at = num(one["version"]);
          if (lessonId === undefined || at === undefined) return [];
          const visible = one["visible"] === true;
          return [some({
            stage: text(one["stage"], 40) ?? "", round: count(one["round"]), lessonId, version: at, why: text(one["why"], 20) ?? "", citation: text(one["citation"], 30) ?? "none", visible,
            // A lesson whose source the person cannot see has no words, whatever Code sent.
            title: visible ? text(one["title"], 80) : undefined, type: visible ? text(one["type"], 40) : undefined,
            helpful: num(one["helpful"]) === undefined ? undefined : count(one["helpful"]), harmful: num(one["harmful"]) === undefined ? undefined : count(one["harmful"]),
            canMark: one["canMark"] === true, trial: text(one["trial"], 20),
          })];
        }),
      });
    },
  },
  {
    // POST …/projects/{p}/tasks/{t}/lessons/{id}/not-helpful (`lessons.notHelpful`): one mark per person per lesson.
    method: "POST", path: new RegExp(`^/projects/${PROJECT}/tasks/${TASK_ID}/lessons/${LESSON_ID}/not-helpful$`, "u"),
    answer: async (context) => {
      const [project, taskId, lessonId] = [context.params[0]!, context.params[1]!, context.params[2]!];
      await postTo(context, `${dev(project)}/tasks/${taskId}/lessons/${lessonId}/not-helpful`, {});
      return ok({ project, taskId, lessonId, marked: "not_helpful" });
    },
  },
];

function modeOf(raw: unknown, project: string): Record<string, unknown> {
  const body = isRecord(raw) ? raw : {};
  const mode = fixed(body["mode"], LESSON_MODES) ?? "off";
  return { project, mode, effective: fixed(body["effective"], LESSON_MODES) ?? mode, lockedByCompany: body["lockedByCompany"] === true, canChange: body["canChange"] === true };
}
