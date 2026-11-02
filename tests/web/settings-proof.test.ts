// @vitest-environment jsdom
// TE-4: the Setup step says whether the commands in the settings are Proven, Checking or Unproven; a saved change that failed its check shows the notice and, when something was ever proved, one button back to it;
// a change an API key asked for is shown as held. The server decides who may go back; the page only asks and says why when it is refused.
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AppProjectDetail } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { SettingsProofSection } from "../../packages/ui/src/screens/onboarding/steps/SettingsProofSection.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const base = (proof: Record<string, unknown> | undefined, myRole = "maintainer"): AppProjectDetail => ({
  name: "web", description: "Customer fixes", status: "active", latestRevision: 3, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole,
  setup: { status: "ready" }, settings: { setupCommands: ["npm ci"], testCommands: ["npm test"], devcontainer: null, allowedDomains: [] },
  createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" }, ...(proof === undefined ? {} : { settingsProof: proof }),
}) as unknown as AppProjectDetail;

function mount(project: AppProjectDetail, reply: { status: number; body: unknown } = { status: 200, body: { project: base({ status: "proven", canUndo: false, provenAt: "2026-11-02T10:00:00.000Z" }), warnings: [] } }) {
  const f = fakeHost(async () => reply);
  const onProject = vi.fn();
  const query = createQueryClient();
  const view = renderUi(h(QueryClientProvider, { client: query }, h(AppHostProvider, { host: f.host, children: h(SettingsProofSection, { project, onProject }) })));
  return { ...f, ...view, onProject };
}
const FAILED = { status: "unproven", canUndo: true, reason: "test: npm test - 3 tests failed", lastProvenAt: "2026-11-01T10:00:00.000Z", notice: { message: "These commands did not pass the check on a fresh machine. You can go back to the last setup that passed.", at: "2026-11-02T10:00:00.000Z", savedBy: "Maya" } };

it("says Proven, Checking or Unproven, with the reason", async () => {
  for (const [proof, word] of [[{ status: "proven", canUndo: false }, "Proven"], [{ status: "checking", canUndo: false }, "Checking"], [{ status: "unproven", canUndo: false, reason: "These commands have not been checked yet." }, "Unproven"]] as const) {
    const view = mount(base(proof));
    expect((await screen.findByRole("status")).textContent).toContain(word);
    view.unmount();
  }
});

it("shows nothing where the server says nothing about proof", () => {
  const view = mount(base(undefined));
  expect(view.container.textContent).toBe("");
});

it("a failed check shows the notice and the way back; the press sends the revision the person saw, and the page takes the answer", async () => {
  const view = mount(base(FAILED));
  expect((await screen.findByRole("alert")).textContent).toContain("go back to the last setup that passed");
  expect(screen.getByRole("status").textContent).toContain("npm test");
  fireEvent.click(screen.getByRole("button", { name: "Undo to the last proven setup" }));
  await waitFor(() => { expect(view.onProject).toHaveBeenCalled(); });
  const sent = view.request.mock.calls.map(([request]) => request).find((request) => request.method === "POST")!;
  expect(sent.path).toBe("/v1/app/projects/web/settings/undo");
  expect(sent.body).toMatchObject({ expectedRevision: 3 });
  await expectNoAxeViolations(document.body);
});

it("offers no way back when nothing was ever proved, or to someone who cannot change settings", () => {
  const nothing = mount(base({ ...FAILED, canUndo: false, lastProvenAt: undefined, notice: { ...FAILED.notice, message: "No earlier setup was ever proved, so there is nothing to go back to." } }));
  expect(screen.queryByRole("button", { name: "Undo to the last proven setup" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("nothing to go back to");
  nothing.unmount();
  mount(base(FAILED, "contributor"));
  expect(screen.queryByRole("button", { name: "Undo to the last proven setup" })).toBeNull();
});

it("asks for a new sign-in when the server says the sign-in is too old", async () => {
  const view = mount(base(FAILED), { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to go back to the last proved setup." } } });
  fireEvent.click(await screen.findByRole("button", { name: "Undo to the last proven setup" }));
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(view.host.signIn).toHaveBeenCalled();
  expect(view.onProject).not.toHaveBeenCalled();
});

it("shows a change an API key asked for as held, not as saved", async () => {
  mount(base({ status: "proven", canUndo: false, held: { status: "checking", fields: ["setupCommands"], heldAt: "2026-11-02T10:00:00.000Z" } }));
  expect((await screen.findAllByRole("status")).map((node) => node.textContent).join(" ")).toContain("It is not in the settings yet");
  mount(base({ status: "proven", canUndo: false, held: { status: "failed", fields: ["setupCommands"], heldAt: "2026-11-02T10:00:00.000Z", reason: "setup: npm ci - exit 1" } }), undefined);
  expect((await screen.findAllByText(/did not pass its check, so it was not saved/)).length).toBeGreaterThan(0);
});
