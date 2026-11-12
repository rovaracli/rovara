// @vitest-environment jsdom
// The phone order of the task page keeps its work behind the closed "Work details and evidence" disclosure. It opens by itself, and scrolls into view, only when something inside it needs this reader
// now (owner decision of 2026-11-12): Understand's questions the reader may answer, or the one control the lead block names inside it (a Merge the reader may press). Otherwise it stays closed, and a
// reader who closes it by hand is respected until a new action (the next round of questions) appears. Focus is not stolen.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DECISION_FOCUS_PARAM } from "@agentx/cloud-contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { mustActInside } from "../../packages/ui/src/screens/session/must-act.js";
import { QUESTIONS_SECTION_ID } from "../../packages/ui/src/screens/session/UnderstandQuestions.js";
import { MERGE_SECTION_ID } from "../../packages/ui/src/screens/session/task-plain-state.js";
import { workspaceTask } from "../../packages/ui/src/screens/session/workspace-types.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { answeredSession } from "./support/answered-fixture.js";
import { understandSession } from "./support/understand-fixture.js";
import { SESSION_FIXTURE_ID, type sessionFixture } from "./support/session-fixture.js";

type Session = ReturnType<typeof sessionFixture>;
const scrolled = vi.fn();
beforeEach(() => { scrolled.mockClear();HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled(this); }; });
afterEach(() => { vi.unstubAllGlobals(); });
const phone = () => vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

function setup(initial: Session, search = "") {
 let session = initial;
 const f = fakeHost(async request => {
  const path = request.path.split("?", 1)[0]!;
  if (path === "/v1/app/decisions") return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
  if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
  return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID + search] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 const details = () => ui.container.querySelector<HTMLDetailsElement>("details.rv-session-evidence")!;
 /** The reader closes (or opens) the disclosure by hand: the browser flips `open` and fires `toggle`. */
 const toggle = (open: boolean) => { details().open = open;details().dispatchEvent(new Event("toggle")); };
 return { ...f, ...ui, query, router, details, toggle, setSession(next: Session) { session = next; }, reread: () => act(async () => { await query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID], exact: true }); }), close() { ui.unmount();router.dispose();query.clear(); } };
}
/** A task waiting on a later round of Understand's questions. */
const round = (number: number, revision = 4 + number): Session => understandSession({ round: number, revision });
const mergeSession = (level: "view" | "edit", ready = true) => workspaceFixture({ display: { state: "ready_to_merge", next: "Press Merge." }, you: { level, owner: level === "edit", following: false, actions: ["watch", "comment"] } } as never, { merge: { ready } });

// The rule on its own.
const NO_ACTION = { action: undefined };
const rule = (session: Session, lead: { action: { label: string; targetId: string } | undefined } = NO_ACTION, decisionsKnown = true) => mustActInside({ session, task: workspaceTask(session), lead, decisionsKnown });
it("the rule: questions the reader may answer are an action, keyed by their round", () => {
 expect(rule(understandSession({ level: "edit" }))).toEqual({ key: "questions:1", targetId: QUESTIONS_SECTION_ID });
 expect(rule(understandSession({ level: "use" }))?.key).toBe("questions:1");
 expect(rule(round(2))?.key).toBe("questions:2");
});
it("the rule: questions the reader cannot answer, answered questions, and a task on a Mac are no action", () => {
 expect(rule(understandSession({ level: "view" }))).toBeUndefined();
 expect(rule(understandSession({ waiting: false }))).toBeUndefined();
 const onMac = understandSession();
 expect(rule({ ...onMac, where: { kind: "mac" } } as never)).toBeUndefined();
});
it("the rule: a Merge the lead names is an action only when it is ready, the pending decisions are read and the reader may press it", () => {
 const go = { action: { label: "Go to Merge", targetId: MERGE_SECTION_ID } };
 expect(rule(mergeSession("edit"), go)).toEqual({ key: "merge", targetId: MERGE_SECTION_ID });
 expect(rule(mergeSession("edit"), go, false)).toBeUndefined();
 expect(rule(mergeSession("edit", false), go)).toBeUndefined();
 expect(rule(mergeSession("view"), go)).toBeUndefined();
 expect(rule({ ...mergeSession("view"), you: { ...mergeSession("view").you, mayMerge: true } } as never, go)?.key).toBe("merge");
 expect(rule(mergeSession("edit"), NO_ACTION)).toBeUndefined();
});
it("the rule: the lead's decision card is above the disclosure, so it is no action inside it", () => {
 expect(rule(mergeSession("edit"), { action: { label: "Go to the decision", targetId: "decision-approve_plan-1" } })).toBeUndefined();
});

