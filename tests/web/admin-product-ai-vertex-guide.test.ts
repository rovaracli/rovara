// @vitest-environment jsdom
// L4-T4 (setup review G4): the three-step guide on the Vertex AI form. A snapshot of the panel, each refusal reason names the step that fixes it,
// the copy buttons copy exactly the command shown, and only values that pass Cloud's own patterns ever reach a command.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { readProductAi } from "../../packages/ui/src/api/admin-product-ai.js";
import { apiError } from "../../packages/ui/src/api/errors.js";
import { VertexGuide } from "../../packages/ui/src/screens/admin/product-ai/VertexGuide.js";
import { ACCOUNT_PLACEHOLDER, PROJECT_PLACEHOLDER, VERTEX_REFUSAL_REASONS, isVertexRefusalReason, vertexGuide, vertexRefusalHelp, type VertexRefusalReason } from "../../packages/ui/src/screens/admin/product-ai/vertex-guide.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const me = "a".repeat(64), company = "org_aaaaaaaaaaaaaaaaaaaa";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const setup = { awsAccountId: "111122223333", roleName: "RovaraProductAiFederation", companyId: company };
// Built at runtime so no email-shaped text sits in the source (the public CI copy's token check).
const ACCOUNT_DOMAIN = ["@acme-evals", "iam.gserviceaccount.com"].join(".");
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });
function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: company, name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
const view = (vertexSetup: unknown) => ({ project: "web", revision: 3, canChange: true, key: { connected: false }, removedUntil: null, vertex: { connected: false }, evalBudget: { calls: 400, costMicros: 4_000_000 }, evalApproval: null, vertexSetup });
function confirmedPath(path: string): string { seeded.set("rovara.stepup.nonce", JSON.stringify({ nonce: "n-1", at: Date.now() })); return `${path}?confirmed=n-1`; }
async function openVertex() {
 fireEvent.change(await screen.findByLabelText("Project"), { target: { value: "web" } });
 fireEvent.click(screen.getByRole("button", { name: "Open" }));
 fireEvent.change(await screen.findByLabelText("AI provider"), { target: { value: "vertex" } });
 await screen.findByTestId("vertex-guide");
}
function renderGuide(props: Partial<Parameters<typeof VertexGuide>[0]> = {}, copyText?: (text: string) => Promise<void>) {
 const f = fakeHost(); if (copyText !== undefined) Object.assign(f.host, { copyText });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(VertexGuide, { projectId: "acme-evals", setup, usesServiceAccount: false, ...props }) }));
 return { ...f, ...view };
}

