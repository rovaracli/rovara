// @vitest-environment jsdom
// Company rules (lane exp/company-rules, switch `si`): Settings > Company rules. The page reads the current version, proposes a change that a second admin approves, shows what waits, the history and the optional repository file.
// Every answer here is a fixture the contract's strict schemas accept; the page reads them with the forward-compatible readers.
import { expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema, CompanyRulesBodySchema, type CompanyRulesState } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { CompanyRulesScreen } from "../../packages/ui/src/screens/admin/company-rules/CompanyRulesScreen.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { ADA, DIGEST, DIGEST2, LIMITS, OMAR, PROPOSAL_ID, REPO, RULES_14, currentVersion, diffOf, historyFor, memberState, proposalFor, stateFor, syncFor, syncSummary, versionViewFor } from "./support/company-rules-fixture.js";

const PATH = "/v1/app/org/company-rules";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const notFound = { status: 404, body: { error: { code: "NOT_FOUND", message: "This item wasn't found, or you no longer have access." } } };
const refusal = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const asButton = (node: HTMLElement): HTMLButtonElement => { if (!(node instanceof HTMLButtonElement)) throw new Error("not a button"); return node; };
const asText = (node: HTMLElement): HTMLTextAreaElement => { if (!(node instanceof HTMLTextAreaElement)) throw new Error("not a textarea"); return node; };

