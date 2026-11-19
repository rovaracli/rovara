// The Members page's routes (guided onboarding PR 12a; design section 4; DEC 254j, 254l items 2 and 9): the company's people and roles, and a
// role change, both answered by Rovara Code's own member routes as the signed-in person, with their own token:
//
//   GET /v1/app/org/members                    -> GET /v1/dev/company/members[?cursor=&limit=100], page by page, at most MEMBER_LIST_PAGES_MAX pages
//   PUT /v1/app/org/members/{personId}/role    -> PUT /v1/dev/company/members/{personId}/role  { role }
//   GET /v1/app/org/members/{personId}/removal-preview[?successorId=]  -> GET /v1/dev/company/members/{personId}/removal-preview[?successorId=]
//   POST /v1/app/org/members/{personId}/removal { requestId, expectedRole, successorId? }  -> POST /v1/dev/company/members/{personId}/removal (the same body)
//   GET /v1/app/org/members/handovers           -> GET /v1/dev/company/members/handovers (DEC 254zzz101: hand-overs that did not finish)
//   POST /v1/app/org/members/{personId}/handover { requestId, successorId }  -> POST /v1/dev/company/members/{personId}/handover (finish one, to someone now)
//
// Removal with a hand-over (DEC 254zzz84 (5)): an owner or admin removes a person and picks who takes over what they owned (agents, chains, open tasks
// the successor can own); Code checks the successor, the role the screen showed and the company's last owner inside its own transaction, moves
// everything at once and writes the audit record. The request id is the receipt: the same id finishes or repeats nothing. No step-up (DEC 254zzz73).
// Once Code removed the person (and only then: a refused removal withdraws nothing), Cloud withdraws any eval approval they made (withdrawForMember).
//
// Who: Code decides. The company is the one Code's live membership names for the person (Code reads it again on every call); the browser never
// names a company, and the person id is passed only as Code's path parameter. Cloud asks Code's access check first (company-caller.ts) and
// refuses early, in fixed words, what Code would refuse anyway: a person who is not a company owner or admin, an admin's self-change, an owner's
// self-promotion, and an owner change by a non-owner. An owner may step down through the existing forward; Code alone checks the live-owner witness
// transactionally and answers
// "another company's person" (404, which reaches the app as one fixed sentence, the same as a missing person) and "the last owner" (Code refuses
// demoting or removing a company's last active owner inside its own transaction; Cloud only words it).
//
// Every answer is a fixed sentence; nothing the request carried and nothing Code worded is echoed. Code writes the company-log record of the change
// (with the person, the old and the new role).
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { withdrawForMember } from "./product-ai-routes.js";

/** Code's member routes (company-member-routes.ts on Code). */
export const CODE_MEMBERS_PATH = "/v1/dev/company/members";
/** The most pages of Code's list (100 people each) one answer reads. Past it the whole list is refused, never a part of it. */
export const MEMBER_LIST_PAGES_MAX = 10;
const PAGE = 100;

