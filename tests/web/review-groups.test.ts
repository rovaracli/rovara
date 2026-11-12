// @vitest-environment jsdom
// Review groups (lane exp/review-groups, switch `rovara.reviews` = "v2"): the project page's Review groups section and the task page's review card.
// Off, neither is rendered and no review route is called. On, a maintainer edits the groups under the revision read; everyone else reads them. The card shows the claim, how GitHub took it, the age,
// and Claim, Release and Reassign only as the server's own flags allow, and always the sentence that a claim never grants approval.
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { REVIEW_CLAIM_APPROVAL_NOTE, REVIEW_GROUP_NAME_MAX } from "@agentx/cloud-contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { TaskReviewCard } from "../../packages/ui/src/screens/reviews/TaskReviewCard.js";
import { REVIEWS_STORAGE_KEY, isReviewGroupsOn } from "../../packages/ui/src/review-flags.js";
import { agedWords, hostSyncWords } from "../../packages/ui/src/screens/reviews/review-text.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { taskFixture } from "./support/session-fixture.js";
import { GROUP_BACKEND, GROUP_PAYMENTS, LENA, MAYA, OMAR, PRIYA, REVIEW_KEY, STALE, TASK_ID, claimOf, error, groupsView, reviewServer, reviewView } from "./support/review-fixture.js";

type Server = ReturnType<typeof reviewServer>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function project(server: Server, options: { on?: boolean; canManage?: boolean } = {}) {
 const overview = projectFixture();
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (request.path.endsWith("/start-preview")) return { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } };
  if (request.path.includes("/review-groups") || request.path.endsWith("/payments/members")) return server.handler(request);
  return request.method === "GET" ? { status: 200, body: overview } : { status: 202, body: {} };
 });
 if (options.on !== false) f.storage.set(REVIEWS_STORAGE_KEY, "v2");
 if (options.canManage !== undefined) server.state.groups = groupsView({ canManage: options.canManage });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }));
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
function card(server: Server, options: { theme?: "light" | "dark" } = {}) {
 const f = fakeHost(server.handler), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(TaskReviewCard, { taskId: TASK_ID, project: "payments" }) }) }), options);
 return { ...f, ...ui, query, close() { ui.unmount();query.clear(); } };
}
const section = () => screen.findByRole("region", { name: "Review groups" });
const cardRegion = () => screen.findByRole("region", { name: "Review" });
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const edit = async () => { fireEvent.click(await screen.findByRole("button", { name: /^(Edit groups|Add a group)$/u })); };
const pick = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const bodyOf = (call: ApiRequest) => call.body as Record<string, unknown>;

describe("the device switch", () => {
 const host = (value?: string) => ({ storage: { get: () => value, set: () => undefined } });
 it("is off unless the device key is exactly v2", () => {
  expect(REVIEWS_STORAGE_KEY).toBe("rovara.reviews");
  expect(isReviewGroupsOn(host())).toBe(false);for (const value of ["", "v1", "V2", "true", "1", "v2 "]) expect(isReviewGroupsOn(host(value)), value).toBe(false);
  expect(isReviewGroupsOn(host("v2"))).toBe(true);
 });
 it("is off when the store throws", () => { expect(isReviewGroupsOn({ storage: { get: () => { throw new Error("blocked"); }, set: () => undefined } })).toBe(false); });
});

describe("the project page: switch off", () => {
 it("shows no Review groups section and never calls a review route", async () => {
  const server = reviewServer({}), f = project(server, { on: false });
  await screen.findByRole("heading", { name: "payments" });await screen.findByRole("heading", { name: "Running now" });
  expect(screen.queryByRole("region", { name: "Review groups" })).toBeNull();expect(screen.queryByText("Review groups")).toBeNull();
  expect(server.calls).toHaveLength(0);f.close();
 });
});

