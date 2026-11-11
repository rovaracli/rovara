import { expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AppNavSchema, orgMetaKey } from "@agentx/cloud-contracts";
import { liveSessionKey } from "@rovara-code/contracts";
import { MAYA, OMAR, seedMembership, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
async function setup() {
 const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
 const org = { ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Maya's organization", plan: "trial", createdBy: MAYA.developerId, createdAt: "2026-10-23T12:00:00Z" };
 h.db.set(org);return { ...h, org };
}
it("serves the production navigation route with canonical Home total and visible projects", async () => {
 const { registerHomeCardSource } = await import("../../packages/broker/src/agent-sessions/home.js");
 const remove = registerHomeCardSource({ kind: "offer", list: async (_deps, caller) => caller.developerId === MAYA.developerId ? [{ cardId: "offer:shared-method", kind: "offer", title: "Try a shared workflow", reason: "A teammate shared this workflow.", at: "2026-10-23T12:00:00Z", buttons: [] }] : [] });
 try {
 const h = await setup(), home = await h.dev(MAYA, "GET", "/v1/app/home"), response = await h.dev(MAYA, "GET", "/v1/app/nav");
 expect(response.status).toBe(200);const body = { ...response.body };delete body.requestId;const nav = AppNavSchema.parse(body);
 expect(home.body.total).toBe(1);expect(nav.homeCount).toBe(home.body.total);expect(nav.projects.map(project => project.name)).toContain("payments");expect(nav.org.trial?.state).toBe("locked");expect(nav.features).toEqual({ localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false });
 } finally { remove(); }
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

/** 40 projects Maya may see and 300 of her running sessions across them, one of which needs her. */
async function bigNavWorld() {
 const { projectRevisionKey, orgProjectCatalogKey, agentSessionKey } = await import("@rovara-code/contracts");
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
 const record = { ...seeded.record, summary: { ...seeded.record.summary, needsPeople: i === 0 ? [MAYA.developerId] : [] }, agent: { agentId: "root-cause-analyst", name: "Analyst", version: 1 } };
 h.db.set({ ...agentSessionKey(TEST_ORG, seeded.sessionId, "META"), entityType: "AGENT_SESSION", ...record });
 h.db.set(w.db.get(taskKey(seeded.taskId))!);
 h.db.set({ ...liveSessionKey(TEST_ORG, seeded.sessionId), entityType: "LIVE_SESSION", ...record, ownerId: MAYA.developerId });
 }
 return { h, projects };
}
it("counts 300 visible sessions across 40 projects without reading the live index per project", async () => {
 const { INTAKE_HOME_PROJECTS_MAX } = await import("../../packages/broker/src/intake/home-source.js");
 const { h, projects } = await bigNavWorld();
 const original = h.db.send.bind(h.db);let liveReads = 0, intakeReads = 0;
 h.db.send = async command => { if (command instanceof QueryCommand && command.input.ExpressionAttributeValues?.[":pk"] === liveSessionKey(TEST_ORG, "ses_00000000000000000000").pk) liveReads++;if (command instanceof QueryCommand && String(command.input.ExpressionAttributeValues?.[":pk"]).includes("#INTAKE_ITEM#")) intakeReads++;return original(command); };
 const before = h.db.commandNames().length, response = await h.dev(MAYA, "GET", "/v1/app/nav");expect(response.status).toBe(200);
 const body = { ...response.body };delete body.requestId;const nav = AppNavSchema.parse(body);
 expect(nav.projects).toHaveLength(40);expect(nav.projects.flatMap(project => project.agents).reduce((sum, agent) => sum + agent.running, 0)).toBe(300);expect(liveReads).toBe(1);expect(nav.projects.flatMap(project => project.agents).reduce((sum, agent) => sum + agent.needsYou, 0)).toBe(1);
 const names = h.db.commandNames().slice(before);const counts = Object.fromEntries([...new Set(names)].sort().map(name => [name, names.filter(value => value === name).length]));
 expect(counts.GetCommand ?? 0).toBeLessThanOrEqual(100);
 expect(counts.QueryCommand ?? 0).toBeLessThanOrEqual(3 * projects.length + 14 + INTAKE_HOME_PROJECTS_MAX);
 expect(counts.BatchGetCommand ?? 0).toBeLessThanOrEqual(20);
 // Release 0.4.18: two more Gets, the chosen name beside the sign-in check and beside the caller's own record (92 before), and one more BatchGet, the owners' chosen names for the live tiles (14 before).
 // Plan 6 Task 18 (d6eb074d9, review reminders) added one more Query (133 before): Home reads the caller's REVIEW_WAIT partition once per request. It is a fixed read, whatever the number of projects or sessions: the rest is 3 per project (the project's revisions, its shared sessions and its agents) plus 14 fixed.
 // Slice 5 (5d0486742, waiting tickets on Home) added the waiting-ticket Home card source, which nav runs for its "needs you" count (the same number Home shows): one Query of each
 // project's INTAKE_ITEM partition the caller may start tasks in, at most INTAKE_HOME_PROJECTS_MAX (10) projects, however many there are (144 = 134 + 10). There is no org-wide index of
 // waiting tickets to read instead; the rest is unchanged (3 per project plus 14 fixed).
 expect(intakeReads).toBe(INTAKE_HOME_PROJECTS_MAX);
 expect(counts).toEqual({ BatchGetCommand: 15, GetCommand: 94, QueryCommand: 134 + INTAKE_HOME_PROJECTS_MAX });
 expect(names).not.toContain("ScanCommand");
});

/** The Queries of one nav read as Maya, by partition (ids masked), with the decision cards switched on as they are at upgrade (owner decision). */
async function decisionCardsNav(failApproverList = false) {
 vi.stubEnv("DECISION_CARDS_ENABLED", "1");
 const logged: string[] = [], log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); });
 try {
 const { h } = await bigNavWorld(), original = h.db.send.bind(h.db), partitions: string[] = [];
 const approverPk = String((await import("@rovara-code/contracts")).approverIndexKey(TEST_ORG, MAYA.developerId, "apr_00000000000000000000").pk);
 h.db.send = async command => {
 const pk = command instanceof QueryCommand ? String(command.input.ExpressionAttributeValues?.[":pk"]) : undefined;
 if (pk !== undefined) partitions.push(pk);
 if (failApproverList && pk === approverPk) throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
 return original(command);
 };
 const before = h.db.commandNames().length, response = await h.dev(MAYA, "GET", "/v1/app/nav");
 const names = h.db.commandNames().slice(before);
 return { response, queries: names.filter(name => name === "QueryCommand").length, approverReads: partitions.filter(pk => pk === approverPk).length, logged };
 } finally { log.mockRestore();vi.unstubAllEnvs(); }
}

