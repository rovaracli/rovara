// A fake Rovara Code: a small local HTTP server that answers contract v0 (packages/contracts/src/code-contract-v0.ts) with canned,
// in-memory data, so Cloud's screens can be built before the real Code serves the routes. Run it with `npm run fake-code`.
//
// It is a fake, not a copy of Code: it keeps just enough state for a screen to work (a task you start appears in the list, a plan you
// approve moves on, a share shows up), it checks the sign-in the way Code does (client secret, PKCE, a refresh token that works once,
// a bearer token on every /v1/dev call), and it answers a task the person may not read with 404. Everything resets when it stops.
// Its handler table is typed against the contract, so a route added to CODE_ROUTES that the fake does not answer fails to compile.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  matchCodeRoute,
  type AccessResponse, type CodeRequest, type CodeResponse, type CodeRouteId, type CompanyMember, type DecisionCard, type ErrorBody, type HowWeWorkView,
  type PlaybookView, type PlanComment, type ProofIndexResponse, type ScriptToken, type TaskMessage, type TaskReader, type TaskView, type TaskWorkflow, type WorkflowArtifact,
  type DecisionsResponse, type DecisionOutcome, type GraduationResponse, type LearningSourceKey, type LessonItem, type LessonMeasureResponse, type LessonMode, type TaskLesson,
} from "../../packages/contracts/src/code-contract-v0.js";
import { DEVELOPER_EVENTS_MAX } from "../../packages/contracts/src/developer-tasks.js";
import { taskPlanAnswer } from "../fixtures/code-answers.js";
import { wikiIndex, wikiPage, wikiSearch, wikiSources, type WikiFixtureOptions } from "./wiki-fixture.js";
import { wikiMapOf, wikiSetupBuildView, type FakeWikiSetup } from "./wiki-setup-fixture.js";
import { WIKI_SETUP_CODE_WORDS } from "../../packages/contracts/src/app-wiki-setup.js";
import { CreateScriptTokenBodySchema } from "../../packages/contracts/src/script-tokens.js";

export interface Person { key: string; developerId: string; name: string; email: string; administrator: boolean; /** Another company than the pretend Code's own (guided onboarding PR 10: two-company tests). */ company?: { id: string; name: string } }

const id64 = (name: string) => createHash("sha256").update(`fake-code:${name}`).digest("hex");
/** The pretend Code's one company (DEC 253z: Code names it in the access check). */
export const FAKE_COMPANY_ID = "org_aaaaaaaaaaaaaaaaaaaa";
export const FAKE_COMPANY_NAME = "Example Co";
/** The one operator invite code the pretend Code takes for creating a company. */
export const FAKE_INVITE_CODE = "inv_fakecode0001";
/** GitHub's `code` values the fake's GitHub claim understands (guided onboarding). */
export const FAKE_GITHUB_CODES = { connected: "fakeghconnected", choose: "fakeghchoose" } as const;
/** Slack's and Linear's `code` values the fake's install and connect understand (guided onboarding PR 11): `other` adds Rovara to a workspace other than the sign-in's. */
export const FAKE_SLACK_CODES = { connected: "fakeslackok", other: "fakeslackother" } as const;
export const FAKE_LINEAR_CODES = { connected: "fakelinearok" } as const;
export const PRIYA: Person = { key: "priya", developerId: id64("priya"), name: "Priya", email: "priya@example.test", administrator: true };
export const SAM: Person = { key: "sam", developerId: id64("sam"), name: "Sam", email: "sam@example.test", administrator: false };
const PEOPLE: readonly Person[] = [PRIYA, SAM];
/** The pretend Code's second company, with its own GitHub account and repositories (guided onboarding PR 10): its owner is not in PEOPLE, so the first company's lists never show them. */
export const OTHER_COMPANY_ID = "org_bbbbbbbbbbbbbbbbbbbb";
export const ZED: Person = { key: "zed", developerId: id64("zed"), name: "Zed", email: "zed@other.test", administrator: true, company: { id: OTHER_COMPANY_ID, name: "Other Co" } };
/** The repositories each company's GitHub accounts reach (`client.repositories.available`), by company. */
export const FAKE_AVAILABLE_REPOSITORIES: Readonly<Record<string, ReadonlyArray<{ installationId: number; accountLogin: string; fullName: string }>>> = {
  [FAKE_COMPANY_ID]: ["web", "api", "docs", "billing", "mobile", "search", "infra", "design", "payments", "auth", "notifier", "reports"].map((name) => ({ installationId: 1001, accountLogin: "example", fullName: `example/${name}` })),
  [OTHER_COMPANY_ID]: [{ installationId: 2002, accountLogin: "other-co", fullName: "other-co/secret-ledger" }, { installationId: 2002, accountLogin: "other-co", fullName: "other-co/web" }],
};

/** Fixed task ids, so a screen under construction can open them by address. */
export const TASK_IDS = {
  planReview: "11111111-1111-4111-8111-111111111111",
  running: "22222222-2222-4222-8222-222222222222",
  failed: "33333333-3333-4333-8333-333333333333",
  pullRequest: "44444444-4444-4444-8444-444444444444",
  blockedReview: "55555555-5555-4555-8555-555555555555",
} as const;
const PLAN_DIGEST = "a".repeat(64);
const CREATED = "2026-11-14T10:00:00.000Z";
const UPDATED = "2026-11-14T10:05:00.000Z";

/**
 * A workflow snapshot as Code's task view sends it: every field the app's reader requires (schemaVersion, definitionId, definitionVersion, taskId, ownerId,
 * dates, artifacts, decisions) is there, with Code's own stage and state words. The first version of this fake sent only stage, state, revision and
 * artifacts, with stages Code does not have (CODE, DONE), so the app could not read any task ("Rovara returned an unreadable response").
 */
const workflowOf = (taskId: string, owner: Person, patch: Pick<TaskWorkflow, "stage" | "state" | "revision"> & Partial<TaskWorkflow>, at: { createdAt?: string; updatedAt?: string } = {}): TaskWorkflow => ({
  schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.1.0", taskId, ownerId: owner.developerId, createdAt: at.createdAt ?? CREATED, updatedAt: at.updatedAt ?? UPDATED,
  artifacts: [], decisions: [], ...patch,
});
const planArtifact = (taskId: string): WorkflowArtifact => ({ id: "plan-1", type: "plan", version: 1, sha256: PLAN_DIGEST, producer: "fake-planner", objectKey: `tasks/${taskId}/plan/1.json`, createdAt: CREATED, format: "structured" });

/** The workflow fields a task waiting to merge carries (Code refuses to show that stage without them): the checked candidate, passing checks, both reviews, and the open pull request. */
const readyToMerge = (candidate: ReturnType<typeof candidateOf>): Partial<TaskWorkflow> => ({
  candidate,
  verification: { candidateDigest: candidate.digest, producer: "fake-worker", environmentId: "fake-env", recordedAt: UPDATED, results: [{ checkId: "unit", status: "PASS" }] },
  reviews: (["CRITIC", "SECURITY"] as const).map((role, index) => ({ operationId: `7777777${String(index)}-7777-4777-8777-777777777777`, candidateDigest: candidate.digest, role, provider: "fake-model", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: UPDATED })),
  pullRequests: [{ repositoryId: "example/web", number: 42, url: "https://github.com/example/web/pull/42", headSha: "c".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }],
});

/** One repository's candidate, with the digest Code computes (sha256 of the canonical manifest). */
const candidateOf = (): { schemaVersion: 1; repositories: Array<{ repositoryId: string; commitSha: string; treeSha: string }>; digest: string } => {
  const repositories = [{ repositoryId: "example/web", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }];
  return { schemaVersion: 1, repositories, digest: createHash("sha256").update(JSON.stringify({ schemaVersion: 1, repositories })).digest("hex") };
};

export interface FakeCodeOptions {
  clientId?: string;
  clientSecret?: string;
  /** Who signs in when nobody has said otherwise. */
  person?: Person;
  port?: number;
  host?: string;
  now?: () => Date;
  /** The Cloud callback Code's Linear app would name (Code reads it from the app's secret); default http://127.0.0.1:8787/api/connect/linear/callback. */
  linearRedirectUri?: string;
}

export interface FakeCode {
  url: string;
  server: Server;
  /** Who the next sign-in is (the fake has no login page). */
  setPerson(person: Person): void;
  close(): Promise<void>;
  /** Lessons on or off (off: every lessons route answers 404 LESSONS_SWITCHED_OFF "Lessons are off.", as Code does while its switch is off). */
  setLessons(on: boolean): void;
  /** Lessons phase 4: every graduation, tidy, both-places and draft call Code received (route id, path params, body), newest last. */
  lessonCalls: Array<{ id: string; params: Record<string, string>; body: unknown; person: string }>;
  /** Lessons phase 4: answer one of those routes with this status and body instead (undefined puts the normal answer back). */
  overrideLessonAnswer(id: string, answer: { status?: number; body: unknown } | undefined): void;
  /** Lessons phase 4: put the lessons, the drafts and the held and closed cards back as the fake starts them. */
  resetLessons(): void;
  /** Every request received, newest last (method, path, status). */
  log: Array<{ method: string; path: string; query: string; status: number }>;
}

interface Answer<K extends CodeRouteId> { status?: number; body?: CodeResponse<K> | ErrorBody; headers?: Record<string, string> }
interface Context<K extends CodeRouteId> { body: CodeRequest<K>; params: Record<string, string>; query: URLSearchParams; person: Person; token?: string }
type Handler<K extends CodeRouteId> = (context: Context<K>) => Answer<K> | Promise<Answer<K>>;
type Handlers = { [K in CodeRouteId]: Handler<K> };

const failure = (status: number, code: string, message: string): { status: number; body: ErrorBody } => ({ status, body: { error: { code, message } } });
/** Code's events limit check (`whole`: one to three digits, then the range): absent is its default, anything else outside 1..DEVELOPER_EVENTS_MAX is refused with Code's 400. */
const eventsLimitRefused = (query: URLSearchParams): { status: number; body: ErrorBody } | undefined => {
  const raw = query.get("limit");
  if (raw === null) return undefined;
  const limit = /^\d{1,3}$/u.test(raw) ? Number(raw) : Number.NaN;
  return limit >= 1 && limit <= DEVELOPER_EVENTS_MAX ? undefined : failure(400, "CONFIG_INVALID", `limit must be a whole number from 1 to ${String(DEVELOPER_EVENTS_MAX)}`);
};
const notFound = (what = "route") => failure(404, "NOT_FOUND", `${what} not found`);

