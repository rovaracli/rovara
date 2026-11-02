// Setup run limits, through the whole broker (sh-su-musts): the routes exist only while `su` is on, only a browser session changes them, an admin sets the company's and a maintainer the project's, a loosening
// waits for a second admin, and a run started afterwards uses the smaller of the two.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT } from "../../packages/contracts/src/index.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { setupLocksKey } from "../../packages/contracts/src/index.js";
import { TEST_ORG } from "../support/orgs.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";

afterEach(() => { delete process.env.SETUP_AGENT_ENABLED; });
const PROJECT = `/v1/app/projects/${NAME}/setup-agent/limits`;
const COMPANY = "/v1/app/org/setup-agent/locks";
const ROUTE = `/v1/app/projects/${NAME}/setup-agent`;

async function bench(): Promise<Bench> {
  process.env.SETUP_AGENT_ENABLED = "1";
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit, modelProxy: true });
  audit.audit.documentClient = t.db as unknown as typeof audit.audit.documentClient;
  await t.person(OMAR, "owner");
  await t.person(MAYA, "admin");
  return t;
}

describe("with the switch off", () => {
  it("none of it exists: every limits path is an unknown path, nothing is written", async () => {
    delete process.env.SETUP_AGENT_ENABLED;
    const t = await setupWizardBench({ audit: capturingAuditDeps(), modelProxy: true });
    for (const [method, path] of [["GET", PROJECT], ["PUT", PROJECT], ["GET", COMPANY], ["PUT", COMPANY], ["POST", `${COMPANY}/approve`]] as const) {
      expect((await t.dev(OMAR, method, path, method === "GET" ? undefined : {})).status, `${method} ${path}`).toBe(404);
      expect((await t.web(OMAR, method, path, method === "GET" ? undefined : {})).status, `web ${method} ${path}`).toBe(404);
    }
    expect(t.db.find((item) => item.entityType === "SETUP_LIMITS" || item.entityType === "SETUP_LOCKS")).toEqual([]);
  });
});

describe("the project's limits, over the routes", () => {
  it("a maintainer sets them from the web app; a token may read but never change them", async () => {
    const t = await bench();
    const refused = await t.dev(OMAR, "PUT", PROJECT, { requestId: randomUUID(), expectedRevision: 0, limits: { commands: 60 } });
    expect(refused.status).toBe(403);
    expect(t.db.find((item) => item.entityType === "SETUP_LIMITS")).toEqual([]);
    const set = await t.web(OMAR, "PUT", PROJECT, { requestId: randomUUID(), expectedRevision: 0, limits: { commands: 60, budgetCents: 900 } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ revision: 1, limits: { commands: 60, budgetCents: 900 }, effective: { commands: 60, budgetCents: 900 } });
    const read = await t.dev(OMAR, "GET", PROJECT);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ revision: 1, limits: { commands: 60 }, companyLock: {} });
  });

  it("a run started afterwards keeps the limits it started with: the project's own, cut down by the company's lock", async () => {
    const t = await bench();
    await t.web(OMAR, "PUT", PROJECT, { requestId: randomUUID(), expectedRevision: 0, limits: { commands: 100, hostAsks: 8 } });
    const lock = await t.web(OMAR, "PUT", COMPANY, { requestId: randomUUID(), expectedRevision: null, limits: { commands: 30, budgetCents: 250 } });
    expect(lock.status, JSON.stringify(lock.body)).toBe(200);
    expect(((await t.dev(OMAR, "GET", ROUTE)).body as { limits: unknown }).limits).toEqual({ ...SETUP_AGENT_LIMITS_DEFAULT, commands: 30, budgetCents: 250, hostAsks: 8 });
    const started = await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const task = t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_agent")[0] as { taskId: string; setupAgentLimits: unknown };
    expect(task.setupAgentLimits).toEqual({ ...SETUP_AGENT_LIMITS_DEFAULT, commands: 30, budgetCents: 250, hostAsks: 8 });
    expect(t.db.get(taskKey(task.taskId).pk, taskKey(task.taskId).sk)).toMatchObject({ budgetUsd: 2.5 });
    // Lowering the company's limit afterwards does not change the run that is going.
    await t.web(OMAR, "PUT", COMPANY, { requestId: randomUUID(), expectedRevision: 1, limits: { commands: 10, budgetCents: 250 } });
    expect(((await t.dev(OMAR, "GET", ROUTE)).body as { limits: { commands: number } }).limits.commands).toBe(30);
  });
});