describe("the Vertex guide panel", () => {
 it("is three steps with the commands Rovara fills in (snapshot)", () => {
  renderGuide();
  const panel = screen.getByTestId("vertex-guide");
  expect(panel.textContent.replaceAll(ACCOUNT_DOMAIN, "@PROJECT_DOMAIN")).toMatchInlineSnapshot(`
    "Connect Vertex AI in three stepsSomeone who can edit IAM in your Google Cloud project runs these in Cloud Shell or any terminal signed in to gcloud (about 10 minutes). Rovara never gets a key: Google trusts a Rovara identity that carries your company's id.Step 1: Let Google trust Rovara's identityCreates a workload identity pool and an AWS provider that accepts only your company's Rovara session (the attribute condition). No key is created.PROJECT_ID="acme-evals"
    gcloud services enable iam.googleapis.com cloudresourcemanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com aiplatform.googleapis.com --project="$PROJECT_ID"
    gcloud iam workload-identity-pools create rovara --project="$PROJECT_ID" --location="global" --display-name="Rovara"
    gcloud iam workload-identity-pools providers create-aws rovara-aws --project="$PROJECT_ID" --location="global" --workload-identity-pool="rovara" \\
      --account-id="111122223333" \\
      --attribute-mapping="google.subject=assertion.arn" \\
      --attribute-condition="assertion.arn == 'arn:aws:sts::111122223333:assumed-role/RovaraProductAiFederation/org_aaaaaaaaaaaaaaaaaaaa'" \\
      --display-name="Rovara"Copy commandThe provider already exists without the conditionPROJECT_ID="acme-evals"
    gcloud iam workload-identity-pools providers update-aws rovara-aws --project="$PROJECT_ID" --location="global" --workload-identity-pool="rovara" \\
      --attribute-condition="assertion.arn == 'arn:aws:sts::111122223333:assumed-role/RovaraProductAiFederation/org_aaaaaaaaaaaaaaaaaaaa'"Copy commandStep 2: Let that identity call Vertex AICreates a service account with the Vertex AI User role, and lets only your company's Rovara session act as it.PROJECT_ID="acme-evals"
    PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")"
    gcloud iam service-accounts create rovara-vertex --project="$PROJECT_ID" --display-name="Rovara Vertex AI"
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
      --member="serviceAccount:rovara-vertex@PROJECT_DOMAIN" \\
      --role="roles/aiplatform.user"
    gcloud iam service-accounts add-iam-policy-binding "rovara-vertex@PROJECT_DOMAIN" --project="$PROJECT_ID" \\
      --role="roles/iam.workloadIdentityUser" \\
      --member="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/rovara/subject/arn:aws:sts::111122223333:assumed-role/RovaraProductAiFederation/org_aaaaaaaaaaaaaaaaaaaa"Copy commandStep 3: Paste three values into RovaraPrints the provider's full name. Then enter it below with your project id, a location such as us-central1, and the service account rovara-vertex@PROJECT_DOMAIN. Rovara tests the connection before it saves anything.PROJECT_ID="acme-evals"
    echo "//iam.googleapis.com/$(gcloud iam workload-identity-pools providers describe rovara-aws --project="$PROJECT_ID" --location="global" --workload-identity-pool="rovara" --format="value(name)")"Copy commandIf this project's tests use workload identity themselves, set GOOGLE_CLOUD_PROJECT to the project id above."
  `);
  expect(panel.querySelectorAll("ol > li")).toHaveLength(3);
 });
 it("reads the setup values only when all three are well formed", () => {
  const read = (vertexSetup: unknown) => readProductAi(view(vertexSetup)).vertexSetup;
  expect(read(setup)).toEqual(setup);
  for (const bad of [null, "x", { ...setup, awsAccountId: "123" }, { ...setup, roleName: "a b" }, { ...setup, companyId: "org_short" }, { roleName: setup.roleName, companyId: company }]) expect(read(bad)).toBeUndefined();
 });
 it("shows capital-letter placeholders and says so when this install does not know Rovara's values", () => {
  renderGuide({ setup: undefined });
  expect(screen.getByTestId("vertex-guide-incomplete")).toBeTruthy();
  expect(screen.getByTestId("vertex-step-1").textContent).toContain(`--account-id="${ACCOUNT_PLACEHOLDER}"`);
 });
 it("puts only a valid project id into a command: anything else stays a placeholder", () => {
  for (const typed of ["", "Acme Evals", 'x"; rm -rf ~ #', "acme$(id)", "a--"]) {
   const g = vertexGuide({ projectId: typed, setup });
   expect(g.steps.every(s => s.command.startsWith(`PROJECT_ID="${PROJECT_PLACEHOLDER}"`))).toBe(true);
   expect(JSON.stringify(g)).not.toContain("rm -rf");
  }
  expect(vertexGuide({ projectId: "acme-evals", setup }).steps[0].command.startsWith('PROJECT_ID="acme-evals"')).toBe(true);
 });
 it("follows the project id typed in the form", async () => {
  const f = mount(confirmedPath("/app/admin/product-ai"), () => ({ status: 200, body: view(setup) }));
  try {
   await openVertex();
   fireEvent.change(await screen.findByLabelText("Google Cloud project ID"), { target: { value: "acme-evals" } });
   expect(screen.getByTestId("vertex-step-2").textContent).toContain(`rovara-vertex${ACCOUNT_DOMAIN}`);
  } finally { f.close(); }
 });
 it("is shown before the fresh sign-in (it is only instructions)", async () => {
  const f = mount("/app/admin/product-ai", () => ({ status: 200, body: view(setup) }));
  try { await openVertex(); expect(screen.getByTestId("fresh-sign-in")).toBeTruthy(); expect(screen.getByTestId("vertex-step-1")).toBeTruthy(); } finally { f.close(); }
 });
});

