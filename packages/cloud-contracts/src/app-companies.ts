// Company memberships (srv/company-memberships; design: briefs/company-memberships-api.md sections 3 to 6, owner decision 91): what the browser reads and sends for the company switcher, `/v1/app/companies`.
// A "company" is an organisation (`org_` plus 20 base36); the word is the UI's, "org" is the code's. The answers carry the caller's OWN memberships only (a name, a role, when they joined and which one is
// active), never another person and never anything read inside a company the session is not in. Strict shapes for what the server answers, `forwardReader` readers for what the app reads.
// Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { OrgIdSchema, forwardReader } from "@rovara-code/contracts";

/** At most this many companies are listed (brief section 4). */
export const COMPANIES_MAX = 20;
/** The request header that names the company a page believes it is in, and the response header that names the company an answer is for. */
export const COMPANY_REQUEST_HEADER = "x-rovara-company";
/** What a browser request is told when the company it names is not the session's active company, or when it names none while its company's switcher is on (the stale-tab rule). Fixed words. */
export const COMPANY_STALE_MESSAGE = "Your company changed in another tab. Reloading.";
/** What a token, the CLI or Slack is told when it asks to switch: a machine credential is bound to one company. */
export const COMPANY_SWITCH_MACHINE_MESSAGE = "This sign-in is bound to one company. Sign in again to use another.";

export const CompanyRoleNameSchema = z.enum(["owner", "admin", "member", "auditor"]);

/** One of the caller's memberships. `status` is `closing` while the company's last owner is leaving it; a closed company is not listed. */
export const CompanyMembershipSchema = z.object({
  companyId: OrgIdSchema,
  name: z.string().min(1).max(200),
  role: CompanyRoleNameSchema,
  joinedAt: z.string().max(40),
  active: z.boolean(),
  status: z.enum(["open", "closing"]),
}).strict();
export type CompanyMembership = z.infer<typeof CompanyMembershipSchema>;

/** `GET /v1/app/companies`: the active company first, then by name. A token answers for the one company it is bound to. */
export const CompaniesAnswerSchema = z.object({
  activeCompanyId: OrgIdSchema,
  companies: z.array(CompanyMembershipSchema).min(1).max(COMPANIES_MAX),
  limits: z.object({ maxCompanies: z.number().int().positive() }).strict(),
  canCreate: z.literal(false),
  canJoinByInvite: z.boolean(),
}).strict();
export type CompaniesAnswer = z.infer<typeof CompaniesAnswerSchema>;
export const CompaniesAnswerReaderSchema = forwardReader(CompaniesAnswerSchema);

/** `POST /v1/app/companies` from a live browser session. Only `switch` is offered in this release; joining by invite is a later step (brief section 7). */
export const CompanySwitchBodySchema = z.object({
  action: z.literal("switch"),
  companyId: OrgIdSchema,
  requestId: z.string().uuid(),
}).strict();
export type CompanySwitchBody = z.infer<typeof CompanySwitchBodySchema>;

/** The answer of a switch: the list as `GET` answers it now, and `me`, the `/v1/app/me` answer for the session's active company, so the page replaces its cache in one step. */
export const CompanySwitchAnswerSchema = z.object({
  status: z.literal("done"),
  activeCompanyId: OrgIdSchema,
  companies: z.array(CompanyMembershipSchema).min(1).max(COMPANIES_MAX),
  me: z.unknown(),
}).strict();
export type CompanySwitchAnswer = z.infer<typeof CompanySwitchAnswerSchema>;
export const CompanySwitchAnswerReaderSchema = forwardReader(CompanySwitchAnswerSchema);
