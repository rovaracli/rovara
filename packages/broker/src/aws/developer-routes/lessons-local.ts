// Lessons for local coding tools (decision 46b, lane B1): `POST /v1/dev/projects/{project}/lessons`. A developer's own sign-in or their own script token with the `lessons` permission (never a shared key) asks for the team
// lessons of ONE repository of ONE project, and gets the markdown block (`lessons/local-tools.ts`). This file is the route's boundary; the rules are in the lessons module.
//   who:   the caller's own sign-in or script token (authenticated before this runs); the caller must hold a role in the project NOW (`projectRoleForRoute`: another company's project and one the caller cannot see answer
//          exactly like a project that does not exist); the `lessons` permission and the token's projects are checked by `script-tokens/authenticate.ts`;
//   what:  the lessons the whole project may read, stable or person-approved, for the repository the tool's git remote names (proved against the project's registered repositories: one that is not the project's answers
//          like a missing project); nothing is cached, so an erased or narrowed lesson is gone on the next call;
//   rate:  60 a minute per person on this route (on top of a token's own limits);
//   audit: one counter per person, project and day (calls, lessons returned, refusals by fixed code). No lesson text, no task text, no file path and no repository name is logged or counted.
// The request is a POST so the task text and file names ride in the body, not in an address a proxy keeps.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, LocalLessonsBodySchema, OrgIdSchema, agentXError, indexExpiresAt, orgScoped } from "@agentx/contracts";
import { takeRateAt } from "../../developer/page-comments.js";
import { LOCAL_OFF_MESSAGES, LocalLessonsUnavailable, lessonsForLocalTool, renderLocalLessons, type LocalLessonsAnswer, type LocalLessonsDeps, type LocalToolsCounter } from "../../lessons/local-tools.js";
import { normalizeRemote } from "../../lessons/repo-remote.js";
import { tableProjectRepoScopes } from "../../lessons/project-repo-audience.js";
import { peopleOf, type Lesson } from "../../lessons/types.js";
import { listProjectMembers } from "../../org/project-members.js";
import { PROJECT_NOT_FOUND_IN_APP } from "./common.js";
import { projectMembersDepsOf } from "./project-list.js";
import { projectRoleForRoute } from "./project-members.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const LOCAL_LESSONS_PATH = /^\/v1\/dev\/projects\/([^/]+)\/lessons$/u;
export const LOCAL_LESSONS_PER_MINUTE = 60;
const LOCAL_LESSONS_RATE_BUCKET = "LESSON_LOCAL_READS";
const DAY_BUCKET = "LESSON_LOCAL_DAY";
const UNAVAILABLE = "Rovara can't read lessons right now. Try again.";
/** At most this many people's names are looked up in one call (the repo-file pass's limit): over it, nothing is returned. */
const MAX_NAME_LOOKUPS = 300;
const NAME_LOOKUPS_AT_ONCE = 20;

/** One take of the person's per-minute budget; a rate row that cannot be read or written refuses (fail closed). */
async function takeBudget(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<void> {
  let allowed: boolean;
  try { allowed = await takeRateAt(deps, { pk: orgScoped(caller.orgId, LOCAL_LESSONS_RATE_BUCKET), sk: caller.developerId }, LOCAL_LESSONS_PER_MINUTE, 60_000); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
  if (!allowed) throw agentXError("TOO_MANY_REQUESTS", "Too many lesson requests. Try again in a minute.");
}

/** The day's counter row: fixed numbers per person, project and day, kept for the index retention and then expired by the table. Best effort: a failure to count never blocks or changes the answer. */
export function dayCounter(deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">): LocalToolsCounter {
  return {
    async count(event) {
      const day = new Date(deps.now()).toISOString().slice(0, 10);
      const refused = event.refusal === undefined ? undefined : `refused_${event.refusal.replace(/[^a-z_]/gu, "").slice(0, 40)}`;
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: { pk: orgScoped(event.orgId, DAY_BUCKET), sk: `${event.project}#${event.developerId}#${day}` },
        UpdateExpression: `SET entityType = :type, #day = :day, #expires = :expires ADD calls :one, lessonsReturned :lessons${refused === undefined ? "" : ", #refused :one"}`,
        ExpressionAttributeNames: { "#day": "day", "#expires": INDEX_EXPIRY_ATTRIBUTE, ...(refused === undefined ? {} : { "#refused": refused }) },
        ExpressionAttributeValues: { ":type": "LESSON_LOCAL_DAY", ":day": day, ":expires": indexExpiresAt(new Date(deps.now()).toISOString()), ":one": 1, ":lessons": event.lessons },
      }));
    },
  };
}

