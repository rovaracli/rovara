// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture as fixture, workspaceWorkflow as workflow } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
function setup(session = fixture(), hash = "", onComment = vi.fn()) {
 const f = fakeHost();const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session: SessionViewReaderSchema.parse(session), onComment })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID + hash] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(RouterProvider, { router }) }));
 return { ...ui, ...f, router, onComment, close() { ui.unmount();router.dispose(); } };
}
it("shows the five supported task tabs and excludes Terminal and Preview", () => {
 const f = setup();expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Pipeline", "Plan", "Tests", "Changes", "Pull request"]);
 expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();expect(screen.queryByRole("tab", { name: "Preview" })).toBeNull();f.close();
});
it("uses the URL hash and restores the chosen evidence tab on a fresh visit", async () => {
 const f = setup(fixture(), "#changes");expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true");expect(screen.getByText("src/refund.ts")).toBeTruthy();
 fireEvent.mouseDown(screen.getByRole("tab", { name: "Plan" }), { button: 0, ctrlKey: false });expect(await screen.findByRole("heading", { name: "Refund investigation" })).toBeTruthy();expect(f.router.state.location.hash).toBe("#plan");f.close();
 const reloaded = setup(fixture(), "#plan");expect(screen.getByRole("tab", { name: "Plan" }).getAttribute("aria-selected")).toBe("true");reloaded.close();
});
it("keeps raw plan HTML and pageHtml out of the document", async () => {
 const task = taskFixture({ workflow: { ...workflow(), planContent: "# Inspect the plan\n\n<script>window.__pwned=1</script>\n\n<iframe src='https://foreign.example'></iframe>" } });
 const f = setup(fixture({ body: { kind: "task", task } }), "#plan");await screen.findByRole("heading", { name: "Inspect the plan" });expect(f.container.querySelector("script,iframe,img")).toBeNull();expect(document.querySelectorAll("h1")).toHaveLength(1);f.close();
});
it("offers review only to the owner while the plan is waiting", async () => {
 for (const owner of [true, false]) {
 const f = setup(fixture({ you: { level: "use", owner, following: false, actions: ["watch", "comment"] } }), "#plan");await screen.findByRole("heading", { name: "Refund investigation" });
 const review = screen.queryByRole("button", { name: "Review and approve the plan" });if (owner) { expect(review).toBeTruthy();fireEvent.click(review!);expect(f.host.openExternal).toHaveBeenCalledWith("https://cell.example/review/11111111-1111-4111-8111-111111111111/task"); } else expect(review).toBeNull();f.close();
 }
});
it("shows the real plan estimate and its run limit without claiming checks passed", async () => {
 const f = setup(fixture(), "#plan");await screen.findByRole("heading", { name: "Refund investigation" });expect(screen.getByText("$0.50")).toBeTruthy();expect(screen.getByText("$1.20")).toBeTruthy();expect(screen.getByText("$2.00")).toBeTruthy();expect(screen.queryByText("Passed")).toBeNull();f.close();
});
it("marks only the server's current pipeline stage", () => {
 const f = setup();const current = f.container.querySelectorAll('[aria-current="step"]');expect(current).toHaveLength(1);expect(current[0]?.textContent).toContain("Plan check");expect(screen.getByText("Understand")).toBeTruthy();expect(screen.getByText("Build")).toBeTruthy();f.close();
});
it("shows agent-step reports as text and no Plan tab without a plan", () => {
 const task = taskFixture({ run: { state: "RUNNING", currentStep: { id: "investigate", name: "Investigate" }, steps: [{ id: "investigate", name: "Investigate", status: "running", report: "<img src=x onerror=alert(1)>" }], pendingApprovals: [] } });
 const f = setup(fixture({ body: { kind: "task", task } }));expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Pipeline"]);expect(screen.queryByRole("tab", { name: "Plan" })).toBeNull();expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();expect(f.container.querySelector("img")).toBeNull();f.close();
});
it("shows structured test evidence while never rendering stored HTML", () => {
 const f = setup(fixture(), "#tests");expect(screen.getByText("No executed evidence yet")).toBeTruthy();expect(screen.getByText("Refund retries have not run")).toBeTruthy();expect(screen.queryByText("Passed")).toBeNull();expect(f.container.querySelector("script")).toBeNull();f.close();
});
it("labels changed lines in words and keeps untrusted file names as text", () => {
 const f = setup(fixture(), "#changes");expect(screen.getByText("12 lines added, 3 removed")).toBeTruthy();expect(screen.getByText("src/refund.ts")).toBeTruthy();f.close();
});
it("links pull requests only to safe GitHub HTTPS URLs", () => {
 const urls = ["https://github.com/acme/payments/pull/42", "http://github.com/acme/payments/pull/42", "https://github.com.foreign.example/acme/payments/pull/42"];
 for (const url of urls) { const f = setup(fixture({ body: { kind: "task", task: taskFixture({ pullRequests: [{ repository: "acme/payments", number: 42, url, state: "open" }] }) } }), "#pull-request");expect(screen.queryAllByRole("link")).toHaveLength(url === urls[0] ? 1 : 0);f.close(); }
});
it("uses only the server-provided anchor when discussing a changed file", () => {
 const anchor = { target: "change_file" as const, targetId: "acme/payments:src/refund.ts", revision: "+12-3" };
 const f = setup(fixture({ anchors: [anchor] }), "#changes");const source = screen.getByRole("button", { name: "Comment on src/refund.ts" });fireEvent.click(source);expect(f.onComment).toHaveBeenCalledExactlyOnceWith(anchor, source);f.close();
 const other = setup(fixture(), "#changes");expect(screen.queryByRole("button", { name: "Comment on src/refund.ts" })).toBeNull();other.close();
});
it("keeps the missing chain contract as an explicit safe seam", () => {
 const f = setup(fixture({ kind: "chain", body: { kind: "chain", chain: { privateTitle: "Hidden chain detail" } } }));expect(screen.getByText("Details aren't available for this session.")).toBeTruthy();expect(screen.queryByText("Hidden chain detail")).toBeNull();f.close();
});
for (const theme of ["light", "dark"] as const) it("keeps the workspace accessible in " + theme, async () => {
 const f = setup(fixture(), "#changes");document.documentElement.setAttribute("data-theme", theme);await expectNoAxeViolations(f.container);f.close();
});

