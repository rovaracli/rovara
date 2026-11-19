// @vitest-environment jsdom
// R1b: a task Understand answered ends CLOSED with the outcome ANSWERED, and the Pipeline tab says so: "Rovara answered this. No code was changed.", the answer (plain text) and where it was
// read. Hosted Code serves no change-anyway route (L4-TA5b), so there is NO "Make a change anyway" button and nothing is posted: a person who can use the session reads the fixed words
// "To change this after it's answered, start a follow-up task." Viewers and sessions on a Mac read only the answer. Other tasks show nothing new.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { FOLLOW_UP_WORDS } from "../../packages/ui/src/screens/session/AnsweredSection.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { answeredSession } from "./support/answered-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";

const FOLLOW_UP = "To change this after it's answered, start a follow-up task.";

function setup(initial: ReturnType<typeof answeredSession>) {
  const f = fakeHost(async (request) => {
    const path = request.path.split("?", 1)[0]!;
    if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
    if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
    if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: initial.viewingNow } };
    // The task page's own reads (plan, proof, decisions) are not what this file tests: Code serves none of them here.
    if (request.method === "GET" && (path.startsWith("/v1/app/tasks/") || path === "/v1/app/decisions")) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served here." } } };
    return { status: 200, body: { session: initial } };
  });
  const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
  const posts = () => f.request.mock.calls.filter(([request]) => request.method !== "GET");
  return { ...f, ...ui, posts, close() { ui.unmount(); router.dispose(); query.clear(); } };
}

const region = async () => screen.findByRole("region", { name: "Rovara's answer" });

it("shows the heading, the answer as plain text and where it was read, for an Answered task", async () => {
  const f = setup(answeredSession());
  const section = await region();
  expect(screen.getByRole("heading", { name: "Rovara answered this. No code was changed." })).toBeTruthy();
  expect(section.querySelector("img")).toBeNull();
  expect(section.textContent).toContain("It turns retries on <img src=x onerror=window.__pwned=1> for the payment worker.");
  expect(section.textContent).not.toContain("\u202E");
  expect(section.textContent).toContain("Second line stays a line.");
  expect(section.textContent).toContain("payments/src/retry.ts:4");
  expect(section.textContent).toContain("payments/docs/flags.md");
  expect("__pwned" in window).toBe(false);
  f.close();
});

it("shows a hostile source line as plain text: no markup, no angle brackets, no control characters", async () => {
  const f = setup(answeredSession());
  const section = await region();
  const items = Array.from(section.querySelectorAll(".rv-answered-sources li"));
  expect(items).toHaveLength(3);
  const hostile = items[2]!;
  // The list items hold only text inside <code>: nothing in the source was turned into an element.
  expect(hostile.querySelectorAll("*")).toHaveLength(1);
  expect(hostile.querySelector("code")?.children).toHaveLength(0);
  expect(hostile.textContent).toBe("pay img src=x onerror=window.__pwned=2/src/a b c.ts:9");
  expect(hostile.textContent).not.toMatch(/[<>\p{Cc}\p{Cf}]/u);
  expect("__pwned" in window).toBe(false);
  // The plain sources before it are unchanged.
  expect(items[0]!.textContent).toBe("payments/src/retry.ts:4");
  f.close();
});

it("shows the fixed follow-up words to a person who can use the session, and no change-anyway button", async () => {
  const f = setup(answeredSession());
  const section = await region();
  expect(FOLLOW_UP_WORDS).toBe(FOLLOW_UP);
  expect(section.textContent).toContain(FOLLOW_UP);
  expect(screen.queryByRole("button", { name: /change/iu })).toBeNull();
  expect(section.querySelectorAll("button")).toHaveLength(0);
  expect(section.textContent).not.toMatch(/anyway/iu);
  f.close();
});

it("sends nothing to change-anyway: the page only reads", async () => {
  const f = setup(answeredSession());
  await region();
  await screen.findByText(FOLLOW_UP);
  expect(f.request.mock.calls.some(([request]) => request.path.includes("change-anyway"))).toBe(false);
  expect(f.posts().filter(([request]) => !request.path.endsWith("/presence"))).toHaveLength(0);
  f.close();
});

it("shows a viewer the answer and no button", async () => {
  const f = setup(answeredSession({ level: "view" }));
  const section = await region();
  expect(section.textContent).toContain("Second line stays a line.");
  expect(section.textContent).not.toContain(FOLLOW_UP);
  expect(screen.queryByRole("button", { name: "Make a change anyway" })).toBeNull();
  f.close();
});

it("shows no button when the session runs on a Mac now", async () => {
  const f = setup(answeredSession({ onMac: true }));
  await screen.findByRole("heading", { name: "Rovara answered this. No code was changed." });
  expect(screen.queryByText(FOLLOW_UP)).toBeNull();
  expect(screen.queryByRole("button", { name: "Make a change anyway" })).toBeNull();
  f.close();
});

it("shows nothing new for a task that was not answered", async () => {
  const f = setup(answeredSession({ answered: false }));
  await screen.findByText("Working");
  expect(screen.queryByRole("region", { name: "Rovara's answer" })).toBeNull();
  expect(screen.queryByText(/Rovara answered this/u)).toBeNull();
  expect(screen.queryByRole("button", { name: "Make a change anyway" })).toBeNull();
  f.close();
});

for (const theme of ["light", "dark"] as const) {
  it(`has no accessibility violations in the ${theme} theme`, async () => {
    const f = setup(answeredSession());
    await region();
    document.documentElement.setAttribute("data-theme", theme);
    await expectNoAxeViolations(f.container);
    f.close();
  });
}
