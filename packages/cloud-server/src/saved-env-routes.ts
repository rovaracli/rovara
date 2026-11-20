import { parsePreviewRequestV2, parsePreviewV2, restrictPreviewV2 } from "./start-estimates.js";
// L4-MF1 (lead 4, missing Code features the Cloud website calls): two reads of the project page that had no route at all and answered 501 NOT_ON_CODE_YET.
//
//   GET  /v1/app/projects/{p}/environment-image -> Code GET /v1/app/projects/{p}/environment-image  (SavedEnvPanelSchema, contracts app-saved-env.ts), as the person
//   GET  /v1/app/projects/{p}/test-environment  -> Code GET /v1/app/projects/{p}/test-environment (core-host dev-routes.ts, DEC 254z-amend3), as the person, read below
//   POST /v1/app/projects/{p}/test-environment/approve -> Code POST .../test-environment/approve { requestId, revision, artifactDigest } (Code #1045 item 4), as the person, below
//   POST /v1/app/projects/{p}/start-preview     -> answered here: 200 { orgId, project, kind: "unknown" }                       (TaskStopStartPreviewSchema)
//
// The saved environment image read (Code PR "l4-env-image-read"): Code decides who may read, from the person's live project grant in their company, and answers
// one 404 "project not found" for a project they may not read, another company's project and a missing one alike. With saved environments off for the install
// (hosted today: no image registry) Code answers a plain 404 "Saved environments are off for this install", never made-up data; the panel shows nothing for it,
// as its own file says. Reset and the setting are NOT forwarded (Code serves neither on the deployed API; its panel answers canReset false).
//
// Rules for the read:
//   - Cloud adds no rule of its own that could widen Code's: no company, person or role check here, no fallback, no cached answer. It only refuses earlier, in fixed
//     words, a project name Code would never take. The browser's query never reaches Code; the project name goes only into Code's path.
//   - The answer is rebuilt from the panel's known fields only, each checked (fixed words for the health, the reasons and the failure; times as ISO times; whole
//     numbers), and it is refused whole when anything is off ("unreadable is refusal"). It carries no digest, repository, command, secret or free text.
//   - Until Code serves the route (an older Code's unknown-route 404 "route not found", the core host's "not on the core engine on this install yet" 404, or a 501) the
//     app gets 501 NOT_ON_CODE_YET in Cloud's fixed words. Code's "off" and "project not found" 404s reach the app as 404 in the same fixed words.
//
// Start preview (advisory, never a reservation): Rovara Code keeps no per-task spending stop (its calculator has no stored company default, ceiling, project or agent
// stop), and the budget engine and its caps stay Cloud's, so Cloud answers `unknown` until it computes the stop from its own spend settings. The page shows that
// plainly. Only a person who may use the project (Code's access check, made now, names it) gets an answer: any other project is the one 404; the company in the answer
// is the one Code's access check names, never the browser's. The body is `{}` (a request id and a path word are accepted, nothing else).
// cloud-server takes no package dependency, so the shapes are checked here by hand against contracts app-saved-env.ts (a unit test pins the words).
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import { companyCaller, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

/** Code's project name pattern on this route (core-host dev-routes.ts SAVED_ENV_IMAGE). */
const CODE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** Cloud's own project name pattern (the start preview is answered from the person's project list). */
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** Code's fixed 404 words for these two answers (core-host dev-routes.ts SAVED_ENV_OFF, PROJECT_NOT_FOUND). */
const CODE_SAVED_ENV_OFF = "Saved environments are off for this install";
const CODE_PROJECT_NOT_FOUND = "project not found";

export const SAVED_ENV_REBUILD_REASONS = Object.freeze(["no_image", "key_changed", "max_age", "stale", "reset"] as const);
export const SAVED_ENV_FAILURES = Object.freeze([
  "not_proved", "not_approved", "not_fresh", "not_default_branch", "secrets_found", "unsafe_tree", "no_push_session", "build_failed", "push_failed", "digest_mismatch", "base_not_pinned", "prove_failed", "fresh_sandbox_failed",
  "wrong_commits", "wrong_manifest", "wrong_repository", "repository_mismatch", "failed",
] as const);
/** The top-level fields of SavedEnvPanelSchema. */
export const SAVED_ENV_PANEL_FIELDS = Object.freeze(["health", "image", "rebuild", "lastRebuildReason", "lastFailure", "canReset", "enabled", "canChangeSetting"] as const);

