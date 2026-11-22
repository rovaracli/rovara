// @vitest-environment jsdom
import { createElement, createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TaskDraftReturnView, type TaskDraftReturnViewProps } from "../../packages/ui/src/screens/session/TaskDraftReturnView.js";

afterEach(cleanup);

const identity = { companyId: "co_1", personId: "person_1" };
const subject = { ...identity, taskId: "task_1" };
const text = "Check the duplicate refund path before sending.";
const props = (overrides: Partial<TaskDraftReturnViewProps> = {}): TaskDraftReturnViewProps => ({
  identity,
  subject,
  state: { kind: "restored", ...subject, text, operation: "unsent" },
  ...overrides,
});

it("shows a restored unsent draft only for the matching viewer, company, and task", () => {
  render(createElement(TaskDraftReturnView, props()));
  expect(screen.getByText(text)).toBeTruthy();
  expect(screen.getByText("Not sent")).toBeTruthy();
});

it("hides draft content when identity or subject scope is missing or mismatched", () => {
  const { rerender } = render(createElement(TaskDraftReturnView, props({ identity: undefined })));
  expect(screen.queryByText(text)).toBeNull();
  rerender(createElement(TaskDraftReturnView, props({ subject: { ...subject, taskId: "task_2" } })));
  expect(screen.queryByText(text)).toBeNull();
  rerender(createElement(TaskDraftReturnView, props({ subject: { ...subject, companyId: "company_2" } })));
  expect(screen.queryByText(text)).toBeNull();
  rerender(createElement(TaskDraftReturnView, props({ identity: { ...identity, personId: "person_2" } })));
  expect(screen.queryByText(text)).toBeNull();
});

it("says draft availability is unknown without claiming no draft exists", () => {
  render(createElement(TaskDraftReturnView, props({ state: { kind: "unknown" } })));
  expect(screen.getByText("Draft availability is unknown.")).toBeTruthy();
  expect(screen.queryByText(text)).toBeNull();
});

it("distinguishes an in-flight send from unsent text and does not render credential fields", () => {
  const unsafeExtras = { csrfToken: "secret-csrf", accessToken: "secret-access" };
  const { rerender } = render(createElement(TaskDraftReturnView, { ...props(), ...unsafeExtras } as TaskDraftReturnViewProps));
  rerender(createElement(TaskDraftReturnView, props({ state: { kind: "restored", ...subject, text, operation: "sending" } })));
  expect(screen.getByText("Sending")).toBeTruthy();
  expect(screen.queryByText("Not sent")).toBeNull();
  expect(document.body.textContent).not.toContain("secret-csrf");
  expect(document.body.textContent).not.toContain("secret-access");
});

it("keeps focus in the owner-controlled composer when draft state changes", () => {
  const composerRef = createRef<HTMLTextAreaElement>();
  const { rerender } = render(createElement("div", {},
    createElement(TaskDraftReturnView, props()),
    createElement("textarea", { ref: composerRef, "aria-label": "Task message" }),
  ));
  composerRef.current?.focus();
  rerender(createElement("div", {},
    createElement(TaskDraftReturnView, props({ state: { kind: "unknown" } })),
    createElement("textarea", { ref: composerRef, "aria-label": "Task message" }),
  ));
  expect(document.activeElement).toBe(composerRef.current);
});

