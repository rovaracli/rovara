// @vitest-environment jsdom
// Rovara-cloud#25: a task stopped by review findings shows the findings and two ways forward: Send back to coding (with an optional note) and Accept
// (with a required reason). Only the owner sees them; a review that couldn't finish (no findings) shows neither.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readFrozenSessionRequest, sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { renderUi } from "./support/render.js";
import { meFixture } from "./support/fixtures.js";
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
function setup(raw: unknown, respond: (request: ApiRequest) => Promise<ApiResponse> = async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } })) {
 const session = SessionViewReaderSchema.parse(raw);let current = session;const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : request.method === "GET" && request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID ? { status: 200, body: { session: current } } : respond(request)), query = createQueryClient();
 query.setQueryData(["nav"], { me: { developerId: ME, name: "Maya", orgRole: "member" } });
 function MountedWorkspace() {
  const read = useQuery({ queryKey: ["session", SESSION_FIXTURE_ID], initialData: session, staleTime: Infinity, queryFn: async () => {
   const reply = await f.host.transport.request({ method: "GET", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID });
   return SessionViewReaderSchema.parse((reply.body as { session: unknown }).session);
  } });
  return h(Workspace, { session: read.data, onComment: () => undefined });
 }
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(MountedWorkspace, {})) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { f, readAs(raw: unknown) { current = SessionViewReaderSchema.parse(raw); }, close() { ui.unmount(); router.dispose(); query.clear(); } };
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

it("accepts with the note as the reason, and names a security finding on the button, with no step-up (owner DEC 254zzz73)", async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings([], SECURITY));
 const s = setup(fixture, async request => request.path.endsWith("/accept-findings") ? { status: 200, body: { session: fixture } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } });
 const button = await screen.findByRole("button", { name: "Accept, including the security finding, and open the pull request" });
 expect(screen.queryByRole("button", { name: /Confirm it's you/u })).toBeNull();
 fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "Reviewed; not reachable." } });
 fireEvent.click(button);
 await waitFor(() => { expect(screen.getByText("Accepted. Rovara is opening the pull request.")).toBeTruthy(); });
 expect(s.f.request.mock.calls.map(([request]) => request).find(request => request.path.endsWith("/accept-findings"))?.body).toMatchObject({ reason: "Reviewed; not reachable." });
 s.close();
});

