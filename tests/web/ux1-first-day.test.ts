// @vitest-environment jsdom
// UX1 (platform UX slice 1, "First day"): linking GitHub from the account menu, the Slack link's "no workspace" answer and hiding, and AI providers
// added, checked and removed on one screen (or plainly held).
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { GithubLink, GITHUB_LINK_MESSAGES, githubLinkOutcome } from "../../packages/ui/src/shell/GithubLink.js";
import { SlackLink, SLACK_LINK_MESSAGES } from "../../packages/ui/src/shell/SlackLink.js";
import { ProviderSetup, PROVIDERS_HELD } from "../../packages/ui/src/screens/admin/models/ProviderSetup.js";
import { isGithubLinkUrl, joinLinkPath } from "../../packages/ui/src/text/links.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import type { ReactElement } from "react";

const ORIGIN = "https://cell.example", REQUEST = "r".repeat(43);
const me = (identities: Array<Record<string, string>>, linkable?: { slack: boolean; github: boolean }) => ({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities, ...(linkable === undefined ? {} : { linkable }) });
function mount(element: ReactElement, respond: (request: ApiRequest) => Promise<ApiResponse>) {
 const f = fakeHost(respond), navigate = vi.fn<(url: string) => void>();f.host.navigate = navigate;
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: element }) }));
 return { ...f, ...ui, navigate, close() { ui.unmount();query.clear(); } };
}

it("links GitHub from the account menu: same-origin link only, and says what happened on the way back", async () => {
 const f = mount(h(GithubLink, {}), async r => r.method === "GET" ? { status: 200, body: me([{ provider: "cloud", linkedAt: "x", lastSignInAt: "x" }], { slack: false, github: true }) } : { status: 200, body: { authorizeUrl: `${ORIGIN}/v1/auth/authorize?request=${REQUEST}&method=github` } });
 fireEvent.click(await screen.findByRole("button", { name: "Link your GitHub account" }));
 await waitFor(() => expect(f.navigate).toHaveBeenCalledWith(`${ORIGIN}/v1/auth/authorize?request=${REQUEST}&method=github`));
 expect(f.request.mock.calls.find(([r]) => r.method === "POST")?.[0]).toMatchObject({ path: "/v1/app/me/identities/github", body: { returnTo: "/app" } });
 f.close();
 expect(isGithubLinkUrl(`https://evil.example/v1/auth/authorize?request=${REQUEST}&method=github`, ORIGIN)).toBe(false);
 expect(isGithubLinkUrl(`${ORIGIN}/v1/auth/authorize?request=${REQUEST}&method=slack`, ORIGIN)).toBe(false);
 for (const outcome of Object.keys(GITHUB_LINK_MESSAGES)) expect(githubLinkOutcome(`/app?github_link=${outcome}`)).toBe(outcome);
 expect(githubLinkOutcome("/app?github_link=<script>")).toBeUndefined();
});

it("refuses to follow a link that is not the sign-in server's GitHub link, and offers Sign in again for a stale sign-in", async () => {
 const evil = mount(h(GithubLink, {}), async r => r.method === "GET" ? { status: 200, body: me([]) } : { status: 200, body: { authorizeUrl: `https://evil.example/v1/auth/authorize?request=${REQUEST}&method=github` } });
 fireEvent.click(await screen.findByRole("button", { name: "Link your GitHub account" }));await screen.findByRole("alert");expect(evil.navigate).not.toHaveBeenCalled();evil.close();
 const stale = mount(h(GithubLink, { returnTo: "/app/onboard" }), async r => r.method === "GET" ? { status: 200, body: me([]) } : { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "sign in again first" } } });
 fireEvent.click(await screen.findByRole("button", { name: "Link your GitHub account" }));fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));expect(stale.host.signIn).toHaveBeenCalledWith("/app/onboard");stale.close();
});

