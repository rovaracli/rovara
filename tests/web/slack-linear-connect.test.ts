// @vitest-environment jsdom
// Guided onboarding PR 11 in the app: Add to Slack (optional, "Set up later"), Slack's return (fixed words, the "Keep it?" question with an owner's fresh
// confirmation for Disconnect), a project's Slack channel (picker, /invite then Check, change, remove) and its Linear team (Connect Linear, pick, change, remove),
// in the checklist rows PR 9 places and in Project settings. Only Slack's and Linear's own consent pages, coming back to this app, are ever opened.
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ApiRequest } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { AddToSlackStep, SlackConnectResult } from "../../packages/ui/src/screens/connect/SlackConnect.js";
import { LinearConnectResult } from "../../packages/ui/src/screens/connect/LinearConnect.js";
import { SlackChannelRow } from "../../packages/ui/src/screens/connect/SlackChannelRow.js";
import { LinearTeamRow } from "../../packages/ui/src/screens/connect/LinearTeamRow.js";
import { isLinearAuthorizeUrl, isSlackAuthorizeUrl } from "../../packages/ui/src/text/links.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const STATE = "s".repeat(43);
const APP = "https://cell.example";
const slackUrl = (redirect = `${APP}/api/connect/slack/callback`, extra = "") => `https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat%3Awrite&redirect_uri=${encodeURIComponent(redirect)}&state=${STATE}${extra}`;
const linearUrl = (redirect = `${APP}/api/connect/linear/callback`, actor = "app") => `https://linear.app/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=read&state=${STATE}&actor=${actor}&prompt=consent&code_challenge=${"c".repeat(43)}&code_challenge_method=S256`;
type Answer = { status: number; body: unknown };
const err = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });

function setup(node: ReactNode, answers: Record<string, Answer | ((request: ApiRequest) => Answer)>, path = "/app/onboard") {
 const f = fakeHost(async request => {
  const path = request.path.split("?", 1)[0]!;
  const found = answers[`${request.method} ${path}`] ?? answers[path];
  if (found === undefined) return { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } };
  return typeof found === "function" ? found(request) : found;
 });
 const navigate = vi.fn<(url: string) => void>(); f.host.navigate = navigate; const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [path], children: node }) }) }), { theme: "light" });
 return { ...f, navigate, calls: (p: string) => f.request.mock.calls.filter(([r]) => r.path.split("?", 1)[0] === p).map(([r]) => r), close() { ui.unmount(); query.clear(); } };
}

it("only Slack's and Linear's own consent pages that come back to this app pass the link checks", () => {
 expect(isSlackAuthorizeUrl(slackUrl(), APP)).toBe(true);
 for (const bad of [slackUrl("https://evil.example/api/connect/slack/callback"), slackUrl(undefined, "&user_scope=admin"), slackUrl().replace("https://slack.com", "https://slack.com.evil.example"), `${slackUrl()}#x`, slackUrl().replace(STATE, "short")]) expect(isSlackAuthorizeUrl(bad, APP), bad).toBe(false);
 expect(isSlackAuthorizeUrl(slackUrl().replace("/oauth/v2/authorize", "/oauth/v2/evil"), APP)).toBe(false);
 expect(isLinearAuthorizeUrl(linearUrl(), APP)).toBe(true);
 expect(isLinearAuthorizeUrl(linearUrl().replace("/oauth/authorize", "/oauth/evil"), APP)).toBe(false);
 for (const bad of [linearUrl("https://evil.example/api/connect/linear/callback"), linearUrl(undefined, "user"), linearUrl().replace("https://linear.app", "https://evil.example"), linearUrl().replace("&prompt=consent", "")]) expect(isLinearAuthorizeUrl(bad, APP), bad).toBe(false);
});

