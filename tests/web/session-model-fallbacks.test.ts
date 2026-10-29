// @vitest-environment jsdom
// V4: when a stage ran on a model other than the one wanted, the Pipeline tab says so in fixed words: "Used X because Y was unavailable." Nothing shows without a fallback.
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

/** The session as lane C's view will send it: the task carries `modelFallbacks` (strict contracts do not know it on this branch yet, so it is added after the fixture parses). */
function withFallbacks(modelFallbacks: unknown, present = true) {
 const base = fixture();
 if (base.body.kind !== "task") throw new Error("fixture must be a task");
 return { ...base, body: { kind: "task", task: present ? { ...base.body.task, modelFallbacks } : base.body.task } };
}
function setup(value: unknown, theme: "light" | "dark" = "light") {
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
 const f = setup(withFallbacks([{ stage: "code_review", used: "openai/gpt-5.5", wanted: null, reasonCode: "DEFAULT_MODEL_UNAVAILABLE" }], true), "dark");
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
it("shows nothing for an empty list, a missing field, or a field of the wrong shape", async () => {
 for (const value of [withFallbacks([]), withFallbacks(undefined, false), withFallbacks("nope"), withFallbacks([{ stage: "build", used: 7, wanted: null }])]) {
  const f = setup(value);
  await screen.findByRole("region", { name: "Work progress" });
  expect(notes()).toBeNull();
  expect(f.container.textContent).not.toContain("was unavailable");
  f.close();
 }
});
it("keeps one bad entry from hiding the good ones", async () => {
 const f = setup(withFallbacks([{ stage: "build", used: 7, wanted: null }, { stage: "plan", used: "m/a", wanted: "m/b", reasonCode: "MODEL_STALE" }]));
 const region = await screen.findByRole("region", { name: "Model changes" });
 expect(region.querySelectorAll("li")).toHaveLength(1);
 expect(region.textContent).toContain("Used m/a because m/b was unavailable.");
 f.close();
});
it("shows hostile model text as plain text: no markup and no control characters", async () => {
 const hostile = "x<img src=x onerror=window.__pwned=1>‮\u0007y";
 const f = setup(withFallbacks([{ stage: "<b>build</b>", used: hostile, wanted: hostile, reasonCode: "MODEL_STALE" }]));
 const region = await screen.findByRole("region", { name: "Model changes" });
 expect(region.querySelector("img,b,script")).toBeNull();
 expect(region.textContent).toContain("x<img src=x onerror=window.__pwned=1>[U+202E][U+0007]y");
 expect(region.textContent).not.toContain("‮");
 expect(region.textContent).not.toContain("\u0007");
 expect("__pwned" in window).toBe(false);
 f.close();
});