const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const SAVED_ENV_ANSWERS = Object.freeze({
  off: answer(404, "NOT_FOUND", CODE_SAVED_ENV_OFF),
  notFound: answer(404, "NOT_FOUND", CODE_PROJECT_NOT_FOUND),
  notYet: answer(501, "NOT_ON_CODE_YET", "Saved environments aren't available on this Rovara yet."),
  unreadable: answer(502, "RUNTIME_UNAVAILABLE", "The saved environment could not be read just now. Try again."),
  invalid: answer(400, "CONFIG_INVALID", "the request is not valid"),
  projectNotFound: answer(404, "PROJECT_NOT_FOUND", "That project doesn't exist, or you can't use it."),
});
const A = SAVED_ENV_ANSWERS;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const oneOf = (value: unknown, words: readonly string[]): boolean => typeof value === "string" && words.includes(value);
const when = (value: unknown): boolean => typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
const exactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

/** Code's panel, kept to its own fields, or undefined when anything does not read. Never a part of it. */
export function savedEnvPanel(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  // Unknown fields are refused whole (not dropped): a newer Code's change is read when this file is, never half-shown.
  if (!exactly(raw, SAVED_ENV_PANEL_FIELDS)) return undefined;
  if (!oneOf(raw["health"], ["never_proved", "healthy", "needs_repair"]) || typeof raw["canReset"] !== "boolean") return undefined;
  if (raw["enabled"] !== undefined && typeof raw["enabled"] !== "boolean") return undefined;
  if (raw["canChangeSetting"] !== undefined && typeof raw["canChangeSetting"] !== "boolean") return undefined;
  const image = raw["image"], rebuild = raw["rebuild"], failure = raw["lastFailure"];
  if (image !== undefined && !(isRecord(image) && exactly(image, ["builtAt", "ageDays", "status"]) && when(image["builtAt"]) && Number.isSafeInteger(image["ageDays"]) && (image["ageDays"] as number) >= 0 && oneOf(image["status"], ["ready", "stale"]))) return undefined;
  if (rebuild !== undefined && !(isRecord(rebuild) && exactly(rebuild, ["state", "reason"]) && oneOf(rebuild["state"], ["queued", "running"]) && oneOf(rebuild["reason"], SAVED_ENV_REBUILD_REASONS))) return undefined;
  if (raw["lastRebuildReason"] !== undefined && !oneOf(raw["lastRebuildReason"], SAVED_ENV_REBUILD_REASONS)) return undefined;
  if (failure !== undefined && !(isRecord(failure) && exactly(failure, ["at", "reason"]) && when(failure["at"]) && oneOf(failure["reason"], SAVED_ENV_FAILURES))) return undefined;
  return Object.fromEntries(SAVED_ENV_PANEL_FIELDS.filter((field) => raw[field] !== undefined).map((field) => [field, raw[field]]));
}

/** Code's 404 messages that mean "this Code does not serve the route yet" (an older Code's unknown route, the core host's "not on the core engine on this install yet"). */
const CODE_NOT_YET: ReadonlySet<string> = new Set(["route not found", "That is not on the core engine on this install yet."]);
function notYetFromCode(error: CodeError): boolean {
  if (error.status === 501) return true;
  if (error.status !== 404) return false;
  const said = codeMessage(error);
  return said !== undefined && said.code === "NOT_FOUND" && typeof said.message === "string" && CODE_NOT_YET.has(said.message);
}

/** Code's body for a CodeError, if it is the standard `{ error: { code, message } }`. */
function codeMessage(error: CodeError): { code: unknown; message: unknown } | undefined {
  const body = isRecord(error.body) && isRecord(error.body["error"]) ? error.body["error"] : undefined;
  return body === undefined ? undefined : { code: body["code"], message: body["message"] };
}

