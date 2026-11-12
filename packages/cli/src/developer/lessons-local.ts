// `agentx lessons` (decision 46b, lane B2; called `rovara lessons` in Rovara Code): the team's lessons for the repository the command runs in, for a developer's own coding tool, or for AGENTS.md ("Before coding, run
// `agentx lessons --task '<summary>'` and follow its output"). One signed-in call to `POST /v1/dev/projects/{project}/lessons`; the broker decides what the whole project may read (never this command), so a lesson that is
// erased or narrowed is gone on the next call and nothing is kept here (no cache, no file). The command is read only on this computer: it reads the git remote and writes nothing.
// It never fails an agent: offline, signed out, a refusal or any failed read prints one fixed line and exits 0 ("Continue without them"). Only a mistake in the command line (an unknown stage) is an error.
// Every line printed is the broker's block or a fixed sentence from `@agentx/contracts`; the project's and the lessons' words pass through the same terminal-safe cleaning as everything else this CLI shows.
import { CLI_PACKAGE_NAME, agentXError } from "@rovara-code/contracts";
import { LOCAL_LESSONS_AMBIGUOUS_LINE, LOCAL_LESSONS_NOT_FOUND_LINE, LOCAL_LESSONS_NO_PROJECT_LINE, LOCAL_LESSONS_STAGES, LOCAL_LESSONS_UNAVAILABLE_LINE, LocalLessonsResponseReaderSchema, lessonsAcrossProjects, withNotesLine, LocalToolsStateReaderSchema, type LocalLessonsAsk, type LocalLessonsBody, type LocalLessonsRead } from "@rovara-code/contracts";
import { z } from "zod";
import { appRequest, clean, result as appResult, seg, type AppResult } from "./agents.js";
import { jsonSafe } from "./audit.js";
import { readCheckout, withoutCredentials, type Checkout } from "./checkout.js";
import { developerAccessToken, type DeveloperSessionDeps } from "./session.js";

export interface LocalLessonsCliInput { project?: string | undefined; repo?: string | undefined; task?: string | undefined; files: readonly string[]; stage?: string | undefined; all: boolean; cwd: string }
export interface LocalLessonsCliDeps extends DeveloperSessionDeps { checkout?: (cwd: string) => Promise<Checkout> }
type Body = Record<string, unknown>;
const TIMEOUT_MS = 8_000;
/** Only the names are read of the person's projects, so a newer server's extra fields never matter. */
const ProjectNamesSchema = z.object({ projects: z.array(z.object({ name: z.string().min(1) })) });