interface Options { role?: "owner" | "admin" | "member" | "auditor"; state?: CompanyRulesState; history?: unknown; sync?: unknown; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined> }
function mount(options: Options = {}) {
 const role = options.role ?? "owner", store = { state: options.state ?? stateFor({ viewer: { role: role === "admin" ? "admin" : "owner", canPropose: true, canDecide: true } }) };
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: role === "auditor" ? "member" : role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async request => {
  const custom = await options.respond?.(request);
  if (custom !== undefined) return custom;
  if (request.path === "/v1/app/nav") return { status: 200, body: nav };
  if (request.path === "/v1/app/me") return { status: 200, body: me };
  if (request.method === "GET" && request.path === PATH) return { status: 200, body: store.state };
  if (request.method === "GET" && request.path.startsWith(PATH + "/history")) return { status: 200, body: options.history ?? historyFor() };
  const version = /\/versions\/(\d+)$/u.exec(request.path);
  if (request.method === "GET" && version !== null) return { status: 200, body: versionViewFor(Number(version[1])) };
  if (request.method === "GET" && request.path === PATH + "/sync") return { status: 200, body: options.sync ?? { connected: false } };
  return notFound;
 });
 f.host.kind = "web";
 f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
 const query = createQueryClient();
 query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/company-rules"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, store, router, query, close: () => { view.unmount();router.dispose();query.clear(); } };
}
/** The screen alone, with the admin context a member would not have (the layout keeps members out; the screen still renders what the server says). */
function mountScreen(state: CompanyRulesState, respond?: Options["respond"]) {
 const f = fakeHost(async request => (await respond?.(request)) ?? (request.method === "GET" && request.path === PATH ? { status: 200, body: state } : notFound));
 f.host.kind = "web";
 const query = createQueryClient();
 const router = createMemoryRouter([{ element: h(Outlet, { context: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", company: "Acme", developerId: "a".repeat(64), role: "member", checking: false } }), children: [{ path: "/rules", element: h(CompanyRulesScreen) }] }], { initialEntries: ["/rules"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, close: () => { view.unmount();router.dispose();query.clear(); } };
}
const posts = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");
const gets = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }, prefix = PATH) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "GET" && request.path.startsWith(prefix));
const open = async () => { await screen.findByRole("heading", { name: "Company rules", level: 1 }); };
const startEditing = async () => { await open();fireEvent.click(await screen.findByRole("button", { name: "Edit the rules" })); };
const accepted = (state: CompanyRulesState, status = "needs_approval"): ApiResponse => ({ status: status === "needs_approval" ? 202 : 200, body: { status, state } });

it("fixtures are accepted by the contract's strict schemas and the page's own bodies are valid sends", () => {
 expect(stateFor({ pending: proposalFor() }).pending?.proposalId).toBe(PROPOSAL_ID);
 expect(memberState().pending).toBeNull();
 expect(CompanyRulesBodySchema.safeParse({ action: "propose", requestId: PROPOSAL_ID, baseVersion: 1, rules: RULES_14 }).success).toBe(true);
});

it("opens with what company rules are, who follows them and where they rank, the what-changes panel, and the current version with Required and Preferred numbered 1 to 14", async () => {
 const f = mount();
 await open();
 expect(screen.getByRole("heading", { name: "Company rules", level: 1 })).toBe(document.activeElement);
 expect(screen.getByText(/Every agent on every step of every task reads them, in every project/u)).toBeTruthy();
 expect(screen.getByText(/Rovara's own rules come first, then company rules, then each project's How we work, then the task, repository files and tickets/u)).toBeTruthy();
 const note = screen.getByRole("complementary", { name: "About Company rules" });
 expect(within(note).getByText("What a change affects.")).toBeTruthy();expect(within(note).getByText("Who can change it.")).toBeTruthy();
 expect(note.textContent).toContain("A different owner or admin has to approve one before it applies.");
 const current = (await screen.findByRole("heading", { name: "Current rules" })).closest("section")!;
 expect(current.textContent).toContain("Version 1, approved by Rovara setup on Nov 11, 2026 UTC.");
 const lists = within(current).getAllByRole("list");
 expect(lists).toHaveLength(2);
 expect(lists[0]!.querySelectorAll("li")).toHaveLength(7);expect(lists[1]!.querySelectorAll("li")).toHaveLength(7);
 expect(lists[0]!.getAttribute("start")).toBe("1");expect(lists[1]!.getAttribute("start")).toBe("8");
 expect(within(current).getByText(/Never put secrets, passwords/u)).toBeTruthy();
 expect(within(current).getByText("Required (agents must never break these)")).toBeTruthy();
 expect(screen.getByRole("link", { name: "Company rules" }).getAttribute("href")).toBe("/app/admin/company-rules");
 expect(gets(f).every(request => request.method === "GET")).toBe(true);
 f.close();
});

it("a proposal: edit one rule, see the change and the preview as agents read it, add a note, send the whole list against the loaded version, and see 'Waiting for a second admin'", async () => {
 const waiting = stateFor({ pending: proposalFor({ proposedByYou: true, approval: { canApprove: false, reason: "you_proposed", freshSignInNeeded: true, soleOwner: { available: false, availableAt: "2026-11-12T06:00:00.000Z", reasonCode: "SOLE_OWNER_COOL_OFF" } } }) });
 const f = mount({ respond: async request => (request.method === "POST" ? accepted(waiting) : undefined) });
 await startEditing();
 expect(screen.getAllByRole("textbox", { name: /^Rule \d+/u })).toHaveLength(14);
 expect(screen.getByText("Rules 14/30")).toBeTruthy();
 expect(screen.getByText(/Characters 2[,\d]+\/12,000/u)).toBeTruthy();
 const submit = asButton(screen.getByRole("button", { name: "Propose this change" }));
 expect(submit.disabled).toBe(true);
 expect(screen.getAllByText("Nothing has changed yet.").length).toBeGreaterThan(0);
 const text = "Prefer the cheapest model that can do the step well, and explain when a step needs more.";
 fireEvent.change(screen.getByLabelText("Rule 13"), { target: { value: text } });
 expect(submit.disabled).toBe(false);
 const changes = screen.getByRole("group", { name: "Your changes against the current rules" });
 expect(changes.textContent).toContain("0 added, 0 removed, 1 changed, 13 unchanged");
 expect(within(changes).getByText("Changed")).toBeTruthy();
 const preview = screen.getByLabelText("The standing instructions block as agents read it");
 expect(preview.textContent).toContain("Standing instructions. These come from the people who run this work");
 expect(preview.textContent).toContain("1. Company rules (set by your company's admins)\nRequired (never break these):\n- Never put secrets");
 expect(preview.textContent).toContain("Preferred (follow these unless the task cannot be done that way, and say so when you do not):");
 expect(preview.textContent).toContain("- " + text);
 expect(preview.textContent).toContain("End of standing instructions");
 fireEvent.change(screen.getByLabelText(/^Note for the other admin/u), { target: { value: "Shorter wording" } });
 fireEvent.click(submit);
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 const sent = posts(f)[0]!;
 expect(sent).toMatchObject({ path: PATH, retry: "never", body: { action: "propose", baseVersion: 1, note: "Shorter wording" } });
 const body = CompanyRulesBodySchema.parse(sent.body);
 if (body.action !== "propose") throw new Error("not a proposal");
 expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u);
 expect(body.rules).toHaveLength(14);
 expect(body.rules[12]).toEqual({ priority: "preferred", text });
 expect(body.rules.slice(0, 7).every(rule => rule.priority === "required")).toBe(true);
 await screen.findByText("Proposed. It is waiting for a second admin.");
 const pending = screen.getByRole("heading", { name: "Waiting for a decision" }).closest("section")!;
 expect(within(pending).getByText("Waiting for a second admin")).toBeTruthy();
 expect(within(pending).getByRole("button", { name: "Cancel this proposal" })).toBeTruthy();
 expect(within(pending).queryByRole("button", { name: "Approve" })).toBeNull();
 expect(screen.getByText(/A change is already waiting for a decision/u)).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Edit the rules" })).toBeNull();
 f.close();
});

it("blocks a submit over a limit with the size budget sentence, and allows exactly 600 characters in a rule", async () => {
 const f = mount();
 await startEditing();
 const submit = asButton(screen.getByRole("button", { name: "Propose this change" }));
 fireEvent.change(screen.getByLabelText("Rule 1"), { target: { value: "x".repeat(601) } });
 expect(submit.disabled).toBe(true);
 expect(screen.getByText("Company rules exceed the size budget: rule 1 has 601 characters, at most 600. Shorten it.")).toBeTruthy();
 expect(screen.getByText("601/600 characters")).toBeTruthy();
 expect(screen.getByText("This rule has 601 characters, at most 600.")).toBeTruthy();
 fireEvent.click(submit);
 expect(posts(f)).toHaveLength(0);
 fireEvent.change(screen.getByLabelText("Rule 1"), { target: { value: "x".repeat(600) } });
 expect(submit.disabled).toBe(false);
 expect(screen.getByText("600/600 characters")).toBeTruthy();
 f.close();
});

it("30 rules is the most: the add buttons stop there, and the counter says 30/30", async () => {
 const thirty = Array.from({ length: 30 }, (_, index) => ({ text: "Rule text number " + String(index + 1), priority: index < 10 ? "required" as const : "preferred" as const }));
 const f = mount({ state: stateFor({ current: currentVersion({ rules: thirty, ruleCount: 30 }) }) });
 await startEditing();
 expect(screen.getByText("Rules 30/30")).toBeTruthy();
 expect(asButton(screen.getByRole("button", { name: "Add a Required rule" })).disabled).toBe(true);
 expect(asButton(screen.getByRole("button", { name: "Add a Preferred rule" })).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Delete, rule 30" }));
 expect(screen.getByText("Rules 29/30")).toBeTruthy();
 expect(asButton(screen.getByRole("button", { name: "Add a Preferred rule" })).disabled).toBe(false);
 f.close();
});

it("reorders by keyboard-reachable buttons that keep focus, switches Required and Preferred, deletes, and adds", async () => {
 const f = mount();
 await startEditing();
 const first = asText(screen.getByLabelText("Rule 1")).value;
 const down = screen.getByRole("button", { name: "Move down, rule 1" });
 down.focus();
 fireEvent.click(down);
 expect(asText(screen.getByLabelText("Rule 2")).value).toBe(first);
 expect((document.activeElement as HTMLElement).getAttribute("data-action")).toBe("down");
 expect(asButton(screen.getByRole("button", { name: "Move up, rule 1" })).disabled).toBe(true);
 expect(asButton(screen.getByRole("button", { name: "Move down, rule 7" })).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Make Preferred, rule 1" }));
 expect(screen.getByText(/Rules 14\/30/u)).toBeTruthy();
 expect(asText(screen.getByLabelText("Rule 14")).value).toBe(RULES_14[1]!.text);
 expect(screen.getByRole("button", { name: "Make Required, rule 14" })).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Delete, rule 14" }));
 expect(screen.getByText(/Rules 13\/30/u)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Add a Required rule" }));
 const added = asText(screen.getByLabelText("Rule 7"));
 expect(added.value).toBe("");
 expect(document.activeElement).toBe(added);
 expect(screen.getByText("Rule 7 is empty. Write it or delete it.")).toBeTruthy();
 expect(asButton(screen.getByRole("button", { name: "Propose this change" })).disabled).toBe(true);
 f.close();
});

it("an empty list: no company rules yet is a valid state; the first proposal needs at least one rule and goes out against version 0", async () => {
 const waiting = stateFor({ current: currentVersion({ version: 1 }), pending: proposalFor({ proposedByYou: true }) });
 const f = mount({ state: stateFor({ current: null }), respond: async request => (request.method === "POST" ? accepted(waiting) : undefined) });
 await open();
 expect(await screen.findByText(/There are no company rules yet/u)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Write the first rules" }));
 expect(screen.queryAllByRole("textbox", { name: /^Rule/u })).toHaveLength(0);
 expect(screen.getByText("Rules 0/30")).toBeTruthy();
 expect(screen.getByText("Add at least one rule to propose a change.")).toBeTruthy();
 expect(screen.getByText("With no company rules, agents get no company section.")).toBeTruthy();
 expect(asButton(screen.getByRole("button", { name: "Propose this change" })).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Add a Required rule" }));
 fireEvent.change(screen.getByLabelText("Rule 1"), { target: { value: "Never ship without a review." } });
 fireEvent.click(screen.getByRole("button", { name: "Propose this change" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]!.body).toMatchObject({ action: "propose", baseVersion: 0, rules: [{ text: "Never ship without a review.", priority: "required" }] });
 f.close();
});

it("a version that holds no rules reads as none, not as an error", async () => {
 const f = mount({ state: stateFor({ current: currentVersion({ rules: [], ruleCount: 0 }) }) });
 await open();
 expect(await screen.findByText(/There are no company rules yet/u)).toBeTruthy();
 f.close();
});

it("a pending proposal for a different admin: the diff (changed rule, was and now), Approve and Reject, and no Cancel; Approve sends the digest that was shown and the answer replaces the page", async () => {
 const approved = stateFor({ current: currentVersion({ version: 2, approvedBy: OMAR, proposedBy: ADA, source: "rovara", approvalMode: "second_person" }), pending: null });
 const f = mount({ role: "admin", state: stateFor({ viewer: { role: "admin", canPropose: true, canDecide: true }, pending: proposalFor() }), respond: async request => (request.method === "POST" ? accepted(approved, "approved") : undefined) });
 await open();
 const pending = (await screen.findByRole("heading", { name: "Waiting for a decision" })).closest("section")!;
 expect(within(pending).getByText("A change is waiting for your decision")).toBeTruthy();
 expect(pending.textContent).toContain("Ada Admin");
 expect(pending.textContent).toContain("Shorter wording for rule 13");
 expect(pending.textContent).toContain("Nov 18, 2026 UTC");
 const diff = within(pending).getByRole("group", { name: "The proposal against the current rules" });
 expect(diff.textContent).toContain("0 added, 0 removed, 1 changed, 13 unchanged");
 expect(within(diff).getByText(/Was \(Preferred\):/u).parentElement!.textContent).toContain("Prefer the cheapest model and the shortest run");
 expect(within(diff).getByText(/Now \(Preferred\):/u).parentElement!.textContent).toContain("Prefer the cheapest model that can do the step well");
 expect(within(pending).queryByRole("button", { name: "Cancel this proposal" })).toBeNull();
 expect(within(pending).getByText(/Approving needs a sign-in within the last 10 minutes/u)).toBeTruthy();
 expect(asButton(within(pending).getByRole("button", { name: "Approve" })).disabled).toBe(false);
 expect(within(pending).getByRole("button", { name: "Reject" })).toBeTruthy();
 fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]).toMatchObject({ path: PATH, retry: "never", body: { action: "approve", proposalId: PROPOSAL_ID, expectedDigest: DIGEST2 } });
 expect(posts(f)[0]!.body).not.toHaveProperty("soleOwnerAcknowledged");
 await screen.findByText(/Approved\. The new version applies/u);
 await waitFor(() => expect(screen.queryByRole("heading", { name: "Waiting for a decision" })).toBeNull());
 // The section that sent the approval is gone; its done-sentence is still on the page.
 expect(screen.getAllByRole("status").some(node => node.textContent?.includes("Approved. The new version applies") === true)).toBe(true);
 expect(screen.getByRole("heading", { name: "Current rules" }).closest("section")!.textContent).toContain("Version 2, approved by Omar Owner on Nov 11, 2026 UTC.");
 f.close();
});

it("Reject sends the digest and says the rules stay; Reject stays open when the proposal is stale while Approve is off with the reason", async () => {
 const f = mount({ role: "admin", state: stateFor({ viewer: { role: "admin", canPropose: true, canDecide: true }, pending: proposalFor({ stale: true, approval: { canApprove: false, reason: "stale", freshSignInNeeded: true, soleOwner: null } }) }), respond: async request => (request.method === "POST" ? accepted(stateFor(), "rejected") : undefined) });
 await open();
 const pending = (await screen.findByRole("heading", { name: "Waiting for a decision" })).closest("section")!;
 expect(asButton(within(pending).getByRole("button", { name: "Approve" })).disabled).toBe(true);
 expect(within(pending).getByText(/The rules changed after this was proposed, so it can't be approved/u)).toBeTruthy();
 fireEvent.click(within(pending).getByRole("button", { name: "Reject" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]!.body).toEqual({ action: "reject", proposalId: PROPOSAL_ID, expectedDigest: DIGEST2 });
 await screen.findByText("Rejected. The rules stay as they were.");
 f.close();
});

it("the proposer sees Cancel, never Approve, and is told they can't approve their own", async () => {
 const f = mount({ state: stateFor({ pending: proposalFor({ proposedByYou: true, approval: { canApprove: false, reason: "you_proposed", freshSignInNeeded: true, soleOwner: { available: false, availableAt: "2026-11-12T06:00:00.000Z", reasonCode: "SOLE_OWNER_COOL_OFF" } } }) }), respond: async request => (request.method === "POST" ? accepted(stateFor(), "cancelled") : undefined) });
 await open();
 const pending = (await screen.findByRole("heading", { name: "Waiting for a decision" })).closest("section")!;
 expect(within(pending).getByText("Waiting for a second admin")).toBeTruthy();
 expect(within(pending).getByText(/You proposed this, so you can't approve it/u)).toBeTruthy();
 expect(within(pending).queryByRole("button", { name: "Approve" })).toBeNull();
 expect(within(pending).queryByRole("button", { name: "Reject" })).toBeNull();
 expect(within(pending).getByText(/after a 24 hour wait\. From Nov 12, 2026, 06:00 UTC\./u)).toBeTruthy();
 expect(pending.textContent).toContain("(you)");
 fireEvent.click(within(pending).getByRole("button", { name: "Cancel this proposal" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]!.body).toEqual({ action: "cancel", proposalId: PROPOSAL_ID });
 await screen.findByText("The proposal was cancelled.");
 f.close();
});

it("the sole owner may approve their own proposal only when the server says it is available, after ticking the acknowledgement", async () => {
 const state = stateFor({ pending: proposalFor({ proposedByYou: true, approval: { canApprove: true, reason: "you_proposed", freshSignInNeeded: true, soleOwner: { available: true, availableAt: null, reasonCode: "SOLE_OWNER_EXCEPTION_AVAILABLE" } } }) });
 const f = mount({ state, respond: async request => (request.method === "POST" ? accepted(stateFor(), "approved") : undefined) });
 await open();
 const button = asButton(await screen.findByRole("button", { name: "Approve as the only owner" }));
 expect(button.disabled).toBe(true);
 fireEvent.click(screen.getByRole("checkbox", { name: /I understand I am approving my own proposal/u }));
 await waitFor(() => expect(button.disabled).toBe(false));
 fireEvent.click(button);
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]!.body).toEqual({ action: "approve", proposalId: PROPOSAL_ID, expectedDigest: DIGEST2, soleOwnerAcknowledged: true });
 f.close();
});

it("a refusal for a recent sign-in shows the server's words and a 'Sign in again' that returns to this page", async () => {
 const message = "Sign in again to approve this change.";
 const f = mount({ role: "admin", state: stateFor({ viewer: { role: "admin", canPropose: true, canDecide: true }, pending: proposalFor() }), respond: async request => (request.method === "POST" ? refusal(403, "REAUTH_REQUIRED", message) : undefined) });
 await open();
 fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
 const alert = await screen.findByRole("alert");
 expect(alert.textContent).toContain(message);
 fireEvent.click(within(alert).getByRole("button", { name: "Sign in again" }));
 expect(f.host.signIn).toHaveBeenCalledWith("/app/live");
 expect(posts(f)).toHaveLength(1);
 f.close();
});

it("shows each refusal in the server's own words, and re-reads after a stale change", async () => {
 const cases: Array<[number, string, string]> = [
  [400, "CONFIG_INVALID", "Company rules exceed the size budget: 12040 characters in all, at most 12000. Ask a company admin to shorten the company rules."],
  [403, "FORBIDDEN", "Use a live browser session to change the company rules."],
  [409, "CHANGE_STALE", "Another change is already waiting. Decide it first."],
  [409, "IDEMPOTENCY_CONFLICT", "This request id was used for a different change."],
  [503, "AUDIT_UNAVAILABLE", "The audit ledger is not available, so no change was made."],
 ];
 for (const [status, code, message] of cases) {
  const f = mount({ respond: async request => (request.method === "POST" ? refusal(status, code, message) : undefined) });
  await startEditing();
  fireEvent.change(screen.getByLabelText("Rule 1"), { target: { value: "Changed once." } });
  const reads = gets(f).length;
  fireEvent.click(screen.getByRole("button", { name: "Propose this change" }));
  const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
  expect(alert.textContent).toContain(message);
  // The draft is kept so nothing the person wrote is lost.
  expect(asText(screen.getByLabelText("Rule 1")).value).toBe("Changed once.");
  if (code === "CHANGE_STALE" || status === 403) await waitFor(() => expect(gets(f).length).toBeGreaterThan(reads));
  f.close();
 }
});

it("a repeat of a failed proposal keeps its request id, and a changed draft gets a new one", async () => {
 let count = 0;
 const f = mount({ respond: async request => (request.method === "POST" ? (count++ < 2 ? refusal(503, "RUNTIME_UNAVAILABLE", "Try later.") : accepted(stateFor({ pending: proposalFor({ proposedByYou: true }) }))) : undefined) });
 await startEditing();
 fireEvent.change(screen.getByLabelText("Rule 1"), { target: { value: "Changed once." } });
 fireEvent.click(screen.getByRole("button", { name: "Propose this change" }));
 await screen.findByText("Try later.");
 fireEvent.click(screen.getByRole("button", { name: "Propose this change" }));
 await waitFor(() => expect(posts(f)).toHaveLength(2));
 const id = (request: ApiRequest) => (request.body as { requestId: string }).requestId;
 expect(id(posts(f)[1]!)).toBe(id(posts(f)[0]!));
 fireEvent.change(screen.getByLabelText("Rule 1"), { target: { value: "Changed twice." } });
 await waitFor(() => expect(posts(f)).toHaveLength(2));
 fireEvent.click(screen.getByRole("button", { name: "Propose this change" }));
 await waitFor(() => expect(posts(f)).toHaveLength(3));
 expect(id(posts(f)[2]!)).not.toBe(id(posts(f)[0]!));
 f.close();
});

it("tells the editor when the rules moved while they were editing, and blocks the send", async () => {
 const f = mount();
 await startEditing();
 fireEvent.change(screen.getByLabelText("Rule 1"), { target: { value: "Changed once." } });
 expect(asButton(screen.getByRole("button", { name: "Propose this change" })).disabled).toBe(false);
 f.store.state = stateFor({ current: currentVersion({ version: 2 }) });
 await f.query.invalidateQueries({ queryKey: ["admin", "company-rules"], exact: true });
 await screen.findByText(/The company rules changed while you were editing/u);
 expect(asButton(screen.getByRole("button", { name: "Propose this change" })).disabled).toBe(true);
 f.close();
});

it("with the switch off the page says so in plain words and offers no editing", async () => {
 const f = mount({ respond: async request => (request.path === PATH ? notFound : undefined) });
 await open();
 expect(await screen.findByText(/Company rules are switched off for this install/u)).toBeTruthy();
 expect(screen.queryByRole("button", { name: /Edit the rules|Write the first rules|Propose/u })).toBeNull();
 expect(screen.queryByRole("heading", { name: "History" })).toBeNull();
 expect(gets(f).filter(request => request.path !== PATH)).toEqual([]);
 f.close();
});

it("a failed read says so and offers to try again", async () => {
 let fail = true;
 const f = mount({ respond: async request => (request.path === PATH && request.method === "GET" && fail ? refusal(403, "FORBIDDEN", "Rovara's store is not available.") : undefined) });
 expect((await screen.findByRole("alert", {}, { timeout: 3000 })).textContent).toContain("Rovara's store is not available.");
 await open();
 fail = false;
 fireEvent.click(screen.getByRole("button", { name: "Try again" }));
 await screen.findByRole("heading", { name: "Current rules" });
 f.close();
});

it("a member reads the current version only: no edit, no history, no repository file, and no request for them", async () => {
 const f = mountScreen(memberState());
 await open();
 const current = (await screen.findByRole("heading", { name: "Current rules" })).closest("section")!;
 expect(current.textContent).toContain("Version 1 on Nov 11, 2026 UTC.");
 expect(current.textContent).not.toContain("approved by");
 expect(within(current).getAllByRole("listitem")).toHaveLength(14);
 expect(screen.getByRole("complementary", { name: "About Company rules" }).textContent).toContain("You can't change this here. You are a member.");
 expect(screen.queryByRole("button", { name: /Edit|Propose|Approve|Reject|Sync|Connect/u })).toBeNull();
 expect(screen.queryByRole("heading", { name: /History|Company repository file|Waiting for a decision|Propose a change/u })).toBeNull();
 expect(f.request.mock.calls.map(([request]) => request.path)).toEqual([PATH]);
 f.close();
});

it("an owner or admin whose server says they cannot propose gets no editor; the page follows the server, not the role name", async () => {
 const f = mount({ state: stateFor({ viewer: { role: "admin", canPropose: false, canDecide: false }, pending: proposalFor() }) });
 await open();
 await screen.findByRole("heading", { name: "Waiting for a decision" });
 expect(screen.queryByRole("heading", { name: "Propose a change" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
 f.close();
});

for (const role of ["member", "auditor"] as const) it(`a ${role} cannot open the page: administration is for owners and admins, and no company rules request is made`, async () => {
 const f = mount({ role });
 expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();
 expect(f.request.mock.calls.filter(([request]) => request.path.startsWith(PATH))).toEqual([]);
 f.close();
});

it("the history lists each version with who proposed, who approved and when, the proposals that did not become a version, and opens any version with what it changed", async () => {
 const f = mount();
 const history = (await screen.findByRole("heading", { name: "History" })).closest("section")!;
 const two = (await within(history).findByRole("heading", { name: "Version 2" })).closest("li")!;
 expect(two.textContent).toContain("Approved Nov 12, 2026 UTC by Omar Owner. Proposed by Ada Admin. 14 rules.");
 expect(two.textContent).toContain("A second admin approved it.");
 expect(two.textContent).toContain("0 added, 0 removed, 1 changed, 13 unchanged");
 const one = within(history).getByRole("heading", { name: "Version 1" }).closest("li")!;
 expect(one.textContent).toContain("by Rovara setup");
 expect(one.textContent).toContain("Loaded when Rovara was set up");
 expect(history.textContent).toContain("Rejected");
 expect(history.textContent).toContain("Company repository (pat-the-editor)");
 expect(history.textContent).toContain("Source: The repository file.");
 fireEvent.click(within(history).getByRole("button", { name: "View version 2" }));
 const view = await within(history).findByRole("region", { name: "Version 2" });
 await within(view).findByRole("group", { name: "Changes in version 2" });
 expect(view.textContent).toContain("Changes from the version before");
 expect(within(view).getByText("Changed")).toBeTruthy();
 expect(view.textContent).toContain("Prefer the cheapest model that can do the step well, and explain when a step needs more.");
 expect(f.request.mock.calls.some(([request]) => request.path === PATH + "/versions/2")).toBe(true);
 fireEvent.click(within(view).getByRole("button", { name: "Close this version" }));
 expect(within(history).queryByRole("region", { name: "Version 2" })).toBeNull();
 f.close();
});

it("history pages: older versions load on request with the page's cursor", async () => {
 const first = historyFor({ nextBefore: 1, entries: historyFor().entries.slice(0, 1) });
 const older = historyFor({ nextBefore: null, entries: historyFor().entries.slice(1), decided: [] });
 const f = mount({ respond: async request => (request.method === "GET" && request.path.startsWith(PATH + "/history") ? { status: 200, body: request.path.includes("before=1") ? older : first } : undefined) });
 const history = (await screen.findByRole("heading", { name: "History" })).closest("section")!;
 await within(history).findByRole("heading", { name: "Version 2" });
 expect(within(history).queryByRole("heading", { name: "Version 1" })).toBeNull();
 fireEvent.click(within(history).getByRole("button", { name: "Show older versions" }));
 await within(history).findByRole("heading", { name: "Version 1" });
 expect(within(history).queryByRole("button", { name: "Show older versions" })).toBeNull();
 expect(f.request.mock.calls.some(([request]) => request.path === PATH + "/history?limit=20&before=1")).toBe(true);
 f.close();
});

it("history says plainly when no version has been approved, and shows the server's refusal if the history cannot be read", async () => {
 const none = mount({ state: stateFor({ current: null }), history: historyFor({ entries: [], decided: [] }) });
 const section = (await screen.findByRole("heading", { name: "History" })).closest("section")!;
 expect(await within(section).findByText("No version has been approved yet.")).toBeTruthy();
 none.close();
 const refused = mount({ respond: async request => (request.path.startsWith(PATH + "/history") ? refusal(403, "FORBIDDEN", "Only owners and admins can read the history.") : undefined) });
 expect((await screen.findByText("Only owners and admins can read the history.", {}, { timeout: 3000 }))).toBeTruthy();
 refused.close();
});

it("repository file, not connected: says so, checks the name before sending, and connects with the path and branch only when given", async () => {
 const connected = stateFor({ sync: syncSummary() });
 const f = mount({ respond: async request => (request.method === "POST" ? accepted(connected, "done") : undefined) });
 const section = (await screen.findByRole("heading", { name: "Company repository file" })).closest("section")!;
 expect(within(section).getByText("No repository file is connected.")).toBeTruthy();
 expect(within(section).getByText(/Rovara never changes the file directly/u)).toBeTruthy();
 fireEvent.change(within(section).getByLabelText("Repository"), { target: { value: "not a repo" } });
 fireEvent.click(within(section).getByRole("button", { name: "Connect a file" }));
 expect(within(section).getByText("Write the repository as owner/name.")).toBeTruthy();
 expect(posts(f)).toHaveLength(0);
 fireEvent.change(within(section).getByLabelText("Repository"), { target: { value: " acme/company-meta " } });
 fireEvent.click(within(section).getByRole("button", { name: "Connect a file" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]).toMatchObject({ path: PATH, retry: "never", body: { action: "sync-connect", repository: "acme/company-meta" } });
 expect(posts(f)[0]!.body).not.toHaveProperty("path");expect(posts(f)[0]!.body).not.toHaveProperty("branch");
 await screen.findByText(/Connected to acme\/company-meta, file \.rovara\/company-rules\.md on main/u);
 f.close();
 const g = mount({ respond: async request => (request.method === "POST" ? accepted(connected, "done") : undefined) });
 const form = (await screen.findByRole("heading", { name: "Company repository file" })).closest("section")!;
 fireEvent.change(within(form).getByLabelText("Repository"), { target: { value: "acme/company-meta" } });
 fireEvent.change(within(form).getByLabelText("File path (optional)"), { target: { value: "docs/rules.md" } });
 fireEvent.change(within(form).getByLabelText("Branch (optional)"), { target: { value: "release" } });
 fireEvent.click(within(form).getByRole("button", { name: "Connect a file" }));
 await waitFor(() => expect(posts(g)).toHaveLength(1));
 expect(posts(g)[0]!.body).toEqual({ action: "sync-connect", repository: "acme/company-meta", path: "docs/rules.md", branch: "release" });
 g.close();
});

it("connecting is refused: GitHub not connected is shown in the server's words, and a sign-in refusal offers 'Sign in again'", async () => {
 const f = mount({ respond: async request => (request.method === "POST" ? refusal(403, "GITHUB_NOT_CONNECTED", "Your company's GitHub connection does not reach that repository.") : undefined) });
 const section = (await screen.findByRole("heading", { name: "Company repository file" })).closest("section")!;
 fireEvent.change(within(section).getByLabelText("Repository"), { target: { value: "acme/other" } });
 fireEvent.click(within(section).getByRole("button", { name: "Connect a file" }));
 expect((await within(section).findByRole("alert")).textContent).toContain("Your company's GitHub connection does not reach that repository.");
 f.close();
 const g = mount({ respond: async request => (request.method === "POST" ? refusal(403, "REAUTH_REQUIRED", "Sign in again to connect a file.") : undefined) });
 const form = (await screen.findByRole("heading", { name: "Company repository file" })).closest("section")!;
 fireEvent.change(within(form).getByLabelText("Repository"), { target: { value: "acme/other" } });
 fireEvent.click(within(form).getByRole("button", { name: "Connect a file" }));
 fireEvent.click(await within(form).findByRole("button", { name: "Sign in again" }));
 expect(g.host.signIn).toHaveBeenCalled();
 g.close();
});

const STATUSES: Array<[string, string]> = [["in_sync", "In sync"], ["file_differs", "The file differs from Rovara"], ["file_missing", "The file is missing from the repository"], ["file_unreadable", "Rovara couldn't read the file"], ["waiting_for_pull_request", "Waiting for a pull request to be merged"], ["never_checked", "Not checked yet"], ["problem", "There is a problem"]];
for (const [status, words] of STATUSES) it(`repository file, connected, status ${status}: the words, never the raw code`, async () => {
 const f = mount({ state: stateFor({ sync: syncSummary({ status, lastCheckedAt: status === "never_checked" ? null : "2026-11-11T10:00:00.000Z" }) }), sync: syncFor({ fileState: status === "file_differs" ? "differs" : status === "file_missing" ? "missing" : status === "file_unreadable" ? "unreadable" : status === "never_checked" ? "never_checked" : "match", lastCheckedAt: status === "never_checked" ? null : "2026-11-11T10:00:00.000Z", diff: null }) });
 const section = (await screen.findByRole("heading", { name: "Company repository file" })).closest("section")!;
 await within(section).findByText(/Connected by/u);
 expect(section.textContent).toContain(words + ".");
 if (status.includes("_")) expect(section.textContent).not.toContain(status);
 expect(section.textContent).toContain("Connected to acme/company-meta, file .rovara/company-rules.md on main.");
 f.close();
});

it("repository file that differs: shows the diff, says the file was edited when a proposal came from it, and shows a problem's fixed sentence", async () => {
 const edited = RULES_14.map((rule, index) => (index === 3 ? { ...rule, text: "Keep every change inside the task's scope." } : rule));
 const diff = diffOf(RULES_14.map((rule, index) => (index === 3 ? { kind: "changed" as const, before: rule, after: edited[index]! } : { kind: "same" as const, after: rule })));
 const f = mount({ state: stateFor({ sync: syncSummary({ status: "file_differs" }), pending: proposalFor({ source: "repo", proposedBy: REPO, note: "Edit the scope rule" }) }),
  sync: syncFor({ fileState: "differs", fileRules: edited, diff, pendingFromRepo: true, problem: { code: "no_write_access", text: "Rovara may not write to this repository, so it cannot send the approved rules to the file." } }) });
 const section = (await screen.findByRole("heading", { name: "Company repository file" })).closest("section")!;
 await within(section).findByText("How the file differs from Rovara");
 expect(section.textContent).toContain("The file was edited. Rovara turned the edit into a proposal above");
 expect(section.textContent).toContain("Removed means only Rovara has the rule. Added means only the file has it.");
 const group = within(section).getByRole("group", { name: "Rovara now compared with the file" });
 expect(group.textContent).toContain("0 added, 0 removed, 1 changed, 13 unchanged");
 expect(group.textContent).toContain("Keep every change inside the task's scope.");
 expect(section.textContent).toContain("Problem. Rovara may not write to this repository");
 const pending = screen.getByRole("heading", { name: "Waiting for a decision" }).closest("section")!;
 expect(pending.textContent).toContain("Company repository (pat-the-editor)");
 expect(pending.textContent).toContain("Commit message");
 expect(within(pending).getByText("A change from the repository file is waiting for an admin")).toBeTruthy();
 expect(within(pending).getByText(/Rejecting a change from the repository file makes Rovara send its own current version back/u)).toBeTruthy();
 f.close();
});

it("repository file: a write-back pull request is a link only when its address is https; Sync now sends one request; Disconnect asks first", async () => {
 const sync = syncFor({ writeBack: { version: 2, state: "open", pullRequest: { number: 12, url: "https://github.com/acme/company-meta/pull/12" }, updatedAt: "2026-11-12T05:30:00.000Z" }, fileState: "differs", diff: diffOf(RULES_14.slice(0, 2).map(after => ({ kind: "same" as const, after }))) });
 const f = mount({ state: stateFor({ sync: syncSummary({ status: "waiting_for_pull_request" }) }), sync, respond: async request => (request.method === "POST" ? accepted(request.body && (request.body as { action: string }).action === "sync-disconnect" ? stateFor({ sync: null }) : stateFor({ sync: syncSummary() }), "done") : undefined) });
 const section = (await screen.findByRole("heading", { name: "Company repository file" })).closest("section")!;
 const link = await within(section).findByRole("link", { name: /pull request #12/u });
 expect(link.getAttribute("href")).toBe("https://github.com/acme/company-meta/pull/12");
 expect(link.getAttribute("rel")).toContain("noopener");
 expect(section.textContent).toContain("Version 2 is open");
 expect(section.textContent).toContain("Rovara has a newer version. The file follows when the pull request is merged.");
 expect(within(section).getByRole("link", { name: /acme\/company-meta/u }).getAttribute("href")).toBe("https://github.com/acme/company-meta");
 fireEvent.click(within(section).getByRole("button", { name: "Sync now" }));
 await waitFor(() => expect(posts(f)).toHaveLength(1));
 expect(posts(f)[0]).toMatchObject({ body: { action: "sync-now" }, retry: "never" });
 await screen.findByText("Checked the file.");
 fireEvent.click(within(section).getByRole("button", { name: "Disconnect" }));
 expect(posts(f)).toHaveLength(1);
 expect(within(section).getByText(/Rovara forgets the connection\. The file is left as it is/u)).toBeTruthy();
 fireEvent.click(within(section).getByRole("button", { name: "Keep it connected" }));
 expect(within(section).queryByText(/Rovara forgets the connection/u)).toBeNull();
 fireEvent.click(within(section).getByRole("button", { name: "Disconnect" }));
 fireEvent.click(within(section).getByRole("button", { name: "Yes, disconnect" }));
 await waitFor(() => expect(posts(f)).toHaveLength(2));
 expect(posts(f)[1]!.body).toEqual({ action: "sync-disconnect" });
 await screen.findByText("No repository file is connected.");
 f.close();
 const bad = mount({ state: stateFor({ sync: syncSummary() }), sync: syncFor({ repository: { name: "acme/company-meta", url: "javascript:alert(1)" }, writeBack: { version: 2, state: "failed", pullRequest: { number: 3, url: "http://github.com/acme/company-meta/pull/3" }, updatedAt: "2026-11-12T05:30:00.000Z" } }) });
 const unsafe = (await screen.findByRole("heading", { name: "Company repository file" })).closest("section")!;
 await within(unsafe).findByText(/Connected by/u);
 expect(within(unsafe).queryAllByRole("link")).toHaveLength(0);
 expect(unsafe.textContent).toContain("pull request #3");
 bad.close();
});

it("text from people and code hosts is plain text: markup is not markup and control characters are visible", async () => {
 const proposal = proposalFor({ note: "<img src=x onerror=alert(1)>‮end", proposedBy: { id: null, name: "Company repository", login: "<b>x</b>" }, source: "repo" });
 const f = mount({ state: stateFor({ pending: proposal, current: currentVersion({ rules: [{ text: "Never <script>alert(1)</script> ​ run", priority: "required" }], ruleCount: 1 }) }) });
 const pending = (await screen.findByRole("heading", { name: "Waiting for a decision" })).closest("section")!;
 expect(pending.querySelector("img")).toBeNull();
 expect(pending.textContent).toContain("<img src=x onerror=alert(1)>[U+202E]end");
 expect(pending.textContent).toContain("Company repository (<b>x</b>)");
 expect(document.querySelector("script")).toBeNull();
 expect(screen.getByText(/Never <script>alert\(1\)<\/script> \[U\+200B\] run/u)).toBeTruthy();
 f.close();
});

it("has no accessibility violations with a pending proposal, the editor open, and a connected file", async () => {
 const f = mount({ state: stateFor({ sync: syncSummary() }), sync: syncFor() });
 await startEditing();
 await screen.findByText(/Connected by/u);
 await expectNoAxeViolations(document.body);
 f.close();
 const g = mount({ role: "admin", state: stateFor({ viewer: { role: "admin", canPropose: true, canDecide: true }, pending: proposalFor() }) });
 await screen.findByRole("heading", { name: "Waiting for a decision" });
 await screen.findByRole("heading", { name: "Version 2" });
 await expectNoAxeViolations(document.body);
 g.close();
});

it("the overview lists Company rules with its blurb, in the group for how work runs", async () => {
 const f = mount();
 f.router.navigate("/app/admin").catch(() => undefined);
 await screen.findByRole("heading", { name: "Company settings", level: 1 });
 const group = screen.getAllByRole("group", { name: "How work runs" })[0]!;
 expect(within(group).getByRole("link", { name: "Company rules" }).getAttribute("href")).toBe("/app/admin/company-rules");
 expect(DIGEST).not.toBe(DIGEST2);
 expect(LIMITS.maxRules).toBe(30);
 f.close();
});