const refusal = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
/** Every answer these routes give other than success. Fixed words only. */
export const MEMBER_WORDS = Object.freeze({
  listNotAdmin: refusal(403, "FORBIDDEN", "Only a company owner or admin can see the company's members."),
  notAdmin: refusal(403, "FORBIDDEN", "Only a company owner or admin can change roles."),
  notFound: refusal(404, "NOT_FOUND", "That person isn't in your company."),
  self: refusal(403, "FORBIDDEN", "You can't change your own role. Ask another owner."),
  ownerOnly: refusal(403, "FORBIDDEN", "Only an owner can make someone an owner or change an owner's role."),
  lastOwner: refusal(409, "LAST_OWNER", "You're the only owner; add another owner first"),
  removed: refusal(409, "MEMBER_ALREADY_REMOVED", "This person was removed from the company."),
  badBody: refusal(400, "CONFIG_INVALID", "Choose member, admin or owner."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The role couldn't be changed just now. Try again."),
  listUnavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The company's members couldn't be read just now. Try again."),
  listTooLong: refusal(503, "RUNTIME_UNAVAILABLE", "Your company has too many members to show here."),
});

/** Code's own fixed words for its two FORBIDDEN refusals (company-member-routes.ts OWN_MEMBERSHIP, company-member-contract.ts MEMBER_ONLY_OWNER). */
const CODE_OWN_MEMBERSHIP = "you cannot change your own role or remove yourself here";
const CODE_OWNER_ONLY = "only an owner can change or remove an owner";
/** Code's 404 for a caller who is not (or no longer) a company owner or admin, as opposed to its "member not found". */
const CODE_NOT_ADMIN = "not found";

const PERSON_ID = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const ROLES = ["owner", "admin", "member"] as const;
type Role = (typeof ROLES)[number];
const LISTED_ROLES = new Set(["owner", "admin", "member", "auditor"]);
const NAME_MAX = 200, EMAIL_MAX = 320;
const NAME_UNSAFE = /[\p{Cc}\p{Cf}]/u;
const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Code's refusal code and message, when its body reads; nothing else of it is kept. */
function codeRefusal(error: CodeError): { code?: string; message?: string } {
  const failure = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  return {
    ...(typeof failure?.["code"] === "string" ? { code: failure["code"] } : {}),
    ...(typeof failure?.["message"] === "string" ? { message: failure["message"] } : {}),
  };
}

/** Code's refusal of a role change, as one of this module's fixed answers. */
export function roleRefusal(error: CodeError): RouteAnswer {
  const { code, message } = codeRefusal(error);
  if (error.status === 404 && message === CODE_NOT_ADMIN) return MEMBER_WORDS.notAdmin;
  if (error.status === 404) return MEMBER_WORDS.notFound;
  if (code === "LAST_OWNER") return MEMBER_WORDS.lastOwner;
  if (code === "MEMBER_ALREADY_REMOVED") return MEMBER_WORDS.removed;
  if (error.status === 403 && message === CODE_OWN_MEMBERSHIP) return MEMBER_WORDS.self;
  if (error.status === 403 && message === CODE_OWNER_ONLY) return MEMBER_WORDS.ownerOnly;
  if (error.status === 403) return MEMBER_WORDS.notAdmin;
  if (error.status === 400) return MEMBER_WORDS.badBody;
  return MEMBER_WORDS.unavailable;
}

/** `PUT /org/members/{personId}/role` with the app's body `{ requestId, role, expectedRole? }`. */
async function changeRole(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return MEMBER_WORDS.notAdmin;
  const body = context.body;
  if (!plain(body) || !Object.keys(body).every((key) => key === "requestId" || key === "role" || key === "expectedRole")
    || typeof body["requestId"] !== "string" || !UUID.test(body["requestId"]) || !isRole(body["role"])
    || (Object.hasOwn(body, "expectedRole") && !isRole(body["expectedRole"]))) return MEMBER_WORDS.badBody;
  const role = body["role"];
  const personId = context.params[0] ?? "";
  if (!PERSON_ID.test(personId)) return MEMBER_WORDS.notFound;
  // Code owns the transactional last-owner check. Cloud forwards only an owner's own step-down;
  // self-promotion, an admin's self-change and keeping the owner role remain refused.
  if (personId === who.developerId && (who.companyRole !== "owner" || role === "owner")) return MEMBER_WORDS.self;
  // Owner changes are an owner's. The person's real role is Code's to know (it refuses an admin who changes an owner); the screen's `expectedRole`
  // only lets Cloud say so before asking Code.
  if ((role === "owner" || body["expectedRole"] === "owner") && who.companyRole !== "owner") return MEMBER_WORDS.ownerOnly;
  try {
    await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}/${personId}/role`, { method: "PUT", body: { role } });
  } catch (error) {
    if (error instanceof CodeError) return roleRefusal(error);
    throw error;
  }
  return { status: 200, body: { developerId: personId, role } };
}

interface ListedMember { developerId: string; name: string; email?: string; role: string; joinedAt?: string }

/** One of Code's member rows as the app's row, or undefined when it doesn't read (then the whole list is refused). */
function listed(row: unknown, companyId: string): ListedMember | undefined | "revoked" {
  if (!plain(row) || row["companyId"] !== companyId || typeof row["personId"] !== "string" || !PERSON_ID.test(row["personId"])) return undefined;
  if (typeof row["role"] !== "string" || !LISTED_ROLES.has(row["role"])) return undefined;
  if (row["revokedAt"] !== undefined) return "revoked";
  const given = typeof row["name"] === "string" ? row["name"].trim() : "";
  const name = given !== "" && Array.from(given).length <= NAME_MAX && !NAME_UNSAFE.test(given) ? given : "Unnamed person";
  return {
    developerId: row["personId"], name, role: row["role"],
    ...(typeof row["email"] === "string" && row["email"].length <= EMAIL_MAX && !NAME_UNSAFE.test(row["email"]) ? { email: row["email"] } : {}),
    ...(typeof row["joinedAt"] === "string" && Number.isFinite(Date.parse(row["joinedAt"])) ? { joinedAt: row["joinedAt"] } : {}),
  };
}

/** `GET /org/members`: the company's current people, every page of Code's list (bounded), or a refusal of the whole list. */
async function listMembers(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return MEMBER_WORDS.listNotAdmin;
  const members: ListedMember[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MEMBER_LIST_PAGES_MAX) return MEMBER_WORDS.listTooLong;
    const query = new URLSearchParams({ limit: String(PAGE), ...(cursor === undefined ? {} : { cursor }) });
    let answer: unknown;
    try {
      answer = await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}?${query.toString()}`);
    } catch (error) {
      if (!(error instanceof CodeError)) throw error;
      return error.status === 404 || error.status === 403 ? MEMBER_WORDS.listNotAdmin : MEMBER_WORDS.listUnavailable;
    }
    if (!plain(answer) || !Array.isArray(answer["members"]) || answer["members"].length > PAGE || typeof answer["more"] !== "boolean") return MEMBER_WORDS.listUnavailable;
    for (const row of answer["members"] as unknown[]) {
      const member = listed(row, who.companyId);
      if (member === undefined) return MEMBER_WORDS.listUnavailable;
      if (member === "revoked" || seen.has(member.developerId)) continue;
      seen.add(member.developerId);
      members.push(member);
    }
    if (!answer["more"]) break;
    const next = answer["cursor"];
    if (typeof next !== "string" || !CURSOR.test(next) || next === cursor) return MEMBER_WORDS.listUnavailable;
    cursor = next;
  }
  return { status: 200, body: { members } };
}

