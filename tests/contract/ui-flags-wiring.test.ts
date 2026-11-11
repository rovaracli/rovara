import { afterEach, expect, it, vi } from "vitest";
import { AppNavSchema, UI_FLAG_NAMES, orgMetaKey, orgUiFlagsKey } from "@agentx/cloud-contracts";
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

it("sends every flag off in the navigation answer for a company that never changed anything", async () => {
  const h = await setup();
  const response = await h.dev(MAYA, "GET", "/v1/app/nav");
  expect(response.status).toBe(200);
  expect(navOf(response.body).uiFlags).toEqual(Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, "off"])));
});

it("sends the company's states, fresh on every request (not held by the five second navigation cache)", async () => {
  const h = await setup();
  expect(navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags?.home).toBe("off");
  h.db.set({ ...orgUiFlagsKey(TEST_ORG), entityType: "UI_FLAGS", orgId: TEST_ORG, flags: { home: true }, previews: true, revision: 1, changedAt: "2026-11-11T09:00:00.000Z" });
  const on = navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags;
  expect(on?.home).toBe("on");expect(on?.look).toBe("preview");
});

it("applies the operator's override from the broker's environment, over the company's choice", async () => {
  const h = await setup();
  h.db.set({ ...orgUiFlagsKey(TEST_ORG), entityType: "UI_FLAGS", orgId: TEST_ORG, flags: { home: true, look: true }, previews: true, revision: 1, changedAt: "2026-11-11T09:00:00.000Z" });
  vi.stubEnv("UI_FLAGS_FORCE_OFF", "home");
  const flags = navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags;
  expect(flags?.home).toBe("off");expect(flags?.look).toBe("on");
  vi.stubEnv("UI_FLAGS_FORCE_OFF", "all");
  expect(Object.values(navOf((await h.dev(MAYA, "GET", "/v1/app/nav")).body).uiFlags ?? {})).toEqual(UI_FLAG_NAMES.map(() => "off"));
});

it("refuses a bearer token on the admin route, for both methods, before anything is read or changed", async () => {
  const h = await setup();
  const get = await h.dev(MAYA, "GET", "/v1/app/org/ui-flags");
  const put = await h.dev(MAYA, "PUT", "/v1/app/org/ui-flags", { expectedRevision: 0, flags: { look: true } });
  expect(get.status).toBe(403);expect(put.status).toBe(403);
  expect(get.body).toMatchObject({ error: { code: "FORBIDDEN" } });expect(put.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(h.db.get(orgUiFlagsKey(TEST_ORG))).toBeUndefined();
});
