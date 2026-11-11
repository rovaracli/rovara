// @vitest-environment jsdom
// F5: the setup screen shows what a stopped run had, read-only, marked "Stopped by <person>", with no way to use or apply it.
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { sanitizeSetupProposal } from "@rovara-code/contracts";
import type { SetupAgentView } from "@agentx/cloud-contracts/web";
import { PartialProposal } from "../../packages/ui/src/screens/setup/PartialProposal.js";
import { renderUi } from "./support/render.js";

const read = sanitizeSetupProposal({ setup: [{ repo: "web", commands: ["npm ci"], confidence: "medium", from: [{ kind: "inferred", repo: "web", note: "worked when run" }] }], tests: [{ repo: "web", commands: ["npm test"], from: [{ kind: "inferred", repo: "web", note: "worked when run" }] }], notes: "" }, { basedOnRevision: 1, repositories: [{ name: "web" }] });
if (!read.ok) throw new Error("fixture");
const view = (over: Partial<SetupAgentView> = {}): SetupAgentView & { proposal: NonNullable<SetupAgentView["proposal"]>; stoppedBy: NonNullable<SetupAgentView["stoppedBy"]> } => ({
  status: "failed", basedOnRevision: 1, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, stop: "stopped_by_person", proposal: read.proposal,
  stoppedBy: { name: "Maya Chen", at: "2026-11-02T10:00:00.000Z" }, verification: { "setup-web": "verified" }, verified: true, ...over,
} as never);

it("says who stopped the run and shows what it had, with its checks and the rule that it is unproven and not applied", () => {
  renderUi(h(PartialProposal, { view: view() }));
  expect(screen.getByText(/What Rovara had when it was stopped/u)).toBeTruthy();
  expect(screen.getByText(/Stopped by/u).textContent).toContain("Maya Chen");
  expect(screen.getByText("npm ci")).toBeTruthy();
  expect(screen.getByText("npm test")).toBeTruthy();
  expect(screen.getByText("Matches the code")).toBeTruthy();
  expect(screen.getByText(/not proven and nothing was applied/u)).toBeTruthy();
});

it("offers no way to use it: no button and no tick box", () => {
  renderUi(h(PartialProposal, { view: view() }));
  expect(screen.queryAllByRole("button")).toEqual([]);
  expect(screen.queryAllByRole("checkbox")).toEqual([]);
  expect(screen.queryByText(/Use this setup/u)).toBeNull();
});

it("shows a person's name as plain text, never as markup", () => {
  renderUi(h(PartialProposal, { view: view({ stoppedBy: { name: "<img src=x onerror=alert(1)>", at: "2026-11-02T10:00:00.000Z" } }) }));
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText(/Stopped by/u).textContent).toContain("<img");
});
