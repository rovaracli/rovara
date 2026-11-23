// Guided onboarding PR 9 (design section 1 "Project setup checklist"; DEC 254j, 254k, 254l, 254n item 3, 254o c): the project checklist's read, its "Set up
// later" change and the hosted setup run, answered from Rovara Code as the signed-in person, with their own token.
//
//   GET  /v1/app/projects/{p}/setup-status              -> Code GET  /v1/dev/client/projects/{p}/setup-status          (#841; any member of the company)
//   PUT  /v1/app/projects/{p}/setup-status/skips        -> Code PUT  /v1/dev/client/projects/{p}/setup-status/skips    (#841; owner/admin or project admin)
//   PUT  /v1/app/projects/{p}/setup-status/eval-none    -> Code PUT  /v1/dev/client/projects/{p}/setup-status/eval-none (L2-5 c; the same people: "this project runs no evals")
//   GET  /v1/app/projects/{p}/setup-agent               -> Code GET  /v1/app/projects/{p}/setup-agent                  (#844; owner/admin or project admin manage, a project user reads)
//   POST /v1/app/projects/{p}/setup-agent   {requestId} -> Code POST /v1/app/projects/{p}/setup-agent                  (start, or Re-run setup: a re-run only proposes)
//   POST /v1/app/projects/{p}/setup-agent/stop {requestId} -> Code POST .../setup-agent/stop
//   GET  /v1/app/projects/{p}/setup-agent/journal?after=n  -> Code GET .../setup-agent/journal?after=n
//   POST /v1/app/projects/{p}/setup-agent/confirm {requestId, expectedRevision, itemIds?} -> Code POST .../setup-agent/confirm  ("Use this setup": a candidate and its check; L4-D, Code #899)
//   POST /v1/app/projects/{p}/setup-agent/discard {requestId}                              -> Code POST .../setup-agent/discard  (drop the waiting candidate)
//   POST /v1/app/projects/{p}/setup-agent/decide {requestId, outcome, seen, reason?}       -> Code POST .../setup-agent/decide   (approve or reject: Code's risk-based approver rule)
//   POST /v1/app/projects/{p}/setup-agent/host-decide {requestId, host, outcome, seen, reason?} -> Code POST .../setup-agent/host-decide (allow or refuse a website a setup run asked for: Code's rule is a live company owner or admin; Cloud adds none)
//   The setup-run read also carries Code's `apply` (the waiting candidate: risk, changes, who approves, the check, the approval binding), rebuilt field by field (L4-D2).
//
// Rules:
//   - Code decides who may read and change (its live company role and project grant). Cloud adds no rule that could widen that; it only refuses earlier:
//     a person Code names no company for gets NOT_IN_COMPANY, a malformed project name "project not found", a malformed body or query 400, without asking Code.
//   - The browser never names a company. The project name goes only into Code's path; a body is rebuilt from its checked fields only (strict).
//   - Code's checklist answer is rebuilt field by field (bounded strings, known words, this project only); anything else is "couldn't be read". Code's setup-run answers
//     (Code's core SetupAgentView and journal, for a person Code allowed) are passed on whole, only as a plain object whose status is a known word, `canManage` a
//     boolean and the journal's lists within Code's bounds; the app reads every field it uses with its own SetupAgentView/SetupJournalReply readers.
//   - Code's refusals reach the app as Cloud's fixed sentences (SETUP_CHECKLIST_WORDS, the same as @agentx/contracts), never Code's or the browser's text. Until Code
//     serves a route, its fixed unknown-route 404 reads "isn't available on this Rovara yet" (501 NOT_ON_CODE_YET).
// cloud-server takes no package dependency, so the shapes are checked here by hand against Code's contract (project-setup-status.ts on #841, setup-run-routes.ts on #844).
import { isCodeOutcomeUnknown, CodeError, SignInEnded } from "./code-client.js";
import { agentAiConnected } from "./agent-ai-presence.js";
import { companyCaller, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const SETUP_CHECKLIST_WORDS = Object.freeze({
  notFound: "project not found",
  skipNotAllowed: "Only company owners and admins, or this project's admins, can set a row aside.",
  runNotAllowed: "Only company owners and admins, or this project's admins, can run the project's setup.",
  invalid: "the request is not valid",
  stale: "The project changed. Look again, then try once more.",
  busy: "A setup run is already going for this project. Wait for it to finish, or stop it first.",
  runUnavailable: "Setting a project up with Rovara isn't available for this company yet.",
  notYet: "The setup checklist isn't available on this Rovara yet.",
  runNotYet: "Setting up with Rovara isn't available on this Rovara yet.",
  unavailable: "The project's setup couldn't be read just now. Try again.",
});
const W = SETUP_CHECKLIST_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const SETUP_CHECKLIST_ANSWERS = Object.freeze({
  notFound: answer(404, "NOT_FOUND", W.notFound),
  skipNotAllowed: answer(403, "FORBIDDEN", W.skipNotAllowed),
  runNotAllowed: answer(403, "FORBIDDEN", W.runNotAllowed),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  stale: answer(409, "CHANGE_STALE", W.stale),
  busy: answer(409, "WORKSPACE_BUSY", W.busy),
  runUnavailable: answer(503, "SETUP_RUN_NOT_AVAILABLE", W.runUnavailable),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  runNotYet: answer(501, "NOT_ON_CODE_YET", W.runNotYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
});
const A = SETUP_CHECKLIST_ANSWERS;

/** Code's project names (AGENTX_NAME_PATTERN; a company-named project's id is the name plus a short suffix, which fits). */
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const ROW_STATES = ["done", "needs_you", "running", "optional", "skipped", "failed"] as const;
const ROWS = ["repos", "setupRun", "evalConfirm", "aiAndSpend", "slackChannel", "linear", "invites", "firstTask"] as const;
const SKIPPABLE = ["slackChannel", "linear", "invites"] as const;
const REPOSITORY_ACCESS = ["transferred", "removed"] as const;
const RUN_STATUSES = ["none", "running", "ready", "failed"] as const;
/** L4-T2 (Code's SETUP_APPROVALS and SETUP_CHECK_STATUSES). */
const APPROVALS = ["none", "candidate", "checking", "approved"] as const;
/** L4-T2c (Code's SETUP_NEWER_PROPOSALS): a newer proposal beside an approved setup. */
const NEWER_PROPOSALS = ["needs_you", "checking", "rejected"] as const;
const CHECK_STATUSES = ["unchecked", "outdated", "checking", "failed", "ready"] as const;
const MODEL_CALLS = ["possible", "none", "unknown"] as const;
/** The rows that must be done before the first task (the same list Code's progress uses). */
const REQUIRED_ROWS = ["repos", "setupRun", "evalConfirm", "aiAndSpend", "firstTask"] as const;
/** Code's eval row report (project-setup-status.ts): `no_evals` is a person's "this project runs no evals" for the latest finished setup run (L2-5 c). */
const EVAL_REPORTS = ["none", "reported", "confirmed", "no_evals"] as const;

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const whole = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = <T extends string>(value: unknown, words: readonly T[]): value is T => typeof value === "string" && (words as readonly string[]).includes(value);
/** A bounded, one-line string with no control or format characters. */
const text = (value: unknown, max: number, min = 1): value is string => typeof value === "string" && value.length >= min && value.length <= max && !CONTROL.test(value);
/** One line of a failed command's output, as Code's journal keeps it: like `text`, but a TAB is part of real output (Code allows it), so it is kept; any other control or format character is still refused. */
const outputLine = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !CONTROL.test(value.replaceAll("\t", " "));

/** Not a readable answer: the whole read is refused, never a part of it. */
class Unreadable extends Error {}
function need<T>(ok: boolean, value: T): T { if (!ok) throw new Unreadable(); return value; }
const optional = <T>(value: unknown, check: (one: unknown) => boolean, key: string): Record<string, T> => (value === undefined ? {} : { [key]: need(check(value), value as T) });

function setupRunRow(row: Plain): Plain {
  // L4-T2: the approval is part of the row; an answer without it is not one this Cloud can read (land with Code's change).
  need(oneOf(row["state"], ROW_STATES) && oneOf(row["status"], RUN_STATUSES) && oneOf(row["approval"], APPROVALS), undefined);
  // L4-T2c: a newer proposal is only ever beside an approved setup, and is one of Code's three words; an answer without it (an older Code) reads as none.
  need(row["newerProposal"] === undefined || (row["approval"] === "approved" && oneOf(row["newerProposal"], NEWER_PROPOSALS)), undefined);
  const found = row["commandsFound"], failed = row["failedCommand"], check = row["check"];
  return {
    state: row["state"], status: row["status"], approval: row["approval"],
    ...(check === undefined ? {} : { check: need(plain(check) && oneOf(check["status"], CHECK_STATUSES) && (check["failedStep"] === undefined || text(check["failedStep"], 300)), { status: (check as Plain)["status"], ...((check as Plain)["failedStep"] === undefined ? {} : { failedStep: (check as Plain)["failedStep"] }) }) }),
    ...optional<string>(row["approvedAt"], (one) => text(one, 40), "approvedAt"),
    ...(row["newerProposal"] === undefined ? {} : { newerProposal: row["newerProposal"] }),
    ...optional<string>(row["startedAt"], (one) => text(one, 40), "startedAt"),
    ...optional<number>(row["elapsedMs"], (one) => whole(one), "elapsedMs"),
    ...optional<number>(row["costCents"], (one) => whole(one), "costCents"),
    ...optional<number>(row["commandsRun"], (one) => whole(one), "commandsRun"),
    ...(found === undefined ? {} : { commandsFound: need(plain(found) && whole(found["setup"]) && whole(found["tests"]), { setup: (found as Plain)["setup"], tests: (found as Plain)["tests"] }) }),
    ...optional<string>(row["testOutcome"], (one) => oneOf(one, ["passed", "failed", "unknown"]), "testOutcome"),
    ...optional<boolean>(row["partial"], (one) => typeof one === "boolean", "partial"),
    ...optional<string>(row["stop"], (one) => text(one, 60), "stop"),
    ...optional<string>(row["failure"], (one) => text(one, 1_000), "failure"),
    ...(failed === undefined ? {} : {
      failedCommand: need(plain(failed) && whole(failed["n"], 1) && text(failed["command"], 2_000) && (failed["exitCode"] === null || whole(failed["exitCode"], -1, 255)) && typeof failed["timedOut"] === "boolean"
        && Array.isArray(failed["lastLines"]) && failed["lastLines"].length <= 20 && failed["lastLines"].every((line) => outputLine(line, 300)),
      { n: (failed as Plain)["n"], command: (failed as Plain)["command"], exitCode: (failed as Plain)["exitCode"], timedOut: (failed as Plain)["timedOut"], lastLines: [...((failed as Plain)["lastLines"] as string[])] }),
    }),
  };
}

/** Code's checklist for THIS project, rebuilt from its known fields only; throws Unreadable on anything off. */
export function checklistAnswer(value: unknown, project: string): Plain {
  need(plain(value) && value["project"] === project, undefined);
  const v = value as Plain;
  const rows = Object.fromEntries(ROWS.map((name) => [name, need(plain(v[name]) && oneOf((v[name])["state"], ROW_STATES), v[name] as Plain)])) as Record<(typeof ROWS)[number], Plain>;
  const viewer = v["viewer"] as Plain, progress = v["progress"] as Plain;
  need(plain(viewer) && (viewer["companyRole"] === null || oneOf(viewer["companyRole"], ["owner", "admin", "member"])) && typeof viewer["projectAdmin"] === "boolean" && typeof viewer["canSkip"] === "boolean", undefined);
  need(plain(progress) && whole(progress["done"]) && whole(progress["total"], 1, ROWS.length) && whole(progress["done"], 0, progress["total"]) && whole(progress["percent"], 0, 100)
    && (progress["nextRequired"] === null || oneOf(progress["nextRequired"], ROWS)), undefined);
  const repos = rows.repos, evalRow = rows.evalConfirm, ai = rows.aiAndSpend, slack = rows.slackChannel, linear = rows.linear, first = rows.firstTask;
  need(whole(repos["count"], 0, 32) && Array.isArray(repos["items"]) && repos["items"].length <= 32 && repos["items"].every((item) => plain(item) && text(item["name"], 128) && text(item["defaultBranch"], 256) && (item["fullName"] === undefined || text(item["fullName"], 256)) && (item["access"] === undefined || oneOf(item["access"], REPOSITORY_ACCESS))), undefined);
  const noEvals = evalRow["noEvals"];
  need(oneOf(evalRow["report"], EVAL_REPORTS) && (noEvals === undefined || (plain(noEvals) && text(noEvals["confirmedAt"], 40))) && (evalRow["blockedBy"] === undefined || evalRow["blockedBy"] === "setupRun")
    && (evalRow["suites"] === undefined || (Array.isArray(evalRow["suites"]) && evalRow["suites"].length <= 4 && evalRow["suites"].every((suite) => plain(suite) && text(suite["selection"], 512) && whole(suite["questions"]))))
    && (evalRow["confirmedSelection"] === undefined || text(evalRow["confirmedSelection"], 512)), undefined);
  need((ai["modelCall"] === undefined || oneOf(ai["modelCall"], MODEL_CALLS)) && oneOf(ai["source"], ["project", "company", "default"]) && typeof ai["companyModelSaved"] === "boolean" && (ai["modelBudgetUsd"] === null || (typeof ai["modelBudgetUsd"] === "number" && Number.isFinite(ai["modelBudgetUsd"]) && ai["modelBudgetUsd"] >= 0)), undefined);
  need(Array.isArray(slack["channels"]) && slack["channels"].length <= 32 && slack["channels"].every((one) => plain(one) && text(one["channelId"], 64) && (one["name"] === undefined || text(one["name"], 200)) && (one["isPrivate"] === undefined || typeof one["isPrivate"] === "boolean")), undefined);
  const team = linear["team"];
  need(team === null || (plain(team) && text(team["id"], 100) && (team["name"] === undefined || text(team["name"], 200))), undefined);
  need(typeof first["hasTask"] === "boolean" && typeof first["canStart"] === "boolean", undefined);
  return {
    project,
    viewer: { companyRole: viewer["companyRole"], projectAdmin: viewer["projectAdmin"], canSkip: viewer["canSkip"] },
    progress: { done: progress["done"], total: progress["total"], percent: progress["percent"], nextRequired: progress["nextRequired"] },
    repos: { state: repos["state"], count: repos["count"], items: (repos["items"] as Plain[]).map((item) => ({ name: item["name"], ...(item["fullName"] === undefined ? {} : { fullName: item["fullName"] }), defaultBranch: item["defaultBranch"], ...(item["access"] === undefined ? {} : { access: item["access"] }) })) },
    setupRun: setupRunRow(rows.setupRun),
    evalConfirm: {
      state: evalRow["state"], report: evalRow["report"], ...(evalRow["blockedBy"] === undefined ? {} : { blockedBy: "setupRun" }),
      ...(evalRow["suites"] === undefined ? {} : { suites: (evalRow["suites"] as Plain[]).map((suite) => ({ selection: suite["selection"], questions: suite["questions"] })) }),
      ...(evalRow["confirmedSelection"] === undefined ? {} : { confirmedSelection: evalRow["confirmedSelection"] }),
      ...(evalRow["noEvals"] === undefined ? {} : { noEvals: { confirmedAt: (evalRow["noEvals"] as Plain)["confirmedAt"] } }),
    },
    aiAndSpend: { state: ai["state"], source: ai["source"], companyModelSaved: ai["companyModelSaved"], modelBudgetUsd: ai["modelBudgetUsd"], ...(ai["modelCall"] === undefined ? {} : { modelCall: ai["modelCall"] }) },
    slackChannel: { state: slack["state"], channels: (slack["channels"] as Plain[]).map((one) => ({ channelId: one["channelId"], ...(one["name"] === undefined ? {} : { name: one["name"] }), ...(one["isPrivate"] === undefined ? {} : { isPrivate: one["isPrivate"] }) })) },
    linear: { state: linear["state"], team: team === null ? null : { id: (team as Plain)["id"], ...((team as Plain)["name"] === undefined ? {} : { name: (team as Plain)["name"] }) } },
    invites: { state: rows.invites["state"] },
    firstTask: { state: first["state"], hasTask: first["hasTask"], canStart: first["canStart"] },
  };
}

/**
 * L4-T2 (G6): the AI row is done only while the company can run a model call. Cloud knows that (the same one yes/no the wiki's controls use: `agentAiConnected`, from the company's saved choice and its key store); Code
 * has no gateway to ask. Only a definite "no" changes anything: the AI row becomes needs_you with `modelCall: "none"`, the first task cannot start, and the progress counts and the next required row follow from it.
 * Every other row is as Code sent it. Unknown (null) and yes leave Code's answer exactly as it is.
 */
export function withModelCallFact(answer: Plain, connected: boolean | null): Plain {
  const ai = answer["aiAndSpend"] as Plain, progress = answer["progress"] as Plain, first = answer["firstTask"] as Plain;
  if (connected !== false || ai["state"] !== "done") return answer;
  const next = { ...answer, aiAndSpend: { ...ai, state: "needs_you", modelCall: "none" }, firstTask: { ...first, canStart: false } } as Plain;
  const done = ROWS.filter((row) => { const state = (next[row] as Plain)["state"]; return state === "done" || state === "skipped"; }).length;
  const total = progress["total"] as number;
  return { ...next, progress: { done, total, percent: Math.round((100 * done) / total), nextRequired: REQUIRED_ROWS.find((row) => (next[row] as Plain)["state"] !== "done") ?? null } };
}

/** The browser's skip change, strictly: `{row, skipped}` and nothing else. */
export function skipBody(value: unknown): { row: (typeof SKIPPABLE)[number]; skipped: boolean } | undefined {
  if (!plain(value) || Object.keys(value).length !== 2 || !oneOf(value["row"], SKIPPABLE) || typeof value["skipped"] !== "boolean") return undefined;
  return { row: value["row"], skipped: value["skipped"] };
}

/** The browser's start or stop, strictly: `{requestId}` (a UUID) and nothing else. Limits, payer and goal never come from the browser. */
export function runBody(value: unknown): { requestId: string } | undefined {
  if (!plain(value) || Object.keys(value).length !== 1 || typeof value["requestId"] !== "string" || !UUID.test(value["requestId"])) return undefined;
  return { requestId: value["requestId"] };
}

type Kind = "checklist" | "skip" | "run";
/** Code's refusal in Cloud's fixed words. Only Code's exact unknown-route 404 means "not on Code yet"; any other 404 is "project not found". */
export function setupRefusal(kind: Kind, error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  if (error.status === 404) return body?.["code"] === "NOT_FOUND" && body["message"] === "route not found" ? (kind === "run" ? A.runNotYet : A.notYet) : A.notFound;
  if (error.status === 403) return kind === "run" ? A.runNotAllowed : kind === "skip" ? A.skipNotAllowed : A.unavailable;
  if (error.status === 400) return A.invalid;
  if (error.status === 409) return kind === "run" && body?.["code"] === "WORKSPACE_BUSY" ? A.busy : A.stale;
  if (error.status === 503 && kind === "run" && body?.["message"] === W.runUnavailable) return A.runUnavailable;
  return A.unavailable;
}

type Got = { value: unknown } | { refusal: RouteAnswer };
async function fromCode(context: RouteContext, kind: Kind, path: string, init: { method?: string; body?: unknown } = {}): Promise<Got> {
  try {
    return { value: await context.client.json<unknown>(context.session, path, init) };
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) return { refusal: setupRefusal(kind, error) };
    throw error;
  }
}

/** The project in the path, after Code's access check names the person's company now; or the route's refusal. */
async function scope(context: RouteContext): Promise<{ project: string; companyId: string } | { refusal: RouteAnswer }> {
  const project = context.params[0];
  if (project === undefined || !PROJECT_NAME.test(project)) return { refusal: A.notFound };
  let who: Awaited<ReturnType<typeof companyCaller>>;
  try {
    who = await companyCaller(context);
  } catch (error) {
    if (isCodeOutcomeUnknown(error)) return { refusal: { status: error.status, body: error.body } };
    if (error instanceof CodeError) return { refusal: A.unavailable };
    throw error;
  }
  return refused(who) ? { refusal: who } : { project, companyId: who.companyId };
}

const statusPath = (project: string) => `/v1/dev/client/projects/${encodeURIComponent(project)}/setup-status`;
const runPath = (project: string, tail = "") => `/v1/app/projects/${encodeURIComponent(project)}/setup-agent${tail}`;

/** Code's setup-run answer: a plain object whose status is a known word and whose `canManage`, when sent, is a boolean. */
const runAnswerOk = (value: unknown): boolean => plain(value) && oneOf(value["status"], RUN_STATUSES) && (value["canManage"] === undefined || typeof value["canManage"] === "boolean");
/** One website ask of the journal as Code sends it: a host, a known state, and (open asks only) whether this person may decide it and the id and digest it is decided on. Anything else is unreadable. */
const hostAskOk = (ask: unknown): boolean => {
  if (!plain(ask) || typeof ask["host"] !== "string" || !HOST_NAME.test(ask["host"]) || !oneOf(ask["status"], ["open", "approved", "refused"] as const)) return false;
  if (ask["canDecide"] !== undefined && typeof ask["canDecide"] !== "boolean") return false;
  const approval = ask["approval"];
  if (approval === undefined) return true;
  return ask["status"] === "open" && plain(approval) && typeof approval["requestId"] === "string" && HOST_REQUEST_ID.test(approval["requestId"]) && whole(approval["revision"], 1)
    && typeof approval["artifactDigest"] === "string" && HEX64.test(approval["artifactDigest"]) && approval["kind"] === "setup_host" && approval["risk"] === "high";
};
const journalOk = (value: unknown): boolean => plain(value) && oneOf(value["status"], RUN_STATUSES) && Array.isArray(value["entries"]) && value["entries"].length <= 400 && Array.isArray(value["hostAsks"]) && value["hostAsks"].length <= 50 && value["hostAsks"].every(hostAskOk);

// ---- L4-D2: the setup approval (confirm, discard, decide) and the `apply` card the run's read carries -------------------------------------------------------------------------------------------------

/** The sentences Code says for a setup approval's fixed refusals (core/setup-agent/apply.ts, core-host/setup-approval.ts, setup-run-routes.ts). A Code message is passed on ONLY when it is exactly one of these: what the app reads is this file's copy, never the text Code sent. */
export const SETUP_APPROVAL_CODE_WORDS: readonly string[] = Object.freeze([
  "There is no setup from Rovara to use. Ask Rovara to set the project up first.",
  "Rovara found this setup for an earlier version of the project's settings. Set the project up again.",
  "Rovara could not finish checking where each suggestion came from. Try again in a minute.",
  "None of the suggestions can be used: each one failed its check, or is a command Rovara does not carry into a project's setup.",
  "That suggestion is not part of this setup.",
  "The setup has no test command to prove, so there is nothing to use yet.",
  // L4-T5: Code's own sentence now says what to do next (the one above is an older Code's).
  "The setup has no test command to prove, so there is nothing to use yet. Add a test command to the project's setup, or run the setup again.",
  "The commands could not be made into the project's setup.",
  // L4-T5: what a person can really do with the waiting setup, by where its check stands. (An older Code's "Decide it, or discard it, first." is not passed on: a failed check could only be discarded.)
  "Another setup is waiting for your approval. Approve or reject it, or discard it, first.",
  "Another setup is still being checked on a fresh machine. Wait for the check to finish, or discard it, first.",
  "Another setup can't be approved: its check on a fresh machine did not pass. Discard it, then use this one.",
  "Another setup is waiting. If its check passed, approve or reject it; otherwise discard it. Then use this one.",
  "A command in this setup is too long to show whole, so it cannot be approved.",
  "There is no setup waiting for a decision. Open the project's setup again.",
  "This setup change reaches outside the project's commands (a website, a secret, a registry, an integration or something Rovara does not recognise), so a company owner or admin must approve it.",
  "Only the project's maintainers, or a company owner or admin, can decide this setup.",
  "Your approval could not be proved just now, so nothing was decided. Try again.",
]);
export const SETUP_APPROVAL_WORDS = Object.freeze({
  stale: "This setup changed or is no longer waiting for a decision. Refresh to see where it stands.",
  conflict: "This was already sent. Refresh to see where the setup stands.",
  cannotDecide: "Only the project's maintainers, or a company owner or admin, can decide this setup.",
  approvalNotYet: "Approving a setup isn't available on this Rovara yet.",
  audit: "The record of this change could not be written, so nothing was done. Try again.",
});
const AW = SETUP_APPROVAL_WORDS;

const RISKS = ["low", "medium", "high"] as const;
/** Code's setup change areas (core/setup-agent/setup-risk.ts AREA_ORDER; `prompt_locations` since L4-EVP). */
const AREAS = ["setup_commands", "test_commands", "test_mocks", "prompt_locations", "websites", "registries", "integrations", "dev_container", "other"] as const;
/** The most item ids one "Use this setup" names, and its answer lists (Code's SetupConfirmRequestSchema / SetupConfirmReplySchema: 128). */
const CONFIRM_IDS_MAX = 128;
const CHECK_STATES = ["unchecked", "outdated", "checking", "failed", "ready"] as const;
const APPROVERS = ["maintainer", "admin"] as const;
const LEFT_OUT = ["unverified", "refused_command", "not_a_command_item", "too_many", "invalid_command"] as const;
const HEX64 = /^[0-9a-f]{64}$/u;
const DECISION_ID = /^setup-[A-Za-z0-9_-]{2,122}$/u;
/** One command line as Code shows it: a bounded string (a command may hold any character; the app shows it through its visible-text reader). */
const line = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 2_000;
const lines = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(line);

/** Code's waiting candidate (`apply` on the setup-run read), rebuilt from known fields only; throws Unreadable on anything off. */
export function applyAnswer(value: unknown): Plain {
  need(plain(value), undefined);
  const v = value as Plain, check = v["check"], approval = v["approval"], changes = v["changes"];
  need(whole(v["candidateRevision"], 1) && whole(v["baseRevision"], 0) && lines(v["setup"], 64) && lines(v["readiness"], 64), undefined);
  // L4-EVP: the prompt locations the candidate adds, one plain line each ("repo/path: function Name"), as Code words them; at most Code's PROMPT_LOCATIONS_MAX.
  const locations = v["promptLocations"];
  need(locations === undefined || (Array.isArray(locations) && locations.length <= 40 && locations.every((one) => text(one, 1_100))), undefined);
  need(plain(check) && oneOf(check["status"], CHECK_STATES) && (check["failedStep"] === undefined || text(check["failedStep"], 1_000)), undefined);
  need(oneOf(v["risk"], RISKS) && oneOf(v["approver"], APPROVERS) && typeof v["canApprove"] === "boolean" && typeof v["canReject"] === "boolean", undefined);
  need(Array.isArray(changes) && changes.length <= 16 && changes.every((one) => plain(one) && oneOf(one["area"], AREAS) && oneOf(one["risk"], RISKS)), undefined);
  need(approval === undefined || (plain(approval) && typeof approval["requestId"] === "string" && DECISION_ID.test(approval["requestId"]) && whole(approval["revision"], 1) && typeof approval["artifactDigest"] === "string" && HEX64.test(approval["artifactDigest"])
    && approval["kind"] === "setup" && oneOf(approval["risk"], RISKS)), undefined);
  const c = check as Plain, a = approval as Plain | undefined;
  return {
    candidateRevision: v["candidateRevision"], baseRevision: v["baseRevision"], setup: [...(v["setup"] as string[])], readiness: [...(v["readiness"] as string[])],
    ...(locations === undefined ? {} : { promptLocations: [...(locations as string[])] }),
    check: { status: c["status"], ...(c["failedStep"] === undefined ? {} : { failedStep: c["failedStep"] }) },
    risk: v["risk"], changes: (changes as Plain[]).map((one) => ({ area: one["area"], risk: one["risk"] })), approver: v["approver"], canApprove: v["canApprove"], canReject: v["canReject"],
    ...(a === undefined ? {} : { approval: { requestId: a["requestId"], revision: a["revision"], artifactDigest: a["artifactDigest"], kind: "setup", risk: a["risk"] } }),
  };
}

/** The browser's "Use this setup", strictly: `{requestId, expectedRevision, itemIds?}` and nothing else. */
export function confirmBody(value: unknown): { requestId: string; expectedRevision: number; itemIds?: string[] } | undefined {
  if (!plain(value) || Object.keys(value).some((key) => key !== "requestId" && key !== "expectedRevision" && key !== "itemIds")) return undefined;
  const ids = value["itemIds"];
  if (typeof value["requestId"] !== "string" || !UUID.test(value["requestId"]) || !whole(value["expectedRevision"], 0, 1_000_000_000)) return undefined;
  if (ids !== undefined && !(Array.isArray(ids) && ids.length <= CONFIRM_IDS_MAX && ids.every((id) => text(id, 100)))) return undefined;
  return { requestId: value["requestId"], expectedRevision: value["expectedRevision"], ...(ids === undefined ? {} : { itemIds: [...ids] }) };
}

export interface DecideBody { requestId: string; outcome: "approve" | "reject"; seen: { revision: number; artifactDigest: string }; reason?: string }
/** The browser's decision, strictly: the id Code offered, the answer, the revision and digest the person saw, and an optional reason. Nothing else. */
export function decideBody(value: unknown): DecideBody | undefined {
  if (!plain(value) || Object.keys(value).some((key) => key !== "requestId" && key !== "outcome" && key !== "seen" && key !== "reason")) return undefined;
  const seen = value["seen"], reason = value["reason"];
  if (typeof value["requestId"] !== "string" || !DECISION_ID.test(value["requestId"]) || !oneOf(value["outcome"], ["approve", "reject"] as const)) return undefined;
  if (!plain(seen) || Object.keys(seen).length !== 2 || !whole(seen["revision"], 1) || typeof seen["artifactDigest"] !== "string" || !HEX64.test(seen["artifactDigest"])) return undefined;
  if (reason !== undefined && !(typeof reason === "string" && reason.length <= 500 && !CONTROL.test(reason))) return undefined;
  return { requestId: value["requestId"], outcome: value["outcome"], seen: { revision: seen["revision"], artifactDigest: seen["artifactDigest"] }, ...(reason === undefined ? {} : { reason }) };
}

/** Code's answer to "Use this setup", rebuilt from known fields; throws Unreadable on anything off. */
function confirmAnswer(value: unknown): Plain {
  need(plain(value), undefined);
  const v = value as Plain, left = v["left"];
  need(HEX64.test(typeof v["digest"] === "string" ? v["digest"] : "") && Array.isArray(v["used"]) && v["used"].length <= CONFIRM_IDS_MAX && v["used"].every((id) => text(id, 100)) && Array.isArray(v["unchecked"]) && v["unchecked"].length <= CONFIRM_IDS_MAX && v["unchecked"].every((id) => text(id, 100)), undefined);
  need(Array.isArray(left) && left.length <= 200 && left.every((one) => plain(one) && text(one["id"], 100) && oneOf(one["reason"], LEFT_OUT)) && typeof v["proved"] === "boolean" && v["next"] === "check" && (v["candidateRevision"] === undefined || whole(v["candidateRevision"], 1)), undefined);
  return {
    digest: v["digest"], used: [...(v["used"] as string[])], unchecked: [...(v["unchecked"] as string[])], left: (left as Plain[]).map((one) => ({ id: one["id"], reason: one["reason"] })),
    ...(v["candidateRevision"] === undefined ? {} : { candidateRevision: v["candidateRevision"] }), proved: v["proved"], next: "check",
  };
}

type ApprovalKind = "confirm" | "discard" | "decide";
/** Code's refusal of a setup approval act in Cloud's fixed words. Only a message that is exactly one of Code's fixed sentences is said (as this file's copy of it); anything else is by code and status. */
export function approvalRefusal(kind: ApprovalKind, error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const code = body?.["code"], said = typeof body?.["message"] === "string" ? SETUP_APPROVAL_CODE_WORDS.find((words) => words === body["message"]) : undefined;
  if (error.status === 404) {
    if (code === "NOT_FOUND" && body?.["message"] === "route not found") return A.runNotYet;
    if (code === "NOT_FOUND" && body?.["message"] === "Approving a project's setup isn't available on this install yet.") return answer(501, "NOT_ON_CODE_YET", AW.approvalNotYet);
    return A.notFound;
  }
  if (error.status === 403) return said !== undefined ? answer(403, "FORBIDDEN", said) : kind === "decide" ? answer(403, "FORBIDDEN", AW.cannotDecide) : A.runNotAllowed;
  if (error.status === 400) return said !== undefined ? answer(400, "CONFIG_INVALID", said) : A.invalid;
  if (error.status === 409) {
    if (code === "IDEMPOTENCY_CONFLICT") return answer(409, "IDEMPOTENCY_CONFLICT", AW.conflict);
    if (code === "WORKSPACE_BUSY") return said !== undefined ? answer(409, "WORKSPACE_BUSY", said) : A.busy;
    if (said !== undefined) return answer(409, code === "PROJECT_REVISION_MISMATCH" ? "PROJECT_REVISION_MISMATCH" : "CHANGE_STALE", said);
    return kind === "decide" ? answer(409, "CHANGE_STALE", AW.stale) : A.stale;
  }
  if (error.status === 503 && code === "AUDIT_UNAVAILABLE") return answer(503, "AUDIT_UNAVAILABLE", AW.audit);
  return A.unavailable;
}
// ---- the website a setup run asked for: allow or refuse (Code's host-decide) ----------------------------------------------------------------------------------------------------------------------

/** Code's host name pattern (contracts setup-run.ts HOST_PATTERN): lower case, at least one dot. */
const HOST_NAME = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOST_REQUEST_ID = /^host-[A-Za-z0-9_-]{2,122}$/u;
/** The sentences Code says for a website decision's fixed refusals (setup-run-routes.ts, setup-approval.ts). A Code message is passed on only when it is exactly one of these. */
export const SETUP_HOST_CODE_WORDS: readonly string[] = Object.freeze([
  "A website for a setup run changes what the project's code can reach, so only a company owner or admin can allow or refuse it.",
  "That website is not waiting for a decision any more. Open the project's setup again.",
  "Your approval could not be proved just now, so nothing was decided. Try again.",
]);
export const SETUP_HOST_WORDS = Object.freeze({
  cannotDecide: "A website for a setup run changes what the project's code can reach, so only a company owner or admin can allow or refuse it.",
  notWaiting: "That website is not waiting for a decision any more. Open the project's setup again.",
  notYet: "Allowing a website isn't available on this Rovara yet.",
});
export interface HostDecideBody { requestId: string; host: string; outcome: "approve" | "reject"; seen: { revision: number; artifactDigest: string }; reason?: string }
/** The browser's website decision, strictly: the id Code offered, the host, the answer, the revision and digest the person saw, and an optional reason. Nothing else. */
export function hostDecideBody(value: unknown): HostDecideBody | undefined {
  if (!plain(value) || Object.keys(value).some((key) => key !== "requestId" && key !== "host" && key !== "outcome" && key !== "seen" && key !== "reason")) return undefined;
  const seen = value["seen"], reason = value["reason"];
  if (typeof value["requestId"] !== "string" || !HOST_REQUEST_ID.test(value["requestId"]) || typeof value["host"] !== "string" || !HOST_NAME.test(value["host"]) || !oneOf(value["outcome"], ["approve", "reject"] as const)) return undefined;
  if (!plain(seen) || Object.keys(seen).length !== 2 || !whole(seen["revision"], 1) || typeof seen["artifactDigest"] !== "string" || !HEX64.test(seen["artifactDigest"])) return undefined;
  if (reason !== undefined && !(typeof reason === "string" && reason.length <= 500 && !CONTROL.test(reason))) return undefined;
  return { requestId: value["requestId"], host: value["host"], outcome: value["outcome"], seen: { revision: seen["revision"], artifactDigest: seen["artifactDigest"] }, ...(reason === undefined ? {} : { reason }) };
}
/** Code's refusal of a website decision in Cloud's fixed words: a Code sentence only when it is exactly a fixed one (then as this file's copy), else by code and status. Never the browser's or Code's other text. */
export function hostRefusal(error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const code = body?.["code"], said = typeof body?.["message"] === "string" ? SETUP_HOST_CODE_WORDS.find((words) => words === body["message"]) : undefined;
  if (error.status === 404) {
    if (code === "NOT_FOUND" && (body?.["message"] === "route not found" || body?.["message"] === "Approving a project's setup isn't available on this install yet.")) return answer(501, "NOT_ON_CODE_YET", SETUP_HOST_WORDS.notYet);
    return A.notFound;
  }
  if (error.status === 403) return answer(403, "FORBIDDEN", said ?? SETUP_HOST_WORDS.cannotDecide);
  if (error.status === 400) return A.invalid;
  if (error.status === 409) {
    if (code === "IDEMPOTENCY_CONFLICT") return answer(409, "IDEMPOTENCY_CONFLICT", AW.conflict);
    return answer(409, "CHANGE_STALE", said ?? SETUP_HOST_WORDS.notWaiting);
  }
  if (error.status === 503 && code === "AUDIT_UNAVAILABLE") return answer(503, "AUDIT_UNAVAILABLE", AW.audit);
  return A.unavailable;
}

/** What the project overview and the lists say about the project's setup: Code's REAL checklist, never a fixed word. Ready only for an approved setup whose check on a fresh machine is ready; a check going (the approved
 *  setup's, or a candidate's) is checking; an approved setup whose check failed or went stale says so; everything else (no setup yet, a proposal nobody used, a run that failed) is unchecked, which is "needs attention". */
export function setupStatusOf(checklist: Plain): { status: "unchecked" | "checking" | "ready" | "failed" | "outdated"; failedStep?: string } {
  const run = checklist["setupRun"] as Plain, check = run["check"] as Plain | undefined;
  if (run["approval"] === "approved" && check !== undefined) {
    if (check["status"] === "ready" && run["state"] === "done") return { status: "ready" };
    if (check["status"] === "checking") return { status: "checking" };
    if (check["status"] === "failed") return { status: "failed", ...(typeof check["failedStep"] === "string" ? { failedStep: check["failedStep"] } : {}) };
    if (check["status"] === "outdated") return { status: "outdated" };
    return { status: "unchecked" };
  }
  return run["approval"] === "checking" ? { status: "checking" } : { status: "unchecked" };
}
/** The project's setup as the overview, the project's detail and the lists show it, from Code's checklist read as the signed-in person. A read that fails or does not read is "unknown" (nothing is known: never "ready", and not "needs attention" either). An ended sign-in still reaches the handler. */
export async function projectSetupStatusOf(context: RouteContext, project: string): Promise<{ status: "unchecked" | "checking" | "ready" | "failed" | "outdated" | "unknown"; failedStep?: string }> {
  if (!PROJECT_NAME.test(project)) return { status: "unknown" };
  try {
    return setupStatusOf(checklistAnswer(await context.client.json<unknown>(context.session, statusPath(project)), project));
  } catch (error) {
    // Only an ended sign-in goes on (the handler signs the person out); any other failure of this extra read (Code's refusal, an answer that does not read, a connection that failed) is "unchecked", never a failed page.
    if (error instanceof SignInEnded) throw error;
    return { status: "unknown" };
  }
}

const statusRoute: Route = {
  method: "GET", path: /^\/projects\/([^/]+)\/setup-status$/u,
  answer: async (context) => {
    const at = await scope(context);
    if ("refusal" in at) return at.refusal;
    const got = await fromCode(context, "checklist", statusPath(at.project));
    if ("refusal" in got) return got.refusal;
    let rebuilt: Plain;
    try { rebuilt = checklistAnswer(got.value, at.project); } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
    // The company is Code's live access check's, never the browser's. A read that throws is "cannot tell" (null), which changes nothing.
    const connected = await agentAiConnected(context, at.companyId).catch(() => null);
    return { status: 200, body: withModelCallFact(rebuilt, connected) };
  },
};

const skipRoute: Route = {
  method: "PUT", path: /^\/projects\/([^/]+)\/setup-status\/skips$/u,
  answer: async (context) => {
    const at = await scope(context);
    if ("refusal" in at) return at.refusal;
    const given = skipBody(context.body);
    if (given === undefined) return A.invalid;
    const got = await fromCode(context, "skip", `${statusPath(at.project)}/skips`, { method: "PUT", body: given });
    if ("refusal" in got) return got.refusal;
    const v = got.value;
    if (!plain(v) || v["project"] !== at.project || v["row"] !== given.row || v["skipped"] !== given.skipped || !Array.isArray(v["skippedRows"]) || v["skippedRows"].length > SKIPPABLE.length
      || !v["skippedRows"].every((row) => oneOf(row, SKIPPABLE))) return A.unavailable;
    return { status: 200, body: { project: at.project, row: given.row, skipped: given.skipped, skippedRows: [...(v["skippedRows"] as string[])] } };
  },
};

/** The browser's "no evals" choice, strictly: `{noEvals}` (true sets it for the latest finished setup run, false takes it back) and nothing else (Code's ProjectSetupEvalNoneBodySchema). */
export function evalNoneBody(value: unknown): { noEvals: boolean } | undefined {
  if (!plain(value) || Object.keys(value).length !== 1 || typeof value["noEvals"] !== "boolean") return undefined;
  return { noEvals: value["noEvals"] };
}

const evalNoneRoute: Route = {
  method: "PUT", path: /^\/projects\/([^/]+)\/setup-status\/eval-none$/u,
  answer: async (context) => {
    const at = await scope(context);
    if ("refusal" in at) return at.refusal;
    const given = evalNoneBody(context.body);
    if (given === undefined) return A.invalid;
    // Code decides who may (a company owner or admin, or the project's admin: the same people as a skip) and against which setup run.
    const got = await fromCode(context, "skip", `${statusPath(at.project)}/eval-none`, { method: "PUT", body: given });
    if ("refusal" in got) return got.refusal;
    const v = got.value;
    if (!plain(v) || v["project"] !== at.project || v["noEvals"] !== given.noEvals || !(v["taskId"] === null || text(v["taskId"], 160))) return A.unavailable;
    return { status: 200, body: { project: at.project, noEvals: given.noEvals, taskId: v["taskId"] } };
  },
};

const runReadRoute: Route = {
  method: "GET", path: /^\/projects\/([^/]+)\/setup-agent$/u,
  answer: async (context) => {
    const at = await scope(context);
    if ("refusal" in at) return at.refusal;
    const got = await fromCode(context, "run", runPath(at.project));
    if ("refusal" in got) return got.refusal;
    if (!runAnswerOk(got.value)) return A.unavailable;
    // The waiting candidate (L4-D2) is rebuilt from its known fields; an unreadable one is no answer at all (never a card with a guessed risk or approver).
    const read = got.value as Plain;
    if (read["apply"] === undefined) return { status: 200, body: read };
    try { return { status: 200, body: { ...read, apply: applyAnswer(read["apply"]) } }; } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
  },
};

/** One approval act (confirm, discard or decide): the checked body goes to Code as the person; Code's answer is rebuilt and its refusals are Cloud's fixed words. */
function approvalRoute<B>(tail: ApprovalKind | "host-decide", check: (body: unknown) => B | undefined, rebuild: (value: unknown, project: string, sent: B) => Plain, event: string, describe: (sent: B) => Record<string, string>, refuse: (error: CodeError) => RouteAnswer = (error) => approvalRefusal(tail as ApprovalKind, error)): Route {
  return {
    method: "POST", path: new RegExp(`^/projects/([^/]+)/setup-agent/${tail}$`, "u"),
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      const given = check(context.body);
      if (given === undefined) return A.invalid;
      let value: unknown;
      try {
        value = await context.client.json<unknown>(context.session, runPath(at.project, `/${tail}`), { method: "POST", body: given });
      } catch (error) {
        // An ended sign-in is not a CodeError: it reaches the handler, which signs the person out.
        if (error instanceof CodeError) return refuse(error);
        throw error;
      }
      let rebuilt: Plain;
      try { rebuilt = rebuild(value, at.project, given); } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
      console.log(JSON.stringify({ event, project: at.project, ...describe(given) }));
      return { status: 200, body: rebuilt };
    },
  };
}