it("with the decision cards on, the nav reads the caller's approvals once: the outside cards share Home's read (145 Queries)", async () => {
 const { INTAKE_HOME_PROJECTS_MAX } = await import("../../packages/broker/src/intake/home-source.js");
 const { response, queries, approverReads } = await decisionCardsNav();
 expect(response.status).toBe(200);
 // The decision cards add one Query, the caller's own pending decision partition. Their outside approval cards list the caller's approvals through the request's read cache, the same read
 // Home's approval cards make (outside-cards.ts), so that list is not read a second time (146 before).
 expect(approverReads).toBe(1);
 expect(queries).toBe(134 + INTAKE_HOME_PROJECTS_MAX + 1);
});

it("with the decision cards on, an approvals list that cannot be read fails the decision cards visibly, never a shorter list that looks complete", async () => {
 const { response, approverReads, logged } = await decisionCardsNav(true);
 // A failed read is never kept by the read cache: whoever asks after it failed reads again (once or twice, as the two askers meet).
 expect(approverReads).toBeGreaterThanOrEqual(1);expect(approverReads).toBeLessThanOrEqual(2);
 expect(response.status).toBe(200);
 // Home's approval source and the decision cards both say they could not read, so the count is known to be short; the outside cards no longer turn the failure into an empty list.
 expect(logged.some(line => line.includes('"event":"home.source_failed"') && line.includes('"source":"approval"'))).toBe(true);
 expect(logged.some(line => line.includes('"event":"home.decisions_unreadable"'))).toBe(true);
});

