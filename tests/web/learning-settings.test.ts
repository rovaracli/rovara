// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { LearningProposalDecisionBodySchema, LearningSettingsBodySchema } from "@agentx/cloud-contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { LEARNING_PATH, learningHost, learningView } from "./support/learning-fixture.js";

const SETTINGS = LEARNING_PATH + "/settings", DECIDE = SETTINGS + "/proposals/prop_1/decide";
type Options = Parameters<typeof learningHost>[0];
function setup(options: Options = {}) {
 const cell = learningHost(options), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }));
 return { ...cell, ...ui, query };
}
const view = (settings: Record<string, unknown>, rest: Record<string, unknown> = {}) => learningView({ settings: { prComments: "off", locked: false, revision: 3, ...settings }, ...rest });
const open = async (options: Options = {}) => { const world = setup(options);await screen.findByText("Learn from PR review comments");return world; };
const ok = (body: unknown, status = 200) => ({ status, body });
const refuse = (code: string, message: string, status = 409) => ({ status, body: { error: { code, message } } });
const writes = (f: ReturnType<typeof setup>) => f.learningWrites().filter(request => request.path.includes("/settings"));
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>("button", { name });
const SOLE = "I'm the only person who can approve this (an audited exception)";
const HELP = "Off by default. Turning it on needs a second person; turning it off applies at once.";

afterEach(() => { document.body.innerHTML = ""; });

