// @vitest-environment jsdom
// Guided onboarding PR 2 in the app: the Connect GitHub step opens only GitHub's own pages from Cloud's answer, the callback's outcome is read once from
// Cloud (connected, a list to choose from, a request sent), refusals are one fixed sentence with "Try again", and the step shows Done from the company's
// real connections.
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { OnboardScreen } from "../../packages/ui/src/screens/onboarding/OnboardScreen.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const STATE = "s".repeat(43);
const me = { developer: { id: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "cloud", nameIsDefault: false }, identities: [] };
function setup(path: string, answers: { result?: unknown; choose?: { status: number; body: unknown }; connections?: unknown[]; connect?: unknown } = {}) {
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: me };
  if (request.path === "/v1/app/github/installations") return { status: 200, body: { installations: [] } };
  if (request.path === "/v1/app/github/connections") return { status: 200, body: { installations: answers.connections ?? [] } };
  if (request.path === "/v1/app/github/connect/result") return { status: 200, body: answers.result ?? { status: "none" } };
  if (request.path === "/v1/app/github/choose") return answers.choose ?? { status: 200, body: { status: "connected", alreadyConnected: false, accountLogin: "acme", accountType: "Organization" } };
  if (request.path === "/v1/app/github/connect") return { status: 200, body: answers.connect ?? { installUrl: `https://github.com/apps/rovara/installations/new?state=${STATE}`, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.abc&state=${STATE}`, expiresAt: "2026-11-17T12:10:00.000Z" } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } };
 });
 const navigate = vi.fn<(url: string) => void>(); f.host.navigate = navigate; const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [path], children: h(OnboardScreen) }) }) }), { theme: "light" });
 return { ...f, navigate, close() { ui.unmount(); query.clear(); } };
}
const calls = (f: ReturnType<typeof setup>, path: string) => f.request.mock.calls.filter(([request]) => request.path === path).map(([request]) => request);

it("Connect GitHub sends an empty body and opens GitHub's install page; the second button opens GitHub's authorize page", async () => {
 const f = setup("/app/onboard");
 fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
 await waitFor(() => expect(f.navigate).toHaveBeenCalledWith(`https://github.com/apps/rovara/installations/new?state=${STATE}`));
 expect(calls(f, "/v1/app/github/connect")[0]).toMatchObject({ method: "POST", body: {} });
 f.close();
 // Busy until the page leaves, so a second press can't start a second connect; a fresh page for the other button.
 const g = setup("/app/onboard");
 fireEvent.click(await screen.findByRole("button", { name: "Rovara is already on GitHub" }));
 await waitFor(() => expect(g.navigate).toHaveBeenCalledWith(`https://github.com/login/oauth/authorize?client_id=Iv1.abc&state=${STATE}`));
 g.close();
});

