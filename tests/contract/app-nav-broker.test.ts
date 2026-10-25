import { expect, it } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AppNavSchema, liveSessionKey, orgMetaKey } from "@agentx/contracts";
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

it("coalesces production source reads across separately authenticated requests", async () => {
 const h = await setup(), original = h.db.send.bind(h.db);let liveReads = 0;
 h.db.send = async command => { if (command instanceof QueryCommand && command.input.ExpressionAttributeValues?.[":pk"] === liveSessionKey(TEST_ORG, "ses_00000000000000000000").pk) liveReads++;return original(command); };
 const answers = await Promise.all([h.dev(MAYA, "GET", "/v1/app/nav"), h.dev(MAYA, "GET", "/v1/app/nav")]);
 expect(answers.map(answer => answer.status)).toEqual([200, 200]);await h.dev(MAYA, "GET", "/v1/app/nav");expect(liveReads).toBe(1);
});

it("counts 300 visible sessions across 40 projects without reading the live index per project", async () => {
 const { projectRevisionKey, orgProjectCatalogKey, agentSessionKey } = await import("@agentx/contracts");
 const { grantProject } = await import("../support/developer-task-broker.js");
 const { sessionWorld } = await import("../support/agent-session-world.js");
 const { taskKey } = await import("../../packages/broker/src/developer/task-records.js");
 const h = await setup(), revision = await h.actions.projectRevision(TEST_ORG, "payments", 1);
 if (revision === undefined) throw new Error("missing project fixture");
 const projects = ["payments", ...Array.from({ length: 39 }, (_, i) => "project-" + String(i).padStart(2, "0"))];
 for (const name of projects.slice(1)) {
 h.db.set({ ...revision, ...projectRevisionKey(TEST_ORG, name, 1), definition: { ...revision.definition, name } });
 h.db.set({ ...orgProjectCatalogKey(TEST_ORG, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1 });grantProject(h.db, MAYA, name);
 }
 const w = sessionWorld();
 for (let i = 0; i < 300; i++) {
 const project = projects[i % projects.length]!, seeded = w.seedSession({ orgId: TEST_ORG, owner: MAYA.developerId, project });
 const record = { ...seeded.record, agent: { agentId: "root-cause-analyst", name: "Analyst", version: 1 } };
 h.db.set({ ...agentSessionKey(TEST_ORG, seeded.sessionId, "META"), entityType: "AGENT_SESSION", ...record });
 h.db.set(w.db.get(taskKey(seeded.taskId))!);
 h.db.set({ ...liveSessionKey(TEST_ORG, seeded.sessionId), entityType: "LIVE_SESSION", ...record, ownerId: MAYA.developerId });
 }
 const original = h.db.send.bind(h.db);let liveReads = 0;
 h.db.send = async command => { if (command instanceof QueryCommand && command.input.ExpressionAttributeValues?.[":pk"] === liveSessionKey(TEST_ORG, "ses_00000000000000000000").pk) liveReads++;return original(command); };
 const before = h.db.commandNames().length, response = await h.dev(MAYA, "GET", "/v1/app/nav");expect(response.status).toBe(200);
 const body = { ...response.body };delete body.requestId;const nav = AppNavSchema.parse(body);
 expect(nav.projects).toHaveLength(40);expect(nav.projects.flatMap(project => project.agents).reduce((sum, agent) => sum + agent.running, 0)).toBe(300);expect(liveReads).toBe(1);
 const names = h.db.commandNames().slice(before);const counts = Object.fromEntries([...new Set(names)].sort().map(name => [name, names.filter(value => value === name).length]));
 expect(counts.GetCommand ?? 0).toBeLessThanOrEqual(100);
 expect(counts.QueryCommand ?? 0).toBeLessThanOrEqual(100);
 expect(counts.BatchGetCommand ?? 0).toBeLessThanOrEqual(20);
 expect(names).not.toContain("ScanCommand");
});