it("shows a linked GitHub account by login, and hides the link where GitHub sign-in is off", async () => {
 const linked = mount(h(GithubLink, { outcome: "linked" }), async () => ({ status: 200, body: me([{ provider: "github", login: "priya-gh", linkedAt: "x", lastSignInAt: "x" }]) }));
 await screen.findByText(/GitHub account priya-gh is linked to your account/);expect(screen.getByRole("status").textContent).toBe(GITHUB_LINK_MESSAGES.linked);expect(screen.queryByRole("button", { name: "Link your GitHub account" })).toBeNull();linked.close();
 const off = mount(h(GithubLink, {}), async () => ({ status: 200, body: me([], { slack: true, github: false }) }));
 await waitFor(() => expect(off.request).toHaveBeenCalled());await waitFor(() => expect(screen.queryByText(/Link your GitHub account/)).toBeNull());off.close();
});

it("hides the Slack link where Slack sign-in is off, and says the right thing when no workspace is connected", async () => {
 const off = mount(h(SlackLink, {}), async () => ({ status: 200, body: me([], { slack: false, github: true }) }));
 await waitFor(() => expect(off.request).toHaveBeenCalled());await waitFor(() => expect(screen.queryByRole("button", { name: "Link your Slack account" })).toBeNull());off.close();
 const none = mount(h(SlackLink, { outcome: "no_workspace" }), async () => ({ status: 200, body: me([], { slack: true, github: true }) }));
 expect((await screen.findByRole("status")).textContent).toBe(SLACK_LINK_MESSAGES.no_workspace);expect(SLACK_LINK_MESSAGES.no_workspace).not.toMatch(/different workspace|agentx/);none.close();
});

it("joinLinkPath accepts only a whole invite link and always answers this origin's path", () => {
 const token = "A".repeat(43);
 expect(joinLinkPath(`https://rovara.dev/join#invite=${token}`)).toBe(`/join#invite=${token}`);
 expect(joinLinkPath(`/join#invite=${token}`)).toBe(`/join#invite=${token}`);
 for (const bad of [`https://x/join#invite=${token}x`, `https://x/join?invite=${token}`, `https://x/app/join#invite=${token}`, `javascript:/join#invite=${token}`, ""]) expect(joinLinkPath(bad), bad).toBeUndefined();
});

it("says plainly that no provider can be added yet, and why, when the launch list is empty", async () => {
 const f = mount(h(ProviderSetup, { available: [], sources: [], revision: 1, canEdit: true, onChanged: vi.fn() }), async () => ({ status: 200, body: {} }));
 expect(screen.getByText("No provider can be added on this Rovara install yet.")).toBeTruthy();expect(screen.getByText(PROVIDERS_HELD)).toBeTruthy();
 expect(screen.queryByRole("button", { name: /Add and check/ })).toBeNull();expect(f.request).not.toHaveBeenCalled();f.close();
});

it("adds an allowed provider with a write-only key, checks it at once, and shows the tick", async () => {
 const changed = vi.fn(), key = ["fixture", "key", Date.now().toString(36)].join("-");
 const f = mount(h(ProviderSetup, { available: ["anthropic", "bedrock"], sources: [], revision: 1, canEdit: true, onChanged: changed }), async r => r.path.endsWith("/check") ? { status: 200, body: { ok: true } } : { status: 201, body: { sourceId: "src_" + "b".repeat(20) } });
 expect(screen.getByText(/You can add Anthropic, Amazon Bedrock \(your AWS account\) here\./)).toBeTruthy();
 fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme Anthropic" } });fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "sample-model" } });fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } });
 fireEvent.click(screen.getByRole("button", { name: "Add and check it works" }));
 await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === `/v1/app/org/model-sources/src_${"b".repeat(20)}/check`)).toBe(true));
 const add = f.request.mock.calls.find(([r]) => r.path === "/v1/app/org/model-sources")?.[0];
 expect(add?.body).toMatchObject({ source: { kind: "anthropic", label: "Acme Anthropic", models: [{ catalog: { provider: "anthropic", modelId: "sample-model" } }] }, apiKey: key });
 expect(changed).toHaveBeenCalled();
 // The key is cleared from the form and never shown back.
 await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("API key").value).toBe(""));expect(document.body.innerHTML).not.toContain(key);f.close();
});

