// Guided onboarding PR 9 (design section 1 "Project setup checklist"; DEC 254j, 254k, 254l, 254n item 3, 254o c): the project checklist's read, its "Set up
// later" change and the hosted setup run, answered from Rovara Code as the signed-in person, with their own token.
//
//   GET  /v1/app/projects/{p}/setup-status              -> Code GET  /v1/dev/client/projects/{p}/setup-status          (#841; any member of the company)
//   PUT  /v1/app/projects/{p}/setup-status/skips        -> Code PUT  /v1/dev/client/projects/{p}/setup-status/skips    (#841; owner/admin or project admin)
//   GET  /v1/app/projects/{p}/setup-agent               -> Code GET  /v1/app/projects/{p}/setup-agent                  (#844; owner/admin or project admin manage, a project user reads)
//   POST /v1/app/projects/{p}/setup-agent   {requestId} -> Code POST /v1/app/projects/{p}/setup-agent                  (start, or Re-run setup: a re-run only proposes)
//   POST /v1/app/projects/{p}/setup-agent/stop {requestId} -> Code POST .../setup-agent/stop
//   GET  /v1/app/projects/{p}/setup-agent/journal?after=n  -> Code GET .../setup-agent/journal?after=n
//   POST /v1/app/projects/{p}/setup-agent/confirm {requestId, expectedRevision, itemIds?} -> Code POST .../setup-agent/confirm  ("Use this setup": a candidate and its check; L4-D, Code #899)
//   POST /v1/app/projects/{p}/setup-agent/discard {requestId}                              -> Code POST .../setup-agent/discard  (drop the waiting candidate)
//   POST /v1/app/projects/{p}/setup-agent/decide {requestId, outcome, seen, reason?}       -> Code POST .../setup-agent/decide   (approve or reject: a fresh step-up, then Code's risk-based approver rule)
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
import { CodeError } from "./code-client.js";
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

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const whole = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = <T extends string>(value: unknown, words: readonly T[]): value is T => typeof value === "string" && (words as readonly string[]).includes(value);
/** A bounded, one-line string with no control or format characters. */
const text = (value: unknown, max: number, min = 1): value is string => typeof value === "string" && value.length >= min && value.length <= max && !CONTROL.test(value);

/** Not a readable answer: the whole read is refused, never a part of it. */
class Unreadable extends Error {}
function need<T>(ok: boolean, value: T): T { if (!ok) throw new Unreadable(); return value; }
const optional = <T>(value: unknown, check: (one: unknown) => boolean, key: string): Record<string, T> => (value === undefined ? {} : { [key]: need(check(value), value as T) });

function setupRunRow(row: Plain): Plain {
  need(oneOf(row["state"], ROW_STATES) && oneOf(row["status"], RUN_STATUSES), undefined);
  const found = row["commandsFound"], failed = row["failedCommand"];
  return {
    state: row["state"], status: row["status"],
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
        && Array.isArray(failed["lastLines"]) && failed["lastLines"].length <= 20 && failed["lastLines"].every((line) => text(line, 300, 0)),
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
  need(oneOf(evalRow["report"], ["none", "reported", "confirmed"]) && (evalRow["blockedBy"] === undefined || evalRow["blockedBy"] === "setupRun")
    && (evalRow["suites"] === undefined || (Array.isArray(evalRow["suites"]) && evalRow["suites"].length <= 4 && evalRow["suites"].every((suite) => plain(suite) && text(suite["selection"], 512) && whole(suite["questions"]))))
    && (evalRow["confirmedSelection"] === undefined || text(evalRow["confirmedSelection"], 512)), undefined);
  need(oneOf(ai["source"], ["project", "company", "default"]) && typeof ai["companyModelSaved"] === "boolean" && (ai["modelBudgetUsd"] === null || (typeof ai["modelBudgetUsd"] === "number" && Number.isFinite(ai["modelBudgetUsd"]) && ai["modelBudgetUsd"] >= 0)), undefined);
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
    },
    aiAndSpend: { state: ai["state"], source: ai["source"], companyModelSaved: ai["companyModelSaved"], modelBudgetUsd: ai["modelBudgetUsd"] },
    slackChannel: { state: slack["state"], channels: (slack["channels"] as Plain[]).map((one) => ({ channelId: one["channelId"], ...(one["name"] === undefined ? {} : { name: one["name"] }), ...(one["isPrivate"] === undefined ? {} : { isPrivate: one["isPrivate"] }) })) },
    linear: { state: linear["state"], team: team === null ? null : { id: (team as Plain)["id"], ...((team as Plain)["name"] === undefined ? {} : { name: (team as Plain)["name"] }) } },
    invites: { state: rows.invites["state"] },
    firstTask: { state: first["state"], hasTask: first["hasTask"], canStart: first["canStart"] },
  };
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
async function scope(context: RouteContext): Promise<{ project: string } | { refusal: RouteAnswer }> {
  const project = context.params[0];
  if (project === undefined || !PROJECT_NAME.test(project)) return { refusal: A.notFound };
  let who: Awaited<ReturnType<typeof companyCaller>>;
  try {
    who = await companyCaller(context);
  } catch (error) {
    if (error instanceof CodeError) return { refusal: A.unavailable };
    throw error;
  }
  return refused(who) ? { refusal: who } : { project };
}

