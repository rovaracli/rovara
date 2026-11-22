// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { AskStatusReaderSchema } from "@agentx/contracts/web";
import { TalkQuestionRecoveryView } from "../../packages/ui/src/screens/session/TalkQuestionRecoveryView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const ask = (state: "queued" | "answered" | "failed") => AskStatusReaderSchema.parse({ askId: "ask_01234567890123456789", state });

it("shows only an actually failed question, as the exact question, without claiming cause or effect", () => {
  const status = ask("failed");
  const ui = renderUi(h(TalkQuestionRecoveryView, { status, read: "current", question: "Does the plan cover a repeated request?" }));
  const notice = screen.getByRole("status");
  expect(notice.textContent).toContain("Rovara couldn't answer this just now.");
  expect(notice.textContent).toContain("Does the plan cover a repeated request?");
  expect(notice.textContent).not.toMatch(/provider|charged|build|cost|cause/i);
  expect(within(notice).queryByRole("button")).toBeNull();
  ui.unmount();
});

it("describes a queued question as unanswered without treating it as an instruction", () => {
  const status = ask("queued");
  const ui = renderUi(h(TalkQuestionRecoveryView, { status, read: "current", question: "Can you do something for me?" }));
  const notice = screen.getByRole("status");
  expect(notice.textContent).toContain("Rovara hasn't answered this yet.");
  expect(notice.textContent).toContain("Can you do something for me?");
  expect(notice.textContent).toContain("A question doesn't change the work.");
  ui.unmount();
});

it("shows only the existing read-only Check slot when the Ask status is unavailable", () => {
  let checked = false;
  const onCheck = () => { checked = true; };
  const ui = renderUi(h(TalkQuestionRecoveryView, { read: "unavailable", question: "Does the plan cover refunds?", onCheck }));
  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("Couldn't check whether Rovara answered this.");
  within(notice).getByRole("button", { name: "Check" }).click();
  expect(checked).toBe(true);
  expect(within(notice).queryByText("Does the plan cover refunds?")).toBeNull();
  ui.unmount();
});

it("treats an unrecognized server state as uncertain and offers only Check", () => {
  const status = AskStatusReaderSchema.parse({ askId: "ask_01234567890123456789", state: "running" });
  const ui = renderUi(h(TalkQuestionRecoveryView, { status, read: "current", question: "Does the plan cover refunds?", onCheck: () => undefined }));
  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("Couldn't check whether Rovara answered this.");
  expect(within(notice).getByRole("button", { name: "Check" })).toBeTruthy();
  expect(within(notice).queryByText("Does the plan cover refunds?")).toBeNull();
  ui.unmount();
});

it("drops the retained question immediately when the latest read loses authority", () => {
  // Even a stale cached failed status cannot preserve a question after a refused latest read.
  const status = ask("failed");
  const ui = renderUi(h(TalkQuestionRecoveryView, { status, read: "authority-lost", question: "Does the plan cover refunds?" }));
  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("This question is no longer available in this session.");
  expect(notice.textContent).not.toContain("Does the plan cover refunds?");
  expect(within(notice).queryByRole("button")).toBeNull();
  ui.unmount();
});

it("does not render a model answer in the question recovery notice", () => {
  const status = AskStatusReaderSchema.parse({ askId: "ask_01234567890123456789", state: "answered", answer: "This is an answer, not a recovery notice." });
  const ui = renderUi(h(TalkQuestionRecoveryView, { status, read: "current", question: "Does the plan cover refunds?" }));
  expect(screen.queryByText("This is an answer, not a recovery notice.")).toBeNull();
  expect(screen.queryByText("Does the plan cover refunds?")).toBeNull();
  ui.unmount();
});
