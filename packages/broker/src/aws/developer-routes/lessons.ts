// Learning v2 L3b wiring: the lessons routes and the loaded-knowledge routes on the developer routes. This module builds what the routes need from the route dependencies; the thin entry file only
// calls the two functions below. Everything answers `undefined` (the route falls through to "not found", as before) when the install has no `lessons` / `loadedKnowledge` ports, and the lessons
// routes answer "not found" for a project whose learning mode is Off.
import { agentXError, orgScoped } from "@agentx/contracts";
import { LOADED_KNOWLEDGE_PATH, routeLoadedKnowledge } from "../../developer/loaded-knowledge.js";
import { takeRateAt } from "../../developer/page-comments.js";
import { resolveTaskAccess } from "../../developer/task-access.js";
import { learnedLessonsSwitchOn, resolveLearning, whyLearningOff } from "../../lessons/policy.js";
import { COMPANY_LOCAL_TOOLS_PATH, COMPANY_PRESET_PATH, LESSONS_PATH, TASK_LESSONS_PATH, routeLessons, type LessonRouteDependencies } from "../../lessons/routes.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import { latestDefinition } from "./project-list.js";
import { projectRoleForRoute } from "./project-members.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/**
 * The route-side dependencies of the lessons routes, or undefined where the install has no lesson ports. The project is found as every other project route finds it, except for the Auditor, who
 * has no project role by design: an Auditor may read, so it gets the project only if it exists in its own company (a "viewer" in name only: the lesson routes check the directory, not this role,
 * and the Auditor is refused every write).
 */
export function lessonRouteDependenciesOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): LessonRouteDependencies | undefined {
  const lessons = deps.lessons;
  if (lessons === undefined) return undefined;
  return {
    lessons, ...(deps.repoFile === undefined ? {} : { repoFile: deps.repoFile }),
    projectFor: async (who, rawName) => {
      if (who.orgId !== caller.orgId || who.developerId !== caller.developerId) throw agentXError("PROJECT_NOT_FOUND", "no such project");
      if (who.orgRole !== "auditor") return projectRoleForRoute(deps, who, rawName);
      let name: string;
      try { name = decodeURIComponent(rawName); } catch { throw agentXError("PROJECT_NOT_FOUND", "no such project"); }
      if (!PROJECT_NAME.test(name) || await latestDefinition(deps, caller.orgId, name) === undefined) throw agentXError("PROJECT_NOT_FOUND", "no such project");
      return { name, role: "viewer" as const };
    },
    taskFor: async (who, taskId) => {
      if (who.orgId !== caller.orgId || who.developerId !== caller.developerId) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
      return { project: (await resolveTaskAccess(developerTaskRouteDependencies(deps, caller), who, taskId, "read")).task.project };
    },
    rate: (who, bucket, limit, windowMs) => takeRateAt(deps, { pk: orgScoped(caller.orgId, bucket), sk: who.developerId }, limit, windowMs),
  };
}

/** The lessons, Sources and task-lessons routes for a request, or undefined when the request is not one or the install has no lesson ports. */
export async function routeLessonsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, url: URL, body: () => unknown): Promise<object | undefined> {
  if (!LESSONS_PATH.test(url.pathname) && !TASK_LESSONS_PATH.test(url.pathname) && !COMPANY_PRESET_PATH.test(url.pathname) && !COMPANY_LOCAL_TOOLS_PATH.test(url.pathname)) return undefined;
  const lessonDeps = lessonRouteDependenciesOf(deps, caller);
  return lessonDeps === undefined ? undefined : routeLessons(lessonDeps, caller, method, url, body);
}

/**
 * "What the agent loaded": the records of a task and the text of one listed rule file. Read-only; the text is served only where the install gave the two reads. Behind the same switch as the
 * lessons routes: an install with no lesson ports does not mount it (the path is "not found", as before), and neither does a project whose learning is Off.
 */
export async function routeLoadedKnowledgeFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, url: URL): Promise<object | undefined> {
  const matched = LOADED_KNOWLEDGE_PATH.exec(url.pathname);
  if (method !== "GET" || matched === null) return undefined;
  // The install's lessons switch (`ll`) is off: nothing is loaded or recorded here, so the list read says so in a fixed code (still a 404) and the task page can say it plainly. The text read is unchanged.
  const switchedOff = matched[2] === undefined && !learnedLessonsSwitchOn();
  if (deps.lessons === undefined) {
    if (switchedOff) throw agentXError("LESSONS_SWITCHED_OFF", "Lessons are switched off for this installation.");
    return undefined;
  }
  const task = developerTaskRouteDependencies(deps, caller), knowledge = deps.loadedKnowledge;
  // The task's project, by the task page's own access check; a task the caller cannot read is refused by the route below exactly as it is today.
  const project = await resolveTaskAccess(task, caller, matched[1]!, "read").then((access) => access.task.project, () => undefined);
  // UX-4b: learning Off says so in a fixed code (the same 404 status as before), so the task page can explain it and offer to turn it on rather than show a dead end.
  if (project !== undefined && (await resolveLearning(deps.lessons.settings, caller.orgId, project)).mode === "Off") {
    if (switchedOff) throw agentXError("LESSONS_SWITCHED_OFF", "Lessons are switched off for this installation.");
    const why = await whyLearningOff(deps.lessons.settings, caller.orgId, project).catch(() => "unreadable" as const);
    if (why === "locked") throw agentXError("LEARNING_LOCKED", "Learning is off for this project because of a company setting.");
    throw agentXError("LEARNING_OFF", "Learning is off for this project.");
  }
  const answer = await routeLoadedKnowledge({
    documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log: (entry) => { task.log?.(entry); }, access: task,
    ...(knowledge?.canReadRepository === undefined ? {} : { canReadRepository: (who, input) => knowledge.canReadRepository!(who, input) }),
    ...(knowledge?.readRuleFile === undefined ? {} : { readRuleFile: (input) => knowledge.readRuleFile!(input) }),
  }, caller, { method, path: url.pathname });
  // With the switch off, records kept from before it went off are still shown; an empty list is the switch, not "nothing was recorded".
  if (switchedOff && answer !== undefined && "stages" in answer && Array.isArray(answer.stages) && answer.stages.length === 0) throw agentXError("LESSONS_SWITCHED_OFF", "Lessons are switched off for this installation.");
  return answer;
}
