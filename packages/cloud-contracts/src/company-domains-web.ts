// Company domain verification (owner decision 2026-11-02): the constants and web contracts of the "Company domains" routes. Their own module, so the web bundle loads them with the lazy admin screen
// that uses them (packages/web/vite.config.ts, the initial JS budget).
//
// A company proves it controls an email domain by publishing a TXT record Rovara gave it. The record goes on `_rovara-verify.<domain>` (not the apex: the apex often holds records the company's mail
// and hosting providers own, and a name below it can be delegated or edited without touching them). Its value is `rovara-verify=<token>`; only an exact match counts.
import { z } from "zod";
import { forwardReader } from "@rovara-code/contracts";

/** The first label of the name the record goes on: `_rovara-verify.acme.example`. */
export const COMPANY_DOMAIN_RECORD_LABEL = "_rovara-verify";
/** The value of the record is this and the token. */
export const COMPANY_DOMAIN_TXT_PREFIX = "rovara-verify=";
/** A verified domain whose record has been gone for this many days running is lost, and stops counting. */
export const COMPANY_DOMAIN_LOST_AFTER_DAYS = 3;
/** A claim nobody has verified is looked at once a day for this many days (Check now always works). A claim that is not verified blocks nobody: any number of companies may hold one for the same domain. */
export const COMPANY_DOMAIN_PENDING_DAYS = 7;
/** A lost domain keeps being looked at (the company that held it can verify it again by putting the record back) for this many days. */
export const COMPANY_DOMAIN_LOST_WATCH_DAYS = 30;
/** Another company takes a lost domain over only after its record, and only its record, has been in DNS for this long between two looks. */
export const COMPANY_DOMAIN_TAKEOVER_CONFIRM_MS = 3_600_000;
/** The most domains one company holds. */
export const COMPANY_DOMAIN_MAX_PER_ORG = 20;

export const CompanyDomainStateSchema = z.enum(["pending", "verified", "lost"]);
export type CompanyDomainState = z.infer<typeof CompanyDomainStateSchema>;

/**
 * What the last look at the name found: the token, no token, a CNAME where the record must be, the lookup itself failed (which never counts against a domain), or the company's record was
 * found but another company holds the domain and the rules for moving it have not been met ("held").
 */
export const CompanyDomainCheckResultSchema = z.enum(["found", "not_found", "indirect", "unavailable", "held"]);
export type CompanyDomainCheckResult = z.infer<typeof CompanyDomainCheckResultSchema>;

export const CompanyDomainViewSchema = z.object({
  domain: z.string().min(1).max(253),
  state: CompanyDomainStateSchema,
  /** The record to add: the name, the type and the exact value. */
  record: z.object({ type: z.literal("TXT"), name: z.string().max(300), value: z.string().max(200) }).strict(),
  addedAt: z.string().datetime(),
  verifiedAt: z.string().datetime().optional(),
  lastCheckedAt: z.string().datetime().optional(),
  lastResult: CompanyDomainCheckResultSchema.optional(),
  /** Since when a verified domain's record has not been found; it is lost three days after. */
  missingSince: z.string().datetime().optional(),
  lostAt: z.string().datetime().optional(),
}).strict();
export type CompanyDomainView = z.infer<typeof CompanyDomainViewSchema>;

/** `GET /v1/app/org/domains`. */
export const CompanyDomainsAnswerSchema = z.object({
  domains: z.array(CompanyDomainViewSchema).max(COMPANY_DOMAIN_MAX_PER_ORG),
  max: z.number().int().min(1),
  lostAfterDays: z.number().int().min(1),
}).strict();
export const CompanyDomainsAnswerReaderSchema = forwardReader(CompanyDomainsAnswerSchema);
export type CompanyDomainsAnswer = z.infer<typeof CompanyDomainsAnswerSchema>;

/** The body of `POST /v1/app/org/domains` (add), `.../domains/check` and `.../domains/remove`: the domain as the owner typed it. */
export const CompanyDomainBodySchema = z.object({ domain: z.string().min(1).max(300) }).strict();
export type CompanyDomainBody = z.infer<typeof CompanyDomainBodySchema>;

/** The answer of add and check: the domain as stored now, and (for a check) what the look found. */
export const CompanyDomainChangeAnswerSchema = z.object({ domain: CompanyDomainViewSchema, result: CompanyDomainCheckResultSchema.optional() }).strict();
export const CompanyDomainChangeAnswerReaderSchema = forwardReader(CompanyDomainChangeAnswerSchema);

/** The answer of remove. */
export const CompanyDomainRemovedAnswerSchema = z.object({ removed: z.literal(true) }).strict();
export const CompanyDomainRemovedAnswerReaderSchema = forwardReader(CompanyDomainRemovedAnswerSchema);