describe("the project page: switch on", () => {
 it("lists groups and members to someone who can't manage them, greys a member who is no longer a contributor, and offers no editing", async () => {
  const server = reviewServer({}), f = project(server, { canManage: false });
  const region = within(await section());
  expect(await region.findByRole("heading", { name: "Backend" })).toBeTruthy();expect(region.getByRole("heading", { name: "Payments" })).toBeTruthy();
  const maya = region.getByText("Maya").closest("li")!;expect(maya.getAttribute("data-eligible")).toBe("no");expect(maya.textContent).toContain("no longer a contributor");
  expect(region.getByText("Priya").closest("li")!.textContent).not.toContain("no longer a contributor");
  expect(region.queryByRole("button")).toBeNull();expect(region.getByRole("note").textContent).toBe(REVIEW_CLAIM_APPROVAL_NOTE);
  expect(server.writes()).toHaveLength(0);expect(server.calls.some(call => call.path.endsWith("/members"))).toBe(false);f.close();
 });
 it("says there are no groups yet, and a maintainer can add the first", async () => {
  const server = reviewServer({ groups: groupsView({ groups: [], canManage: true }) }), f = project(server);
  const region = within(await section());expect(await region.findByText(/This project has no review groups yet/u)).toBeTruthy();expect(region.getByRole("button", { name: "Add a group" })).toBeTruthy();f.close();
 });
 it("lets a maintainer rename, add a person from contributors and maintainers, add and remove groups, and saves the whole list under the revision with a fresh request id", async () => {
  const server = reviewServer({}), f = project(server, { canManage: true });
  const region = within(await section());await region.findByRole("heading", { name: "Backend" });
  await edit();
  fireEvent.change(await screen.findByDisplayValue("Backend"), { target: { value: "Backend team" } });
  // The picker offers contributors and maintainers who are not in the group yet, and not a viewer.
  const picker = await screen.findByLabelText("Add a person to Backend team");
  await waitFor(() => expect((picker as HTMLSelectElement).disabled).toBe(false));
  expect([...(picker as HTMLSelectElement).options].map(option => option.textContent)).toEqual(["Choose a person", "Omar", "Lena"]);
  pick("Add a person to Backend team", LENA);
  fireEvent.click(screen.getByRole("button", { name: "Remove Priya from Backend team" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove group Payments" }));
  press("Add a group");
  fireEvent.change(screen.getByLabelText("Name", { selector: "#" + (screen.getAllByLabelText("Name").at(-1) as HTMLElement).id }), { target: { value: "Security" } });
  press("Save groups");
  await waitFor(() => expect(server.writes()).toHaveLength(1));
  const put = server.writes()[0]!;expect(put.method).toBe("PUT");expect(put.path).toBe("/v1/app/projects/payments/review-groups");
  const body = bodyOf(put);expect(body["expectedRevision"]).toBe(3);expect(String(body["requestId"])).toMatch(UUID);
  // Maya is no longer a contributor: she is left out, as the server would drop her anyway.
  expect(body["groups"]).toEqual([{ groupId: GROUP_BACKEND, name: "Backend team", members: [LENA] }, { name: "Security", members: [] }]);
  expect(Object.keys(body).sort()).toEqual(["expectedRevision", "groups", "requestId"]);
  expect(await screen.findByText("Review groups saved.")).toBeTruthy();f.close();
 });
 it("shows the saved list the server answered", async () => {
  const saved = groupsView({ revision: 4, canManage: true, groups: [{ groupId: GROUP_BACKEND, name: "Backend team", members: [{ developerId: LENA, name: "Lena", eligible: true }] }] });
  const server = reviewServer({ put: () => ({ status: 200, body: saved }) }), f = project(server, { canManage: true });
  await section();await edit();fireEvent.change(await screen.findByDisplayValue("Backend"), { target: { value: "Backend team" } });press("Save groups");
  expect(await screen.findByRole("heading", { name: "Backend team" })).toBeTruthy();expect(screen.queryByRole("heading", { name: "Payments" })).toBeNull();expect(screen.getByRole("button", { name: "Edit groups" })).toBeTruthy();f.close();
 });
 it("reloads the groups and says why when the list changed under the draft (CHANGE_STALE)", async () => {
  const server = reviewServer({ put: () => error(409, "CHANGE_STALE", STALE) }), f = project(server, { canManage: true });
  await section();await edit();fireEvent.change(await screen.findByDisplayValue("Backend"), { target: { value: "Backend team" } });
  const reads = () => server.calls.filter(call => call.method === "GET" && call.path.endsWith("/review-groups")).length, before = reads();
  press("Save groups");
  expect((await within(await section()).findByRole("alert")).textContent).toBe(STALE);
  await waitFor(() => expect(reads()).toBe(before + 1));expect(screen.queryByDisplayValue("Backend team")).toBeNull();expect(screen.getByRole("button", { name: "Edit groups" })).toBeTruthy();f.close();
 });
 it("shows a refusal as the server worded it and keeps the draft", async () => {
  const words = "groups.0.name: another group has this name", server = reviewServer({ put: () => error(400, "CONFIG_INVALID", words) }), f = project(server, { canManage: true });
  await section();await edit();fireEvent.change(await screen.findByDisplayValue("Backend"), { target: { value: "Backend team" } });press("Save groups");
  expect((await within(await section()).findByRole("alert")).textContent).toBe(words);expect(screen.getByDisplayValue("Backend team")).toBeTruthy();f.close();
 });
 it("refuses a name that is empty, too long or taken before it sends anything", async () => {
  const server = reviewServer({}), f = project(server, { canManage: true });
  await section();await edit();const name = await screen.findByDisplayValue("Backend");
  fireEvent.change(name, { target: { value: "payments" } });expect(screen.getAllByText("Another group has this name.").length).toBeGreaterThan(0);expect((screen.getByRole<HTMLButtonElement>("button", { name: "Save groups" })).disabled).toBe(true);
  fireEvent.change(name, { target: { value: "x".repeat(REVIEW_GROUP_NAME_MAX + 1) } });expect(screen.getByText("Use 60 characters or fewer.")).toBeTruthy();expect((screen.getByRole<HTMLButtonElement>("button", { name: "Save groups" })).disabled).toBe(true);
  fireEvent.change(name, { target: { value: "  " } });expect(screen.getByText("Give every group a name to save.")).toBeTruthy();expect((screen.getByRole<HTMLButtonElement>("button", { name: "Save groups" })).disabled).toBe(true);
  fireEvent.change(name, { target: { value: "y".repeat(REVIEW_GROUP_NAME_MAX) } });expect((screen.getByRole<HTMLButtonElement>("button", { name: "Save groups" })).disabled).toBe(false);
  expect(server.writes()).toHaveLength(0);f.close();
 });
 it("stops adding groups at the limit", async () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ groupId: "rgp_" + index.toString(16).padStart(16, "0"), name: "Group " + String(index), members: [] })), server = reviewServer({ groups: groupsView({ groups: many, canManage: true }) }), f = project(server);
  await section();await edit();expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Add a group" })).disabled).toBe(true);f.close();
 });
 it("cancel drops the draft and sends nothing", async () => {
  const server = reviewServer({}), f = project(server, { canManage: true });
  await section();await edit();fireEvent.change(await screen.findByDisplayValue("Backend"), { target: { value: "Gone" } });press("Cancel");
  expect(await screen.findByRole("heading", { name: "Backend" })).toBeTruthy();expect(server.writes()).toHaveLength(0);f.close();
 });
 it("says why when the groups can't be read, and tries again", async () => {
  let fail = true;const server = reviewServer({}), f = project({ ...server, handler: async request => (fail && request.path.endsWith("/review-groups") ? error(400, "RUNTIME_UNAVAILABLE", "Review groups are unavailable right now.") : server.handler(request)) });
  expect((await within(await section()).findByRole("alert")).textContent).toBe("Review groups are unavailable right now.");
  fail = false;fireEvent.click(within(await section()).getByRole("button", { name: "Try again" }));expect(await screen.findByRole("heading", { name: "Backend" })).toBeTruthy();f.close();
 });
 it("has no axe violations, read-only and editing, in both themes", async () => {
  for (const theme of ["light", "dark"] as const) {
   const ui = project(reviewServer({}), { canManage: true });document.documentElement.setAttribute("data-theme", theme);
   const region = await section();await within(region).findByRole("heading", { name: "Backend" });await expectNoAxeViolations(region);
   await edit();await screen.findByLabelText(/Add a person to Backend/u);await expectNoAxeViolations(region);ui.close();
  }
 });
});

