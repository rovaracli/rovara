// @vitest-environment jsdom
// Rovara-cloud#25: a task stopped by review findings shows the findings and two ways forward: Send back to coding (with an optional note) and Accept
// (with a required reason). Only the owner sees them; a review that couldn't finish (no findings) shows neither.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const REPOSITORIES = [{ repositoryId: "payments", commitSha: "2".repeat(40), treeSha: "3".repeat(40), baseCommitSha: "1".repeat(40) }];
// The candidate's digest is the SHA-256 of its canonical manifest, as the contract checks it.
const DIGEST = createHash("sha256").update(JSON.stringify({ schemaVersion: 1, repositories: REPOSITORIES })).digest("hex");
const review = (role: string, findings: unknown[]) => ({ candidateDigest: DIGEST, operationId: "6a756d44-f9d4-43f2-bc1c-8298e1296d5b", provider: "amazon-bedrock", readOnly: true, recordedAt: "2026-11-15T01:17:00.000Z", role, status: findings.length === 0 ? "PASS" : "FINDINGS", version: "us.anthropic.claude-sonnet-4-6", findings });
function blockedByFindings(findings: unknown[], security: unknown[] = []) {
 return { workflow: { ...workspaceWorkflow(), stage: "REVIEW", state: "BLOCKED", blockReason: "the code review did not pass", candidate: { schemaVersion: 1, digest: DIGEST, repositories: REPOSITORIES }, reviews: [review("CRITIC", findings), review("SECURITY", security)] } };
}
const FINDINGS = [
 { advisory: false, origin: "INTRODUCED", severity: "LOW", file: "src/pages/Blog.jsx", text: "Blog.jsx injects blog.css after first render." },
 { advisory: true, origin: "INTRODUCED", severity: "LOW", text: "An advisory note that does not block." },
];
const ME = "d".repeat(64);
function setup(raw: unknown, respond: (request: ApiRequest) => Promise<ApiResponse> = async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }), options: { confirmedAgoMs?: number; note?: string } = {}) {
 const session = SessionViewReaderSchema.parse(raw), f = fakeHost(respond), query = createQueryClient();
 query.setQueryData(["nav"], { me: { developerId: ME, name: "Maya", orgRole: "member" } });
 // A confirmation (Code's step-up sign-in) this person finished that long ago, as the page records it.
 if (options.confirmedAgoMs !== undefined) f.storage.set(`rovara.stepup.confirmedAt.${ME}`, String(Date.now() - options.confirmedAgoMs));
 if (options.note !== undefined) f.storage.set(`rovara.reviewNote.${SESSION_FIXTURE_ID}`, options.note);
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session, onComment: () => undefined })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { f, close() { ui.unmount(); router.dispose(); query.clear(); } };
}

it("lists only the blocking findings and sends the code back to coding with the owner's note", async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings(FINDINGS));
 const s = setup(fixture, async request => request.path.endsWith("/send-back") ? { status: 200, body: { session: fixture } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } });
 const region = await screen.findByRole("region", { name: "Review findings" });
 expect(region.textContent).toContain("Blog.jsx injects blog.css after first render.");
 expect(region.textContent).not.toContain("advisory note");
 expect(screen.getByRole("button", { name: "Accept and open the pull request" }).hasAttribute("disabled")).toBe(true);
 fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "Import blog.css directly." } });
 fireEvent.click(screen.getByRole("button", { name: "Send back to coding" }));
 await waitFor(() => { expect(screen.getByText("Sent back to coding.")).toBeTruthy(); });
 const call = s.f.request.mock.calls.map(([request]) => request).find(request => request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/send-back")!;
 expect(call.method).toBe("POST");
 expect(call.body).toMatchObject({ note: "Import blog.css directly." });
 s.close();
});

const SECURITY = [{ advisory: true, origin: "INTRODUCED", severity: "LOW", text: "A security finding always blocks." }];

