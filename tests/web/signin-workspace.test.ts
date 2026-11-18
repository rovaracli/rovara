// @vitest-environment jsdom
// L4-SIGNIN (browser side): the last Slack workspace is kept in localStorage as ONLY a workspace id, sent as a hint on the next sign-in, and forgotten by
// "Use a different workspace"; the sign-in page shows "Sign in with GitHub" only when Code's offer lists it. Storage that throws never blocks a sign-in.
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createBrowserHost, LAST_WORKSPACE_KEY, type BrowserWindow } from "../../packages/web/src/browser-host.js";
import { AppHostProvider, type AppHost } from "../../packages/ui/src/host.js";
import { SignInChoices } from "../../packages/ui/src/screens/signed-out/SignInChoices.js";
import { SignupScreen } from "../../packages/ui/src/screens/onboarding/SignupScreen.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";

const HINT = "T0HINT0001";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function browser(options: { stored?: string; throwing?: boolean; answers?: Record<string, () => Response> } = {}) {
 const local = new Map<string, string>(options.stored === undefined ? [] : [[LAST_WORKSPACE_KEY, options.stored]]), assign = vi.fn();
 const boom = () => { throw new Error("storage blocked"); };
 const fetch = vi.fn(async (input: RequestInfo | URL) => (options.answers?.[String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)] ?? (() => json({}, 404)))());
 const win = { location: { origin: "https://cell.example", pathname: "/app/live", search: "", assign }, fetch,
  localStorage: options.throwing === true ? { getItem: boom, setItem: boom } : { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => { local.set(key, value); } },
  sessionStorage: { getItem: () => null, setItem: () => undefined },
 } as unknown as BrowserWindow;
 return { win, local, assign, fetch };
}
const target = (assign: ReturnType<typeof vi.fn>) => new URL(String(assign.mock.lastCall?.[0]), "https://cell.example");
afterEach(() => { vi.restoreAllMocks(); });

describe("the browser host's sign-in", () => {
 it("adds the remembered workspace as a hint, and nothing when none is kept", () => {
  const some = browser({ stored: HINT });
  createBrowserHost(some.win).signIn("/app");
  expect(target(some.assign).searchParams.get("slack_team")).toBe(HINT);
  const none = browser();
  createBrowserHost(none.win).signIn("/app");
  expect(none.assign.mock.lastCall?.[0]).toBe("/v1/auth/browser/authorize?return_to=%2Fapp");
 });

 it.each([["lowercase", "t0hint0001"], ["too short", "T0HIN"], ["a url", "https://evil.example"], ["an injection", "T0HINT0001&return_to=/x"], ["an enterprise id", "E0HINT0001"], ["empty", ""]])("ignores a stored value that is not a workspace id (%s)", (_case, stored) => {
  const b = browser({ stored });
  const host = createBrowserHost(b.win);
  expect(host.lastWorkspace?.()).toBeUndefined();
  host.signIn("/app");
  expect(b.assign.mock.lastCall?.[0]).toBe("/v1/auth/browser/authorize?return_to=%2Fapp");
 });

 it("localStorage that throws still signs in, with no hint", () => {
  const b = browser({ throwing: true });
  const host = createBrowserHost(b.win);
  expect(host.lastWorkspace?.()).toBeUndefined();
  expect(() => host.signIn("/app", { differentWorkspace: true })).not.toThrow();
  expect(b.assign.mock.lastCall?.[0]).toBe("/v1/auth/browser/authorize?return_to=%2Fapp");
 });

 it("a different workspace signs in without the hint and forgets it", () => {
  const b = browser({ stored: HINT });
  const host = createBrowserHost(b.win);
  host.signIn("/app", { differentWorkspace: true });
  expect(target(b.assign).searchParams.has("slack_team")).toBe(false);
  expect(host.lastWorkspace?.()).toBeUndefined();
  expect(b.local.get(LAST_WORKSPACE_KEY)).toBe("");
 });

 it("a method button names its method; GitHub never carries a Slack hint, Slack does", () => {
  const b = browser({ stored: HINT });
  const host = createBrowserHost(b.win);
  host.signIn("/app", { method: "github" });
  expect(target(b.assign).searchParams.get("method")).toBe("github");
  expect(target(b.assign).searchParams.has("slack_team")).toBe(false);
  host.signIn("/app", { method: "slack" });
  expect(target(b.assign).searchParams.get("method")).toBe("slack");
  expect(target(b.assign).searchParams.get("slack_team")).toBe(HINT);
 });

 it("keeps the Slack workspace of a sign-in, only as a workspace id, and only the id", async () => {
  const b = browser({ answers: { "/v1/web/me/sign-in-workspace": () => json({ slackTeamId: HINT, email: "a@b.test" }) } });
  await createBrowserHost(b.win).rememberSignInWorkspace?.();
  expect(b.local.get(LAST_WORKSPACE_KEY)).toBe(HINT);
  expect([...b.local.values()].join(" ")).not.toContain("a@b.test");
 });

 it.each([["a bad id", json({ slackTeamId: "nope" })], ["no workspace", json({})], ["an error", json({}, 401)], ["a non-object", json("T0HINT0001")]])("keeps nothing for %s", async (_case, answer) => {
  const b = browser({ stored: "T0KEEP0001", answers: { "/v1/web/me/sign-in-workspace": () => answer } });
  await createBrowserHost(b.win).rememberSignInWorkspace?.();
  expect(b.local.get(LAST_WORKSPACE_KEY)).toBe("T0KEEP0001");
 });

 it("never throws when storage or the request fails", async () => {
  const blocked = browser({ throwing: true, answers: { "/v1/web/me/sign-in-workspace": () => json({ slackTeamId: HINT }) } });
  await expect(createBrowserHost(blocked.win).rememberSignInWorkspace?.()).resolves.toBeUndefined();
  const failing = browser();
  failing.fetch.mockRejectedValueOnce(new Error("offline"));
  await expect(createBrowserHost(failing.win).rememberSignInWorkspace?.()).resolves.toBeUndefined();
 });

 it("reads the offer as two booleans, or nothing", async () => {
  const good = browser({ answers: { "/v1/auth/browser/methods": () => json({ slack: true, github: true }) } });
  expect(await createBrowserHost(good.win).signInOffer?.()).toEqual({ slack: true, github: true });
  const odd = browser({ answers: { "/v1/auth/browser/methods": () => json({ slack: "yes", github: 1 }) } });
  expect(await createBrowserHost(odd.win).signInOffer?.()).toBeUndefined();
  const down = browser({ answers: { "/v1/auth/browser/methods": () => json({}, 503) } });
  expect(await createBrowserHost(down.win).signInOffer?.()).toBeUndefined();
 });
});