// ---- The test environment read and approve (DEC 254z-amend3; Code #1045 item 4) ----
// Code's hosted answer is the laptop's own state view (core/test-env/local-view.ts TestEnvironmentView): `{ project, enabled, testServices, testServicesUnavailable?, approved?, proposal?,
// serviceCatalog? }`. Since Code #1045 the proposal that waits also carries its whole proposed body (`proposal.environment`, read back for exactly its digest), with `nextRevision`
// (the revision approving it makes), `risk`, `lessSafe`, `changes` (Code's own "where: before -> after" lines) and `proved`. The app's onboarding section reads Cloud's
// TestEnvironmentState (contracts test-environment-wire.ts), so Cloud builds it from that:
//   - the proposal: its digest, risk, less-safe flags, whether it is proved, its body and a summary counted from the body; Code's change lines are the section's notes. Code's hosted
//     read names no commands as run lines, prove steps or value sources, so none are shown. Approving it needs no step-up (owner DEC 254zzz73: `needs.freshSignIn` is
//     always false), and who may approve is Code's risk rule (no second-person card on the hosted Code).
//   - a proposal without a body that reads (an older Code, or one that could not be read back) is not offered for approval: a fixed line says one waits, as before.
//   - an approved revision is a fixed line (Code's hosted read carries no approved body to show).
// Approve (`POST .../test-environment/approve`, the app's `{ digest, expectedRevision, requestId }`) is forwarded as Code's `{ requestId, revision: proposal.nextRevision, artifactDigest:
// proposal.digest }`, only when the proposal Code holds NOW is the one the person saw (the same digest, and the approved revision they saw is the one before `nextRevision`); otherwise
// nothing is sent and the answer says it changed. Code decides who may approve; its refusals become fixed words.
// With the feature off (`enabled: false`) the app gets Code's 404 words and shows nothing.
export const TEST_ENVIRONMENT_WORDS = Object.freeze({
  off: "The test environment is off for this install.",
  approved: (revision: number) => `An approved test environment is in place (revision ${String(revision)}).`,
  proposal: "A proposed test environment is waiting for review in Rovara Code.",
  notYet: "The test environment isn't available on this Rovara yet.",
  unreadable: "The test environment could not be read just now. Try again.",
  approveNotYet: "Approving the test environment isn't available on this Rovara yet.",
  stale: "It changed while you were looking. Open it again.",
  notAllowed: "Only a company admin, or the project's maintainer for a low or medium risk change, can approve this test environment.",
  approvedRefresh: "The test environment was approved. Refresh to see it.",
});
/** Code's four fixed "not available here" sentences (core/test-env/test-services-switch.ts TEST_SERVICES_UNAVAILABLE_WORDS); only an exact one is said. */
const TEST_SERVICES_UNAVAILABLE: ReadonlySet<string> = new Set([
  "Test services not available here: this install's workers cannot start them yet",
  "Test services not available here: this computer already uses addresses in 172.30.0.0/16, where test runs put their networks",
  "Test services not available here: no service image can be used on this install",
  "Test services not available here: something they need is missing on this install",
]);
const TEST_ENVIRONMENT_FIELDS = ["project", "enabled", "testServices", "testServicesUnavailable", "approved", "proposal", "serviceCatalog"] as const;
const PROPOSAL_FIELDS = ["digest", "proposedAt", "risk", "lessSafe", "changes", "proved", "nextRevision", "expiresAt", "environment"] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
/** One plain line, as the app's contract reads one (no control or format characters). */
const LINE_OK = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max && LINE_OK.test(value);
const CHANGE_LINES_SHOWN = 60;
const REPOSITORIES_MAX = 16;
const CHECKS_MAX = 32;
const DEPENDENCIES_MAX = 64;

