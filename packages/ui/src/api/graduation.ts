// Lessons phase 4 (L4-LP4G): the read layer of "Make this permanent?", the tidy card, draft tasks and "Both, in different places", on Code's lessons API through Cloud
// (contract v0 `lessons.graduation` ... `lessons.checkDraft.dismiss`). Only people who decide see any of it (Code says so with `canDecide`). Every write is sent once
// (`retry: "never"`): a refusal, a stale version or a throttle is shown in Code's own words, never repeated here. Nothing in this file starts a task: a draft task is text the
// person starts themselves, and the only call that names a task records which of their own tasks they started from the draft.
import type { BothPlacesResponse, CheckDraft, GraduateResponse, GraduationCard, GraduationResponse, GraduationTarget, LessonBecame, TeamRule, TidyCard } from "@agentx/contracts/code-contract-v0";
import type { createApiClient, Reader } from "./client.js";
import { ApiError } from "./errors.js";

export type { BothPlacesResponse, CheckDraft, GraduateResponse, GraduationCard, GraduationResponse, GraduationTarget, TeamRule, TidyCard };
const NEVER = { retry: "never" } as const;
type Api = ReturnType<typeof createApiClient>;

// ---- Words ----
export const GRADUATION_TARGETS: readonly GraduationTarget[] = ["rule", "check", "skill"];
/** What each target is, in the picker. */
export const TARGET_WORDS: Record<GraduationTarget, string> = { rule: "A team rule for this code area", check: "A draft task to add a check (you start it)", skill: "A skill" };
/** The button for each outcome. */
export const TARGET_BUTTON_WORDS: Record<GraduationTarget, string> = { rule: "Make it a rule", check: "Make a draft task", skill: "Make a skill" };
export const targetWords = (target: string) => (target === "rule" || target === "check" || target === "skill" ? TARGET_WORDS[target] : "Another kind of permanent place");
/** What a lesson became, in the retired list. A kind this build does not know reads as the plain "Made permanent", never as one of the known kinds. */
const BECAME_WORDS: Record<string, string> = { rule: "Became a team rule", check: "Became a draft task to add a check", skill: "Became a skill" };
export const becameWords = (kind: string) => BECAME_WORDS[kind] ?? "Made permanent";
export const WAITING_WORDS = "Waiting for a second person";
export const GRADUATION_TITLE = "Make this permanent?";
export const TIDY_TITLE = "10 least used: retire?";
export const NOT_NOW = "Not now";
const plural = (n: number, one: string, many = one + "s") => `${String(n)} ${n === 1 ? one : many}`;
/** Why the lesson is proven, in words: "Used in 12 tasks over 41 days". */
export const provenWords = (card: Pick<GraduationCard, "tasks" | "days">) => `Used in ${plural(card.tasks, "task")} over ${plural(card.days, "day")}`;
/** Where it applies: the code paths, or the whole project. */
export const whereWords = (paths: readonly string[]) => (paths.length === 0 ? "The whole project" : `Code paths: ${paths.join(", ")}`);
/** How many people it needs, or undefined when one person is enough. */
export function needsWords(needs: GraduationCard["needs"]): string | undefined {
  if (needs.required < 2) return undefined;
  return needs.have >= 1 ? "One person asked; needs one more" : "Needs two people";
}
/** A tidy row's use count: "Used in 3 tasks over 20 days". */
export const tidyUseWords = (lesson: { tasks: number; days: number }) => (lesson.tasks === 0 ? "Not used by a task yet" : provenWords(lesson));
export const TIDY_CONFIRM = (n: number) => `Retire ${plural(n, "lesson")}? Rovara stops giving ${n === 1 ? "it" : "them"} to tasks. You can't undo this here.`;
/** What one Make permanent came to, in words. */
export function graduatedWords(answer: GraduateResponse): string {
  switch (answer.state) {
    case "waiting": return `${WAITING_WORDS}. It becomes permanent when they choose the same target and the same paths.`;
    case "drafted": return answer.name === "" ? "A skill was drafted. It waits for people to approve it." : `The skill "${answer.name}" was drafted. It waits for people to approve it.`;
    case "done": return answer.already ? "It was already permanent." : answer.target === "check" ? "Done. The draft task is under Draft tasks. Start it yourself when you are ready." : answer.target === "skill" ? "Done. It is now a skill." : "Done. It is now a team rule for this code area.";
    default: return "Rovara answered in a way this page doesn't know. Reload the page to see where it stands.";
  }
}
/** What "Both, in different places" came to, in words (the waiting lesson is then kept as usual). */
export function bothPlacesWords(answer: BothPlacesResponse): string {
  const applied = "Saved. Each lesson now applies only to its own place. The older one applies only to its new place.";
  if (answer.status === "active" || answer.needs === "nothing") return applied;
  switch (answer.needs) {
    case "second_person": return `${applied} The new lesson needs one more person before Rovara uses it.`;
    case "group_member": return `${applied} The new lesson needs someone from its review group before Rovara uses it.`;
    case "decision": return `${applied} The new lesson waits for a decision before Rovara uses it.`;
    default: return `${applied} Reload the page to see where the new lesson stands.`;
  }
}