const confirmRoute = approvalRoute("confirm", confirmBody, (value) => confirmAnswer(value), "cloud.setup_confirm", () => ({}));
const discardRoute = approvalRoute("discard", runBody, (value) => { need(plain(value) && typeof value["discarded"] === "boolean", undefined); return { discarded: (value as Plain)["discarded"] }; }, "cloud.setup_discard", () => ({}));
const decideRoute = approvalRoute("decide", decideBody, (value, project, sent) => {
  need(plain(value) && value["project"] === project && oneOf(value["decision"], ["approved", "rejected"] as const) && value["decision"] === (sent.outcome === "approve" ? "approved" : "rejected")
    && oneOf(value["risk"], RISKS) && whole(value["revision"], 1) && typeof value["replayed"] === "boolean", undefined);
  const v = value as Plain;
  return { project, decision: v["decision"], risk: v["risk"], revision: v["revision"], replayed: v["replayed"] };
}, "cloud.setup_decide", (sent) => ({ outcome: sent.outcome }));

const hostDecideRoute = approvalRoute("host-decide", hostDecideBody, (value, project, sent) => {
  need(plain(value) && value["project"] === project && value["host"] === sent.host && oneOf(value["decision"], ["approved", "refused"] as const) && value["decision"] === (sent.outcome === "approve" ? "approved" : "refused") && typeof value["replayed"] === "boolean", undefined);
  const v = value as Plain;
  return { project, host: sent.host, decision: v["decision"], replayed: v["replayed"] };
}, "cloud.setup_host_decide", (sent) => ({ outcome: sent.outcome }), hostRefusal);

