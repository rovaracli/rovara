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
  type PlaybookView, type PlanComment, type PlanView, type ProofIndexResponse, type ScriptToken, type TaskMessage, type TaskReader, type TaskView, type TaskWorkflow, type WorkflowArtifact,
  type DecisionsResponse, type DecisionOutcome, type LessonItem, type LessonMode, type TaskLesson,
} from "../../packages/contracts/src/code-contract-v0.js";

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
  /** Every request received, newest last (method, path, status). */
  log: Array<{ method: string; path: string; query: string; status: number }>;
}

interface Answer<K extends CodeRouteId> { status?: number; body?: CodeResponse<K> | ErrorBody; headers?: Record<string, string> }
interface Context<K extends CodeRouteId> { body: CodeRequest<K>; params: Record<string, string>; query: URLSearchParams; person: Person; token?: string }
type Handler<K extends CodeRouteId> = (context: Context<K>) => Answer<K> | Promise<Answer<K>>;
type Handlers = { [K in CodeRouteId]: Handler<K> };

const failure = (status: number, code: string, message: string): { status: number; body: ErrorBody } => ({ status, body: { error: { code, message } } });
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
  type FakeRun = { status: "none" | "running" | "ready" | "failed"; startedAt?: string; taskId?: string; stop?: "stopped_by_person" | "proposed" };
  const setupRuns = new Map<string, FakeRun>();
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
    const runRow = run.status === "none" ? { state: "needs_you" as const, status: "none" as const }
      : run.status === "running" ? { state: "running" as const, status: "running" as const, startedAt: run.startedAt, elapsedMs: 95_000, costCents: 12, commandsRun: 3 }
      : run.status === "ready" ? { state: "done" as const, status: "ready" as const, startedAt: run.startedAt, elapsedMs: 412_000, costCents: 48, commandsRun: 9, commandsFound: { setup: 2, tests: 1 }, testOutcome: "passed" as const }
      : { state: "failed" as const, status: "failed" as const, startedAt: run.startedAt, elapsedMs: 300_000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "failed" as const, ...(run.stop === undefined ? {} : { stop: run.stop }), failure: "A test command failed.", failedCommand: FAILED_COMMAND };
    const setupDone = runRow.state === "done";
    const evalRow = setupDone ? { state: "needs_you" as const, report: "reported" as const, suites: [{ selection: "npm test", questions: 3 }] } : { state: "needs_you" as const, report: "none" as const, blockedBy: "setupRun" as const };
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
    return { status: run.status, basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, ...(run.taskId === undefined ? {} : { taskId: run.taskId }), ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }), ...(run.status === "failed" ? { failure: "A test command failed.", ...(run.stop === undefined ? {} : { stop: run.stop }) } : {}), canManage: manage };
  };
  /** The hosted setup run's answer (Code #844 serves the laptop's /v1/app path), or undefined when the path is not one of its four. */
  const setupRunAnswer = (method: string, path: string, query: URLSearchParams, person: Person, body: unknown): { status: number; body: unknown } | undefined => {
    const match = /^\/v1\/app\/projects\/([^/]+)\/setup-agent(?:\/(stop|journal))?$/u.exec(path);
    if (match === null) return undefined;
    const tail = match[2];
    if (!((method === "GET" && (tail === undefined || tail === "journal")) || (method === "POST" && (tail === undefined || tail === "stop")))) return undefined;
    const name = decodeURIComponent(match[1]!), entry = project(name), grant = roleIn(person, name);
    const manage = !companyless.has(person.developerId) && (person.administrator || grant === "administrator");
    if (entry === undefined || companyless.has(person.developerId) || (!manage && grant === undefined)) return failure(404, "NOT_FOUND", "project not found");
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
  const OFFERED_MODELS = ["zai.glm-4.7", "claude-sonnet-4-5", "zai.glm-4.6"];
  let companyModel: string | undefined;
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
  const peopleListed = (entry: { owner: Person; task: TaskView }) => PEOPLE.filter((one) => one.developerId === entry.owner.developerId || peopleOf(entry.task.taskId).listed.has(one.developerId) || readers.get(entry.task.taskId)?.has(one.developerId) === true);
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
  const planOf = (task: TaskView): PlanView => ({
    taskId: task.taskId, document: "plan", version: 1, sha256: PLAN_DIGEST, approved: task.workflow?.stage !== "PLAN_REVIEW", current: true, versions: [1],
    content: { problem: `The task: ${task.title}`, approach: ["Read the code around the change", "Make the change", "Add a test that fails without it"], files: ["src/index.ts"], risks: ["Touches one shared module"] },
    summary: { headline: "One small change, one new test", checks: ["Unit tests", "Type check"] },
    estimate: "about $1.20 to $3.10, 12 to 25 minutes", runLimitUsd: 5,
    // The structured spec (UX audit 2026-11-15): stable ids that a task, a comment, a question and a proof item can point at.
    requirements: [{ id: "R1", title: "The change works and is tested", criteria: [{ id: "R1.1", when: "the change is made", then: "the new test passes", taskIds: ["T2", "T3"] }, { id: "R1.2", when: "the type check runs", then: "it reports no errors", taskIds: ["T2"] }] }],
    tasks: [{ id: "T1", title: "Read the code around the change", status: "done" }, { id: "T2", title: "Make the change", status: "running", criterionIds: ["R1.1", "R1.2"] }, { id: "T3", title: "Add a test that fails without it", status: "todo", criterionIds: ["R1.1"] }],
    questions: [{ questionId: "Q1", text: "Keep the old behaviour behind a flag?", options: [{ optionId: "yes", label: "Yes, behind a flag" }, { optionId: "no", label: "No, replace it" }], criterionId: "R1.1", defaultOptionId: "no" }],
  });

  const proofOf = (task: TaskView): ProofIndexResponse => ({
    taskId: task.taskId,
    items: [
      { sha256: "d".repeat(64), title: "Unit tests", kind: "test_report", verdict: "pass", criterionIds: ["R1.1"], commit: "c".repeat(40), stale: false },
      { sha256: "e".repeat(64), title: "Type check", kind: "check_result", verdict: "pass", criterionIds: ["R1.2"], commit: "c".repeat(40), stale: false },
      { sha256: "f".repeat(64), title: "Webhook retry eval", kind: "eval", verdict: "unknown", criterionIds: [], passed: 18, total: 20, bar: 0.95 },
    ],
  });

  // --- lessons (contract v0 `lessons.*`, Code's lessons API #713): project "web" has three proposed lessons (one from Priya's own correction, one that lapses within a
  // day), two approved and one retired; the pull-request task was given two. Priya (the project's administrator) decides; Sam reads and may ask to retire.
  let lessonsOn = true;
  /** The Cost and time report's rows and features (set by the specs through /__fake/report); none: Code does not serve the report (404), as before the report lane merges. */
  let reportData: { tasks: unknown[]; features: unknown[] } | undefined;
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
  const retireAsks = new Map<string, { by: string; at: number }>();
  const taskLessons = new Map<string, TaskLesson[]>([
    [TASK_IDS.pullRequest, [
      { stage: "IMPLEMENT", round: 1, lessonId: "les_logs00001", version: 1, why: "scope", citation: "valid", visible: true, title: "Log request ids with every error", type: "convention", helpful: 3, harmful: 1, canMark: true },
      { stage: "PLAN", round: 1, lessonId: "les_readme001", version: 1, why: "path", citation: "none", visible: true, title: "Keep the README's setup steps current", type: "convention", helpful: 0, harmful: 0, canMark: true, trial: "trial" },
      { stage: "REVIEW", round: 1, lessonId: "les_hidden001", version: 2, why: "similar", citation: "unchecked", visible: false, canMark: false },
    ]],
  ]);
  const notHelpful = new Set<string>();
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
      const ordinary = () => ({ body: { tasks: [...tasks.values()].filter((entry) => entry.owner.developerId === person.developerId || readers.get(entry.task.taskId)?.has(person.developerId) === true).map((entry) => entry.task).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) } });
      if (query.get("involved") !== "1" || involvedMode === "old") return ordinary();
      if (involvedMode !== "on") return failure(Number(involvedMode), involvedMode === "500" ? "RUNTIME_UNAVAILABLE" : involvedMode === "400" ? "CONFIG_INVALID" : "NOT_FOUND", "involved is not served here");
      return { body: { involved: true, tasks: [...tasks.values()].filter((entry) => involved.get(entry.task.taskId)?.has(person.developerId) === true && entry.owner.developerId !== person.developerId).map((entry) => entry.task).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) } as never };
    },
    "tasks.get": (context) => taskOr404(context, ({ task }) => ({ body: { task } })),
    "tasks.events": (context) => taskOr404(context, ({ task }) => ({ body: { events: [{ seq: 1, at: task.createdAt, kind: "status", text: "Task started" }, { seq: 2, at: task.updatedAt, kind: "progress", text: `Now at ${task.workflow?.stage ?? "start"}`, taskItemId: "T2", attempt: 1 }] } })),
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
      for (const [key, value] of Object.entries({ client_id: "fakelinearclient", redirect_uri: linearRedirectUri, response_type: "code", scope: "read,comments:create,issues:create", state, actor: "app", prompt: "consent", code_challenge: "c".repeat(43), code_challenge_method: "S256" })) authorize.searchParams.set(key, value);
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
    "scriptTokens.list": ({ person }) => ({ body: { tokens: scriptTokens.get(person.developerId) ?? [] } }),
    "scriptTokens.create": ({ body, person }) => {
      if (body.label.trim() === "") return failure(400, "CONFIG_INVALID", "Name the token.");
      const token: ScriptToken = { tokenId: randomUUID(), label: body.label.trim(), createdAt: iso() };
      scriptTokens.set(person.developerId, [...(scriptTokens.get(person.developerId) ?? []), token]);
      return { status: 201, body: { token, secret: `fake-script-${randomBytes(8).toString("hex")}` } };
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
    "lessons.mode.get": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      return { body: { project: found.name, mode: lessonMode, effective: lessonMode, lockedByCompany: false, canChange: found.decides } };
    },
    "lessons.mode.put": (context) => {
      const found = lessonsProject(context);
      if ("refused" in found) return found.refused;
      if (!found.decides) return failure(403, "FORBIDDEN", "Only an admin of this project, or an owner or admin of the company, can change its learning mode.");
      if (!["off", "suggest", "auto"].includes(context.body.mode)) return failure(400, "CONFIG_INVALID", "the mode is off, suggest or auto");
      lessonMode = context.body.mode;
      return { body: { project: found.name, mode: lessonMode, effective: lessonMode, lockedByCompany: false, canChange: true } };
    },
    // Any member reads; an owner or admin sets a model from the offered list.
    "company.engineModel.get": ({ person }) => (companyless.has(person.developerId) ? failure(401, "AUTH_REQUIRED", "sign in again") : { body: engineView() }),
    "company.engineModel.put": ({ person, body }) => {
      if (companyless.has(person.developerId)) return failure(401, "AUTH_REQUIRED", "sign in again");
      if (!person.administrator) return failure(403, "FORBIDDEN", "Only a company owner or admin can change the company's AI model.");
      if (body.model !== null && !OFFERED_MODELS.includes(body.model)) return failure(400, "CONFIG_INVALID", "That model isn't offered to this company now. Pick one from the list.");
      companyModel = body.model ?? undefined;
      return { body: engineView() };
    },
    // Members of the project read; its administrator changes (revision-checked). The pretend Code sets no step-up, so it checks none here.
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
      const list = scriptTokens.get(person.developerId) ?? [];
      const next = list.filter((entry) => entry.tokenId !== params["tokenId"]);
      scriptTokens.set(person.developerId, next);
      return { body: { revoked: next.length !== list.length } };
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
        if (method === "POST" && url.pathname === "/__fake/lessons") {
          const on = (JSON.parse(await readBody(request)) as { on?: unknown }).on;
          if (typeof on !== "boolean") return send(400, { error: { code: "CONFIG_INVALID", message: "on is true or false" } });
          lessonsOn = on;
          return send(200, { on });
        }
        if (method === "POST" && url.pathname === "/__fake/report") {
          const given = JSON.parse(await readBody(request)) as { reset?: unknown; tasks?: unknown; features?: unknown };
          if (given.reset === true) { reportData = undefined; return send(200, { served: false }); }
          if (!Array.isArray(given.tasks) || !Array.isArray(given.features)) return send(400, { error: { code: "CONFIG_INVALID", message: "tasks and features are lists, or reset is true" } });
          reportData = { tasks: given.tasks, features: given.features };
          return send(200, { served: true, tasks: given.tasks.length });
        }
        // The Cost and time report's two reads (design A5): company owners and admins only, rows oldest first, 200 a page by a numeric cursor.
        if (method === "GET" && (url.pathname === "/v1/dev/company/report/tasks" || url.pathname === "/v1/dev/company/report/features")) {
          const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
          const who = bearer === undefined ? undefined : access.get(bearer);
          if (who === undefined) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (reportData === undefined) return send(404, { error: { code: "NOT_FOUND", message: "route not found" } });
          if (!who.administrator) return send(403, { error: { code: "FORBIDDEN", message: "only a company owner or admin" } });
          if (url.pathname.endsWith("/features")) return send(200, { features: reportData.features });
          const size = 200, start = Number(url.searchParams.get("cursor") ?? "0");
          return send(200, { tasks: reportData.tasks.slice(start, start + size), ...(start + size < reportData.tasks.length ? { next: String(start + size) } : {}) });
        }
        const raw = await readBody(request);
        if (method === "POST" && url.pathname === "/v1/auth/token") {
          const answer = tokenEndpoint(new URLSearchParams(raw), request.headers.authorization);
          return send(answer.status, answer.body);
        }
        if (method === "POST" && url.pathname === "/__fake/setup-run") {
          const given = JSON.parse(raw) as { project?: unknown; status?: unknown };
          if (typeof given.project !== "string" || project(given.project) === undefined || !["none", "running", "ready", "failed"].includes(given.status as string)) return send(400, { error: { code: "CONFIG_INVALID", message: "project and status" } });
          const status = given.status as FakeRun["status"];
          setupRuns.set(given.project, status === "none" ? { status } : { status, startedAt: iso(), taskId: randomUUID() });
          setupSkips.delete(given.project);
          return send(200, { status });
        }
        if (url.pathname.startsWith("/v1/app/projects/")) {
          const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
          const who = bearer === undefined ? undefined : access.get(bearer);
          let parsed: unknown = {};
          if (raw !== "") { try { parsed = JSON.parse(raw); } catch { return send(400, { error: { code: "CONFIG_INVALID", message: "the request body is not JSON" } }); } }
          const answer = who === undefined ? undefined : setupRunAnswer(method, url.pathname, url.searchParams, who, parsed);
          if (who === undefined && /\/setup-agent(?:\/(?:stop|journal))?$/u.test(url.pathname)) return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in again." } });
          if (answer !== undefined) return send(answer.status, answer.body);
        }
        const matched = matchCodeRoute(method, url.pathname);
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
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); server.closeAllConnections(); }),
  };
}
