// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SignedOutRoute } from "../../packages/ui/src/screens/signed-out/SignedOutRoute.js";
import { SignedOutScreen } from "../../packages/ui/src/screens/signed-out/SignedOutScreen.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";

for (const [reason, text] of Object.entries({ removed: "You're no longer a member of this organization. Ask an owner to invite you again.", ended: "Your sign-in was ended. Sign in again to continue.", cancelled: "Sign-in was cancelled.", failed: "Sign-in didn't work. Try again in a minute." })) it(`explains ${reason} and signs in only on a click`, async () => {
  const signIn = vi.fn(); renderUi(h(SignedOutScreen, { reason, onSignIn: signIn })); expect(screen.getByText(text)).toBeTruthy(); expect(signIn).not.toHaveBeenCalled(); await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" })); expect(signIn).toHaveBeenCalledTimes(1);
});

it("uses the fixed failure explanation for unknown reason keys", () => { renderUi(h(SignedOutScreen, { reason: "constructor", onSignIn: vi.fn() })); expect(screen.getByText("Sign-in didn't work. Try again in a minute.")).toBeTruthy(); });

for (const theme of ["light", "dark"] as const) it(`keeps the sign-in stage accessible in ${theme}`, async () => {
  const base = fakeHost();
  const host = { ...base.host, lastWorkspace: () => "T0HINT0001", signInOffer: async () => ({ slack: true, github: true }) };
  const ui = renderUi(
    h(AppHostProvider, { host, children: h(MemoryRouter, { initialEntries: ["/app/signed-out?reason=ended"], children: h(SignedOutRoute) }) }),
    { theme },
  );
  await screen.findByRole("button", { name: "Sign in with GitHub" });
  expect(screen.getByRole("button", { name: "Sign in with Slack" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Use a different workspace" })).toBeTruthy();
  await expectNoAxeViolations(ui.container);
  ui.unmount();
});
