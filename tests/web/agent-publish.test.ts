// @vitest-environment jsdom
// Agent publishing (exp/agent-publish): the switch, the ask flow (project and company, and the immediate publish for a maintainer), the approver's Approve and Decline (both on the confirmation page, never a POST to decide),
// the requests list, favourites, suggested agents and their reasons. Everything is read against fixtures shaped like the API doc; the server is built in parallel.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { AGENT_PUBLISH_STORAGE_KEY, isAgentPublishOn } from "../../packages/ui/src/screens/agents/publish-flags.js";
import { askEffect, cannotDecideLine, outcomeLine, publicationLine, reasonLabel, stateWords, summaryLines, waitingLine, dedupeSuggested, toggledFavourites } from "../../packages/ui/src/screens/agents/publish-words.js";
import { AgentPublishAnswerReaderSchema, AgentPublishRequestListReaderSchema, MyAgentsReaderSchema, publicationOf } from "../../packages/ui/src/api/agent-publish.js";
import { renderAgents } from "./support/agent-render.js";
import { renderBuilder } from "./support/builder-render.js";
import { agentProfile, AGENT_FIXTURE_ID } from "./support/agent-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { navFixture } from "./support/fixtures.js";
import { ON, agentCard, errorBody, me, myAgents, ok, other, publishRequest, renderRequests, summary, uuid } from "./support/publish-fixture.js";

const PROFILE = "/app/agents/" + AGENT_FIXTURE_ID, PUBLISH = "/v1/app/agents/" + AGENT_FIXTURE_ID + "/publish-requests";
const withPublication = (publication: unknown, agent: Record<string, unknown> = {}) => { const base = agentProfile();return { ...base, agent: { ...base.agent, ...agent, publication } } as unknown as ReturnType<typeof agentProfile>; };
const personal = { level: "personal", projects: [], pending: null };
const sentTo = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }, path: string) => f.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET" && (request.path === path || request.path.startsWith(path + "?")));

it("is off unless the device key says v2", () => {
 const f = fakeHost();
 expect(isAgentPublishOn(f.host)).toBe(false);
 for (const value of ["", "v1", "true", "V2", "1"]) { f.storage.set(AGENT_PUBLISH_STORAGE_KEY, value);expect(isAgentPublishOn(f.host)).toBe(false); }
 f.storage.set(AGENT_PUBLISH_STORAGE_KEY, "v2");expect(isAgentPublishOn(f.host)).toBe(true);
 expect(isAgentPublishOn({ storage: { get() { throw new Error("blocked"); }, set() { /* none */ } } })).toBe(false);
});