it("Add to Slack (optional): opens Slack's page from Cloud's answer, with this page as the way back; 'Set up later' never blocks", async () => {
 const onSkip = vi.fn();
 const f = setup(h(AddToSlackStep, { onSkip }), { "/v1/app/slack": { status: 200, body: { workspace: null } }, "/v1/app/slack/install": { status: 200, body: { authorizeUrl: slackUrl(), expiresAt: "x" } } });
 await screen.findByTestId("slack-add");
 expect(screen.getByTestId("slack-step").getAttribute("data-state")).toBe("open");
 expect(screen.getByText("Optional")).toBeTruthy();
 fireEvent.click(screen.getByTestId("slack-skip"));
 expect(onSkip).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByTestId("slack-add"));
 await waitFor(() => expect(f.navigate).toHaveBeenCalledWith(slackUrl()));
 // fakeHost's current page is /app/live: the start names it as the way back, and nothing else.
 expect(f.calls("/v1/app/slack/install")[0]).toMatchObject({ method: "POST", body: { back: "/app/live" } });
 f.close();
});

it("never opens a Slack address that comes back elsewhere", async () => {
 const f = setup(h(AddToSlackStep, {}), { "/v1/app/slack": { status: 200, body: { workspace: null } }, "/v1/app/slack/install": { status: 200, body: { authorizeUrl: slackUrl("https://evil.example/api/connect/slack/callback"), expiresAt: "x" } } });
 fireEvent.click(await screen.findByTestId("slack-add"));
 await screen.findByText("Rovara returned an invalid Slack link.");
 expect(f.navigate).not.toHaveBeenCalled();
 f.close();
});

it("shows the step done from the company's real workspace, and skipped when the guided setup says so", async () => {
 const f = setup(h(AddToSlackStep, {}), { "/v1/app/slack": { status: 200, body: { workspace: { teamName: "Acme", state: "connected", connectedAt: "2026-11-17T12:00:00.000Z", connectedBy: { kind: "person" } } } } });
 expect((await screen.findByTestId("slack-connected-line")).textContent).toBe("Rovara is in Acme.");
 f.close();
 const g = setup(h(AddToSlackStep, { skipped: true }), { "/v1/app/slack": { status: 200, body: { workspace: null } } });
 expect((await screen.findByTestId("slack-skipped")).textContent).toContain("Skipped (optional)");
 g.close();
});

it("Slack's return: one fixed sentence per word, with Try again; the kept outcome read once", async () => {
 for (const [word, text] of <Array<[string, string]>>[["start_again", "Start again from Rovara."], ["taken", "This Slack workspace is already connected to another company."], ["cancelled", "Rovara wasn't added to Slack. You can add it any time."]]) {
  const f = setup(h(SlackConnectResult, { outcome: word }), {});
  expect((await screen.findByTestId("slack-refused-message")).textContent).toBe(text);
  if (word === "taken") expect((await screen.findByTestId("slack-refused-message")).textContent).not.toMatch(/Acme|T0[A-Z0-9]+|different Rovara company/u);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  f.close();
 }
 // A crafted word (an Object.prototype member, or markup) shows nothing and never crashes the page.
 for (const word of ["<script>", "toString", "constructor", "__proto__"]) {
  const g = setup(h("div", { children: [h(SlackConnectResult, { outcome: word }), h(LinearConnectResult, { outcome: word }), h("p", { children: "page alive" })] }), {});
  expect(screen.getByText("page alive")).toBeTruthy();
  expect(screen.queryByTestId("slack-refused")).toBeNull();
  expect(screen.queryByTestId("linear-refused")).toBeNull();
  g.close();
 }
 const r = setup(h(SlackConnectResult, { outcome: "result" }), { "/v1/app/slack/install/result": { status: 200, body: { status: "connected", alreadyConnected: false, workspaceName: "Acme" } } });
 expect((await screen.findByTestId("slack-connected")).textContent).toBe("Rovara is in Acme.");
 expect(r.calls("/v1/app/slack/install/result")).toHaveLength(1);
 r.close();
});