/** Every answer the removal routes give other than success. Fixed words only. */
export const REMOVAL_WORDS = Object.freeze({
  notAdmin: refusal(403, "FORBIDDEN", "Only a company owner or admin can remove people."),
  notFound: refusal(404, "NOT_FOUND", "That person isn't in your company."),
  self: refusal(403, "FORBIDDEN", "You can't remove yourself. Ask another owner or admin."),
  ownerOnly: refusal(403, "FORBIDDEN", "Only an owner can remove an owner."),
  successor: refusal(409, "SUCCESSOR_INVALID", "Pick someone who is still in the company to take over."),
  stale: refusal(409, "CHANGE_STALE", "Company members changed. Reload and review the removal again."),
  reused: refusal(409, "IDEMPOTENCY_CONFLICT", "Use a new request id for a different removal."),
  lastOwner: refusal(409, "LAST_OWNER", "A company needs at least one owner. Make someone else an owner first."),
  removed: refusal(409, "MEMBER_ALREADY_REMOVED", "That person was already removed."),
  tooMuch: refusal(409, "HANDOVER_TOO_BIG", "This person owns too much to hand over in one go. Hand some of it over first."),
  badBody: refusal(400, "CONFIG_INVALID", "Send a request id, the person's role and who takes over."),
  badQuery: refusal(400, "CONFIG_INVALID", "Pick who takes over from the list."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The removal couldn't be finished just now. Try the removal again: nothing is handed over twice."),
  previewUnavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The removal couldn't be previewed just now. Try again."),
  noPending: refusal(404, "NOT_FOUND", "There's no hand-over waiting for this person."),
  inProgress: refusal(409, "HANDOVER_IN_PROGRESS", "This removal is still being made. Try again in a few minutes."),
  finishBody: refusal(400, "CONFIG_INVALID", "Send a request id and who takes over."),
  finishUnavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The hand-over couldn't be finished just now. Try again: nothing is handed over twice."),
  pendingUnavailable: refusal(503, "RUNTIME_UNAVAILABLE", "Hand-overs waiting to be finished couldn't be read just now. Try again."),
});
/** Code's own fixed words for a removal that is too big to hand over (company-member-handover.ts HANDOVER_TOO_BIG, company-member-routes.ts TOO_MUCH_WORK). */
const CODE_TOO_MUCH = new Set(["This person owns too much to hand over in one go. Hand some of it over first.", "This person has too much work to show in one preview. Hand some of it over first."]);
const CODE_OWNER_ONLY_REMOVAL = CODE_OWNER_ONLY;

/** Code's refusal of a removal or its preview, as one of the fixed answers above. */
export function removalRefusal(error: CodeError, preview = false): RouteAnswer {
  const { code, message } = codeRefusal(error);
  if (error.status === 404 && message === CODE_NOT_ADMIN) return REMOVAL_WORDS.notAdmin;
  if (error.status === 404) return REMOVAL_WORDS.notFound;
  if (code === "SUCCESSOR_INVALID") return REMOVAL_WORDS.successor;
  if (code === "CHANGE_STALE") return REMOVAL_WORDS.stale;
  if (code === "IDEMPOTENCY_CONFLICT") return REMOVAL_WORDS.reused;
  if (code === "LAST_OWNER") return REMOVAL_WORDS.lastOwner;
  if (code === "MEMBER_ALREADY_REMOVED") return REMOVAL_WORDS.removed;
  if (message !== undefined && CODE_TOO_MUCH.has(message)) return REMOVAL_WORDS.tooMuch;
  if (error.status === 403 && message === CODE_OWN_MEMBERSHIP) return REMOVAL_WORDS.self;
  if (error.status === 403 && message === CODE_OWNER_ONLY_REMOVAL) return REMOVAL_WORDS.ownerOnly;
  if (error.status === 403) return REMOVAL_WORDS.notAdmin;
  if (error.status === 400) return preview ? REMOVAL_WORDS.badQuery : REMOVAL_WORDS.badBody;
  return preview ? REMOVAL_WORDS.previewUnavailable : REMOVAL_WORDS.unavailable;
}

const COUNT_MAX = 1000;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, COUNT_MAX) : undefined;
const shownName = (value: unknown): string => {
  const given = typeof value === "string" ? value.trim() : "";
  return given !== "" && Array.from(given).length <= NAME_MAX && !NAME_UNSAFE.test(given) ? given : "Unnamed person";
};
const plural = (n: number, one: string, many = `${one}s`) => `${n >= COUNT_MAX ? "1000+" : String(n)} ${n === 1 ? one : many}`;

