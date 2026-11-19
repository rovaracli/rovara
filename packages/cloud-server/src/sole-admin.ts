// DEC 254zzz79 (2): the second-person rule for LOOSENING limits and settings applies only while the company has TWO OR MORE owners/admins. A company
// with exactly ONE live owner or admin lets that person approve their own loosening, and the audit line says so.
//
// "Live" and "at decision time": the count is read from Code's own member list (as the signed-in person, in their company; Code scopes it) on every
// decision, never cached or taken from a stored proposal. A person Code lists as removed (`revokedAt`) does not count. Anything that does not read
// (a page that fails, a row of another company, a malformed row, more pages than the member list reads) is "could not tell", and then the rule stays
// as strict as before: a second person is needed. The caller must be the one owner/admin: a company of one is the caller's.
import { isCompanyAdmin, type CompanyRole } from "./company-caller.js";
import { CODE_MEMBERS_PATH, MEMBER_LIST_PAGES_MAX } from "./member-routes.js";
import type { RouteContext } from "./routes.js";

/** The audit line (a record's `detail`) of a loosening its own proposer approved because nobody else could. */
export const SELF_APPROVED_ONLY_ADMIN = "self-approved: only owner/admin";

const PAGE = 100;
const PERSON_ID = /^[a-f0-9]{64}$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** The company's live owners and admins (their person ids), or undefined when the list could not be read whole. */
export async function liveCompanyAdmins(context: Pick<RouteContext, "client" | "session">, companyId: string): Promise<Set<string> | undefined> {
  const admins = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MEMBER_LIST_PAGES_MAX; page += 1) {
    let answer: unknown;
    try {
      const query = new URLSearchParams({ limit: String(PAGE), ...(cursor === undefined ? {} : { cursor }) });
      answer = await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}?${query.toString()}`);
    } catch {
      return undefined;
    }
    if (!plain(answer) || !Array.isArray(answer["members"]) || answer["members"].length > PAGE || typeof answer["more"] !== "boolean") return undefined;
    for (const row of answer["members"] as unknown[]) {
      if (!plain(row) || row["companyId"] !== companyId || typeof row["personId"] !== "string" || !PERSON_ID.test(row["personId"]) || typeof row["role"] !== "string") return undefined;
      if (row["revokedAt"] !== undefined) continue;
      if (row["role"] === "owner" || row["role"] === "admin") admins.add(row["personId"]);
    }
    if (!answer["more"]) return admins;
    const next = answer["cursor"];
    if (typeof next !== "string" || !CURSOR.test(next) || next === cursor) return undefined;
    cursor = next;
  }
  return undefined;
}

/**
 * Whether this caller is the company's ONLY live owner or admin right now, so the second-person rule does not apply to them. False for anything else:
 * two or more admins, a caller who is not an admin (or not in the list), or a list that could not be read.
 */
export async function isSoleCompanyAdmin(context: Pick<RouteContext, "client" | "session">, who: { companyId: string; developerId: string; companyRole: CompanyRole }): Promise<boolean> {
  if (!isCompanyAdmin(who.companyRole)) return false;
  const admins = await liveCompanyAdmins(context, who.companyId);
  return admins !== undefined && admins.size === 1 && admins.has(who.developerId);
}