// The page.
it("on a phone, questions the reader may answer open the disclosure by themselves, scroll into view, and leave focus where it was", async () => {
 phone();
 const f = setup(understandSession());
 const region = await screen.findByRole("region", { name: "Questions from Rovara" });
 await waitFor(() => expect(f.details().open).toBe(true));
 expect(f.details().contains(region)).toBe(true);
 await waitFor(() => expect(scrolled).toHaveBeenCalledWith(region));
 // The page put focus on the heading when it was read; opening must not take it.
 expect(document.activeElement).toBe(f.container.querySelector("h1"));
 expect(region.contains(document.activeElement)).toBe(false);
 await expectNoAxeViolations(f.container);
 f.close();
});
it("on a phone, the disclosure opened for questions is a native disclosure whose summary is its first child (its expanded state is announced by the browser)", async () => {
 phone();
 const f = setup(understandSession());
 await screen.findByRole("region", { name: "Questions from Rovara" });
 await waitFor(() => expect(f.details().open).toBe(true));
 expect(f.details().firstElementChild!.tagName).toBe("SUMMARY");
 expect(f.details().firstElementChild!.hasAttribute("aria-expanded")).toBe(false);
 expect(f.details().firstElementChild!.textContent).toBe("Work details and evidence");
 f.close();
});
it("on a phone, a reader who came by a needs-you link gets focus on the questions", async () => {
 phone();
 const f = setup(understandSession(), "?" + DECISION_FOCUS_PARAM + "=approve_plan%3A1");
 const region = await screen.findByRole("region", { name: "Questions from Rovara" });
 await waitFor(() => expect(document.activeElement).toBe(region));
 f.close();
});
it("on a phone, with nothing to act on the disclosure stays closed: questions for a viewer, answered questions, an ordinary task", async () => {
 phone();
 for (const session of [understandSession({ level: "view" }), understandSession({ waiting: false }), workspaceFixture()] as Session[]) {
  const f = setup(session);
  await screen.findByRole("region", { name: "Where this task stands" });
  expect(f.details().open).toBe(false);
  expect(scrolled).not.toHaveBeenCalled();
  f.close();
 }
});
it("on a phone, an Answered task's answer stays behind the closed disclosure", async () => {
 phone();
 const f = setup(answeredSession());
 await screen.findByRole("region", { name: "Where this task stands" });
 expect(f.details().open).toBe(false);
 expect(f.details().contains(f.container.querySelector("[aria-label=\"Rovara's answer\"]"))).toBe(true);
 f.close();
});
it("on a phone, a manual close is respected, a re-read of the same questions does not reopen it, and the next round does", async () => {
 phone();
 const f = setup(round(1));
 await screen.findByRole("region", { name: "Questions from Rovara" });
 await waitFor(() => expect(f.details().open).toBe(true));
 f.toggle(false);
 await waitFor(() => expect(f.details().open).toBe(false));
 f.setSession(round(1, 9));await f.reread();
 await new Promise(resolve => setTimeout(resolve, 20));
 expect(f.details().open).toBe(false);
 f.setSession(round(2, 10));await f.reread();
 await waitFor(() => expect(f.details().open).toBe(true));
 await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
 f.close();
});
it("on a phone, after the questions are answered a later round is a new action even though the reader closed the disclosure", async () => {
 phone();
 const f = setup(round(1));
 await screen.findByRole("region", { name: "Questions from Rovara" });
 f.toggle(false);
 f.setSession(understandSession({ waiting: false, revision: 9 }));await f.reread();
 await waitFor(() => expect(screen.queryByRole("region", { name: "Questions from Rovara" })).toBeNull());
 f.setSession(round(2, 10));await f.reread();
 await waitFor(() => expect(f.details().open).toBe(true));
 f.close();
});
it("on a phone, a Merge the reader may press opens the disclosure; one they may not, or that is not ready, does not", async () => {
 phone();
 const ready = setup(mergeSession("edit"));
 await screen.findByRole("button", { name: "Go to Merge" });
 await waitFor(() => expect(ready.details().open).toBe(true));
 await waitFor(() => expect(scrolled).toHaveBeenCalledWith(document.getElementById(MERGE_SECTION_ID)));
 ready.close();
 for (const session of [mergeSession("view"), mergeSession("edit", false)]) {
  const f = setup(session);
  await screen.findByRole("button", { name: "Go to Merge" });
  expect(f.details().open).toBe(false);
  f.close();
 }
});
it("on a phone, an address that names a tab opens it, as before", async () => {
 phone();
 const f = setup(workspaceFixture());
 await screen.findByRole("region", { name: "Where this task stands" });
 expect(f.details().open).toBe(false);
 await act(async () => { await f.router.navigate("#plan"); });
 await waitFor(() => expect(f.details().open).toBe(true));
 f.close();
});
