// @vitest-environment jsdom
// Lead 4 Opus delta review (G1 4d471fbd4): an identity re-check that begins while a pressed action waits for the settings re-read drops the press (zero sends).
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ApiRequest, ApiResponse } from "../../../../packages/ui/src/host.js";
import { mount } from "./mount.js";
import { identity, pendingSettings, reply } from "./fixtures.js";

const SETTINGS = "/v1/app/org/settings";
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const writes = (app: { request: { mock: { calls: readonly (readonly [ApiRequest])[] } } }) => app.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");

it("Approve pressed during a settings re-read sends NOTHING when an identity re-check began before that read answered", async () => {
 const app = await mount("/app/admin/settings", r => (r.method !== "GET" ? ok({}) : r.path.split("?")[0] === SETTINGS ? ok(pendingSettings) : reply(r)));
 const respond = app.request.getMockImplementation()!;
 await screen.findByText("Review every change");
 let holdSettings = false, holdMe = false, releaseSettings: ((r: ApiResponse) => void) | undefined, releaseMe: ((r: ApiResponse) => void) | undefined;
 app.request.mockImplementation(async r => (holdSettings && r.method === "GET" && r.path.split("?")[0] === SETTINGS ? new Promise<ApiResponse>(done => { holdSettings = false; releaseSettings = done; })
  : holdMe && r.path === "/v1/app/me" ? new Promise<ApiResponse>(done => { holdMe = false; releaseMe = done; }) : respond(r)));
 holdSettings = true;
 fireEvent.click(await screen.findByRole("button", { name: "Read company settings again" }));
 await waitFor(() => expect(releaseSettings).toBeDefined());
 fireEvent.click(screen.getByRole("button", { name: "Approve this change" }));
 holdMe = true;
 await act(async () => { void app.query.refetchQueries({ queryKey: ["admin", "identity"] }); });
 await waitFor(() => expect(releaseMe).toBeDefined());
 await act(async () => { releaseSettings!(ok(pendingSettings)); });
 await new Promise(resolve => setTimeout(resolve, 30));
 expect(writes(app)).toHaveLength(0);
 await act(async () => { releaseMe!(ok(identity)); });
 await new Promise(resolve => setTimeout(resolve, 30));
 expect(writes(app)).toHaveLength(0);
 app.close();
});