it("never opens an address that isn't GitHub's own page", async () => {
 const f = setup("/app/onboard", { connect: { installUrl: `https://evil.example/apps/rovara/installations/new?state=${STATE}`, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.abc&state=${STATE}&redirect_uri=https://evil.example`, expiresAt: "x" } });
 fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
 await screen.findByText("Rovara returned an invalid GitHub link.");
 await waitFor(() => expect(screen.getByRole("button", { name: "Rovara is already on GitHub" }).hasAttribute("disabled")).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Rovara is already on GitHub" }));
 await waitFor(() => expect(calls(f, "/v1/app/github/connect")).toHaveLength(2));
 expect(f.navigate).not.toHaveBeenCalled();
 f.close();
});

it("shows 'Connected to <account>' from the kept outcome, read once", async () => {
 const f = setup("/app/onboard?github=result", { result: { status: "connected", alreadyConnected: false, accountLogin: "acme", accountType: "Organization" } });
 expect((await screen.findByTestId("github-connected")).textContent).toBe("Connected to acme");
 expect(calls(f, "/v1/app/github/connect/result")).toHaveLength(1);
 expect(screen.queryByTestId("github-trial-used")).toBeNull();
 f.close();
});

it("tells a GitHub account that already used its trial", async () => {
 setup("/app/onboard?github=result", { result: { status: "connected", alreadyConnected: false, accountLogin: "acme", accountType: "Organization", trialUsed: true } });
 expect((await screen.findByTestId("github-trial-used")).textContent).toContain("This GitHub account already started a free trial for another organization.");
});

it("lists what was found; another company's account can't be chosen; choosing one connects it", async () => {
 const f = setup("/app/onboard?github=result", { result: { status: "choose", githubLogin: "maya-gh", installations: [
  { installationId: 11, accountLogin: "acme", accountType: "Organization", suspended: false, connection: "unbound" },
  { installationId: 12, accountLogin: "beta-co", accountType: "Organization", suspended: false, connection: "another_company" },
 ] } });
 const rows = await screen.findAllByTestId("github-choice");
 expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["We found Rovara on acme. Connect it?", "We found Rovara on beta-co. It's connected to a different Rovara company."]);
 expect(rows[1]!.querySelector("button")).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Connect it" }));
 expect((await screen.findByTestId("github-connected")).textContent).toBe("Connected to acme");
 expect(calls(f, "/v1/app/github/choose")[0]).toMatchObject({ method: "POST", body: { installationId: 11 } });
 f.close();
});

it("shows a refused choice as its one sentence with Try again", async () => {
 setup("/app/onboard?github=result", { result: { status: "choose", githubLogin: "maya-gh", installations: [{ installationId: 11, accountLogin: "acme", accountType: "Organization", suspended: false, connection: "unbound" }] }, choose: { status: 409, body: { error: { code: "GITHUB_INSTALLATION_TAKEN", message: "This GitHub account is already connected to a different Rovara company." } } } });
 fireEvent.click(await screen.findByRole("button", { name: "Connect it" }));
 expect((await screen.findByTestId("github-refused-message")).textContent).toBe("This GitHub account is already connected to a different Rovara company.");
 expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("shows a request sent, with the link to copy for the GitHub admin", async () => {
 const f = setup("/app/onboard?github=result", { result: { status: "requested", adminUrl: "https://github.com/apps/rovara/installations/new" } });
 await screen.findByText("Request sent. We'll show it here when your GitHub admin approves.");
 expect(screen.getByTestId("github-admin-link").getAttribute("value")).toBe("https://github.com/apps/rovara/installations/new");
 const copy = vi.fn(async () => {}); f.host.copyText = copy;
 fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
 await screen.findByRole("button", { name: "Link copied" });
 expect(copy).toHaveBeenCalledWith("https://github.com/apps/rovara/installations/new");
 f.close();
});

it("says each refusal word as Code's one sentence with Try again, and ignores any other word", async () => {
 const words: Record<string, string> = {
  start_again: "Start again from Rovara.", taken: "This GitHub account is already connected to a different Rovara company.",
  unavailable: "GitHub could not be connected just now. Start again from Rovara.", not_available: "Connecting GitHub isn't available yet.",
 };
 for (const [word, sentence] of Object.entries(words)) {
  const f = setup(`/app/onboard?github=${word}`);
  expect((await screen.findByTestId("github-refused-message")).textContent).toBe(sentence);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledWith(`https://github.com/apps/rovara/installations/new?state=${STATE}`));
  f.close();
 }
 const f = setup("/app/onboard?github=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
 await screen.findByRole("button", { name: "Connect GitHub" });
 expect(screen.queryByTestId("github-refused")).toBeNull();
 expect(document.body.textContent).not.toContain("alert(1)");
 expect(calls(f, "/v1/app/github/connect/result")).toHaveLength(0);
 f.close();
});

it("marks the Connect GitHub step Done from the company's real connections", async () => {
 const f = setup("/app/onboard", { connections: [{ installationId: 11, accountLogin: "acme", connectedAt: "2026-11-17T12:00:00.000Z", connectedBy: { kind: "person", name: "Maya" } }] });
 await screen.findByTestId("github-step-done");
 expect(screen.getByTestId("onboard-step-github").textContent).toContain("Done");
 f.close();
 const g = setup("/app/onboard");
 await screen.findByRole("button", { name: "Connect GitHub" });
 await waitFor(() => expect(calls(g, "/v1/app/github/connections")).toHaveLength(1));
 expect(screen.getByTestId("onboard-step-github").textContent).not.toContain("Done");
 g.close();
});

it("a crafted github= word (an Object.prototype member) shows nothing and never crashes the page", async () => {
 for (const word of ["toString", "constructor", "__proto__"]) {
  const f = setup(`/app/onboard?github=${word}`);
  await screen.findByRole("heading", { name: "Onboard a project" });
  expect(screen.queryByTestId("github-refused")).toBeNull();
  f.close();
 }
});
