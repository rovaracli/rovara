import { afterEach, expect, it, vi } from "vitest";
import { AppNavSchema, REMOVED_UI_FLAG_NAMES, UI_FLAG_NAMES, orgMetaKey, orgUiFlagsKey, uiFlagDefaultOn } from "@agentx/cloud-contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

// Runtime UI flags through the real broker handler: the navigation answer carries them, and the admin route is browser-only (a bearer token is refused before anything is read).

afterEach(() => { vi.unstubAllEnvs(); });
async function setup() {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Maya's organization", plan: "trial", createdBy: MAYA.developerId, createdAt: "2026-10-23T12:00:00Z" });
  return h;
}
const navOf = (body: Record<string, unknown>) => { const copy = { ...body };delete copy.requestId;return AppNavSchema.parse(copy); };

it("sends only the flags that are left (decision 125), each at its default, in the navigation answer for a company that never changed anything, and the Insights switch beside them", async () => {
  const h = await setup();
  const response = await h.dev(MAYA, "GET", "/v1/app/nav");
  expect(response.status).toBe(200);
  const nav = navOf(response.body);
  expect(nav.uiFlags).toEqual(Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, uiFlagDefaultOn(name) ? "on" : "off"])));
  for (const name of REMOVED_UI_FLAG_NAMES) expect(Object.keys(nav.uiFlags ?? {}), name).not.toContain(name);
  expect(nav.insights).toBe(false);
  vi.stubEnv("INSIGHTS_ENABLED", "1");
  expect(navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).insights).toBe(true);
});

it("sends the company's states, fresh on every request (not held by the five second navigation cache), and never a removed name stored by an older broker", async () => {
  const h = await setup();
  expect(navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags?.health).toBe("off");
  h.db.set({ ...orgUiFlagsKey(TEST_ORG), entityType: "UI_FLAGS", orgId: TEST_ORG, flags: { home: false, health: true }, previews: true, revision: 1, changedAt: "2026-11-11T09:00:00.000Z" });
  const after = navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags;
  expect(after).toEqual({ health: "on", setup: "preview", publish: "preview", billing: "preview", agreement: "preview", companies: "preview" });
});

it("applies the operator's override from the broker's environment, over the company's choice; a removed name in it is skipped, any other unknown name holds everything back", async () => {
  const h = await setup();
  h.db.set({ ...orgUiFlagsKey(TEST_ORG), entityType: "UI_FLAGS", orgId: TEST_ORG, flags: { health: true, setup: true }, previews: true, revision: 1, changedAt: "2026-11-11T09:00:00.000Z" });
  vi.stubEnv("UI_FLAGS_FORCE_OFF", "home-health");
  const flags = navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags;
  expect(flags?.health).toBe("off");expect(flags?.setup).toBe("on");expect(flags?.billing).toBe("preview");
  vi.stubEnv("UI_FLAGS_FORCE_OFF", "homw-health");
  expect(Object.values(navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags ?? {})).toEqual(UI_FLAG_NAMES.map(() => "off"));
  vi.stubEnv("UI_FLAGS_FORCE_OFF", "all");
  expect(Object.values(navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags ?? {})).toEqual(UI_FLAG_NAMES.map(() => "off"));
});

it("refuses a bearer token on the admin route, for both methods, before anything is read or changed", async () => {
  const h = await setup();
  const get = await h.dev(MAYA, "GET", "/v1/app/org/ui-flags");
  const put = await h.dev(MAYA, "PUT", "/v1/app/org/ui-flags", { expectedRevision: 0, flags: { health: true } });
  expect(get.status).toBe(403);expect(put.status).toBe(403);
  expect(get.body).toMatchObject({ error: { code: "FORBIDDEN" } });expect(put.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(h.db.get(orgUiFlagsKey(TEST_ORG))).toBeUndefined();
});