const statusPath = (project: string) => `/v1/dev/client/projects/${encodeURIComponent(project)}/setup-status`;
const runPath = (project: string, tail = "") => `/v1/app/projects/${encodeURIComponent(project)}/setup-agent${tail}`;

/** Code's setup-run answer: a plain object whose status is a known word and whose `canManage`, when sent, is a boolean. */
const runAnswerOk = (value: unknown): boolean => plain(value) && oneOf(value["status"], RUN_STATUSES) && (value["canManage"] === undefined || typeof value["canManage"] === "boolean");
const journalOk = (value: unknown): boolean => plain(value) && oneOf(value["status"], RUN_STATUSES) && Array.isArray(value["entries"]) && value["entries"].length <= 400 && Array.isArray(value["hostAsks"]) && value["hostAsks"].length <= 50;

// ---- L4-D2: the setup approval (confirm, discard, decide) and the `apply` card the run's read carries -------------------------------------------------------------------------------------------------

/** The sentences Code says for a setup approval's fixed refusals (core/setup-agent/apply.ts, core-host/setup-approval.ts, setup-run-routes.ts). A Code message is passed on ONLY when it is exactly one of these: what the app reads is this file's copy, never the text Code sent. */
export const SETUP_APPROVAL_CODE_WORDS: readonly string[] = Object.freeze([
  "There is no setup from Rovara to use. Ask Rovara to set the project up first.",
  "Rovara found this setup for an earlier version of the project's settings. Set the project up again.",
  "Rovara could not finish checking where each suggestion came from. Try again in a minute.",
  "None of the suggestions can be used: each one failed its check, or is a command Rovara does not carry into a project's setup.",
  "That suggestion is not part of this setup.",
  "The setup has no test command to prove, so there is nothing to use yet.",
  "The commands could not be made into the project's setup.",
  "Another setup is waiting for your approval. Decide it, or discard it, first.",
  "A command in this setup is too long to show whole, so it cannot be approved.",
  "There is no setup waiting for a decision. Open the project's setup again.",
  "This setup change reaches outside the project's commands (a website, a secret, a registry, an integration or something Rovara does not recognise), so a company owner or admin must approve it.",
  "Only the project's maintainers, or a company owner or admin, can decide this setup.",
  "Your approval could not be proved just now, so nothing was decided. Try again.",
]);
export const SETUP_APPROVAL_WORDS = Object.freeze({
  stale: "This setup changed or is no longer waiting for a decision. Refresh to see where it stands.",
  conflict: "This decision was already sent. Refresh to see where the setup stands.",
  stepUp: "Confirm it's you again, then try once more.",
  cannotDecide: "Only the project's maintainers, or a company owner or admin, can decide this setup.",
  approvalNotYet: "Approving a setup isn't available on this Rovara yet.",
  audit: "The record of this change could not be written, so nothing was done. Try again.",
});
const AW = SETUP_APPROVAL_WORDS;