it("attaches discussion only to the real plan paragraph supplied by the server", async () => {
 const anchor = { target: "plan_block" as const, targetId: "p2", revision: "v1" };
 const f = setup(fixture({ anchors: [anchor] }), "#plan");await screen.findByRole("heading", { name: "Refund investigation" });
 const source = screen.getByRole("button", { name: "Comment on plan paragraph 2" });fireEvent.click(source);expect(f.onComment).toHaveBeenCalledExactlyOnceWith(anchor, source);
 expect(screen.queryByRole("button", { name: "Comment on plan paragraph 1" })).toBeNull();f.close();
});
it("makes hidden direction controls visible in plan text without executing markup", async () => {
 const task = taskFixture({ workflow: { ...workflow(), planContent: "# Inspect evidence\n\nRefund\u202Epayment" } });
 const f = setup(fixture({ body: { kind: "task", task } }), "#plan");expect(await screen.findByText("Refund[U+202E]payment")).toBeTruthy();f.close();
});
it("does not turn a visible evidence anchor into permission to comment", () => {
 const anchor = { target: "change_file" as const, targetId: "acme/payments:src/refund.ts", revision: "+12-3" };
 const f = setup(fixture({ anchors: [anchor], you: { level: "view", owner: false, following: false, actions: ["watch"] } }), "#changes");
 expect(screen.queryByRole("button", { name: "Comment on src/refund.ts" })).toBeNull();f.close();
});