/** The pasted link or id of one of the person's tasks, as the one lowercase uuid in it, or undefined (none, or more than one different one). */
export function taskIdFrom(input: string): string | undefined {
  const found = [...new Set(input.toLowerCase().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu) ?? [])];
  return found.length === 1 ? found[0] : undefined;
}

/** Plain relative paths, one per line or comma: trimmed, empty ones left out. */
export function parsePaths(input: string): string[] { return [...new Set(input.split(/[\n,]/u).map(one => one.trim()).filter(one => one !== ""))]; }
/** Whether a path is one Cloud will send (the same rule as the server's: plain, relative, no `..`). */
export const plainPath = (value: string) => value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9._@+~*?/-]+$/u.test(value) && !value.startsWith("/") && !value.split("/").includes("..");
export const PATHS_HELP = "Plain paths such as src/billing/**, one per line, up to 20. Letters, numbers and . _ - / * ? @ + ~ only.";
/** What a second person is told: they must ask for the same thing as the first. */
export const SAME_CHOICE_WORDS = "Choose the same target and the same paths as the first person.";
export const TEAM_RULES_TITLE = "Team rules in use";
export const RULE_RETIRE_CONFIRM = "Retire this rule? Rovara stops adding it to tasks. It can't be undone here.";

// ---- Readers: an answer that is not the shape is "unreadable", never half drawn ----
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string";
const fin = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const n = (value: unknown) => (fin(value) && value > 0 ? Math.floor(value) : 0);
const strs = (value: unknown) => (Array.isArray(value) ? value.filter(str) : []);
const target = (value: unknown): GraduationTarget | undefined => GRADUATION_TARGETS.find(one => one === value);

