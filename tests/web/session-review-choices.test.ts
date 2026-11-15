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
function setup(raw: unknown, respond: (request: ApiRequest) => Promise<ApiResponse> = async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } })) {
 const session = SessionViewReaderSchema.parse(raw), f = fakeHost(respond), query = createQueryClient();
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

it("accepts with the note as the reason, and names a security finding on the button", async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings([], [{ advisory: true, origin: "INTRODUCED", severity: "LOW", text: "A security finding always blocks." }]));
 const s = setup(fixture, async request => request.path.endsWith("/accept-findings") ? { status: 200, body: { session: fixture } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } });
 const button = await screen.findByRole("button", { name: "Accept, including the security finding, and open the pull request" });
 fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "Reviewed; not reachable." } });
 fireEvent.click(button);
 await waitFor(() => { expect(screen.getByText("Accepted. Rovara is opening the pull request.")).toBeTruthy(); });
 expect(s.f.request.mock.calls.map(([request]) => request).find(request => request.path.endsWith("/accept-findings"))?.body).toMatchObject({ reason: "Reviewed; not reachable." });
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
