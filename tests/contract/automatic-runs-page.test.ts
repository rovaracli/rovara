// The project page's automatic runs through the whole broker (owner decision 2026-11-02): the test-health route (behind nh) carries the runs, the "Automatic runs" line, the pause and the reminder; a maintainer sets the cap
// (audited); a person who is not a maintainer can read but not change.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { startAutomaticRun } from "../../packages/broker/src/automatic-runs/start.js";
import { startAgentRun } from "../../packages/broker/src/agents/runs.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { systemOwnerIdOf } from "@agentx/contracts";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const PROJECT = "payments";
const HEALTH = `/v1/app/projects/${PROJECT}/test-health`;
let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
let createAutomaticRunStarter: typeof BrokerModule.createAutomaticRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter, createAutomaticRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});
afterEach(() => { delete process.env.NIGHTLY_HEALTH_ENABLED; delete process.env.TEST_ENVIRONMENT_ENABLED; });
const on = () => { process.env.NIGHTLY_HEALTH_ENABLED = "1"; process.env.TEST_ENVIRONMENT_ENABLED = "1"; };
const setCap = (h: { dev: Awaited<ReturnType<typeof createDeveloperTaskBroker>>["dev"] }, who: typeof MAYA, cap: number, requestId = randomUUID()) => h.dev(who, "POST", HEALTH, { action: "set_automatic_runs_cap", cap, requestId });

describe("the project page's automatic runs", () => {
  it("is part of the health read, behind nh: the line, no pause, no runs yet", async () => {
    const h = await createDeveloperTaskBroker();
    on();
    const reply = await h.dev(MAYA, "GET", HEALTH);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.automaticRuns).toMatchObject({ line: { label: "Automatic runs", used: 0, cap: 100, paused: false, words: "Automatic runs: 0 of 100 this month" }, recent: [] });
    expect((reply.body.automaticRuns as Record<string, unknown>).pausedWords).toBeUndefined();
    delete process.env.NIGHTLY_HEALTH_ENABLED;
    expect((await h.dev(MAYA, "GET", HEALTH)).status).toBe(404);
  });

  it("a maintainer sets the monthly cap and it is audited; a person who is not a maintainer can read the page but not change the cap", async () => {
    const audit = capturingAuditDeps();
    const h = { ...(await createDeveloperTaskBroker({ audit })), audit };
    on();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const refused = await setCap(h, MAYA, 5);
    expect(refused.status).toBe(403);
    expect((await h.dev(MAYA, "GET", HEALTH)).body.automaticRuns).toMatchObject({ line: { cap: 100 } });
    const changed = await setCap(h, OMAR, 5);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.automaticRuns).toMatchObject({ line: { cap: 5, capIsDefault: false } });
    expect(h.audit.recordedBy("project.automatic_runs_cap_changed")).toHaveLength(1);
    for (const cap of [-1, 2.5, 5000]) expect((await setCap(h, OMAR, cap)).status, String(cap)).toBe(400);
  });

  it("shows a run Rovara started by itself as 'Started by Rovara (nightly)', and the pause when the cap is reached", async () => {
    const audit = capturingAuditDeps();
    const h = { ...(await createDeveloperTaskBroker({ audit, brokerExtra: { agents: {} } })), audit };
    on();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    await setCap(h, OMAR, 1);
    const starter = createAgentRunStarter(h.brokerInput as never)!;
    const deps = { documentClient: h.db, tableName: "state", now: Date.now, audit: h.audit.audit, startAgentRun: (request: Parameters<typeof startAgentRun>[1]) => startAgentRun(starter, request) };
    const started = await startAutomaticRun(deps, { orgId: TEST_ORG, project: PROJECT, job: "nightly", requestId: randomUUID(), agent: { agentId: "rovara-code" }, input: { text: "Nightly test run." }, origin: "nightly", setupApprovedBy: OMAR.developerId });
    expect("started" in started).toBe(true);
    const page = (await h.dev(MAYA, "GET", HEALTH)).body.automaticRuns as { line: { paused: boolean; used: number }; recent: Array<{ words: string; state: string }>; pausedWords?: string };
    expect(page.recent).toMatchObject([{ words: "Started by Rovara (nightly)", state: "running" }]);
    expect(page.line).toMatchObject({ used: 1, paused: true });
    expect(page.pausedWords).toContain("paused");
    expect(await startAutomaticRun(deps, { orgId: TEST_ORG, project: PROJECT, job: "nightly", requestId: randomUUID(), agent: { agentId: "rovara-code" }, input: { text: "Nightly test run." }, origin: "nightly" })).toEqual({ skipped: "automatic_cap" });
    // the run is in nobody's task list
    expect(JSON.stringify((await h.dev(MAYA, "GET", "/v1/dev/tasks")).body)).not.toContain("Nightly");
    expect(JSON.stringify((await h.dev(OMAR, "GET", "/v1/dev/tasks")).body)).not.toContain("Nightly");
  });
});

describe("the function every automatic job starts with (the saved-environments lane's rebuild uses it)", () => {
  it("starts a run owned by the project's system owner, held to the cap, with the start audited as the system", async () => {
    const audit = capturingAuditDeps();
    const h = { ...(await createDeveloperTaskBroker({ audit, brokerExtra: { agents: {} } })), audit };
    on();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const start = createAutomaticRunStarter(h.brokerInput as never)!;
    expect(start).toBeDefined();
    const requestId = randomUUID();
    const outcome = await start({ orgId: TEST_ORG, project: PROJECT, job: "image_rebuild", requestId, agent: { agentId: "rovara-code" }, input: { text: "Rebuild the saved image." }, origin: "automatic", setupApprovedBy: OMAR.developerId });
    expect("started" in outcome).toBe(true);
    const task = h.db.find((item) => item.entityType === "DEVELOPER_TASK")[0] as Record<string, unknown>;
    expect(task).toMatchObject({ developerId: systemOwnerIdOf(TEST_ORG, PROJECT), provider: "system", origin: "automatic", payer: { kind: "project", project: PROJECT }, automatic: { job: "image_rebuild", approvedBy: OMAR.developerId } });
    expect(task.startedBy).toBeUndefined();
    const events = h.audit.recordedBy("automatic_run.started");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "system", id: "rovara" }, facts: { job: "image_rebuild", setupApprovedBy: OMAR.developerId } });
    // nobody's task list, and the page says who started it
    expect(JSON.stringify((await h.dev(OMAR, "GET", "/v1/dev/tasks")).body)).not.toContain(String(task.taskId));
    expect(((await h.dev(OMAR, "GET", HEALTH)).body.automaticRuns as { recent: Array<{ words: string }> }).recent[0]?.words).toBe("Started by Rovara (image rebuild)");
  });
});