it("Check it works shows exactly what failed, and Remove sends the reviewed revision", async () => {
 const changed = vi.fn(), source = { sourceId: "src_" + "c".repeat(20), kind: "openai" as const, label: "Acme OpenAI" };
 const f = mount(h(ProviderSetup, { available: ["openai"], sources: [source], revision: 7, canEdit: true, onChanged: changed }), async r => r.path.endsWith("/check") ? { status: 200, body: { ok: false, message: "OpenAI refused the saved key (HTTP 401)" } } : { status: 200, body: { sourceId: source.sourceId, removed: true } });
 fireEvent.click(screen.getByRole("button", { name: "Check it works" }));
 expect((await screen.findByRole("alert")).textContent).toBe("It didn't work: OpenAI refused the saved key (HTTP 401)");
 fireEvent.click(screen.getByRole("button", { name: "Remove" }));fireEvent.click(await screen.findByRole("button", { name: "Remove provider" }));
 await waitFor(() => expect(changed).toHaveBeenCalled());
 const removal = f.request.mock.calls.find(([r]) => r.method === "DELETE")?.[0];
 expect(removal).toMatchObject({ path: `/v1/app/org/model-sources/${source.sourceId}`, body: { expectedRevision: 7 } });f.close();
});

it("a member sees the providers but cannot add, check or remove", () => {
 const f = mount(h(ProviderSetup, { available: ["anthropic"], sources: [{ sourceId: "src_" + "d".repeat(20), kind: "anthropic", label: "Acme" }], revision: 1, canEdit: false, onChanged: vi.fn() }), async () => ({ status: 200, body: {} }));
 expect(screen.queryByRole("button", { name: "Check it works" })).toBeNull();expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();expect(screen.queryByLabelText("API key")).toBeNull();
 expect(screen.getByText("Only a company owner or admin can add or remove providers.")).toBeTruthy();f.close();
});

it("opens the account menu on its Leave step from an invite to another company, and leaves nothing without the click", async () => {
 const { AccountMenu } = await import("../../packages/ui/src/shell/AccountMenu.js");
 const { AppNavSchema } = await import("@agentx/contracts/web");
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { name: "Trial team" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
 const g = fakeHost(async () => ({ status: 200, body: me([]) }));g.host.currentPath = () => "/app?account=leave";
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: g.host, children: h(QueryClientProvider, { client: query, children: h(AccountMenu, { nav }) }) }));
 const dialog = await screen.findByRole("dialog", { name: "Leave organization?" });
 expect(dialog.textContent).toContain("Then open your invite link again to join the other company.");
 expect(g.request.mock.calls.some(([r]) => r.method === "POST")).toBe(false);ui.unmount();query.clear();
});

it("the GitHub connect panel waits for the person's GitHub link before offering Connect GitHub (no Connect button flashes up for someone who must link first)", async () => {
 const { GithubConnectPanel } = await import("../../packages/ui/src/screens/onboarding/steps/GithubConnectPanel.js");
 let answer: (response: ApiResponse) => void = () => undefined;
 const f = mount(h(GithubConnectPanel, { requested: false, refresh: () => undefined, returnTo: "/app/admin/connections" }), r => r.method === "GET" && r.path === "/v1/app/me" ? new Promise<ApiResponse>(resolve => { answer = resolve; }) : Promise.resolve({ status: 404, body: {} }));
 expect((await screen.findByRole("status")).textContent).toBe("Checking your GitHub account.");
 expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();expect(screen.queryByRole("button", { name: "Link your GitHub account" })).toBeNull();
 answer({ status: 200, body: me([]) });
 expect(await screen.findByRole("button", { name: "Link your GitHub account" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();f.close();
});