it("a refused security accept shows the server's words and no sign-in step; the button stays the accept", async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings([], SECURITY));
 const s = setup(fixture, async request => request.path.endsWith("/accept-findings") ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Only Ada or a co-owner can accept these findings." } } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } });
 fireEvent.change(await screen.findByLabelText("Your note"), { target: { value: "Reviewed; not reachable." } });
 fireEvent.click(screen.getByRole("button", { name: "Accept, including the security finding, and open the pull request" }));
 expect((await screen.findByRole("alert")).textContent).toContain("Only Ada or a co-owner can accept these findings.");
 expect(screen.queryByRole("button", { name: /Confirm it's you/u })).toBeNull();
 expect(s.f.host.signIn).not.toHaveBeenCalled();
 s.close();
});

it("a co-owner on the task's People list sees the choices", async () => {
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

for (const operation of ["send", "accept"] as const) for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R3/R6a Review ${operation}: 500/${code} leaves the confirmation locked`, async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings(FINDINGS));
 const s = setup(fixture, async () => ({ status: 500, body: { error: { code, message: "Unknown result" } } }));
 fireEvent.change(await screen.findByLabelText("Your note"), { target: { value: "Keep the exact reviewed change" } });
 const button = screen.getByRole<HTMLButtonElement>("button", { name: operation === "send" ? "Send back to coding" : "Accept and open the pull request" });
 await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
 await waitFor(() => expect(s.f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1));
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(button.disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check" }));
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(s.f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);expect(button.disabled).toBe(true);
 s.close();
});

for (const code of ["IDEMPOTENCY_CONFLICT", "CONFLICT"]) for (const operation of ["send", "accept"] as const) it(`DEC283 ${code} ${operation}: sends the displayed workflow revision and candidate after a newer GET and never resends a 409`, async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings(FINDINGS));
 const words = code === "CONFLICT" ? operation === "send" ? "There are no review findings to send back right now." : "There are no review findings to accept right now." : "The shown candidate changed.";
 const s = setup(fixture, async () => ({ status: 409, body: { error: { code, message: words } } }));
 try {
  fireEvent.change(await screen.findByLabelText("Your note"), { target: { value: "Use these exact findings" } });
  s.readAs(workspaceFixture({ status: "needs_person" }, { workflow: { ...blockedByFindings(FINDINGS).workflow, revision: workspaceWorkflow().revision + 1 } }));
  fireEvent.click(screen.getByRole("button", { name: operation === "send" ? "Send back to coding" : "Accept and open the pull request" }));
  await screen.findByText(words);
  const sent = s.f.request.mock.calls.filter(([r]) => r.method === "POST");
  expect(sent).toHaveLength(1);expect(sent[0]![0].body).toMatchObject({ expectedRevision: workspaceWorkflow().revision, candidateDigest: DIGEST });
  await waitFor(() => expect(s.f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path.endsWith(SESSION_FIXTURE_ID)).length).toBeGreaterThanOrEqual(2));
  if (code === "IDEMPOTENCY_CONFLICT") {
   // docs/safe-action.md:5,9: every review idempotency conflict is unknown;
   // a newer read alone cannot discard the frozen identity and permit a resend.
   const me = meFixture(), scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, "review:" + SESSION_FIXTURE_ID);
   const frozen = readFrozenSessionRequest(s.f.host, scope);
   expect(frozen).toMatchObject({ requestId: (sent[0]![0].body as { requestId: string }).requestId, action: operation, body: sent[0]![0].body });
   expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send back to coding" }).disabled).toBe(true);
   expect(screen.getByRole<HTMLButtonElement>("button", { name: "Accept and open the pull request" }).disabled).toBe(true);
   expect(screen.getByText(/Rovara didn't confirm this yet/)).toBeTruthy();
   const reads = s.f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path.endsWith(SESSION_FIXTURE_ID)).length;
   await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); });
   await waitFor(() => expect(s.f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path.endsWith(SESSION_FIXTURE_ID)).length).toBeGreaterThan(reads));
   expect(readFrozenSessionRequest(s.f.host, scope)).toEqual(frozen);
   const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send back to coding" }), accept = screen.getByRole<HTMLButtonElement>("button", { name: "Accept and open the pull request" });
   expect(send.disabled).toBe(true);expect(accept.disabled).toBe(true);
   fireEvent.click(send);fireEvent.click(accept);
  } else {
   // docs/safe-action.md:5: proven pre-commit owner-round refusals remain final.
   await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send back to coding" }).disabled).toBe(false));
   expect(screen.getByRole<HTMLButtonElement>("button", { name: "Accept and open the pull request" }).disabled).toBe(false);
   expect(screen.queryByText(/Rovara didn't confirm this yet/)).toBeNull();
   expect([...s.f.storage.values()].some(raw => raw.includes('"action":"' + operation + '"'))).toBe(false);
  }
  expect(s.f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 } finally { s.close(); }
});

for (const refusal of ["The displayed revision and candidate digest are required.", "This page is out of date. Reload to continue."]) for (const operation of ["send", "accept"] as const) it(`N4 ${operation}/${refusal}: missing display pins offer a full Reload and never resend`, async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings(FINDINGS));
 const s = setup(fixture, async () => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message: refusal } } }));
 try {
  fireEvent.change(await screen.findByLabelText("Your note"), { target: { value: "Reviewed these findings" } });
  const button = screen.getByRole<HTMLButtonElement>("button", { name: operation === "send" ? "Send back to coding" : "Accept and open the pull request" });
  await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
  await screen.findByText("This page is out of date. Reload to continue.");
  expect(screen.getByRole("link", { name: "Reload" }).getAttribute("href")).toBe("/s/" + SESSION_FIXTURE_ID);
  expect(screen.queryByRole("button", { name: "Send back to coding" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Accept and open the pull request" })).toBeNull();
  expect(screen.queryByText(/didn't confirm/)).toBeNull();
  expect(s.f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 } finally { s.close(); }
});

for (const [status, code, message] of [
 [500, "CONFIG_INVALID", "The displayed revision and candidate digest are required."],
 [409, "CONFIG_INVALID", "The displayed revision and candidate digest are required."],
 [400, "FUTURE_CODE", "The displayed revision and candidate digest are required."],
 [400, "CONFIG_INVALID", "The candidate changed. Read the task again."],
] as const) it(`N4 ${status}/${code}/${message}: unrelated errors do not claim the bundle is stale`, async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings(FINDINGS));
 const s = setup(fixture, async () => ({ status, body: { error: { code, message } } }));
 try {
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Send back to coding" });
  await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
  await screen.findByRole("alert");
  expect(screen.queryByText("This page is out of date. Reload to continue.")).toBeNull();
  expect(screen.queryByRole("link", { name: "Reload" })).toBeNull();
  expect(s.f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 } finally { s.close(); }
});

// Opus N4 review (5e5c29cf6): Reload must be a full document load of the new bundle, not an in-app re-read or a resend.
for (const operation of ["send", "accept"] as const) it(`N4 review ${operation}: Reload is a plain full-page link (default not prevented, nothing resent)`, async () => {
 const fixture = workspaceFixture({ status: "needs_person" }, blockedByFindings(FINDINGS));
 const s = setup(fixture, async () => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "This page is out of date. Reload to continue." } } }));
 try {
  fireEvent.change(await screen.findByLabelText("Your note"), { target: { value: "Reviewed these findings" } });
  const button = screen.getByRole<HTMLButtonElement>("button", { name: operation === "send" ? "Send back to coding" : "Accept and open the pull request" });
  await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
  const link = await screen.findByRole("link", { name: "Reload" });
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  // Window bubble runs after React's root handlers; read the app's choice, then stop jsdom's navigation.
  let prevented: boolean | undefined;
  window.addEventListener("click", seen => { prevented = seen.defaultPrevented;seen.preventDefault(); }, { once: true });
  link.dispatchEvent(event);
  expect(prevented).toBe(false);
  await Promise.resolve();
  expect(s.f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 } finally { s.close(); }
});