function withHost(overrides: Partial<AppHost>) {
 const base = fakeHost();
 const host: AppHost = { ...base.host, ...overrides };
 return { host, element: h(AppHostProvider, { host, children: h(SignInChoices, { returnPath: "/app" }) }) };
}

describe("the sign-in buttons", () => {
 it("show Sign in with Slack and Sign in with GitHub only when Code's offer lists both", async () => {
  const { host, element } = withHost({ signInOffer: async () => ({ slack: true, github: true }) });
  renderUi(element);
  await screen.findByRole("button", { name: "Sign in with GitHub" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  expect(host.signIn).toHaveBeenLastCalledWith("/app", { method: "github" });
  await user.click(screen.getByRole("button", { name: "Sign in with Slack" }));
  expect(host.signIn).toHaveBeenLastCalledWith("/app", { method: "slack" });
 });

 it.each([["slack only", { slack: true, github: false }], ["nothing readable", undefined], ["github only", { slack: false, github: true }]])("shows the one plain Sign in button for %s, never a GitHub button", async (_case, offer) => {
  const { host, element } = withHost({ signInOffer: async () => offer });
  renderUi(element);
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy());
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(screen.queryByRole("button", { name: /GitHub/u })).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
  expect(host.signIn).toHaveBeenLastCalledWith("/app");
 });

 it("a failing offer read leaves the plain button, with no error shown", async () => {
  const { element } = withHost({ signInOffer: async () => { throw new Error("offline"); } });
  renderUi(element);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
 });

 it("a host with no offer (the desktop host) shows the plain button", () => {
  const { element } = withHost({});
  renderUi(element);
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /GitHub|workspace/u })).toBeNull();
 });

 it("Use a different workspace appears only when a workspace is remembered, and signs in without it", async () => {
  const none = withHost({ lastWorkspace: () => undefined });
  renderUi(none.element);
  expect(screen.queryByRole("button", { name: "Use a different workspace" })).toBeNull();
  const some = withHost({ lastWorkspace: () => HINT });
  renderUi(some.element);
  await userEvent.setup().click(screen.getByRole("button", { name: "Use a different workspace" }));
  expect(some.host.signIn).toHaveBeenLastCalledWith("/app", { differentWorkspace: true });
 });

 it("the sign-up page uses the same buttons and keeps its wording", async () => {
  const base = fakeHost();
  const host: AppHost = { ...base.host, signInOffer: async () => ({ slack: true, github: true }) };
  renderUi(h(AppHostProvider, { host, children: h(SignupScreen) }));
  await screen.findByRole("button", { name: "Sign in with GitHub" });
  expect(screen.getByRole("heading", { name: "Start with Rovara" })).toBeTruthy();
 });
});
