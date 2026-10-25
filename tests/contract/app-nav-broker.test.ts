import { expect, it } from "vitest";
import { AppNavSchema, orgMetaKey } from "@agentx/contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
async function setup() {
 const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
 const org = { ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Maya's organization", plan: "trial", createdBy: MAYA.developerId, createdAt: "2026-10-23T12:00:00Z" };
 h.db.set(org);return { ...h, org };
}
it("serves the production navigation route with canonical Home total and visible projects", async () => {
 const h = await setup(), home = await h.dev(MAYA, "GET", "/v1/app/home"), response = await h.dev(MAYA, "GET", "/v1/app/nav");
 expect(response.status).toBe(200);const body = { ...response.body };delete body.requestId;const nav = AppNavSchema.parse(body);
 expect(nav.homeCount).toBe(home.body.total);expect(nav.projects.map(project => project.name)).toContain("payments");expect(nav.org.trial?.state).toBe("locked");expect(nav.features).toEqual({ localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false });
});
it("adds the authoritative trial state and default-name flag to me", async () => {
 const h = await setup();
 expect((await h.dev(MAYA, "GET", "/v1/app/me")).body).toMatchObject({ org: { trial: { state: "locked" }, nameIsDefault: true } });
 h.db.set({ ...h.org, trialGithubUsedAt: Date.now(), nameIsDefault: false });
 expect((await h.dev(MAYA, "GET", "/v1/app/me")).body).toMatchObject({ org: { trial: { state: "github_used" }, nameIsDefault: false } });
 h.db.set({ ...h.org, trialGithubUsedAt: Date.now(), trialUnlockedAt: Date.now() });
 expect((await h.dev(MAYA, "GET", "/v1/app/me")).body).toMatchObject({ org: { trial: { state: "unlocked" } } });
});