/** The display names of the project's members and of the people of the lessons asked about; a name that cannot be read, or too many people, throws (the call is then "unavailable"). */
async function peopleNames(deps: DeveloperRouteDependencies, caller: DeveloperCaller, key: { workspaceId: string; project: string }, lessons: readonly Lesson[]): Promise<string[]> {
  const orgId = OrgIdSchema.parse(key.workspaceId);
  const ids = new Set((await listProjectMembers(projectMembersDepsOf(deps), orgId, key.project)).map((member) => member.developerId));
  // The person asking is named too, however they reach the project (a grant, their company role or a channel).
  ids.add(caller.developerId);
  for (const lesson of lessons) for (const id of peopleOf(lesson)) ids.add(id);
  if (ids.size > MAX_NAME_LOOKUPS) throw new Error("too many people to look up");
  const list = [...ids];
  const names: string[] = [];
  for (let at = 0; at < list.length; at += NAME_LOOKUPS_AT_ONCE) {
    for (const name of await Promise.all(list.slice(at, at + NAME_LOOKUPS_AT_ONCE).map((id) => deps.lessons!.names.memberName(orgId, id)))) if (name !== undefined) names.push(name);
  }
  return names;
}

/** What the local-tools read needs, from the route dependencies (undefined where the install has no lesson ports). */
export function localLessonsDepsOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): LocalLessonsDeps | undefined {
  const lessons = deps.lessons;
  if (lessons === undefined || lessons.localTools === undefined) return undefined;
  const resolve = lessons.directory.resolveMember?.bind(lessons.directory);
  return {
    store: lessons.store, settings: lessons.settings, access: lessons.access, names: (key, found) => peopleNames(deps, caller, key, found), localTools: lessons.localTools, now: deps.now,
    ...(resolve === undefined ? {} : { resolveMember: (workspaceId: string, developerId: string) => resolve(workspaceId, developerId) }),
    ...(lessons.log === undefined ? {} : { log: lessons.log }),
    // What is merged into the repository's own lessons file now (decision 50a): the file pass's publish state, ids only.
    ...(deps.repoFile === undefined ? {} : { repoFileIds: async (key: { workspaceId: string; project: string }, place: string) => { const state = await deps.repoFile!.deps.state.get(key, place); return state === undefined ? undefined : new Set(Object.keys(state.rendered)); } }),
  };
}

const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
const offAnswer = (project: string, now: number): LocalLessonsAnswer => ({
  status: "off", reason: "install_switch", message: LOCAL_OFF_MESSAGES.install_switch, project, lessons: [], complete: true,
  markdown: renderLocalLessons({ project, lessons: [], at: now, complete: true, note: LOCAL_OFF_MESSAGES.install_switch }),
});

/** The route, or undefined when the request is not one. */
export async function routeLocalLessonsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, url: URL, body: () => unknown): Promise<object | undefined> {
  const matched = LOCAL_LESSONS_PATH.exec(url.pathname);
  if (matched === null || method !== "POST") return undefined;
  // The person's per-minute budget comes first, so a 404 or a 400 from a sign-in caller is counted too (the cost of a refusal is small, but the number of asks is not unbounded).
  await takeBudget(deps, caller);
  // The caller must hold a role in the project now (an owner or admin of the company counts, as everywhere: what they get is the whole-project set they could already read). A person outside it, another company's project and a project
  // that is not there are one answer.
  const project = (await projectRoleForRoute(deps, caller, matched[1]!)).name;
  if (caller.scriptToken !== undefined && (!caller.scriptToken.permissions.includes("lessons") || !caller.scriptToken.projects.includes(project))) throw notFound();
  const parsed = LocalLessonsBodySchema.safeParse(body());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the caller's.
    throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  const counter = dayCounter(deps);
  const count = async (lessons: number, refusal?: string): Promise<void> => { try { await counter.count({ orgId: caller.orgId, project, developerId: caller.developerId, lessons, refusal }); } catch { /* bookkeeping only */ } };
  const lessonDeps = localLessonsDepsOf(deps, caller);
  // An install with no lesson ports cannot read a lesson or a setting: its answer is "switched off" (decision 47), but the repository is proved first from the project's own definition, so a repository that is not the project's is
  // still "no such project" and a client that asks every project meets no other project's "off".
  if (lessonDeps === undefined) {
    if (parsed.data.repo !== undefined) {
      const remote = normalizeRemote(parsed.data.repo);
      let held: unknown;
      try { held = remote === undefined ? undefined : await tableProjectRepoScopes({ documentClient: deps.documentClient, tableName: deps.tableName }).byRemote?.(caller.orgId, project, remote); } catch { held = undefined; }
      if (held === undefined) { await count(0, "unknown_repo"); throw notFound(); }
    }
    await count(0, "install_switch");
    return offAnswer(project, deps.now());
  }
  let outcome: Awaited<ReturnType<typeof lessonsForLocalTool>>;
  try {
    outcome = await lessonsForLocalTool(lessonDeps, { orgId: caller.orgId, project, remote: parsed.data.repo, task: parsed.data.task, files: parsed.data.files, stage: parsed.data.stage, all: parsed.data.all, skipRepoFile: parsed.data.skipRepoFile });
  } catch (error) {
    await count(0, error instanceof LocalLessonsUnavailable ? "unavailable" : "error");
    throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
  }
  if (outcome.kind === "unknown_repo") {
    await count(0, "unknown_repo");
    throw notFound();
  }
  await count(outcome.answer.lessons.length, outcome.answer.reason);
  return outcome.answer;
}