it("says plainly that approving a project request moves the agent and a maintainer becomes accountable, and that company-wide needs an admin", () => {
 const project = askEffect("Release notes writer", { kind: "project", project: "payments" });
 expect(project).toContain("moves to the payments project");expect(project).toContain("becomes accountable");expect(project).toContain("keep edit access");
 const company = askEffect("Release notes writer", { kind: "company" });
 expect(company).toContain("Only an admin can approve");expect(company).toContain("You stay its owner");
});
it("words each publication level, waiting line, state, reason and refusal", () => {
 expect(publicationLine({ level: "personal", projects: [], pending: null })).toBe("Only you");
 expect(publicationLine({ level: "project", projects: ["payments"], pending: null })).toBe("payments project");
 expect(publicationLine({ level: "company", projects: [], pending: null })).toBe("Company");
 expect(waitingLine({ kind: "project", project: "payments" })).toBe("Waiting for a payments maintainer");
 expect(waitingLine({ kind: "company" })).toBe("Waiting for an admin");
 expect(waitingLine({ kind: "unknown" })).toBe("Waiting for an approver");
 expect(["pending", "approved", "declined", "withdrawn", "expired", "stale", "failed", "unknown"].map(stateWords)).toEqual(["Waiting", "Approved", "Declined", "Withdrawn", "Expired", "Out of date", "Could not be applied", "Unknown"]);
 expect([reasonLabel("favourite"), reasonLabel("project_roster"), reasonLabel("used_by_you"), reasonLabel("starter"), reasonLabel("unknown")]).toEqual(["Your favourite", "On this project's roster", "You use this", "Starter", undefined]);
 const base = publishRequest(1) as never;
 expect(cannotDecideLine({ ...(base as object), approval: { ...(base as { approval: object }).approval, canDecide: false, reason: "you_requested" } } as never)).toBe("You asked for this, so someone else decides.");
 expect(outcomeLine({ state: "declined", decidedBy: other, declineReason: "Not yet", failureText: null })).toBe("Declined by Ada Admin: Not yet");
 expect(outcomeLine({ state: "stale", decidedBy: null, declineReason: null, failureText: null })).toBe("The agent changed after this was asked. Ask again.");
 expect(summaryLines(summary() as never).map(line => line.label)).toEqual(["Steps", "Tools and access", "Autonomy", "Starts", "Skills"]);
 expect(summaryLines(summary() as never)[1]!.value).toBe("github: read and write; sentry: read");
 expect(toggledFavourites(["a"], "b")).toEqual(["a", "b"]);expect(toggledFavourites(["a", "b"], "a")).toEqual(["b"]);
 expect(dedupeSuggested([agentCard("agt_aaaaaaaaaaaaaaaaaaaa", "A", "favourite")] as never, [agentCard("agt_aaaaaaaaaaaaaaaaaaaa", "A", "used_by_you"), agentCard("ticket-triage", "T", "starter")] as never).map(card => card.agentId)).toEqual(["ticket-triage"]);
});
it("reads the doc's shapes, keeps unknown fields and reads a reason or state a newer server added as unknown", () => {
 const list = AgentPublishRequestListReaderSchema.parse({ requests: [{ ...publishRequest(1), state: "something_new", added: 1 }] });
 expect(list.requests[0]!.state).toBe("unknown");expect(list.requests[0]!.added).toBe(1);
 expect(MyAgentsReaderSchema.parse(myAgents([], [agentCard("ticket-triage", "T", "popular_in_company"), agentCard("ticket-triage", "T", "brand_new")])).suggested.map(card => card.reason)).toEqual(["popular_in_company", "unknown"]);
 expect(AgentPublishAnswerReaderSchema.parse({ status: "published", agent: { agentId: AGENT_FIXTURE_ID, name: "X", extra: true }, request: null }).status).toBe("published");
 expect(publicationOf({ publication: personal })?.level).toBe("personal");expect(publicationOf({})).toBeUndefined();expect(publicationOf({ publication: { level: "x" } })).toBeUndefined();
});

it("with the switch off the profile and directory are today's: no star, no publishing section, and no publishing request is made", async () => {
 const f = renderAgents({ path: PROFILE, profile: withPublication(personal), reply: async () => ok(errorBody("NOT_FOUND", "Not found."), 404) });
 await screen.findByRole("heading", { name: "Payments Expert" });
 expect(screen.queryByText("Who can use it")).toBeNull();expect(screen.queryByRole("button", { name: /^Favourite/ })).toBeNull();expect(screen.queryByRole("button", { name: "Ask to publish" })).toBeNull();
 await new Promise(resolve => setTimeout(resolve, 30));
 expect(f.request.mock.calls.filter(([request]) => /publish-requests|agent-publish-requests|me\/agents/u.test(request.path))).toEqual([]);
 f.close();
 const g = renderAgents({ path: "/app/agents", reply: async () => ok(errorBody("NOT_FOUND", "Not found."), 404) });
 await screen.findByRole("heading", { name: "Agent directory" });await screen.findByRole("link", { name: "Payments Expert" });
 expect(screen.queryByRole("link", { name: /Publish requests/ })).toBeNull();expect(screen.queryByRole("button", { name: /^Favourite/ })).toBeNull();
 expect(g.request.mock.calls.filter(([request]) => /me\/agents|publish-requests/u.test(request.path))).toEqual([]);
 g.close();
});

