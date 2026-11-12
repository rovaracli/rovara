import type { Page, Request } from "@playwright/test";
import { GROUP_BACKEND, GROUP_PAYMENTS, LENA, MAYA, OMAR, PRIYA, REVIEW_KEY, TASK_ID, claimOf, groupsView, members, reviewView } from "../../web/support/review-fixture.js";
// The server's review routes for the review groups journeys (switch: localStorage `rovara.reviews` = "v2"), mounted over the mock cell with page.route. A stand-in for packages/broker/src/review-groups/routes.ts:
// the fences it enforces (the revision on a group save and on a claim, the review key) are enforced here too, so a screen that sent the wrong one would be refused as the real server refuses it.
export { TASK_ID };
type Json = Record<string, unknown>;
export async function mockReviews(page: Page) {
 let groups: Json = groupsView({ canManage: true }), revision = 3, claim: Json | undefined, claimRevision = 4;
 const requests: Request[] = [], writes: Array<{ path: string; body: Json }> = [];
 const view = (): Json => reviewView({ aged: true, ageHours: 30, revision: claimRevision, ...(claim === undefined ? { canClaim: true, claimableGroups: [{ groupId: GROUP_BACKEND, name: "Backend" }] } : { claim, canRelease: true }) });
 page.on("request", request => { if (request.url().includes("/v1/web/")) requests.push(request); });
 await page.route("**/v1/web/projects/payments/members", route => route.fulfill({ json: members }));
 await page.route("**/v1/web/projects/payments/review-groups", async route => {
  if (route.request().method() === "GET") { await route.fulfill({ json: groups });return; }
  const body = route.request().postDataJSON() as { expectedRevision: number; groups: Array<{ groupId?: string; name: string; members: string[] }> };writes.push({ path: "review-groups", body });
  if (body.expectedRevision !== revision) { await route.fulfill({ status: 409, json: { error: { code: "CHANGE_STALE", message: "This changed while you were looking. Reload and try again." } } });return; }
  const names = new Map(members.members.map(member => [member.developerId, member.name]));
  revision += 1;groups = groupsView({ revision, canManage: true, groups: body.groups.map((group, index) => ({ groupId: group.groupId ?? "rgp_" + String(index + 5).repeat(16), name: group.name, members: group.members.map(id => ({ developerId: id, name: names.get(id) ?? "A member", eligible: true })) })) });
  await route.fulfill({ json: groups });
 });
 await page.route("**/v1/web/tasks/" + TASK_ID + "/review", route => route.fulfill({ json: view() }));
 await page.route("**/v1/web/tasks/" + TASK_ID + "/review/*", async route => {
  const body = route.request().postDataJSON() as Json, action = route.request().url().split("/").pop()!;writes.push({ path: action, body });
  if (body["expectedRevision"] !== claimRevision || (action !== "release" && body["reviewKey"] !== REVIEW_KEY)) { await route.fulfill({ status: 409, json: { error: { code: "CHANGE_STALE", message: "This changed while you were looking. Reload and try again." } } });return; }
  claimRevision += 1;
  if (action === "claim") claim = claimOf({ hostSync: "pending", claimedAt: new Date().toISOString() });else claim = undefined;
  await route.fulfill({ json: view() });
 });
 return { requests: () => requests, /** Only this lane's routes: the groups, the task's own review and its claim, release and reassign (not the design review's). */
  reviewRequests: () => requests.filter(request => /\/review-groups$|\/tasks\/[0-9a-f-]{36}\/review(?:\/|$)/u.test(new URL(request.url()).pathname)), writes: () => writes, ids: { PRIYA, MAYA, OMAR, LENA, GROUP_BACKEND, GROUP_PAYMENTS } };
}
