// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SignedOutRoute } from "../../packages/ui/src/screens/signed-out/SignedOutRoute.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";

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
