// @vitest-environment jsdom
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TalkOutcomeView } from "../../packages/ui/src/screens/session/TalkOutcomeView.js";

afterEach(cleanup);

const anchor = { href: "/app/s/ses_abcdefghijklmnopqrst#step-build-2", label: "Build, step 2" };

it("shows the confirmed queued result and the exact session anchor", () => {
 render(h(TalkOutcomeView, { anchor, outcome: { kind: "queued", serverMessage: "Rovara has it." } }));
 expect(screen.getByRole("region", { name: "Talk delivery outcome" })).toBeTruthy();
 expect(screen.getByText("Queued for this build")).toBeTruthy();
 expect(screen.getByText("Rovara has it.")).toBeTruthy();
 expect(screen.getByRole("link", { name: "Back to Build, step 2" }).getAttribute("href")).toBe(anchor.href);
});

it("shows the confirmed applied facts that the server returned", () => {
 render(h(TalkOutcomeView, { anchor, outcome: { kind: "applied", serverMessage: "Applied.", change: "Added tests/refunds/test_repeat.py." } }));
 expect(screen.getByText("Applied")).toBeTruthy();
 expect(screen.getByText("Applied.")).toBeTruthy();
 expect(screen.getByText("Added tests/refunds/test_repeat.py.")).toBeTruthy();
 expect(screen.queryByText(/your instruction was applied/i)).toBeNull();
});

it("shows a refusal using only its returned reason", () => {
 render(h(TalkOutcomeView, { anchor, outcome: { kind: "refused", serverMessage: "Not delivered.", reason: "The build finished before this instruction arrived." } }));
 expect(screen.getByText("Not delivered")).toBeTruthy();
 expect(screen.getByText("The build finished before this instruction arrived.")).toBeTruthy();
 expect(screen.queryByText(/nothing was changed/i)).toBeNull();
});

it("keeps an unknown send in Check-only recovery without exposing resend", () => {
 const onCheck = vi.fn();
 render(h(TalkOutcomeView, { anchor, outcome: { kind: "unknown" }, onCheck }));
 expect(screen.getByText("Rovara didn't confirm this yet.")).toBeTruthy();
 const check = screen.getByRole("button", { name: "Check delivery" });
 fireEvent.click(check);
 expect(onCheck).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole("button", { name: /send|resend|retry/i })).toBeNull();
});
