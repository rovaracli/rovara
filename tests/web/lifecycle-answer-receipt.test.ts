// @vitest-environment jsdom
// UI-CLAUDE-ANSWER-RECEIPT: the answer-only result view (boards AnswerOnly / AnswerOnlyPhone). The view is presentation only: the Session owner (AnsweredSection) keeps the Answered predicate, the
// sanitizing and the mount. Covered here: answered with sources, without sources, long wrapping text, the read-only receipt (no control of any kind, so nothing starts work from it), the fixed
// follow-up words only when the adapter passes them, markup that stays text, accessibility in both themes, and a composed fixture where a task that is not an answer never shows a receipt.
import { expect, it } from "vitest";
import { within } from "@testing-library/react";
import { answerSourceLine, plainAnswerText } from "@agentx/contracts/web";
import { ANSWERED_HEADING, FOLLOW_UP_WORDS, AnsweredSection } from "../../packages/ui/src/screens/session/AnsweredSection.js";
import { ANSWER_NO_SOURCES_WORDS, ANSWER_RESULT_WORDS, AnswerReceiptView, type AnswerReceiptFacts } from "../../packages/ui/src/screens/session/AnswerReceiptView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { HOSTILE_ANSWER, HOSTILE_SOURCE, answeredSession } from "./support/answered-fixture.js";
import type { ReadTask } from "../../packages/ui/src/screens/session/workspace-types.js";

const SOURCES = [{ line: "src/refunds/amounts.py:22", note: "quantize, ROUND_HALF_UP" }, { line: "src/ledger/rounding.py:14", note: "quantize, ROUND_HALF_EVEN" }, { line: "tests/ledger/test_rounding.py" }];
const facts = (over: Partial<AnswerReceiptFacts> = {}): AnswerReceiptFacts => ({
  heading: ANSWERED_HEADING,
  answer: "Refunds round half up to cents. The ledger rounds half to even.\nA partial refund of $10.005 is $10.01 in the refund and $10.00 in the ledger.",
  sources: SOURCES, question: "Where do we round currency amounts?", followUp: FOLLOW_UP_WORDS,
  details: [{ label: "Read", value: "14 files in acme/payments" }], ...over,
});
const FOCUSABLE = "a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]";
const show = (f: AnswerReceiptFacts, theme: "light" | "dark" = "light") => renderUi(h(AnswerReceiptView, { facts: f }), { theme });
const region = (container: HTMLElement) => within(container).getByRole("region", { name: "Rovara's answer" });

it("shows the heading, the answer with its line break, the sources in order, the fixed result line and the served facts", () => {
  const { container } = show(facts());
  const section = region(container);
  expect(within(section).getByRole("heading", { name: ANSWERED_HEADING, level: 3 })).toBeTruthy();
  expect(section.querySelector(".rv-answer-receipt-text")?.textContent).toContain("The ledger rounds half to even.\nA partial refund");
  expect(Array.from(section.querySelectorAll(".rv-answer-receipt-sources li")).map(li => li.querySelector("code")?.textContent)).toEqual(["src/refunds/amounts.py:22", "src/ledger/rounding.py:14", "tests/ledger/test_rounding.py"]);
  expect(section.querySelectorAll(".rv-answer-receipt-sources li")[0]?.textContent).toContain("quantize, ROUND_HALF_UP");
  expect(within(section).getByRole("heading", { name: "Based on", level: 4 })).toBeTruthy();
  expect(section.textContent).toContain(ANSWER_RESULT_WORDS);
  const labels = Array.from(section.querySelectorAll("dt")).map(dt => dt.textContent);
  expect(labels).toEqual(["Result", "Read"]);
  expect(section.textContent).toContain("Where do we round currency amounts?");
});

it("honours the heading level it is mounted under", () => {
  const { container } = renderUi(h(AnswerReceiptView, { facts: facts(), headingLevel: 2 }));
  expect(within(region(container)).getByRole("heading", { name: ANSWERED_HEADING, level: 2 })).toBeTruthy();
  expect(within(region(container)).getByRole("heading", { name: "Based on", level: 3 })).toBeTruthy();
});

it("answered without sources says so in plain words and shows no empty list", () => {
  const { container } = show(facts({ sources: [], question: undefined, details: undefined }));
  const section = region(container);
  expect(section.querySelector("ul")).toBeNull();
  expect(section.textContent).toContain(ANSWER_NO_SOURCES_WORDS);
  expect(section.textContent).toContain(ANSWER_RESULT_WORDS);
  expect(section.querySelector(".rv-answer-receipt-question")).toBeNull();
  expect(Array.from(section.querySelectorAll("dt")).map(dt => dt.textContent)).toEqual(["Result"]);
});