function readCard(raw: unknown): GraduationCard | undefined {
  if (!isRecord(raw) || !str(raw["lessonId"]) || !fin(raw["version"]) || !str(raw["title"])) return undefined;
  const offered = [...new Set((Array.isArray(raw["targets"]) ? raw["targets"] : []).flatMap(one => { const known = target(one); return known === undefined ? [] : [known]; }))];
  const suggested = target(raw["target"]) ?? offered[0];
  if (suggested === undefined) return undefined;
  const needs = isRecord(raw["needs"]) ? raw["needs"] : {};
  return {
    lessonId: raw["lessonId"], version: raw["version"], title: raw["title"], description: str(raw["description"]) ? raw["description"] : "", type: str(raw["type"]) ? raw["type"] : "",
    tier: raw["tier"] === 0 || raw["tier"] === 2 ? raw["tier"] : 1, target: suggested, targets: [suggested, ...offered.filter(one => one !== suggested)], paths: strs(raw["paths"]), tasks: n(raw["tasks"]), days: n(raw["days"]),
    needs: { required: fin(needs["required"]) && needs["required"] >= 2 ? 2 : 1, have: n(needs["have"]), you: needs["you"] === true },
  };
}
function readTidy(raw: unknown): TidyCard | undefined {
  if (!isRecord(raw) || !Array.isArray(raw["lessons"])) return undefined;
  const lessons = raw["lessons"].filter(isRecord).flatMap(one => (str(one["lessonId"]) && fin(one["version"]) && str(one["title"]) ? [{ lessonId: one["lessonId"], version: one["version"], title: one["title"], type: str(one["type"]) ? one["type"] : "", tasks: n(one["tasks"]), days: n(one["days"]) }] : []));
  return lessons.length === 0 ? undefined : { period: n(raw["period"]), lessons: lessons.slice(0, 10) };
}
function readDrafts(raw: unknown): CheckDraft[] {
  return Array.isArray(raw) ? raw.filter(isRecord).flatMap(one => (str(one["id"]) && str(one["lessonId"]) && str(one["title"]) && str(one["request"]) ? [{ id: one["id"], lessonId: one["lessonId"], title: one["title"], request: one["request"], paths: strs(one["paths"]), createdAt: n(one["createdAt"]) }] : [])) : [];
}
function readRules(raw: unknown): TeamRule[] {
  return Array.isArray(raw) ? raw.filter(isRecord).slice(0, 50).flatMap(one => (str(one["id"]) && str(one["text"]) && one["text"] !== "" ? [{ id: one["id"], text: one["text"], paths: strs(one["paths"]), repos: strs(one["repos"]), fromLesson: str(one["fromLesson"]) ? one["fromLesson"] : "", createdAt: n(one["createdAt"]) }] : [])) : [];
}
/** Only a person who decides is shown a card, the tidy card or a draft, whatever the answer carried. */
export const GraduationReader: Reader<GraduationResponse> = { parse(body: unknown): GraduationResponse {
  if (!isRecord(body) || !str(body["project"])) throw new Error("not a graduation answer");
  if (body["canDecide"] !== true) return { project: body["project"], canDecide: false, drafts: [], rules: [] };
  const card = readCard(body["card"]), tidy = readTidy(body["tidy"]);
  return { project: body["project"], canDecide: true, ...(card === undefined ? {} : { card }), ...(tidy === undefined ? {} : { tidy }), drafts: readDrafts(body["drafts"]), rules: readRules(body["rules"]) };
} };
const GraduateReader: Reader<GraduateResponse> = { parse(body: unknown): GraduateResponse {
  if (!isRecord(body) || !str(body["project"]) || !str(body["lessonId"])) throw new Error("not a graduate answer");
  const base = { project: body["project"], lessonId: body["lessonId"] }, aimed = target(body["target"]) ?? "rule";
  if (body["state"] === "done" && str(body["ref"])) return { ...base, target: aimed, state: "done", ref: body["ref"], already: body["already"] === true };
  if (body["state"] === "waiting") return { ...base, target: aimed, state: "waiting", needs: "second_person" };
  if (body["state"] === "drafted") return { ...base, target: "skill", state: "drafted", name: str(body["name"]) ? body["name"] : "", version: n(body["version"]) };
  return { ...base, target: aimed, state: "unknown" };
} };
const BothPlacesReader: Reader<BothPlacesResponse> = { parse(body: unknown): BothPlacesResponse {
  if (!isRecord(body) || !str(body["project"]) || !str(body["lessonId"])) throw new Error("not a both-places answer");
  return { project: body["project"], lessonId: body["lessonId"], otherId: str(body["otherId"]) ? body["otherId"] : "", cardPaths: strs(body["cardPaths"]), otherPaths: strs(body["otherPaths"]), version: n(body["version"]),
    status: str(body["status"]) ? body["status"] : "unknown", needs: str(body["needs"]) ? body["needs"] : "unknown" };
} };
const TidyRetireReader: Reader<{ retired: string[]; skipped: number }> = { parse(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body["retired"])) throw new Error("not a tidy answer");
  return { retired: strs(body["retired"]), skipped: n(body["skipped"]) };
} };
const flag = (key: string, value: unknown): Reader<Record<string, unknown>> => ({ parse(body: unknown) { if (!isRecord(body) || body[key] !== value) throw new Error("not the answer"); return body; } });