it("'You signed in from A but added Rovara to B. Keep it?': Keep closes it; Disconnect asks an owner to confirm it's them first, then disconnects", async () => {
 let fresh = false;
 const f = setup(h(SlackConnectResult, { outcome: "result" }), {
  "/v1/app/slack/install/result": { status: 200, body: { status: "connected", alreadyConnected: false, workspaceName: "Side", mismatch: { signedInName: "Main" } } },
  "/v1/app/slack/disconnect": () => fresh ? { status: 200, body: { status: "disconnected", workspaceName: "Side", projectsLosingChannel: [] } } : err(403, "REAUTH_REQUIRED", "Confirm it's you again, then try once more."),
 });
 expect((await screen.findByTestId("slack-mismatch")).textContent).toContain("You signed in from Main but added Rovara to Side. Keep it?");
 fireEvent.click(screen.getByTestId("slack-mismatch-disconnect"));
 await screen.findByTestId("fresh-sign-in");
 fireEvent.click(screen.getByTestId("fresh-sign-in-start"));
 expect(f.host.signIn).toHaveBeenCalledWith(expect.stringContaining("confirmed="), { stepUp: true });
 fresh = true;
 fireEvent.click(screen.getByTestId("slack-mismatch-disconnect"));
 expect((await screen.findByTestId("slack-disconnected")).textContent).toBe("Rovara was removed from Side.");
 f.close();
 const g = setup(h(SlackConnectResult, { outcome: "result" }), { "/v1/app/slack/install/result": { status: 200, body: { status: "connected", alreadyConnected: false, workspaceName: "Side", mismatch: {} } } });
 fireEvent.click(await screen.findByTestId("slack-keep"));
 expect((await screen.findByTestId("slack-connected")).textContent).toBe("Rovara is in Side.");
 expect(g.calls("/v1/app/slack/disconnect")).toHaveLength(0);
 g.close();
});

it("a project's Slack channel: Add to Slack first when none is connected, with 'Set up later' in the checklist", async () => {
 const onSkip = vi.fn();
 const f = setup(h(SlackChannelRow, { project: "web", mode: "checklist", canEdit: true, onSkip }), { "/v1/app/projects/web/slack/channel": { status: 200, body: { connected: false, channels: [] } } });
 expect((await screen.findByTestId("slack-channel-not-connected")).textContent).toContain("Add Rovara to Slack first");
 expect(screen.getByTestId("slack-channel-row").getAttribute("data-state")).toBe("optional");
 fireEvent.click(screen.getByTestId("slack-channel-skip"));
 expect(onSkip).toHaveBeenCalledOnce();
 f.close();
 const g = setup(h(SlackChannelRow, { project: "web", mode: "checklist", canEdit: true, skipped: true }), { "/v1/app/projects/web/slack/channel": { status: 200, body: { connected: true, channels: [] } } });
 expect((await screen.findByTestId("slack-channel-skipped")).textContent).toContain("Skipped");
 expect(screen.getByTestId("slack-channel-row").getAttribute("data-state")).toBe("skipped");
 g.close();
});