/** One signed-in call; every failure is "unavailable" (with the sign-in command when the sign-in is what failed), a 404 is "not found" (the broker's one answer for a missing project and a repository that is not the project's). */
async function ask(deps: LocalLessonsCliDeps, env: string | undefined, project: string, body: LocalLessonsBody, hint: { signIn?: string }): Promise<LocalLessonsAsk> {
  try {
    const session = await developerAccessToken(deps, env);
    const response = await deps.fetch(`${session.entry.url}/v1/dev/projects/${seg(project)}/lessons`, {
      method: "POST", headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return { kind: "not_found" };
    if (response.status === 401) { hint.signIn = `Sign in again: npx ${CLI_PACKAGE_NAME} login ${session.entry.url}`; return { kind: "unavailable" }; }
    if (!response.ok) return { kind: "unavailable" };
    const parsed = LocalLessonsResponseReaderSchema.safeParse(await response.json().catch(() => undefined));
    // A status this CLI does not know (a newer server) is not judged here.
    return parsed.success && (parsed.data.status === "ok" || parsed.data.status === "off") ? { kind: "answer", response: parsed.data } : { kind: "unavailable" };
  } catch (error) {
    // A sign-in that is gone says how to come back; any other failure (offline included) is the plain line.
    const message = error instanceof Error ? error.message : "";
    if (/login/u.test(message)) hint.signIn = `Sign in: ${clean(message.slice(message.indexOf("run ")))}`;
    return { kind: "unavailable" };
  }
}

function result(status: string, text: string, data: Body = {}): AppResult {
  return { env: "", url: "", data: jsonSafe({ status, ...data }) as Body, text: text.endsWith("\n") ? text : `${text}\n` };
}
const lessonsData = (project: string, response: LocalLessonsRead): Body => ({
  status: response.status, project, lessons: response.lessons.map((l) => ({ id: l.id, advice: l.advice, ...(l.why === undefined ? {} : { why: l.why }), ...(l.citation === undefined ? {} : { citation: l.citation }), ...(l.inRepoFile === true ? { inRepoFile: true } : {}) })), markdown: withNotesLine(response.markdown),
});

export async function localLessons(deps: LocalLessonsCliDeps, env: string | undefined, input: LocalLessonsCliInput): Promise<AppResult> {
  if (input.stage !== undefined && !(LOCAL_LESSONS_STAGES as readonly string[]).includes(input.stage)) throw agentXError("CONFIG_INVALID", `--stage is one of ${LOCAL_LESSONS_STAGES.join(", ")}`);
  const checkout = await (deps.checkout ?? readCheckout)(input.cwd).catch((): Checkout => ({ hasLessonsFile: false }));
  const repoGiven = input.repo === undefined || input.repo.trim() === "" ? undefined : withoutCredentials(input.repo.trim());
  const repo = repoGiven ?? checkout.remote;
  const body: LocalLessonsBody = {
    ...(repo === undefined ? {} : { repo }), ...(input.task === undefined || input.task.trim() === "" ? {} : { task: input.task.slice(0, 2_000) }),
    ...(input.files.length === 0 ? {} : { files: input.files.slice(0, 50) }), ...(input.stage === undefined ? {} : { stage: input.stage as LocalLessonsBody["stage"] }),
    ...(input.all ? { all: true } : {}), ...(checkout.hasLessonsFile ? { skipRepoFile: true } : {}),
  };
  const hint: { signIn?: string } = {};
  const unavailable = (): AppResult => result("unavailable", [LOCAL_LESSONS_UNAVAILABLE_LINE, ...(hint.signIn === undefined ? [] : [hint.signIn])].join("\n"));
  const shown = (project: string, response: LocalLessonsRead): AppResult => ({ ...result(response.status, clean(withNotesLine(response.markdown)), lessonsData(project, response)), env: "", url: "" });

  if (input.project !== undefined) {
    const answer = await ask(deps, env, input.project, body, hint);
    return answer.kind === "answer" ? shown(input.project, answer.response) : answer.kind === "not_found" ? result("not_found", LOCAL_LESSONS_NOT_FOUND_LINE) : unavailable();
  }
  if (repo === undefined) return result("no_project", LOCAL_LESSONS_NO_PROJECT_LINE);
  // Not told the project: ask the person's projects one at a time and keep the one whose registered repositories hold this remote.
  let names: string[];
  try {
    const session = await developerAccessToken(deps, env);
    const response = await deps.fetch(`${session.entry.url}/v1/dev/projects`, { headers: { authorization: `Bearer ${session.accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const parsed = ProjectNamesSchema.safeParse(response.ok ? await response.json().catch(() => undefined) : undefined);
    if (!parsed.success) return unavailable();
    names = parsed.data.projects.map((project) => project.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/login/u.test(message)) hint.signIn = `Sign in: ${clean(message.slice(message.indexOf("run ")))}`;
    return unavailable();
  }
  const across = await lessonsAcrossProjects(names, (name) => ask(deps, env, name, body, hint));
  switch (across.kind) {
    case "answer": return shown(across.project, across.response);
    case "none": return result("not_found", LOCAL_LESSONS_NOT_FOUND_LINE);
    case "ambiguous": return result("ambiguous", LOCAL_LESSONS_AMBIGUOUS_LINE);
    case "unavailable": return unavailable();
  }
}

export const LOCAL_TOOLS_ACTIONS = ["status", "on", "off"] as const;
const UNEXPECTED = "AgentX answered with something unexpected; upgrade the command and try again";

/**
 * `agentx lessons local [status|on|off] --project <name>`: whether local coding tools get a project's lessons, and why not; a maintainer switches the project's own choice (the company's "lessons stay in Rovara" is an
 * owner's or admin's setting in the app). The default is on under the Standard preset and off under Regulated. Every sentence is fixed here; the broker decides who may change it and audits the change.
 */
export async function localToolsSetting(deps: DeveloperSessionDeps, env: string | undefined, project: string | undefined, action: string | undefined): Promise<AppResult> {
  const what = action ?? "status";
  if (!(LOCAL_TOOLS_ACTIONS as readonly string[]).includes(what)) throw agentXError("CONFIG_INVALID", `the action is one of ${LOCAL_TOOLS_ACTIONS.join(", ")}`);
  if (project === undefined || project.trim() === "") throw agentXError("CONFIG_INVALID", "--project <name> is required: the project's name");
  const path = `/v1/app/projects/${seg(project)}/lessons/local-tools`;
  const answer = what === "status" ? await appRequest(deps, env, path) : await appRequest(deps, env, path, { method: "POST", body: { enabled: what === "on" } });
  const state = LocalToolsStateReaderSchema.safeParse(answer.body);
  if (!state.success) throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
  const s = state.data;
  const why = s.reason === "company_stays" ? "your company keeps lessons inside Rovara" : s.reason === "regulated" ? "the project uses the Regulated preset" : s.reason === "project_setting" ? "the project switched it off" : undefined;
  const own = s.own === undefined ? "not set (on under Standard, off under Regulated)" : s.own ? "on" : "off";
  const lines = [
    `Local coding tools for ${clean(project)}: ${s.enabled ? "on" : "off"}${why === undefined ? "" : ` (${why})`}`,
    `  The project's own choice: ${own}`, `  Preset: ${s.preset}`, `  The company keeps lessons inside Rovara: ${s.companyStays ? "yes" : "no"}`, "",
  ];
  return appResult(answer, { localTools: s }, lines.join("\n"));
}