/** The proposed body's summary (contracts testEnvSummaryOf), or undefined when the body does not read as a test environment. The body itself is passed on unchanged. */
function summaryOf(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !oneOf(body["tier"], ["sandbox", "preview", "shared"]) || !Array.isArray(body["repos"]) || body["repos"].length > REPOSITORIES_MAX) return undefined;
  const selection = body["selection"], nightly = body["nightly"], services = body["services"], dependencies = body["dependencies"];
  if (!isRecord(selection) || !line(selection["method"], 40) || !Number.isSafeInteger(body["roundBudgetMin"])) return undefined;
  if (!isRecord(nightly) || typeof nightly["enabled"] !== "boolean" || !line(nightly["cronUtc"], 64) || !line(nightly["branch"], 255) || !Array.isArray(services)) return undefined;
  if (dependencies !== undefined && !(Array.isArray(dependencies) && dependencies.length <= DEPENDENCIES_MAX && dependencies.every(isRecord))) return undefined;
  const repositories: Array<Record<string, unknown>> = [];
  for (const repo of body["repos"] as unknown[]) {
    if (!isRecord(repo) || !line(repo["repositoryId"], 200) || !Array.isArray(repo["setupCommands"]) || !Array.isArray(repo["checks"]) || repo["checks"].length > CHECKS_MAX) return undefined;
    const checks: Array<Record<string, unknown>> = [];
    for (const check of repo["checks"] as unknown[]) {
      if (!isRecord(check) || !line(check["id"], 64) || !line(check["label"], 80) || !line(check["kind"], 40)) return undefined;
      const selectArgs = check["selectArgs"];
      if (selectArgs !== undefined && !(Array.isArray(selectArgs) && selectArgs.length <= 8 && selectArgs.every((arg) => typeof arg === "string" && arg.length >= 1 && arg.length <= 256))) return undefined;
      checks.push({ id: check["id"], label: check["label"], kind: check["kind"], ...(selectArgs === undefined ? {} : { selectArgs }) });
    }
    repositories.push({ repositoryId: repo["repositoryId"], setupCommands: repo["setupCommands"].length, checks });
  }
  // What Rovara starts, counted as contracts testEnvStartedCount counts it: one each for local, project-image and fake backings, one shared emulator, one test-account helper.
  const kinds = (dependencies ?? []).map((dependency) => (isRecord(dependency["backing"]) ? dependency["backing"]["kind"] : undefined));
  const started = kinds.filter((kind) => kind === "local" || kind === "project_image" || kind === "fake").length + (kinds.includes("emulated") ? 1 : 0) + (kinds.includes("test_account") ? 1 : 0);
  return {
    tier: body["tier"], repositories, selectionMethod: selection["method"], roundBudgetMin: body["roundBudgetMin"],
    nightly: { enabled: nightly["enabled"], cronUtc: nightly["cronUtc"], branch: nightly["branch"] }, services: services.length,
    ...(dependencies === undefined || (dependencies as unknown[]).length === 0 ? {} : { dependencies: { count: (dependencies as unknown[]).length, started } }),
  };
}

/** Code's proposal that waits, as the app's proposal (with what approving it must name); undefined when it carries no body that reads; "unreadable" for a malformed proposal (the read is refused whole). */
function proposalOf(proposal: Record<string, unknown>): { view: Record<string, unknown>; changes: string[]; nextRevision: number; digest: string } | undefined | "unreadable" {
  if (!exactly(proposal, PROPOSAL_FIELDS) || typeof proposal["digest"] !== "string" || !SHA256.test(proposal["digest"]) || !oneOf(proposal["risk"], ["low", "medium", "high"])) return "unreadable";
  if (!Number.isSafeInteger(proposal["nextRevision"]) || (proposal["nextRevision"] as number) < 1 || typeof proposal["proved"] !== "boolean") return "unreadable";
  const lessSafe = proposal["lessSafe"], changes = proposal["changes"];
  if (!Array.isArray(lessSafe) || lessSafe.length > 20 || !lessSafe.every((flag) => line(flag, 60))) return "unreadable";
  if (changes !== undefined && !Array.isArray(changes)) return "unreadable";
  const summary = summaryOf(proposal["environment"]);
  if (summary === undefined) return undefined;
  const digest = proposal["digest"];
  return {
    digest, nextRevision: proposal["nextRevision"] as number,
    // Code's own change lines (one plain line each, `shownLine`); a line that does not read as one is left out, never cut.
    changes: ((changes ?? []) as unknown[]).filter((change): change is string => line(change, 400)).slice(0, CHANGE_LINES_SHOWN),
    view: {
      digest, source: "setup", risk: proposal["risk"], lessSafe, summary, environment: proposal["environment"], runs: [], valueSources: [], proved: proposal["proved"], proveSteps: [],
      needs: { freshSignIn: false, secondPerson: false }, approval: { status: "none" }, commandsNotInSettings: 0, check: { status: proposal["proved"] === true ? "ready" : "unchecked" },
    },
  };
}

/** Code's hosted test environment view as Cloud's TestEnvironmentState, or undefined when it does not read (refused whole). `off` when Code says the feature is off. */
export function testEnvironmentState(raw: unknown, project: string): Record<string, unknown> | "off" | undefined {
  return testEnvironmentRead(raw, project)?.state;
}