const RISKS = ["low", "medium", "high"] as const;
const AREAS = ["setup_commands", "test_commands", "test_mocks", "websites", "registries", "integrations", "dev_container", "other"] as const;
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
  need(whole(v["candidateRevision"], 1) && whole(v["baseRevision"], 0) && lines(v["setup"], 40) && lines(v["readiness"], 40), undefined);
  need(plain(check) && oneOf(check["status"], CHECK_STATES) && (check["failedStep"] === undefined || text(check["failedStep"], 1_000)), undefined);
  need(oneOf(v["risk"], RISKS) && oneOf(v["approver"], APPROVERS) && typeof v["canApprove"] === "boolean" && typeof v["canReject"] === "boolean", undefined);
  need(Array.isArray(changes) && changes.length <= 16 && changes.every((one) => plain(one) && oneOf(one["area"], AREAS) && oneOf(one["risk"], RISKS)), undefined);
  need(approval === undefined || (plain(approval) && typeof approval["requestId"] === "string" && DECISION_ID.test(approval["requestId"]) && whole(approval["revision"], 1) && typeof approval["artifactDigest"] === "string" && HEX64.test(approval["artifactDigest"])
    && approval["kind"] === "setup" && oneOf(approval["risk"], RISKS)), undefined);
  const c = check as Plain, a = approval as Plain | undefined;
  return {
    candidateRevision: v["candidateRevision"], baseRevision: v["baseRevision"], setup: [...(v["setup"] as string[])], readiness: [...(v["readiness"] as string[])],
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
  if (ids !== undefined && !(Array.isArray(ids) && ids.length <= 64 && ids.every((id) => text(id, 100)))) return undefined;
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
  need(HEX64.test(typeof v["digest"] === "string" ? v["digest"] : "") && Array.isArray(v["used"]) && v["used"].length <= 64 && v["used"].every((id) => text(id, 100)) && Array.isArray(v["unchecked"]) && v["unchecked"].length <= 64 && v["unchecked"].every((id) => text(id, 100)), undefined);
  need(Array.isArray(left) && left.length <= 200 && left.every((one) => plain(one) && text(one["id"], 100) && oneOf(one["reason"], LEFT_OUT)) && typeof v["proved"] === "boolean" && v["next"] === "check" && (v["candidateRevision"] === undefined || whole(v["candidateRevision"], 1)), undefined);
  return {
    digest: v["digest"], used: [...(v["used"] as string[])], unchecked: [...(v["unchecked"] as string[])], left: (left as Plain[]).map((one) => ({ id: one["id"], reason: one["reason"] })),
    ...(v["candidateRevision"] === undefined ? {} : { candidateRevision: v["candidateRevision"] }), proved: v["proved"], next: "check",
  };
}

type ApprovalKind = "confirm" | "discard" | "decide";
/** Code's refusal of a setup approval act in Cloud's fixed words. Only a message that is exactly one of Code's fixed sentences is said (as this file's copy of it); anything else is by code and status. */
export function approvalRefusal(kind: ApprovalKind, error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const code = body?.["code"], said = typeof body?.["message"] === "string" ? SETUP_APPROVAL_CODE_WORDS.find((words) => words === body["message"]) : undefined;
  if (error.status === 404) {
    if (code === "NOT_FOUND" && body?.["message"] === "route not found") return A.runNotYet;
    if (code === "NOT_FOUND" && body?.["message"] === "Approving a project's setup isn't available on this install yet.") return answer(501, "NOT_ON_CODE_YET", AW.approvalNotYet);
    return A.notFound;
  }
  if (code === "REAUTH_REQUIRED") return answer(403, "REAUTH_REQUIRED", AW.stepUp);
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
const statusRoute: Route = {
  method: "GET", path: /^\/projects\/([^/]+)\/setup-status$/u,
  answer: async (context) => {
    const at = await scope(context);
    if ("refusal" in at) return at.refusal;
    const got = await fromCode(context, "checklist", statusPath(at.project));
    if ("refusal" in got) return got.refusal;
    try { return { status: 200, body: checklistAnswer(got.value, at.project) }; } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
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
function approvalRoute<B>(tail: ApprovalKind, check: (body: unknown) => B | undefined, rebuild: (value: unknown, project: string, sent: B) => Plain, event: string, describe: (sent: B) => Record<string, string>): Route {
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
        if (error instanceof CodeError) return approvalRefusal(tail, error);
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

export const SETUP_CHECKLIST_ROUTES: Route[] = [statusRoute, skipRoute, runReadRoute, runChangeRoute(""), runChangeRoute("/stop"), journalRoute, confirmRoute, discardRoute, decideRoute];
