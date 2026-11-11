import type { Page, Request } from "@playwright/test";
// Fixtures for the company switcher (switch: localStorage `rovara.companies` = "v2"): the server's two company routes, and the company-specific parts of the answers the mock cell already gives.
// Nothing here is the real server: briefs/company-memberships-api.md is the agreement it will follow. The nav and Home answers are the mock cell's own, with the active company's name, project and card titles put on them,
// so a screen that kept one company's data after a switch would show another company's words.
export const ORG_A = "org_" + "a".repeat(20), ORG_B = "org_" + "b".repeat(20), ORG_C = "org_" + "c".repeat(20);
export interface MockCompany { id: string; name: string; role: "owner" | "admin" | "member" | "auditor"; project: string }
export const COMPANIES: MockCompany[] = [{ id: ORG_A, name: "Acme", role: "owner", project: "acme-payments" }, { id: ORG_B, name: "Beta Ltd", role: "member", project: "beta-search" }, { id: ORG_C, name: "Gamma", role: "auditor", project: "gamma-docs" }];
export const MACHINE_REFUSAL = "This sign-in is bound to one company. Sign in again to use another.";
const company = (item: MockCompany, active: boolean) => ({ companyId: item.id, name: item.name, role: item.role, joinedAt: "2026-11-01T10:00:00.000Z", active, status: "open" });
export async function mockCompanies(page: Page, options: { companies?: MockCompany[]; start?: string; refuse?: { status: number; code: string; message: string } } = {}) {
 const companies = options.companies ?? COMPANIES, requests: Request[] = [], posts: unknown[] = [];
 let active = options.start ?? companies[0]!.id;
 const current = () => companies.find(item => item.id === active)!;
 const list = () => ({ activeCompanyId: active, companies: companies.map(item => company(item, item.id === active)), limits: { maxCompanies: 20 }, canCreate: false, canJoinByInvite: true });
 page.on("request", request => { requests.push(request); });
 await page.route("**/v1/web/companies", async route => {
  if (route.request().method() === "GET") { await route.fulfill({ status: 200, contentType: "application/json", json: list() });return; }
  const body = route.request().postDataJSON() as { action: string; companyId: string };posts.push(body);
  if (options.refuse !== undefined) { await route.fulfill({ status: options.refuse.status, contentType: "application/json", json: { error: { code: options.refuse.code, message: options.refuse.message } } });return; }
  active = body.companyId;await route.fulfill({ status: 200, contentType: "application/json", json: { status: "done", activeCompanyId: active, companies: list().companies, me: {} } });
 });
 await page.route("**/v1/web/nav", async route => {
  const response = await route.fetch(), json = await response.json() as { org: { name: string }; projects: unknown[] };
  json.org.name = current().name;json.projects = [{ name: current().project, agents: [] }];
  await route.fulfill({ response, json, headers: { ...response.headers(), "x-rovara-company": active } });
 });
 await page.route("**/v1/web/home**", async route => {
  const response = await route.fetch(), json = await response.json() as { cards?: Array<{ title: string }> };
  for (const card of json.cards ?? []) card.title = current().name + ": " + card.title;
  await route.fulfill({ response, json });
 });
 return { active: () => active, requests: () => requests.filter(request => request.url().includes("/v1/web/")), companyReads: () => requests.filter(request => request.url().endsWith("/v1/web/companies")), posts: () => posts };
}
