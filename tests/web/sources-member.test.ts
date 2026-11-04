// @vitest-environment jsdom
// T5: a member keeps the read-only Sources tab, and the editing chunk is never loaded for them.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { refusal, source, sources } from "./support/lessons-fixture.js";
import { adminView, flat } from "./support/sources-fixture.js";
import { openSources } from "./support/sources-render.js";

const chunk = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../../packages/ui/src/screens/project/lessons/SourcesAdmin.js", async importOriginal => { chunk.loads += 1;return await importOriginal(); });

describe("the Sources tab for a person who cannot edit", () => {
 it("a member sees the read-only list and nothing asks for the editors' view or loads the editing screen", async () => {
  const f = openSources({ canEdit: false, view: adminView(), readable: sources({ sources: [source()] }) });
  const list = await screen.findByRole("list", { name: "Sources" });
  expect(list).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  expect(screen.queryByText("Add a source")).toBeNull();
  expect(f.recordCalls()).toHaveLength(0);
  expect(chunk.loads).toBe(0);
 });
 it("with the team record off (the lessons sources read answers not found) a maintainer never asks for the editors' view, and sees the same tab as before this lane", async () => {
  const f = openSources({ lessonsSources: refusal("NOT_FOUND", "The team record isn't set up here.", 404) });
  expect(await screen.findByText("The team record isn't set up here yet.")).toBeTruthy();
  expect(f.recordCalls()).toHaveLength(0);
  expect(chunk.loads).toBe(0);
 });
 it("a maintainer whose record route is absent keeps the read-only list and no editing screen", async () => {
  const f = openSources({ adminRead: refusal("NOT_FOUND", "Not found.", 404) });
  await screen.findByText("No source feeds the team record for this project yet.");
  expect(f.recordReads()).toHaveLength(1);
  expect(screen.queryByText("Add a source")).toBeNull();
  expect(chunk.loads).toBe(0);
 });
 it("an editors' view that says canEdit is false stays the read-only tab and never loads the editing screen", async () => {
  const f = openSources({ view: adminView({ canEdit: false }), readable: sources({ sources: [source()] }) });
  expect(await screen.findByRole("list", { name: "Sources" })).toBeTruthy();
  expect(f.recordReads()).toHaveLength(1);
  expect(screen.queryByText("Add a source")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  expect(chunk.loads).toBe(0);
 });
 it("a maintainer without a live browser session gets the members' reply, which stays the read-only tab with a fixed note and no server text", async () => {
  // The route's reply for anyone but an editor in a live browser session: rows without the editors' fields.
  openSources({ adminRead: { status: 200, body: { sources: [{ kind: "github", scope: "github:repo/9", enabled: true, retention: "C", health: "ok", audience: "project", updatedAt: "2026-10-30T10:00:00.000Z", paused: false }], otherPaused: 0 } } });
  expect(await screen.findByText("Changing sources isn't available to you right now.")).toBeTruthy();
  expect(screen.queryByText("Add a source")).toBeNull();
  expect(chunk.loads).toBe(0);
 });
 it("a refusal of the editors' view (503) leaves the read-only tab, says editing is unavailable, and never shows the server's words", async () => {
  openSources({ adminRead: flat("RUNTIME_UNAVAILABLE", "private upstream detail", 503) });
  expect(await screen.findByText("Changing sources isn't available to you right now.")).toBeTruthy();
  expect(screen.queryByText(/private upstream detail/u)).toBeNull();
  expect(chunk.loads).toBe(0);
 });
});

describe("T8: learning is off for the project", () => {
 const LEARNING_OFF = "Learning is off for this project, so Rovara isn't recording anything from these sources. Turn learning on to add or change sources.";
 it("a member sees the learning-off line, not 'isn't set up'", async () => {
  const f = openSources({ canEdit: false, lessonsSources: refusal("LEARNING_OFF", "Learning is off for this project.", 404) });
  expect(await screen.findByText(LEARNING_OFF)).toBeTruthy();
  expect(screen.queryByText(/isn't set up/u)).toBeNull();
  expect(screen.queryByRole("button", { name: "Add source" })).toBeNull();
  expect(f.recordCalls()).toHaveLength(0);
  expect(chunk.loads).toBe(0);
 });
 it("an editor sees the same line, and the editing screen is not loaded or asked for", async () => {
  const f = openSources({ lessonsSources: refusal("LEARNING_OFF", "Learning is off for this project.", 404) });
  expect(await screen.findByText(LEARNING_OFF)).toBeTruthy();
  expect(screen.queryByText(/isn't set up/u)).toBeNull();
  expect(screen.queryByText("Add a source")).toBeNull();
  expect(f.recordCalls()).toHaveLength(0);
  expect(chunk.loads).toBe(0);
 });
 it("the team record switch off (plain not found) still says the record isn't set up and makes no record request", async () => {
  const f = openSources({ lessonsSources: refusal("NOT_FOUND", "The team record isn't set up here.", 404) });
  expect(await screen.findByText("The team record isn't set up here yet.")).toBeTruthy();
  expect(screen.queryByText(/Learning is off/u)).toBeNull();
  expect(f.recordCalls()).toHaveLength(0);
 });
 it("a company lock gives its own line, with the existing company wording", async () => {
  const f = openSources({ lessonsSources: refusal("LEARNING_LOCKED", "Learning is off for this project because of a company setting.", 404) });
  expect(await screen.findByText("Learning is off for this project. Your company set this to be stricter than the project's own choice.")).toBeTruthy();
  expect(screen.queryByText(/Turn learning on/u)).toBeNull();
  expect(screen.queryByText(/isn't set up/u)).toBeNull();
  expect(f.recordCalls()).toHaveLength(0);
 });
 it("a setting that could not be read says so and offers Retry, which asks again (it is not 'learning is off')", async () => {
  const f = openSources({ lessonsSources: refusal("RUNTIME_UNAVAILABLE", "private upstream detail", 503) });
  expect(await screen.findByText("Couldn't load the sources. Try again.", {}, { timeout: 8000 })).toBeTruthy();
  expect(screen.queryByText(/Learning is off/u)).toBeNull();
  expect(screen.queryByText(/private upstream detail/u)).toBeNull();
  const asked = () => f.request.mock.calls.map(([request]) => request).filter(request => request.path.split("?")[0]!.endsWith("/lessons/sources")).length;
  const before = asked();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => { expect(asked()).toBeGreaterThan(before); }, { timeout: 8000 });
  expect(f.recordCalls()).toHaveLength(0);
 }, 20_000);
});