describe("setupAgentOff", () => {
  it("a company admin turns setup runs off for the company: a start is refused, nothing is started, and the view says so; turning it on again needs a second admin", async () => {
    const t = await bench();
    expect((await t.web(OMAR, "PUT", COMPANY, { requestId: randomUUID(), expectedRevision: null, setupAgentOff: true })).status).toBe(200);
    const refused = await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() });
    expect(refused.status).toBe(403);
    expect(t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_agent")).toEqual([]);
    expect((await t.dev(OMAR, "GET", ROUTE)).body).toMatchObject({ status: "none", companySetupOff: true });
    const on = await t.web(OMAR, "PUT", COMPANY, { requestId: randomUUID(), expectedRevision: 1, setupAgentOff: false });
    expect(on.status).toBe(202);
    expect((await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() })).status).toBe(403);
    const digest = (on.body as { pending: { digest: string } }).pending.digest;
    expect((await t.web(MAYA, "POST", `${COMPANY}/approve`, { requestId: randomUUID(), expectedRevision: 2, expectedDigest: digest })).status).toBe(200);
    expect((await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() })).status).toBe(202);
    expect((await t.dev(OMAR, "GET", ROUTE)).body).not.toHaveProperty("companySetupOff");
  });
});

describe("M3: a locks row that does not read", () => {
  it("holds every start with a clear message and shows it on the setup page, which still loads; an admin repairs it from the web app", async () => {
    const t = await bench();
    t.db.set({ ...setupLocksKey(TEST_ORG), entityType: "SETUP_LOCKS", orgId: TEST_ORG, revision: 3, locks: { limits: { commands: "many" } }, updatedBy: OMAR.developerId, updatedAt: "2026-11-02T10:00:00.000Z" });
    const refused = await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("Company locks unreadable, runs held");
    expect(t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_agent")).toEqual([]);
    expect((await t.dev(OMAR, "GET", ROUTE)).body).toMatchObject({ status: "none", companySetupOff: true, companyLocksUnreadable: true });
    expect((await t.web(OMAR, "GET", COMPANY)).body).toMatchObject({ unreadable: true, revision: 3 });
    expect((await t.web(OMAR, "POST", `${COMPANY}/repair`, { requestId: randomUUID(), expectedRevision: 2 })).status).toBe(409);
    const repaired = await t.web(OMAR, "POST", `${COMPANY}/repair`, { requestId: randomUUID(), expectedRevision: 3 });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    expect((await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() })).status).toBe(202);
  });
});

describe("L12: setup runs turned off for the company stop the runs that are going", () => {
  it("a running run is told to stop at its next look, is handed no person's command, and its website asks are refused", async () => {
    const t = await bench();
    await t.person(OMAR, "owner", "maintainer");
    const started = await t.dev(OMAR, "POST", ROUTE, { requestId: randomUUID() });
    expect(started.status).toBe(202);
    const task = t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_agent")[0] as { workspaceId: string };
    const operations = t.operations(task.workspaceId);
    await t.finish(task.workspaceId, operations.find((operation) => operation.kind === "prepare")!.id, "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "web", baseCommitSha: "c".repeat(40) }] } });
    const own = t.operations(task.workspaceId).find((operation) => operation.kind === "task")!;
    await t.events(task.workspaceId, own.id, [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
    expect(await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "poll" })).not.toHaveProperty("companyOff");
    expect((await t.web(OMAR, "PUT", COMPANY, { requestId: randomUUID(), expectedRevision: null, setupAgentOff: true })).status).toBe(200);
    expect(await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "poll" })).toMatchObject({ companyOff: true });
    expect(await t.callback(task.workspaceId, own.id, "setup-agent", { kind: "host", host: "registry.acme-build.io" })).toMatchObject({ outcome: "no_run" });
    expect(t.db.find((item) => item.entityType === "SETUP_HOST_ASK")).toEqual([]);
  });
});