describe("the Learn from PR review comments setting", () => {
 it("off: states it, offers Turn on and sends the exact body, then shows the waiting copy and reads again", async () => {
  const f = await open({ view: view({}), learn: async (request, url) => { if (request.method === "PUT" && url.pathname === SETTINGS) { f.learning.view = view({ pendingProposal: { id: "prop_1" } });return ok({ applied: false, proposalId: "prop_1" }); } return undefined; } });
  expect(screen.getByText(HELP)).toBeTruthy();
  expect(screen.getByText("Status: Off")).toBeTruthy();
  const reads = f.learningReads();
  fireEvent.click(button("Turn on…"));
  await screen.findByText("Turning on is waiting for a second person");
  expect(writes(f)).toHaveLength(1);
  expect(writes(f)[0]).toMatchObject({ method: "PUT", path: SETTINGS, body: LearningSettingsBodySchema.parse({ expectedRevision: 3, prComments: "on" }) });
  await waitFor(() => expect(f.learningReads()).toBe(reads + 1));
  // The re-read brings the pending line; the one-off waiting line is then gone, so only one waiting line shows.
  expect(screen.queryByText("Waiting for a second person to approve")).toBeNull();
  expect(screen.getAllByRole("status")).toHaveLength(1);
 });
 it("Turn on shows the waiting line when the re-read does not yet show a proposal", async () => {
  const f = await open({ view: view({}), learn: async (request, url) => request.method === "PUT" && url.pathname === SETTINGS ? ok({ applied: false, proposalId: "prop_1" }) : undefined });
  fireEvent.click(button("Turn on…"));
  await screen.findByText("Waiting for a second person to approve");
  expect(writes(f)).toHaveLength(1);
 });
 it("on: states it and Turn off sends off, then reads again", async () => {
  const f = await open({ view: view({ prComments: "on" }), learn: async (request, url) => { if (request.method === "PUT" && url.pathname === SETTINGS) { f.learning.view = view({});return ok({ applied: true, settings: { prComments: "off", locked: false, revision: 4 } }); } return undefined; } });
  expect(screen.getByText("Status: On")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on…" })).toBeNull();
  const reads = f.learningReads();
  fireEvent.click(button("Turn off"));
  await waitFor(() => expect(f.learningReads()).toBe(reads + 1));
  expect(writes(f)[0]!.body).toEqual({ expectedRevision: 3, prComments: "off" });
  await screen.findByText("Status: Off");
 });
 it("locked by the company: off and disabled, no buttons", async () => {
  await open({ view: view({ prComments: "off", locked: true, lockedBy: "company" }) });
  expect(screen.getByText("Your company has turned this off.")).toBeTruthy();
  expect(screen.getByText("Status: Off")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Turn on|Turn off|Approve|Decline/u })).toBeNull();
 });
 it("locked hides a pending proposal's buttons too", async () => {
  await open({ view: view({ prComments: "off", locked: true, lockedBy: "company", pendingProposal: { id: "prop_1" } }) });
  expect(screen.queryByRole("button", { name: /Approve|Decline/u })).toBeNull();
 });
 it("pending with an expiry: says who it waits for and when it expires", async () => {
  await open({ view: view({ pendingProposal: { id: "prop_1", expiresAt: "2026-10-31T10:00:00.000Z" } }) });
  expect(screen.getByText("Turning on is waiting for a second person")).toBeTruthy();
  expect(screen.getByText(/^Expires /u)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on…" })).toBeNull();
  expect(button("Approve")).toBeTruthy();
  expect(button("Decline")).toBeTruthy();
 });
 it("pending without an expiry: no Expires line", async () => {
  await open({ view: view({ pendingProposal: { id: "prop_1" } }) });
  expect(screen.getByText("Turning on is waiting for a second person")).toBeTruthy();
  expect(screen.queryByText(/^Expires /u)).toBeNull();
 });
 it("Approve and Decline send the exact path and body, with the acknowledgement only when ticked", async () => {
  const f = await open({ view: view({ pendingProposal: { id: "prop_1" } }), learn: async (request, url) => request.method === "POST" && url.pathname === DECIDE ? ok({ settings: { prComments: "on", locked: false, revision: 4 } }) : undefined });
  fireEvent.click(button("Approve"));
  await waitFor(() => expect(writes(f)).toHaveLength(1));
  expect(writes(f)[0]).toMatchObject({ method: "POST", path: DECIDE, body: LearningProposalDecisionBodySchema.parse({ decision: "approve" }) });
  expect("soleOwnerAcknowledged" in (writes(f)[0]!.body as object)).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: SOLE }));
  fireEvent.click(button("Approve"));
  await waitFor(() => expect(writes(f)).toHaveLength(2));
  expect(writes(f)[1]!.body).toEqual({ decision: "approve", soleOwnerAcknowledged: true });
  const box = screen.getByRole<HTMLInputElement>("checkbox", { name: SOLE });
  await waitFor(() => expect(box.checked).toBe(false));
  fireEvent.click(button("Decline"));
  await waitFor(() => expect(writes(f)).toHaveLength(3));
  expect(writes(f)[2]).toMatchObject({ path: DECIDE, body: { decision: "decline" } });
  expect("soleOwnerAcknowledged" in (writes(f)[2]!.body as object)).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: SOLE }));
  fireEvent.click(button("Decline"));
  await waitFor(() => expect(writes(f)).toHaveLength(4));
  expect(writes(f)[3]).toMatchObject({ path: DECIDE, body: { decision: "decline", soleOwnerAcknowledged: true } });
 });
 it("a decision re-reads the learning view", async () => {
  const f = await open({ view: view({ pendingProposal: { id: "prop_1" } }), learn: async (request, url) => { if (request.method === "POST" && url.pathname === DECIDE) { f.learning.view = view({ prComments: "on" });return ok({ settings: { prComments: "on", locked: false, revision: 4 } }); } return undefined; } });
  fireEvent.click(button("Approve"));
  await screen.findByText("Status: On");
 });
 it("a FORBIDDEN refusal is shown as plain text and the person can tick the box and try again", async () => {
  const message = "Needs the only-owner acknowledgement <img src=x onerror=alert(1)>";
  let calls = 0;
  const f = await open({ view: view({ pendingProposal: { id: "prop_1" } }), learn: async (request, url) => { if (request.method === "POST" && url.pathname === DECIDE) { calls += 1;return calls === 1 ? refuse("FORBIDDEN", message, 403) : ok({ settings: { prComments: "on", locked: false, revision: 4 } }); } return undefined; } });
  fireEvent.click(button("Approve"));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(message);
  expect(alert.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: SOLE }));
  fireEvent.click(button("Approve"));
  await waitFor(() => expect(writes(f)).toHaveLength(2));
  expect(writes(f)[1]!.body).toEqual({ decision: "approve", soleOwnerAcknowledged: true });
 });
 it("CHANGE_STALE says so and reads again", async () => {
  const f = await open({ view: view({}), learn: async (request, url) => request.method === "PUT" && url.pathname === SETTINGS ? refuse("CHANGE_STALE", "Learning settings changed. Refresh before deciding.") : undefined });
  const reads = f.learningReads();
  fireEvent.click(button("Turn on…"));
  await screen.findByText("Someone else changed this. The setting was refreshed.");
  await waitFor(() => expect(f.learningReads()).toBe(reads + 1));
 });
 it("TOO_MANY_REQUESTS shows its words and is not retried", async () => {
  const f = await open({ view: view({}), learn: async (request, url) => request.method === "PUT" && url.pathname === SETTINGS ? refuse("TOO_MANY_REQUESTS", "Too many learning setting requests. Try again in a minute.", 429) : undefined });
  // The client's own retry would wait about a second; fake timers run past it so a retry, if there were one, would be seen.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
   fireEvent.click(button("Turn on…"));
   await screen.findByText("Too many changes. Try again in a minute.");
   await vi.advanceTimersByTimeAsync(10_000);
   expect(writes(f)).toHaveLength(1);
  } finally { vi.useRealTimers(); }
 });
 it("a double click sends one request", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await open({ view: view({}), learn: async (request, url) => { if (request.method === "PUT" && url.pathname === SETTINGS) { await gate;return ok({ applied: false, proposalId: "prop_1" }); } return undefined; } });
  const turnOn = button("Turn on…");
  fireEvent.click(turnOn);fireEvent.click(turnOn);
  expect(turnOn.disabled).toBe(true);
  release();
  await screen.findByText("Waiting for a second person to approve");
  expect(writes(f)).toHaveLength(1);
 });
 it("on, with PR comments skipped: says how many, in the singular and plural", async () => {
  await open({ view: view({ prComments: "on" }, { skippedUnlinked: 1 }) });
  expect(screen.getByText("1 PR comment skipped because the author's GitHub account isn't linked to Rovara.")).toBeTruthy();
 });
 it("on, with several skipped", async () => {
  await open({ view: view({ prComments: "on" }, { skippedUnlinked: 3 }) });
  expect(screen.getByText("3 PR comments skipped because the author's GitHub account isn't linked to Rovara.")).toBeTruthy();
 });
 it("off, the skipped line is not shown", async () => {
  await open({ view: view({}, { skippedUnlinked: 3 }) });
  expect(screen.queryByText(/skipped because/u)).toBeNull();
 });
 it("without canDecide: the state is read-only with the maintainer note", async () => {
  await open({ view: view({ pendingProposal: { id: "prop_1" } }, { canDecide: false }) });
  expect(screen.getByText("Turning on is waiting for a second person")).toBeTruthy();
  expect(screen.getByText("Only a project maintainer can change this.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Turn on|Turn off|Approve|Decline/u })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: SOLE })).toBeNull();
 });
 it("a missing revision offers no write", async () => {
  await open({ view: view({ revision: undefined }) });
  expect(screen.getByText("Status: Off")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Turn on|Turn off/u })).toBeNull();
 });
});