/** `GET /org/members/{personId}/removal-preview[?successorId=]`: Code's preview as the app's removal preview (MemberRemovalPreviewSchema). */
async function removalPreview(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return REMOVAL_WORDS.notAdmin;
  const personId = context.params[0] ?? "";
  if (!PERSON_ID.test(personId)) return REMOVAL_WORDS.notFound;
  if (personId === who.developerId) return REMOVAL_WORDS.self;
  const keys = [...context.query.keys()];
  const successorId = context.query.get("successorId") ?? who.developerId;
  if (keys.some((key) => key !== "successorId") || keys.length > 1 || !PERSON_ID.test(successorId)) return REMOVAL_WORDS.badQuery;
  let answer: unknown;
  try {
    answer = await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}/${personId}/removal-preview?${new URLSearchParams({ successorId }).toString()}`);
  } catch (error) {
    if (error instanceof CodeError) return removalRefusal(error, true);
    throw error;
  }
  const handOver = plain(answer) && plain(answer["handOver"]) ? answer["handOver"] : undefined;
  const successor = plain(answer) && plain(answer["successor"]) ? answer["successor"] : undefined;
  const agents = count(handOver?.["agents"]), chains = count(handOver?.["chains"]), projects = handOver?.["projects"] === undefined ? 0 : count(handOver["projects"]), tasks = count(handOver?.["tasks"]), tasksLeft = count(handOver?.["tasksLeft"]);
  const role = plain(answer) ? answer["role"] : undefined;
  const owned = plain(answer) && Array.isArray(answer["ownedProjects"]) ? answer["ownedProjects"] : undefined;
  const grants = plain(answer) && Array.isArray(answer["projectGrants"]) ? answer["projectGrants"] : undefined;
  if (!plain(answer) || answer["personId"] !== personId || !isRole(role) || successor?.["personId"] !== successorId
    || agents === undefined || chains === undefined || projects === undefined || tasks === undefined || tasksLeft === undefined || owned === undefined || grants === undefined) return REMOVAL_WORDS.previewUnavailable;
  const warnings = [
    ...(tasksLeft > 0 ? [`${plural(tasksLeft, "open task")} can't go to them (no access to the project) and will wait for someone with access to take over.`] : []),
  ];
  return { status: 200, body: {
    member: { developerId: personId, name: shownName(answer["name"]), role },
    successor: { developerId: successorId, name: shownName(successor["name"]) },
    moves: { agents, skills: 0, chains, triggers: 0, approvals: 0, spendRequests: 0, tasks, projects },
    ends: ["Their access to this company and its work", "Their sign-ins to Rovara for this company", "Their GitHub link in this company"],
    duties: { wasRole: role, projectGrants: Math.min(grants.length + owned.length, COUNT_MAX), maintainerProjects: Math.min(Math.max(owned.length - projects, 0), COUNT_MAX), invitesCreated: 0 },
    warnings,
  } };
}

