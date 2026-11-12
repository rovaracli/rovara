// The project People tab, collaborator approvals and product decisions (lane exp/project-people) for the browser journeys: the broker's answers for these routes, held in memory and served by the page itself
// (`page.route`), so the shared mock cell needs no change. Shapes are the contract's; a write changes the held state and moves the revision, as the broker does. `sent` records every write for the test to read.
import type { Page, Route } from "@playwright/test";
export interface Sent { method: string; path: string; body: unknown }
const hex = (letter: string) => letter.repeat(64);
export const PEOPLE = { noor: hex("9"), maya: hex("a"), priya: hex("b"), sam: hex("c"), lee: hex("d"), ana: hex("e"), dana: hex("f") };
type Person = { developerId: string; name: string; role: string; projectRole: string; source: string };
const person = (developerId: string, name: string, projectRole: string, source = "grant"): Person => ({ developerId, name, role: projectRole === "collaborator" ? "viewer" : projectRole, projectRole, source });
export const DECISION_ID = "pdq_" + "B".repeat(20);

export async function installPeopleMock(page: Page, options: { decisions?: boolean } = {}): Promise<{ sent: Sent[] }> {
 const sent: Sent[] = [];
 let revision = 7, approvalsRevision = 2, approvalsOn = true;
 const settingsRevision = 3;
 const members: Person[] = [person(PEOPLE.maya, "Maya Chen", "maintainer"), person(PEOPLE.noor, "Noor Haddad", "maintainer"), person(PEOPLE.priya, "Priya Rao", "collaborator"), person(PEOPLE.sam, "Sam Ortiz", "contributor"), person(PEOPLE.lee, "Lee Park", "viewer"), person(PEOPLE.dana, "Dana Admin", "maintainer", "org_role")];
 let decision: Record<string, unknown> = { decisionId: DECISION_ID, taskId: "11111111-1111-4111-8111-111111111111", project: "payments", question: "Which wording should the refund button use?", options: [{ id: "o1", label: "Refund now" }, { id: "o2", label: "Request a refund" }], risk: "low", status: "open", revision: 4, raisedAt: "2026-11-10T10:00:00.000Z", answers: [], you: { canAnswer: true, canApprove: true } };
 const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
 await page.route(/\/v1\/web\/(?:projects\/payments\/(?:people|code-settings|collaborator-approvals|product-decisions)|org\/members$|org\/invites\/reviewed$)/u, async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname.replace("/v1/web/", "");
  let body: unknown;if (method !== "GET") { try { body = request.postDataJSON(); } catch { body = undefined; }sent.push({ method, path, body }); }
  const input = (body ?? {}) as Record<string, unknown>;
  if (path === "projects/payments/people" && method === "GET") return json(route, { project: "payments", members, revision, viewer: { role: "maintainer", canManageMembers: true, assignableRoles: ["maintainer", "contributor", "collaborator", "viewer"], canInvite: true, invitableRoles: ["maintainer", "contributor", "viewer"], canEditCodeSettings: true, canConfirmSelfApproval: false } });
  const one = /^projects\/payments\/people\/([a-f0-9]{64})$/u.exec(path);
  if (one !== null && method === "PUT") { const found = members.find(item => item.developerId === one[1]);const role = String(input["role"]);if (found !== undefined) { found.projectRole = role;found.role = role === "collaborator" ? "viewer" : role; } else members.push(person(one[1]!, "Ana Silva", role));revision += 1;return json(route, { member: { developerId: one[1], role: role === "collaborator" ? "viewer" : role }, revision }); }
  if (one !== null && method === "DELETE") { const index = members.findIndex(item => item.developerId === one[1]);if (index >= 0) members.splice(index, 1);revision += 1;return json(route, { developerId: one[1], removed: true, revision }); }
  if (path === "projects/payments/code-settings") return json(route, { settings: { allowSelfApproval: false, mergeMethod: "squash", codeReviewers: ["acme/payments-team"], revision: settingsRevision } });
  if (path === "projects/payments/collaborator-approvals" && method === "GET") return json(route, { collaboratorApprovals: { enabled: approvalsOn, revision: approvalsRevision, isDefault: false, canChange: true } });
  if (path === "projects/payments/collaborator-approvals" && method === "PUT") { approvalsOn = input["enabled"] === true;approvalsRevision += 1;return json(route, { collaboratorApprovals: { enabled: approvalsOn, revision: approvalsRevision, isDefault: false, canChange: true } }); }
  if (path === "projects/payments/product-decisions" && method === "GET") return json(route, { decisions: options.decisions === false ? [] : [decision] });
  if (path === "projects/payments/product-decisions/" + DECISION_ID && method === "POST") {
   if (input["action"] === "approve") decision = { ...decision, status: "approved", revision: 5, approved: { optionId: String(input["optionId"]), by: { developerId: PEOPLE.maya, name: "Maya Chen" }, role: "maintainer", at: "2026-11-11T10:00:00.000Z", class: "product" }, you: { canAnswer: true, canApprove: true } };
   return json(route, { decision });
  }
  if (path === "org/members" && method === "GET") return json(route, { members: [{ developerId: PEOPLE.ana, name: "Ana Silva", role: "member" }, { developerId: PEOPLE.sam, name: "Sam Ortiz", role: "member" }] });
  if (path === "org/invites/reviewed" && method === "POST") return json(route, { receipt: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", requestId: input["requestId"], inviteId: "22222222-2222-4222-8222-222222222222", role: "member", createdAt: "2026-11-11T10:00:00.000Z", expiresAt: "2026-11-18T10:00:00.000Z", project: input["project"] }, email: "sent" });
  return route.fallback();
 });
 return { sent };
}