it("asks to publish to a project: shows the ownership move, the agent's facts and a note, and sends the doc's body", async () => {
 const request = publishRequest(1, { requestedBy: me });
 const f = renderAgents({ path: PROFILE, storage: ON, profile: withPublication(personal), reply: async r => r.path === PUBLISH ? ok({ status: "NEEDS_CONFIRMATION", changes: ["Moves the agent"], request }, 202) : r.path.startsWith("/v1/app/agents/" + AGENT_FIXTURE_ID + "/publish-requests") ? ok({ requests: [] }) : r.path === "/v1/app/me/agents" || r.path.startsWith("/v1/app/me/agents?") ? ok(myAgents([], [])) : ok(errorBody("NOT_FOUND", "Not found."), 404) });
 expect(await screen.findByText("Who can use it")).toBeTruthy();expect(screen.getByText("Only you")).toBeTruthy();
 fireEvent.click(await screen.findByRole("button", { name: "Ask to publish" }));
 const dialog = await screen.findByRole("dialog");
 fireEvent.change(await within(dialog).findByRole("combobox", { name: "Publish to" }), { target: { value: "project:payments" } });
 expect(within(dialog).getByRole("status").textContent).toContain("moves to the payments project");expect(within(dialog).getByRole("status").textContent).toContain("becomes accountable");
 expect(within(dialog).getByText("What you are asking to publish")).toBeTruthy();expect(within(dialog).getByText("Tools and access")).toBeTruthy();expect(within(dialog).getByText("Autonomy")).toBeTruthy();
 fireEvent.change(within(dialog).getByRole("textbox", { name: /A note for the approver/ }), { target: { value: "Used it on 6 releases." } });
 fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
 expect(await within(dialog).findByText("Request sent.")).toBeTruthy();
 expect(within(dialog).getAllByText(/Waiting for a payments maintainer/).length).toBeGreaterThan(0);expect(within(dialog).getByText("What the approver sees")).toBeTruthy();expect(within(dialog).getByText("Adds write access to github")).toBeTruthy();
 expect(within(dialog).queryByRole("button", { name: "Confirm on the next page" })).toBeNull();
 const [sent] = sentTo(f, PUBLISH);expect(sent!.method).toBe("POST");
 expect(sent!.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, target: { kind: "project", project: "payments" }, version: 3, note: "Used it on 6 releases." });
 f.close();
});
it("asks company-wide, says only an admin approves, and shows an admin the confirmation page", async () => {
 const request = publishRequest(2, { requestedBy: me, target: { kind: "company" }, approval: { canDecide: true, reason: null, freshSignInNeeded: true, confirmUrl: "https://cell.example/v1/app/approve/tkt_abc123" } });
 const f = renderAgents({ path: PROFILE, storage: ON, profile: withPublication(personal), reply: async r => r.path === PUBLISH ? ok({ status: "NEEDS_CONFIRMATION", confirmUrl: "https://cell.example/v1/app/approve/tkt_abc123", changes: ["Shares with everyone"], request }, 202) : r.path === "/v1/app/me/agents" ? ok(myAgents([], [])) : r.path.endsWith("/publish-requests") ? ok({ requests: [] }) : ok(errorBody("NOT_FOUND", "Not found."), 404) });
 fireEvent.click(await screen.findByRole("button", { name: "Ask to publish" }));
 const dialog = await screen.findByRole("dialog");
 fireEvent.change(await within(dialog).findByRole("combobox", { name: "Publish to" }), { target: { value: "company" } });
 expect(within(dialog).getByRole("status").textContent).toContain("Only an admin can approve");
 fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
 expect(await within(dialog).findByText("Request sent.")).toBeTruthy();expect(within(dialog).getAllByText(/Waiting for an admin/).length).toBeGreaterThan(0);
 fireEvent.click(within(dialog).getByRole("button", { name: "Confirm on the next page" }));
 expect(f.host.openExternal).toHaveBeenCalledWith("https://cell.example/v1/app/approve/tkt_abc123");
 expect(sentTo(f, PUBLISH)[0]!.body).toMatchObject({ target: { kind: "company" }, version: 3 });
 f.close();
});
it("shows a maintainer's immediate publish as done", async () => {
 const f = renderAgents({ path: PROFILE, storage: ON, profile: withPublication(personal), reply: async r => r.path === PUBLISH ? ok({ status: "published", agent: { agentId: AGENT_FIXTURE_ID, name: "Payments Expert" }, request: null }) : r.path === "/v1/app/me/agents" ? ok(myAgents([], [])) : r.path.endsWith("/publish-requests") ? ok({ requests: [] }) : ok(errorBody("NOT_FOUND", "Not found."), 404) });
 fireEvent.click(await screen.findByRole("button", { name: "Ask to publish" }));
 const dialog = await screen.findByRole("dialog");
 fireEvent.change(await within(dialog).findByRole("combobox", { name: "Publish to" }), { target: { value: "project:payments" } });
 fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
 expect(await within(dialog).findByText("Done.")).toBeTruthy();expect(dialog.textContent).toContain("is now published to the payments project");expect(dialog.textContent).toContain("It belongs to the payments project now");
 expect(within(dialog).queryByText("Request sent.")).toBeNull();
 f.close();
});
it("shows the server's refusal word for word and keeps the form so the ask can be sent again with the same id", async () => {
 let calls = 0;
 const f = renderAgents({ path: PROFILE, storage: ON, profile: withPublication(personal), reply: async r => { if (r.path === PUBLISH && r.method === "POST") { calls += 1;return ok(errorBody("CHANGE_STALE", "A request for this target already waits."), 409); } return r.path === "/v1/app/me/agents" ? ok(myAgents([], [])) : r.path.endsWith("/publish-requests") ? ok({ requests: [] }) : ok(errorBody("NOT_FOUND", "Not found."), 404); } });
 fireEvent.click(await screen.findByRole("button", { name: "Ask to publish" }));
 const dialog = await screen.findByRole("dialog");
 fireEvent.change(await within(dialog).findByRole("combobox", { name: "Publish to" }), { target: { value: "company" } });
 fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
 expect((await within(dialog).findByRole("alert")).textContent).toBe("A request for this target already waits.");
 fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));await waitFor(() => expect(calls).toBe(2));
 const bodies = sentTo(f, PUBLISH).map(request => (request.body as { requestId: string }).requestId);expect(bodies[0]).toBe(bodies[1]);
 f.close();
});
it("offers no ask on a built-in, to someone without manage, or for an agent with no published version", async () => {
 for (const agent of [{ builtin: true, owner: undefined }, { access: "edit" }, { currentVersion: undefined }] as Array<Record<string, unknown>>) {
  const base = withPublication(personal, agent), profile = agent.currentVersion === undefined && "currentVersion" in agent ? ({ ...base, current: undefined } as unknown as typeof base) : base;
  const f = renderAgents({ path: PROFILE, storage: ON, profile, reply: async r => r.path === "/v1/app/me/agents" ? ok(myAgents([], [])) : r.path.endsWith("/publish-requests") ? ok({ requests: [] }) : ok(errorBody("NOT_FOUND", "Not found."), 404) });
  await screen.findByRole("heading", { name: "Payments Expert" });await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.queryByRole("button", { name: "Ask to publish" })).toBeNull();f.close();
 }
});
it("shows a waiting request on the profile, a way in for the person who decides, and Ask again for an out-of-date one", async () => {
 const waiting = publishRequest(3, { requestedBy: me });
 const f = renderAgents({ path: PROFILE, storage: ON, profile: withPublication({ level: "personal", projects: [], pending: { requestId: waiting.requestId, target: waiting.target, requestedAt: waiting.requestedAt } }), reply: async r => r.path === "/v1/app/me/agents" ? ok(myAgents([], [])) : r.path.startsWith("/v1/app/agent-publish-requests") ? ok({ requests: [waiting] }) : r.path.endsWith("/publish-requests") ? ok({ requests: [waiting] }) : ok(errorBody("NOT_FOUND", "Not found."), 404) });
 expect(await screen.findByText(/Waiting for a payments maintainer/)).toBeTruthy();expect(await screen.findByText(waiting.effect)).toBeTruthy();expect(screen.getByText(/Used it on 6 releases/)).toBeTruthy();
 expect(await screen.findByRole("link", { name: "Review and decide" })).toBeTruthy();
 f.close();
 const stale = publishRequest(4, { requestedBy: me, state: "stale" });
 const g = renderAgents({ path: PROFILE, storage: ON, profile: withPublication(personal), reply: async r => r.path === "/v1/app/me/agents" ? ok(myAgents([], [])) : r.path.endsWith("/publish-requests") ? ok({ requests: [stale] }) : ok(errorBody("NOT_FOUND", "Not found."), 404) });
 expect(await screen.findByText(/The agent changed after this was asked. Ask again./)).toBeTruthy();
 fireEvent.click(await screen.findByRole("link", { name: "Ask again" }));
 expect(await screen.findByRole("dialog")).toBeTruthy();
 g.close();
});

