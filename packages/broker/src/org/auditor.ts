// Enterprise foundations, task I2: the Auditor role. It reads the audit log and exports it, and writes nothing anywhere.
//
// The guarantee is not "every role check remembers the new role". Hundreds of checks name `owner`, `admin` or `member`; almost all are positive lists, which
// refuse an Auditor by construction, but one `role !== "member"` added later would not. So the route dispatcher asks `requireAuditorRoute` first, and the Auditor
// reaches nothing but the short list below. Everything else is unreachable for it, whatever the code behind the route does with a role.
import { agentXError } from "@rovara-code/contracts";
import { featureEnabled, isWriterOrgRole, requireFeature, type EditionPolicy, type WriterOrgRole } from "@agentx/cloud-contracts";

/** What an Auditor is told, and what the page and API say. Fixed text: it never echoes the path. */
export const AUDITOR_REFUSED = "The Auditor role can read the audit log and nothing else.";

interface AuditorRoute { readonly method: "GET" | "POST"; readonly path: RegExp; readonly what: string }

/**
 * The whole of what an Auditor can reach through `/v1/app/*` and `/v1/dev/*`. Every pattern is anchored at both ends and matched on the raw path, as the dispatcher's
 * own patterns are; a path that only looks like one of these (a trailing slash, another case, an encoded separator) matches none and is refused.
 */
export const AUDITOR_ALLOWED_ROUTES: readonly AuditorRoute[] = Object.freeze(([
  { method: "GET", path: /^\/v1\/(?:app|dev)\/org\/audit\/records$/, what: "read the audit log" },
  { method: "GET", path: /^\/v1\/(?:app|dev)\/org\/audit\/status$/, what: "read the audit log's status" },
  { method: "POST", path: /^\/v1\/(?:app|dev)\/org\/audit\/exports$/, what: "start an audit export" },
  { method: "GET", path: /^\/v1\/(?:app|dev)\/org\/audit\/exports\/[A-Za-z0-9_-]{1,128}$/, what: "read an audit export" },
  { method: "GET", path: /^\/v1\/app\/me$/, what: "read their own identity" },
  { method: "GET", path: /^\/v1\/app\/install$/, what: "read the install's edition" },
  // Company memberships (brief section 9): the Auditor lists its own companies and switches its browser session between them, like anyone; inside each company its role there decides.
  { method: "GET", path: /^\/v1\/app\/companies$/, what: "list their own companies" },
  { method: "POST", path: /^\/v1\/app\/companies$/, what: "switch their browser session's company" },
  // Learning v2 L3b: the Auditor reads a project's active lessons and its sources, read-only. Not the weekly digest, a lesson's history or the queue (the routes give those to people who decide),
  // and no write: the approve, reject, retire, rollback and mark routes are not here.
  { method: "GET", path: /^\/v1\/app\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/lessons$/, what: "read a project's active lessons" },
  { method: "GET", path: /^\/v1\/app\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/lessons\/sources$/, what: "read a project's sources" },
] satisfies AuditorRoute[]).map((route) => Object.freeze(route)));

/** The three roles that existed before the Auditor. Anything else is not trusted to pass the gate untouched. */
const UNGATED_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "member"]);

/** Owners, admins and the Auditor read the audit log; no one else does. A value that is not a role is no one. */
export function canReadAuditLog(role: unknown): boolean {
  return role === "owner" || role === "admin" || role === "auditor";
}

/**
 * Called once per request, right after the caller is known. An owner, admin or member passes untouched. An Auditor passes only on the allow-list. A role this
 * release does not know is refused like an Auditor: a new role must be given a decision here, not inherit one.
 */
export function requireAuditorRoute(caller: { orgRole: string }, method: string, pathname: string): void {
  if (UNGATED_ROLES.has(caller.orgRole)) return;
  if (caller.orgRole === "auditor" && AUDITOR_ALLOWED_ROUTES.some((route) => route.method === method && route.path.test(pathname))) return;
  throw agentXError("FORBIDDEN", AUDITOR_REFUSED);
}

/**
 * The Auditor is an Enterprise feature. Called wherever the role is given (a role change, a group mapping) and wherever an Auditor's session is read: with no
 * edition known, or an edition without the feature, the answer is no.
 */
export function requireAuditorEdition(policy: EditionPolicy | undefined): void {
  if (policy === undefined) throw agentXError("FORBIDDEN", "This feature is part of the Enterprise edition.");
  requireFeature(policy, "auditorRole");
}

/** Whether the edition may hold an Auditor, without throwing. Unknown is no. */
export function auditorAllowedByEdition(policy: EditionPolicy | undefined): boolean {
  return policy !== undefined && featureEnabled(policy, "auditorRole");
}

/**
 * A caller that may write: its company role is one a writer can hold. Write paths that take a caller from outside the dispatcher (Slack, a background step) ask for this type, so a
 * caller that is an Auditor does not type-check as one; `requireWriterCaller` is where an unchecked caller becomes one, and it refuses the Auditor and any role it does not know.
 */
export type WriterCaller<Caller extends { orgRole: string }> = Omit<Caller, "orgRole"> & { orgRole: WriterOrgRole };
export function requireWriterCaller<Caller extends { orgRole: string }>(caller: Caller): WriterCaller<Caller> {
  if (!isWriterOrgRole(caller.orgRole)) throw agentXError("FORBIDDEN", AUDITOR_REFUSED);
  return caller as WriterCaller<Caller>;
}
