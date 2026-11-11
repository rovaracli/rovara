// Company domain verification (owner decision 2026-11-02): the owner-only "Company domains" routes.
//
//   GET  /v1/app/org/domains           the company's domains and the record to publish for each
//   POST /v1/app/org/domains           claims a domain          { domain }   a live browser session, a fresh sign-in and the audit ledger; the record is in the same transaction
//   POST /v1/app/org/domains/check     looks at the record now  { domain }   a live browser session; rate limited (it makes a DNS lookup)
//   POST /v1/app/org/domains/remove    gives the domain up      { domain }   a live browser session, a fresh sign-in and the audit ledger
//
// Only an owner: a domain decides whose email counts as the company's, which later decides who may be linked to a tracker account. There is no edition gate: Public, Cloud and Enterprise all have it.
// Nothing here repeats what the owner typed: refusals are fixed sentences.
import { AUDIT_ERROR_MESSAGES, COMPANY_DOMAIN_LOST_AFTER_DAYS, COMPANY_DOMAIN_MAX_PER_ORG, CompanyDomainBodySchema } from "@agentx/cloud-contracts";
import { agentXError, orgScoped } from "@rovara-code/contracts";
import { takeRateAt } from "../../developer/page-comments.js";
import { isFreshSignIn, type SessionRecord } from "../../developer/store.js";
import { normalizeCompanyDomain, type DomainRefusal } from "../../org/company-domains/normalize.js";
import { nodeTxtResolver, type TxtResolver } from "../../org/company-domains/resolver.js";
import { addCompanyDomain, checkCompanyDomain, listEntries, removeCompanyDomain, toView } from "../../org/company-domains/store.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { getSignIn } from "./authentication.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const COMPANY_DOMAINS_PATH = "/v1/app/org/domains";
const CHECK_PATH = `${COMPANY_DOMAINS_PATH}/check`;
const REMOVE_PATH = `${COMPANY_DOMAINS_PATH}/remove`;
export const isCompanyDomainsRoute = (pathname: string): boolean => pathname === COMPANY_DOMAINS_PATH || pathname === CHECK_PATH || pathname === REMOVE_PATH;

export const COMPANY_DOMAINS_FRESH_SIGN_IN_MESSAGE = "Sign in again to change company domains.";
/** Changes and checks a minute, for the whole company: a check makes a DNS lookup. */
export const COMPANY_DOMAINS_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;

export const DOMAIN_REFUSAL_MESSAGES: Readonly<Record<DomainRefusal, string>> = {
  not_a_name: "That is not a domain name. Type it like example.com, without https:// or a path.",
  ip_address: "An IP address is not a company domain.",
  public_suffix: "That is a public suffix shared by many companies, not one company's domain. Use your own, such as example.com.",
  lookalike: "That name has letters that look like the letters of another name, or that are written differently when stored. Use the plain form of the domain.",
};

let defaultResolver: TxtResolver | undefined;
const resolverOf = (deps: DeveloperRouteDependencies): TxtResolver => deps.domainResolver ?? (defaultResolver ??= nodeTxtResolver());

/** A change needs a live browser session AND a sign-in made within the last few minutes. */
async function requireFreshBrowserWrite(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<void> {
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session to change company domains.");
  const session = await getSignIn<Pick<SessionRecord, "authTime">>(deps, `SESSION#${caller.sessionId}`);
  if (session === undefined || !isFreshSignIn(session, deps.now())) throw agentXError("REAUTH_REQUIRED", COMPANY_DOMAINS_FRESH_SIGN_IN_MESSAGE);
}

function parseBody(request: AdaptedHttpRequest): string {
  const parsed = CompanyDomainBodySchema.safeParse(jsonBody(request));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "The domain is missing or the request has a field this route does not take.");
  const domain = normalizeCompanyDomain(parsed.data.domain);
  if (!domain.ok) throw agentXError("CONFIG_INVALID", DOMAIN_REFUSAL_MESSAGES[domain.reason]);
  return domain.domain;
}

async function throttle(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<void> {
  let accepted: boolean;
  try { accepted = await takeRateAt({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, { pk: orgScoped(caller.orgId, "COMPANY_DOMAIN_WRITES"), sk: "ALL" }, COMPANY_DOMAINS_PER_MINUTE, RATE_WINDOW_MS); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "The domain could not be saved. Try again."); }
  if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many domain changes or checks. Try again in a minute.");
}

/** The reply, or undefined when the path is not one of these. */
export async function routeCompanyDomains(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, pathname: string): Promise<unknown> {
  if (!isCompanyDomainsRoute(pathname)) return undefined;
  const isGet = request.method === "GET" && pathname === COMPANY_DOMAINS_PATH;
  const isPost = request.method === "POST";
  if (!isGet && !isPost) throw agentXError("NOT_FOUND", "route not found");
  if (caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "Only a company owner can see or change company domains.");
  const store = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, audit: deps.audit };

  if (isGet) {
    return { domains: (await listEntries(store, caller.orgId)).map(toView), max: COMPANY_DOMAIN_MAX_PER_ORG, lostAfterDays: COMPANY_DOMAIN_LOST_AFTER_DAYS };
  }

  if (pathname === CHECK_PATH) {
    if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session to check company domains.");
    const domain = parseBody(request);
    await throttle(deps, caller);
    const outcome = await checkCompanyDomain(store, { orgId: caller.orgId, by: caller.developerId, domain, resolver: resolverOf(deps) });
    return { domain: toView(outcome.entry), result: outcome.result };
  }

  // Add and remove: a fresh sign-in, and a ledger to record the change in. A change that could not be recorded is not made.
  await requireFreshBrowserWrite(deps, caller);
  if (deps.audit === undefined) throw agentXError("AUDIT_UNAVAILABLE", AUDIT_ERROR_MESSAGES.AUDIT_UNAVAILABLE);
  const domain = parseBody(request);
  await throttle(deps, caller);
  if (pathname === REMOVE_PATH) {
    await removeCompanyDomain(store, { orgId: caller.orgId, by: caller.developerId, domain });
    return { removed: true };
  }
  const added = await addCompanyDomain(store, { orgId: caller.orgId, by: caller.developerId, domain });
  return { domain: toView(added.entry) };
}