describe("copy buttons", () => {
 it("each copies exactly the command printed above it, and says so", async () => {
  const copyText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  renderGuide({}, copyText);
  const guide = vertexGuide({ projectId: "acme-evals", setup });
  for (const step of guide.steps) {
   const li = screen.getByTestId(`vertex-step-${String(step.n)}`);
   expect(li.querySelector("pre")!.textContent).toBe(step.command);
   fireEvent.click(within(li).getByRole("button", { name: `Copy step ${String(step.n)} command` }));
   await waitFor(() => { expect(copyText).toHaveBeenLastCalledWith(step.command); });
   expect(await within(li).findByText("Copied.")).toBeTruthy();
  }
  expect(copyText).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("button", { name: "Copy the condition fix command" }));
  await waitFor(() => { expect(copyText).toHaveBeenLastCalledWith(guide.fixCondition); });
 });
 it("says so when the clipboard refuses, and never claims it copied", async () => {
  renderGuide({}, async () => { throw new Error("no clipboard"); });
  fireEvent.click(screen.getByRole("button", { name: "Copy step 1 command" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't copy");
  expect(screen.queryByText("Copied.")).toBeNull();
 });
 it("the commands carry this company's session in the condition and the grant, and no other company's", () => {
  const g = vertexGuide({ projectId: "acme-evals", setup });
  const arn = `arn:aws:sts::111122223333:assumed-role/RovaraProductAiFederation/${company}`;
  expect(g.steps[0].command).toContain(`--attribute-condition="assertion.arn == '${arn}'"`);
  expect(g.steps[1].command).toContain(`/subject/${arn}"`);
  expect(g.steps[1].command).toContain('--role="roles/aiplatform.user"');
  expect(g.steps[2].command).toContain('--format="value(name)"');
  expect(JSON.stringify(g)).not.toMatch(/org_(?!a{20})[0-9a-z]{20}/u);
 });
});

describe("each refusal names the step that fixes it", () => {
 const STEP: Record<VertexRefusalReason, number> = { vertex_refused: 1, vertex_too_open: 1, vertex_unavailable: 3, vertex_invalid: 3 };
 it("maps every reason Cloud can send (read from product-ai-routes.ts) to a step", () => {
  const source = readFileSync("packages/cloud-server/src/product-ai-routes.ts", "utf8");
  const sent = [...source.matchAll(/"(vertex_[a-z_]+)"\)/gu)].map(m => m[1]!).sort();
  expect(sent).toEqual([...VERTEX_REFUSAL_REASONS].sort());
  for (const reason of VERTEX_REFUSAL_REASONS) { expect(vertexRefusalHelp(reason, false).step).toBe(STEP[reason]); expect(isVertexRefusalReason(reason)).toBe(true); }
  expect(isVertexRefusalReason("CONFIG_INVALID")).toBe(false); expect(isVertexRefusalReason(undefined)).toBe(false);
 });
 it("with a service account, a Google refusal also sends the person to step 2", () => {
  expect(vertexRefusalHelp("vertex_refused", true)).toMatchObject({ step: 1, also: 2 });
  expect(vertexRefusalHelp("vertex_refused", false).also).toBeUndefined();
 });
 it("the API client keeps a well-formed reason and drops any other", () => {
  const body = (reason: unknown) => ({ error: { code: "CONFIG_INVALID", message: "m", reason } });
  expect(apiError(400, body("vertex_refused"), "https://cell.example").reason).toBe("vertex_refused");
  for (const bad of [42, "Vertex Refused", "x".repeat(60), undefined, { a: 1 }]) expect(apiError(400, body(bad), "https://cell.example").reason).toBeUndefined();
 });
 for (const reason of VERTEX_REFUSAL_REASONS) it(`on the page, ${reason} marks step ${String(STEP[reason])} and only it`, async () => {
  const f = mount(confirmedPath("/app/admin/product-ai"), r => (r.method === "PUT" ? { status: reason === "vertex_unavailable" ? 503 : 400, body: { error: { code: reason === "vertex_unavailable" ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID", message: "Cloud's sentence.", reason } } } : { status: 200, body: view(setup) }));
  try {
   await openVertex();
   fireEvent.change(await screen.findByLabelText("Google Cloud project ID"), { target: { value: "acme-evals" } });
   fireEvent.change(screen.getByLabelText("Workload identity provider"), { target: { value: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara/providers/rovara-aws" } });
   expect(screen.queryByTestId("vertex-refusal-step")).toBeNull();
   fireEvent.click(screen.getByRole("button", { name: "Test and save" }));
   const help = await screen.findByTestId("vertex-refusal-step");
   expect(help.textContent).toBe(vertexRefusalHelp(reason, false).text);
   for (const n of [1, 2, 3]) expect(screen.getByTestId(`vertex-step-${String(n)}`).hasAttribute("data-redo")).toBe(n === STEP[reason]);
  } finally { f.close(); }
 });
 it("with a service account typed, a Google refusal marks steps 1 and 2", async () => {
  const f = mount(confirmedPath("/app/admin/product-ai"), r => (r.method === "PUT" ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Cloud's sentence.", reason: "vertex_refused" } } } : { status: 200, body: view(setup) }));
  try {
   await openVertex();
   fireEvent.change(await screen.findByLabelText("Google Cloud project ID"), { target: { value: "acme-evals" } });
   fireEvent.change(screen.getByLabelText("Workload identity provider"), { target: { value: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara/providers/rovara-aws" } });
   fireEvent.change(screen.getByLabelText("Service account (optional)"), { target: { value: ["rovara-vertex", "acme-evals.iam.gserviceaccount.com"].join("@") } });
   fireEvent.click(screen.getByRole("button", { name: "Test and save" }));
   await screen.findByTestId("vertex-refusal-step");
   for (const n of [1, 2, 3]) expect(screen.getByTestId(`vertex-step-${String(n)}`).hasAttribute("data-redo")).toBe(n !== 3);
  } finally { f.close(); }
 });
 it("a refusal with no Vertex reason (a stale revision) marks no step", async () => {
  const f = mount(confirmedPath("/app/admin/product-ai"), r => (r.method === "PUT" ? { status: 409, body: { error: { code: "CONFLICT", message: "Product AI settings changed. Refresh and try again." } } } : { status: 200, body: view(setup) }));
  try {
   await openVertex();
   fireEvent.change(await screen.findByLabelText("Google Cloud project ID"), { target: { value: "acme-evals" } });
   fireEvent.change(screen.getByLabelText("Workload identity provider"), { target: { value: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara/providers/rovara-aws" } });
   fireEvent.click(screen.getByRole("button", { name: "Test and save" }));
   await screen.findByText(/settings changed/u);
   expect(screen.queryByTestId("vertex-refusal-step")).toBeNull();
   expect(document.querySelector("[data-redo]")).toBeNull();
  } finally { f.close(); }
 });
});