/** The tidy answer in words: how many were retired and how many were left. */
export function tidyWords(answer: { retired: string[]; skipped: number }): string {
  const done = answer.retired.length === 0 ? "Nothing was retired." : `Retired ${plural(answer.retired.length, "lesson")}. Rovara no longer gives ${answer.retired.length === 1 ? "it" : "them"} to tasks.`;
  return answer.skipped > 0 ? `${done} ${plural(answer.skipped, "lesson")} could not be retired (already retired or changed).` : done;
}

export function graduationApi(api: Api) {
  const lessons = (project: string) => "/v1/app/projects/" + encodeURIComponent(project) + "/lessons";
  const one = (project: string, lessonId: string) => lessons(project) + "/" + encodeURIComponent(lessonId);
  const settled = <T,>(result: Awaited<ReturnType<Api["send"]>> & { kind: string }, read: (value: unknown) => T): T => {
    if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");
    return read((result as { value: unknown }).value);
  };
  return {
    graduation: (project: string) => api.get(lessons(project) + "/graduation", GraduationReader),
    async graduate(project: string, lessonId: string, input: { target: GraduationTarget; paths?: string[]; name?: string }) { return settled(await api.send("POST", one(project, lessonId) + "/graduate", input, GraduateReader, NEVER), v => v as GraduateResponse); },
    async graduateLater(project: string, lessonId: string) { return settled(await api.send("POST", one(project, lessonId) + "/graduate-later", {}, flag("later", true), NEVER), v => v); },
    async bothPlaces(project: string, lessonId: string, input: { version: number; cardPaths: string[]; otherPaths: string[] }) { return settled(await api.send("POST", one(project, lessonId) + "/both-places", input, BothPlacesReader, NEVER), v => v as BothPlacesResponse); },
    async tidyRetire(project: string, ids: string[]) { return settled(await api.send("POST", lessons(project) + "/tidy/retire", { ids }, TidyRetireReader, NEVER), v => v as { retired: string[]; skipped: number }); },
    async tidyLater(project: string) { return settled(await api.send("POST", lessons(project) + "/tidy/later", {}, flag("closed", true), NEVER), v => v); },
    async draftStarted(project: string, draftId: string, taskId: string) { return settled(await api.send("POST", lessons(project) + "/check-drafts/" + encodeURIComponent(draftId) + "/started", { taskId }, flag("status", "started"), NEVER), v => v); },
    async retireRule(project: string, ruleId: string) { return settled(await api.send("POST", lessons(project) + "/rules/" + encodeURIComponent(ruleId) + "/retire", {}, flag("status", "retired"), NEVER), v => v); },
    async draftDismiss(project: string, draftId: string) { return settled(await api.send("POST", lessons(project) + "/check-drafts/" + encodeURIComponent(draftId) + "/dismiss", {}, flag("status", "dismissed"), NEVER), v => v); },
  };
}

/** What a lesson became, read for the retired list: only a link this build can read, with an unknown kind as `other`. */
export function readBecame(raw: unknown): LessonBecame | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = raw["kind"] === "rule" || raw["kind"] === "check" || raw["kind"] === "skill" ? raw["kind"] : "other";
  return { kind, ref: str(raw["ref"]) ? raw["ref"] : "", at: n(raw["at"]) };
}