/** `POST /org/members/{personId}/removal` with the app's body `{ requestId, expectedRole, successorId? }`. */
async function removeMember(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return REMOVAL_WORDS.notAdmin;
  const body = context.body;
  if (!plain(body) || !Object.keys(body).every((key) => key === "requestId" || key === "expectedRole" || key === "successorId")
    || typeof body["requestId"] !== "string" || !UUID.test(body["requestId"]) || !isRole(body["expectedRole"])
    || (Object.hasOwn(body, "successorId") && (typeof body["successorId"] !== "string" || !PERSON_ID.test(body["successorId"])))) return REMOVAL_WORDS.badBody;
  const personId = context.params[0] ?? "";
  if (!PERSON_ID.test(personId)) return REMOVAL_WORDS.notFound;
  if (personId === who.developerId) return REMOVAL_WORDS.self;
  if (body["expectedRole"] === "owner" && who.companyRole !== "owner") return REMOVAL_WORDS.ownerOnly;
  const successorId = typeof body["successorId"] === "string" ? body["successorId"] : who.developerId;
  if (successorId === personId) return REMOVAL_WORDS.successor;
  let answer: unknown;
  try {
    answer = await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}/${personId}/removal`, { method: "POST", body: { requestId: body["requestId"], expectedRole: body["expectedRole"], successorId } });
  } catch (error) {
    if (error instanceof CodeError) return removalRefusal(error);
    throw error;
  }
  const moved = plain(answer) && plain(answer["moved"]) ? answer["moved"] : undefined;
  const agents = count(moved?.["agents"]), chains = count(moved?.["chains"]), projects = moved?.["projects"] === undefined ? 0 : count(moved["projects"]), tasks = count(moved?.["tasks"]), tasksLeft = count(moved?.["tasksLeft"]);
  if (!plain(answer) || answer["state"] !== "DONE" || typeof answer["removalId"] !== "string" || answer["removalId"] !== body["requestId"].toLowerCase()
    || typeof answer["successorId"] !== "string" || !PERSON_ID.test(answer["successorId"]) || agents === undefined || chains === undefined || projects === undefined || tasks === undefined || tasksLeft === undefined) return REMOVAL_WORDS.unavailable;
  // DEC 254zzz101: an owner or admin may have finished this removal's hand-over to someone else (it had stopped); that is a finished removal too.
  const finishedElsewhere = answer["successorId"] !== successorId;
  // Only after Code removed them: a removal Code refuses (an owner, a stale role, the last owner) withdraws nothing.
  // A withdrawal that could not be saved is not a finished removal: the screen retries with the same request id, which Code answers DONE again.
  const withdrawal = await withdrawForMember(context, personId, { companyId: who.companyId });
  if ("status" in withdrawal) return REMOVAL_WORDS.unavailable;
  await withdrawal.after();
  const handed = [agents > 0 && plural(agents, "agent"), chains > 0 && plural(chains, "chain"), projects > 0 && `admin of ${plural(projects, "project")}`, tasks > 0 && plural(tasks, "open task")].filter((part): part is string => part !== false);
  const message = finishedElsewhere ? "Removed from the company. Another owner or admin finished the hand-over."
    : `Removed from the company.${handed.length === 0 ? "" : ` Handed over ${handed.join(", ")}.`}${tasksLeft > 0 ? ` ${plural(tasksLeft, "open task")} wait for someone with access to take over.` : ""}`;
  return { status: 200, body: { removalId: answer["removalId"], state: "DONE", message } };
}

/** Code's fixed words for "nothing to finish" (company-member-routes.ts NO_PENDING_HANDOVER). */
const CODE_NO_PENDING = "this person has no hand-over waiting to be finished";
/** Code's fixed words for a removal still being made by its remover (company-member-routes.ts HANDOVER_IN_PROGRESS). */
const CODE_IN_PROGRESS = "this removal is still being made; try again in a few minutes";

/** `GET /org/members/handovers` (DEC 254zzz101): the removals whose hand-over is waiting, as the app's list, or a refusal of the whole list. */
async function pendingHandOvers(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return REMOVAL_WORDS.notAdmin;
  let answer: unknown;
  try {
    answer = await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}/handovers`);
  } catch (error) {
    if (!(error instanceof CodeError)) throw error;
    return error.status === 404 || error.status === 403 ? REMOVAL_WORDS.notAdmin : REMOVAL_WORDS.pendingUnavailable;
  }
  if (!plain(answer) || !Array.isArray(answer["handovers"]) || answer["handovers"].length > 100) return REMOVAL_WORDS.pendingUnavailable;
  const handovers = [];
  for (const row of answer["handovers"] as unknown[]) {
    if (!plain(row) || typeof row["personId"] !== "string" || !PERSON_ID.test(row["personId"]) || typeof row["removalId"] !== "string" || !UUID.test(row["removalId"])
      || typeof row["startedAt"] !== "string" || !Number.isFinite(Date.parse(row["startedAt"]))) return REMOVAL_WORDS.pendingUnavailable;
    handovers.push({ developerId: row["personId"], name: shownName(row["name"]), removalId: row["removalId"], startedAt: new Date(row["startedAt"]).toISOString() });
  }
  return { status: 200, body: { handovers } };
}