function runChangeRoute(tail: "" | "/stop"): Route {
  return {
    method: "POST", path: new RegExp(`^/projects/([^/]+)/setup-agent${tail}$`, "u"),
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      const given = runBody(context.body);
      if (given === undefined) return A.invalid;
      const got = await fromCode(context, "run", runPath(at.project, tail), { method: "POST", body: given });
      if ("refusal" in got) return got.refusal;
      if (!runAnswerOk(got.value)) return A.unavailable;
      console.log(JSON.stringify({ event: tail === "" ? "cloud.setup_run_start" : "cloud.setup_run_stop", project: at.project }));
      return { status: 200, body: got.value };
    },
  };
}

const journalRoute: Route = {
  method: "GET", path: /^\/projects\/([^/]+)\/setup-agent\/journal$/u,
  answer: async (context) => {
    const at = await scope(context);
    if ("refusal" in at) return at.refusal;
    // Only `after`, once, a whole number from 0 to 400 (Code's bound); nothing else is forwarded.
    const keys = [...context.query.keys()];
    const after = context.query.get("after");
    if (keys.some((key) => key !== "after") || keys.length > 1 || (after !== null && !/^(?:0|[1-9][0-9]{0,2})$/u.test(after)) || (after !== null && Number(after) > 400)) return A.invalid;
    const got = await fromCode(context, "run", runPath(at.project, `/journal${after === null ? "" : `?after=${after}`}`));
    if ("refusal" in got) return got.refusal;
    return journalOk(got.value) ? { status: 200, body: got.value } : A.unavailable;
  },
};

export const SETUP_CHECKLIST_ROUTES: Route[] = [statusRoute, skipRoute, evalNoneRoute, runReadRoute, runChangeRoute(""), runChangeRoute("/stop"), journalRoute, confirmRoute, discardRoute, decideRoute, hostDecideRoute];