describe("who may change the project's limits", () => {
  it("a contributor or a viewer can neither read nor change them, over the web as over a token", async () => {
    const t = await bench();
    for (const grant of ["contributor", "viewer"] as const) {
      await t.person(MAYA, "member", grant);
      expect((await t.web(MAYA, "PUT", PROJECT, { requestId: randomUUID(), expectedRevision: 0, limits: { commands: 60 } })).status, grant).toBe(403);
      expect((await t.web(MAYA, "GET", PROJECT)).status, grant).toBe(403);
    }
    expect(t.db.find((item) => item.entityType === "SETUP_LIMITS")).toEqual([]);
  });
});

describe("the company's limits, over the routes", () => {
  it("an admin with a fresh browser sign-in sets them; a token, an old sign-in and a maintainer who is not an admin are refused", async () => {
    const t = await bench();
    const request = () => ({ requestId: randomUUID(), expectedRevision: null, limits: { commands: 50 } });
    expect((await t.dev(OMAR, "PUT", COMPANY, request())).status).toBe(403);
    t.ageSignIn(OMAR, 30);
    const old = await t.web(OMAR, "PUT", COMPANY, request());
    expect(old.status).toBe(403);
    expect((old.body as { error: { code: string } }).error.code).toBe("REAUTH_REQUIRED");
    expect(t.db.find((item) => item.entityType === "SETUP_LOCKS")).toEqual([]);
    t.ageSignIn(OMAR, 1);
    const ok = await t.web(OMAR, "PUT", COMPANY, request());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: "applied", revision: 1, limits: { commands: 50 } });
    expect((await t.web(OMAR, "GET", COMPANY)).body).toMatchObject({ revision: 1, limits: { commands: 50 } });
  });

  it("a member who is only a project maintainer cannot read or set the company's limits", async () => {
    const t = await bench();
    await t.person(MAYA, "member", "maintainer");
    expect((await t.web(MAYA, "GET", COMPANY)).status).toBe(403);
    expect((await t.web(MAYA, "PUT", COMPANY, { requestId: randomUUID(), expectedRevision: null, limits: { commands: 50 } })).status).toBe(403);
  });

  it("a loosening waits for the other admin, who approves it from the web app; the first admin cannot approve their own", async () => {
    const t = await bench();
    await t.web(OMAR, "PUT", COMPANY, { requestId: randomUUID(), expectedRevision: null, limits: { commands: 40 } });
    const loosen = await t.web(OMAR, "PUT", COMPANY, { requestId: randomUUID(), expectedRevision: 1, limits: { commands: 90 } });
    expect(loosen.status, JSON.stringify(loosen.body)).toBe(202);
    const digest = (loosen.body as { pending: { digest: string } }).pending.digest;
    const own = await t.web(OMAR, "POST", `${COMPANY}/approve`, { requestId: randomUUID(), expectedRevision: 2, expectedDigest: digest });
    expect(own.status).toBeGreaterThanOrEqual(400);
    expect((await t.web(OMAR, "GET", COMPANY)).body).toMatchObject({ limits: { commands: 40 }, pending: { limits: { commands: 90 }, byYou: true } });
    expect((await t.web(OMAR, "PUT", PROJECT, { requestId: randomUUID(), expectedRevision: 0, limits: { commands: 85 } })).status).toBe(400);
    const approved = await t.web(MAYA, "POST", `${COMPANY}/approve`, { requestId: randomUUID(), expectedRevision: 2, expectedDigest: digest });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: "applied", limits: { commands: 90 } });
    // The project could not ask for more than 40 while the lock said 40; now it may.
    expect((await t.web(OMAR, "PUT", PROJECT, { requestId: randomUUID(), expectedRevision: 0, limits: { commands: 85 } })).status).toBe(200);
    expect(((await t.dev(OMAR, "GET", ROUTE)).body as { limits: { commands: number } }).limits.commands).toBe(85);
  });
});
