// @vitest-environment jsdom
// Opus N3 (DEC 540): an agent draft that holds a thinking level (reasoning effort) a newer Code added can be read, but this build cannot edit or save it. The page says so, in plain words, and sends nothing.
import { afterEach, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderBuilder } from "./support/builder-render.js";
import { builderFixture } from "./support/builder-fixture.js";

afterEach(cleanup);
it("a draft with a thinking level this build does not know says it cannot be edited here and why, and sends no write", async () => {
  const base = builderFixture();
  const draft = { ...base, draft: { ...base.draft, overlay: { steps: { build: { instructions: "Keep it short", thinkingLevel: "turbo-from-a-newer-code" } } } } } as unknown as ReturnType<typeof builderFixture>;
  const f = renderBuilder({ draft });
  expect((await screen.findByRole("alert")).textContent).toBe("This draft uses a newer format. Refresh before editing.");
  expect(screen.queryByText(/^Draft · revision/u)).toBeNull();
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
});

it("a RESOLVED recipe (the base or the current steps) that holds a thinking level this build does not know says so instead of showing an empty step list", async () => {
  const base = builderFixture();
  const steps = (base.resolved as unknown as { steps: Array<{ settings: Record<string, unknown> }> }).steps.map((step, index) => index === 0 ? { ...step, settings: { ...step.settings, thinkingLevel: "turbo-from-a-newer-code" } } : step);
  const draft = { ...base, resolved: { ...base.resolved, steps } } as unknown as ReturnType<typeof builderFixture>;
  const f = renderBuilder({ draft });
  expect((await screen.findByRole("alert")).textContent).toBe("This agent uses a setting from a newer version of Rovara that this page can't edit (for example a reasoning effort it doesn't know). Nothing was changed. Refresh before editing.");
  expect(screen.queryByText(/^Draft · revision/u)).toBeNull();
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
});

it("control: a known resolved recipe opens the editor and lists its steps", async () => {
  renderBuilder({});
  expect(await screen.findByText(/^Draft · revision/u)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
