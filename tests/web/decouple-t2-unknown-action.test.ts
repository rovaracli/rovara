// @vitest-environment jsdom
// DECOUPLE T2: the session's `you.actions` is a permission-ish display list. An action a newer Code adds reads as "unknown" and shows no button (the page only draws a button for a word it knows).
import { expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { meFixture } from "./support/fixtures.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

function controlsFor(actions: readonly string[]) {
  const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : { status: 404, body: { error: { code: "NOT_FOUND", message: "none" } } });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Agent", actions, following: false, onChanged: async () => undefined }) }) }));
  return { ui, close: () => { ui.unmount(); query.clear(); } };
}

const readActions = (actions: string[]) => SessionViewReaderSchema.parse({ ...sessionFixture(), you: { ...sessionFixture().you, actions } }).you.actions;

it("an action a newer Code adds reads as unknown and the page draws no control for it", () => {
  const read = readActions(["watch", "teleport_task"]);
  expect(read).toEqual(["watch", "unknown"]);
  const only = controlsFor(readActions(["teleport_task", "delete_everything"]));
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  only.close();
  const mixed = controlsFor(read);
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Follow"]);
  expect(screen.queryByText(/unknown|teleport/iu)).toBeNull();
  mixed.close();
});

it("an unknown access level is read as unknown and is never a known level", () => {
  const read = SessionViewReaderSchema.parse({ ...sessionFixture(), you: { ...sessionFixture().you, level: "superuser" } });
  expect(read.you.level).toBe("unknown");
  expect(["use", "edit"]).not.toContain(read.you.level);
});
