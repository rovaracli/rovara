// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ANSWER_WORDS } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { AnswerBox } from "../../packages/ui/src/screens/answers/AnswerBox.js";
import { AnswerView } from "../../packages/ui/src/screens/answers/AnswerView.js";
import { TalkQuestionRecoveryView } from "../../packages/ui/src/screens/session/TalkQuestionRecoveryView.js";
import { TaskPageBoundary } from "../../packages/ui/src/screens/session/task-page-policy.js";
import { viewerTime } from "../../packages/ui/src/design/viewer-time.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const COMMIT = "a".repeat(40);
const LONG_PATH = "packages/payments-service/src/refunds/idempotency/duplicate-request-guard.ts";
const entry = (answerId: string, answer: string, sources: unknown[] = []) => ({ answerId, threadId: "thread-1", question: "Who approved the retry limit?", answer, createdAt: "2026-11-22T09:20:45.000Z", sources });
const wrap = (child: ReturnType<typeof h>) => h(AppHostProvider, { host: fakeHost().host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MemoryRouter, { children: child }) }) });
function box(options: { past?: ReturnType<typeof entry>[]; taskId?: string | undefined } = {}) {
 return renderUi(wrap(h(AnswerBox, { project: "payments", repositories: [], canStart: false, taskId: options.taskId, past: options.past as never })));
}

it("C1: a pending question is a neutral waiting card, not the red failure card; the real failure card is unchanged", () => {
 const waiting = renderUi(h(TaskPageBoundary, { children: h(TalkQuestionRecoveryView, { read: "unavailable", waiting: true, question: "Will retries cover partial refunds?", asker: { name: "Priya", at: "2026-11-22T09:20:00.000Z" } }) }));
 const card = document.querySelector(".rv-ask-recovery")!;
 expect(card.getAttribute("role")).toBe("status");
 expect(card.querySelector("[data-tone=bad]")).toBeNull();
 expect(card.textContent).toContain("Will retries cover partial refunds?");
 expect(card.textContent).toContain("Waiting for Rovara's answer.");
 expect(card.textContent).toContain("your question is kept");
 expect(card.textContent).not.toContain("Couldn't check whether Rovara answered this.");
 expect(within(card as HTMLElement).queryByRole("button")).toBeNull();
 waiting.unmount();
 renderUi(h(TaskPageBoundary, { children: h(TalkQuestionRecoveryView, { read: "unavailable", onCheck: () => undefined, question: "Will retries cover partial refunds?", asker: { name: "Priya", at: "2026-11-22T09:20:00.000Z" } }) }));
 const failed = document.querySelector(".rv-ask-recovery")!;
 expect(failed.getAttribute("role")).toBe("alert");
 expect(failed.querySelector("[data-tone=bad]")).not.toBeNull();
 expect(failed.textContent).toContain("Couldn't check whether Rovara answered this.");
 expect(within(failed as HTMLElement).getByRole("button", { name: "Check" })).toBeTruthy();
});

it("C2: history times show no seconds and are exactly the shared viewer-local format", () => {
 box({ taskId: TASK, past: [entry("answer-one", "The plan is waiting.")] });
 const time = document.querySelector<HTMLTimeElement>(".rv-ask-turn-time")!;
 expect(time.dateTime).toBe("2026-11-22T09:20:45.000Z");
 expect(time.textContent).toBe(viewerTime("2026-11-22T09:20:45.000Z", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
 expect(time.textContent).not.toMatch(/\d:\d\d:\d\d/u);
});

it("C3: a long code path can break only after a separator, never inside a word", () => {
 const source = { n: 1, repo: "payments", path: LONG_PATH, line: 12, commit: COMMIT };
 renderUi(wrap(h(AnswerView, { project: "payments", repositories: [], answer: { threadId: "thread-1", outcome: "answered", text: "See the guard. [1]", sources: [source], unconfirmed: [], wikiPages: [] } })));
 const path = [...document.querySelectorAll("code.rv-source-code")].find(el => el.textContent?.includes("duplicate-request-guard"))!;
 expect(path.textContent).toBe("payments/" + LONG_PATH + ":12");
 // A break opportunity after each "/" and "-" keeps words whole.
 expect(path.querySelectorAll("wbr").length).toBeGreaterThanOrEqual(LONG_PATH.split("/").length);
 for (const mark of path.querySelectorAll("wbr")) expect(/[/.\-_:]$/u.test(mark.previousSibling?.textContent ?? "")).toBe(true);
});

it("C4: an I-don't-know answer carries a No answer chip, fresh or kept in history; a normal answer does not", () => {
 renderUi(wrap(h(AnswerView, { project: "payments", repositories: [], answer: { threadId: "thread-1", outcome: "not_found", text: "", unconfirmed: [], wikiPages: [], sources: [] } })));
 expect(screen.getByRole("img", { name: "No answer" })).toBeTruthy();
});
it("C4b: a retained history entry that says I don't know shows the chip, and one that answers does not", () => {
 box({ taskId: TASK, past: [entry("answer-idk", ANSWER_WORDS.notFound), entry("answer-ok", "The plan is waiting.")] });
 const turns = [...document.querySelectorAll(".rv-ask-turn")];
 // Same instant: ordered by answer id, so the "idk" entry comes first.
 expect(within(turns[0] as HTMLElement).getByRole("img", { name: "No answer" })).toBeTruthy();
 expect(within(turns[1] as HTMLElement).queryByRole("img", { name: "No answer" })).toBeNull();
});

it("C5: the helper line names the task only when the task is served; project Ask keeps its words", () => {
 box({ taskId: TASK });
 expect(screen.getByText(/answers from this task, the project's wiki and code/u)).toBeTruthy();
 expect(document.body.textContent).toContain("The code is the truth.");
});
it("C5b: without task context the helper line stays the project's words", () => {
 box({});
 expect(screen.getByText("Rovara answers from the project's wiki and code. It can be wrong. The code is the truth.")).toBeTruthy();
});