const lists = (pending: unknown[], mine: unknown[]) => (r: ApiRequest) => r.path === "/v1/app/nav" ? ok(navFixture()) : r.path.startsWith("/v1/app/agent-publish-requests?") ? ok({ requests: r.path.includes("mine=1") ? mine : pending }) : undefined;
const CONFIRM = "https://cell.example/v1/app/approve/tkt_abc123";
const anyDecide = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }) => f.request.mock.calls.map(([request]) => request).filter(request => request.path.includes("/decide"));
it("lists what waits for an approver with the summary and the less-safe sentences, and approves a project request on the confirmation page", async () => {
 const waiting = publishRequest(1);
 const f = renderRequests(lists([waiting], []));
 expect(await screen.findByRole("heading", { name: "Release notes writer" })).toBeTruthy();
 expect(screen.getByText("This makes the agent less safe:")).toBeTruthy();expect(screen.getByText("Adds write access to github")).toBeTruthy();expect(screen.getByText(waiting.effect)).toBeTruthy();expect(screen.getByText(/Used it on 6 releases/)).toBeTruthy();
 expect(screen.getByRole("tab", { name: "To decide (1)" })).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Approve Release notes writer for payments" }));
 // One click does not leave: a confirm step says what approving does (ownership moves) and that it is confirmed on the next page; Cancel goes nowhere.
 const confirm = screen.getByRole("group", { name: "Confirm approving Release notes writer" });
 expect(within(confirm).getByText(waiting.effect)).toBeTruthy();expect(within(confirm).getByText(/You'll confirm on the next page/)).toBeTruthy();
 fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
 expect(screen.queryByRole("group", { name: "Confirm approving Release notes writer" })).toBeNull();expect(f.host.openExternal).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "Approve Release notes writer for payments" }));
 fireEvent.click(screen.getByRole("button", { name: "Continue to approve" }));
 expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM);
 // The screen never posts a decision: the decide route refuses a script's request (RULING Q10).
 expect(anyDecide(f)).toEqual([]);
 f.close();
});
it("declines on the confirmation page too, where the reason is written", async () => {
 const f = renderRequests(lists([publishRequest(1)], []));
 fireEvent.click(await screen.findByRole("button", { name: "Decline Release notes writer for payments" }));
 const confirm = screen.getByRole("group", { name: "Confirm declining Release notes writer" });
 expect(within(confirm).getByText(/You'll confirm on the next page/)).toBeTruthy();expect(within(confirm).queryByRole("textbox")).toBeNull();
 fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
 expect(screen.queryByRole("group", { name: "Confirm declining Release notes writer" })).toBeNull();expect(f.host.openExternal).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "Decline Release notes writer for payments" }));
 fireEvent.click(screen.getByRole("button", { name: "Continue to decline" }));
 expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM);
 expect(anyDecide(f)).toEqual([]);
 f.close();
});
it("approves a company-wide request on the confirmation page the same way, posting nothing", async () => {
 const company = publishRequest(5, { target: { kind: "company" }, effect: "Shares Release notes writer with everyone." });
 const f = renderRequests(lists([company], []));
 fireEvent.click(await screen.findByRole("button", { name: "Approve Release notes writer for Company" }));
 fireEvent.click(screen.getByRole("button", { name: "Continue to approve" }));
 expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM);
 expect(anyDecide(f)).toEqual([]);
 f.close();
});
it("refuses a confirmation link that is not this app's own", async () => {
 const company = publishRequest(5, { target: { kind: "company" }, approval: { canDecide: true, reason: null, freshSignInNeeded: true, confirmUrl: "https://evil.example/v1/app/approve/tkt_x" } });
 const f = renderRequests(lists([company], []));
 fireEvent.click(await screen.findByRole("button", { name: "Approve Release notes writer for Company" }));
 fireEvent.click(screen.getByRole("button", { name: "Continue to approve" }));
 expect((await screen.findByRole("alert")).textContent).toContain("The confirmation page isn't available");expect(f.host.openExternal).not.toHaveBeenCalled();
 f.close();
});
it("shows my requests with their state, withdraws a waiting one, and hides the button when the server has no withdraw yet", async () => {
 const mine = [publishRequest(1, { requestedBy: me, approval: { canDecide: false, reason: "you_requested", freshSignInNeeded: false, confirmUrl: null } }), publishRequest(2, { requestedBy: me, state: "declined", decidedBy: other, declineReason: "Not yet", approval: { canDecide: false, reason: null, freshSignInNeeded: false, confirmUrl: null } }), publishRequest(3, { requestedBy: me, state: "stale", approval: { canDecide: false, reason: "stale", freshSignInNeeded: false, confirmUrl: null } })];
 let withdraw: "ok" | "missing" = "ok";
 const f = renderRequests(r => lists([], mine)(r) ?? (r.path === "/v1/app/agent-publish-requests/" + uuid(1) + "/withdraw" ? withdraw === "ok" ? ok({ request: { ...mine[0], state: "withdrawn" } }) : ok(errorBody("NOT_FOUND", "Not found."), 404) : undefined));
 expect(await screen.findByText("You asked for this, so someone else decides.")).toBeTruthy();expect(screen.getByText("Declined by Ada Admin: Not yet")).toBeTruthy();expect(screen.getByText("The agent changed after this was asked. Ask again.")).toBeTruthy();
 expect(screen.getByRole("link", { name: "Ask again" }).getAttribute("href")).toBe("/app/agents/" + AGENT_FIXTURE_ID + "?publish=1&to=project%3Apayments");
 expect(screen.getAllByRole("button", { name: /^Withdraw/ }).length).toBe(1);expect(screen.queryByRole("button", { name: /Approve|Decline/ })).toBeNull();
 fireEvent.mouseDown(screen.getByRole("tab", { name: "To decide" }), { button: 0, ctrlKey: false });expect(await screen.findByText("Nothing waits for you to decide.")).toBeTruthy();fireEvent.mouseDown(screen.getByRole("tab", { name: "My requests" }), { button: 0, ctrlKey: false });
 withdraw = "missing";
 fireEvent.click(screen.getByRole("button", { name: "Withdraw the request for Release notes writer" }));
 expect((await screen.findByRole("alert")).textContent).toContain("Withdrawing isn't available yet");
 expect(screen.queryByRole("button", { name: /^Withdraw/ })).toBeNull();
 f.close();
 const g = renderRequests(r => lists([], mine)(r) ?? (r.path.endsWith("/withdraw") ? ok({ request: { ...mine[0], state: "withdrawn" } }) : undefined));
 fireEvent.click(await screen.findByRole("button", { name: "Withdraw the request for Release notes writer" }));
 await waitFor(() => expect(sentTo(g, "/v1/app/agent-publish-requests/" + uuid(1) + "/withdraw").length).toBe(1));
 expect(sentTo(g, "/v1/app/agent-publish-requests/" + uuid(1) + "/withdraw")[0]!.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown });
 g.close();
});
it("is not found while the switch is off", async () => {
 const f = renderRequests(() => undefined, { on: false });
 expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();
 expect(f.request.mock.calls.filter(([request]) => /publish-requests/u.test(request.path))).toEqual([]);
 f.close();
});
it("registers the requests route only while the switch is on; off, the address is like any unknown one and falls to the agent directory", async () => {
 const nav = navFixture(), paths = (publish: boolean) => appRoutes(nav.features, { publish }).flatMap(route => route.children ?? []).map(route => route.path);
 expect(paths(false)).not.toContain("agents/requests");expect(paths(true)).toContain("agents/requests");
 expect(appRoutes(nav.features).flatMap(route => route.children ?? []).map(route => route.path)).not.toContain("agents/requests");
 expect(paths(true).indexOf("agents/requests")).toBeLessThan(paths(true).indexOf("agents/:id?"));
 const open = async (on: boolean) => {
  const f = fakeHost(async request => request.path === "/v1/app/nav" ? ok(nav) : request.path.startsWith("/v1/app/agent-publish-requests") ? ok({ requests: [] }) : ok(errorBody("NOT_FOUND", "Not found."), 404));
  if (on) f.storage.set(AGENT_PUBLISH_STORAGE_KEY, "v2");
  const query = createQueryClient();query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features, { publish: on }), { initialEntries: ["/app/agents/requests"] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
  return { ...f, close() { ui.unmount();router.dispose();query.clear(); } };
 };
 const off = await open(false);
 try {
  // The directory takes "requests" as an agent id, which is not a valid one, so it says "not found" without asking the server.
  await screen.findByText(/We couldn't find that\./);
  expect(screen.queryByRole("heading", { name: "Publish requests" })).toBeNull();
  expect(off.request.mock.calls.filter(([request]) => request.path.startsWith("/v1/app/agent-publish-requests"))).toEqual([]);
 } finally { off.close(); }
 const on = await open(true);
 try {
  expect(await screen.findByRole("heading", { name: "Publish requests" })).toBeTruthy();
  expect(on.request.mock.calls.some(([request]) => request.path === "/v1/app/agents/requests")).toBe(false);
 } finally { on.close(); }
});
for (const theme of ["light", "dark"] as const) it("has an accessible requests page in " + theme, async () => {
 const { expectNoAxeViolations } = await import("./support/axe.js");
 const f = renderRequests(lists([publishRequest(1)], [publishRequest(2, { requestedBy: me, approval: { canDecide: false, reason: "you_requested", freshSignInNeeded: false, confirmUrl: null } })]), { theme });
 await screen.findByRole("heading", { name: "Release notes writer" });await expectNoAxeViolations(f.container);f.close();
});

const A1 = "agt_aaaaaaaaaaaaaaaaaaaa";
function favouritesHost(state: { favourites: unknown[]; revision: number }, extra: (r: ApiRequest) => ReturnType<typeof ok> | undefined = () => undefined) {
 return async (r: ApiRequest) => {
  if (r.path === "/v1/app/me/agents/favourites" && r.method === "PUT") { const body = r.body as { agentIds: string[]; expectedRevision: number };const replied = extra(r);if (replied) return replied;state.favourites = body.agentIds.map(id => agentCard(id, id === A1 ? "Payments Expert" : "Ticket triage", "favourite"));state.revision = body.expectedRevision + 1;return ok({ favourites: state.favourites, revision: state.revision }); }
  if (r.path === "/v1/app/me/agents" || r.path.startsWith("/v1/app/me/agents?")) return ok(myAgents(state.favourites, [agentCard("ticket-triage", "Ticket triage", "starter")], state.revision));
  return ok(errorBody("NOT_FOUND", "Not found."), 404);
 };
}
it("toggles a favourite star on the profile with the revision it read, and every star agrees", async () => {
 const state = { favourites: [] as unknown[], revision: 4 };
 const f = renderAgents({ path: PROFILE, storage: ON, profile: withPublication(personal), reply: favouritesHost(state) });
 const star = await screen.findByRole("button", { name: "Favourite Payments Expert" });
 await waitFor(() => expect((star as HTMLButtonElement).disabled).toBe(false));expect(star.getAttribute("aria-pressed")).toBe("false");
 fireEvent.click(star);
 await waitFor(() => expect(screen.getByRole("button", { name: "Favourite Payments Expert" }).getAttribute("aria-pressed")).toBe("true"));
 const [put] = f.request.mock.calls.map(([request]) => request).filter(request => request.method === "PUT");
 expect(put!.path).toBe("/v1/app/me/agents/favourites");expect(put!.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, expectedRevision: 4, agentIds: [A1] });
 fireEvent.click(screen.getByRole("button", { name: "Favourite Payments Expert" }));
 await waitFor(() => expect(screen.getByRole("button", { name: "Favourite Payments Expert" }).getAttribute("aria-pressed")).toBe("false"));
 expect(f.request.mock.calls.map(([request]) => request).filter(request => request.method === "PUT")[1]!.body).toMatchObject({ expectedRevision: 5, agentIds: [] });
 f.close();
});
it("tells the person when the favourites changed somewhere else or the list is full", async () => {
 const state = { favourites: [] as unknown[], revision: 4 };
 const f = renderAgents({ path: PROFILE, storage: ON, profile: withPublication(personal), reply: favouritesHost(state, () => ok(errorBody("CHANGE_STALE", "The list moved."), 409)) });
 const star = await screen.findByRole("button", { name: "Favourite Payments Expert" });await waitFor(() => expect((star as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(star);
 expect((await screen.findByRole("alert")).textContent).toBe("Your favourites changed somewhere else. Try again.");
 f.close();
 const full = { favourites: Array.from({ length: 12 }, (_, index) => agentCard("agt_" + index.toString(36).padStart(20, "b"), "Agent " + String(index), "favourite")), revision: 9 };
 const g = renderAgents({ path: PROFILE, storage: ON, profile: withPublication(personal), reply: favouritesHost(full) });
 const again = await screen.findByRole("button", { name: "Favourite Payments Expert" });await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(again);
 expect((await screen.findByRole("alert")).textContent).toContain("up to 12 favourites");expect(g.request.mock.calls.filter(([request]) => request.method === "PUT")).toEqual([]);
 g.close();
});
it("shows favourites and suggested agents side by side in the directory, each with its reason, and a star on every card", async () => {
 const state = { favourites: [agentCard(A1, "Payments Expert", "favourite")], revision: 2 };
 const f = renderAgents({ path: "/app/agents", storage: ON, reply: async r => (r.path.startsWith("/v1/app/me/agents") && r.method === "GET") ? ok(myAgents(state.favourites, [agentCard(A1, "Payments Expert", "used_by_you"), agentCard("ticket-triage", "Ticket triage", "starter"), agentCard("agt_bbbbbbbbbbbbbbbbbbbb", "Roster agent", "project_roster"), agentCard("agt_cccccccccccccccccccc", "Mine", "used_by_you")], 2)) : r.path.startsWith("/v1/app/agent-publish-requests") ? ok({ requests: [publishRequest(1)] }) : ok(errorBody("NOT_FOUND", "Not found."), 404) });
 const favourites = await screen.findByRole("region", { name: "Your favourites" }), suggested = await screen.findByRole("region", { name: "Suggested" });
 expect(within(favourites).getByRole("link", { name: "Payments Expert" })).toBeTruthy();
 expect(within(suggested).queryByRole("link", { name: "Payments Expert" })).toBeNull();
 expect(within(suggested).getByText("Starter")).toBeTruthy();expect(within(suggested).getByText("On this project's roster")).toBeTruthy();expect(within(suggested).getByText("You use this")).toBeTruthy();
 expect(screen.getAllByRole("button", { name: "Favourite Payments Expert" }).length).toBeGreaterThanOrEqual(2);
 expect(screen.getAllByRole("button", { name: "Favourite Payments Expert" }).every(button => button.getAttribute("aria-pressed") === "true")).toBe(true);
 expect((await screen.findByRole("link", { name: /Publish requests/ })).getAttribute("href")).toBe("/app/agents/requests");
 f.close();
});
it("shows no favourites or suggestions, and no error, when the server cannot answer yet", async () => {
 const f = renderAgents({ path: "/app/agents", storage: ON, reply: async () => ok(errorBody("NOT_FOUND", "Not found."), 404) });
 await screen.findByRole("link", { name: "Payments Expert" });await new Promise(resolve => setTimeout(resolve, 30));
 expect(screen.queryByRole("region", { name: "Your favourites" })).toBeNull();expect(screen.queryByRole("region", { name: "Suggested" })).toBeNull();expect(screen.queryByRole("button", { name: /^Favourite/ })).toBeNull();
 f.close();
});

it("puts Ask to publish beside Publish in the builder only with the switch on, and only once a version exists", async () => {
 const off = renderBuilder({});await screen.findByRole("button", { name: "Publish" });
 expect(screen.queryByRole("button", { name: "Ask to publish" })).toBeNull();off.close();
 const on = renderBuilder({ storage: ON });await screen.findByRole("button", { name: "Publish" });
 expect(await screen.findByRole("button", { name: "Ask to publish" })).toBeTruthy();on.close();
 const base = agentProfile(), unpublished = agentProfile({ agent: { ...base.agent, currentVersion: undefined, latestVersion: 0 } });
 const none = renderBuilder({ storage: ON, profile: { ...unpublished, current: undefined } as unknown as ReturnType<typeof agentProfile> });await screen.findByRole("button", { name: "Publish" });await new Promise(resolve => setTimeout(resolve, 20));
 expect(screen.queryByRole("button", { name: "Ask to publish" })).toBeNull();none.close();
});
