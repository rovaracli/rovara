// A small stand-in for the Company rules routes, for the browser journeys: one company, two admins, one waiting proposal at a time, and the rule that a person cannot approve their own proposal. It answers what the contract's schemas accept;
// the real routes, their audit and their limits are the broker's (and tested there). State lives for one test.
import type { Page, Route } from "@playwright/test";
import { CompanyRulesBodySchema, type CompanyRuleView } from "@agentx/contracts/web";
import { ADA, DIGEST, DIGEST2, OMAR, PROPOSAL_ID, RULES_14, currentVersion, diffOf, historyFor, memberState, proposalFor, stateFor, syncFor, syncSummary, versionViewFor } from "../../web/support/company-rules-fixture.js";

export type Viewer = "omar" | "ada";
export interface CompanyRulesMock {
 viewer: Viewer;
 version: number;
 rules: CompanyRuleView[];
 pending: { proposer: Viewer; rules: CompanyRuleView[]; note: string | null } | null;
 sync: boolean;
 requests: Array<{ method: string; action?: string; body?: unknown }>;
}
const who = (viewer: Viewer) => (viewer === "omar" ? OMAR : ADA);
const text = (value: unknown) => JSON.stringify(value);

export function companyRulesState(mock: CompanyRulesMock) {
 const pending = mock.pending === null ? null : proposalFor({
  rules: mock.pending.rules, ruleCount: mock.pending.rules.length, note: mock.pending.note, proposedBy: who(mock.pending.proposer), proposedByYou: mock.pending.proposer === mock.viewer, baseVersion: mock.version, digest: DIGEST2,
  diff: diffOf(mock.pending.rules.map((after, index) => (mock.rules[index] === undefined ? { kind: "added" as const, after } : mock.rules[index].text === after.text && mock.rules[index].priority === after.priority ? { kind: "same" as const, after } : { kind: "changed" as const, before: mock.rules[index], after }))),
  approval: mock.pending.proposer === mock.viewer ? { canApprove: false, reason: "you_proposed", freshSignInNeeded: true, soleOwner: { available: false, availableAt: "2026-11-13T06:00:00.000Z", reasonCode: "SOLE_OWNER_COOL_OFF" } } : { canApprove: true, reason: null, freshSignInNeeded: true, soleOwner: null },
 });
 return stateFor({ viewer: { role: mock.viewer === "omar" ? "owner" : "admin", canPropose: true, canDecide: true }, current: currentVersion({ version: mock.version, rules: mock.rules, ruleCount: mock.rules.length, approvedBy: mock.version === 1 ? { id: null, name: "Rovara setup" } : OMAR }), pending, sync: mock.sync ? syncSummary() : null });
}

export async function mockCompanyRules(page: Page, options: { off?: boolean; member?: boolean } = {}): Promise<CompanyRulesMock> {
 const mock: CompanyRulesMock = { viewer: "ada", version: 1, rules: RULES_14, pending: null, sync: false, requests: [] };
 await page.route(/\/v1\/(?:app|web)\/org\/company-rules/u, async (route: Route) => {
  const request = route.request(), url = new URL(request.url()), json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: text(body) });
  if (options.off === true) return json(404, { error: { code: "NOT_FOUND", message: "This item wasn't found, or you no longer have access." } });
  if (request.method() === "GET") {
   mock.requests.push({ method: "GET" });
   if (url.pathname.endsWith("/history")) return json(200, historyFor());
   if (url.pathname.endsWith("/sync")) return json(200, mock.sync ? syncFor() : { connected: false });
   const version = /\/versions\/(\d+)$/u.exec(url.pathname);
   if (version !== null) return json(200, versionViewFor(Number(version[1])));
   return json(200, options.member === true ? memberState() : companyRulesState(mock));
  }
  const parsed = CompanyRulesBodySchema.safeParse(request.postDataJSON());
  if (!parsed.success) return json(400, { error: { code: "CONFIG_INVALID", message: "The request was not understood." } });
  const body = parsed.data;
  mock.requests.push({ method: "POST", action: body.action, body });
  if (body.action === "propose") {
   if (mock.pending !== null) return json(409, { error: { code: "CHANGE_STALE", message: "A change is already waiting for a decision." } });
   if (body.baseVersion !== mock.version) return json(409, { error: { code: "CHANGE_STALE", message: "The company rules changed since you loaded them." } });
   mock.pending = { proposer: mock.viewer, rules: body.rules, note: body.note ?? null };
   return json(202, { status: "needs_approval", state: companyRulesState(mock) });
  }
  if (body.action === "approve" || body.action === "reject" || body.action === "cancel") {
   if (mock.pending === null || body.proposalId !== PROPOSAL_ID) return json(409, { error: { code: "CHANGE_STALE", message: "That proposal is no longer waiting." } });
   if (body.action === "cancel") { if (mock.pending.proposer !== mock.viewer) return json(403, { error: { code: "FORBIDDEN", message: "Only the person who proposed a change can cancel it." } });mock.pending = null;return json(200, { status: "cancelled", state: companyRulesState(mock) }); }
   if (mock.pending.proposer === mock.viewer) return json(403, { error: { code: "FORBIDDEN", message: "You proposed this change, so a different owner or admin has to decide it." } });
   if (body.expectedDigest !== DIGEST2) return json(409, { error: { code: "CHANGE_STALE", message: "The proposal changed." } });
   if (body.action === "approve") { mock.rules = mock.pending.rules;mock.version += 1; }
   mock.pending = null;
   return json(200, { status: body.action === "approve" ? "approved" : "rejected", state: companyRulesState(mock) });
  }
  if (body.action === "sync-connect") { mock.sync = true;return json(200, { status: "done", state: companyRulesState(mock) }); }
  mock.sync = body.action === "sync-now";
  return json(200, { status: "done", state: companyRulesState(mock) });
 });
 return mock;
}
export { DIGEST };