describe("the review card: what is shown", () => {
 it("shows nothing when nothing waits and nobody holds the review", async () => {
  const server = reviewServer({ review: reviewView({ waiting: false, reviewKey: undefined, pullRequests: [], waitingSince: undefined, ageHours: undefined }) }), f = card(server);
  await waitFor(() => expect(server.reviewCalls()).toHaveLength(1));expect(screen.queryByRole("region", { name: "Review" })).toBeNull();f.close();
 });
 it("shows nothing when the server has no review route (404)", async () => {
  const server = reviewServer({ reviewStatus: error(404, "NOT_FOUND", "Not found.") }), f = card(server);
  await waitFor(() => expect(server.reviewCalls()).toHaveLength(1));expect(screen.queryByRole("region", { name: "Review" })).toBeNull();f.close();
 });
 it("says why when the review can't be read", async () => {
  const server = reviewServer({ reviewStatus: error(400, "RUNTIME_UNAVAILABLE", "Rovara couldn't check who owns this task. Try again in a minute.") }), f = card(server);
  expect((await within(await cardRegion()).findByRole("alert")).textContent).toBe("Rovara couldn't check who owns this task. Try again in a minute.");f.close();
 });
 it("shows who holds the claim, their group and since when", async () => {
  const server = reviewServer({ review: reviewView({ claim: claimOf() }) }), f = card(server), region = within(await cardRegion());
  const line = (await region.findByText(/Claimed by/u)).closest("p")!;expect(line.textContent).toMatch(/^Claimed by Priya for the Backend group, /u);expect(line.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-11T09:00:00.000Z");
  expect(region.getByText("acme/payments #41")).toBeTruthy();f.close();
 });
 it("says nobody has claimed it when nobody has", async () => {
  const f = card(reviewServer({})), region = within(await cardRegion());expect(await region.findByText("Nobody has claimed this review yet.")).toBeTruthy();expect(region.getByText(/Waiting for review, since/u)).toBeTruthy();f.close();
 });
 it.each([["requested", "Asked on GitHub"], ["refused", "GitHub refused"], ["pending", "Waiting to ask GitHub"], ["unavailable", "GitHub unavailable"]] as const)("says in words how GitHub took the claim: %s", async (sync, words) => {
  const f = card(reviewServer({ review: reviewView({ claim: claimOf({ hostSync: sync }) }) })), region = within(await cardRegion());
  expect((await region.findByText(words)).className).toContain("rv-review-sync-words");expect(hostSyncWords(sync)).toBe(words);
  for (const other of ["Asked on GitHub", "GitHub refused", "Waiting to ask GitHub", "GitHub unavailable"].filter(word => word !== words)) expect(region.queryByText(other)).toBeNull();f.close();
 });
 it("never reads an unknown GitHub answer as a success", async () => {
  const f = card(reviewServer({ review: { ...reviewView(), claim: claimOf({ hostSync: "later" }) } })), region = within(await cardRegion());
  expect(await region.findByText("GitHub status unknown")).toBeTruthy();expect(region.queryByText("Asked on GitHub")).toBeNull();f.close();
 });
 it("shows the Aged badge with the hours when the review has waited long, claimed or not, and none when it has not", async () => {
  const aged = card(reviewServer({ review: reviewView({ aged: true, ageHours: 30 }) }));
  expect((await within(await cardRegion()).findByText("Aged: waiting 30 hours"))).toBeTruthy();aged.close();
  const claimed = card(reviewServer({ review: reviewView({ aged: true, ageHours: 1, claim: claimOf() }) }));
  expect(await within(await cardRegion()).findByText("Aged: waiting 1 hour")).toBeTruthy();claimed.close();
  const fresh = card(reviewServer({ review: reviewView({ aged: false, ageHours: 3 }) }));await cardRegion();expect(screen.queryByText(/Aged/u)).toBeNull();fresh.close();
  expect(agedWords(undefined)).toBe("Aged: waiting more than a day");
 });
 it("says the review went back to the group when its holder left", async () => {
  const f = card(reviewServer({ review: reviewView({ returned: true }) })), region = within(await cardRegion());
  expect(await region.findByText(/This review went back to the group/u)).toBeTruthy();f.close();
 });
 it("does not say it went back while someone holds it", async () => {
  const f = card(reviewServer({ review: reviewView({ returned: true, claim: claimOf() }) })), region = within(await cardRegion());await region.findByText(/Claimed by/u);expect(region.queryByText(/went back to the group/u)).toBeNull();f.close();
 });
 it.each([
  ["waiting and unclaimed", { }], ["claimed", { claim: claimOf() }], ["returned", { returned: true }], ["aged", { aged: true }], ["can claim", { canClaim: true }], ["can do everything", { claim: claimOf(), canRelease: true, canReassign: true, canClaim: true }],
 ] as const)("always shows the approval note: %s", async (_name, overrides) => {
  const f = card(reviewServer({ review: reviewView(overrides) })), region = within(await cardRegion());
  expect((await region.findByText(REVIEW_CLAIM_APPROVAL_NOTE))).toBeTruthy();f.close();
 });
 it("shows the server's own approval note, whatever its words", async () => {
  const f = card(reviewServer({ review: reviewView({ approvalNote: "A different sentence from the server." }) }));expect(await within(await cardRegion()).findByText("A different sentence from the server.")).toBeTruthy();f.close();
 });
 it("has no axe violations in both themes, with a claim and every button", async () => {
  for (const theme of ["light", "dark"] as const) {
   const f = card(reviewServer({ review: reviewView({ aged: true, ageHours: 30, claim: claimOf({ hostSync: "refused" }), canRelease: true, canReassign: true }) }), { theme });
   await expectNoAxeViolations(await cardRegion());f.close();
  }
 });
});

describe("the review card: which buttons", () => {
 const names = ["Claim review", "Release", "Reassign"] as const;
 it.each([
  [{ canClaim: false, canRelease: false, canReassign: false }, []],
  [{ canClaim: true, canRelease: false, canReassign: false }, ["Claim review"]],
  [{ canClaim: false, canRelease: true, canReassign: false }, ["Release"]],
  [{ canClaim: false, canRelease: false, canReassign: true }, ["Reassign"]],
  [{ canClaim: true, canRelease: true, canReassign: true }, ["Claim review", "Release", "Reassign"]],
 ] as const)("follows the server's flags: %j", async (flags, shown) => {
  const f = card(reviewServer({ review: reviewView({ ...flags }) }));await cardRegion();
  for (const name of names) expect(screen.queryByRole("button", { name }) !== null, name).toBe((shown as readonly string[]).includes(name));f.close();
 });
 it("offers no Claim without a group to claim through, or without a review key", async () => {
  const none = card(reviewServer({ review: reviewView({ canClaim: true, claimableGroups: [] }) }));await cardRegion();expect(screen.queryByRole("button", { name: "Claim review" })).toBeNull();none.close();
  const noKey = card(reviewServer({ review: reviewView({ canClaim: true, canReassign: true, reviewKey: undefined }) }));await cardRegion();expect(screen.queryByRole("button", { name: "Claim review" })).toBeNull();expect(screen.queryByRole("button", { name: "Reassign" })).toBeNull();noKey.close();
 });
});

describe("the review card: claim, release and reassign", () => {
 it("claims through the chosen group with the revision and the review's key, then shows the claim and Release", async () => {
  const claimed = reviewView({ revision: 5, claim: claimOf({ hostSync: "pending" }), canRelease: true }), server = reviewServer({ review: reviewView({ canClaim: true, claimableGroups: [{ groupId: GROUP_BACKEND, name: "Backend" }, { groupId: GROUP_PAYMENTS, name: "Payments" }] }), post: () => ({ status: 200, body: claimed }) }), f = card(server);
  await cardRegion();press("Claim review");const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(REVIEW_CLAIM_APPROVAL_NOTE)).toBeTruthy();expect((dialog.getByRole<HTMLButtonElement>("button", { name: "Claim" })).disabled).toBe(true);
  pick("Claim through which group?", GROUP_PAYMENTS);fireEvent.click(dialog.getByRole("button", { name: "Claim" }));
  await waitFor(() => expect(server.writes()).toHaveLength(1));
  const call = server.writes()[0]!;expect(call.method).toBe("POST");expect(call.path).toBe("/v1/app/tasks/" + TASK_ID + "/review/claim");
  expect(bodyOf(call)).toMatchObject({ expectedRevision: 4, reviewKey: REVIEW_KEY, groupId: GROUP_PAYMENTS });expect(String(bodyOf(call)["requestId"])).toMatch(UUID);expect(Object.keys(bodyOf(call)).sort()).toEqual(["expectedRevision", "groupId", "requestId", "reviewKey"]);
  expect(await screen.findByText("Waiting to ask GitHub")).toBeTruthy();expect(screen.getByRole("status").textContent).toBe("You claimed this review.");
  expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Claim review" })).toBeNull();expect(screen.queryByRole("dialog")).toBeNull();f.close();
 });
 it("preselects the only group that can be claimed through", async () => {
  const server = reviewServer({ review: reviewView({ canClaim: true }) }), f = card(server);await cardRegion();press("Claim review");
  const dialog = within(await screen.findByRole("dialog"));expect((dialog.getByRole<HTMLButtonElement>("button", { name: "Claim" })).disabled).toBe(false);
  fireEvent.click(dialog.getByRole("button", { name: "Claim" }));await waitFor(() => expect(bodyOf(server.writes()[0]!)["groupId"]).toBe(GROUP_BACKEND));f.close();
 });
 it("releases with the revision, and says it is back with the group", async () => {
  const back = reviewView({ revision: 6, canClaim: true }), server = reviewServer({ review: reviewView({ claim: claimOf(), canRelease: true }), post: () => ({ status: 200, body: back }) }), f = card(server);
  await within(await cardRegion()).findByText(/Claimed by/u);press("Release");const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(REVIEW_CLAIM_APPROVAL_NOTE)).toBeTruthy();fireEvent.click(dialog.getByRole("button", { name: "Release" }));
  await waitFor(() => expect(server.writes()).toHaveLength(1));const call = server.writes()[0]!;expect(call.path).toBe("/v1/app/tasks/" + TASK_ID + "/review/release");
  expect(Object.keys(bodyOf(call)).sort()).toEqual(["expectedRevision", "requestId"]);expect(bodyOf(call)["expectedRevision"]).toBe(4);
  expect(await screen.findByText("Nobody has claimed this review yet.")).toBeTruthy();expect(screen.getByRole("status").textContent).toContain("back with the group");f.close();
 });
 it("reassigns to another person in the claim's group, not to the holder or someone who is no longer a contributor", async () => {
  const groups = groupsView({ canManage: true, groups: [{ groupId: GROUP_BACKEND, name: "Backend", members: [{ developerId: PRIYA, name: "Priya", eligible: true }, { developerId: LENA, name: "Lena", eligible: true }, { developerId: MAYA, name: "Maya", eligible: false }] }, { groupId: GROUP_PAYMENTS, name: "Payments", members: [{ developerId: OMAR, name: "Omar", eligible: true }] }] });
  const after = reviewView({ revision: 7, claim: claimOf({ developerId: LENA, name: "Lena" }), canReassign: true });
  const server = reviewServer({ groups, review: reviewView({ claim: claimOf(), canReassign: true }), post: () => ({ status: 200, body: after }) }), f = card(server);
  await within(await cardRegion()).findByText(/Claimed by/u);press("Reassign");const dialog = within(await screen.findByRole("dialog"));
  const target = await dialog.findByLabelText("Reassign to");await waitFor(() => expect((target as HTMLSelectElement).disabled).toBe(false));
  expect([...(target as HTMLSelectElement).options].map(option => option.textContent)).toEqual(["Choose a person", "Lena"]);
  expect((dialog.getByRole<HTMLButtonElement>("button", { name: "Reassign" })).disabled).toBe(true);
  fireEvent.change(target, { target: { value: LENA } });fireEvent.click(dialog.getByRole("button", { name: "Reassign" }));
  await waitFor(() => expect(server.writes()).toHaveLength(1));const call = server.writes()[0]!;expect(call.path).toBe("/v1/app/tasks/" + TASK_ID + "/review/reassign");
  expect(bodyOf(call)).toMatchObject({ expectedRevision: 4, reviewKey: REVIEW_KEY, groupId: GROUP_BACKEND, to: LENA });expect(Object.keys(bodyOf(call)).sort()).toEqual(["expectedRevision", "groupId", "requestId", "reviewKey", "to"]);
  await waitFor(() => expect(screen.getByText(/Claimed by/u).textContent).toContain("Lena"));expect(screen.getByRole("status").textContent).toBe("This review was reassigned.");f.close();
 });
 it("on an unclaimed review, reassign first asks for the group", async () => {
  const groups = groupsView({ canManage: true }), server = reviewServer({ groups, review: reviewView({ canReassign: true }) }), f = card(server);
  await cardRegion();press("Reassign");const dialog = within(await screen.findByRole("dialog"));
  const target = await dialog.findByLabelText("Reassign to");expect((target as HTMLSelectElement).disabled).toBe(true);
  fireEvent.change(await dialog.findByLabelText("Which group?"), { target: { value: GROUP_PAYMENTS } });await waitFor(() => expect((target as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(target, { target: { value: OMAR } });fireEvent.click(dialog.getByRole("button", { name: "Reassign" }));
  await waitFor(() => expect(bodyOf(server.writes()[0]!)).toMatchObject({ groupId: GROUP_PAYMENTS, to: OMAR }));f.close();
 });
 it("reloads the card and says why when the claim moved (CHANGE_STALE), with a fresh request next time", async () => {
  const server = reviewServer({ review: reviewView({ canClaim: true }), post: () => error(409, "CHANGE_STALE", STALE) }), f = card(server);
  await cardRegion();const reads = () => server.reviewCalls().filter(call => call.method === "GET").length, before = reads();
  press("Claim review");fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Claim" }));
  expect((await screen.findByRole("alert")).textContent).toContain(STALE);await waitFor(() => expect(reads()).toBe(before + 1));expect(screen.queryByRole("dialog")).toBeNull();
  press("Claim review");fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Claim" }));await waitFor(() => expect(server.writes()).toHaveLength(2));
  expect(bodyOf(server.writes()[1]!)["requestId"]).not.toBe(bodyOf(server.writes()[0]!)["requestId"]);f.close();
 });
 it.each([
  ["You asked for this task, so someone else reviews it."], ["Someone else has claimed this review. A maintainer can reassign it."], ["Link your GitHub account to claim reviews: the claim makes you the requested reviewer on GitHub."],
  ["Rovara couldn't check who owns this task. Try again in a minute."],
 ])("shows a refusal as the server worded it, in the dialog: %s", async words => {
  const server = reviewServer({ review: reviewView({ canClaim: true }), post: () => error(words.startsWith("Rovara") ? 503 : 403, words.startsWith("Rovara") ? "RUNTIME_UNAVAILABLE" : "FORBIDDEN", words) }), f = card(server);
  await cardRegion();press("Claim review");fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Claim" }));
  const dialog = await screen.findByRole("dialog");expect((await within(dialog).findByRole("alert")).textContent).toBe(words);expect(within(dialog).getByText(REVIEW_CLAIM_APPROVAL_NOTE)).toBeTruthy();f.close();
 });
 it("never uses window.confirm", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "confirm");let asked = 0;window.confirm = () => { asked += 1;return true; };
  try {
   const server = reviewServer({ review: reviewView({ claim: claimOf(), canRelease: true }) }), f = card(server);await within(await cardRegion()).findByText(/Claimed by/u);press("Release");
   fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Release" }));await waitFor(() => expect(server.writes()).toHaveLength(1));expect(asked).toBe(0);f.close();
  } finally { if (original !== undefined) Object.defineProperty(window, "confirm", original); }
 });
 it("keeps the dialog open and the buttons off while a request is on its way", async () => {
  let release: (value: ApiResponse) => void = () => undefined;const server = reviewServer({ review: reviewView({ canClaim: true }) });
  let posts = 0;const slow = { ...server, handler: (request: ApiRequest) => (request.method === "POST" ? new Promise<ApiResponse>(resolve => { posts += 1;release = resolve; }) : server.handler(request)) };
  const f = card(slow);await cardRegion();press("Claim review");const dialog = within(await screen.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Claim" }));await waitFor(() => expect((dialog.getByRole<HTMLButtonElement>("button", { name: "Claim" })).disabled).toBe(true));
  fireEvent.click(dialog.getByRole("button", { name: "Claim" }));expect(posts).toBe(1);release({ status: 200, body: reviewView({ claim: claimOf() }) });f.close();
 });
});

describe("the task page", () => {
 function page(server: Server, on: boolean) {
  const session = workspaceFixture({}, {}), f = fakeHost(async request => {
   if (request.path.includes("/review")) return server.handler(request);
   if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
   if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
   if (request.path.split("?", 1)[0]!.endsWith("/messages")) return { status: 200, body: { messages: [] } };
   return { status: 200, body: { session } };
  });
  if (on) f.storage.set(REVIEWS_STORAGE_KEY, "v2");
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/sessions/" + session.sessionId], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/sessions/:id", element: h(SessionScreen, {}) }) }) }) }) }) }));
  return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
 }
 it("switch off: no review card and no review call", async () => {
  const server = reviewServer({ review: reviewView({ claim: claimOf() }) }), f = page(server, false);
  await screen.findByRole("heading", { name: "Fix duplicate refunds" });await screen.findByRole("tab", { name: "Pipeline" });
  expect(screen.queryByRole("region", { name: "Review" })).toBeNull();expect(server.calls).toHaveLength(0);f.close();
 });
 it("switch on: the card reads the task's own review", async () => {
  const server = reviewServer({ review: reviewView({ claim: claimOf() }) }), f = page(server, true);
  expect(await within(await cardRegion()).findByText(/Claimed by/u)).toBeTruthy();expect(server.reviewCalls()[0]!.path).toBe("/v1/app/tasks/" + taskFixture().taskId + "/review");f.close();
 });
});