/** The state, and the proposal Code holds now (what an approval must name), from Code's read. */
function testEnvironmentRead(raw: unknown, project: string): { state: Record<string, unknown> | "off"; proposal?: { digest: string; nextRevision: number } } | undefined {
  if (!isRecord(raw) || !exactly(raw, TEST_ENVIRONMENT_FIELDS) || raw["project"] !== project || typeof raw["enabled"] !== "boolean" || typeof raw["testServices"] !== "boolean") return undefined;
  const unavailable = raw["testServicesUnavailable"], approved = raw["approved"], proposal = raw["proposal"];
  if (unavailable !== undefined && !(typeof unavailable === "string" && TEST_SERVICES_UNAVAILABLE.has(unavailable))) return undefined;
  if (approved !== undefined && !(isRecord(approved) && Number.isSafeInteger(approved["revision"]) && (approved["revision"] as number) >= 1)) return undefined;
  if (proposal !== undefined && !isRecord(proposal)) return undefined;
  if (!raw["enabled"]) return { state: "off" };
  const waiting = proposal === undefined ? undefined : proposalOf(proposal);
  if (waiting === "unreadable") return undefined;
  const notes = [
    ...(approved === undefined ? [] : [TEST_ENVIRONMENT_WORDS.approved(approved["revision"] as number)]),
    ...(proposal === undefined ? [] : waiting === undefined ? [TEST_ENVIRONMENT_WORDS.proposal] : waiting.changes),
    ...(unavailable === undefined ? [] : [unavailable]),
  ].slice(0, CHANGE_LINES_SHOWN);
  return {
    state: { draft: { status: "none", notes, questions: [], pendingServices: [] }, ...(waiting === undefined ? {} : { proposal: waiting.view }) },
    ...(waiting === undefined ? {} : { proposal: { digest: waiting.digest, nextRevision: waiting.nextRevision } }),
  };
}

/** Code's request id rule on its approve route (core-host dev-routes.ts ApproveTestEnvironmentBodySchema). */
const APPROVE_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u;
/** The app's approve body (contracts TestEnvApproveBodySchema), checked here: exactly these keys. */
function approveBody(value: unknown): { digest: string; expectedRevision: number; requestId: string } | undefined {
  if (!isRecord(value) || !exactly(value, ["digest", "expectedRevision", "requestId"])) return undefined;
  const { digest, expectedRevision, requestId } = value;
  if (typeof digest !== "string" || !SHA256.test(digest) || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0 || typeof requestId !== "string" || !APPROVE_REQUEST_ID.test(requestId)) return undefined;
  return { digest, expectedRevision: expectedRevision as number, requestId };
}

/** Code's test environment read for the project, as Cloud reads it, or the answer to give instead. */
async function readTestEnvironment(client: RouteContext["client"], session: RouteContext["session"], project: string): Promise<{ read: NonNullable<ReturnType<typeof testEnvironmentRead>> } | { answer: RouteAnswer }> {
  let raw: unknown;
  try {
    raw = await client.json<unknown>(session, `/v1/app/projects/${encodeURIComponent(project)}/test-environment`);
  } catch (error) {
    if (error instanceof CodeError) {
      if (notYetFromCode(error)) return { answer: answer(501, "NOT_ON_CODE_YET", TEST_ENVIRONMENT_WORDS.notYet) };
      // Code's own 404 (a project the person may not read, or a missing one, alike) reads as a missing project.
      if (error.status === 404) return { answer: A.notFound };
    }
    throw error;
  }
  const read = testEnvironmentRead(raw, project);
  if (read === undefined) return { answer: answer(502, "INVALID_RESPONSE", TEST_ENVIRONMENT_WORDS.unreadable) };
  if (read.state === "off") return { answer: answer(404, "NOT_FOUND", TEST_ENVIRONMENT_WORDS.off) };
  return { read };
}

