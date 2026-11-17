// The Members page's routes (guided onboarding PR 12a; design section 4; DEC 254j, 254l items 2 and 9): the company's people and roles, and a
// role change, both answered by Rovara Code's own member routes as the signed-in person, with their own token:
//
//   GET /v1/app/org/members                    -> GET /v1/dev/company/members[?cursor=&limit=100], page by page, at most MEMBER_LIST_PAGES_MAX pages
//   PUT /v1/app/org/members/{personId}/role    -> PUT /v1/dev/company/members/{personId}/role  { role }
//
// Who: Code decides. The company is the one Code's live membership names for the person (Code reads it again on every call); the browser never
// names a company, and the person id is passed only as Code's path parameter. Cloud asks Code's access check first (company-caller.ts) and
// refuses early, in fixed words, what Code would refuse anyway: a person who is not a company owner or admin, their own role, an owner change by a
// non-owner, and a role change without a fresh step-up (step-up.ts; Code checks the same claims of the same token). Code alone answers
// "another company's person" (404, which reaches the app as one fixed sentence, the same as a missing person) and "the last owner" (Code refuses
// demoting or removing a company's last active owner inside its own transaction; Cloud only words it).
//
// Every answer is a fixed sentence; nothing the request carried and nothing Code worded is echoed. Code writes the company-log record of the change
// (with the person, the old and the new role).
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp, STEP_UP_WINDOW_SECONDS } from "./step-up.js";

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
  stepUp: refusal(403, "REAUTH_REQUIRED", "Confirm it's you again, then try once more."),
  lastOwner: refusal(409, "LAST_OWNER", "A company needs at least one owner. Make someone else an owner first."),
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
  if (code === "REAUTH_REQUIRED") return MEMBER_WORDS.stepUp;
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
  if (personId === who.developerId) return MEMBER_WORDS.self;
  // Owner changes are an owner's. The person's real role is Code's to know (it refuses an admin who changes an owner); the screen's `expectedRole`
  // only lets Cloud say so before asking for a step-up.
  if ((role === "owner" || body["expectedRole"] === "owner") && who.companyRole !== "owner") return MEMBER_WORDS.ownerOnly;
  if (freshStepUp(context.session.accessToken, context.now().getTime(), STEP_UP_WINDOW_SECONDS) === undefined) return MEMBER_WORDS.stepUp;
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

/** The Members page's routes. They need only Code, so every Cloud serves them. */
export const MEMBER_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/members$/u, answer: listMembers },
  { method: "PUT", path: /^\/org\/members\/([^/]+)\/role$/u, answer: changeRole },
];
