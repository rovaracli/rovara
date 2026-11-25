// @vitest-environment jsdom
// SLACK-LINK-L1: "You're not in a company yet" tells a person who already uses Rovara with GitHub what to do (a Slack sign-in is a different person until it is connected from
// Account, Sign-in methods). The words are exact and promise nothing more: no linking from any Slack workspace, no matching by email.
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };

function mount() {
 const f = fakeHost(async () => ({ status: 403, body: { error: { code: "NO_COMPANY", message: "You're not in a company yet." } } }));
 const query = createQueryClient();
 const router = createMemoryRouter(appRoutes(features), { initialEntries: ["/app/no-company"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}

describe("You're not in a company yet (SLACK-LINK-L1)", () => {
 it("says how a person who already uses Rovara with GitHub connects this Slack sign-in, in the owner's words, and still offers the invite and create-company ways", async () => {
  const m = mount();
  expect(await screen.findByRole("heading", { name: "You're not in a company yet" })).toBeTruthy();
  expect(screen.getByTestId("no-company-github").textContent).toBe("Already use Rovara with GitHub? Sign in with GitHub, then go to Account → Sign-in methods → Connect Slack.");
  expect(screen.getByTestId("no-company-invite").textContent).toBe("Have an invite? Open the link you were sent.");
  expect(screen.getByTestId("no-company-create").textContent).toBe("Create your company");
  // True words only: it never promises linking from any Slack workspace, nor by email, nor an automatic merge.
  expect(screen.getByTestId("no-company-github").textContent ?? "").not.toMatch(/any (Slack )?workspace|same email|automatically|merge/iu);
  m.close();
 });
});