export const SAVED_ENV_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/test-environment$/u,
    answer: async ({ client, session, params }) => {
      const project = params[0]!;
      if (!CODE_PROJECT_NAME.test(project)) return A.notFound;
      const found = await readTestEnvironment(client, session, project);
      return "answer" in found ? found.answer : { status: 200, body: found.read.state };
    },
  },
  {
    // The app's Approve: forwarded only for the proposal Code holds now, exactly as the person saw it (see above). Code checks who may approve.
    method: "POST", path: /^\/projects\/([^/]+)\/test-environment\/approve$/u,
    answer: async ({ client, session, params, body }) => {
      const project = params[0]!;
      if (!CODE_PROJECT_NAME.test(project)) return A.notFound;
      const asked = approveBody(body);
      if (asked === undefined) return A.invalid;
      const found = await readTestEnvironment(client, session, project);
      if ("answer" in found) return found.answer;
      const waiting = found.read.proposal;
      // Not the proposal the person saw (another digest, none, or the approved revision moved on): nothing is sent.
      if (waiting === undefined || waiting.digest !== asked.digest || waiting.nextRevision !== asked.expectedRevision + 1) return answer(409, "CHANGE_STALE", TEST_ENVIRONMENT_WORDS.stale);
      try {
        await client.json<unknown>(session, `/v1/app/projects/${encodeURIComponent(project)}/test-environment/approve`, { method: "POST", body: { requestId: asked.requestId, revision: waiting.nextRevision, artifactDigest: waiting.digest } });
      } catch (error) {
        if (!(error instanceof CodeError)) throw error;
        if (notYetFromCode(error)) return answer(501, "NOT_ON_CODE_YET", TEST_ENVIRONMENT_WORDS.approveNotYet);
        if (error.status === 403) return answer(403, "FORBIDDEN", TEST_ENVIRONMENT_WORDS.notAllowed);
        if (error.status === 409) return answer(409, "CHANGE_STALE", TEST_ENVIRONMENT_WORDS.stale);
        if (error.status === 404) return A.notFound;
        throw error;
      }
      // Approved: the state as Code reads it now (a read that fails still says it was approved).
      const after = await readTestEnvironment(client, session, project).catch(() => undefined);
      const state = after !== undefined && !("answer" in after) ? after.read.state : { draft: { status: "none", notes: [TEST_ENVIRONMENT_WORDS.approvedRefresh], questions: [], pendingServices: [] } };
      return { status: 200, body: { revision: waiting.nextRevision, digest: waiting.digest, replayed: false, state } };
    },
  },
  {
    method: "GET", path: /^\/projects\/([^/]+)\/environment-image$/u,
    answer: async ({ client, session, params }) => {
      const project = params[0]!;
      if (!CODE_PROJECT_NAME.test(project)) return A.notFound;
      let raw: unknown;
      try {
        raw = await client.json<unknown>(session, `/v1/app/projects/${encodeURIComponent(project)}/environment-image`);
      } catch (error) {
        if (error instanceof CodeError) {
          if (notYetFromCode(error)) return A.notYet;
          const said = error.status === 404 ? codeMessage(error) : undefined;
          // Code's own two 404s, in Cloud's fixed words (the same words); any other 404 reads as a missing project.
          if (said !== undefined && said.code === "NOT_FOUND" && said.message === CODE_SAVED_ENV_OFF) return A.off;
          if (error.status === 404) return A.notFound;
        }
        throw error;
      }
      const panel = savedEnvPanel(raw);
      return panel === undefined ? A.unreadable : { status: 200, body: panel };
    },
  },
  {
    method: "POST", path: /^\/projects\/([^/]+)\/start-preview$/u,
    answer: async (context) => {
      const project = context.params[0]!;
      if (!PROJECT_NAME.test(project)) return A.projectNotFound;
      const body = context.body === undefined || context.body === null ? {} : context.body;
      const v2 = isRecord(body) && body["quoteVersion"] === 2 ? parsePreviewRequestV2(body) : undefined;
      if (v2 === undefined && (!isRecord(body) || !exactly(body, ["requestId", "path"]) || (body["requestId"] !== undefined && !(typeof body["requestId"] === "string" && UUID.test(body["requestId"]))) || (body["path"] !== undefined && !oneOf(body["path"], ["QUICK", "FULL"])))) return A.invalid;
      const who = await companyCaller(context);
      if (refused(who)) return who;
      // Only a project the person may use (their project list, from Code's access check made now); anything else is the one 404.
      if (!who.access.projects.some((one) => one.name === project)) return A.projectNotFound;
      if (v2 !== undefined) {
        try {
          const raw = await context.client.json<unknown>(context.session, `/v1/dev/projects/${encodeURIComponent(project)}/start-estimates`, { method: "POST", body: v2 });
          const quote = parsePreviewV2(raw);
          if (quote === undefined || quote.orgId !== who.companyId || quote.project !== project || Date.parse(quote.expiresAt) <= context.now().getTime() || Date.parse(quote.asOf) > context.now().getTime()) return answer(502, "RUNTIME_UNAVAILABLE", "The cost comparison could not be read just now.");
          return { status: 200, body: who.companyRole === "owner" || who.companyRole === "admin" ? quote : restrictPreviewV2(quote) };
        } catch (error) {
          if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
          if (error instanceof CodeError && error.status === 404 && !notYetFromCode(error)) return A.projectNotFound;
          return answer(502, "RUNTIME_UNAVAILABLE", "The cost comparison is unavailable. It does not reserve money or authorize spending.");
        }
      }
      return { status: 200, body: { orgId: who.companyId, project, kind: "unknown" } };
    },
  },
];
