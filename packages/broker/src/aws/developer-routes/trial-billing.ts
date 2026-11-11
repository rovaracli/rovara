// Trial and billing reads (lane srv/trial-reads; design doc briefs/trial-billing-api.md). READS ONLY, plus `available: false` for billing. The provider, auto-billing and the abuse limits are programme M.
//   GET /v1/app/trial                          any live member of the company: the phase, the allowances (models in US dollars, machine time in hours, both renewing monthly today), what is used and left, and what ends it.
//                                              Edition gate only (Enterprise has no trial: not found). Does NOT need the billing switch.
//   GET /v1/app/org/billing                    [owner or admin, switch `bl`] `available: false`, the plan, the phase and the monthly limit auto-billing would be held to. No provider part exists to return.
//   GET /v1/app/org/billing/invoices           [owner or admin, switch `bl`] an empty list (no invoice exists until a provider does). `?limit=1..50&cursor=` are checked, not used.
// Every figure is read for the CALLER's company (`caller.orgId`, from the verified session); a request carries no company, and a query or header that names one is ignored. The role is read live
// (`requireLiveCompanyAdmin`: the member row, the person's pointer, the sign-in identity and the open company, all now), never taken from a token's claim. With the switch off, or on an edition with no
// trial, the two billing paths are "not found" for everyone, owner or not, as any unknown path. `org` is a browser route family and `trial` was added to it, so the app reaches these as `/v1/web/...`;
// a token may read them by role. The POST of programme M is not here: any other method is not found. Answers are fixed words, numbers and ids; never a card, a provider id or a token.
import { AgentXError, agentXError, type OrgId } from "@agentx/contracts";
import { InvoiceListSchema, INVOICES_MAX_PAGE } from "@agentx/contracts";
import { orgTrial } from "../../app-nav/nav.js";
import { listOrganizationMembers } from "../../org/directory.js";
import { billingEnabled } from "../../org/billing-switch.js";
import { requireLiveCompanyAdmin } from "../../org/company-authority.js";
import { readOrgAndMemberFigures } from "../../spend/routes.js";
import { trialAvailable } from "../../org/trial-availability.js";
import { asksAnAdmin, buildBillingState, buildTrialView, machineAllowance, modelsAllowance, type OrgTrialFacts } from "../../org/trial-view.js";
import { readMachineAllowance } from "../../org/trial.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TRIAL_PATH = "/v1/app/trial";
export const BILLING_PATH = "/v1/app/org/billing";
export const BILLING_INVOICES_PATH = "/v1/app/org/billing/invoices";

const notFound = () => agentXError("NOT_FOUND", "route not found");

async function orgFacts(deps: DeveloperRouteDependencies, orgId: OrgId): Promise<OrgTrialFacts> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const org = await deps.orgs.getOrg(orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");
  // The trial lock and the machine-time allowance are enforced only on a cloud install (admission.ts); elsewhere there is no `locked` phase and no machine meter to show.
  const trial = deps.cloud === true ? orgTrial(org) : undefined;
  return { plan: org.plan, trialState: trial?.state };
}

const monthOfNow = (now: number): string => new Date(now).toISOString().slice(0, 7);

async function getTrial(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<StatusReply> {
  const org = await orgFacts(deps, caller.orgId);
  const now = deps.now();
  const month = monthOfNow(now);
  const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: () => now };
  const [figures, machine] = await Promise.all([
    readOrgAndMemberFigures({ documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.cloud === true ? { cloud: true } : {}) }, { orgId: caller.orgId, developerId: caller.developerId }, month),
    deps.cloud === true ? readMachineAllowance(table, caller.orgId) : Promise.resolve(undefined),
  ]);
  const input = { org, role: caller.orgRole, month, models: modelsAllowance(figures.org, month), machine: machineAllowance(machine), member: figures.member };
  const view = buildTrialView(input);
  if (!asksAnAdmin(view)) return new StatusReply(200, view);
  // The names to ask: the company's owners and admins, as the member list shows them to any member.
  const { members } = await listOrganizationMembers(deps, caller);
  const admins = members.filter((member) => member.role === "owner" || member.role === "admin").map((member) => ({ id: member.developerId, name: member.name }));
  return new StatusReply(200, buildTrialView(input, admins));
}

async function requireBillingReader(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<void> {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "Billing is not available here.");
  await requireLiveCompanyAdmin({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName }, { orgId: caller.orgId, developerId: caller.developerId });
}

async function getBilling(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<StatusReply> {
  await requireBillingReader(deps, caller);
  const org = await orgFacts(deps, caller.orgId);
  const month = monthOfNow(deps.now());
  const { org: figures } = await readOrgAndMemberFigures({ documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.cloud === true ? { cloud: true } : {}) }, { orgId: caller.orgId, developerId: caller.developerId }, month);
  return new StatusReply(200, buildBillingState({ org, monthlyLimitUsd: figures.limitUsd }));
}

/** `?limit=` is a whole number 1 to 50, `?cursor=` text up to 2,000 characters; anything else, and any other parameter, is refused. Nothing is listed yet, so neither changes the answer. */
function checkInvoiceQuery(url: URL): void {
  for (const [key, value] of url.searchParams) {
    if (key === "limit" && /^[0-9]{1,3}$/u.test(value) && Number(value) >= 1 && Number(value) <= INVOICES_MAX_PAGE) continue;
    if (key === "cursor" && value.length >= 1 && value.length <= 2000) continue;
    throw agentXError("CONFIG_INVALID", "limit is a whole number from 1 to 50, and cursor is the next value of the last page");
  }
}

async function getInvoices(deps: DeveloperRouteDependencies, caller: DeveloperCaller, url: URL): Promise<StatusReply> {
  await requireBillingReader(deps, caller);
  checkInvoiceQuery(url);
  return new StatusReply(200, InvoiceListSchema.parse({ invoices: [] }));
}

/** Answers `undefined` for a path that is not one of these (or any method but GET), so the dispatch goes on to the next route family and ends in "not found". */
export async function routeTrialBilling(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  const path = url.pathname;
  if (path !== TRIAL_PATH && path !== BILLING_PATH && path !== BILLING_INVOICES_PATH) return undefined;
  if (request.method !== "GET") return undefined;
  // No edition with a trial, no trial and no billing.
  if (!trialAvailable(deps.editionPolicy)) throw notFound();
  if (path !== TRIAL_PATH && !billingEnabled(env)) throw notFound();
  try {
    if (path === TRIAL_PATH) return await getTrial(deps, caller);
    return await (path === BILLING_PATH ? getBilling(deps, caller) : getInvoices(deps, caller, url));
  } catch (error) {
    // A store fault is a retryable 503 with a fixed sentence: never the fault's own text, and never a plausible answer.
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "The trial and billing figures could not be read. Try again.");
  }
}
