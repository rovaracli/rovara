// @vitest-environment jsdom
// V4 (experience lane: the old per-stage list is the `plainNotices: false` view, kept here; the new default is further down): when a stage ran on a model other than the one wanted, the Pipeline tab says so in fixed words: "Used X because Y was unavailable." Nothing shows without a fallback.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture as fixture } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { forceTaskPageFlags } from "../../packages/ui/src/screens/session/task-page-flags.js";
import { afterEach } from "vitest";
afterEach(() => forceTaskPageFlags(undefined));

/** The session as the server sends it: the task carries `modelFallbacks` and the whole fixture goes through the strict task and session view schemas. */
const withFallbacks = (modelFallbacks?: unknown) => fixture({}, modelFallbacks === undefined ? {} : { modelFallbacks });
function setup(value: unknown, theme: "light" | "dark" = "light", plain = false) {
 forceTaskPageFlags({ plainNotices: plain });
 const session = SessionViewReaderSchema.parse(value), f = fakeHost();
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session, onComment: () => undefined })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(RouterProvider, { router }) }), { theme });
 return { ...ui, close() { ui.unmount(); router.dispose(); } };
}
const notes = () => screen.queryByRole("region", { name: "Model changes" });

it("says which model a stage used and which one was unavailable", async () => {
 const f = setup(withFallbacks([{ stage: "build", used: "openai/gpt-5.5", wanted: "anthropic/claude-sonnet-5-5", reasonCode: "MODEL_NOT_VERIFIED" }]));
 const region = await screen.findByRole("region", { name: "Model changes" });
 expect(region.textContent).toContain("Build");
 expect(region.textContent).toContain("Used openai/gpt-5.5 because anthropic/claude-sonnet-5-5 was unavailable.");
 expect(region.textContent).not.toContain("MODEL_NOT_VERIFIED");
 await expectNoAxeViolations(f.container);
 f.close();
});
it("says the preferred model was unavailable when none is named", async () => {
 const f = setup(withFallbacks([{ stage: "code_review", used: "openai/gpt-5.5", wanted: null, reasonCode: "DEFAULT_MODEL_UNAVAILABLE" }]), "dark");
 const region = await screen.findByRole("region", { name: "Model changes" });
 expect(region.textContent).toContain("Code review");
 expect(region.textContent).toContain("Used openai/gpt-5.5 because the preferred model was unavailable.");
 f.close();
});
it("lists one line per stage, in the order given", async () => {
 const f = setup(withFallbacks([
  { stage: "plan", used: "m/a", wanted: "m/b", reasonCode: "MODEL_STALE" },
  { stage: "security_review", used: "m/c", wanted: null, reasonCode: "CONFIGURED_FALLBACK" },
 ]));
 const region = await screen.findByRole("region", { name: "Model changes" });
 const lines = Array.from(region.querySelectorAll("li")).map(item => item.textContent);
 expect(lines).toEqual(["Plan Used m/a because m/b was unavailable.", "Security review Used m/c because the preferred model was unavailable."]);
 f.close();
});
it("shows nothing for an empty list or a task without the field", async () => {
 for (const value of [withFallbacks([]), withFallbacks()]) {
  const f = setup(value);
  await screen.findByRole("region", { name: "Work progress" });
  expect(notes()).toBeNull();
  expect(f.container.textContent).not.toContain("was unavailable");
  f.close();
 }
});
it("is refused by the strict task view when an entry is malformed, so the screen never sees one", () => {
 const bad = [{ stage: "build", used: 7, wanted: null, reasonCode: "MODEL_STALE" }, { stage: "build", used: "m/a", wanted: null, reasonCode: "raw provider exception" }, { stage: "build", used: "m/a", wanted: "m/\u0007b", reasonCode: "MODEL_STALE" }];
 for (const entry of bad) expect(() => withFallbacks([entry])).toThrow();
 expect(() => withFallbacks("nope")).toThrow();
 expect(() => withFallbacks(Array(65).fill({ stage: "build", used: "m/a", wanted: null, reasonCode: "MODEL_STALE" }))).toThrow();
});
it("shows hostile model text as plain text: no markup", async () => {
 const hostile = "x<img src=x onerror=window.__pwned=1>y";
 const f = setup(withFallbacks([{ stage: "build", used: hostile, wanted: "w" + hostile, reasonCode: "MODEL_STALE" }]));
 const region = await screen.findByRole("region", { name: "Model changes" });
 expect(region.querySelector("img,b,script")).toBeNull();
 expect(region.textContent).toContain("Used " + hostile + " because w" + hostile + " was unavailable.");
 expect("__pwned" in window).toBe(false);
 f.close();
});

// Experience lane, task page: with `plainNotices` (the default) the same notes read as one plain line; the raw model ids and the repeats sit behind "Details".
const opus = "amazon-bedrock/us.anthropic.claude-opus-5-5", haiku = "amazon-bedrock/us.anthropic.claude-haiku-4-5";
const note = { stage: "plan_check", used: haiku, wanted: opus, reasonCode: "MODEL_NOT_VERIFIED" };
it("shows three repeated notices as one plain line with no model id visible, and the ids behind Details", async () => {
 const f = setup(withFallbacks([note, note, note]), "light", true);
 const region = await screen.findByRole("region", { name: "Model changes" });
 const line = region.querySelector(".rv-model-fallback-line")!;
 expect(line.textContent).toBe("Used a different model for plan check: Opus unavailable.");
 expect(region.querySelectorAll("p")).toHaveLength(1);
 const details = region.querySelector("details")!;
 expect(details.open).toBe(false);
 expect(details.querySelector("summary")!.textContent).toBe("Details");
 const rows = Array.from(details.querySelectorAll("li")).map(item => item.textContent);
 expect(rows).toEqual([`Plan check Used ${haiku} because ${opus} was unavailable. (recorded 3 times)`]);
 expect(Array.from(region.children).filter(child => child.tagName !== "DETAILS").map(child => child.textContent).join(" ")).not.toMatch(/amazon|bedrock|claude/u);
 expect(region.textContent).not.toContain("MODEL_NOT_VERIFIED");
 await expectNoAxeViolations(f.container);
 f.close();
});
it("opens Details to the raw ids on a click", async () => {
 const f = setup(withFallbacks([note]), "dark", true);
 const summary = await screen.findByText("Details");
 summary.click();
 expect((summary.closest("details") as HTMLDetailsElement).open).toBe(true);
 f.close();
});
it("keeps hostile model text inert in the details", async () => {
 const hostile = "x<img src=x onerror=window.__pwned=1>y";
 const f = setup(withFallbacks([{ stage: "build", used: hostile, wanted: "w" + hostile, reasonCode: "MODEL_STALE" }]), "light", true);
 const region = await screen.findByRole("region", { name: "Model changes" });
 expect(region.querySelector("img,b,script")).toBeNull();
 expect(region.querySelector("details")!.textContent).toContain("Used " + hostile);
 f.close();
});
