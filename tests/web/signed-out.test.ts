// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { SignedOutScreen } from "../../packages/ui/src/screens/signed-out/SignedOutScreen.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
for (const [reason, text] of Object.entries({ removed: "You're no longer a member of this organization. Ask an owner to invite you again.", ended: "Your sign-in was ended. Sign in again to continue.", cancelled: "Sign-in was cancelled.", failed: "Sign-in didn't work. Try again in a minute." })) it(`explains ${reason} and signs in only on a click`, async () => {
 const signIn = vi.fn();renderUi(h(SignedOutScreen, { reason, onSignIn: signIn }));expect(screen.getByText(text)).toBeTruthy();expect(signIn).not.toHaveBeenCalled();await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));expect(signIn).toHaveBeenCalledTimes(1);
});
