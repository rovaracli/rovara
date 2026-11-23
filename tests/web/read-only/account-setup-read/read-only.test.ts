// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { mount } from "./mount.js";
import { identity, respond } from "./fixtures.js";

// G5 ship: Account, Your GitHub account and Automation keys now carry the live actions of the pages they replace (name, theme, sign-in connect/unlink, Slack switch, GitHub
// connect/unlink, key create/revoke). The old "zero write controls" rule is replaced by: nothing is sent until a person presses one of THESE controls, and the setup views
// (onboard slots, project checklist) stay read-only. Each action's own send/refuse counts are in tests/web/account-setup-mount.test.ts.
const CONTROLS: Record<string, RegExp> = {
 "/app/account": /^(Change name|Choose a name|Unlink |Connect )/,
 "/app/account/github": /^(Disconnect your GitHub account|Connect your GitHub)$/,
 "/app/account/automation-keys": /^(Create automation key|Revoke )/,
};
const buttonNames = () => [...document.querySelectorAll("button:not([data-read-retry]):not([role=switch])")].map(b => b.getAttribute("aria-label") ?? b.textContent ?? "");
it.each(Object.keys(CONTROLS))("%s sends only reads until a listed control is pressed, including refetch", async path => {
 const f = mount(path, r => r.path === "/v1/app/me/sign-ins" ? { status: 200, body: { signIns: [{ method: "github", primary: true }, { method: "slack", primary: false }] } } : respond(r));
 await screen.findByRole("heading", { level: 1 });
 await waitFor(() => expect(document.querySelector(".g5-skeleton-rows")).toBeNull());
 await act(async () => { await f.query.refetchQueries(); });
 await waitFor(() => expect(buttonNames().length).toBeGreaterThan(0));
 for (const name of buttonNames()) expect(name).toMatch(CONTROLS[path]!);
 expect(document.querySelector("form,select,textarea")).toBeNull();
 expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 expect(f.host.signIn).not.toHaveBeenCalled(); expect(Reflect.get(f.host, "navigate")).not.toHaveBeenCalled();
 f.close();
});
// The three files that hold a live handler are listed by name, each with the writers it must NOT use; every other file of the area (all the setup views) may not write at all.
const WRITERS: Record<string, RegExp> = {
 "AccountReadScreen.tsx": /createScriptTokenApi|\.send(?:Answer)?\(/,
 "AutomationKeysReadScreen.tsx": /NameForm|\.send(?:Answer)?\(/,
 "GithubAccountReadScreen.tsx": /createScriptTokenApi|NameForm/,
};
it("mounted area imports no writer API or writer screen outside the three live account pages", () => {
 const root = resolve("packages/ui/src/screens/account-setup-read");
 const files = readdirSync(root).filter(f => /\.tsx?$/.test(f));
 for (const file of files) {
  const code = readFileSync(resolve(root, file), "utf8");
  const own = WRITERS[file];
  if (own === undefined) expect(code).not.toMatch(/\.send(?:Answer)?\(|useMutation|createScriptTokenApi|useOnboardingApi|useSetupAgentApi|useSetupChecklistApi|safe-action|NameForm|screens\/account\//);
  else { expect(code).not.toMatch(/useMutation|useOnboardingApi|useSetupAgentApi|useSetupChecklistApi|safe-action/); expect(code).not.toMatch(own); }
 }
});
it("keeps secret fields out of the key DOM and query cache", async () => {
 const f = mount("/app/account/automation-keys", r => {
  const answer = respond(r);
  if (r.path !== "/v1/app/script-tokens") return answer;
  const body = answer.body as { tokens: object[] };
  return { status: 200, body: { ...body, secret: "SYNTHETIC-SECRET", tokens: body.tokens.map(t => ({ ...t, secret: "SYNTHETIC-SECRET" })) } };
 });
 await screen.findByText("Nightly CI");
 expect(document.body.textContent).not.toContain("SYNTHETIC-SECRET");
 expect(JSON.stringify(f.query.getQueryCache().getAll().map(q => q.state.data))).not.toContain("SYNTHETIC-SECRET"); f.close();
});
it.each(["owner", "admin", "member"])("the same personal controls for %s: nothing is role-gated on Account, and no request is a write", async orgRole => {
 const f = mount("/app/account", r => r.path === "/v1/app/me" ? { status: 200, body: { ...identity, developer: { ...identity.developer, orgRole } } } : respond(r));
 await screen.findByText("priya-dev");
 await waitFor(() => expect(document.querySelector(".g5-skeleton-rows")).toBeNull());
 expect(buttonNames()).toContain("Change name");
 for (const name of buttonNames()) expect(name).toMatch(CONTROLS["/app/account"]!);
 expect(document.querySelectorAll("form")).toHaveLength(0);
 expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true); f.close();
});