it("accepts with the note as the reason, and names a security finding on the button, right after the person confirmed it's them", async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings([], SECURITY));
 const s = setup(fixture, async request => request.path.endsWith("/accept-findings") ? { status: 200, body: { session: fixture } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }, { confirmedAgoMs: 60_000 });
 const button = await screen.findByRole("button", { name: "Accept, including the security finding, and open the pull request" });
 fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "Reviewed; not reachable." } });
 fireEvent.click(button);
 await waitFor(() => { expect(screen.getByText("Accepted. Rovara is opening the pull request.")).toBeTruthy(); });
 expect(s.f.request.mock.calls.map(([request]) => request).find(request => request.path.endsWith("/accept-findings"))?.body).toMatchObject({ reason: "Reviewed; not reachable." });
 s.close();
});

it("a security finding without a fresh confirmation: the button sends the person to Code's step-up sign-in, keeping the note, and nothing is accepted yet", async () => {
 for (const confirmedAgoMs of [undefined, 11 * 60_000]) {
  const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings([], SECURITY));
  const s = setup(fixture, undefined, confirmedAgoMs === undefined ? {} : { confirmedAgoMs });
  expect(screen.queryByRole("button", { name: "Accept, including the security finding, and open the pull request" })).toBeNull();
  const confirm = await screen.findByRole("button", { name: "Confirm it's you to accept the security finding" });
  fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "Reviewed; not reachable." } });
  fireEvent.click(confirm);
  expect(s.f.host.signIn).toHaveBeenCalledTimes(1);
  const [path, options] = (s.f.host.signIn as unknown as { mock: { calls: Array<[string, unknown]> } }).mock.calls[0]!;
  expect(options).toEqual({ stepUp: true });
  expect(path).toMatch(/confirmed=[0-9a-f-]{36}/u);
  expect(s.f.storage.get(`rovara.reviewNote.${SESSION_FIXTURE_ID}`)).toBe("Reviewed; not reachable.");
  expect(s.f.request.mock.calls.some(([request]) => request.path.endsWith("/accept-findings"))).toBe(false);
  s.close();
 }
});

it("back from confirming, the kept note is filled in once; a server that still finds the confirmation too old asks again", async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings([], SECURITY));
 const s = setup(fixture, async request => request.path.endsWith("/accept-findings") ? { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Accepting a security finding needs you to confirm it's you again. Confirm it, then try once more." } } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }, { confirmedAgoMs: 60_000, note: "Kept note." });
 expect((await screen.findByLabelText<HTMLTextAreaElement>("Your note")).value).toBe("Kept note.");
 expect(s.f.storage.get(`rovara.reviewNote.${SESSION_FIXTURE_ID}`)).toBe("");
 fireEvent.click(screen.getByRole("button", { name: "Accept, including the security finding, and open the pull request" }));
 await screen.findByRole("button", { name: "Confirm it's you to accept the security finding" });
 expect(screen.getByRole("alert").textContent).toContain("confirm it's you again");
 s.close();
});

it("a co-owner on the task's People list sees the choices; a code-only finding needs no confirmation", async () => {
 const coOwner = workspaceFixture({ status: "needs_person", you: { level: "view", owner: false, coOwner: true, following: false, actions: ["watch"] } }, blockedByFindings(FINDINGS));
 const s = setup(coOwner);
 expect(await screen.findByRole("region", { name: "Review findings" })).toBeTruthy();
 expect(screen.getByRole("button", { name: "Accept and open the pull request" })).toBeTruthy();
 s.close();
});

it("shows nothing to someone who is not the owner, or for a review that couldn't finish", async () => {
 const notOwner = workspaceFixture({ status: "needs_person", you: { level: "view", owner: false, following: false, actions: ["watch"] } }, blockedByFindings(FINDINGS));
 const a = setup(notOwner);
 await screen.findByRole("list", { name: "Task stages" });
 expect(screen.queryByRole("region", { name: "Review findings" })).toBeNull();
 a.close();
 const b = setup(workspaceFixture({ status: "needs_person" }, blockedByFindings([])));
 await screen.findByRole("list", { name: "Task stages" });
 expect(screen.queryByRole("region", { name: "Review findings" })).toBeNull();
 b.close();
});
