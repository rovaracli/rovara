// The repository picker and the several-repository create (guided onboarding PR 10; design section 2; DEC 254l item 1), answered by Rovara Code's own
// routes (Code PR #837) as the signed-in person, with their own token:
//
//   GET  /v1/app/github/repository-choices?q=&limit=&after=  -> GET  /v1/dev/client/repositories/available   (the picker, one page at a time)
//   POST /v1/app/projects {requestId, repositories, separate?, name?}
//          one project (separate absent or false)             -> POST /v1/dev/client/projects {repositories, name?}
//          one project per repository (separate: true)        -> POST /v1/dev/client/projects/bulk {repositories}
//
// The browser never names a company: Code takes the company from the person's live membership, and every repository must be on a GitHub account
// connected to THAT company (Code's check, per repository, answered with one uniform sentence). Cloud asks Code's access check first (company-caller.ts)
// only to refuse a person who is in no company, and forwards nothing the browser sent except the fields below, each checked: the query keys q, limit
// and after (any other key, a `company` included, refuses the call before Code is asked), and the body fields above (any other key refuses it).
//
// What reaches the browser is read again here: a Code row that doesn't read refuses the whole answer (never a part of it). Refusals are fixed words:
// Code's own fixed sentences (its 400 "not available" and 503 "could not be reached", which name nothing the person didn't type) and Cloud's own;
// Code's 403 reads "Only company owners and admins can create projects." and nothing else Code worded is passed on.
//
// A retried requestId answers what the first try answered and writes nothing (the person's session keeps it, with a digest of the body: the same id with
// another body is refused). Hosted Code has no setup-run route yet, so nothing here starts a setup run; `SETUP_RUNS_AT_ONCE_PER_COMPANY` (contracts, the
// one place a future runner caps them) is not used on this path.
import { createHash } from "node:crypto";
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import { companyCaller, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import type { CodeSession } from "./sessions.js";

/** Code's routes (Code PR #837). */
export const CODE_PROJECTS_PATH = "/v1/dev/client/projects";
export const CODE_BULK_PATH = "/v1/dev/client/projects/bulk";
export const CODE_AVAILABLE_PATH = "/v1/dev/client/repositories/available";

/** The most repositories one create names (Code's cap), and the most rows one picker page shows. */
export const REPOSITORIES_MAX = 32;
export const PICKER_PAGE_MAX = 100;
/** How many creations a session remembers for replays (the newest), and how many of them may carry per-repository rows (up to 32 each), so the sealed session stays small. */
export const REMEMBERED_CREATES_MAX = 50;
export const REMEMBERED_BULK_MAX = 10;

const refusal = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
/** Code's fixed sentences, which Cloud shows as Code worded them (Code PR #837). */
export const CODE_NOT_AVAILABLE = "one or more of these repositories is not available through your company's GitHub connection; nothing was created";
export const CODE_UNREACHABLE = "GitHub could not be reached for these repositories just now; nothing was created, try again";
/** Code's "a project named X already exists; choose another name": the one sentence that carries a name (the one the person gave, or the repository's). */
const CODE_NAME_TAKEN = /^a project named [a-z][a-z0-9-]{0,62} already exists; choose another name$/u;

/** Every answer these routes give other than success. */
export const PICKER_WORDS = Object.freeze({
  notAdmin: refusal(403, "FORBIDDEN", "Only company owners and admins can create projects."),
  notAvailable: refusal(400, "CONFIG_INVALID", CODE_NOT_AVAILABLE),
  unreachable: refusal(503, "RUNTIME_UNAVAILABLE", CODE_UNREACHABLE),
  badBody: refusal(400, "CONFIG_INVALID", "Pick 1 to 32 different repositories, and give a project name only for one project."),
  badQuery: refusal(400, "CONFIG_INVALID", "That search isn't valid."),
  refused: refusal(400, "CONFIG_INVALID", "These repositories couldn't be used. Check them and try again."),
  sameIdOtherBody: refusal(400, "CONFIG_INVALID", "This request was already used for something else. Reload and try again."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "Rovara couldn't create the projects just now. Try again."),
  listUnavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The repositories couldn't be read just now. Try again."),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** `owner/name`, as the single create checks it, with no `.`, `..` or `.git` name. */
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/u;
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const SEARCH = /^[A-Za-z0-9_./-]{0,100}$/u;
const AFTER = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const NAME_UNSAFE = /[\p{Cc}\p{Cf}]/u;
const BULK_REASONS = new Set(["not_available", "name_taken", "unavailable", "not_started"]);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const isRepository = (value: unknown): value is string => typeof value === "string" && REPOSITORY.test(value) && !/\/(\.{1,2}|\.git)$/u.test(value);
/** The one spelling Code compares repositories by: case-insensitive, without a `.git` ending. */
const sameKey = (repository: string) => repository.toLowerCase().replace(/\.git$/u, "");

export interface CreateProjectsInput { requestId: string; repositories: string[]; separate: boolean; name?: string }

/** The create body as these routes take it, or undefined when it isn't exactly that (unknown keys, repeats, a name with separate projects). */
export function readCreateProjectsBody(body: unknown): CreateProjectsInput | undefined {
  if (!plain(body) || !Object.keys(body).every((key) => key === "requestId" || key === "repositories" || key === "separate" || key === "name")) return undefined;
  const { requestId, repositories, separate, name } = body;
  if (typeof requestId !== "string" || !UUID.test(requestId)) return undefined;
  if (!Array.isArray(repositories) || repositories.length < 1 || repositories.length > REPOSITORIES_MAX || !repositories.every(isRepository)) return undefined;
  if (new Set(repositories.map(sameKey)).size !== repositories.length) return undefined;
  if (separate !== undefined && typeof separate !== "boolean") return undefined;
  if (name !== undefined && (typeof name !== "string" || !PROJECT_NAME.test(name))) return undefined;
  if (separate === true && name !== undefined) return undefined;
  return { requestId, repositories: [...repositories], separate: separate === true, ...(name === undefined ? {} : { name }) };
}

/** Whether a POST /projects body is the several-repository form (it names `repositories`, not `repository`). */
export const isCreateProjectsBody = (body: unknown): boolean => plain(body) && Object.hasOwn(body, "repositories");

function codeMessage(error: CodeError): string | undefined {
  const failure = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  return typeof failure?.["message"] === "string" ? failure["message"] : undefined;
}

/** Code's refusal of a create or a picker read, as one of these fixed answers (or the one sentence that names a project's name). */
export function createRefusal(error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  if (error.status === 403) return PICKER_WORDS.notAdmin;
  const message = codeMessage(error);
  if (error.status === 400 && message === CODE_NOT_AVAILABLE) return PICKER_WORDS.notAvailable;
  if (error.status === 400 && message !== undefined && CODE_NAME_TAKEN.test(message)) return refusal(400, "CONFIG_INVALID", message);
  if (error.status === 400 || error.status === 409) return PICKER_WORDS.refused;
  if (error.status === 503 && message === CODE_UNREACHABLE) return PICKER_WORDS.unreachable;
  return PICKER_WORDS.unavailable;
}

/** The picker's query, or undefined when it holds any key but q, limit and after, a key twice, or a value that doesn't read. */
export function readPickerQuery(query: URLSearchParams): URLSearchParams | undefined {
  const keys = [...query.keys()];
  if (!keys.every((key) => key === "q" || key === "limit" || key === "after") || new Set(keys).size !== keys.length) return undefined;
  const forwarded = new URLSearchParams();
  const q = query.get("q"), limit = query.get("limit"), after = query.get("after");
  if (q !== null) {
    if (!SEARCH.test(q)) return undefined;
    if (q !== "") forwarded.set("q", q);
  }
  if (limit !== null) {
    if (!/^[0-9]{1,3}$/u.test(limit) || Number(limit) < 1 || Number(limit) > PICKER_PAGE_MAX) return undefined;
    forwarded.set("limit", String(Number(limit)));
  }
  if (after !== null) {
    if (!AFTER.test(after)) return undefined;
    forwarded.set("after", after);
  }
  return forwarded;
}

const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && Array.from(value).length <= max && !NAME_UNSAFE.test(value);

interface PickerRow { installationId: number; accountLogin: string; fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string; projects: string[] }
function pickerRow(row: unknown): PickerRow | undefined {
  if (!plain(row)) return undefined;
  const { installationId, accountLogin, fullName, githubRepositoryId, projects } = row;
  if (!Number.isSafeInteger(installationId) || (installationId as number) < 1 || !Number.isSafeInteger(githubRepositoryId) || (githubRepositoryId as number) < 1) return undefined;
  if (!safeText(accountLogin, 100) || !isRepository(fullName) || typeof row["private"] !== "boolean" || !safeText(row["defaultBranch"], 255)) return undefined;
  if (!Array.isArray(projects) || projects.length > REPOSITORIES_MAX * 4 || !projects.every((name) => typeof name === "string" && PROJECT_NAME.test(name))) return undefined;
  return { installationId: installationId as number, accountLogin, fullName, githubRepositoryId: githubRepositoryId as number, private: row["private"], defaultBranch: row["defaultBranch"], projects: (projects as string[]).slice() };
}

/** `GET /github/repository-choices`: one page of the company's repositories, each with the company's projects that already hold it. */
async function repositoryChoices(context: RouteContext): Promise<RouteAnswer> {
  const forwarded = readPickerQuery(context.query);
  if (forwarded === undefined) return PICKER_WORDS.badQuery;
  const who = await companyCaller(context);
  if (refused(who)) return who;
  let answer: unknown;
  try {
    const suffix = forwarded.size === 0 ? "" : `?${forwarded.toString()}`;
    answer = await context.client.json<unknown>(context.session, `${CODE_AVAILABLE_PATH}${suffix}`);
  } catch (error) {
    if (!(error instanceof CodeError)) throw error;
    return error.status === 403 ? PICKER_WORDS.notAdmin : PICKER_WORDS.listUnavailable;
  }
  if (!plain(answer) || !Array.isArray(answer["repositories"]) || answer["repositories"].length > PICKER_PAGE_MAX || typeof answer["incomplete"] !== "boolean") return PICKER_WORDS.listUnavailable;
  const repositories: PickerRow[] = [];
  for (const row of answer["repositories"] as unknown[]) {
    const read = pickerRow(row);
    if (read === undefined) return PICKER_WORDS.listUnavailable;
    repositories.push(read);
  }
  const next = answer["next"];
  if (next !== undefined && !isRepository(next)) return PICKER_WORDS.listUnavailable;
  return { status: 200, body: { repositories, ...(next === undefined ? {} : { next }), incomplete: answer["incomplete"] } };
}

type BulkRow = { repository: string; outcome: "created"; project: string } | { repository: string; outcome: "refused"; reason: string };

/** Code's bulk answer, read against what was asked: one row per repository, in the order asked, each created (with a project name) or refused (a known reason). */
function bulkRows(answer: unknown, asked: readonly string[]): BulkRow[] | undefined {
  if (!plain(answer) || !Array.isArray(answer["results"]) || answer["results"].length !== asked.length) return undefined;
  const rows: BulkRow[] = [];
  for (const [index, row] of (answer["results"] as unknown[]).entries()) {
    if (!plain(row) || typeof row["repository"] !== "string" || sameKey(row["repository"]) !== sameKey(asked[index]!)) return undefined;
    if (row["outcome"] === "created" && typeof row["project"] === "string" && PROJECT_NAME.test(row["project"])) rows.push({ repository: asked[index]!, outcome: "created", project: row["project"] });
    else if (row["outcome"] === "refused" && typeof row["reason"] === "string" && BULK_REASONS.has(row["reason"])) rows.push({ repository: asked[index]!, outcome: "refused", reason: row["reason"] });
    else return undefined;
  }
  return rows;
}

const digestOf = (input: CreateProjectsInput) => createHash("sha256").update(JSON.stringify([input.repositories, input.separate, input.name ?? null])).digest("hex");

/** Keeps a creation in the session for replays: the newest REMEMBERED_CREATES_MAX in the order made (never by clock), of which only the newest REMEMBERED_BULK_MAX keep their rows. An id already kept keeps its first answer. */
function remember(session: CodeSession, requestId: string, entry: NonNullable<CodeSession["created"]>[string]): void {
  if (session.created?.[requestId] !== undefined) return;
  const all = Object.entries({ ...session.created, [requestId]: entry }).slice(-REMEMBERED_CREATES_MAX);
  let bulk = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const [, kept] = all[index]!;
    if (kept.results !== undefined && (bulk += 1) > REMEMBERED_BULK_MAX) all[index] = [all[index]![0], { name: kept.name, at: kept.at, ...(kept.digest === undefined ? {} : { digest: kept.digest }) }];
  }
  session.created = Object.fromEntries(all);
  session.changed = true;
}

/** `POST /projects` with `repositories`: one project holding them all, or (separate) one project per repository. */
export async function createProjects(context: RouteContext): Promise<RouteAnswer> {
  const input = readCreateProjectsBody(context.body);
  if (input === undefined) return PICKER_WORDS.badBody;
  const who = await companyCaller(context);
  if (refused(who)) return who;
  const digest = digestOf(input);
  const earlier = context.session.created?.[input.requestId];
  if (earlier !== undefined && earlier.digest !== undefined) {
    if (earlier.digest !== digest) return PICKER_WORDS.sameIdOtherBody;
    if (input.separate) return earlier.results === undefined ? PICKER_WORDS.sameIdOtherBody : { status: 200, body: { duplicate: true, results: earlier.results } };
    return { status: 200, body: { duplicate: true, project: { definition: { name: earlier.name }, registeredAt: earlier.at } } };
  }
  const at = context.now().toISOString();
  try {
    if (input.separate) {
      const answer = await context.client.json<unknown>(context.session, CODE_BULK_PATH, { method: "POST", body: { repositories: input.repositories } });
      const rows = bulkRows(answer, input.repositories);
      if (rows === undefined) return PICKER_WORDS.unavailable;
      const first = rows.find((row) => row.outcome === "created");
      remember(context.session, input.requestId, { name: first?.outcome === "created" ? first.project : "", at, digest, results: rows });
      console.log(JSON.stringify({ event: "cloud.projects_bulk_created", companyId: who.companyId, developerId: who.developerId, requested: rows.length, created: rows.filter((row) => row.outcome === "created").length }));
      return { status: 200, body: { duplicate: false, results: rows } };
    }
    const answer = await context.client.json<unknown>(context.session, CODE_PROJECTS_PATH, { method: "POST", body: { repositories: input.repositories, ...(input.name === undefined ? {} : { name: input.name }) } });
    const name = plain(answer) ? answer["name"] : undefined;
    if (typeof name !== "string" || !PROJECT_NAME.test(name)) return PICKER_WORDS.unavailable;
    remember(context.session, input.requestId, { name, at, digest });
    console.log(JSON.stringify({ event: "cloud.project_created", companyId: who.companyId, developerId: who.developerId, repositories: input.repositories.length }));
    return { status: 201, body: { duplicate: false, project: { definition: { name }, registeredAt: at } } };
  } catch (error) {
    if (error instanceof CodeError) return createRefusal(error);
    throw error;
  }
}

/** The picker's route. It needs only Code, so every Cloud serves it. */
export const PROJECT_CREATE_ROUTES: Route[] = [
  { method: "GET", path: /^\/github\/repository-choices$/u, answer: repositoryChoices },
];
