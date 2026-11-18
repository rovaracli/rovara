// @vitest-environment jsdom
// L4-B5: the "Decisions and answers" card on the session screen, against a fake host that answers as Cloud's /log route does.
import { describe, expect, it } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { DECISIONS_SHOWN, DecisionsCard, decisionRows, whenWords } from "../../packages/ui/src/screens/session/DecisionsCard.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { createSessionLogApi } from "../../packages/ui/src/api/session-log.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const LOG = `/v1/app/sessions/${SESSION_FIXTURE_ID}/log`;
const question = { key: "question:r1:q1", at: "2026-11-17T10:01:00.000Z", kind: "question", questionId: "q1", round: 1, text: "Cap value?" };
const answer = (over: Record<string, unknown> = {}) => ({ key: "answer:r1:q1", at: "2026-11-17T10:02:00.000Z", kind: "answer", questionId: "q1", round: 1, text: "20,000", by: "Ana Ruiz", surface: "linear", ...over });
const approval = (over: Record<string, unknown> = {}) => ({ key: "approval:a", at: "2026-11-17T10:03:00.000Z", kind: "approval", what: "plan", outcome: "approved", by: "Nick P.", surface: "slack", ...over });

function setup(handle: (request: { method: string; path: string }) => { status: number; body: unknown }) {
  const f = fakeHost(async request => handle(request));
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(DecisionsCard, { id: SESSION_FIXTURE_ID }) }) }));
  return { f, ui };
}

describe("Decisions and answers", () => {
  it("lists each answer with its question and each decision, newest first, saying who, where and when", async () => {
    setup(() => ({ status: 200, body: { entries: [question, answer(), approval()] } }));
    const card = await screen.findByTestId("decisions");
    const items = card.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Decision: the plan, approved.");
    expect(items[0]!.textContent).toContain("Nick P., in Slack, Nov 17, 10:03 UTC");
    expect(items[1]!.textContent).toContain("Cap value? Answer: 20,000");
    expect(items[1]!.textContent).toContain("Ana Ruiz, in Linear, Nov 17, 10:02 UTC");
  });

  it("says each outcome in words, and an answer whose question is not in the list still reads", () => {
    const rows = decisionRows([approval({ outcome: "changes_requested" }), approval({ key: "approval:b", outcome: "rejected", what: "design" }), approval({ key: "approval:c", what: "requirements" }), answer({ text: "yes" })] as never);
    expect(rows.map(row => row.main)).toEqual(["Decision: the plan, changes requested.", "Decision: the design, rejected.", "Decision: the requirements, approved.", "A question was answered: yes"]);
    expect(whenWords("2026-01-05T04:07:00.000Z")).toBe("Jan 5, 04:07 UTC");
  });

  it("shows a short list and the rest one click away", async () => {
    const entries = Array.from({ length: DECISIONS_SHOWN + 3 }, (_, n) => answer({ key: `answer:r${String(n)}:q1`, round: n, text: `answer ${String(n)}`, at: `2026-11-17T10:${String(10 + n).padStart(2, "0")}:00.000Z` }));
    setup(() => ({ status: 200, body: { entries } }));
    const card = await screen.findByTestId("decisions");
    expect(card.querySelectorAll("li")).toHaveLength(DECISIONS_SHOWN);
    expect(card.querySelector("li")!.textContent).toContain(`answer ${String(entries.length - 1)}`);
    fireEvent.click(screen.getByRole("button", { name: `Show all ${String(entries.length)}` }));
    expect(card.querySelectorAll("li")).toHaveLength(entries.length);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(card.querySelectorAll("li")).toHaveLength(DECISIONS_SHOWN);
  });

  it("shows nothing for a task with no answers or decisions, and nothing when Code shows no log or does not serve it", async () => {
    for (const reply of [{ status: 200, body: { entries: [question] } }, { status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "x" } } }, { status: 501, body: { error: { code: "NOT_ON_CORE_ENGINE", message: "x" } } }]) {
      const { f, ui } = setup(() => reply);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(f.request).toHaveBeenCalled();
      expect(screen.queryByTestId("decisions")).toBeNull();
      expect(screen.queryByTestId("decisions-error")).toBeNull();
      ui.unmount();
    }
  });

  it("says so calmly when the log can't be read, with Try again", async () => {
    let fail = true;
    const { f } = setup(() => (fail ? { status: 403, body: { error: { code: "FORBIDDEN", message: "down" } } } : { status: 200, body: { entries: [answer()] } }));
    expect((await screen.findByTestId("decisions-error")).textContent).toContain("Couldn't load the decisions and answers.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByTestId("decisions")).textContent).toContain("20,000");
    expect(f.request.mock.calls.every(([request]) => request.method === "GET" && request.path === LOG)).toBe(true);
  });

  it("draws text as text: markup in an answer is not markup", async () => {
    setup(() => ({ status: 200, body: { entries: [answer({ text: "<img src=x onerror=alert(1)> <b>bold</b>" })] } }));
    const card = await screen.findByTestId("decisions");
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("b")).toBeNull();
    expect(card.textContent).toContain("<b>bold</b>");
  });

  it("reads an answer with an extra member from a newer Cloud, and leaves out an entry of a kind it does not know", async () => {
    setup(() => ({ status: 200, body: { entries: [answer({ extra: 1 }), { key: "future:x", at: "2026-11-17T10:02:00.000Z", kind: "poll", text: "later" }] } }));
    const card = await screen.findByTestId("decisions");
    expect(card.textContent).toContain("20,000");
    expect(card.querySelectorAll("li")).toHaveLength(1);
  });
});

describe("the page's reader of the log", () => {
  it("keeps strict entries only: an extra member is dropped, an entry of another kind or shape is left out", async () => {
    const f = fakeHost(async () => ({ status: 200, body: { entries: [answer({ extra: 1 }), { key: "future:x", at: "2026-11-17T10:02:00.000Z", kind: "poll", text: "later" }, answer({ key: "answer:r2:q1", surface: "carrier-pigeon" })] } }));
    const read = await createSessionLogApi(f.host).read(SESSION_FIXTURE_ID);
    expect(read.entries).toHaveLength(1);
    expect(Object.keys(read.entries[0]!).sort()).toEqual(["at", "by", "key", "kind", "questionId", "round", "surface", "text"]);
  });
});