it("keeps a long answer and long source lines as text in the page: no truncation, nothing hidden, wrapping left to the stylesheet", () => {
  const longWord = "x".repeat(400), longPath = "monorepo/" + "deeply/nested/".repeat(30) + "file.ts:1234";
  const long = "word ".repeat(300) + longWord;
  const { container } = show(facts({ answer: long, sources: [{ line: longPath, note: "note ".repeat(60) + longWord }], details: [{ label: "Read", value: longWord }] }));
  const section = region(container);
  expect(section.querySelector(".rv-answer-receipt-text")?.textContent).toBe(long);
  expect(section.querySelector(".rv-answer-receipt-sources code")?.textContent).toBe(longPath);
  expect(section.querySelector("[style]")).toBeNull();
  expect(section.querySelector("[hidden],[aria-hidden]")).toBeNull();
});

it("is read only: no link, button, field or tab stop, so nothing starts work from this receipt", () => {
  const { container } = show(facts());
  const section = region(container);
  expect(section.querySelectorAll(FOCUSABLE)).toHaveLength(0);
  expect(within(section).queryByRole("button")).toBeNull();
  expect(within(section).queryByRole("link")).toBeNull();
  expect(section.textContent).not.toMatch(/start a task from this answer|ask a follow-up|make a change anyway/iu);
});

it("shows the existing follow-up words only when the adapter passes them", () => {
  const withWords = show(facts());
  expect(region(withWords.container).textContent).toContain(FOLLOW_UP_WORDS);
  withWords.unmount();
  const readOnly = show(facts({ followUp: undefined }));
  expect(region(readOnly.container).textContent).not.toContain("follow-up");
  expect(region(readOnly.container).textContent).toContain(ANSWER_RESULT_WORDS);
  expect(region(readOnly.container).querySelectorAll(FOCUSABLE)).toHaveLength(0);
});

it("shows a model's words as text only: markup, angle brackets and control characters never become elements", () => {
  const answer = plainAnswerText(HOSTILE_ANSWER), line = answerSourceLine(HOSTILE_SOURCE);
  const { container } = show(facts({ answer, sources: [{ line }], question: "<b>why</b>‮?" }));
  const section = region(container);
  expect(section.querySelector("img,b,script")).toBeNull();
  expect(section.textContent).toContain("<img src=x onerror=window.__pwned=1>");
  expect(section.textContent).not.toMatch(/\p{Cf}/u);
  expect(section.textContent).toContain("[U+202E]");
  expect(section.querySelector(".rv-answer-receipt-sources li")?.querySelectorAll("*")).toHaveLength(1);
  expect("__pwned" in window).toBe(false);
});

it("shows nothing for an empty answer", () => {
  const { container } = show(facts({ answer: "  \n " }));
  expect(container.querySelector("section")).toBeNull();
});

// Composed fixture: what the Session owner's adapter does, with the real Answered predicate and the real sanitizers, in front of the view.
const taskOf = (session: ReturnType<typeof answeredSession>) => (session.body as { task: ReadTask }).task;

it("composed: an answered task shows the receipt, for a person who may ask and for a viewer", () => {
  const session = answeredSession(), answered = taskOf(session);
  const ask = renderUi(h("div", {}, h(AnsweredSection, { session, task: answered })));
  expect(region(ask.container).textContent).toContain(FOLLOW_UP_WORDS);
  expect(region(ask.container).textContent).toContain("What does the retry flag do?");
  expect(region(ask.container).textContent).toContain("payments/src/retry.ts:4");
  ask.unmount();
  const viewerSession = { ...session, you: { ...session.you, level: "view" as const } };
  const view = renderUi(h("div", {}, h(AnsweredSection, { session: viewerSession, task: answered })));
  expect(region(view.container).textContent).not.toContain(FOLLOW_UP_WORDS);
  expect(region(view.container).querySelectorAll(FOCUSABLE)).toHaveLength(0);
});

it("composed: a task that is not an answer never displays a receipt", () => {
  const session = answeredSession(), running = taskOf(answeredSession({ answered: false }));
  const answered = taskOf(session);
  // Same Answered outcome but the assessment is a plan, not an answer; and the assessment is an answer but the outcome is not ANSWERED.
  const planNotAnswer = { ...answered, workflow: { ...answered.workflow!, intent: { ...answered.workflow!.intent!, assessment: { kind: "ready" as const, path: "feature", restatement: "x", assumptions: [] } } } } as unknown as ReadTask;
  const outcomeElse = { ...answered, workflow: { ...answered.workflow!, outcome: "MERGED" } } as unknown as ReadTask;
  for (const task of [undefined, running, planNotAnswer, outcomeElse]) {
    const ui = renderUi(h("div", {}, task === undefined ? null : h(AnsweredSection, { session, task })));
    expect(ui.container.querySelector("section")).toBeNull();
    expect(ui.container.textContent).toBe("");
    ui.unmount();
  }
});

for (const theme of ["light", "dark"] as const) for (const [name, f] of [["with sources and facts", facts()], ["without sources", facts({ sources: [], followUp: undefined })], ["long text", facts({ answer: "long ".repeat(400), sources: [{ line: "a/".repeat(150) + "z.ts:1" }] })]] as const) {
  it(`has no accessibility violations (${name}, ${theme} theme)`, async () => {
    const { container } = show(f, theme);
    await expectNoAxeViolations(container);
  });
}
