// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { SlackLink, SLACK_LINK_MESSAGES, slackLinkOutcome } from "../../packages/ui/src/shell/SlackLink.js";
import { isSlackLinkUrl } from "../../packages/ui/src/text/links.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const ORIGIN = "https://cell.example";
const REQUEST = "r".repeat(43);
const me = (slack: boolean) => ({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" },
  identities: [{ provider: "cloud", linkedAt: "x", lastSignInAt: "x" }, ...(slack ? [{ provider: "slack", linkedAt: "x", lastSignInAt: "x" }] : [])] });

function view(options: { slack: boolean; outcome?: string; start?: { status: number; body: unknown } }) {
  const f = fakeHost(async (request) => {
    if (request.method === "GET") return { status: 200, body: me(options.slack) };
    if (request.method === "POST") return options.start ?? { status: 200, body: { authorizeUrl: `${ORIGIN}/v1/auth/authorize?request=${REQUEST}&method=slack` } };
    return { status: 200, body: { identities: [] } };
  });
  const navigate = vi.fn<(url: string) => void>();
  f.host.navigate = navigate;
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SlackLink, { outcome: options.outcome }) }) }));
  return { ...f, ...ui, navigate };
}

it("offers to link a Slack account, and starts the sign-in at Slack in this tab", async () => {
  const f = view({ slack: false });
  fireEvent.click(await screen.findByRole("button", { name: "Link your Slack account" }));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledWith(`${ORIGIN}/v1/auth/authorize?request=${REQUEST}&method=slack`));
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path: "/v1/app/me/identities/slack" }));
});

it("does not follow an address that is not the sign-in server's Slack link", async () => {
  const f = view({ slack: false, start: { status: 200, body: { authorizeUrl: "https://evil.example/v1/auth/authorize?request=" + REQUEST + "&method=slack" } } });
  fireEvent.click(await screen.findByRole("button", { name: "Link your Slack account" }));
  await screen.findByRole("alert");
  expect(f.navigate).not.toHaveBeenCalled();
  expect(isSlackLinkUrl(`${ORIGIN}/v1/auth/authorize?request=${REQUEST}&method=github`, ORIGIN)).toBe(false);
  expect(isSlackLinkUrl(`${ORIGIN}/v1/auth/authorize?request=${REQUEST}&method=slack&x=1`, ORIGIN)).toBe(false);
  expect(isSlackLinkUrl(`${ORIGIN}/v1/auth/authorize?request=${REQUEST}&method=slack#x`, ORIGIN)).toBe(false);
  expect(isSlackLinkUrl(`http://cell.example/v1/auth/authorize?request=${REQUEST}&method=slack`, ORIGIN)).toBe(false);
});

it("shows the server's words when starting is refused", async () => {
  view({ slack: false, start: { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "sign in again first" } } } });
  fireEvent.click(await screen.findByRole("button", { name: "Link your Slack account" }));
  expect((await screen.findByRole("alert")).textContent).toContain("sign in again first");
});

it("offers to unlink when a Slack account is linked, and says so", async () => {
  const f = view({ slack: true });
  fireEvent.click(await screen.findByRole("button", { name: "Unlink your Slack account" }));
  await waitFor(() => expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ method: "DELETE", path: "/v1/app/me/identities/slack" })));
  expect((await screen.findByRole("status")).textContent).toContain("unlinked");
});

it("says what happened when the person comes back from Slack, for each outcome, and ignores an outcome it does not know", async () => {
  for (const outcome of Object.keys(SLACK_LINK_MESSAGES)) {
    expect(slackLinkOutcome(`/app?slack_link=${outcome}`)).toBe(outcome);
  }
  expect(slackLinkOutcome("/app?slack_link=<script>")).toBeUndefined();
  expect(slackLinkOutcome("/app")).toBeUndefined();
  view({ slack: false, outcome: "taken" });
  expect((await screen.findByRole("status")).textContent).toBe(SLACK_LINK_MESSAGES.taken);
});