it("keeps production navigation separate across organizations", async () => {
 const other = "org_bbbbbbbbbbbbbbbbbbbb";
 const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} }, orgResolver: async ({ developerId }) => developerId === OMAR.developerId ? other : TEST_ORG });
 const responses = await Promise.all([h.dev(MAYA, "GET", "/v1/app/nav"), h.dev(OMAR, "GET", "/v1/app/nav")]);
 const navs = responses.map(response => { expect(response.status).toBe(200);const body = { ...response.body };delete body.requestId;return AppNavSchema.parse(body); });
 expect(navs[0]!.projects.map(project => project.name)).toContain("payments");expect(navs[1]!.projects).toEqual([]);expect(navs[1]!.shared).toEqual({ agents: [], sessions: [] });expect(navs[1]!.me.developerId).toBe(OMAR.developerId);
});
it("rechecks role and server feature switches before reusing a production projection", async () => {
 vi.stubEnv("WEB_FEATURES", "usage,admin,chains,notices,describe");
 try {
 const { projectRevisionKey, orgProjectCatalogKey } = await import("@rovara-code/contracts");
 const h = await setup(), revision = await h.actions.projectRevision(TEST_ORG, "payments", 1);if (revision === undefined) throw new Error("missing project fixture");
 h.db.set({ ...revision, ...projectRevisionKey(TEST_ORG, "admin-only", 1), definition: { ...revision.definition, name: "admin-only" } });h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "admin-only"), entityType: "PROJECT_CATALOG", name: "admin-only", latestRevision: 1 });
 const read = async () => { const response = await h.dev(MAYA, "GET", "/v1/app/nav");expect(response.status).toBe(200);const body = { ...response.body };delete body.requestId;return AppNavSchema.parse(body); };
 const member = await read();expect(member.features.admin).toBe(false);expect(member.features.usage).toBe(true);expect(member.projects.some(project => project.name === "admin-only")).toBe(false);
 seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });const admin = await read();expect(admin.features.admin).toBe(true);expect(admin.projects.some(project => project.name === "admin-only")).toBe(true);
 vi.stubEnv("WEB_FEATURES", "");expect((await read()).features.admin).toBe(false);
 } finally { vi.unstubAllEnvs(); }
});
it("does not reuse another person's source adapter in the same company", async () => {
 const h = await setup();await h.dev(MAYA, "GET", "/v1/app/nav");const response = await h.dev(OMAR, "GET", "/v1/app/nav");expect(response.status).toBe(200);const body = { ...response.body };delete body.requestId;const nav = AppNavSchema.parse(body);expect(nav.me.developerId).toBe(OMAR.developerId);expect(nav.projects).toEqual([]);
});
it("does not reuse the old company's adapter after the same person moves organizations", async () => {
 const { bearerFor } = await import("../support/developer-task-broker.js");
 const h = await setup();await h.dev(MAYA, "GET", "/v1/app/nav");const other = "org_bbbbbbbbbbbbbbbbbbbb";seedMembership(h.db, MAYA.developerId, { orgId: other, role: "member" });
 const response = await h.handler({ version: "2.0", rawPath: "/v1/app/nav", rawQueryString: "", headers: { authorization: await bearerFor(MAYA, { orgId: other, role: "member" }) }, requestContext: { requestId: "moved-org", http: { method: "GET" } } });expect(response.statusCode).toBe(200);
 const body = JSON.parse(response.body) as Record<string, unknown>;delete body.requestId;const nav = AppNavSchema.parse(body);expect(nav.projects).toEqual([]);expect(nav.org.name).toBe("test");
});
it("refreshes production live facts after five seconds without reusing the old source promises", async () => {
 const { bearerFor } = await import("../support/developer-task-broker.js"), { randomUUID } = await import("node:crypto");
 const h = await setup();h.db.set({ ...h.org, plan: "team" });const authorization = await bearerFor(MAYA);
 const read = async () => { const response = await h.handler({ version: "2.0", rawPath: "/v1/app/nav", rawQueryString: "", headers: { authorization }, requestContext: { requestId: "fresh-navigation", http: { method: "GET" } } });expect(response.statusCode).toBe(200);const body = JSON.parse(response.body) as Record<string, unknown>;delete body.requestId;return AppNavSchema.parse(body).projects.flatMap(project => project.agents).reduce((sum, agent) => sum + agent.running, 0); };
 expect(await read()).toBe(0);
 expect((await h.dev(MAYA, "POST", "/v1/app/agents/root-cause-analyst/runs", { requestId: randomUUID(), project: "payments", input: { text: "Investigate refunds" } })).status).toBe(202);
 expect(await read()).toBe(0);const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now + 5001);
 try { expect(await read()).toBe(1); } finally { clock.mockRestore(); }
});
it("discards failed production adapters so a real retry reloads the source", async () => {
 const h = await setup();h.db.injectFault({ command: "QueryCommand", match: input => (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"] === liveSessionKey(TEST_ORG, "ses_00000000000000000000").pk, error: { name: "ThrottlingException" }, times: 1 });
 expect((await h.dev(MAYA, "GET", "/v1/app/nav")).status).toBeGreaterThanOrEqual(500);expect((await h.dev(MAYA, "GET", "/v1/app/nav")).status).toBe(200);
});
