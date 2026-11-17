// Who is asking, and which company they are in (DEC 253z, 254; designs-2026-10-30/cloud-per-person-company-onboarding.md): the one place
// Cloud learns a person's company. The company and the person's role in it come only from Rovara Code's access check (`companyId`,
// `companyRole`, `companyName`), asked afresh, server to server, with the person's own token. Nothing the browser sends (a header, query,
// body or cookie) ever names a company, and there is no deployment-wide fallback: a Code answer with no company, or one that doesn't read,
// is refused with the one fixed answer below.
//
// A company admin is a person whose company role is owner or admin. Code's `administrator` flag means install administrator, never this.
import type { CodeAccess } from "./code-client.js";
import { COMPANY_ID } from "./company-store.js";
import type { RouteAnswer, RouteContext } from "./routes.js";

export type CompanyRole = "owner" | "admin" | "member";
export const COMPANY_ROLES: readonly CompanyRole[] = Object.freeze(["owner", "admin", "member"]);

/** The person's company as Code named it in its access check. */
export interface CompanyMembership {
  companyId: string;
  companyRole: CompanyRole;
  /** The company's own name, when Code sent a readable one (for display only). */
  companyName?: string;
}

/** The person, their company and their role in it, from Code's access check made now. */
export interface CompanyCaller extends CompanyMembership {
  developerId: string;
  name: string;
  /** The whole access answer, for the project list. */
  access: CodeAccess;
}

/** The one answer for a person Code names no company for (or names one that doesn't read). */
export const NOT_IN_COMPANY: RouteAnswer = Object.freeze({ status: 403, body: Object.freeze({ error: Object.freeze({ code: "NO_COMPANY", message: "You're not in a company yet." }) }) });
/** The name Cloud shows when Code sends none. */
export const COMPANY_NAME_FALLBACK = "Your company";

const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
const NAME_MAX = 200;
const NAME_UNSAFE = /[\p{Cc}\p{Cf}]/u;

/**
 * The company Code's access answer names, or undefined when it names none or any part doesn't read. A company id without a readable role is
 * refused as a whole (never a guessed role). The name is display only: one that doesn't read is left out, never refuses.
 */
export function companyOf(access: CodeAccess | undefined): CompanyMembership | undefined {
  if (access === undefined || access === null || typeof access !== "object") return undefined;
  const { companyId, companyRole, companyName } = access as { companyId?: unknown; companyRole?: unknown; companyName?: unknown };
  if (typeof companyId !== "string" || !COMPANY_ID.test(companyId)) return undefined;
  if (typeof companyRole !== "string" || !(COMPANY_ROLES as readonly string[]).includes(companyRole)) return undefined;
  const name = typeof companyName === "string" ? companyName.trim() : "";
  const readable = name.length > 0 && Array.from(name).length <= NAME_MAX && !NAME_UNSAFE.test(name);
  return { companyId, companyRole: companyRole as CompanyRole, ...(readable ? { companyName: name } : {}) };
}

/** Owner or admin of their company. */
export const isCompanyAdmin = (role: CompanyRole | undefined): boolean => role === "owner" || role === "admin";

/** The company name to show: Code's, else the fixed fallback. */
export const companyNameOf = (membership: CompanyMembership): string => membership.companyName ?? COMPANY_NAME_FALLBACK;

/** The person and their company from Code's access check made now; NOT_IN_COMPANY when Code names none. */
export async function companyCaller(context: Pick<RouteContext, "client" | "session">): Promise<CompanyCaller | RouteAnswer> {
  const access = await context.client.access(context.session);
  const membership = companyOf(access);
  if (membership === undefined || typeof access.developerId !== "string" || !DEVELOPER_ID.test(access.developerId)) return NOT_IN_COMPANY;
  return { ...membership, developerId: access.developerId, name: access.displayName, access };
}

/** A route's refusal rather than a caller. */
export const refused = (value: CompanyCaller | RouteAnswer): value is RouteAnswer => "status" in value;