/** `POST /org/members/{personId}/handover` with `{ requestId, successorId }` (DEC 254zzz101): finish a stuck hand-over to someone picked now. */
async function finishHandOver(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return REMOVAL_WORDS.notAdmin;
  const body = context.body;
  if (!plain(body) || !Object.keys(body).every((key) => key === "requestId" || key === "successorId")
    || typeof body["requestId"] !== "string" || !UUID.test(body["requestId"]) || typeof body["successorId"] !== "string" || !PERSON_ID.test(body["successorId"])) return REMOVAL_WORDS.finishBody;
  const personId = context.params[0] ?? "";
  if (!PERSON_ID.test(personId)) return REMOVAL_WORDS.notFound;
  if (personId === who.developerId) return REMOVAL_WORDS.self;
  const successorId = body["successorId"];
  if (successorId === personId) return REMOVAL_WORDS.successor;
  let answer: unknown;
  try {
    answer = await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}/${personId}/handover`, { method: "POST", body: { requestId: body["requestId"], successorId } });
  } catch (error) {
    if (!(error instanceof CodeError)) throw error;
    if (error.status === 404 && codeRefusal(error).message === CODE_NO_PENDING) return REMOVAL_WORDS.noPending;
    if (codeRefusal(error).message === CODE_IN_PROGRESS) return REMOVAL_WORDS.inProgress;
    const mapped = removalRefusal(error);
    return mapped === REMOVAL_WORDS.unavailable || mapped === REMOVAL_WORDS.badBody ? (mapped === REMOVAL_WORDS.badBody ? REMOVAL_WORDS.finishBody : REMOVAL_WORDS.finishUnavailable) : mapped;
  }
  const moved = plain(answer) && plain(answer["moved"]) ? answer["moved"] : undefined;
  const agents = count(moved?.["agents"]), chains = count(moved?.["chains"]), projects = moved?.["projects"] === undefined ? 0 : count(moved["projects"]), tasks = count(moved?.["tasks"]), tasksLeft = count(moved?.["tasksLeft"]);
  if (!plain(answer) || answer["state"] !== "DONE" || typeof answer["removalId"] !== "string" || !UUID.test(answer["removalId"]) || answer["successorId"] !== successorId
    || agents === undefined || chains === undefined || projects === undefined || tasks === undefined || tasksLeft === undefined) return REMOVAL_WORDS.finishUnavailable;
  // The removal that stopped never reached Cloud's withdrawal: withdraw the removed person's eval approvals now.
  const withdrawal = await withdrawForMember(context, personId, { companyId: who.companyId });
  if ("status" in withdrawal) return REMOVAL_WORDS.finishUnavailable;
  await withdrawal.after();
  const handed = [agents > 0 && plural(agents, "agent"), chains > 0 && plural(chains, "chain"), projects > 0 && `admin of ${plural(projects, "project")}`, tasks > 0 && plural(tasks, "open task")].filter((part): part is string => part !== false);
  const message = `Hand-over finished.${handed.length === 0 ? " Nothing was left to hand over." : ` Handed over ${handed.join(", ")}.`}${tasksLeft > 0 ? ` ${plural(tasksLeft, "open task")} wait for someone with access to take over.` : ""}`;
  return { status: 200, body: { removalId: answer["removalId"], state: "DONE", message } };
}

/** The Members page's routes. They need only Code, so every Cloud serves them. */
export const MEMBER_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/members$/u, answer: listMembers },
  { method: "PUT", path: /^\/org\/members\/([^/]+)\/role$/u, answer: changeRole },
  { method: "GET", path: /^\/org\/members\/([^/]+)\/removal-preview$/u, answer: removalPreview },
  { method: "POST", path: /^\/org\/members\/([^/]+)\/removal$/u, answer: removeMember },
  { method: "GET", path: /^\/org\/members\/handovers$/u, answer: pendingHandOvers },
  { method: "POST", path: /^\/org\/members\/([^/]+)\/handover$/u, answer: finishHandOver },
];