it("links a private channel after /invite and Check, then changes and removes it (Project settings)", async () => {
 const linked: string[] = [];
 const f = setup(h(SlackChannelRow, { project: "web", mode: "settings", canEdit: true }), {
  "/v1/app/projects/web/slack/channel": (r) => {
   if (r.method === "GET") return { status: 200, body: { connected: true, channels: linked.map(id => ({ id })) } };
   if (r.method === "DELETE") { const was = [...linked];linked.length = 0;return { status: 200, body: { status: "unlinked", channels: was } }; }
   const id = (r.body as { channelId: string }).channelId;
   if (id === "GSECRET01") return { status: 200, body: { status: "invite_needed", channel: { id }, message: "Type `/invite @Rovara` in the channel, then press Check." } };
   linked.length = 0;linked.push(id);return { status: 200, body: { status: "linked", channel: { id, name: "web-dev", isPrivate: false }, alreadyLinked: false, replaced: [] } };
  },
  "/v1/app/projects/web/slack/channel/check": (r) => { const id = (r.body as { channelId: string }).channelId;linked.length = 0;linked.push(id);return { status: 200, body: { status: "linked", channel: { id, name: "secret", isPrivate: true }, alreadyLinked: false, replaced: [] } }; },
  "/v1/app/slack/channels": { status: 200, body: { channels: [{ id: "CWEB00001", name: "web-dev", isPrivate: false }, { id: "GSECRET01", name: "secret", isPrivate: true }, { id: "CAPI00001", name: "api", isPrivate: false, linked: true, linkedProject: "api" }] } },
 }, "/app/admin/projects/web");
 const picker = await screen.findByTestId("slack-channel-picker");
 const select = picker.querySelector("select")!;
 expect([...select.options].find(o => o.value === "CAPI00001")?.disabled).toBe(true);
 fireEvent.change(select, { target: { value: "GSECRET01" } });
 fireEvent.click(screen.getByTestId("slack-channel-link"));
 expect((await screen.findByTestId("slack-invite-needed")).textContent).toContain("Type `/invite @Rovara` in the channel, then press Check.");
 fireEvent.click(screen.getByTestId("slack-channel-check"));
 expect((await screen.findByTestId("slack-channel-linked")).textContent).toBe("Linked to #secret.");
 fireEvent.click(screen.getByTestId("slack-channel-change"));
 fireEvent.change((await screen.findByTestId("slack-channel-picker")).querySelector("select")!, { target: { value: "CWEB00001" } });
 fireEvent.click(screen.getByTestId("slack-channel-link"));
 expect((await screen.findByTestId("slack-channel-linked")).textContent).toBe("Linked to #web-dev.");
 fireEvent.click(screen.getByTestId("slack-channel-remove"));
 expect((await screen.findByTestId("slack-channel-note")).textContent).toContain("Channel removed.");
 expect(f.calls("/v1/app/projects/web/slack/channel").filter(r => r.method === "PUT").map(r => r.body)).toEqual([{ channelId: "GSECRET01" }, { channelId: "CWEB00001" }]);
 f.close();
});

it("shows Cloud's refusal words when a link is refused", async () => {
 const f = setup(h(SlackChannelRow, { project: "web", mode: "settings", canEdit: true }), {
  "GET /v1/app/projects/web/slack/channel": { status: 200, body: { connected: true, channels: [] } },
  "PUT /v1/app/projects/web/slack/channel": err(409, "SLACK_CHANNEL_TAKEN", "This channel is already linked to another project. Unlink it there first."),
  "/v1/app/slack/channels": { status: 200, body: { channels: [{ id: "CWEB00001", name: "web-dev", isPrivate: false }] } },
 });
 fireEvent.change((await screen.findByTestId("slack-channel-picker")).querySelector("select")!, { target: { value: "CWEB00001" } });
 fireEvent.click(screen.getByTestId("slack-channel-link"));
 expect((await screen.findByTestId("slack-channel-error")).textContent).toBe("This channel is already linked to another project. Unlink it there first.");
 f.close();
});

it("a project's Linear team: Connect Linear first (once per company), with 'Set up later' in the checklist", async () => {
 const onSkip = vi.fn();
 const f = setup(h(LinearTeamRow, { project: "web", mode: "checklist", canEdit: true, onSkip }), { "/v1/app/linear": { status: 200, body: { status: "disconnected" } }, "/v1/app/linear/connect": { status: 200, body: { authorizeUrl: linearUrl(), expiresAt: "x" } } });
 expect((await screen.findByTestId("linear-not-connected")).textContent).toContain("Connect Linear once");
 fireEvent.click(screen.getByTestId("linear-skip"));
 expect(onSkip).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByTestId("linear-connect"));
 await waitFor(() => expect(f.navigate).toHaveBeenCalledWith(linearUrl()));
 expect(f.calls("/v1/app/linear/connect")[0]).toMatchObject({ method: "POST", body: { back: "/app/live" } });
 f.close();
 const g = setup(h(LinearTeamRow, { project: "web", mode: "checklist", canEdit: true }), { "/v1/app/linear": { status: 200, body: { status: "disconnected" } }, "/v1/app/linear/connect": { status: 200, body: { authorizeUrl: linearUrl("https://evil.example/api/connect/linear/callback"), expiresAt: "x" } } });
 fireEvent.click(await screen.findByTestId("linear-connect"));
 await screen.findByText("Rovara returned an invalid Linear link.");
 expect(g.navigate).not.toHaveBeenCalled();
 g.close();
});