export async function startFakeCode(options: FakeCodeOptions = {}): Promise<FakeCode> {
  const clientId = options.clientId ?? "rovara-cloud";
  const clientSecret = options.clientSecret ?? "fake-secret";
  const now = options.now ?? (() => new Date());
  let current = options.person ?? PRIYA;
  /** People Code names no company for (DEC 253z), and Code's live member pre-approvals by the email's SHA-256. */
  const companyless = new Set<string>();
  const preapprovals = new Map<string, string>();
  /** DEC 254h: Code's single-use invite secrets by their SHA-256 (Code keeps only the hash), each bound to the company and its pre-approval. */
  const inviteSecrets = new Map<string, { companyId: string; emailHash: string; expiresAt: number; used: boolean }>();
  /** Access tokens whose sign-in spent an invite secret (the access answer's `joinedByInvite`). */
  const joinedTokens = new Set<string>();
  // Guided onboarding (Code PR #830): single-use GitHub connect states and choose tickets, each for the person who got it; the company's bound installations.
  const githubStates = new Map<string, { developerId: string; spent: boolean }>();
  const githubTickets = new Map<string, { developerId: string; spent: boolean }>();
  const githubBound = new Map<number, { accountLogin: string; connectedAt: string; by: Person }>();
  // Guided onboarding PR 11 (Code PRs #836, #840, #838): single-use Slack and Linear states, the company's workspace, channel links and Linear team picks.
  const connectStates = new Map<string, { developerId: string; spent: boolean; provider: "slack" | "linear" }>();
  let slackWorkspace: { teamId: string; teamName: string; connectedAt: string; by: Person } | undefined;
  const slackLinks = new Map<string, string>();
  const slackChannels = [{ id: "CGENERAL1", name: "general", isPrivate: false }, { id: "CWEBDEV01", name: "web-dev", isPrivate: false }, { id: "GPRIVATE1", name: "private-team", isPrivate: true }];
  let linearWorkspace: { id: string; name: string; urlKey: string; connectedAt: string; by: Person } | undefined;
  const linearTeams = [{ id: "lin-team-web", key: "WEB", name: "Web team" }, { id: "lin-team-ops", key: "OPS", name: "Operations" }];
  const linearPicks = new Map<string, string>();
  // Guided onboarding PR 9 (Code #841, #844): each project's skipped optional rows and its hosted setup run (set by the specs through /__fake/setup-run).
  const setupSkips = new Map<string, Set<"slackChannel" | "linear" | "invites">>();
  type FakeRun = { status: "none" | "running" | "ready" | "failed"; startedAt?: string; taskId?: string; stop?: "stopped_by_person" | "proposed"; /** L4-T2: a person approved the setup and its check is ready (Code's rule for Done). A ready run is not approved until a spec says so. */ approved?: boolean };
  const setupRuns = new Map<string, FakeRun>();
  // Lead 4 W5 (Code W2): the pretend wiki, per project (set by the specs through /__fake/wiki); `off` makes Code answer its unknown-route 404, as a Code without the wiki does.
  const wikis = new Map<string, WikiFixtureOptions & { off?: boolean; broken?: boolean }>();
  /** Who may read a project's wiki, as Code decides it: someone with a role on the project, in the project's own company (an administrator reads every project of their company). */
  const wikiReads = (person: Person, name: string) => {
    const entry = project(name);
    if (entry === undefined || companyless.has(person.developerId) || (entry.companyId ?? FAKE_COMPANY_ID) !== companyOfPerson(person)) return false;
    return person.administrator || roleIn(person, name) !== undefined;
  };
  type SavedEnvMode = "off" | "route-missing" | "core-off" | "never" | "healthy" | "broken" | "extra-field" | "501";
  // L4-MF1: Code's saved environment panel read on its own /v1/app path (core host, read only), per project (set by the specs through /__fake/saved-env). The default is `off`, as a hosted
  // Code answers today (no image registry): a plain 404 "Saved environments are off for this install". `route-missing` is an older Code's unknown-route 404, `core-off` the core host's
  // "not on the core engine" 404, `broken` an answer that does not read, `extra-field` one with a field this file does not know.
  const savedEnvModes = new Map<string, SavedEnvMode>();
  const savedEnvAnswer = (method: string, path: string, person: Person): { status: number; body: unknown } | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/environment-image$/u.exec(path);
    if (match === null || method !== "GET") return undefined;
    const name = decodeURIComponent(match[1]!), mode = savedEnvModes.get(name) ?? "off";
    if (mode === "route-missing") return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
    if (mode === "core-off") return { status: 404, body: { error: { code: "NOT_FOUND", message: "That is not on the core engine on this install yet." } } };
    // Code's rule (canReadProject, checked before the switch): anyone who may not read the project, or another company's, gets the one 404.
    if (!wikiReads(person, name)) return { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
    if (mode === "501") return { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: "not served" } } };
    if (mode === "off") return { status: 404, body: { error: { code: "NOT_FOUND", message: "Saved environments are off for this install" } } };
    if (mode === "broken") return { status: 200, body: { health: "fine", canReset: "yes" } };
    const panel = { health: mode === "healthy" ? "healthy" : "never_proved", ...(mode === "healthy" ? { image: { builtAt: "2026-11-16T10:00:00.000Z", ageDays: 1, status: "ready" } } : {}), canReset: false, enabled: true, canChangeSetting: false };
    return { status: 200, body: mode === "extra-field" ? { ...panel, digest: "sha256:abc" } : panel };
  };
  // Lead 4 C1: the pretend corrections, per project and page (reset whenever a spec sets the wiki): notes added and approved here, claims marked wrong, notes removed.
  interface Corrections { added: Array<{ noteId: string; text: string; author: string; authorKey: string; createdAt: string; approval: "pending" | "approved"; file?: { repo: string; path: string } }>; approved: Set<string>; removed: Set<string>; marked: Set<string> }
  const corrections = new Map<string, Corrections>();
  const correctionsOf = (project: string, page: string): Corrections => { const key = `${project}/${page}`; const known = corrections.get(key) ?? { added: [], approved: new Set<string>(), removed: new Set<string>(), marked: new Set<string>() }; corrections.set(key, known); return known; };
  const withCorrections = (project: string, page: string, answer: ReturnType<typeof wikiPage>): ReturnType<typeof wikiPage> => {
    if (answer === undefined) return answer;
    const mine = correctionsOf(project, page);
    const notes = [...answer.notes, ...mine.added.map((note) => ({ noteId: note.noteId, text: note.text, author: note.author, createdAt: note.createdAt, approval: note.approval, ...(note.file === undefined ? {} : { file: note.file }) }))]
      .filter((note) => !mine.removed.has(note.noteId)).map((note) => (mine.approved.has(note.noteId) ? { ...note, approval: "approved" as const } : note));
    const claims = answer.page.claims.map((claim) => (mine.marked.has(claim.claimId) ? { ...claim, flagged: true } : claim));
    return { ...answer, page: { ...answer.page, claims }, notes, openFlags: answer.openFlags + [...mine.marked].filter((id) => !answer.page.claims.find((claim) => claim.claimId === id)?.flagged).length };
  };
  const corrected = (method: string, path: string, person: Person, body: unknown): { status: number; body: unknown } | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/wiki\/(?:pages\/([^/]+)\/(corrections|notes|flags)(?:\/([^/]+)\/(approve|delete|suggest-lesson)|\/(resolve))?|(disputed))$/u.exec(path);
    if (match === null) return undefined;
    const name = decodeURIComponent(match[1]!), set = wikis.get(name) ?? {};
    if (set.off) return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
    if (!wikiReads(person, name)) return { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
    const role = person.administrator ? "maintainer" : "contributor";
    const deny = { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a project maintainer, or an owner or admin of the company, can do that." } } };
    if (match[7] !== undefined) return method === "GET" ? (role === "maintainer" ? { status: 200, body: { project: name, more: false, items: [] } } : deny) : undefined;
    const page = decodeURIComponent(match[2]!), base = wikiPage(name, page, set);
    if (base === undefined) return { status: 404, body: { error: { code: "NOT_FOUND", message: "That wiki page is not there." } } };
    const mine = correctionsOf(name, page), input = (typeof body === "object" && body !== null ? body : {}) as { text?: string; claimId?: string; file?: { repo: string; path: string } };
    if (match[3] === "corrections" && method === "GET") {
      const shown = withCorrections(name, page, base)!;
      return { status: 200, body: { project: name, pageId: page, you: { role, addNote: true, markWrong: true, approveNotes: role === "maintainer", resolveMarks: role === "maintainer", seeDisputed: role === "maintainer" },
        notes: shown.notes.map((note) => ({ noteId: note.noteId, mine: mine.added.some((added) => added.noteId === note.noteId && added.authorKey === person.key), canDelete: role === "maintainer" || mine.added.some((added) => added.noteId === note.noteId && added.authorKey === person.key), canApprove: role === "maintainer" && note.approval === "pending", canSuggestLesson: /\b(always|never|must)\b/iu.test(note.text), mayBeOutOfDate: false })) } };
    }
    if (method !== "POST") return undefined;
    if (match[3] === "notes" && match[4] === undefined) {
      const note = { noteId: `note-${String(mine.added.length + 1).padStart(4, "0")}-new`, text: String(input.text ?? ""), author: person.name, authorKey: person.key, createdAt: iso(), approval: "pending" as const, ...(input.file === undefined ? {} : { file: input.file }) };
      mine.added.push(note);
      return { status: 200, body: { note: { noteId: note.noteId, text: note.text, author: note.author, createdAt: note.createdAt, approval: note.approval, ...(note.file === undefined ? {} : { file: note.file }) } } };
    }
    const noteId = match[4] === undefined ? undefined : decodeURIComponent(match[4]);
    if (match[5] === "approve") { if (role !== "maintainer") return deny; mine.approved.add(noteId!); return { status: 200, body: { noteId, approval: "approved" } }; }
    if (match[5] === "delete") { mine.removed.add(noteId!); return { status: 200, body: { deleted: true } }; }
    if (match[5] === "suggest-lesson") return { status: 200, body: { state: "proposed", lessonId: "wn_fakelesson000000000001" } };
    if (match[3] === "flags" && match[6] === "resolve") { if (role !== "maintainer") return deny; const n = mine.marked.size; mine.marked.clear(); return { status: 200, body: { resolved: n } }; }
    if (match[3] === "flags") { if (input.claimId !== undefined) mine.marked.add(input.claimId); return { status: 200, body: { flagId: `flag-${String(mine.marked.size).padStart(4, "0")}-new`, pageId: page, ...(input.claimId === undefined ? {} : { claimId: input.claimId }) } }; }
    return undefined;
  };
  /** Lead 4 L4-LP3W: what an agent is told in a wiki page's area (Code `GET .../wiki/pages/{id}/lessons`): the module page and the repository page of beacon-api have an area and two approved lessons; no other page has an area. */
  const TEAM_NOTE = "These are the team's approved lessons for this area. Agents are told them as notes, not commands, and the code wins when they disagree.";
  const TEAM_ROWS = [
    { id: "L-les_retry0001", lessonId: "les_retry0001", version: 1, type: "pitfall", statement: "Wrap webhook calls in withRetry", why: "Network calls to payment providers go through withRetry.", detail: "Every outbound call in src/billing/ goes through withRetry from src/net/retry.ts.", scopeLabel: "repo beacon-api src/billing/**", trust: "team-approved" },
    { id: "L-les_fakebill1", lessonId: "les_fakebill1", version: 2, type: "convention", statement: "Use FakeBilling in tests, never the live billing API", why: "Real calls charge the sandbox account.", detail: "When writing a test under src/billing/, build the client with makeFakeBilling().", scopeLabel: "repo beacon-api src/billing/**", trust: "team-approved" },
  ];
  const teamLessonsOf = (project: string, pageId: string) => {
    const area = pageId === "beacon-api--billing" ? { repo: "beacon-api", folder: "src/billing" } : pageId === "repo-beacon-api" ? { repo: "beacon-api", folder: "" } : undefined;
    return { project, pageId, ...(area === undefined ? {} : { area }), lessons: area === undefined ? [] : TEAM_ROWS, moreLessons: 0, note: TEAM_NOTE };
  };
  /** Code's wiki read routes (W2; `/v1/app/projects/{p}/wiki`, `.../pages/{id}`, `.../pages/{id}/sources`), as the person; every refusal is Code's one 404. */
  const wikiAnswer = (method: string, path: string, person: Person, body: unknown = {}, search: URLSearchParams = new URLSearchParams()): { status: number; body: unknown } | undefined => {
    const done = corrected(method, path, person, body);
    if (done !== undefined) return done;
    const match = /^\/v1\/app\/projects\/([^/]+)\/wiki(?:\/(search|pages\/([^/]+)(\/sources|\/lessons)?))?$/u.exec(path);
    if (match === null || method !== "GET") return undefined;
    const name = decodeURIComponent(match[1]!), set = wikis.get(name) ?? {};
    if (set.off) return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
    const refuse = { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
    if (!wikiReads(person, name)) return refuse;
    if (set.broken) return { status: 200, body: { project: "elsewhere" } };
    if (match[2] === undefined) return { status: 200, body: wikiIndex(name, set) };
    if (match[2] === "search") return { status: 200, body: wikiSearch(name, search.get("q") ?? "") };
    const id = decodeURIComponent(match[3]!);
    // Lead 4 L4-LP3W: the team's lessons for a page's area: the module page and the repository page have one; any other page has no area.
    if (match[4] === "/lessons") return wikiPage(name, id, set) === undefined ? { status: 404, body: { error: { code: "NOT_FOUND", message: "page not found" } } } : { status: 200, body: teamLessonsOf(name, id) };
    const answered = match[4] === undefined ? withCorrections(name, id, wikiPage(name, id, set)) : wikiSources(name, id, set);
    return answered === undefined ? { status: 404, body: { error: { code: "NOT_FOUND", message: "page not found" } } } : { status: 200, body: answered };
  };
  // L4-D2 (Code #899): the candidate waiting for a decision on a project (set by the specs through /__fake/setup-apply), and what decide does with it.
  type FakeApply = { check: "checking" | "ready" | "failed"; risk: "low" | "medium" | "high"; changes: Array<{ area: string; risk: string }>; canApprove: boolean; canReject: boolean; moved: boolean; failedStep?: string; revision: number };
  const setupApplies = new Map<string, FakeApply>();
  const APPLY_DIGEST = "ab12".repeat(16);
  const applyView = (entry: FakeApply) => ({
    candidateRevision: entry.revision, baseRevision: entry.revision - 1, setup: ["npm ci"], readiness: ["npm test", "npm run lint"],
    check: { status: entry.check, ...(entry.failedStep === undefined ? {} : { failedStep: entry.failedStep }) }, risk: entry.risk, changes: entry.changes, approver: entry.risk === "high" ? "admin" as const : "maintainer" as const,
    canApprove: entry.check === "ready" && entry.canApprove, canReject: entry.check === "ready" && entry.canReject,
    ...(entry.check === "ready" ? { approval: { requestId: `setup-${APPLY_DIGEST.slice(0, 40)}-${String(entry.revision)}`, revision: entry.revision, artifactDigest: APPLY_DIGEST, kind: "setup" as const, risk: entry.risk } } : {}),
  });
  // Lead 4 W6 (Code W0's wiki-map, W4's wiki-build controls, and the nightly upkeep seam): each project's pretend wiki build, set by the specs through /__fake/wiki-setup. `off` makes Code answer its unknown-route 404.
  const wikiSetups = new Map<string, FakeWikiSetup>();
  const wikiSetupOf = (name: string): FakeWikiSetup => { let one = wikiSetups.get(name); if (one === undefined) { one = { status: "none", pages: 0, refreshPages: 0, agentsOn: false, aiKey: "connected", mapMade: false, planned: 0, written: 0, upkeepOn: false }; wikiSetups.set(name, one); } return one; };
  // L4-P2 (Code's two locks): the company's consent to Rovara's automatic runs is the company's, not a project's. It starts off; only a company owner or admin sets it, in the one PUT that also switches the project on.
  const upkeepConsent = new Map<string, boolean>();
  const companyKeyOf = (name: string) => project(name)?.companyId ?? "main";
  // L4-P3 (owner 2026-11-17): allowing or withdrawing the consent is a company owner's or admin's (no step-up since owner DEC 254zzz73).
  const companyConsentKey = (person: Person) => (companyOfPerson(person) === FAKE_COMPANY_ID ? "main" : companyOfPerson(person));
  /** Code's `GET`/`PUT /v1/app/company/system-runs`: a live company owner or admin only (a member is 403, a person with no company is not served). */
  const systemRunsAnswer = (method: string, person: Person, body: unknown): { status: number; body: unknown } => {
    const admin = person.administrator && !companyless.has(person.developerId);
    if (!admin) return failure(403, "FORBIDDEN", "Only company owners and admins can see or change whether Rovara's automatic runs are allowed for the company.");
    const key = companyConsentKey(person);
    const available = [...wikiSetups.values()].every((entry) => entry.ceilingOff !== true);
    const view = () => ({ available, allowed: upkeepConsent.get(key) === true, systemRunsOn: available && upkeepConsent.get(key) === true });
    if (method === "GET") return { status: 200, body: view() };
    const given = body as { requestId?: unknown; allowed?: unknown } | undefined;
    if (typeof given?.requestId !== "string" || typeof given.allowed !== "boolean") return failure(400, "CONFIG_INVALID", "the request is not valid");
    if (given.allowed) {
      if (!available) return failure(404, "NOT_AVAILABLE_HERE", "Rovara's automatic runs aren't available on this Rovara yet");
    }
    upkeepConsent.set(key, given.allowed);
    return { status: 200, body: view() };
  };
  const upkeepView = (name: string, one: FakeWikiSetup, person: Person, manage: boolean) => {
    if (one.legacyUpkeep === true) return { enabled: one.upkeepOn, canManage: manage, available: true };
    const available = one.ceilingOff !== true, admin = person.administrator && !companyless.has(person.developerId);
    return { enabled: one.upkeepOn, canManage: manage, available, systemRunsOn: available && upkeepConsent.get(companyKeyOf(name)) === true, canEnableSystemRuns: available && admin, cap: { monthlyUsd: one.capUsd ?? null, canRaise: admin }, ...(manage && one.paused !== undefined ? { paused: { reason: one.paused, month: "2026-11" } } : {}) };
  };
  const upkeepPut = (name: string, one: FakeWikiSetup, person: Person, manage: boolean, given: { on?: unknown; allowSystemRuns?: unknown }) => {
    if (one.legacyUpkeep === true) { one.upkeepOn = given.on === true; return { status: 200, body: upkeepView(name, one, person, manage) }; }
    if (one.ceilingOff === true) return failure(409, "NOT_AVAILABLE_HERE", "Nightly upkeep isn't available on this Rovara yet.");
    if (given.allowSystemRuns !== undefined) {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only company owners and admins can allow or stop Rovara's automatic runs for the company.");
      if (given.allowSystemRuns === false && given.on === true) return failure(400, "CONFIG_INVALID", "the request is not valid");
      upkeepConsent.set(companyKeyOf(name), given.allowSystemRuns === true);
    } else if (given.on === true && upkeepConsent.get(companyKeyOf(name)) !== true) {
      return failure(403, "FORBIDDEN", "A company owner or admin has to allow Rovara's automatic runs for the company first.");
    }
    one.upkeepOn = given.on === true;
    return { status: 200, body: upkeepView(name, one, person, manage) };
  };
  // L4-EVCI2: Code's eval check card (`/v1/app/projects/{p}/ci-eval-check`): each project's pretend proposals and confirmed check, set by the specs through /__fake/eval-check. `off` makes Code answer its unknown-route 404.
  interface FakeEvalCheck { off?: boolean; verdict: "proposals" | "none_found" | "unknown"; items: Array<{ name: string; source?: string; workflow: string; repository: string; basis: "name" | "commands" }>; confirmed?: { name: string; source?: string }; puts: number; lastBody?: unknown }
  const evalChecks = new Map<string, FakeEvalCheck>();
  const evalCheckOf = (name: string): FakeEvalCheck => {
    let one = evalChecks.get(name);
    if (one === undefined) { one = { verdict: "proposals", items: [{ name: "evals", source: "15368", workflow: ".github/workflows/ci.yml", repository: name, basis: "name" }, { name: "Quality gate", source: "15368", workflow: ".github/workflows/ci.yml", repository: name, basis: "commands" }], puts: 0 }; evalChecks.set(name, one); }
    return one;
  };
  const evalCheckAnswer = (method: string, path: string, person: Person, body: unknown): { status: number; body: unknown } | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/ci-eval-check$/u.exec(path);
    if (match === null || (method !== "GET" && method !== "PUT")) return undefined;
    const name = decodeURIComponent(match[1]!), one = evalCheckOf(name), grant = roleIn(person, name);
    if (one.off === true) return failure(404, "NOT_FOUND", "route not found");
    const manage = !companyless.has(person.developerId) && (person.administrator || grant === "administrator");
    if (project(name) === undefined || companyless.has(person.developerId) || (!manage && grant === undefined)) return failure(404, "NOT_FOUND", "project not found");
    const view = () => ({ status: 200, body: { project: name, canManage: manage, confirmed: one.confirmed === undefined ? null : { ...one.confirmed, changedAt: "2026-11-18T08:00:00.000Z" }, proposals: manage ? { verdict: one.verdict, items: one.verdict === "proposals" ? one.items : [], cut: false } : null, explanation: "Rovara shows this check's result on its pull requests." } });
    if (method === "GET") return view();
    one.lastBody = body;
    if (!manage) return failure(403, "FORBIDDEN", "Only company owners and admins, or this project's admins, can choose the eval check.");
    const given = body as { requestId?: unknown; check?: unknown; [key: string]: unknown } | undefined;
    if (typeof given?.requestId !== "string" || Object.keys(given).some((key) => key !== "requestId" && key !== "check") || given.check === undefined) return failure(400, "CONFIG_INVALID", "the request is not valid");
    one.puts += 1;
    if (given.check === null) { delete one.confirmed; return view(); }
    const check = given.check as { name?: unknown; source?: unknown };
    if (one.verdict === "unknown") return failure(503, "RUNTIME_UNAVAILABLE", "Rovara could not read your workflow files just now, so it cannot confirm a check. Try again.");
    const found = one.items.find((item) => item.name === check.name && item.source === check.source);
    if (one.verdict !== "proposals" || found === undefined) return failure(400, "CONFIG_INVALID", "That is not a check Rovara found in your workflow files. Open the setup again to see the list.");
    one.confirmed = { name: found.name, ...(found.source === undefined ? {} : { source: found.source }) };
    return view();
  };
  const wikiSetupAnswer = (method: string, path: string, person: Person, body: unknown): { status: number; body: unknown } | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/(wiki-map|wiki-build(?:\/(?:continue|stop|refresh|agents|delete))?|upkeep|setup-check)$/u.exec(path);
    if (match === null) return undefined;
    const name = decodeURIComponent(match[1]!), tail = match[2]!, one = wikiSetupOf(name), grant = roleIn(person, name);
    if (tail === "setup-check" ? one.setupCheckOff === true : tail === "upkeep" ? one.upkeepOff === true : one.off === true) return failure(404, "NOT_FOUND", "route not found");
    if (tail === "setup-check") {
      // L4-P1 + L4-U5: any live role reads (canManage and, while broken, the card); a person who manages starts the plain check (202), a repeat while one runs is 409.
      const manager = !companyless.has(person.developerId) && (person.administrator || grant === "administrator");
      if (project(name) === undefined || companyless.has(person.developerId) || (!manager && grant === undefined)) return failure(404, "NOT_FOUND", "project not found");
      if (method === "GET") {
        const repair = one.repair === undefined ? undefined : {
          title: "Setup needs repair", body: `The project's setup stopped working after recent code changes (${one.repair.step}). Rovara cannot build on this project until it is fixed.`,
          ...(one.repair.changed === undefined ? {} : { changed: one.repair.changed }), at: "2026-11-17T09:05:00.000Z", fixReady: one.repair.fixReady,
          actions: manager ? [one.repair.fixReady ? { id: "approve_new_setup", label: "Approve new setup" } : { id: "fix_setup", label: "Fix setup" }] : [],
        };
        return { status: 200, body: { status: one.repair === undefined ? (one.rechecking === true ? "checking" : "ready") : "failed", canManage: manager, ...(repair === undefined ? {} : { repair }) } };
      }
      if (!manager) return failure(403, "FORBIDDEN", "Only company owners and admins, or this project's admins, can run the project's setup.");
      if ((body as { requestId?: unknown } | undefined)?.requestId === undefined) return failure(400, "CONFIG_INVALID", "the request is not valid");
      if (one.rechecking === true) return failure(409, "WORKSPACE_BUSY", "A setup check is already running for this project.");
      one.rechecks = (one.rechecks ?? 0) + 1; one.rechecking = true;
      return { status: 202, body: { workspaceId: "ws-recheck" } };
    }
    const manage = !companyless.has(person.developerId) && (person.administrator || grant === "administrator");
    if (project(name) === undefined || companyless.has(person.developerId) || (!manage && grant === undefined) || !wikiReads(person, name)) return failure(404, "NOT_FOUND", "project not found");
    const view = (): { status: number; body: unknown } => ({ status: 200, body: wikiSetupBuildView(one, manage) });
    if (method === "GET") return tail === "wiki-map" ? { status: 200, body: one.mapMade ? { status: "ready", canManage: manage, map: wikiMapOf(name) } : { status: "none", canManage: manage } } : tail === "upkeep" ? { status: 200, body: upkeepView(name, one, person, manage) } : view();
    if (!manage) return failure(403, "FORBIDDEN", tail === "wiki-map" ? WIKI_SETUP_CODE_WORDS.mapNotAllowed : WIKI_SETUP_CODE_WORDS.notAllowed);
    const given = body as { requestId?: unknown; on?: unknown; allowSystemRuns?: unknown } | undefined;
    if (tail === "wiki-map") { one.mapMade = true; return { status: 200, body: { status: "ready", canManage: true, map: wikiMapOf(name) } }; }
    if (typeof given?.requestId !== "string") return failure(400, "CONFIG_INVALID", "the request is not valid");
    if (tail === "upkeep") return upkeepPut(name, one, person, manage, given);
    if (tail === "wiki-build/agents") { one.agentsOn = given.on === true; return view(); }
    if (tail === "wiki-build/delete") {
      if (one.status === "running") return failure(409, "WORKSPACE_BUSY", WIKI_SETUP_CODE_WORDS.deleteWhileRunning);
      Object.assign(one, { status: "none", pages: 0, refreshPages: 0, agentsOn: false, planned: 0, written: 0, mapMade: false });
      delete one.stop;
      return { status: 200, body: { deleted: true, message: WIKI_SETUP_CODE_WORDS.deleted, view: wikiSetupBuildView(one, true) } };
    }
    if (tail === "wiki-build/stop") {
      if (one.status === "running") Object.assign(one, { status: "stopped", stop: "stopped_by_person" });
      return { status: 202, body: wikiSetupBuildView(one, true) };
    }
    if (one.status === "running") return failure(409, "WORKSPACE_BUSY", WIKI_SETUP_CODE_WORDS.busy);
    if (one.aiKey === "missing") return failure(503, "MODEL_PROXY_UNAVAILABLE", WIKI_SETUP_CODE_WORDS.connectKey);
    if (tail === "wiki-build/continue") {
      if (one.status !== "stopped") return failure(400, "CONFIG_INVALID", WIKI_SETUP_CODE_WORDS.nothingToContinue);
      one.status = "running";
      return { status: 202, body: wikiSetupBuildView(one, true) };
    }
    if (tail === "wiki-build/refresh") {
      if (one.pages === 0) return failure(400, "CONFIG_INVALID", WIKI_SETUP_CODE_WORDS.buildFirst);
      if (one.refreshPages === 0) return failure(400, "CONFIG_INVALID", WIKI_SETUP_CODE_WORDS.nothingToRefresh);
      Object.assign(one, { status: "running", planned: one.refreshPages, written: 0 });
      delete one.stop;
      return { status: 202, body: wikiSetupBuildView(one, true) };
    }
    if (!one.mapMade) return failure(400, "CONFIG_INVALID", WIKI_SETUP_CODE_WORDS.noMap);
    Object.assign(one, { status: "running", planned: 24, written: 6 });
    delete one.stop;
    return { status: 202, body: wikiSetupBuildView(one, true) };
  };
  type HowWeWorkMode = "on" | "off" | "core-off" | "broken" | "501" | "403";
  // Walkthrough 2026-11-17 item 4: Code's How we work read on its own /v1/app path (core host, read only), per project (set by the specs through /__fake/how-we-work).
  // `off` is an older Code's unknown-route 404, `core-off` the core host's "not on the core engine" 404, `broken` an answer for another project.
  const howWeWorkModes = new Map<string, HowWeWorkMode>();
  const howWeWorkAnswer = (method: string, path: string, person: Person): { status: number; body: unknown } | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/how-we-work$/u.exec(path);
    if (match === null || method !== "GET") return undefined;
    const name = decodeURIComponent(match[1]!), mode = howWeWorkModes.get(name) ?? "on";
    if (mode === "off") return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
    if (mode === "core-off") return { status: 404, body: { error: { code: "NOT_FOUND", message: "That is not on the core engine on this install yet." } } };
    // Code's rule (canReadProject: the person's own grant row on the project, in the project's own company; no company-administrator shortcut); anyone else gets the one 404.
    const entry = project(name);
    if (entry === undefined || companyless.has(person.developerId) || (entry.companyId ?? FAKE_COMPANY_ID) !== companyOfPerson(person) || roleIn(person, name) === undefined) return { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
    if (mode === "501") return { status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: "not served" } } };
    if (mode === "403") return { status: 403, body: { error: { code: "FORBIDDEN", message: "This sign-in can't read projects." } } };
    if (mode === "broken") return { status: 200, body: { project: "elsewhere", playbookRevision: 1, process: { kind: "builtin", agentId: "rovara-standard" }, stages: [], rules: [], modelsEditable: false } };
    return { status: 200, body: { project: name, playbookRevision: 3, process: { kind: "builtin", agentId: "rovara-standard" }, stages: [], rules: [], modelsEditable: false, requestId: "req-fake" } };
  };
  // Lead 4 J3 (Code J1 and its start-suggest route): the pretend answer service, per project (set by the specs through /__fake/answers). Default is a Code with no model set up: every answer is the fixed
  // "not set up" outcome and the suggestion says the classifier is unavailable. `off` makes Code answer its unknown-route 404. Who may ask is Code's rule for the wiki (a role on the project in its own company).
  const answerSets = new Map<string, { answers?: "answered" | "not_set_up" | "off"; suggest?: Record<string, unknown> }>();
  const ANSWER_SHA = "a".repeat(40);
  const answersAnswer = (method: string, path: string, person: Person, given: unknown): { status: number; body: unknown } | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/(answers|code\/suggest)$/u.exec(path);
    if (match === null || method !== "POST") return undefined;
    const name = decodeURIComponent(match[1]!), set = answerSets.get(name) ?? {};
    if (set.answers === "off") return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
    if (!wikiReads(person, name)) return { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
    if (match[2] === "code/suggest") return { status: 200, body: set.suggest ?? { kind: "unknown", classifier: "unavailable", pick: "answer" } };
    const asked = (given as { question?: unknown }).question;
    if (typeof asked !== "string" || asked.trim() === "") return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "An answer needs a request ID and a question of 1 to 1,000 characters." } } };
    if (set.answers !== "answered") return { status: 200, body: { threadId: "t-fake0001", outcome: "not_set_up", text: "", honesty: "Answers are not set up here yet.", unconfirmed: [], sources: [], wikiPages: [] } };
    return { status: 200, body: {
      answerId: "a-fake0001", threadId: "t-fake0001", outcome: "answered", text: "Refunds go out to the payment provider and come back by webhook. [1] Only full refunds work today. [2]", unconfirmed: [],
      honesty: "I checked the code: the wiki was out of date here.", wikiPages: [{ pageId: "beacon-api--billing", title: "billing" }],
      sources: [{ n: 1, repo: "beacon-api", path: "src/billing/refund.ts", line: 12, lineEnd: 40, commit: ANSWER_SHA }, { n: 2, repo: "beacon-api", path: "src/billing/webhooks.ts", line: 104, lineEnd: 139, commit: ANSWER_SHA }],
      action: { kind: "quick_task", label: "Start a Quick task", title: "Support partial refunds" },
    } };
  };
  const log: FakeCode["log"] = [];
  const iso = () => now().toISOString();

  // --- sign-in state
  const codes = new Map<string, { person: Person; challenge: string; redirectUri: string; joined?: true }>();
  const access = new Map<string, Person>();
  const refresh = new Map<string, Person>();

  // --- data
  const projects: Array<{ companyId?: string; name: string; repositories: Array<{ name: string; url: string; defaultBranch: string; fullName: string }>; members: Map<string, "administrator" | "developer"> }> = [
    { name: "web", repositories: [{ name: "web", url: "https://github.com/example/web", defaultBranch: "main", fullName: "example/web" }], members: new Map([[PRIYA.developerId, "administrator"], [SAM.developerId, "developer"]]) },
    { name: "api", repositories: [{ name: "api", url: "https://github.com/example/api", defaultBranch: "main", fullName: "example/api" }], members: new Map([[PRIYA.developerId, "administrator"]]) },
    { companyId: OTHER_COMPANY_ID, name: "secret-ledger", repositories: [{ name: "secret-ledger", url: "https://github.com/other-co/secret-ledger", defaultBranch: "main", fullName: "other-co/secret-ledger" }], members: new Map([[ZED.developerId, "administrator"]]) },
  ];
  const companyOfPerson = (person: Person) => person.company?.id ?? FAKE_COMPANY_ID;
  const project = (name: string) => projects.find((entry) => entry.name === name);
  const ticketUpdates = new Map<string, { comments: boolean; changeStatus: boolean; statuses: Record<string, string>; level?: "status_only" | "decisions" | "plan_decisions" | "full" }>();
  const ticketUpdatesAnswer = (method: string, path: string, who: Person, body: unknown) => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/intake\/updates$/u.exec(path);
    if (match === null) return undefined;
    const name = decodeURIComponent(match[1]!);
    const selected = project(name);
    if (selected === undefined || companyOfPerson(who) !== (selected.companyId ?? FAKE_COMPANY_ID) || (!who.administrator && !selected.members.has(who.developerId))) return { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
    const canEdit = who.administrator || selected.members.get(who.developerId) === "administrator";
    const key = `${selected.companyId ?? FAKE_COMPANY_ID}:${name}`;
    const settings = ticketUpdates.get(key) ?? { comments: true, changeStatus: false, statuses: { started: "In Progress", pr_opened: "In Review", merged: "Done" } };
    if (method === "GET") return { status: 200, body: { settings, canEdit, access: [] } };
    if (method !== "PUT") return { status: 405, body: { error: { code: "METHOD_NOT_ALLOWED", message: "method not allowed" } } };
    if (!canEdit) return { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a project admin can change these settings." } } };
    if (typeof body !== "object" || body === null || !("requestId" in body) || !((body as { requestId?: unknown }).requestId) || !("settings" in body)) return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Send valid ticket update settings." } } };
    const next = (body as { settings: typeof settings }).settings;
    ticketUpdates.set(key, next);
    return { status: 200, body: { settings: next, canEdit, access: [] } };
  };
  const linearRedirectUri = options.linearRedirectUri ?? "http://127.0.0.1:8787/api/connect/linear/callback";
  const linkNotAllowed = "Only a company owner or admin, or this project's admin, can link or unlink its Slack channel.";
  /** Link (or ask for the /invite: a private channel needs Check after /invite, which the fake takes as done). */
  const fakeLink = (name: string, channelId: string, person: Person, check: boolean) => {
    if (project(name) === undefined) return failure(404, "NOT_FOUND", "project not found");
    if (!person.administrator) return failure(403, "FORBIDDEN", linkNotAllowed);
    if (slackWorkspace === undefined) return failure(409, "SLACK_NOT_CONNECTED", "Add Rovara to Slack first: this company has no Slack workspace connected.");
    const channel = slackChannels.find((one) => one.id === channelId);
    if (channel === undefined) return failure(409, "SLACK_CHANNEL_REFUSED", "This channel is shared with another organization, so it can't be linked. Pick a channel only your workspace uses.");
    const holder = slackLinks.get(channel.id);
    if (holder !== undefined && holder !== name) return failure(409, "SLACK_CHANNEL_TAKEN", "This channel is already linked to another project. Unlink it there first.");
    if (channel.isPrivate && !check) return { body: { status: "invite_needed" as const, workspace: { teamId: slackWorkspace.teamId }, channel: { id: channel.id }, message: "Type `/invite @Rovara` in the channel, then press Check." } };
    const replaced = [...slackLinks].filter(([id, linked]) => linked === name && id !== channel.id).map(([id]) => id);
    for (const id of replaced) slackLinks.delete(id);
    slackLinks.set(channel.id, name);
    return { body: { status: "linked" as const, workspace: { teamId: slackWorkspace.teamId }, channel, alreadyLinked: holder === name, replaced } };
  };
  const fakeTeamRefusal = (name: string, person: Person) => {
    if (project(name) === undefined) return failure(404, "NOT_FOUND", "project not found");
    if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin, or the project's admin, can choose its Linear team.");
    if (linearWorkspace === undefined) return failure(409, "LINEAR_NOT_CONNECTED", "Linear isn't connected for this company. A company owner or admin can connect it in Company settings, Connections.");
    return undefined;
  };
  const roleIn = (person: Person, name: string) => project(name)?.members.get(person.developerId);
  // Guided onboarding PR 9: the checklist read (Code #841's rule: any member of the company reads, a company admin or the project's admin sets rows aside) and the hosted
  // setup run (Code #844's rule: a company owner/admin or the project's admin manages, a project user reads, anyone else "project not found").
  const runOf = (name: string): FakeRun => setupRuns.get(name) ?? { status: "none" };
  const FAILED_COMMAND = { n: 2, command: "npm test", exitCode: 1, timedOut: false, lastLines: ["FAIL src/app.test.ts", "  expected 2, received 3", "Tests: 1 failed, 41 passed"] };
  const setupStatusOf = (name: string, person: Person) => {
    const entry = project(name)!;
    const run = runOf(name), skips = setupSkips.get(name) ?? new Set();
    const grant = entry.members.get(person.developerId);
    const companyRole = person.administrator ? "owner" as const : "member" as const;
    const baseRow = run.status === "none" ? { state: "needs_you" as const, status: "none" as const, approval: "none" as const }
      : run.status === "running" ? { state: "running" as const, status: "running" as const, approval: "none" as const, startedAt: run.startedAt, elapsedMs: 95_000, costCents: 12, commandsRun: 3 }
      : run.status === "ready" ? { state: run.approved === true ? "done" as const : "needs_you" as const, status: "ready" as const, ...(run.approved === true ? { approval: "approved" as const, check: { status: "ready" as const }, approvedAt: "2026-11-12T10:00:00.000Z" } : { approval: "none" as const }), startedAt: run.startedAt, elapsedMs: 412_000, costCents: 48, commandsRun: 9, commandsFound: { setup: 2, tests: 1 }, testOutcome: "passed" as const }
      : { state: "failed" as const, status: "failed" as const, approval: "none" as const, startedAt: run.startedAt, elapsedMs: 300_000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "failed" as const, ...(run.stop === undefined ? {} : { stop: run.stop }), failure: "A test command failed.", failedCommand: FAILED_COMMAND };
    // L4-T2: a candidate waiting for a decision (/__fake/setup-apply) is Needs you (its check ready or failed) or Running (its check going), as Code says.
    const waiting = setupApplies.get(name);
    const runRow = waiting === undefined || run.status === "running" || run.status === "failed" ? baseRow
      : { ...baseRow, state: waiting.check === "checking" ? "running" as const : "needs_you" as const, approval: waiting.check === "checking" ? "checking" as const : "candidate" as const,
        check: { status: waiting.check, ...(waiting.failedStep === undefined ? {} : { failedStep: waiting.failedStep }) } };
    const setupDone = run.status === "ready";
    const evalRow = setupDone && evalOf(name).state === "approved" ? { state: "done" as const, report: "confirmed" as const, confirmedSelection: "npm run evals" } : setupDone ? { state: "needs_you" as const, report: "reported" as const, suites: [{ selection: "npm test", questions: 3 }] } : { state: "needs_you" as const, report: "none" as const, blockedBy: "setupRun" as const };
    const channels = [...slackLinks].filter(([, linked]) => linked === name).map(([channelId]) => ({ channelId, name: slackChannels.find((one) => one.id === channelId)?.name ?? channelId }));
    const team = linearPicks.get(name);
    const optional = (set: boolean, row: "slackChannel" | "linear" | "invites") => set ? "done" as const : skips.has(row) ? "skipped" as const : "optional" as const;
    const rows = {
      repos: { state: "done" as const, count: entry.repositories.length, items: entry.repositories.map((one) => ({ name: one.name, fullName: one.fullName, defaultBranch: one.defaultBranch })) },
      setupRun: runRow, evalConfirm: evalRow,
      aiAndSpend: { state: "done" as const, source: companyModel === undefined ? "default" as const : "company" as const, companyModelSaved: companyModel !== undefined, modelBudgetUsd: null },
      slackChannel: { state: optional(channels.length > 0, "slackChannel"), channels },
      linear: { state: optional(team !== undefined, "linear"), team: team === undefined ? null : { id: team, name: linearTeams.find((one) => one.id === team)?.name ?? team } },
      invites: { state: optional(false, "invites") },
      firstTask: { state: "needs_you" as const, hasTask: false, canStart: false },
    };
    const order = ["repos", "setupRun", "evalConfirm", "aiAndSpend", "slackChannel", "linear", "invites", "firstTask"] as const;
    const done = order.filter((row) => rows[row].state === "done" || rows[row].state === "skipped").length;
    const nextRequired = (["repos", "setupRun", "evalConfirm", "aiAndSpend", "firstTask"] as const).find((row) => rows[row].state !== "done") ?? null;
    return { project: name, viewer: { companyRole, projectAdmin: grant === "administrator", canSkip: person.administrator || grant === "administrator" }, progress: { done, total: order.length, percent: Math.round((done / order.length) * 100), nextRequired }, ...rows };
  };
  const setupRunView = (name: string, manage: boolean) => {
    const run = runOf(name);
    return { status: run.status, basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, ...(run.taskId === undefined ? {} : { taskId: run.taskId }), ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }), ...(run.status === "failed" ? { failure: "A test command failed.", ...(run.stop === undefined ? {} : { stop: run.stop }) } : {}), canManage: manage, ...(setupApplies.has(name) ? { apply: applyView(setupApplies.get(name)!) } : {}) };
  };
  // L4-EVC (DEC 254zzz20): the setup flow's ONE eval card, in dollars (Code's hosted eval routes, small). A project with a finished setup run has an eval to approve; the specs set the stage through /__fake/eval-card.
  type FakeWrapperStep = "needs_file" | "pull_request_open" | "file_found" | "dismissed" | "not_offered" | "custom";
  type FakeEval = { state: "none" | "propose" | "waiting" | "approved" | "rejected"; health: "none" | "requested" | "finished"; wrapper?: FakeWrapperStep };
  const evalCards = new Map<string, FakeEval>();
  const EVAL_SEEN = { perCheckHighMicros: 1_200_000, monthlyCapMicros: 41_000_000 };
  const EVAL_OFFER = { requestId: `eval-${"e".repeat(40)}-3`, revision: 3, artifactDigest: "cd34".repeat(16) };
  const evalOf = (name: string): FakeEval => evalCards.get(name) ?? { state: runOf(name).status === "ready" ? "propose" : "none", health: "none" };
  /** L4-EVW4 (DEC 254zzz43): Code's wrapper card, small: the file's path and text for everyone, the pull request only for a manager. */
  const WRAPPER_FILE = "#!/usr/bin/env python3\n# Made by Rovara so it can read the results of your eval.\n# rovara-eval-wrapper-template: 1\nimport json\n";
  const wrapperCard = (step: FakeWrapperStep, manage: boolean) => {
    const custom = step === "custom", shown = step === "dismissed" ? "dismissed" : step === "custom" ? "needs_file" : step;
    const lines: Record<string, string> = {
      needs_file: "Rovara needs a small file in your repository to read this eval's results. Add it yourself, or let Rovara open a pull request for it.",
      pull_request_open: "Rovara opened PR #12 with the file. Review and merge it; Rovara notices it on your default branch by itself.",
      file_found: "The file is on your default branch. Approve a test run (its cost is shown) so Rovara can check it reads your results.",
      dismissed: "Set aside for now. Pull requests will say the eval was not read until it is set up.",
      not_offered: "Rovara could not check a file for this eval, so it is not offering one. If you add your own file at the place Rovara looks, Rovara will find it.",
    };
    return {
      selection: "npm run evals", language: "python", kind: custom ? "custom" : "template", path: "rovara/eval-wrapper.py", content: step === "not_offered" ? "" : WRAPPER_FILE,
      title: "Rovara can't read the results of npm run evals yet", step: shown, line: lines[shown]!, offered: step !== "not_offered",
      canOpenPullRequest: manage && step === "needs_file",
      ...(custom ? { copyOnly: { reason: "custom", text: "A file Rovara's setup agent wrote itself is copy-only: copy it into your repository." } } : {}),
      ...(step === "pull_request_open" ? { pullRequest: { number: "12", url: "https://github.com/acme/web/pull/12", state: "open" } } : {}),
      ...(step === "file_found" ? { fileStatus: "same" } : {}), dismissed: step === "dismissed",
    };
  };
  const evalCardAnswer = (method: string, tail: string, name: string, manage: boolean, body: unknown): { status: number; body: unknown } => {
    const card = evalOf(name);
    if (method === "GET") {
      const sentence = "Running your evals on each AI change will cost about $0.50-$1.20 per PR, at most $41.00 a month. Approve?";
      return { status: 200, body: {
        project: name, state: card.state, canApprove: manage,
        ...(card.state === "none" ? {} : { report: { taskId: "task_fake-eval", reportDigest: "ab12".repeat(16) } }),
        suites: card.state === "propose" ? [{ selection: "npm run evals", files: ["evals/a.yaml", "evals/b.yaml"], cases: 12, sentence, perPr: "$0.50-$1.20", monthly: "$41.00", seen: EVAL_SEEN, ...(card.wrapper !== undefined && card.wrapper !== "file_found" ? { readable: false, needsFile: "Rovara can't read this eval's results yet. It needs a small file in your repository. Add it yourself or let Rovara open a pull request for it; once the file is on your default branch, approve a test run." } : {}) }] : [],
        ...(card.wrapper === undefined ? {} : { wrappers: [wrapperCard(card.wrapper, manage)] }),
        ...(card.state === "waiting" ? { spend: { state: "waiting", perPr: "$0.90-$2.40", monthly: "$41.00", needsApproval: "Needs approval: your eval set grew past the approved $1.20", approval: EVAL_OFFER } }
          : card.state === "approved" || card.state === "rejected" ? { spend: { state: card.state, perPr: "$0.50-$1.20", monthly: "$41.00" } } : {}),
        ...(card.state === "approved" ? { health: { state: card.health, label: "Check my evals now (about $2.40)", cost: "$2.40", seenCostMicros: 2_400_000 } } : {}),
      } };
    }
    const given = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    // L4-EVW4: a person's act on the wrapper card: exactly a request id, an act and (to open a pull request) the eval. "Check now" only reads, so a project member may ask it; every other act is for a manager.
    if (tail === "eval-wrapper") {
      const keys = Object.keys(given), action = given["action"];
      const known = ["open_pull_request", "dismiss", "reopen", "check"];
      if (typeof given["requestId"] !== "string" || !/^[0-9a-f-]{36}$/u.test(given["requestId"]) || typeof action !== "string" || !known.includes(action) || keys.some((key) => !["requestId", "action", "selection"].includes(key)) || (action === "open_pull_request" && typeof given["selection"] !== "string")) return failure(400, "CONFIG_INVALID", "requestId: invalid");
      if (action !== "check" && !manage) return failure(403, "FORBIDDEN", "Only a company owner, admin or project maintainer can ask Rovara to open a pull request for the eval's file, set it aside, or approve its test run.");
      const at = card.wrapper;
      if (at === undefined) return failure(404, "NOT_FOUND", "There is no eval report for this project's latest setup run.");
      const next: FakeWrapperStep = action === "open_pull_request" ? (at === "needs_file" ? "pull_request_open" : at) : action === "dismiss" ? "dismissed" : action === "reopen" ? "needs_file" : at;
      evalCards.set(name, { ...card, wrapper: next });
      return { status: 200, body: { project: name, action, ...(action === "open_pull_request" ? { outcome: { selection: given["selection"], state: next === "pull_request_open" ? "open" : "failed", ...(next === "pull_request_open" ? { number: "12", url: "https://github.com/acme/web/pull/12" } : { failure: "copy_only" }) } } : {}), wrappers: [wrapperCard(next, manage)] } };
    }
    if (!manage) return failure(403, "FORBIDDEN", "Only a company owner, admin or project maintainer can answer for the eval's spend.");
    if (tail === "eval-approve") {
      const seen = given["seen"] as Record<string, unknown> | undefined;
      if (card.state !== "propose" || given["approve"] !== true || seen?.["perCheckHighMicros"] !== EVAL_SEEN.perCheckHighMicros || seen["monthlyCapMicros"] !== EVAL_SEEN.monthlyCapMicros) return failure(409, "CHANGE_STALE", "Your evals changed. Look again.");
      evalCards.set(name, { state: "approved", health: "none" });
      return { status: 200, body: { project: name, state: "approved", perPr: "$0.50-$1.20", monthly: "$41.00", carried: false } };
    }
    if (tail === "eval-decide") {
      if (card.state !== "waiting" || given["requestId"] !== EVAL_OFFER.requestId) return failure(409, "CHANGE_STALE", "Your evals changed. Look again.");
      evalCards.set(name, { state: given["outcome"] === "approve" ? "approved" : "rejected", health: "none" });
      return { status: 200, body: { project: name, decision: given["outcome"] === "approve" ? "approved" : "rejected" } };
    }
    if (card.state !== "approved" || typeof given["requestId"] !== "string" || given["seenCostMicros"] !== 2_400_000) return failure(409, "CHANGE_STALE", "Your evals changed. Look again.");
    evalCards.set(name, { ...card, health: "requested" });
    return { status: 200, body: { project: name, requested: true, duplicate: false, cost: "$2.40" } };
  };
  /** The hosted setup run's answer (Code #844 serves the laptop's /v1/app path), or undefined when the path is not one of its four. */
  const setupRunAnswer = (method: string, path: string, query: URLSearchParams, person: Person, body: unknown): { status: number; body: unknown } | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/setup-agent(?:\/(stop|journal|confirm|discard|decide|eval|eval-approve|eval-decide|eval-health|eval-wrapper))?$/u.exec(path);
    if (match === null) return undefined;
    const tail = match[2];
    if (!((method === "GET" && (tail === undefined || tail === "journal" || tail === "eval")) || (method === "POST" && tail !== "journal" && tail !== "eval"))) return undefined;
    const name = decodeURIComponent(match[1]!), entry = project(name), grant = roleIn(person, name);
    const manage = !companyless.has(person.developerId) && (person.administrator || grant === "administrator");
    if (entry === undefined || companyless.has(person.developerId) || (!manage && grant === undefined)) return failure(404, "NOT_FOUND", "project not found");
    if (tail === "eval" || tail === "eval-approve" || tail === "eval-decide" || tail === "eval-health" || tail === "eval-wrapper") return evalCardAnswer(method, tail, name, manage, body);
    if (method === "GET" && tail === undefined) return { status: 200, body: setupRunView(name, manage) };
    if (method === "GET") {
      const run = runOf(name), after = Number(query.get("after") ?? "0");
      const all = run.status === "none" ? [] : [
        { n: 1, source: "agent", command: "npm ci", exitCode: 0, durationMs: 42_000, timedOut: false, flagged: false, blockedHosts: [], tail: "added 812 packages in 41s", startedAt: run.startedAt ?? CREATED },
        ...(run.status === "running" ? [] : [{ n: 2, source: "agent", command: "npm test", exitCode: run.status === "failed" ? 1 : 0, durationMs: 61_000, timedOut: false, flagged: false, blockedHosts: [], tail: run.status === "failed" ? FAILED_COMMAND.lastLines.join("\n") : "Tests: 42 passed", startedAt: run.startedAt ?? CREATED }]),
      ];
      return { status: 200, body: { status: run.status, entries: all.filter((one) => one.n > after), hostAsks: [] } };
    }
    if (!manage) return failure(403, "FORBIDDEN", "Only company owners and admins, or this project's admins, can run the project's setup.");
    if (tail === "discard") { const had = setupApplies.delete(name); return { status: 200, body: { discarded: had } }; }
    if (tail === "decide") {
      const asked = body as { outcome?: string; seen?: { revision?: number; artifactDigest?: string } };
      const waiting = setupApplies.get(name);
      if (waiting === undefined || waiting.check !== "ready") return failure(409, "CHANGE_STALE", "There is no setup waiting for a decision. Open the project's setup again.");
      if (waiting.moved || asked.seen?.artifactDigest !== APPLY_DIGEST || asked.seen?.revision !== waiting.revision) return failure(409, "CHANGE_STALE", "The setup moved.");
      setupApplies.delete(name);
      // L4-T2: an approved setup (its check was ready) makes the checklist's Setup run row Done.
      if (asked.outcome === "approve") setupRuns.set(name, { ...runOf(name), approved: true });
      return { status: 200, body: { project: name, decision: asked.outcome === "approve" ? "approved" : "rejected", risk: waiting.risk, revision: waiting.revision, replayed: false } };
    }
    if (tail === "confirm") return failure(409, "WORKSPACE_BUSY", "Another setup is waiting for your approval. Decide it, or discard it, first.");
    const given = body as { requestId?: unknown };
    if (typeof given?.requestId !== "string" || Object.keys(given).length !== 1) return failure(400, "CONFIG_INVALID", "requestId: Required");
    const run = runOf(name);
    if (tail === undefined) {
      if (run.status === "running") return failure(409, "WORKSPACE_BUSY", "A setup run is already going for this project.");
      setupRuns.set(name, { status: "running", startedAt: iso(), taskId: randomUUID() });
      return { status: 202, body: setupRunView(name, true) };
    }
    if (run.status === "running") setupRuns.set(name, { ...run, status: "failed", stop: "stopped_by_person" });
    return { status: 202, body: setupRunView(name, true) };
  };
  // Guided onboarding PR 16/17: each project's archive state (Code #839's rule, small).
  const lifecycle = new Map<string, { status: "active" | "archived"; revision: number; receipts: Map<string, { personId: string; outcome: ArchiveOutcome }> }>();
  type ArchiveOutcome = CodeResponse<"client.projects.archive">;
  const lifecycleOf = (name: string) => { let entry = lifecycle.get(name); if (entry === undefined) { entry = { status: "active", revision: 0, receipts: new Map() }; lifecycle.set(name, entry); } return entry; };
  const lifecycleOr404 = <T,>(person: Person, name: string, then: (name: string, manage: boolean) => T) => {
    const grant = roleIn(person, name);
    const owner = !companyless.has(person.developerId) && person.administrator;
    if (project(name) === undefined || companyless.has(person.developerId) || (!owner && grant === undefined)) return failure(404, "NOT_FOUND", "project not found");
    return then(name, owner || grant === "administrator");
  };
  const lifecyclePreview = (kind: "archive" | "restore", name: string, manage: boolean) => {
    const entry = lifecycleOf(name);
    return {
      orgId: FAKE_COMPANY_ID, project: name, status: entry.status, expectedRevision: entry.revision, expectedProjectRevision: 3, checkedAt: iso(),
      ...(kind === "restore" ? { prerequisites: "not_required" as const } : {}),
      access: { actions: manage && entry.status === (kind === "archive" ? "active" : "archived") ? [kind] : [] },
      impact: kind === "archive" ? { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: 1, slackChannelsStayLinked: true, deletesNothing: true } : { allowsNewWork: true, linkedSlackChannels: 1 },
    };
  };
  const lifecycleChange = (kind: "archive" | "restore", name: string, manage: boolean, person: Person, body: CodeRequest<"client.projects.archive">) => {
    const ack = kind === "archive" ? body.acknowledgeNewWorkStops : body.acknowledgeNewWorkAllowed;
    if (ack !== true || typeof body.requestId !== "string") return failure(400, "CONFIG_INVALID", "the request is not valid");
    if (!manage) return failure(403, "FORBIDDEN", "Only company owners and admins, or this project's admins, can archive or restore it.");
    const entry = lifecycleOf(name);
    const earlier = entry.receipts.get(body.requestId);
    if (earlier !== undefined && earlier.personId === person.developerId) return { body: { ...earlier.outcome, replayed: true } };
    if ((body.expectedOrgId !== undefined && body.expectedOrgId !== FAKE_COMPANY_ID) || body.expectedRevision !== entry.revision || body.expectedProjectRevision !== 3 || entry.status !== (kind === "archive" ? "active" : "archived")) {
      return failure(409, "CHANGE_STALE", "The project changed. Review it again before you archive or restore it.");
    }
    entry.status = kind === "archive" ? "archived" : "active"; entry.revision += 1;
    const receipt = { project: name, status: entry.status, revision: entry.revision, projectRevision: 3, [kind === "archive" ? "archivedAt" : "restoredAt"]: iso(), egressReconciliation: "pending" };
    const outcome: ArchiveOutcome = { receipt, replayed: false, current: lifecyclePreview(kind, name, manage), effects: kind === "archive" ? { egress: "not_attempted", archiveHook: "not_configured" } : { egress: "not_attempted" } };
    entry.receipts.set(body.requestId, { personId: person.developerId, outcome });
    return { body: outcome };
  };
  // Guided onboarding PR 15: the company's engine model (Code #835) and each project's cost settings (Code's M4a), small.
  /** Rovara's outbound addresses as the fake Code holds them (documentation-range style public addresses, not real ones). */
  const EGRESS_ADDRESSES = ["198.51.100.10", "198.51.100.20"];
  const OFFERED_MODELS = ["zai.glm-4.7", "claude-sonnet-4-5", "zai.glm-4.6"];
  let companyModel: string | undefined;
  /** DEC 254zzz63 (Code #1075): the company's lessons learning model; the install default is Claude Haiku 5.5, only Claude models are offered. */
  const LEARNING_OFFERED = ["claude-sonnet-5-5", "claude-haiku-5-5"];
  let learningModel: string | undefined;
  const learningView = () => { const model = learningModel ?? "claude-haiku-5-5"; return { model, source: learningModel === undefined ? "install" as const : "company" as const, offered: [...LEARNING_OFFERED], preselect: LEARNING_OFFERED.includes(model) ? model : LEARNING_OFFERED[0]! }; };
  const engineView = () => { const model = companyModel ?? "zai.glm-4.6"; return { model, source: companyModel === undefined ? "install" as const : "company" as const, offered: [...OFFERED_MODELS], preselect: OFFERED_MODELS.includes(model) ? model : OFFERED_MODELS[0]! }; };
  const projectSettings = new Map<string, { overrides: Record<string, unknown>; revision: number }>();
  const settingsView = (name: string) => {
    const entry = projectSettings.get(name) ?? { overrides: {}, revision: 0 };
    const own = entry.overrides["model_budget_usd"];
    return { preset: null, overrides: { ...entry.overrides }, revision: entry.revision, updatedAt: null, updatedBy: null, resolved: {}, values: { model_budget_usd: { value: own === undefined ? null : own, origin: own === undefined ? "preset" : "project" } }, clamped: [] };
  };

  const base = (taskId: string, owner: Person, patch: Partial<TaskView> & { title: string; project: string }): { owner: Person; task: TaskView } => ({
    owner,
    task: { taskId, status: "RUNNING", startingRevision: 1, client: "Rovara Cloud", shared: false, events: [], changedFiles: [], artifacts: [], pullRequests: [], createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:05:00.000Z", ...patch },
  });
  const blockedCandidate = candidateOf();
  const tasks = new Map<string, { owner: Person; task: TaskView }>([
    [TASK_IDS.planReview, base(TASK_IDS.planReview, PRIYA, { title: "Add a retry to the billing webhook", project: "web", workflow: workflowOf(TASK_IDS.planReview, PRIYA, { stage: "PLAN_REVIEW", state: "WAITING", revision: 4, artifacts: [planArtifact(TASK_IDS.planReview)] }) })],
    [TASK_IDS.running, base(TASK_IDS.running, PRIYA, { title: "Speed up the search index", project: "api", workflow: workflowOf(TASK_IDS.running, PRIYA, { stage: "IMPLEMENT", state: "RUNNING", revision: 7, artifacts: [planArtifact(TASK_IDS.running)] }) })],
    [TASK_IDS.failed, base(TASK_IDS.failed, PRIYA, { title: "Upgrade the date library", project: "web", status: "FAILED", workflow: workflowOf(TASK_IDS.failed, PRIYA, { stage: "IMPLEMENT", state: "BLOCKED", revision: 9, blockReason: "The coding step could not finish." }) })],
    [TASK_IDS.pullRequest, base(TASK_IDS.pullRequest, PRIYA, { title: "Fix the README typo", project: "web", status: "SUCCEEDED", pullRequests: [{ repository: "example/web", number: 42, url: "https://github.com/example/web/pull/42", state: "open" }], workflow: workflowOf(TASK_IDS.pullRequest, PRIYA, { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 12, ...readyToMerge(candidateOf()) }) })],
    [TASK_IDS.blockedReview, base(TASK_IDS.blockedReview, PRIYA, { title: "Rename the settings page", project: "web", workflow: workflowOf(TASK_IDS.blockedReview, PRIYA, {
      stage: "REVIEW", state: "BLOCKED", revision: 10, candidate: blockedCandidate,
      reviews: [{ operationId: "66666666-6666-4666-8666-666666666666", candidateDigest: blockedCandidate.digest, role: "CRITIC", provider: "fake-model", version: "1", status: "FAILED", failureReason: "TIMEOUT", findings: [], readOnly: true, recordedAt: UPDATED }],
    }) })],
  ]);
  const readers = new Map<string, Map<string, TaskReader>>();
  // --- the in-app inbox (web task channel K5): Code's C7 shapes (core-host/inbox-routes.ts). Rows are kept per person and seeded by a spec (/__fake/inbox); `off` answers 404 like a Code with no inbox.
  const sessionOfTask = (taskId: string) => `ses_${createHash("sha256").update(`task-session\n${taskId}`, "utf8").digest("hex").slice(0, 20)}`;
  const inboxRows = new Map<string, Array<{ taskId: string; kind: string; atMs: number; read: boolean }>>();
  let inboxOff = false;
  const inboxAnswer = (method: string, pathname: string, query: URLSearchParams, person: Person, body: unknown): { status: number; body: unknown } | undefined => {
    const gone = { status: 404, body: { error: { code: "NOT_FOUND", message: "That is not on the core engine on this install yet." } } };
    const session = /^\/v1\/app\/sessions\/(ses_[0-9a-z]{20})$/u.exec(pathname);
    if (session !== null && method === "GET") {
      const found = [...tasks.values()].find((entry) => sessionOfTask(entry.task.taskId) === session[1]);
      return found === undefined ? { status: 404, body: { error: { code: "NOT_FOUND", message: "There is no such session." } } } : { status: 200, body: { session: { sessionId: session[1], body: { kind: "task", task: { taskId: found.task.taskId } } } } };
    }
    if (pathname !== "/v1/app/inbox" && pathname !== "/v1/app/inbox/read") return undefined;
    if (inboxOff) return gone;
    const own = [...(inboxRows.get(person.developerId) ?? [])].sort((a, b) => b.atMs - a.atMs);
    const idOf = (row: { taskId: string; kind: string; atMs: number }) => `${sessionOfTask(row.taskId)}.${row.kind}.${String(row.atMs)}`;
    if (pathname === "/v1/app/inbox/read" && method === "POST") {
      const ids = (body as { ids?: unknown }).ids;
      let marked = 0;
      for (const row of own) if (Array.isArray(ids) && ids.includes(idOf(row)) && !row.read) { row.read = true; marked += 1; }
      return { status: 200, body: { marked } };
    }
    if (pathname !== "/v1/app/inbox" || method !== "GET") return undefined;
    const limit = Number(query.get("limit") ?? "20"), start = query.get("cursor") === null ? 0 : Number(Buffer.from(query.get("cursor")!, "base64url").toString("utf8"));
    const shown = own.filter((row) => tasks.has(row.taskId));
    const page = shown.slice(start, start + limit);
    return { status: 200, body: {
      items: page.map((row) => ({ id: idOf(row), sessionId: sessionOfTask(row.taskId), kind: row.kind, title: tasks.get(row.taskId)!.task.title, status: "Waiting for you.", link: `https://fake-code.invalid/app/sessions/${sessionOfTask(row.taskId)}`, at: new Date(row.atMs).toISOString(), read: row.read })),
      ...(start + limit < shown.length ? { nextCursor: Buffer.from(String(start + limit), "utf8").toString("base64url") } : {}),
      ...(start === 0 ? { unread: shown.filter((row) => !row.read).length } : {}),
    } };
  };
  /**
   * Web task channel K4: the tasks a person was ADDED to (Code's involved index), by task id. `involvedMode` is how this Code answers `GET /v1/dev/tasks?involved=1`: `on` lists the
   * current person's involved tasks (`{ involved: true, tasks }`); `old` is a Code from before the route, which ignores the query and answers the ordinary list; the others refuse.
   */
  const involved = new Map<string, Set<string>>();
  /** The tasks `/__fake/involved` made, so a spec can take them away again (`reset`). */
  const involvedMade = new Set<string>();
  let involvedMode: "on" | "old" | "400" | "404" | "501" | "500" = "on";
  const startedByRequest = new Map<string, string>();
  const messages = new Map<string, TaskMessage[]>();
  const comments = new Map<string, PlanComment[]>();
  const playbooks = new Map<string, PlaybookView>();
  const scriptTokens = new Map<string, ScriptToken[]>();
  const scriptTokenKey = (person: Person) => `${person.company?.id ?? FAKE_COMPANY_ID}:${person.developerId}`;
  const scriptTokenRequests = new Set<string>();
  const decided = new Set<string>();
  const companyMembers: CompanyMember[] = PEOPLE.map((person, index) => ({ developerId: person.developerId, name: person.name, email: person.email, role: person.administrator ? "owner" : "member", joinedAt: `2026-10-0${String(index + 1)}T09:00:00.000Z` }));
  let preApproved: string[] = ["new.hire@example.test"];
  let preApprovedRevision = 1;

  const mayRead = (person: Person, taskId: string): { owner: Person; task: TaskView } | undefined => {
    const entry = tasks.get(taskId);
    if (entry === undefined) return undefined;
    return entry.owner.developerId === person.developerId || readers.get(taskId)?.has(person.developerId) === true || involved.get(taskId)?.has(person.developerId) === true ? entry : undefined;
  };
  const touch = (task: TaskView, patch: Partial<TaskView>) => { Object.assign(task, patch, { updatedAt: iso() }); };
  const taskOr404 = <K extends CodeRouteId>(context: Context<K>, then: (entry: { owner: Person; task: TaskView }) => Answer<K>): Answer<K> => {
    const entry = mayRead(context.person, context.params["taskId"] ?? "");
    return entry === undefined ? notFound("task") : then(entry);
  };
  const ownerTask = <K extends CodeRouteId>(context: Context<K>, then: (entry: { owner: Person; task: TaskView }) => Answer<K>): Answer<K> => {
    const entry = mayRead(context.person, context.params["taskId"] ?? "");
    if (entry === undefined) return notFound("task");
    return entry.owner.developerId === context.person.developerId ? then(entry) : failure(403, "FORBIDDEN", `Only ${entry.owner.name} can do that.`);
  };
  // --- task People (the planned Code shapes): roles per task person, a revision, and changes that commit at once or wait for the confirm page
  const personIdOf = (person: Person) => { const hex = person.developerId; return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
  const peopleStates = new Map<string, { revision: number; roles: Map<string, string>; listed: Set<string> }>();
  const peopleOf = (taskId: string) => { let state = peopleStates.get(taskId); if (state === undefined) { state = { revision: 3, roles: new Map(), listed: new Set() }; peopleStates.set(taskId, state); } return state; };
  const peopleListed = (entry: { owner: Person; task: TaskView }) => PEOPLE.filter((one) => one.developerId === entry.owner.developerId || peopleOf(entry.task.taskId).listed.has(one.developerId));
  // (Readers a Share made are not on this list: Code lists them apart until it folds them into People, which Cloud shows beside it.)
  const peopleView = (entry: { owner: Person; task: TaskView }, person: Person) => {
    const state = peopleOf(entry.task.taskId), mine = entry.owner.developerId === person.developerId;
    return {
      revision: state.revision, orphaned: false, canManage: mine, canTakeOwnership: !mine,
      people: peopleListed(entry).map((one) => {
        const role = one.developerId === entry.owner.developerId ? "owner" : state.roles.get(personIdOf(one)) ?? "viewer";
        return { personId: personIdOf(one), name: one.name, role, you: one.developerId === person.developerId, effectiveRole: role === "denied" ? null : role, method: one.key === "sam" ? "slack" : "github" };
      }),
    };
  };
  const pendingPeople = new Map<string, () => void>();
  const proposePeople = (entry: { owner: Person; task: TaskView }, person: Person, requestId: string, apply: () => void, needsConfirm: boolean) => {
    const commit = () => { apply(); peopleOf(entry.task.taskId).revision += 1; };
    if (!needsConfirm) { commit(); return { body: { change: { status: "COMMITTED", view: peopleView(entry, person) } } }; }
    pendingPeople.set(requestId, commit);
    return { body: { change: { status: "PENDING", requestId, confirmationUrl: `https://fake-code.invalid/review/${entry.task.taskId}/task/people/confirm/${requestId}`, expiresAt: new Date(now().getTime() + 600_000).toISOString() } } };
  };
  // Code's REAL plan answer (`{ plan: TaskPlanDocumentView }`, tests/fixtures/code-answers.ts, made by Code's own readTaskPlanDocument): only the task id, the digest the fake's
  // decision cards bind to and whether it was approved are this task's. Its claims ("1", "1.1", "2") are the criteria the proof index below points at.
  const planOf = (task: TaskView) => {
    const answer = taskPlanAnswer(task.taskId);
    return { plan: { ...answer.plan, sha256: PLAN_DIGEST, approved: task.workflow?.stage !== "PLAN_REVIEW" } };
  };

  /** One task as Code's detailed list row says it (aws/developer-tasks.ts listRowDetail): the workflow's own upper-case pull request states, the cost and limit as numbers. */
  const detailedRowOf = (task: TaskView): Record<string, unknown> => {
    const workflow = task.workflow as (TaskWorkflow & { path?: string; blockReason?: string }) | undefined;
    const pulls = (task.pullRequests ?? []) as Array<{ repository: string; number: number; url: string; state?: string }>;
    const spent = (task as { spent?: { usd?: number } }).spent?.usd, limit = (task as { runLimit?: { limitUsd?: number } }).runLimit?.limitUsd;
    return {
      taskId: task.taskId, title: task.title, project: task.project, status: task.status, shared: task.shared === true, createdAt: task.createdAt, updatedAt: task.updatedAt,
      ...(workflow === undefined ? {} : { workflow: { stage: workflow.stage, state: workflow.state, revision: workflow.revision, path: workflow.path ?? "FULL", ...(workflow.blockReason === undefined ? {} : { blockReason: workflow.blockReason }) } }),
      ...(pulls.length === 0 ? {} : { pullRequests: pulls.map((pull) => ({ repository: pull.repository, number: pull.number, url: pull.url, state: (pull.state ?? "unknown").toUpperCase() })) }),
      ...(spent === undefined ? {} : { costUsd: spent }), ...(limit === undefined ? {} : { runLimitUsd: limit }),
    };
  };

  const proofOf = (task: TaskView): ProofIndexResponse => ({
    taskId: task.taskId,
    items: [
      { sha256: "d".repeat(64), title: "Unit tests", kind: "test_report", verdict: "pass", criterionIds: ["1.1"], commit: "c".repeat(40), stale: false },
      { sha256: "e".repeat(64), title: "Type check", kind: "check_result", verdict: "pass", criterionIds: ["2"], commit: "c".repeat(40), stale: false },
      { sha256: "f".repeat(64), title: "Webhook retry eval", kind: "eval", verdict: "unknown", criterionIds: [], passed: 18, total: 20, bar: 0.95 },
    ],
  });

  // --- lessons (contract v0 `lessons.*`, Code's lessons API #713): project "web" has three proposed lessons (one from Priya's own correction, one that lapses within a
  // day), two approved and one retired; the pull-request task was given two. Priya (the project's administrator) decides; Sam reads and may ask to retire.
  let lessonsOn = true;
  /** The Cost and time report's rows and features (set by the specs through /__fake/report); none: Code does not serve the report (404), as before the report lane merges. */
  let reportData: { tasks: unknown[]; features: unknown[] } | undefined;
  /**
   * Lead 4 PCF: the open features each company's plan card offers and the feature each task is filed under (set by the specs through /__fake/plan-features). Code words the line, says who may change it
   * (a task filed by the tracker or not at all may be changed by its person; one a person chose only by an administrator) and refuses a feature of another company, as Code does.
   */
  const planChoices = new Map<string, Array<{ id: string; name: string }>>();
  const planFiled = new Map<string, { featureId: string | null; source: string }>();
  /** A spec can make Code say "this person may not change it" whatever the rule says (a person who only reads the plan card). */
  let planMayChange: boolean | undefined;
  const companyIdOf = (person: Person): string => person.company?.id ?? FAKE_COMPANY_ID;
  const planFeatureView = (person: Person, taskId: string) => {
    const own = planFiled.get(taskId);
    const named = own === undefined || own.featureId === null ? undefined : (planChoices.get(companyIdOf(person)) ?? []).find((item) => item.id === own.featureId);
    const words = own?.source === "tracker" ? "from the Linear parent" : "chosen";
    const canChange = planMayChange ?? (own === undefined || own.source === "tracker" || person.administrator);
    return { line: named === undefined ? "Feature: No feature" : `Feature: ${named.name} (${words})`, feature: named === undefined || own === undefined ? null : { id: named.id, name: named.name, source: own.source }, canChange, canCreate: canChange && person.administrator };
  };
  const DAY = 864e5;
  const at = (days: number) => now().getTime() + days * DAY;
  const lessonOf = (id: string, patch: Partial<LessonItem> & { title: string }): LessonItem => ({
    id, version: 1, type: "convention", stages: ["IMPLEMENT"], description: "", body: "", scope: { repos: ["example/web"], paths: [], languages: [] }, tier: 1, status: "pending",
    counters: { loaded: 0, helpful: 0, harmful: 0 }, createdAt: at(-2), updatedAt: at(-2), expiresAt: at(5), citations: [], from: [], measured: true, supportTasks: 1,
    canApprove: true, canReject: true, canRetire: true, ...patch,
  });
  const lessonPeople = new Map<string, string[]>();
  const lessonStore = new Map<string, LessonItem>([
    ["les_retry0001", lessonOf("les_retry0001", { title: "Wrap webhook calls in withRetry", description: "Network calls to payment providers go through withRetry.", body: "Every outbound call in src/billing/ goes through withRetry(fn, { attempts: 3 }). A bare fetch was sent back twice this week.", citations: [{ kind: "code", repo: "example/web", path: "src/billing/retry.ts", startLine: 12, endLine: 30, check: "valid" }], supportTasks: 2, createdAt: at(-1) })],
    ["les_tests0001", lessonOf("les_tests0001", { title: "Put new tests next to the module", description: "Tests live beside the file they test, as name.test.ts.", body: "Add tests as src/<area>/<name>.test.ts beside the module, not under a top-level tests folder.", citations: [{ kind: "pr", url: "https://github.com/example/web/pull/40" }], expiresAt: at(0.6), createdAt: at(-6), contradicts: "les_readme001" })],
    ["les_dates0001", lessonOf("les_dates0001", { title: "Use the shared date formatter", description: "Dates on screens go through formatDate, never toLocaleString.", body: "Use formatDate from src/text/dates.ts for every date a person reads.", type: "preference", tier: 0, createdAt: at(-3), needs: { required: 2, have: 0, groups: [] }, possibleDuplicate: "les_retry0001" })],
    ["les_logs00001", lessonOf("les_logs00001", { title: "Log request ids with every error", description: "Error logs carry the request id.", body: "Pass the request id to logger.error so a failed request can be traced.", status: "active", counters: { loaded: 14, helpful: 3, harmful: 1 }, supportTasks: 3, createdAt: at(-20), updatedAt: at(-18), lastUsedAt: at(-1) })],
    ["les_readme001", lessonOf("les_readme001", { title: "Keep the README's setup steps current", description: "A change to a setup command updates the README in the same pull request.", body: "When package.json scripts or the setup commands change, update README.md's Setup section in the same pull request.", status: "active", counters: { loaded: 6, helpful: 0, harmful: 0 }, createdAt: at(-12), updatedAt: at(-11) })],
    ["les_semis0001", lessonOf("les_semis0001", { title: "No semicolons in the old scripts folder", description: "An old style rule.", body: "Files in scripts/legacy have no semicolons.", status: "retired", createdAt: at(-60), updatedAt: at(-30) })],
  ]);
  lessonPeople.set("les_retry0001", [PRIYA.developerId]);
  lessonPeople.set("les_tests0001", [SAM.developerId]);
  lessonPeople.set("les_dates0001", [SAM.developerId, PRIYA.developerId]);
  lessonPeople.set("les_logs00001", [SAM.developerId]);
  let lessonMode: LessonMode = "suggest";
  const pausedSources = new Set<LearningSourceKey>();
  const retireAsks = new Map<string, { by: string; at: number }>();
  const taskLessons = new Map<string, TaskLesson[]>([
    [TASK_IDS.pullRequest, [
      { stage: "IMPLEMENT", round: 1, lessonId: "les_logs00001", version: 1, why: "scope", citation: "valid", visible: true, title: "Log request ids with every error", type: "convention", helpful: 3, harmful: 1, canMark: true },
      { stage: "PLAN", round: 1, lessonId: "les_readme001", version: 1, why: "path", citation: "none", visible: true, title: "Keep the README's setup steps current", type: "convention", helpful: 0, harmful: 0, canMark: true, trial: "trial" },
      { stage: "REVIEW", round: 1, lessonId: "les_hidden001", version: 2, why: "similar", citation: "unchecked", visible: false, canMark: false },
    ]],
  ]);
  const notHelpful = new Set<string>();
  // --- lessons phase 4 (L4-LP4G): graduation, tidy, both places and draft tasks. Priya decides; Sam is refused in Code's words. Only project "web" has any.
  const lessonCalls: FakeCode["lessonCalls"] = [];
  const lessonOverrides = new Map<string, { status?: number; body: unknown }>();
  const checkDrafts = new Map<string, { id: string; lessonId: string; title: string; request: string; paths: string[]; createdAt: number; status: "open" | "started" | "dismissed" }>([
    ["chk_0123456789abcdef", { id: "chk_0123456789abcdef", lessonId: "les_semis0001", title: "Check that scripts have no semicolons", request: "Add a check that fails when a file in scripts/legacy has a semicolon at the end of a line.", paths: ["scripts/legacy/**"], createdAt: at(-1), status: "open" }],
  ]);
  /** Live team rules (a lesson made a rule): the rule's text, its paths and where it came from. */
  const teamRules = new Map<string, { id: string; text: string; paths: string[]; repos: string[]; fromLesson: string; createdAt: number; status: "live" | "retired" }>();
  const CARD_PATHS = ["src/logging/**"];
  const graduationLater = new Set<string>();
  let tidyClosed = false;
  const initialLessons = [...lessonStore.entries()].map(([id, lesson]) => [id, JSON.parse(JSON.stringify(lesson)) as LessonItem] as const);
  const initialDrafts = [...checkDrafts.entries()].map(([id, draft]) => [id, { ...draft }] as const);
  const resetLessons = () => {
    lessonStore.clear(); for (const [id, lesson] of initialLessons) lessonStore.set(id, JSON.parse(JSON.stringify(lesson)) as LessonItem);
    checkDrafts.clear(); for (const [id, draft] of initialDrafts) checkDrafts.set(id, { ...draft });
    teamRules.clear(); graduationLater.clear(); tidyClosed = false; retireAsks.clear(); lessonMode = "suggest";
  };
  const GRADUATION_REFUSED = "Only a maintainer of this project, or an admin, can decide what becomes permanent.";
  /** One of the phase 4 routes: record the call, apply an override, refuse a non-decider in Code's words, else run `run`. */
  const graduationRoute = <K extends CodeRouteId>(id: K, run: (context: Context<K>, project: string) => Answer<K>): Handler<K> => (context) => {
    lessonCalls.push({ id, params: { ...context.params }, body: JSON.parse(JSON.stringify(context.body ?? null)) as unknown, person: context.person.key });
    const found = lessonsProject(context);
    if ("refused" in found) return found.refused;
    const override = lessonOverrides.get(id);
    if (override !== undefined) return { status: override.status ?? 200, body: override.body as CodeResponse<K> };
    if (!found.decides) return failure(403, "FORBIDDEN", GRADUATION_REFUSED);
    return run(context, found.name);
  };
  const lessonsOff = () => failure(404, "LESSONS_SWITCHED_OFF", "Lessons are off.");
  const LIST_STATUSES: Record<string, string[]> = { proposed: ["pending"], approved: ["active", "stale"], retired: ["retired", "expired", "rejected"] };
  /** The project, if lessons are on and the person is on its roster (Code answers the same "No such project." for both). */
  const lessonsProject = (context: { params: Record<string, string>; person: Person }) => {
    if (!lessonsOn) return { refused: lessonsOff() };
    const name = context.params["project"] ?? "";
    if (roleIn(context.person, name) === undefined) return { refused: failure(404, "NOT_FOUND", "No such project.") };
    return { name, decides: roleIn(context.person, name) === "administrator" };
  };
  const viewOf = (lesson: LessonItem, person: Person, decides: boolean): LessonItem => ({
    ...lesson,
    from: (lessonPeople.get(lesson.id) ?? []).map((id) => { const who = PEOPLE.find((one) => one.developerId === id); return who === undefined ? { name: "a former member" } : { name: who.name, ...(who.developerId === person.developerId ? { you: true as const } : {}) }; }),
    canApprove: decides && lesson.status === "pending", canReject: decides && lesson.status === "pending", canRetire: decides && (lesson.status === "active" || lesson.status === "stale"),
  });
  const decide = (lessonId: string, version: number, keep: boolean, edit?: { title: string; description: string; body: string }): { ok: true; status: string } | { ok: false; code: string; message: string } => {
    const lesson = lessonStore.get(lessonId);
    if (lesson === undefined) return { ok: false, code: "NOT_FOUND", message: "That lesson is no longer there." };
    if (lesson.status !== "pending") return { ok: false, code: "IDEMPOTENCY_CONFLICT", message: "That lesson is not waiting for a decision." };
    if (lesson.version !== version) return { ok: false, code: "IDEMPOTENCY_CONFLICT", message: "This lesson changed since you read it. Read it again and decide again." };
    if (!keep) { lessonStore.set(lessonId, { ...lesson, status: "rejected", updatedAt: now().getTime() }); return { ok: true, status: "rejected" }; }
    const changed = { ...lesson, ...(edit ?? {}), version: lesson.version + (edit === undefined ? 0 : 1), updatedAt: now().getTime() };
    // A lesson that needs two people waits for the second one after the first keeps it.
    if (lesson.needs?.required === 2) { lessonStore.set(lessonId, { ...changed, needs: { ...lesson.needs, have: lesson.needs.have + 1 } }); return { ok: true, status: "pending" }; }
    const kept: LessonItem = { ...changed, status: "active" };
    delete kept.needs;
    lessonStore.set(lessonId, kept);
    return { ok: true, status: "active" };
  };

  const NO = { expandEvidenceFirst: false, freshSignIn: false, secondPerson: false };
  const REJECT_REASONS = ["wrong_problem", "wrong_approach", "too_big", "missing_test", "not_now", "other"];
  const opened = new Set<string>();
  const decisionHref = (id: string, action: "approve" | "reject") => `/v1/app/decisions/${id.replace(":", "/")}/${action}`;
  /** The decision cards in the app's own shape (`DecisionCardSchema`): the plan waiting for review (low risk) and an open pull request to merge (medium: open the evidence first). */
  const cards = (person: Person): DecisionCard[] => {
    const out: DecisionCard[] = [];
    for (const { owner, task } of tasks.values()) {
      if (owner.developerId !== person.developerId) continue;
      if (task.workflow?.stage === "PLAN_REVIEW" && task.workflow.state === "WAITING") {
        const id = `approve_plan:${task.taskId}`;
        out.push({
          id, kind: "approve_plan", taskId: task.taskId, project: task.project, title: task.title.slice(0, 80), question: "Approve this plan?",
          recommended: { action: "approve", why: "A small change with one new test" }, next: { text: "Builds in about 25 minutes, about $3.10, opens a pull request", costUsd: 3.1, minutes: 25 },
          evidence: [{ kind: "cost", label: "Cost", value: "about $1.20 to $3.10", state: "good" }], risk: "low", riskReasons: [], friction: NO,
          actions: [{ kind: "approve", label: "Approve plan", href: decisionHref(id, "approve"), method: "POST" }, { kind: "reject", label: "Reject", href: decisionHref(id, "reject"), method: "POST" }, { kind: "open", label: "Open the plan", href: `/app/sessions/${task.taskId}`, method: "GET" }],
          rejectReasons: REJECT_REASONS, status: "pending", createdAt: task.updatedAt,
          ...(planFiled.size > 0 || planChoices.size > 0 ? { planFeature: planFeatureView(person, task.taskId) } : {}),
        });
      }
      const open = (task.pullRequests ?? []).find((entry) => entry.state === "open");
      if (open !== undefined && !decided.has(`merge:${task.taskId}`)) {
        const id = `merge:${task.taskId}`;
        out.push({
          id, kind: "merge", taskId: task.taskId, project: task.project, title: task.title.slice(0, 80), question: `Merge pull request ${String(open.number)}?`,
          recommended: { action: "approve", why: "Checks passed and the reviews are done" }, next: { text: "Merges the pull request into main" },
          evidence: [{ kind: "checks", label: "Checks", value: "all passed", state: "good" }], risk: "medium", riskReasons: ["Changes the main branch"], friction: { expandEvidenceFirst: true, freshSignIn: false, secondPerson: false },
          actions: [{ kind: "approve", label: "Merge", href: decisionHref(id, "approve"), method: "POST" }, { kind: "reject", label: "Reject", href: decisionHref(id, "reject"), method: "POST" }, { kind: "open", label: "Open the task", href: `/app/sessions/${task.taskId}`, method: "GET" }],
          rejectReasons: REJECT_REASONS, status: "pending", createdAt: task.updatedAt,
        });
      }
    }
    return out;
  };
  /** What Code shows now for a card: the digest the person sends back when they act. */
  const digestOf = (card: DecisionCard) => (card.kind === "approve_plan" ? PLAN_DIGEST : "b".repeat(64));

  const handlers: Handlers = {
    "auth.authorize": ({ query }) => {
      const redirectUri = query.get("redirect_uri") ?? "";
      if (query.get("client_id") !== clientId || redirectUri === "" || query.get("code_challenge_method") !== "S256") return failure(400, "invalid_request", "bad authorize request");
      const back = new URL(redirectUri);
      // DEC 254h: a join with Code's invite secret. The secret must be live, unspent, bound to `company`, and its pre-approval still live; a
      // person Code names another company for is refused. Spent with the membership. Any failure: the one "not invited" refusal.
      const secret = query.get("invite");
      let joined = false;
      if (secret !== null) {
        const held = inviteSecrets.get(createHash("sha256").update(secret).digest("hex"));
        if (held === undefined || held.used || held.expiresAt <= now().getTime() || held.companyId !== query.get("company") || !preapprovals.has(held.emailHash)) {
          back.searchParams.set("error", "access_denied");
          back.searchParams.set("state", query.get("state") ?? "");
          return { status: 302, headers: { location: back.toString() } };
        }
        held.used = true;
        preapprovals.delete(held.emailHash);
        companyless.delete(current.developerId);
        joined = true;
      }
      const code = randomBytes(12).toString("hex");
      codes.set(code, { person: current, challenge: query.get("code_challenge") ?? "", redirectUri, ...(joined ? { joined: true as const } : {}) });
      back.searchParams.set("code", code);
      back.searchParams.set("state", query.get("state") ?? "");
      return { status: 302, headers: { location: back.toString() } };
    },
    "auth.token": () => failure(500, "UNREACHABLE", "handled before the route table"),
    "auth.revoke": ({ body }) => {
      const token = (body as { token?: string }).token ?? "";
      access.delete(token);
      refresh.delete(token);
      return { body: {} };
    },
    "auth.jwks": () => ({ body: { keys: [] } }),
    "access.check": ({ person, token }) => {
      const body: AccessResponse = {
        developerId: person.developerId, displayName: person.name, nameChosen: true, administrator: person.administrator,
        // DEC 253z: the person's company and role, as Code PR #820 names them (the same role the company members list shows); none for a person
        // the test made companyless (POST /__fake/no-company).
        ...(companyless.has(person.developerId) ? {} : { companyId: companyOfPerson(person), companyRole: person.administrator ? "owner" as const : "member" as const, companyName: person.company?.name ?? FAKE_COMPANY_NAME }),
        projects: projects.filter((entry) => entry.members.has(person.developerId)).map((entry) => ({ name: entry.name, access: entry.members.get(person.developerId) ?? "developer" })), notices: [],
        ...(token !== undefined && joinedTokens.has(token) && !companyless.has(person.developerId) ? { joinedByInvite: true } : {}),
      };
      return { body };
    },
    "me.setName": ({ body, person }) => {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name === "" || name.length > 80) return failure(400, "CONFIG_INVALID", "name: give a name of 1 to 80 characters.");
      const known = PEOPLE.find((entry) => entry.developerId === person.developerId);
      if (known !== undefined) known.name = name;
      return { body: { name, nameChosen: true } };
    },
    "channelLinks.list": () => ({ body: { links: [{ channel: "slack", workspace: "T0FAKE", account: "U0FAKE", displayName: "priya", linkedAt: "2026-10-05T09:00:00.000Z" }] } }),
    "channelLinks.remove": () => ({ body: { removed: true } }),
    "projects.list": ({ person }) => ({ body: { projects: projects.filter((entry) => entry.members.has(person.developerId)).map((entry) => ({ name: entry.name, access: entry.members.get(person.developerId) ?? "developer" })) } }),
    "client.projects.create": ({ body, person }) => {
      // Guided onboarding PR 10 (Code PR #837 and 19): `repositories` makes ONE project holding them all, every repository on the caller's company's GitHub accounts; only a company owner or admin (here: the administrator flag) may create.
      if (!person.administrator) return failure(403, "FORBIDDEN", "only a Rovara administrator can create a project");
      const asked: unknown = "repositories" in body ? body.repositories : body.repository;
      const list = Array.isArray(asked) ? asked : [asked];
      if (list.length < 1 || list.some((entry) => typeof entry !== "string" || entry === "")) return failure(400, "CONFIG_INVALID", "repository: name a repository.");
      const mine = new Set((FAKE_AVAILABLE_REPOSITORIES[companyOfPerson(person)] ?? []).map((entry) => entry.fullName.toLowerCase()));
      if ("repositories" in body && list.some((entry) => !mine.has(String(entry).toLowerCase()))) return failure(400, "CONFIG_INVALID", "one or more of these repositories is not available through your company's GitHub connection; nothing was created");
      const first = String(list[0]);
      const name = body.name ?? first.split("/").pop() ?? "project";
      if (project(name) !== undefined) return "repositories" in body ? failure(400, "CONFIG_INVALID", `a project named ${name} already exists; choose another name`) : failure(409, "CONFLICT", "A project with that name exists.");
      projects.push({ companyId: companyOfPerson(person), name, repositories: list.map((entry) => ({ name: String(entry).split("/").pop() ?? name, url: `https://github.com/${String(entry)}`, defaultBranch: "main", fullName: String(entry) })), members: new Map([[person.developerId, "administrator"]]) });
      return { status: 201, body: { name } };
    },
    "client.projects.bulk": ({ body, person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "only a Rovara administrator can create a project");
      if (!Array.isArray(body.repositories) || body.repositories.length < 1) return failure(400, "CONFIG_INVALID", "repositories: name at least one repository.");
      const mine = new Set((FAKE_AVAILABLE_REPOSITORIES[companyOfPerson(person)] ?? []).map((entry) => entry.fullName.toLowerCase()));
      return {
        body: {
          results: body.repositories.map((repository) => {
            if (!mine.has(repository.toLowerCase())) return { repository, outcome: "refused" as const, reason: "not_available" as const };
            const name = repository.split("/").pop() ?? "project";
            if (project(name) !== undefined) return { repository, outcome: "refused" as const, reason: "name_taken" as const };
            projects.push({ companyId: companyOfPerson(person), name, repositories: [{ name, url: `https://github.com/${repository}`, defaultBranch: "main", fullName: repository }], members: new Map([[person.developerId, "administrator"]]) });
            return { repository, outcome: "created" as const, project: name };
          }),
        },
      };
    },
    "client.projects.get": ({ params, person }) => {
      const entry = project(params["project"] ?? "");
      if (entry === undefined || !entry.members.has(person.developerId)) return notFound("project");
      return { body: { name: entry.name, latestRevision: 3, access: entry.members.get(person.developerId) ?? "developer", repositories: entry.repositories } };
    },
    // Guided onboarding PR 16 (Code #839): preview first; the company owner or the project's admin changes, a project user sees no action, anyone else "project not found".
    "client.projects.archivePreview": ({ params, person }) => lifecycleOr404(person, params["project"] ?? "", (name, manage) => ({ body: lifecyclePreview("archive", name, manage) })),
    "client.projects.restorePreview": ({ params, person }) => lifecycleOr404(person, params["project"] ?? "", (name, manage) => ({ body: lifecyclePreview("restore", name, manage) })),
    "client.projects.archive": ({ params, person, body }) => lifecycleOr404(person, params["project"] ?? "", (name, manage) => lifecycleChange("archive", name, manage, person, body)),
    "client.projects.restore": ({ params, person, body }) => lifecycleOr404(person, params["project"] ?? "", (name, manage) => lifecycleChange("restore", name, manage, person, body)),
    "client.projects.setupStatus": ({ params, person }) => {
      const name = params["project"] ?? "";
      if (project(name) === undefined || companyless.has(person.developerId)) return failure(404, "NOT_FOUND", "project not found");
      return { body: setupStatusOf(name, person) };
    },
    "client.projects.setupSkips": ({ params, person, body }) => {
      const name = params["project"] ?? "";
      if (project(name) === undefined || companyless.has(person.developerId)) return failure(404, "NOT_FOUND", "project not found");
      if (!person.administrator && roleIn(person, name) !== "administrator") return failure(403, "FORBIDDEN", "Only a company owner or admin, or this project's admin, can change the checklist.");
      const keys = Object.keys(body ?? {});
      if (!["slackChannel", "linear", "invites"].includes(body.row) || typeof body.skipped !== "boolean" || keys.length !== 2) return failure(400, "CONFIG_INVALID", "row: Invalid enum value");
      const set = setupSkips.get(name) ?? new Set();
      if (body.skipped) set.add(body.row); else set.delete(body.row);
      setupSkips.set(name, set);
      return { body: { project: name, row: body.row, skipped: body.skipped, skippedRows: [...set].sort() } };
    },
    "client.projects.codeSettings.get": () => ({ body: { settings: { requireSecondReviewer: true, mergeRule: "maintainer", protectedPaths: ["infra/"], revision: 2 } } }),
    "client.projects.codeSettings.put": ({ body }) => ({ body: { settings: { ...body.settings, revision: body.expectedRevision + 1 } } }),
    "client.repositories.list": () => ({
      body: { installations: [{ installationId: 1001, accountLogin: "example", accountType: "Organization", repositorySelection: "selected", status: "active", repositories: [{ fullName: "example/web", githubRepositoryId: 1, private: true, defaultBranch: "main" }, { fullName: "example/api", githubRepositoryId: 2, private: true, defaultBranch: "main" }, { fullName: "example/docs", githubRepositoryId: 3, private: false, defaultBranch: "main" }] }] },
    }),
    "client.repositories.available": ({ person, query }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "only a Rovara administrator can create a project");
      const company = companyOfPerson(person);
      const q = (query.get("q") ?? "").toLowerCase(), after = query.get("after"), limit = Number(query.get("limit") ?? 50);
      const heldBy = (fullName: string) => projects.filter((entry) => (entry.companyId ?? FAKE_COMPANY_ID) === company && entry.repositories.some((repository) => repository.fullName.toLowerCase() === fullName.toLowerCase())).map((entry) => entry.name);
      const sorted = [...(FAKE_AVAILABLE_REPOSITORIES[company] ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName)).filter((entry) => entry.fullName.toLowerCase().includes(q) && (after === null || entry.fullName.localeCompare(after) > 0));
      const page = sorted.slice(0, limit);
      const all = [...(FAKE_AVAILABLE_REPOSITORIES[company] ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName));
      return { body: { repositories: page.map((entry) => ({ ...entry, githubRepositoryId: 100 + all.findIndex((one) => one.fullName === entry.fullName), private: true, defaultBranch: "main", projects: heldBy(entry.fullName) })), ...(sorted.length > limit ? { next: page.at(-1)!.fullName } : {}), incomplete: false } };
    },
    "client.members.list": ({ params, person }) => {
      const entry = project(params["project"] ?? "");
      if (entry === undefined || !entry.members.has(person.developerId)) return notFound("project");
      return { body: { members: [...entry.members].map(([developerId, role]) => ({ developerId, name: PEOPLE.find((one) => one.developerId === developerId)?.name ?? "Someone", role })) } };
    },
    "client.members.put": ({ params, person }) => {
      const entry = project(params["project"] ?? "");
      if (entry === undefined || entry.members.get(person.developerId) !== "administrator") return failure(403, "FORBIDDEN", "Only a project administrator can do that.");
      const who = params["developerId"] ?? "";
      if (!entry.members.has(who)) entry.members.set(who, "developer");
      return { body: { developerId: who } };
    },
    "client.members.remove": ({ params, person }) => {
      const entry = project(params["project"] ?? "");
      if (entry === undefined || entry.members.get(person.developerId) !== "administrator") return failure(403, "FORBIDDEN", "Only a project administrator can do that.");
      const who = params["developerId"] ?? "";
      return { body: { developerId: who, outcome: entry.members.delete(who) ? "revoked" : "not_a_member" } };
    },
    "tasks.start": ({ body, person }) => {
      if (typeof body.requestId !== "string" || typeof body.project !== "string" || typeof body.instructions !== "string" || body.instructions.trim() === "") return failure(400, "CONFIG_INVALID", "requestId, project and instructions are required.");
      if (roleIn(person, body.project) === undefined) return notFound("project");
      const earlier = startedByRequest.get(body.requestId);
      if (earlier !== undefined) return { status: 200, body: { task: tasks.get(earlier)?.task as TaskView } };
      const taskId = randomUUID();
      const entry = base(taskId, person, { title: body.instructions.trim().slice(0, 80), project: body.project, status: "RUNNING", createdAt: iso(), updatedAt: iso(), workflow: workflowOf(taskId, person, { stage: "UNDERSTAND", state: "RUNNING", revision: 1 }, { createdAt: iso(), updatedAt: iso() }) });
      tasks.set(taskId, entry);
      startedByRequest.set(body.requestId, taskId);
      return { status: 201, body: { task: entry.task } };
    },
    "tasks.list": ({ person, query }) => {
      // Code #1045 item 5: `detail=1` (exactly) answers Code's detailed rows (the list row and its stage, pull requests, cost and limit, contracts DeveloperTaskDetailedListItemSchema),
      // only for the person's own tasks, as Code's list does; anything else is the list as before.
      if (query.get("detail") === "1" && query.get("involved") !== "1") {
        return { body: { tasks: [...tasks.values()].filter((entry) => entry.owner.developerId === person.developerId).map((entry) => detailedRowOf(entry.task)).sort((a, b) => String(b["updatedAt"]).localeCompare(String(a["updatedAt"]))) } as never };
      }
      const ordinary = () => ({ body: { tasks: [...tasks.values()].filter((entry) => entry.owner.developerId === person.developerId || readers.get(entry.task.taskId)?.has(person.developerId) === true).map((entry) => entry.task).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) } });
      if (query.get("involved") !== "1" || involvedMode === "old") return ordinary();
      if (involvedMode !== "on") return failure(Number(involvedMode), involvedMode === "500" ? "RUNTIME_UNAVAILABLE" : involvedMode === "400" ? "CONFIG_INVALID" : "NOT_FOUND", "involved is not served here");
      return { body: { involved: true, tasks: [...tasks.values()].filter((entry) => involved.get(entry.task.taskId)?.has(person.developerId) === true && entry.owner.developerId !== person.developerId).map((entry) => entry.task).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) } as never };
    },
    "tasks.get": (context) => taskOr404(context, ({ task }) => ({ body: { task } })),
    // Code's own bound (packages/broker/src/aws/developer-tasks.ts taskEvents): the task is read first (its 404), then a limit outside 1..DEVELOPER_EVENTS_MAX is a 400.
    "tasks.events": (context) => taskOr404(context, ({ task }) => eventsLimitRefused(context.query) ?? ({ body: { events: [{ seq: 1, at: task.createdAt, kind: "status", text: "Task started" }, { seq: 2, at: task.updatedAt, kind: "progress", text: `Now at ${task.workflow?.stage ?? "start"}`, taskItemId: "T2", attempt: 1 }] } })),
    "tasks.plan": (context) => taskOr404(context, ({ task }) => ({ body: planOf(task) })),
    "tasks.cancel": (context) => ownerTask(context, ({ task }) => { touch(task, { status: "CANCELLED" }); return { body: { task } }; }),
    "tasks.close": (context) => ownerTask(context, ({ task }) => { touch(task, { status: "CLOSED" }); return { body: { task, closed: true } }; }),
    "tasks.continue": (context) => ownerTask(context, ({ task }) => ({ body: { task } })),
    "tasks.pullRequests.open": (context) => ownerTask(context, ({ task }) => { touch(task, { pullRequests: [{ repository: "example/web", number: 43, url: "https://github.com/example/web/pull/43", state: "open" }] }); return { body: { task } }; }),
    "tasks.share": (context) => ownerTask(context, ({ task }) => ({ body: { task } })),
    "tasks.people.get": (context) => taskOr404(context, (entry) => ({ body: { view: peopleView(entry, context.person) } })),
    "tasks.people.role": (context) => ownerTask(context, (entry) => {
      const state = peopleOf(entry.task.taskId);
      if (context.body.expectedPeopleRevision !== state.revision) return failure(409, "CHANGE_STALE", "Task access changed before the role could be saved");
      return proposePeople(entry, context.person, context.body.requestId, () => { state.roles.set(context.body.personId, context.body.role); }, context.body.role === "owner");
    }),
    "tasks.people.takeOwnership": (context) => taskOr404(context, (entry) => {
      if (entry.owner.developerId === context.person.developerId) return failure(409, "CONFLICT", "You already own this task.");
      const state = peopleOf(entry.task.taskId);
      if (context.body.expectedPeopleRevision !== state.revision) return failure(409, "CHANGE_STALE", "Task access changed before the role could be saved");
      return proposePeople(entry, context.person, context.body.requestId, () => { entry.owner = context.person; }, false);
    }),
    // The planned C4 routes: the owner's candidates are the project's people not yet on the task; an add of an owner waits for the confirm step.
    "tasks.people.candidates": (context) => ownerTask(context, (entry) => ({ body: { candidates: { candidates: PEOPLE.filter((one) => roleIn(one, entry.task.project) !== undefined && !peopleListed(entry).some((listed) => listed.developerId === one.developerId)).map((one) => ({ developerId: one.developerId, name: one.name })), complete: true } } })),
    "tasks.people.add": (context) => ownerTask(context, (entry) => {
      const who = PEOPLE.find((one) => one.developerId === context.body.developerId);
      if (who === undefined || roleIn(who, entry.task.project) === undefined) return failure(403, "TASK_ACCESS_DENIED", "That person can't be added to this task");
      const state = peopleOf(entry.task.taskId);
      if (context.body.expectedPeopleRevision !== state.revision) return failure(409, "CHANGE_STALE", "Task access changed before the role could be saved");
      return proposePeople(entry, context.person, context.body.requestId, () => { state.roles.set(personIdOf(who), context.body.role); state.listed.add(who.developerId); }, context.body.role === "owner");
    }),
    "tasks.people.request": (context) => taskOr404(context, () => ({ body: { change: { requestId: context.params["requestId"] ?? "", status: "COMMITTED" } } })),
    "tasks.readers.list": (context) => ownerTask(context, ({ task }) => ({ body: { readers: [...(readers.get(task.taskId)?.values() ?? [])] } })),
    "tasks.readers.put": (context) => ownerTask(context, ({ task }) => {
      const who = PEOPLE.find((one) => one.developerId === context.params["developerId"]);
      if (who === undefined || roleIn(who, task.project) === undefined) return failure(400, "CONFIG_INVALID", "Only a member of the project can be added.");
      const reader: TaskReader = { developerId: who.developerId, name: who.name, role: "viewer", projectMember: true, grantedAt: iso() };
      const map = readers.get(task.taskId) ?? new Map<string, TaskReader>();
      map.set(who.developerId, reader);
      readers.set(task.taskId, map);
      return { body: { reader } };
    }),
    "tasks.readers.remove": (context) => ownerTask(context, ({ task }) => ({ body: { removed: readers.get(task.taskId)?.delete(context.params["developerId"] ?? "") === true } })),
    "tasks.workflow.decision": (context) => ownerTask(context, ({ task }) => {
      const workflow = task.workflow;
      if (workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return failure(409, "CONFLICT", "No plan is waiting.");
      if (context.body.expectedRevision !== workflow.revision || context.body.artifactDigest !== PLAN_DIGEST) return failure(409, "CHANGE_STALE", "The plan changed.");
      touch(task, { workflow: { ...workflow, stage: context.body.decision === "APPROVE" ? "IMPLEMENT" : "PLAN", state: "RUNNING", revision: workflow.revision + 1, updatedAt: iso() } });
      return { body: { task } };
    }),
    "tasks.workflow.review": (context) => ownerTask(context, ({ task }) => { touch(task, { workflow: { ...task.workflow!, stage: "REVIEW", state: "RUNNING", reviews: [], updatedAt: iso() } }); return { body: { task } }; }),
    "tasks.workflow.retry": (context) => ownerTask(context, ({ task }) => ({ body: { task } })),
    "tasks.workflow.sendBack": (context) => ownerTask(context, ({ task }) => { touch(task, { workflow: { ...task.workflow!, stage: "IMPLEMENT", state: "RUNNING", updatedAt: iso() } }); return { body: { task } }; }),
    "tasks.workflow.reviewFindings": (context) => ownerTask(context, ({ task }) => ({ body: { task } })),
    "tasks.workflow.publishRetry": (context) => ownerTask(context, ({ task }) => ({ body: { task, started: true } })),
    "tasks.workflow.keepPullRequests": (context) => ownerTask(context, ({ task }) => ({ body: { task } })),
    "tasks.workflow.feedback": (context) => taskOr404(context, () => ({ body: { review: null } })),
    "tasks.workflow.feedbackDecision": (context) => ownerTask(context, ({ task }) => ({ body: { task } })),
    "tasks.workflow.feedbackRetry": (context) => ownerTask(context, ({ task }) => ({ body: { task, started: true } })),
    "tasks.messages.list": (context) => taskOr404(context, ({ task }) => ({ body: { messages: messages.get(task.taskId) ?? [] } })),
    "tasks.messages.send": (context) => taskOr404(context, ({ task }) => {
      if (context.body.text.trim() === "") return failure(400, "CONFIG_INVALID", "Say something.");
      const message: TaskMessage = { messageId: randomUUID(), kind: context.body.kind, author: { developerId: context.person.developerId, name: context.person.name }, text: context.body.text, at: iso(), rev: 1 };
      messages.set(task.taskId, [...(messages.get(task.taskId) ?? []), message]);
      return { status: 201, body: { message } };
    }),
    "tasks.diff": (context) => taskOr404(context, () => ({ body: { repository: context.query.get("repository") ?? "example/web", number: Number(context.query.get("number") ?? "42"), page: Number(context.query.get("page") ?? "1"), files: [{ path: "README.md", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-Welcom\n+Welcome" }], more: false } })),
    "tasks.answers": (context) => ownerTask(context, ({ task }) => ({ body: { task } })),
    "tasks.merge": (context) => ownerTask(context, ({ task }) => {
      decided.add(`merge:${task.taskId}`);
      touch(task, { pullRequests: (task.pullRequests ?? []).map((entry) => ({ ...entry, state: "merged" })) });
      return { body: { task, merged: true } };
    }),
    "tasks.evidence.list": (context) => taskOr404(context, ({ task }) => ({ body: proofOf(task) })),
    "tasks.evidence.get": (context) => taskOr404(context, () => ({ body: { sha256: context.params["sha256"] ?? "", kind: "test_report", title: "Unit tests", contentType: "text/plain", sizeBytes: 42, body: "12 passed, 0 failed", checkedAt: iso(), verdict: "pass" } })),
    "tasks.comments.list": (context) => taskOr404(context, ({ task }) => ({ body: { comments: comments.get(task.taskId) ?? [] } })),
    "tasks.comments.create": (context) => taskOr404(context, ({ task }) => {
      const comment: PlanComment = { commentId: randomUUID(), document: context.body.document, author: { developerId: context.person.developerId, name: context.person.name }, text: context.body.text, at: iso(), rev: 1, resolved: false, ...(context.body.anchor === undefined ? {} : { anchor: context.body.anchor }), ...(context.body.replyTo === undefined ? {} : { replyTo: context.body.replyTo }) };
      comments.set(task.taskId, [...(comments.get(task.taskId) ?? []), comment]);
      return { status: 201, body: { comment } };
    }),
    "decisions.list": ({ person }) => {
      const list = cards(person);
      const body: DecisionsResponse = { cards: list, total: list.length, tabs: {}, details: {}, digests: Object.fromEntries(list.map((card) => [card.id, digestOf(card)])), dropped: 0 };
      return { body };
    },
    "decisions.act": ({ body, params, person }) => {
      const card = cards(person).find((entry) => entry.id === `${params["kind"] ?? ""}:${params["subject"] ?? ""}`);
      if (card === undefined) return notFound("card");
      const action = params["action"];
      if (action === "evidence-opened") {
        if (body.shownDigest !== digestOf(card)) return failure(409, "CHANGE_STALE", "The card changed since you saw it.");
        opened.add(card.id);
        const answer: DecisionOutcome = { cardId: card.id, opened: true, recorded: card.risk !== "low" };
        return { body: answer };
      }
      if (action === "approve") {
        if (body.shownDigest !== digestOf(card)) return failure(409, "CHANGE_STALE", "The card changed since you saw it.");
        if (card.friction.expandEvidenceFirst && !opened.has(card.id)) return failure(409, "EVIDENCE_NOT_OPENED", "Open the evidence before you approve.");
      } else if (action !== "reject" && action !== "request-changes") return notFound("action");
      const approved = action === "approve";
      const task = card.taskId === undefined ? undefined : tasks.get(card.taskId)?.task;
      if (card.kind === "approve_plan" && task?.workflow !== undefined) touch(task, { workflow: { ...task.workflow, stage: approved ? "IMPLEMENT" : "PLAN", state: "RUNNING", revision: task.workflow.revision + 1, updatedAt: iso() } });
      else if (card.kind === "merge" && task !== undefined) {
        decided.add(card.id);
        if (approved) touch(task, { pullRequests: (task.pullRequests ?? []).map((entry) => ({ ...entry, state: "merged" })) });
      }
      const answer: DecisionOutcome = { cardId: card.id, outcome: approved ? "approved" : "rejected", remainingTabs: [] };
      return { body: answer };
    },
    "playbook.get": ({ params }) => ({ body: playbooks.get(params["project"] ?? "") ?? { revision: 1, defaultProcess: { kind: "default", name: "Rovara's standard process" }, designReview: "ask" } }),
    "playbook.put": ({ body, params }) => {
      const earlier = playbooks.get(params["project"] ?? "") ?? { revision: 1, defaultProcess: { kind: "default" }, designReview: "ask" };
      if (body.expectedRevision !== earlier.revision) return failure(409, "CONFLICT", "The playbook changed.");
      const next: PlaybookView = { revision: earlier.revision + 1, defaultProcess: body.defaultProcess ?? earlier.defaultProcess, designReview: body.designReview ?? earlier.designReview };
      playbooks.set(params["project"] ?? "", next);
      return { body: next };
    },
    "playbook.process": () => ({ status: 201, body: { layer: { kind: "project_process", agentId: "agt_fake0000000000000001", name: "Our process" } } }),
    "howWeWork.get": ({ params }) => {
      const view: HowWeWorkView = { project: params["project"] ?? "", revision: 1, layers: [{ title: "Rovara's standard process", summary: "Plan, code, check, review, draft pull request.", editable: false }, { title: "Our rules", summary: "Always add a test.", editable: true }] };
      return { body: view };
    },
    "company.members.list": () => ({ body: { members: companyMembers } }),
    "company.members.setRole": ({ body, params, person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only an administrator can do that.");
      const member = companyMembers.find((entry) => entry.developerId === params["developerId"]);
      if (member === undefined) return notFound("member");
      member.role = body.role;
      return { body: { member } };
    },
    "company.members.removalPreview": ({ params }) => ({ body: { developerId: params["developerId"] ?? "", ownedTasks: 2, ownedProjects: [], successorRequired: true } }),
    "company.members.remove": ({ params, person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only an administrator can do that.");
      const index = companyMembers.findIndex((entry) => entry.developerId === params["developerId"]);
      if (index < 0) return notFound("member");
      companyMembers.splice(index, 1);
      return { body: { removed: true } };
    },
    "company.preApproved.put": ({ body, person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only an administrator can do that.");
      preApproved = [...new Set(body.emails.map((email) => email.trim().toLowerCase()).filter((email) => email !== ""))];
      preApprovedRevision += 1;
      return { body: { emails: preApproved, revision: preApprovedRevision } };
    },
    // DEC 253z: Code's member pre-approvals (every refusal NOT_FOUND) and a person creating a company with an operator's invite code.
    "company.preapprovals.create": ({ body, person }) => {
      if (!person.administrator || companyless.has(person.developerId) || typeof body.email !== "string") return failure(404, "NOT_FOUND", "not found");
      const key = createHash("sha256").update(body.email.trim().toLowerCase()).digest("hex");
      if (preapprovals.has(key) || body.role !== "member") return failure(404, "NOT_FOUND", "not found");
      preapprovals.set(key, body.email.trim().toLowerCase());
      // DEC 254h: a single-use invite secret for this pre-approval, returned once; the fake keeps only its hash.
      const secret = `rvi_${randomBytes(24).toString("base64url")}`;
      const expiresAt = now().getTime() + body.expiresInHours * 3_600_000;
      inviteSecrets.set(createHash("sha256").update(secret).digest("hex"), { companyId: FAKE_COMPANY_ID, emailHash: key, expiresAt, used: false });
      return { body: { ok: true, invite: { secret, expiresAt: new Date(expiresAt).toISOString() } } };
    },
    "company.preapprovals.withdraw": ({ params, person }) => {
      if (!person.administrator || !preapprovals.delete(params["emailHash"] ?? "")) return failure(404, "NOT_FOUND", "not found");
      // Withdrawing the pre-approval kills its secret too.
      for (const [hash, held] of inviteSecrets) if (held.emailHash === params["emailHash"]) inviteSecrets.delete(hash);
      return { body: { ok: true } };
    },
    "company.create": ({ body, person }) => {
      if (!companyless.has(person.developerId)) return failure(409, "CONFLICT", "You're already in a company.");
      if (body.inviteCode !== FAKE_INVITE_CODE || typeof body.name !== "string") return failure(403, "FORBIDDEN", "This invite code can't be used. Ask the Rovara team for a new one.");
      companyless.delete(person.developerId);
      return { status: 201, body: { companyId: FAKE_COMPANY_ID, companyName: body.name, companyRole: "owner" } };
    },
    // Guided onboarding (Code PR #830). GitHub's `code` picks the outcome: FAKE_GITHUB_CODES.connected binds the installation id GitHub sent,
    // FAKE_GITHUB_CODES.choose lists two installations (one another company's); setup_action=request answers "requested". Anything else: Code's one refusal.
    "company.github.connect": ({ person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin can connect GitHub.");
      const state = randomBytes(32).toString("base64url");
      githubStates.set(state, { developerId: person.developerId, spent: false });
      return { body: { state, expiresAt: new Date(now().getTime() + 600_000).toISOString(), installUrl: `https://github.com/apps/rovara-fake/installations/new?state=${state}`, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.fake&state=${state}` } };
    },
    "company.github.claim": ({ body, person }) => {
      const kept = githubStates.get(body.state);
      if (!person.administrator || kept === undefined || kept.spent || kept.developerId !== person.developerId) return failure(403, "FORBIDDEN", "Start again from Rovara.");
      kept.spent = true;
      const githubUser = { id: 4242, login: `${person.key}-gh` };
      if (body.setupAction === "request") return { body: { status: "requested" } };
      if (body.code === FAKE_GITHUB_CODES.choose) {
        const ticket = randomBytes(32).toString("base64url");
        githubTickets.set(ticket, { developerId: person.developerId, spent: false });
        return { body: { status: "choose", ticket, expiresAt: new Date(now().getTime() + 600_000).toISOString(), githubUser, installations: [
          { installationId: 5001, accountLogin: "example", accountType: "Organization", suspended: false, connection: githubBound.has(5001) ? "this_company" : "unbound" },
          { installationId: 5002, accountLogin: "other-co", accountType: "Organization", suspended: false, connection: "another_company" },
        ] } };
      }
      if (body.code !== FAKE_GITHUB_CODES.connected || body.installationId === undefined) return failure(403, "FORBIDDEN", "Start again from Rovara.");
      const already = githubBound.has(body.installationId);
      githubBound.set(body.installationId, { accountLogin: "example", connectedAt: iso(), by: person });
      return { body: { status: "connected", alreadyConnected: already, installation: { installationId: body.installationId, accountLogin: "example", accountType: "Organization" }, githubUser } };
    },
    "company.github.choose": ({ body, person }) => {
      const kept = githubTickets.get(body.ticket);
      if (!person.administrator || kept === undefined || kept.spent || kept.developerId !== person.developerId || body.installationId !== 5001) return failure(403, "FORBIDDEN", "Start again from Rovara.");
      kept.spent = true;
      const already = githubBound.has(5001);
      githubBound.set(5001, { accountLogin: "example", connectedAt: iso(), by: person });
      return { body: { status: "connected", alreadyConnected: already, installation: { installationId: 5001, accountLogin: "example", accountType: "Organization" }, githubUser: { id: 4242, login: `${person.key}-gh` } } };
    },
    "company.github.status": () => ({ body: { installations: [...githubBound].map(([installationId, row]) => ({ installationId, accountLogin: row.accountLogin, status: "active" as const, accountType: "Organization" as const, connectedAt: row.connectedAt, connectedBy: { kind: "person" as const, personId: row.by.developerId, name: row.by.name } })) } }),
    // Guided onboarding PR 12b (Code #832): an owner disconnects an installation the company holds, refused while a project uses its repos.
    "company.github.disconnect": ({ params, person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner can disconnect GitHub.");
      const id = Number(params["installationId"]), row = githubBound.get(id);
      if (row === undefined) return failure(404, "NOT_FOUND", "That GitHub installation isn't connected to your company.");
      const using = projects.filter((entry) => entry.repositories.some((repository) => repository.fullName.toLowerCase().startsWith(`${row.accountLogin.toLowerCase()}/`))).map((entry) => entry.name).sort();
      if (using.length > 0) return failure(409, "GITHUB_IN_USE", `Projects still use this GitHub connection: ${using.join(", ")}. Remove its repositories from them first.`);
      githubBound.delete(id);
      return { body: { status: "disconnected" as const, installationId: id, accountLogin: row.accountLogin, uninstallUrl: `https://github.com/organizations/${row.accountLogin}/settings/installations/${String(id)}` } };
    },
    "company.slack.install": ({ body, person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin can add Rovara to Slack.");
      const state = randomBytes(32).toString("base64url");
      connectStates.set(state, { developerId: person.developerId, spent: false, provider: "slack" });
      const authorize = new URL("https://slack.com/oauth/v2/authorize");
      for (const [key, value] of Object.entries({ client_id: "1111.2222", scope: "chat:write,commands", redirect_uri: body.redirectUri, state })) authorize.searchParams.set(key, value);
      return { body: { state, expiresAt: new Date(now().getTime() + 600_000).toISOString(), authorizeUrl: authorize.toString(), signedInWorkspace: { teamId: "TFAKESIGN", teamName: "Example Slack" } } };
    },
    "company.slack.installComplete": ({ body, person }) => {
      const kept = connectStates.get(body.state);
      if (!person.administrator || kept === undefined || kept.spent || kept.developerId !== person.developerId || kept.provider !== "slack") return failure(403, "FORBIDDEN", "Start again from Rovara.");
      kept.spent = true;
      if (body.error === "access_denied") return { body: { status: "cancelled" as const } };
      if (body.code !== FAKE_SLACK_CODES.connected && body.code !== FAKE_SLACK_CODES.other) return failure(403, "FORBIDDEN", "Start again from Rovara.");
      const team = body.code === FAKE_SLACK_CODES.other ? { teamId: "TFAKEOTHER", teamName: "Side Project Slack" } : { teamId: "TFAKESIGN", teamName: "Example Slack" };
      const already = slackWorkspace?.teamId === team.teamId;
      slackWorkspace = { ...team, connectedAt: iso(), by: person };
      return { body: { status: "connected" as const, alreadyConnected: already, workspace: team, signedInWorkspace: { teamId: "TFAKESIGN", teamName: "Example Slack" }, matchesSignIn: team.teamId === "TFAKESIGN" } };
    },
    "company.slack.get": () => ({ body: { workspace: slackWorkspace === undefined ? null : { teamId: slackWorkspace.teamId, teamName: slackWorkspace.teamName, state: "connected", connectedAt: slackWorkspace.connectedAt, connectedBy: { kind: "person", personId: slackWorkspace.by.developerId, name: slackWorkspace.by.name } } } }),
    "company.slack.disconnect": ({ person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner can disconnect Slack.");
      if (slackWorkspace === undefined) return failure(404, "NOT_FOUND", "This company has no Slack workspace connected.");
      const workspace = { teamId: slackWorkspace.teamId, teamName: slackWorkspace.teamName };
      slackWorkspace = undefined;
      const lost = [...new Set(slackLinks.values())];
      slackLinks.clear();
      return { body: { status: "disconnected" as const, workspace, projectsLosingChannel: lost } };
    },
    "company.slack.channels": ({ query, person }) => {
      if (project(query.get("project") ?? "") === undefined) return failure(404, "NOT_FOUND", "project not found");
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin, or this project's admin, can link or unlink its Slack channel.");
      if (slackWorkspace === undefined) return failure(409, "SLACK_NOT_CONNECTED", "Add Rovara to Slack first: this company has no Slack workspace connected.");
      return { body: { workspace: { teamId: slackWorkspace.teamId }, channels: slackChannels.map((c) => ({ ...c, ...(slackLinks.has(c.id) ? { linked: true as const, linkedProject: slackLinks.get(c.id)! } : {}) })) } };
    },
    "company.slack.channel.get": ({ params }) => {
      const name = params["project"] ?? "";
      if (project(name) === undefined) return failure(404, "NOT_FOUND", "project not found");
      return { body: { workspace: slackWorkspace === undefined ? null : { teamId: slackWorkspace.teamId }, channels: [...slackLinks].filter(([, linked]) => linked === name).map(([channelId]) => ({ channelId })) } };
    },
    "company.slack.channel.link": ({ params, body, person }) => fakeLink(params["project"] ?? "", body.channelId, person, false),
    "company.slack.channel.check": ({ params, body, person }) => fakeLink(params["project"] ?? "", body.channelId, person, true),
    "company.slack.channel.unlink": ({ params, person }) => {
      const name = params["project"] ?? "";
      if (project(name) === undefined) return failure(404, "NOT_FOUND", "project not found");
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin, or this project's admin, can link or unlink its Slack channel.");
      const mine = [...slackLinks].filter(([, linked]) => linked === name).map(([channelId]) => channelId);
      if (mine.length === 0) return failure(404, "NOT_FOUND", "This project has no Slack channel linked.");
      for (const id of mine) slackLinks.delete(id);
      return { body: { status: "unlinked" as const, teamId: slackWorkspace?.teamId ?? "TFAKESIGN", channels: mine } };
    },
    "company.linear.connect": ({ person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin can connect Linear.");
      const state = randomBytes(32).toString("base64url");
      connectStates.set(state, { developerId: person.developerId, spent: false, provider: "linear" });
      const authorize = new URL("https://linear.app/oauth/authorize");
      for (const [key, value] of Object.entries({ client_id: "fakelinearclient", redirect_uri: linearRedirectUri, response_type: "code", scope: "read,write,comments:create,issues:create", state, actor: "app", prompt: "consent", code_challenge: "c".repeat(43), code_challenge_method: "S256" })) authorize.searchParams.set(key, value);
      return { body: { state, expiresAt: new Date(now().getTime() + 600_000).toISOString(), authorizeUrl: authorize.toString() } };
    },
    "company.linear.complete": ({ body, person }) => {
      const kept = connectStates.get(body.state);
      if (!person.administrator || kept === undefined || kept.spent || kept.developerId !== person.developerId || kept.provider !== "linear" || body.code !== FAKE_LINEAR_CODES.connected) return failure(403, "FORBIDDEN", "Start again from Rovara.");
      kept.spent = true;
      const reconnected = linearWorkspace !== undefined;
      linearWorkspace = { id: "lin-org-1", name: "Example Linear", urlKey: "example", connectedAt: iso(), by: person };
      return { body: { status: "connected" as const, reconnected, workspace: { id: "lin-org-1", name: "Example Linear", urlKey: "example" } } };
    },
    "company.linear.get": () => ({ body: linearWorkspace === undefined ? { status: "disconnected" as const } : { status: "connected" as const, statusAt: linearWorkspace.connectedAt, workspace: { id: linearWorkspace.id, name: linearWorkspace.name, urlKey: linearWorkspace.urlKey }, connectedAt: linearWorkspace.connectedAt, connectedBy: { personId: linearWorkspace.by.developerId, name: linearWorkspace.by.name } } }),
    "company.linear.disconnect": ({ person }) => {
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner can disconnect Linear.");
      if (linearWorkspace === undefined) return failure(409, "LINEAR_NOT_CONNECTED", "Linear isn't connected for this company. A company owner or admin can connect it in Company settings, Connections.");
      const name = linearWorkspace.name;
      linearWorkspace = undefined;
      const projects = [...linearPicks.keys()];
      linearPicks.clear();
      return { body: { status: "disconnected" as const, workspaceName: name, projects } };
    },
    "company.linear.team.get": ({ params, person }) => {
      const name = params["project"] ?? "";
      const refused = fakeTeamRefusal(name, person);
      if (refused !== undefined) return refused;
      const pick = linearPicks.get(name);
      return { body: { project: name, team: linearTeams.find((team) => team.id === pick) ?? null, teams: linearTeams } };
    },
    "company.linear.team.put": ({ params, body, person }) => {
      const name = params["project"] ?? "";
      const refused = fakeTeamRefusal(name, person);
      if (refused !== undefined) return refused;
      const team = linearTeams.find((one) => one.id === body.teamId);
      if (team === undefined) return failure(404, "NOT_FOUND", "That Linear team was not found in the company's Linear workspace.");
      linearPicks.set(name, team.id);
      return { body: { project: name, team } };
    },
    "company.linear.team.clear": ({ params, person }) => {
      const name = params["project"] ?? "";
      if (project(name) === undefined) return failure(404, "NOT_FOUND", "project not found");
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin, or the project's admin, can choose its Linear team.");
      return { body: { project: name, team: null, cleared: linearPicks.delete(name) } };
    },
    "company.audit.records": ({ person }) => person.administrator
      ? { body: { records: [{ at: "2026-11-14T10:00:00.000Z", actor: { developerId: PRIYA.developerId, name: "Priya" }, action: "task.start", subject: TASK_IDS.running, outcome: "ok" }] } }
      : failure(403, "FORBIDDEN", "Only an administrator can read the audit."),
    "scriptTokens.list": ({ person }) => {
      const own = scriptTokenKey(person), company = `${person.company?.id ?? FAKE_COMPANY_ID}:`;
      const tokens = [...scriptTokens].filter(([creator]) => creator === own || person.administrator && creator.startsWith(company))
        .flatMap(([creator, list]) => list.map(token => ({ ...token, status: token.status === "active" && Date.parse(token.expiresAt) <= Date.now() ? "expired" as const : token.status, mine: creator === own, ...(creator === own ? {} : { createdBy: "A teammate" }) })));
      return { body: { tokens, canCreate: person.administrator } };
    },
    "scriptTokens.create": ({ body, person }) => {
      const parsed = CreateScriptTokenBodySchema.safeParse(body);
      if (!parsed.success) return failure(400, "CONFIG_INVALID", "That automation key request isn't valid.");
      const own = scriptTokenKey(person), request = `${own}:${parsed.data.requestId}`;
      if (scriptTokenRequests.has(request)) return failure(409, "CONFLICT", "This request was already used. The key is shown only once.");
      if (parsed.data.projects.some(name => project(name) === undefined)) return failure(404, "NOT_FOUND", "project not found");
      scriptTokenRequests.add(request);
      const tokenPart = randomBytes(10).toString("hex");
      const token: ScriptToken = { tokenId: `stk_${tokenPart}`, name: parsed.data.name, hint: `rvst_…${tokenPart.slice(-8)}`, projects: parsed.data.projects, permissions: parsed.data.permissions, createdAt: iso(), expiresAt: new Date(Date.now() + (parsed.data.days ?? 30) * 86400000).toISOString(), status: "active", mine: true };
      scriptTokens.set(own, [...(scriptTokens.get(own) ?? []), token]);
      return { status: 201, body: { token, secret: `rvst_${randomBytes(10).toString("hex")}_${tokenPart}_${randomBytes(32).toString("base64url")}` } };
    },
    "lessons.list": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      const list = context.query.get("list") ?? "approved";
      if (!(list in LIST_STATUSES)) return failure(400, "CONFIG_INVALID", "list takes list (proposed, approved or retired), since, limit (1 to 100) and cursor, once each");
      if (list !== "approved" && !found.decides) return { body: { project: found.name, list: list as "proposed", canDecide: false, lessons: [] } };
      const since = Number(context.query.get("since") ?? "0");
      const lessons = found.name === "web" ? [...lessonStore.values()].filter((lesson) => LIST_STATUSES[list]!.includes(lesson.status) && lesson.createdAt >= since).sort((a, b) => b.updatedAt - a.updatedAt) : [];
      return { body: { project: found.name, list: list as "proposed", canDecide: found.decides, lessons: lessons.map((lesson) => viewOf(lesson, context.person, found.decides)) } };
    },
    "lessons.approve": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      if (!found.decides) return failure(403, "FORBIDDEN", "Only a maintainer of this project, or an admin, can decide lessons.");
      const result = decide(context.params["lessonId"] ?? "", Number(context.body.version), true, context.body.edit);
      if (!result.ok) return failure(result.code === "NOT_FOUND" ? 404 : 409, result.code, result.message);
      const lesson = lessonStore.get(context.params["lessonId"] ?? "")!;
      return { body: { project: found.name, lessonId: lesson.id, status: result.status, version: lesson.version, ...(lesson.needs === undefined ? {} : { needs: lesson.needs }) } };
    },
    "lessons.reject": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      if (!found.decides) return failure(403, "FORBIDDEN", "Only a maintainer of this project, or an admin, can decide lessons.");
      const result = decide(context.params["lessonId"] ?? "", Number(context.body.version), false);
      if (!result.ok) return failure(result.code === "NOT_FOUND" ? 404 : 409, result.code, result.message);
      return { body: { project: found.name, lessonId: context.params["lessonId"] ?? "", status: "rejected" } };
    },
    "lessons.decisions": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      const decisions = Array.isArray(context.body.decisions) ? context.body.decisions : [];
      if (decisions.length === 0 || decisions.length > 20) return failure(400, "CONFIG_INVALID", "decisions takes 1 to 20 distinct lessons");
      return { body: { project: found.name, results: decisions.map((one) => {
        if (!found.decides) return { lessonId: one.lessonId, ok: false as const, code: "FORBIDDEN", message: "Only a maintainer of this project, or an admin, can decide lessons." };
        return { lessonId: one.lessonId, ...decide(one.lessonId, one.version, one.decision === "keep", one.decision === "keep" ? one.edit : undefined) };
      }) } };
    },
    "lessons.retire": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      if (!found.decides) return failure(403, "FORBIDDEN", "Only a maintainer of this project, or an admin, can decide lessons.");
      const lesson = lessonStore.get(context.params["lessonId"] ?? "");
      if (lesson === undefined || (lesson.status !== "active" && lesson.status !== "stale")) return failure(404, "NOT_FOUND", "That lesson is no longer there.");
      lessonStore.set(lesson.id, { ...lesson, status: "retired", updatedAt: now().getTime() });
      retireAsks.delete(lesson.id);
      return { body: { project: found.name, lessonId: lesson.id, status: "retired" } };
    },
    "lessons.retireRequest": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      const lesson = lessonStore.get(context.params["lessonId"] ?? "");
      if (lesson === undefined || !["active", "stale", "pending"].includes(lesson.status)) return failure(404, "NOT_FOUND", "That lesson is no longer there.");
      if (!retireAsks.has(lesson.id)) retireAsks.set(lesson.id, { by: context.person.name, at: now().getTime() });
      return { body: { project: found.name, lessonId: lesson.id, requested: true } };
    },
    "lessons.retireRequests": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      if (!found.decides) return failure(403, "FORBIDDEN", "Only a maintainer of this project, or an admin, can see retire requests.");
      const requests = [...retireAsks.entries()].flatMap(([lessonId, ask]) => { const lesson = lessonStore.get(lessonId); return lesson === undefined || lesson.status === "retired" ? [] : [{ lessonId, title: lesson.title, status: lesson.status, by: ask.by, at: ask.at }]; });
      return { body: { project: found.name, requests, more: false } };
    },
    "lessons.task": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      const entry = mayRead(context.person, context.params["taskId"] ?? "");
      if (entry === undefined || entry.task.project !== found.name) return failure(404, "TASK_NOT_FOUND", "No such task.");
      const rows = (taskLessons.get(entry.task.taskId) ?? []).map((row) => ({ ...row, harmful: row.harmful === undefined ? undefined : row.harmful + (notHelpful.has(`${entry.task.taskId}:${row.lessonId}`) ? 1 : 0), canMark: row.canMark && !notHelpful.has(`${entry.task.taskId}:${row.lessonId}`) }));
      return { body: { project: found.name, taskId: entry.task.taskId, lessons: rows.map((row) => JSON.parse(JSON.stringify(row)) as TaskLesson) } };
    },
    "lessons.notHelpful": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      const taskId = context.params["taskId"] ?? "", lessonId = context.params["lessonId"] ?? "";
      const entry = mayRead(context.person, taskId);
      if (entry === undefined || !(taskLessons.get(taskId) ?? []).some((row) => row.lessonId === lessonId && row.visible)) return failure(404, "NOT_FOUND", "That lesson is no longer there.");
      if (notHelpful.has(`${taskId}:${lessonId}`)) return failure(409, "IDEMPOTENCY_CONFLICT", "You already marked this lesson.");
      notHelpful.add(`${taskId}:${lessonId}`);
      return { body: { project: found.name, taskId, lessonId, marked: "not_helpful" } };
    },
    // Lead 4 L4-LP3W: the approved lessons by code area: "les_logs00001" lives in web/src/server/, "les_readme001" names no area. A pick of a node lists the approved lessons anchored there.
    "lessons.areas": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      const approved = found.name === "web" ? [...lessonStore.values()].filter((lesson) => lesson.status === "active" || lesson.status === "stale") : [];
      const anchored = (lesson: LessonItem) => (lesson.id === "les_logs00001" ? "src/server" : undefined);
      const inServer = approved.filter((lesson) => anchored(lesson) !== undefined), whole = approved.filter((lesson) => anchored(lesson) === undefined);
      const repos = inServer.length === 0 ? [] : [{ repo: "web", lessons: inServer.length, children: [{ name: "src", path: "src/", lessons: inServer.length, children: [{ name: "server", path: "src/server/", lessons: inServer.length, children: [], files: [{ name: "log.ts", lessons: inServer.length }] }], files: [] }], files: [] }];
      const tree = { project: found.name, total: approved.length, wholeProject: whole.length, repos };
      const repo = context.query.get("repo"), folder = context.query.get("folder") ?? "", wholeAsk = context.query.get("whole") === "1";
      const picked = wholeAsk ? whole : repo === "web" && (folder === "" || folder === "src" || folder === "src/server") ? inServer : repo !== null ? [] : undefined;
      if (picked === undefined) return { body: tree };
      return { body: { ...tree, selection: { ...(wholeAsk ? { whole: true as const } : { repo, folder }), lessons: picked.map((lesson) => viewOf(lesson, context.person, found.decides)) } } };
    },
    "lessons.learningSources.get": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      const counts: Record<string, [number, number, number]> = { task_decisions: [9, 4, 3], review_comments: [6, 2, 1], pr_edits: [12, 5, 3], remember: [2, 2, 2], after_merge: [1, 0, 0], ci: [0, 0, 0] };
      const words: Record<string, [string, string]> = {
        task_decisions: ["Decisions in tasks", "Send-backs and close reasons"], review_comments: ["Review comments", "Comments on Rovara's pull requests and its own review findings"], pr_edits: ["Edits to Rovara's pull requests", "Changes people make before merging"],
        remember: ["Things people ask Rovara to remember", "Notes people write on purpose"], after_merge: ["After merge", "Reverts and what happened to merged work"], ci: ["Failing checks", "Test and build failures. No log text is kept"],
      };
      return { body: { project: found.name, windowDays: 30 as const, canPause: found.decides, sources: (Object.keys(words) as LearningSourceKey[]).map((key) => ({ key, label: words[key]![0], detail: words[key]![1], seen: counts[key]![0], suggested: counts[key]![1], kept: counts[key]![2], paused: pausedSources.has(key), ...(key === "pr_edits" ? { example: { lessonId: "les_logs00001", title: "Log request ids with every error" } } : {}) })) } };
    },
    "lessons.learningSources.put": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      if (!found.decides) return failure(403, "FORBIDDEN", "Only an admin of this project, or an owner or admin of the company, can pause or resume a source.");
      const key = context.params["source"] as LearningSourceKey;
      if (typeof context.body.paused !== "boolean") return failure(400, "CONFIG_INVALID", "pause takes paused: true or false");
      if (context.body.paused) pausedSources.add(key); else pausedSources.delete(key);
      return { body: { project: found.name, key, paused: context.body.paused } };
    },
    "lessons.mode.get": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      return { body: { project: found.name, mode: lessonMode, effective: lessonMode, lockedByCompany: false, canChange: found.decides } };
    },
    "lessons.measure": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      if (!found.decides) return failure(403, "FORBIDDEN", "Only an admin of this project, or an owner or admin of the company, can see how lessons are loaded.");
      const body: LessonMeasureResponse = {
        project: found.name, windowDays: 30, floor: 0.35, loads: 7, lessonsInUse: 12, loadedLessons: 21, loadedBelowFloor: 3,
        loadsWithBelowFloor: 2, loadedNoMatch: 1, meanWordsLoaded: 0.42, meanWordsLeftOut: 0.3, loadsCapBound: 1,
        leftOutAtOrAboveFloor: 4, meanFitLoaded: 0.61, meanFitLeftOut: 0.39,
        cleanMerge: { merged: 5, reverted: 0, clean: 5, rate: 1 }, revertDetection: "not_wired", truncated: false, unreadable: 0,
      };
      return { body };
    },
    "lessons.mode.put": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      if (!found.decides) return failure(403, "FORBIDDEN", "Only an admin of this project, or an owner or admin of the company, can change its learning mode.");
      if (!["off", "suggest", "auto"].includes(context.body.mode)) return failure(400, "CONFIG_INVALID", "the mode is off, suggest or auto");
      lessonMode = context.body.mode;
      return { body: { project: found.name, mode: lessonMode, effective: lessonMode, lockedByCompany: false, canChange: true } };
    },
    // Lessons phase 4. A non-decider reads canDecide false and nothing else (Code's own read); every write is refused in Code's words.
    "lessons.graduation": (context) => {
      lessonCalls.push({ id: "lessons.graduation", params: { ...context.params }, body: null, person: context.person.key });
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      const override = lessonOverrides.get("lessons.graduation");
      if (override !== undefined) return { status: override.status ?? 200, body: override.body as GraduationResponse };
      if (!found.decides || found.name !== "web") return { body: { project: found.name, canDecide: found.decides, drafts: [], rules: [] } };
      const active = [...lessonStore.values()].filter((lesson) => lesson.status === "active" && !graduationLater.has(lesson.id));
      const proven = active.find((lesson) => lesson.id === "les_logs00001");
      const tidy = [...lessonStore.values()].filter((lesson) => lesson.status === "active").sort((a, b) => a.counters.loaded - b.counters.loaded);
      return { body: {
        project: found.name, canDecide: true,
        ...(proven === undefined ? {} : { card: { lessonId: proven.id, version: proven.version, title: proven.title, description: proven.description, type: proven.type, tier: proven.tier, target: "rule" as const, targets: ["rule", "check", "skill"] as Array<"rule" | "check" | "skill">, paths: CARD_PATHS, tasks: 12, days: 41, needs: { required: 1 as const, have: 0, you: false } } }),
        ...(tidyClosed || tidy.length === 0 ? {} : { tidy: { period: 30, lessons: tidy.slice(0, 10).map((lesson) => ({ lessonId: lesson.id, version: lesson.version, title: lesson.title, type: lesson.type, tasks: lesson.counters.helpful + 1, days: 20 })) } }),
        rules: [...teamRules.values()].filter((rule) => rule.status === "live").map((rule) => ({ id: rule.id, text: rule.text, paths: rule.paths, repos: rule.repos, fromLesson: rule.fromLesson, createdAt: rule.createdAt })),
        drafts: [...checkDrafts.values()].filter((draft) => draft.status === "open").map((draft) => ({ id: draft.id, lessonId: draft.lessonId, title: draft.title, request: draft.request, paths: draft.paths, createdAt: draft.createdAt })),
      } };
    },
    "lessons.graduate": graduationRoute("lessons.graduate", (context, project) => {
      const lesson = lessonStore.get(context.params["lessonId"] ?? "");
      if (lesson === undefined || lesson.status !== "active") return failure(404, "NOT_FOUND", "That lesson is no longer there.");
      const target = context.body.target;
      if (!["rule", "check", "skill"].includes(target)) return failure(400, "CONFIG_INVALID", "target is rule, check or skill");
      if (target === "skill") return { body: { project, lessonId: lesson.id, target: "skill", state: "drafted", name: context.body.name ?? "log-request-ids", version: 1 } };
      const asked = context.body.paths;
      // A rule may only narrow the lesson's own paths (Code's check, in its fixed words).
      if (target === "rule" && asked !== undefined && (!Array.isArray(asked) || asked.length < 1 || asked.length > 20 || asked.some((one) => !CARD_PATHS.some((own) => one === own || one.startsWith(own.replace(/\*+$/u, "")))))) return failure(400, "CONFIG_INVALID", "A rule's paths must lie inside the lesson's own paths.");
      const ref = target === "rule" ? "rule_0123456789abcdef" : "chk_fedcba9876543210";
      if (target === "rule") teamRules.set(ref, { id: ref, text: lesson.body, paths: asked ?? CARD_PATHS, repos: lesson.scope.repos, fromLesson: lesson.id, createdAt: now().getTime(), status: "live" });
      if (target === "check") checkDrafts.set(ref, { id: ref, lessonId: lesson.id, title: lesson.title, request: `Add a check for: ${lesson.body}`, paths: [], createdAt: now().getTime(), status: "open" });
      lessonStore.set(lesson.id, { ...lesson, status: "retired", updatedAt: now().getTime(), became: { kind: target, ref, at: now().getTime() } });
      return { body: { project, lessonId: lesson.id, target, state: "done", ref, already: false } };
    }),
    "lessons.graduateLater": graduationRoute("lessons.graduateLater", (context, project) => {
      if (!lessonStore.has(context.params["lessonId"] ?? "")) return failure(404, "NOT_FOUND", "That lesson is no longer there.");
      graduationLater.add(context.params["lessonId"] ?? "");
      return { body: { project, lessonId: context.params["lessonId"] ?? "", later: true } };
    }),
    "lessons.bothPlaces": graduationRoute("lessons.bothPlaces", (context, project) => {
      const lesson = lessonStore.get(context.params["lessonId"] ?? "");
      if (lesson === undefined || lesson.status !== "pending" || lesson.contradicts === undefined) return failure(404, "NOT_FOUND", "That lesson is no longer there.");
      if (lesson.version !== context.body.version) return failure(409, "IDEMPOTENCY_CONFLICT", "This lesson changed since you read it. Read it again and decide again.");
      lessonStore.set(lesson.id, { ...lesson, scope: { ...lesson.scope, paths: context.body.cardPaths } });
      return { body: { project, lessonId: lesson.id, otherId: lesson.contradicts, cardPaths: context.body.cardPaths, otherPaths: context.body.otherPaths, version: lesson.version, status: "pending", needs: "second_person" } };
    }),
    "lessons.tidy.retire": graduationRoute("lessons.tidy.retire", (context, project) => {
      const ids = context.body.ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10) return failure(400, "CONFIG_INVALID", "ids takes 1 to 10 lessons");
      const retired: string[] = [];
      for (const id of ids) {
        const lesson = lessonStore.get(id);
        if (lesson?.status === "active") { lessonStore.set(id, { ...lesson, status: "retired", updatedAt: now().getTime() }); retired.push(id); }
      }
      return { body: { project, retired, skipped: ids.length - retired.length } };
    }),
    "lessons.rules.retire": graduationRoute("lessons.rules.retire", (context, project) => {
      const rule = teamRules.get(context.params["ruleId"] ?? "");
      if (rule === undefined || rule.status !== "live") return failure(404, "NOT_FOUND", "That rule is no longer there.");
      rule.status = "retired";
      return { body: { project, ruleId: rule.id, status: "retired" } };
    }),
    "lessons.tidy.later": graduationRoute("lessons.tidy.later", (_context, project) => { tidyClosed = true; return { body: { project, closed: true } }; }),
    "lessons.checkDraft.started": graduationRoute("lessons.checkDraft.started", (context, project) => {
      const draft = checkDrafts.get(context.params["draftId"] ?? "");
      if (draft === undefined || draft.status !== "open") return failure(404, "NOT_FOUND", "That draft is no longer there.");
      const entry = mayRead(context.person, context.body.taskId);
      if (entry === undefined || entry.owner.developerId !== context.person.developerId || entry.task.project !== project) return failure(404, "NOT_FOUND", "No such task.");
      draft.status = "started";
      return { body: { project, draftId: draft.id, status: "started" } };
    }),
    "lessons.checkDraft.dismiss": graduationRoute("lessons.checkDraft.dismiss", (context, project) => {
      const draft = checkDrafts.get(context.params["draftId"] ?? "");
      if (draft === undefined || draft.status !== "open") return failure(404, "NOT_FOUND", "That draft is no longer there.");
      draft.status = "dismissed";
      return { body: { project, draftId: draft.id, status: "dismissed" } };
    }),
    // L4-EGR: Rovara's outbound addresses, the same for every company (the install's); only an owner or admin reads them.
    "company.egressAddresses.get": ({ person }) => (companyless.has(person.developerId) ? failure(401, "AUTH_REQUIRED", "sign in again") : !person.administrator ? failure(403, "FORBIDDEN", "Only a company owner or admin can see Rovara's outbound addresses.") : { body: { addresses: EGRESS_ADDRESSES.slice(), requestId: "JBnQ5hKvIAMEJ-Q=" } }),
    // Any member reads; an owner or admin sets a model from the offered list.
    "company.engineModel.get": ({ person }) => (companyless.has(person.developerId) ? failure(401, "AUTH_REQUIRED", "sign in again") : { body: engineView() }),
    "company.engineModel.put": ({ person, body }) => {
      if (companyless.has(person.developerId)) return failure(401, "AUTH_REQUIRED", "sign in again");
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin can change the company's AI model.");
      if (body.model !== null && !OFFERED_MODELS.includes(body.model)) return failure(400, "CONFIG_INVALID", "That model isn't offered to this company now. Pick one from the list.");
      companyModel = body.model ?? undefined;
      return { body: engineView() };
    },
    // Any member reads; an owner or admin sets a Claude model from the offered list (null puts the install default back).
    "company.learningModel.get": ({ person }) => (companyless.has(person.developerId) ? failure(401, "AUTH_REQUIRED", "sign in again") : { body: learningView() }),
    "company.learningModel.put": ({ person, body }) => {
      if (companyless.has(person.developerId)) return failure(401, "AUTH_REQUIRED", "sign in again");
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin can change the model lessons learn with.");
      // Code's body schema takes only Claude ids (its own words); a Claude id the gateway doesn't offer is the "not offered" answer.
      if (body.model !== null && !(typeof body.model === "string" && body.model.startsWith("claude-"))) return failure(400, "CONFIG_INVALID", "Send the Claude model lessons should learn with, as { \"model\": \"<model id>\" }, or { \"model\": null } to use this Rovara's default.");
      if (body.model !== null && !LEARNING_OFFERED.includes(body.model)) return failure(400, "CONFIG_INVALID", "That model isn't a Claude model offered to this company now. Pick one from the list.");
      learningModel = body.model ?? undefined;
      return { body: learningView() };
    },
    // Members of the project read; its administrator changes (revision-checked). No step-up (owner DEC 254zzz73).
    "projects.settings.get": ({ params, person }) => (roleIn(person, params["project"] ?? "") === undefined ? notFound("project") : { body: settingsView(params["project"] ?? "") }),
    "projects.settings.put": ({ params, person, body }) => {
      const name = params["project"] ?? "";
      const grant = roleIn(person, name);
      if (grant === undefined) return notFound("project");
      if (grant !== "administrator") return failure(403, "FORBIDDEN", "project administrator required");
      const entry = projectSettings.get(name) ?? { overrides: {}, revision: 0 };
      if (body.expectedRevision !== entry.revision) return failure(409, "PROJECT_REVISION_MISMATCH", "settings revision conflict");
      projectSettings.set(name, { overrides: { ...(body.overrides ?? entry.overrides) }, revision: entry.revision + 1 });
      return { body: settingsView(name) };
    },
    "scriptTokens.revoke": ({ params, person }) => {
      const own = scriptTokenKey(person), company = `${person.company?.id ?? FAKE_COMPANY_ID}:`;
      for (const [creator, tokens] of scriptTokens) {
        const token = tokens.find(entry => entry.tokenId === params["tokenId"]);
        if (token === undefined || creator !== own && !(person.administrator && creator.startsWith(company))) continue;
        token.status = "revoked"; token.revokedAt ??= iso();
        return { body: { token: { ...token, mine: creator === own } } };
      }
      return failure(404, "NOT_FOUND", "That automation key doesn't exist, or you can't manage it.");
    },
  };

  // --- the HTTP layer
  async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new Error("body too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function issue(person: Person, joined = false): { access_token: string; refresh_token: string; token_type: "Bearer" } {
    const accessToken = `fake-access-${randomBytes(12).toString("hex")}`;
    if (joined) joinedTokens.add(accessToken);
    const refreshToken = `fake-refresh-${randomBytes(12).toString("hex")}`;
    access.set(accessToken, person);
    refresh.set(refreshToken, person);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer" };
  }

  function tokenEndpoint(form: URLSearchParams, authorization: string | undefined): { status: number; body: unknown } {
    if (authorization !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`) return { status: 401, body: { error: "invalid_client" } };
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (code === undefined || form.get("redirect_uri") !== code.redirectUri || createHash("sha256").update(verifier).digest("base64url") !== code.challenge) return { status: 400, body: { error: "invalid_grant" } };
      return { status: 200, body: issue(code.person, code.joined === true) };
    }
    if (form.get("grant_type") === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const person = refresh.get(token);
      refresh.delete(token);
      return person === undefined ? { status: 400, body: { error: "invalid_grant" } } : { status: 200, body: issue(person) };
    }
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake-code.invalid");
      const method = request.method ?? "GET";
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        log.push({ method, path: url.pathname, query: url.search, status });
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
        response.end(body === undefined ? "" : JSON.stringify(body));
      };
      try {
        if (method === "POST" && url.pathname === "/__fake/person") {
          const wanted = (JSON.parse(await readBody(request)) as { person?: string }).person;
          const who = [...PEOPLE, ZED].find((one) => one.key === wanted);
          if (who === undefined) return send(400, { error: { code: "CONFIG_INVALID", message: "person is priya, sam or zed" } });
          current = who;
          return send(200, { person: who.key });
        }
        // The person confirms a waiting People change on Code's own page (a test stands in for that page).
        if (method === "POST" && url.pathname === "/__fake/people-confirm") {
          const requestId = (JSON.parse(await readBody(request)) as { requestId?: string }).requestId;
          // No request id: every waiting change is confirmed.
          const waiting = requestId === undefined ? [...pendingPeople.keys()] : pendingPeople.has(requestId) ? [requestId] : [];
          if (waiting.length === 0) return send(404, { error: { code: "NOT_FOUND", message: "no waiting change" } });
          for (const id of waiting) { pendingPeople.get(id)?.(); pendingPeople.delete(id); }
          return send(200, { confirmed: waiting.length });
        }
        if (method === "POST" && url.pathname === "/__fake/no-company") {
          const on = (JSON.parse(await readBody(request)) as { on?: unknown }).on;
          if (typeof on !== "boolean") return send(400, { error: { code: "CONFIG_INVALID", message: "on is true or false" } });
          if (on) companyless.add(current.developerId); else companyless.delete(current.developerId);
          return send(200, { on });
        }
        // K5: seed the inbox. rows name a task by its title or id; `off` makes the inbox answer 404 (a Code with no inbox); `clear` forgets the rows.
        if (method === "POST" && url.pathname === "/__fake/inbox") {
          const wanted = JSON.parse(await readBody(request)) as { off?: boolean; clear?: boolean; rows?: Array<{ taskTitle?: string; taskId?: string; kind?: string; read?: boolean; atMs?: number }> };
          if (wanted.off !== undefined) inboxOff = wanted.off;
          if (wanted.clear === true) inboxRows.clear();
          for (const row of wanted.rows ?? []) {
            const entry = row.taskId !== undefined ? tasks.get(row.taskId) : [...tasks.values()].find((one) => one.task.title === row.taskTitle);
            if (entry === undefined) return send(400, { error: { code: "CONFIG_INVALID", message: "no such task" } });
            inboxRows.set(current.developerId, [...(inboxRows.get(current.developerId) ?? []), { taskId: entry.task.taskId, kind: row.kind ?? "needs_you", atMs: row.atMs ?? Date.now(), read: row.read === true }]);
          }
          return send(200, { off: inboxOff });
        }
        // Guided onboarding PR 10: forget the projects a spec made through the picker (the two the pretend Code starts with stay), so later specs see the people and projects they expect.
        if (method === "POST" && url.pathname === "/__fake/reset-created-projects") {
          const keep = new Set(["web", "api", "secret-ledger"]);
          for (let index = projects.length - 1; index >= 0; index -= 1) if (!keep.has(projects[index]!.name)) projects.splice(index, 1);
          return send(200, { projects: projects.length });
        }
        // Web task channel K4: say how Code answers the involved list (`reset` puts it back as it was), and add a person (`as`: priya or sam, default the one signed in last) to a task of someone else (`involve`: true makes a new task owned by the other of the two; or the id of an existing one).
        if (method === "POST" && url.pathname === "/__fake/involved") {
          const input = JSON.parse(await readBody(request)) as { reset?: unknown; mode?: unknown; involve?: unknown; as?: unknown; title?: unknown; updatedAt?: unknown };
          // The person added (default: whoever signed in last) and the owner of the new task (the other of the two).
          const added = PEOPLE.find((one) => one.key === input.as) ?? current, owner = added.developerId === SAM.developerId ? PRIYA : SAM;
          if (input.reset === true) { for (const made of involvedMade) tasks.delete(made);involvedMade.clear();involved.clear();involvedMode = "on"; }
          if (input.mode !== undefined) {
            if (typeof input.mode !== "string" || !["on", "old", "400", "404", "501", "500"].includes(input.mode)) return send(400, { error: { code: "CONFIG_INVALID", message: "mode is on, old, 400, 404, 501 or 500" } });
            involvedMode = input.mode as typeof involvedMode;
          }
          let taskId: string | undefined;
          if (input.involve === true) {
            taskId = randomUUID();
            involvedMade.add(taskId);
            const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : iso();
            tasks.set(taskId, base(taskId, owner, { title: typeof input.title === "string" ? input.title : "Migrate the invoices table", project: "api", createdAt: updatedAt, updatedAt, workflow: workflowOf(taskId, owner, { stage: "IMPLEMENT", state: "RUNNING", revision: 3 }, { createdAt: updatedAt, updatedAt }) }));
          } else if (typeof input.involve === "string" && tasks.has(input.involve)) taskId = input.involve;
          if (taskId !== undefined) involved.set(taskId, new Set([...(involved.get(taskId) ?? []), added.developerId]));
          return send(200, { mode: involvedMode, ...(taskId === undefined ? {} : { taskId }) });
        }
        if (method === "POST" && url.pathname === "/__fake/saved-env") {
          const given = JSON.parse(await readBody(request)) as { project?: unknown; mode?: unknown };
          if (typeof given.project !== "string" || !["off", "route-missing", "core-off", "never", "healthy", "broken", "extra-field", "501"].includes(given.mode as string)) return send(400, { error: { code: "CONFIG_INVALID", message: "project and mode" } });
          savedEnvModes.set(given.project, given.mode as SavedEnvMode);
          return send(200, { mode: given.mode });
        }
        if (method === "POST" && url.pathname === "/__fake/wiki") {
          const given = JSON.parse(await readBody(request)) as { project?: unknown; state?: unknown; off?: unknown; broken?: unknown };
          if (typeof given.project !== "string" || project(given.project) === undefined || (given.state !== undefined && !["ready", "none", "building", "stopped"].includes(given.state as string))) return send(400, { error: { code: "CONFIG_INVALID", message: "project, and state ready, none, building or stopped" } });
          for (const key of [...corrections.keys()]) if (key.startsWith(`${given.project}/`)) corrections.delete(key);
          wikis.set(given.project, { ...(given.state === undefined ? {} : { state: given.state as "ready" }), ...(given.off === true ? { off: true } : {}), ...(given.broken === true ? { broken: true } : {}) });
          return send(200, { project: given.project });
        }
        if (method === "POST" && url.pathname === "/__fake/eval-check") {
          // L4-EVCI2: sets the pretend card of one project (verdict, items, the confirmed check, `off`), and reads back what it saw (`puts`, `lastBody`).
          const given = JSON.parse(await readBody(request)) as Record<string, unknown>;
          if (typeof given["project"] !== "string" || project(given["project"]) === undefined) return send(400, { error: { code: "CONFIG_INVALID", message: "project" } });
          if (given["read"] === true) { const seen = evalCheckOf(given["project"]); return send(200, { puts: seen.puts, lastBody: seen.lastBody ?? null, confirmed: seen.confirmed ?? null }); }
          evalChecks.delete(given["project"]);
          const one = evalCheckOf(given["project"]);
          if (given["off"] === true) one.off = true;
          if (given["verdict"] === "proposals" || given["verdict"] === "none_found" || given["verdict"] === "unknown") one.verdict = given["verdict"];
          if (Array.isArray(given["items"])) one.items = given["items"] as FakeEvalCheck["items"];
          if (typeof given["confirmed"] === "object" && given["confirmed"] !== null) one.confirmed = given["confirmed"] as NonNullable<FakeEvalCheck["confirmed"]>;
          return send(200, { project: given["project"] });
        }
        if (method === "POST" && url.pathname === "/__fake/wiki-setup") {
          const given = JSON.parse(await readBody(request)) as Record<string, unknown>;
          if (typeof given["project"] !== "string" || project(given["project"]) === undefined) return send(400, { error: { code: "CONFIG_INVALID", message: "project" } });
          wikiSetups.delete(given["project"]);
          upkeepConsent.set(companyKeyOf(given["project"]), given["consent"] === true);
          const one = wikiSetupOf(given["project"]);
          const status = given["status"];
          if (status === "built" || status === "stopped" || status === "running") { Object.assign(one, { status, pages: 24, refreshPages: 2, mapMade: true, planned: 24, written: status === "built" ? 24 : 12 }); if (status === "stopped") one.stop = (given["stop"] as FakeWikiSetup["stop"] | undefined) ?? "stopped_by_person"; }
          if (given["aiKey"] === "missing" || given["aiKey"] === "unknown") one.aiKey = given["aiKey"];
          if (given["mapMade"] === true) one.mapMade = true;
          if (given["refreshPages"] === 0) one.refreshPages = 0;
          if (given["agentsOn"] === true) one.agentsOn = true;
          if (given["upkeepOn"] === true) one.upkeepOn = true;
          if (given["off"] === true) one.off = true;
          if (given["upkeepOff"] === true) one.upkeepOff = true;
          if (given["ceilingOff"] === true) one.ceilingOff = true;
          if (given["legacyUpkeep"] === true) one.legacyUpkeep = true;
          if (typeof given["capUsd"] === "number") one.capUsd = given["capUsd"];
          if (typeof given["repair"] === "object" && given["repair"] !== null) one.repair = given["repair"] as NonNullable<FakeWikiSetup["repair"]>;
          if (given["paused"] === "no_budget" || given["paused"] === "monthly_limit" || given["paused"] === "cost_too_high") one.paused = given["paused"];
          if (given["setupCheckOff"] === true) one.setupCheckOff = true;
          return send(200, { project: given["project"] });
        }
        if (method === "POST" && url.pathname === "/__fake/how-we-work") {
          const given = JSON.parse(await readBody(request)) as { project?: unknown; mode?: unknown };
          if (typeof given.project !== "string" || !["on", "off", "core-off", "broken", "501", "403"].includes(given.mode as string)) return send(400, { error: { code: "CONFIG_INVALID", message: "project and mode" } });
          howWeWorkModes.set(given.project, given.mode as HowWeWorkMode);
          return send(200, { mode: given.mode });
        }
        if (method === "POST" && url.pathname === "/__fake/answers") {
          const given = JSON.parse(await readBody(request)) as { project?: unknown; answers?: unknown; suggest?: unknown };
          if (typeof given.project !== "string" || project(given.project) === undefined || (given.answers !== undefined && !["answered", "not_set_up", "off"].includes(given.answers as string))) return send(400, { error: { code: "CONFIG_INVALID", message: "project and answers" } });
          answerSets.set(given.project, { ...(given.answers === undefined ? {} : { answers: given.answers as "answered" }), ...(given.suggest === undefined ? {} : { suggest: given.suggest as Record<string, unknown> }) });
          return send(200, { project: given.project });
        }
        if (method === "POST" && url.pathname === "/__fake/lessons") {
          const on = (JSON.parse(await readBody(request)) as { on?: unknown }).on;
          if (typeof on !== "boolean") return send(400, { error: { code: "CONFIG_INVALID", message: "on is true or false" } });
          lessonsOn = on;
          pausedSources.clear();
          return send(200, { on });
        }
        if (method === "POST" && url.pathname === "/__fake/report") {
          const given = JSON.parse(await readBody(request)) as { reset?: unknown; tasks?: unknown; features?: unknown };
          if (given.reset === true) { reportData = undefined; return send(200, { served: false }); }
          if (!Array.isArray(given.tasks) || !Array.isArray(given.features)) return send(400, { error: { code: "CONFIG_INVALID", message: "tasks and features are lists, or reset is true" } });
          reportData = { tasks: given.tasks, features: given.features };
          return send(200, { served: true, tasks: given.tasks.length });
        }
        // The Cost and time report's two reads (design A5): company owners and admins only, rows oldest first, 200 a page by a numeric cursor, `next` always and `hasMore` (Code PR #913).
        if (method === "GET" && (url.pathname === "/v1/app/org/report/tasks" || url.pathname === "/v1/app/org/report/features")) {
          const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
          const who = bearer === undefined ? undefined : access.get(bearer);
          if (who === undefined) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (reportData === undefined) return send(404, { error: { code: "NOT_FOUND", message: "route not found" } });
          if (!who.administrator) return send(403, { error: { code: "FORBIDDEN", message: "only a company owner or admin" } });
          if (url.pathname.endsWith("/features")) return send(200, { features: reportData.features });
          // Code takes exactly one of `from` (a full instant with milliseconds) and `cursor`.
          const from = url.searchParams.get("from"), cursor = url.searchParams.get("cursor");
          if ((from === null) === (cursor === null) || (from !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(from))) return send(400, { error: { code: "CONFIG_INVALID", message: "the report query is not valid" } });
          const size = 200, start = Number(cursor ?? "0");
          const more = start + size < reportData.tasks.length;
          return send(200, { tasks: reportData.tasks.slice(start, start + size), next: String(more ? start + size : reportData.tasks.length), hasMore: more, skipped: 0, unreadable: 0 });
        }
        if (method === "POST" && url.pathname === "/__fake/plan-features") {
          const given = JSON.parse(await readBody(request)) as { reset?: unknown; company?: unknown; features?: unknown; filed?: unknown };
          if (given.reset === true) { planChoices.clear(); planFiled.clear(); planMayChange = undefined; return send(200, { reset: true }); }
          if (typeof (given as { canChange?: unknown }).canChange === "boolean") planMayChange = (given as { canChange: boolean }).canChange;
          if (Array.isArray(given.features)) planChoices.set(typeof given.company === "string" ? given.company : FAKE_COMPANY_ID, given.features as Array<{ id: string; name: string }>);
          if (typeof given.filed === "object" && given.filed !== null) { const filed = given.filed as { taskId: string; featureId: string | null; source: string }; planFiled.set(filed.taskId, { featureId: filed.featureId, source: filed.source }); }
          return send(200, { ok: true });
        }
        // The plan card's feature-choice read is Code's own gate; its writes use the report actions below.
        const planTask = method === "GET" && /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/feature-choices$/u.exec(url.pathname);
        if (planTask) {
          const who = access.get(/^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "");
          if (who === undefined) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          const taskId = planTask[1]!;
          const found = tasks.get(taskId);
          const mine = found !== undefined && (found.owner.developerId === who.developerId || who.administrator) && companyIdOf(found.owner) === companyIdOf(who);
          if (!mine) return send(404, { error: { code: "NOT_FOUND", message: "task not found" } });
          return send(200, { features: planChoices.get(companyIdOf(who)) ?? [], canCreate: who.administrator });
        }
        // The Cost and time actions (lane L4-CR4), with Code's own rules and fixed sentences (Code PR #913): company owners and admins change features; the report's rows and features are the ones the specs set.
        const featureAction = /^\/v1\/app\/org\/report\/features(?:\/(ft_[a-f0-9]{20})\/(rename|merge|state))?$/u.exec(url.pathname);
        const taskMove = /^\/v1\/app\/tasks\/([^/]+)\/feature$/u.exec(url.pathname);
        if (method === "POST" && (featureAction !== null || taskMove !== null)) {
          const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
          const who = bearer === undefined ? undefined : access.get(bearer);
          if (who === undefined) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (reportData === undefined && (planChoices.size > 0 || planFiled.size > 0)) {
            // Lead 4 PCF: the plan card's Change, No feature and "make a new one" use these same two Cost and time actions; with no report seeded they act on the plan-feature state the spec set.
            const planGiven = JSON.parse(await readBody(request) || "{}") as Record<string, unknown>;
            const choices = planChoices.get(companyIdOf(who)) ?? [];
            const planRefuse = (status: number, code: string, message: string) => send(status, { error: { code, message } });
            if (taskMove !== null) {
              const taskId = taskMove[1]!;
              if (!planFeatureView(who, taskId).canChange) return planRefuse(403, "FORBIDDEN", "You can't change this task's feature.");
              const target = planGiven["feature"];
              if (target !== null && typeof target !== "string") return planRefuse(400, "CONFIG_INVALID", "The request is not valid.");
              const into = target === null ? undefined : choices.find((entry) => entry.id === target);
              if (target !== null && into === undefined) return planRefuse(404, "NOT_FOUND", "That feature does not exist.");
              planFiled.set(taskId, { featureId: into?.id ?? null, source: "chosen" });
              return send(200, { task: { taskId, feature: into === undefined ? null : { id: into.id, source: "moved" } } });
            }
            if (featureAction![1] !== undefined) return planRefuse(404, "NOT_FOUND", "route not found");
            if (!who.administrator) return planRefuse(403, "FORBIDDEN", "Only an owner or admin of the company can change features.");
            const name = typeof planGiven["name"] === "string" ? planGiven["name"].trim() : "";
            if (name === "" || [...name].length > 80) return planRefuse(400, "CONFIG_INVALID", "The request is not valid.");
            if (choices.some((entry) => entry.name === name)) return planRefuse(400, "CONFIG_INVALID", "A feature with that name already exists.");
            const made = { id: `ft_${(choices.length + 1 + 0xe0).toString(16).padStart(20, "0")}`, name };
            planChoices.set(companyIdOf(who), [...choices, made]);
            return send(201, { feature: { ...made, state: "open", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z" } });
          }
          if (reportData === undefined) return send(404, { error: { code: "NOT_FOUND", message: "route not found" } });
          if (!who.administrator) return send(403, { error: { code: "FORBIDDEN", message: "Only an owner or admin of the company can change features." } });
          const given = JSON.parse(await readBody(request) || "{}") as Record<string, unknown>;
          const features = reportData.features as Array<{ id: string; name: string; state: string }>;
          const tasks = reportData.tasks as Array<Record<string, unknown>>;
          const refuse = (status: number, code: string, message: string) => send(status, { error: { code, message } });
          const view = (feature: { id: string; name: string; state: string }) => ({ ...feature, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z" });
          if (taskMove !== null) {
            const task = tasks.find((entry) => entry["taskId"] === taskMove[1]);
            if (task === undefined) return refuse(404, "NOT_FOUND", "task not found");
            const target = given["feature"];
            if (target !== null && typeof target !== "string") return refuse(400, "CONFIG_INVALID", "The request is not valid.");
            const into = target === null ? undefined : features.find((entry) => entry.id === target);
            if (target !== null && into === undefined) return refuse(404, "NOT_FOUND", "That feature does not exist.");
            if (into?.state === "done") return refuse(400, "CONFIG_INVALID", "That feature is done. Reopen it first.");
            if (into === undefined) delete task["feature"]; else task["feature"] = { id: into.id, source: "moved" };
            return send(200, { task: { taskId: task["taskId"], feature: into === undefined ? null : { id: into.id, source: "moved" } } });
          }
          if (featureAction![1] === undefined) {
            const name = typeof given["name"] === "string" ? given["name"].trim() : "";
            if (name === "" || [...name].length > 80) return refuse(400, "CONFIG_INVALID", "The request is not valid.");
            if (features.some((entry) => entry.name === name)) return refuse(400, "CONFIG_INVALID", "A feature with that name already exists.");
            const made = { id: `ft_${(features.length + 1 + 0xe0).toString(16).padStart(20, "0")}`, name, state: "open" };
            features.push(made);
            return send(201, { feature: view(made) });
          }
          const feature = features.find((entry) => entry.id === featureAction![1]);
          if (feature === undefined) return refuse(404, "NOT_FOUND", "That feature does not exist.");
          if (featureAction![2] === "rename") {
            const name = typeof given["name"] === "string" ? given["name"].trim() : "";
            if (name === "" || [...name].length > 80) return refuse(400, "CONFIG_INVALID", "The request is not valid.");
            if (features.some((entry) => entry.name === name && entry.id !== feature.id)) return refuse(400, "CONFIG_INVALID", "A feature with that name already exists.");
            feature.name = name;
            return send(200, { feature: view(feature) });
          }
          if (featureAction![2] === "state") {
            if (given["state"] !== "open" && given["state"] !== "done") return refuse(400, "CONFIG_INVALID", "The request is not valid.");
            feature.state = given["state"];
            return send(200, { feature: view(feature) });
          }
          const into = features.find((entry) => entry.id === given["into"]);
          if (into === undefined) return refuse(404, "NOT_FOUND", "That feature does not exist.");
          if (into.id === feature.id) return refuse(400, "CONFIG_INVALID", "A feature cannot be merged into itself or into one already merged away.");
          for (const task of tasks) { const filed = task["feature"] as { id: string } | undefined; if (filed?.id === feature.id) task["feature"] = { id: into.id, source: "moved" }; }
          features.splice(features.indexOf(feature), 1);
          return send(200, { feature: view(into) });
        }
        const raw = await readBody(request);
        if (method === "POST" && url.pathname === "/v1/auth/token") {
          const answer = tokenEndpoint(new URLSearchParams(raw), request.headers.authorization);
          return send(answer.status, answer.body);
        }
        // The inbox and the session read Cloud makes to place its rows (K5): paths under /v1/app that Code's core serves; the bearer names the person.
        if (/^\/v1\/app\/(?:inbox(?:\/read)?|sessions\/ses_[0-9a-z]{20})$/u.test(url.pathname)) {
          const person = access.get(/^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "");
          if (person === undefined) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          let parsed: unknown = {};
          try { parsed = raw === "" ? {} : JSON.parse(raw); } catch { return send(400, { error: { code: "CONFIG_INVALID", message: "the request body is not JSON" } }); }
          const answered = inboxAnswer(method, url.pathname, url.searchParams, person, parsed);
          if (answered !== undefined) return send(answered.status, answered.body);
        }
        if (method === "POST" && url.pathname === "/__fake/setup-run") {
          const given = JSON.parse(raw) as { project?: unknown; status?: unknown; approved?: unknown };
          if (typeof given.project !== "string" || project(given.project) === undefined || !["none", "running", "ready", "failed"].includes(given.status as string)) return send(400, { error: { code: "CONFIG_INVALID", message: "project and status" } });
          const status = given.status as FakeRun["status"];
          setupRuns.set(given.project, status === "none" ? { status } : { status, startedAt: iso(), taskId: randomUUID(), ...(status === "ready" && given.approved === true ? { approved: true } : {}) });
          setupSkips.delete(given.project);
          return send(200, { status });
        }
        if (method === "POST" && url.pathname === "/__fake/eval-card") {
          const given = JSON.parse(raw) as { project?: unknown; state?: unknown; health?: unknown };
          if (typeof given.project !== "string" || project(given.project) === undefined || !["default", "none", "propose", "waiting", "approved", "rejected"].includes(given.state as string)) return send(400, { error: { code: "CONFIG_INVALID", message: "project and state" } });
          const wrapper = (given as { wrapper?: unknown }).wrapper;
          // "default": forget the set card, so the project's card follows its setup run again (a spec's afterEach puts it back this way).
          if (given.state === "default") { evalCards.delete(given.project);return send(200, { ok: true }); }
          evalCards.set(given.project, { state: given.state as FakeEval["state"], health: ["requested", "finished"].includes(given.health as string) ? given.health as FakeEval["health"] : "none", ...(typeof wrapper === "string" && ["needs_file", "pull_request_open", "file_found", "dismissed", "not_offered", "custom"].includes(wrapper) ? { wrapper: wrapper as FakeWrapperStep } : {}) });
          return send(200, { ok: true });
        }
        if (method === "POST" && url.pathname === "/__fake/setup-apply") {
          const given = JSON.parse(raw) as { project?: unknown; apply?: Partial<FakeApply> | null };
          if (typeof given.project !== "string" || project(given.project) === undefined) return send(400, { error: { code: "CONFIG_INVALID", message: "project and apply" } });
          if (given.apply === null || given.apply === undefined) setupApplies.delete(given.project);
          else {
            const risk = given.apply.risk ?? "low";
            setupApplies.set(given.project, { check: given.apply.check ?? "ready", risk, changes: given.apply.changes ?? [{ area: "setup_commands", risk: "low" }, { area: "test_commands", risk: "low" }], canApprove: given.apply.canApprove ?? true, canReject: given.apply.canReject ?? true, moved: given.apply.moved ?? false, revision: 4, ...(given.apply.failedStep === undefined ? {} : { failedStep: given.apply.failedStep }) });
          }
          return send(200, { ok: true });
        }
        if (url.pathname === "/v1/app/company/system-runs" && (method === "GET" || method === "PUT")) {
          const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
          const who = bearer === undefined ? undefined : access.get(bearer);
          if (who === undefined) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          let parsed: unknown = {};
          if (raw !== "") { try { parsed = JSON.parse(raw); } catch { return send(400, { error: { code: "CONFIG_INVALID", message: "the request body is not JSON" } }); } }
          const answered = systemRunsAnswer(method, who, parsed);
          return send(answered.status, answered.body);
        }
        if (url.pathname.startsWith("/v1/app/projects/")) {
          const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
          const who = bearer === undefined ? undefined : access.get(bearer);
          let parsed: unknown = {};
          if (raw !== "") { try { parsed = JSON.parse(raw); } catch { return send(400, { error: { code: "CONFIG_INVALID", message: "the request body is not JSON" } }); } }
          const answer = who === undefined ? undefined : wikiAnswer(method, url.pathname, who, parsed, url.searchParams) ?? howWeWorkAnswer(method, url.pathname, who) ?? savedEnvAnswer(method, url.pathname, who) ?? wikiSetupAnswer(method, url.pathname, who, parsed) ?? evalCheckAnswer(method, url.pathname, who, parsed) ?? answersAnswer(method, url.pathname, who, parsed) ?? setupRunAnswer(method, url.pathname, url.searchParams, who, parsed);
          if (who === undefined && /\/(?:answers|code\/suggest)$/u.test(url.pathname)) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (who === undefined && /\/how-we-work$/u.test(url.pathname)) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (who === undefined && /\/(?:wiki(?:[-/]|$)|upkeep$)/u.test(url.pathname)) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (who === undefined && /\/environment-image$/u.test(url.pathname)) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (who === undefined && /\/setup-agent(?:\/(?:stop|journal|confirm|discard|decide))?$/u.test(url.pathname)) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          const updateAnswer = who === undefined ? undefined : ticketUpdatesAnswer(method, url.pathname, who, parsed);
          if (who === undefined && /\/intake\/updates$/u.test(url.pathname)) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (updateAnswer !== undefined) return send(updateAnswer.status, updateAnswer.body);
          if (answer !== undefined) return send(answer.status, answer.body);
        }
        // Code serves its decision cards on its own `/v1/app/decisions...` (core host, L4-MF1); the contract rows still carry the historical `/v1/dev/client/decisions...`, which real Code never served and
        // Cloud no longer asks. The fake answers the real path with the same cards, and the contract path too (the "answers every route in the contract" test reads the rows as they are); a spec that wants to
        // prove Cloud never asks the old path reads the fake's log.
        const matched = matchCodeRoute(method, /^\/v1\/app\/decisions(?:\/|$)/u.test(url.pathname) ? `/v1/dev/client${url.pathname.slice("/v1/app".length)}` : url.pathname);
        if (matched === undefined) return send(404, { error: { code: "NOT_FOUND", message: "route not found" } });
        const id = matched.route.id;
        let person: Person | undefined = current;
        let bearer: string | undefined;
        if (matched.route.scope !== "none" || id === "access.check" || id === "auth.revoke") {
          bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
          person = bearer === undefined ? undefined : access.get(bearer);
          if (person === undefined) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
        }
        let body: unknown = {};
        if (raw !== "") {
          try { body = JSON.parse(raw); } catch { return send(400, { error: { code: "CONFIG_INVALID", message: "the request body is not JSON" } }); }
        }
        const handler = handlers[id] as Handler<CodeRouteId>;
        const answer = await handler({ body: body as never, params: matched.params, query: url.searchParams, person, ...(bearer === undefined ? {} : { token: bearer }) });
        const status = answer.status ?? 200;
        return send(status, status === 302 ? undefined : answer.body ?? {}, answer.headers);
      } catch (error) {
        return send(500, { error: { code: "FAKE_CODE_ERROR", message: error instanceof Error ? error.message : "failed" } });
      }
    })();
  });

  await new Promise<void>((resolve) => { server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve); });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${String(address.port)}`,
    server,
    log,
    setPerson: (person) => { current = person; },
    setLessons: (on) => { lessonsOn = on; },
    lessonCalls,
    resetLessons,
    overrideLessonAnswer: (id, answer) => { if (answer === undefined) lessonOverrides.delete(id); else lessonOverrides.set(id, answer); },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); server.closeAllConnections(); }),
  };
}
