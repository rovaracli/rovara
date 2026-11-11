// @vitest-environment jsdom
// UX1: one signed-out screen; each fixed reason says what happened and the next step.
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { SIGNED_OUT_REASONS } from "@agentx/contracts/web";
import { SIGNED_OUT_COPY, SignedOutScreen } from "../../packages/ui/src/screens/signed-out/SignedOutScreen.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
for (const [reason, text] of Object.entries({ removed: "Your access to this company ended.", ended: "You've signed out.", cancelled: "Sign-in was cancelled.", failed: "We couldn't finish signing you in.", refused: "That account wasn't accepted.", unavailable: "The sign-in service couldn't be reached.", method_unavailable: "That sign-in method can't open Rovara here.", invitation_only: "Rovara is invitation-only right now, and nothing was created." })) it(`explains ${reason} with a next step and signs in only on a click`, async () => {
 const signIn = vi.fn();const view = renderUi(h(SignedOutScreen, { reason, onSignIn: signIn }));expect(screen.getByText(text)).toBeTruthy();expect(screen.getByText(SIGNED_OUT_COPY[reason as keyof typeof SIGNED_OUT_COPY].next)).toBeTruthy();expect(signIn).not.toHaveBeenCalled();await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));expect(signIn).toHaveBeenCalledTimes(1);view.unmount();
});
it("has words for every reason the sign-in server can give, and none of them is a terminal command", () => {
 for (const reason of SIGNED_OUT_REASONS) { expect(SIGNED_OUT_COPY[reason].message.length).toBeGreaterThan(0);expect(`${SIGNED_OUT_COPY[reason].message} ${SIGNED_OUT_COPY[reason].next}`).not.toMatch(/agentx|run /i); }
});
it("offers Create a company for a new person who did not ask for one, and nothing is created without the click", async () => {
 const signIn = vi.fn(), create = vi.fn();renderUi(h(SignedOutScreen, { reason: "no_account", onSignIn: signIn, onCreateCompany: create }));
 expect(screen.getByText(/nothing was created/)).toBeTruthy();expect(screen.getByText(/open the invite link an owner or admin sent you/)).toBeTruthy();expect(create).not.toHaveBeenCalled();
 await userEvent.setup().click(screen.getByRole("button", { name: "Create a company" }));expect(create).toHaveBeenCalledTimes(1);expect(signIn).not.toHaveBeenCalled();
});
it("uses the fixed failure explanation for unknown reason keys", () => { renderUi(h(SignedOutScreen, { reason: "constructor", onSignIn: vi.fn() }));expect(screen.getByText("We couldn't finish signing you in.")).toBeTruthy(); });
it("says invitation-only without offering Create a company, even when the app could start one", async () => {
 const signIn = vi.fn(), create = vi.fn();renderUi(h(SignedOutScreen, { reason: "invitation_only", onSignIn: signIn, onCreateCompany: create }));
 expect(screen.getByText(/ask someone at your company to invite you/i)).toBeTruthy();expect(screen.queryByRole("button", { name: "Create a company" })).toBeNull();
 await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));expect(signIn).toHaveBeenCalledTimes(1);expect(create).not.toHaveBeenCalled();
});