it("picks, changes and removes a project's Linear team (Project settings)", async () => {
 let pick: { id: string; key: string; name: string } | null = null;
 const teams = [{ id: "t1", key: "WEB", name: "Web" }, { id: "t2", key: "OPS", name: "Ops" }];
 const f = setup(h(LinearTeamRow, { project: "web", mode: "settings", canEdit: true }), {
  "/v1/app/linear": { status: 200, body: { status: "connected", workspace: { name: "Acme Linear", urlKey: "acme" }, connectedAt: "2026-11-17T12:00:00.000Z", connectedBy: {} } },
  "/v1/app/projects/web/linear": (r) => {
   if (r.method === "PUT") { pick = teams.find(t => t.id === (r.body as { teamId: string }).teamId)!;return { status: 200, body: { team: pick } }; }
   if (r.method === "DELETE") { pick = null;return { status: 200, body: { team: null, cleared: true } }; }
   return { status: 200, body: { team: pick, teams } };
  },
 });
 const select = await screen.findByLabelText("Linear team");
 fireEvent.change(select, { target: { value: "t2" } });
 fireEvent.click(screen.getByTestId("linear-team-save"));
 expect((await screen.findByTestId("linear-team")).textContent).toBe("Team: Ops (OPS)");
 fireEvent.click(screen.getByTestId("linear-team-change"));
 fireEvent.change(await screen.findByLabelText("Linear team"), { target: { value: "t1" } });
 fireEvent.click(screen.getByTestId("linear-team-save"));
 await waitFor(() => expect(screen.getByTestId("linear-team").textContent).toBe("Team: Web (WEB)"));
 fireEvent.click(screen.getByTestId("linear-team-remove"));
 expect((await screen.findByTestId("linear-note")).textContent).toBe("Linear team removed.");
 expect(f.calls("/v1/app/projects/web/linear").filter(r => r.method === "PUT").map(r => r.body)).toEqual([{ teamId: "t2" }, { teamId: "t1" }]);
 f.close();
});

it("Linear's return: fixed sentences, and the kept workspace name", async () => {
 const f = setup(h(LinearConnectResult, { outcome: "other_workspace" }), {});
 expect((await screen.findByTestId("linear-refused-message")).textContent).toBe("This company is already connected to another Linear workspace. A company owner can disconnect it first, then connect again.");
 f.close();
 const g = setup(h(LinearConnectResult, { outcome: "result" }), { "/v1/app/linear/connect/result": { status: 200, body: { status: "connected", reconnected: false, workspaceName: "Acme Linear", urlKey: "acme" } } });
 expect((await screen.findByTestId("linear-connected")).textContent).toBe("Connected to Linear workspace Acme Linear.");
 g.close();
});

it("a failed read says the app's own words by code, never the server's text", async () => {
 const f = setup(h("div", { children: [h(SlackChannelRow, { project: "web", mode: "settings", canEdit: true }), h(LinearTeamRow, { project: "web", mode: "settings", canEdit: true })] }), {
  "/v1/app/projects/web/slack/channel": err(409, "SLACK_NOT_CONNECTED", "PRIVATE_SERVER_TEXT"),
  "/v1/app/linear": err(400, "CONFIG_INVALID", "PRIVATE_SERVER_TEXT"),
 });
 expect((await screen.findByTestId("slack-channel-read-error")).textContent).toBe("Add Rovara to Slack first: this company has no Slack workspace connected.");
 expect((await screen.findByTestId("linear-read-error")).textContent).toBe("Couldn't read the Linear connection just now; try again.");
 expect(document.body.textContent).not.toContain("PRIVATE_SERVER_TEXT");
 f.close();
});
