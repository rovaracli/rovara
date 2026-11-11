// Plan 3 final fix wave, owner decision 2026-10-22 (option D), access I-3: running an older version of an agent.
// A run uses the current version by default. A named version that is not the current one runs when it is no looser than the current one (the comparison a
// publish makes). A looser one answers 202 NEEDS_OWNER_APPROVAL and makes an approval for the agent's owner; the owner confirms it on the page with a fresh
// sign-in, and then the run starts exactly once. Declining or expiry starts nothing. Built-ins below the org's pin follow the same rules.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import { getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor } from "../../packages/broker/src/developer/decide-session.js";
import { BUILTIN_AGENTS } from "@rovara-code/contracts";
import { agentXError } from "@rovara-code/contracts";
import { recipeDigest, type RecipeOverlay, type ResolvedRecipe } from "@rovara-code/contracts";
import { approvalKey, projectAgentKey, projectMemberKey } from "@rovara-code/contracts";
import type { AgentId } from "@rovara-code/contracts";
import { MAYA, createDeveloperTaskBroker, seedMembership, DEV_ISSUER, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const KIT = person("4", "Kit Alvarez"); // a contributor on payments with `use` on the agent
const DANA = person("1", "Dana"); // an org admin
const CELL = new URL(DEV_ISSUER).origin;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

const step = { id: "work", name: "work", kind: "agent" as const, workspace: "none" as const };
const overlay = (access: "read" | "read_write"): RecipeOverlay => ({ instructions: "Summarise the open tickets.", sequence: [step], tools: [{ connector: { type: "linear" }, access }] });
const READ = overlay("read");
const WRITE = overlay("read_write");

type Reply = { status: number; body: Record<string, unknown> };

async function world(options: { builtins?: Record<string, unknown> } = {}) {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { ...(options.builtins === undefined ? {} : { builtins: options.builtins }) }, decide: {} } });
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now, ...(options.builtins === undefined ? {} : { builtins: options.builtins as never }) });
  const enroll = async (who: Developer, role: "member" | "admin") => {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: "oidc", displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  };
  await enroll(KIT, "member");
  await enroll(DANA, "admin");
  h.db.set({ ...projectMemberKey(TEST_ORG, KIT.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: KIT.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const publishNext = async (agentId: AgentId, next: RecipeOverlay) => {
    const draft = (await store.getDraft(TEST_ORG, agentId))!;
    await store.saveDraft({ orgId: TEST_ORG, agentId, overlay: next, expectedRevision: draft.revision, by: MAYA.developerId });
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: MAYA.developerId });
  };
  /** An agent of Maya's, shared with Kit at `use`, on payments' roster, with `versions` published in order (the last is the current one). */
  const agentWith = async (versions: RecipeOverlay[], name = "Ticket looker"): Promise<AgentId> => {
    const created = await call(MAYA, "POST", "/v1/app/agents", { name, overlay: versions[0] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: AgentId }).agentId;
    for (const next of versions) await publishNext(agentId, next);
    h.db.set({ ...projectAgentKey(TEST_ORG, "payments", agentId), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project: "payments", agentId, addedBy: MAYA.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
    const shared = await call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: KIT.developerId }, level: "use" }] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    return agentId;
  };
  const run = (who: Developer, agentId: string, body: Record<string, unknown> = {}) => call(who, "POST", `/v1/app/agents/${agentId}/runs`, { project: "payments", input: { text: "Look at the new ticket" }, ...body });
  const tasks = () => h.db.find((item) => item.entityType === "DEVELOPER_TASK");
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as unknown as Array<{ approvalId: string; status: string; subject: Record<string, unknown>; approvers: { candidates: string[] }; requestedBy: string }>;
  const decideStore = new DecideStore({ documentClient: h.db, tableName: "signin", now: Date.now });
  const session = async (who: Developer, approvalId: string) => {
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    await decideStore.putSession(cookie, { orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    return cookie;
  };
  const raw = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) => await h.handler({
    version: "2.0", rawPath: path, rawQueryString: "", headers, ...(body === undefined ? {} : { body }), requestContext: { requestId: randomUUID(), http: { method } },
  }) as { statusCode: number; headers: Record<string, string>; body: string };
  /** Opens the confirmation page as `who` (signed in just now) and decides it there. */
  const page = async (who: Developer, approvalId: string, decision: "approve" | "decline" | undefined) => {
    const cookie = await session(who, approvalId);
    const headers = { cookie: `${DECIDE_COOKIE}=${cookie}` };
    if (decision === undefined) return raw("GET", `/v1/app/approve/${approvalId}`, headers);
    return raw("POST", `/v1/app/approve/${approvalId}`, { ...headers, origin: CELL, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ decision, csrf: csrfTokenFor(cookie) }).toString());
  };
  const record = async (approvalId: string) => (await getAnyApproval({ documentClient: h.db, tableName: "state" }, TEST_ORG, approvalId))!;
  const status = (approvalId: string) => (h.db.get(approvalKey(TEST_ORG, approvalId).pk, approvalKey(TEST_ORG, approvalId).sk) as { status: string }).status;
  return { ...h, store, call, publishNext, agentWith, run, tasks, approvals, page, record, status };
}

const taskOf = (reply: Reply) => reply.body.task as { taskId: string; agent?: { agentId: string; version: number | string; builtin: boolean } };

describe("a run uses the current version by default, and an older one that is no looser", () => {
  it("runs the current version when none is named, and when it is named", async () => {
    const t = await world();
    const agentId = await t.agentWith([WRITE, READ]);
    const byDefault = await t.run(KIT, agentId);
    expect(byDefault.status, JSON.stringify(byDefault.body)).toBe(202);
    expect(taskOf(byDefault).agent).toMatchObject({ agentId, version: 2 });
    const named = await t.run(KIT, agentId, { version: 2 });
    expect(named.status, JSON.stringify(named.body)).toBe(202);
    expect(taskOf(named).agent).toMatchObject({ version: 2 });
    expect(t.approvals()).toEqual([]);
  });

  it("runs an older version that is no looser than the current one at once, with no approval", async () => {
    const t = await world();
    // Version 1 only reads; version 2 (current) may also change things in Linear: version 1 is the safer one.
    const agentId = await t.agentWith([READ, WRITE]);
    const reply = await t.run(KIT, agentId, { version: 1 });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body).not.toHaveProperty("status");
    expect(taskOf(reply).agent).toMatchObject({ agentId, version: 1 });
    expect(t.approvals()).toEqual([]);
  });
});

describe("an older version that is looser than the current one waits for the owner", () => {
  /** Version 1 may change things in Linear; the current version 2 only reads, as after an owner tightened it. */
  const looser = async () => {
    const t = await world();
    const agentId = await t.agentWith([WRITE, READ], "Payments ops");
    return { t, agentId };
  };

  it("answers 202 NEEDS_OWNER_APPROVAL with the page's link and what is looser, and starts nothing", async () => {
    const { t, agentId } = await looser();
    const reply = await t.run(KIT, agentId, { version: 1 });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const [approval] = t.approvals();
    expect(reply.body).toMatchObject({ status: "NEEDS_OWNER_APPROVAL", confirmUrl: `${CELL}/v1/app/approve/${approval!.approvalId}` });
    expect(reply.body.changes).toEqual([expect.stringContaining("version 1 of Payments ops on payments, which is less safe than the version that runs now (version 2)"), "Lets the agent change things in every linear connector (read and write)"]);
    expect(t.tasks()).toEqual([]);
    expect(approval).toMatchObject({ status: "PENDING", requestedBy: KIT.developerId, subject: { kind: "agent_run_version", agentId, version: 1, expectedCurrentVersion: 2, project: "payments" } });
    // It is asked of the agent's owner (and the org's admins), not of the person who asked.
    expect(approval!.approvers.candidates[0]).toBe(MAYA.developerId);
    expect(approval!.approvers.candidates).not.toContain(KIT.developerId);
  });

  it("answers a repeat of the same request with the same link, and one approval", async () => {
    const { t, agentId } = await looser();
    const requestId = randomUUID();
    const first = await t.run(KIT, agentId, { requestId, version: 1 });
    const again = await t.run(KIT, agentId, { requestId, version: 1 });
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    expect(t.approvals()).toHaveLength(1);
  });

  it("is refused as the start would be, with no approval, when the run could not start anyway", async () => {
    const { t, agentId } = await looser();
    const off = await t.run(KIT, agentId, { version: 1, project: "not-a-project" });
    expect(off.status).toBeGreaterThanOrEqual(400);
    const missing = await t.run(KIT, agentId, { version: 9 });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(t.approvals()).toEqual([]);
  });

  it("names the agent and both versions on the page, and starts the run exactly once when the owner approves it", async () => {
    const { t, agentId } = await looser();
    const requestId = randomUUID();
    await t.run(KIT, agentId, { requestId, version: 1, input: { text: "Triage the payments backlog" } });
    const [approval] = t.approvals();
    const shown = await t.page(MAYA, approval!.approvalId, undefined);
    expect(shown.statusCode, shown.body).toBe(200);
    for (const expected of ["Payments ops", agentId, "Run version 1", "instead of version 2, which runs now", "payments", "Triage the payments backlog", "Kit Alvarez", "Lets the agent change things in every linear connector"]) {
      expect(shown.body, expected).toContain(expected);
    }
    expect(t.tasks()).toEqual([]);

    const done = await t.page(MAYA, approval!.approvalId, "approve");
    expect(done.statusCode, done.body).toBe(200);
    expect(t.status(approval!.approvalId)).toBe("APPROVED_DONE");
    const started = t.tasks();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ developerId: KIT.developerId, project: "payments", agent: { agentId, version: 1, builtin: false } });

    // The same start asked again (the client retried) answers that run: nothing more starts.
    const again = await t.run(KIT, agentId, { requestId, version: 1, input: { text: "Triage the payments backlog" } });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(taskOf(again).taskId).toBe((started[0] as { taskId: string }).taskId);
    expect(t.tasks()).toHaveLength(1);
  });

  it("starts nothing when the owner declines", async () => {
    const { t, agentId } = await looser();
    await t.run(KIT, agentId, { version: 1 });
    const [approval] = t.approvals();
    const declined = await t.page(MAYA, approval!.approvalId, "decline");
    expect(declined.statusCode, declined.body).toBe(200);
    expect(t.status(approval!.approvalId)).toBe("DECLINED");
    expect(t.tasks()).toEqual([]);
  });

  it("starts nothing when it expires", async () => {
    const { t, agentId } = await looser();
    await t.run(KIT, agentId, { version: 1 });
    const [approval] = t.approvals();
    const key = approvalKey(TEST_ORG, approval!.approvalId);
    t.db.set({ ...t.db.get(key.pk, key.sk)!, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const late = await t.page(MAYA, approval!.approvalId, "approve");
    expect(late.statusCode).toBe(409);
    expect(t.tasks()).toEqual([]);
  });

  it("is not started by a token: the sharee who asked can't decide it, and the owner's token is sent to the page", async () => {
    const { t, agentId } = await looser();
    await t.run(KIT, agentId, { version: 1 });
    const [approval] = t.approvals();
    const sharee = await t.call(KIT, "POST", `/v1/app/approvals/${approval!.approvalId}/decide`, { decision: "APPROVE" });
    expect([401, 403]).toContain(sharee.status);
    expect(sharee.body).not.toHaveProperty("approval");
    const owner = await t.call(MAYA, "POST", `/v1/app/approvals/${approval!.approvalId}/decide`, { decision: "APPROVE" });
    expect(owner.status).toBe(401);
    expect(owner.body.error).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(t.status(approval!.approvalId)).toBe("PENDING");
    expect(t.tasks()).toEqual([]);
    // The person who asked can't decide it on the page either.
    const asker = await t.page(KIT, approval!.approvalId, "approve");
    expect(asker.statusCode).toBe(403);
    expect(t.tasks()).toEqual([]);
  });

  it("is stale, and starts nothing, when the version that runs now changed after it was asked", async () => {
    const { t, agentId } = await looser();
    await t.run(KIT, agentId, { version: 1 });
    const [approval] = t.approvals();
    await t.publishNext(agentId, overlay("read"));
    const page = await t.page(MAYA, approval!.approvalId, undefined);
    expect(page.body).toContain("The agent has changed since this was asked");
    const done = await t.page(MAYA, approval!.approvalId, "approve");
    expect(done.body).toContain("did not go through");
    expect(t.status(approval!.approvalId)).toBe("APPROVED_FAILED");
    expect(t.tasks()).toEqual([]);
  });

  it("is also asked of an AI tool's start through the developer route, with the same answer", async () => {
    const { t, agentId } = await looser();
    const reply = await t.call(KIT, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Look at it", agent: { agentId, version: 1 } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body).toMatchObject({ status: "NEEDS_OWNER_APPROVAL", confirmUrl: expect.stringContaining("/v1/app/approve/apr_") as string });
    expect(t.tasks()).toEqual([]);
  });

  // Fix wave re-check, minor 2: a retry through /v1/dev/tasks is answered from the first start before the version is looked at.
  it("answers a retry of an approved, started start with the task that started, not IDEMPOTENCY_CONFLICT, and with or without a title", async () => {
    for (const title of [undefined, "Look at it now"]) {
      const { t, agentId } = await looser();
      const requestId = randomUUID();
      const body = { requestId, project: "payments", instructions: "Look at it", agent: { agentId, version: 1 }, ...(title === undefined ? {} : { title }) };
      const first = await t.call(KIT, "POST", "/v1/dev/tasks", body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      const [approval] = t.approvals();
      expect((await t.page(MAYA, approval!.approvalId, "approve")).statusCode).toBe(200);
      const [started] = t.tasks() as unknown as Array<{ taskId: string }>;
      expect(started).toBeDefined();
      const retry = await t.call(KIT, "POST", "/v1/dev/tasks", body);
      expect(retry.status, JSON.stringify(retry.body)).toBeLessThan(300);
      expect(retry.status).not.toBe(202);
      expect(taskOf(retry).taskId).toBe(started!.taskId);
      expect(t.tasks()).toHaveLength(1);
      expect(t.approvals()).toHaveLength(1);
    }
  });

  it("answers a retry of a start made before the version was tightened with the first task, not 202 and not a new approval", async () => {
    const t = await world();
    // Versions 1 and 2 are equally loose, so version 1 runs at once; version 3 then tightens the agent and makes version 1 less safe than the one that runs now.
    const agentId = await t.agentWith([WRITE, { ...WRITE, instructions: "Summarise the open tickets, twice." }], "Payments ops");
    const requestId = randomUUID();
    const body = { requestId, project: "payments", instructions: "Look at it", agent: { agentId, version: 1 } };
    const first = await t.call(KIT, "POST", "/v1/dev/tasks", body);
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const firstTask = taskOf(first).taskId;
    expect(t.tasks()).toHaveLength(1);
    await t.publishNext(agentId, READ);
    const retry = await t.call(KIT, "POST", "/v1/dev/tasks", body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(first.status);
    expect(retry.body).not.toHaveProperty("status", "NEEDS_OWNER_APPROVAL");
    expect(taskOf(retry).taskId).toBe(firstTask);
    expect(t.tasks()).toHaveLength(1);
    expect(t.approvals()).toEqual([]);
    // A new request id for the same start is a new start, and now waits for the owner.
    const fresh = await t.call(KIT, "POST", "/v1/dev/tasks", { ...body, requestId: randomUUID() });
    expect(fresh.status).toBe(202);
  });

  it("is refused for a start no person made, which has nobody to ask", async () => {
    const { t, agentId } = await looser();
    const starter = createAgentRunStarter(t.brokerInput as never)!;
    const { startAgentRun } = await import("../../packages/broker/src/agents/runs.js");
    const refused = await startAgentRun(starter, {
      requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId, version: 1 }, input: { text: "go" }, origin: "event", owner: { developerId: MAYA.developerId },
      payer: { kind: "member", developerId: MAYA.developerId },
    }).then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }));
    expect(refused).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("less safe than the version that runs now") as string });
    expect(t.tasks()).toEqual([]);
  });
});

describe("the version list marks each version against the current one", () => {
  it("says which are the same or safer, and which are less safe and need the owner's OK", async () => {
    const t = await world();
    // 1: writes (looser than 3); 2: reads (as safe as 3); 3: reads, the current one.
    const agentId = await t.agentWith([WRITE, READ, overlay("read")], "Payments ops");
    const listed = await t.call(KIT, "GET", `/v1/app/agents/${agentId}/versions`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const versions = listed.body.versions as Array<Record<string, unknown>>;
    expect(versions.map((version) => [version.version, version.current, version.safety, version.needsOwnerOk])).toEqual([
      [1, false, "less_safe", true], [2, false, "same_or_safer", false], [3, true, "current", false],
    ]);
    expect(versions[0]!.lessSafe).toEqual(["Lets the agent change things in every linear connector (read and write)"]);
  });
});

describe("built-in agents below the org's pin follow the same rules", () => {
  /** ticket-triage: release 1 reads and changes things in "docs", release 2 (the pin) only reads. */
  function releases() {
    const shipped = BUILTIN_AGENTS["ticket-triage"].versions[0]!.recipe;
    const widened: ResolvedRecipe = { ...structuredClone(shipped), tools: [...structuredClone(shipped.tools), { connector: { name: "docs" }, access: "read_write" }] };
    const state = { latest: 1, widenedIsFirst: true };
    return {
      state,
      source: {
        currentVersion: (id: string) => (id === "ticket-triage" ? state.latest : 1),
        defaultPin: (id: string) => (id === "ticket-triage" ? state.latest : 1),
        recipe: (id: string, version: number) => {
          if (id !== "ticket-triage") return structuredClone(BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].versions[0]!.recipe);
          if (version < 1 || version > 2) throw agentXError("NOT_FOUND", `ticket-triage has no version ${String(version)}`);
          return structuredClone(state.widenedIsFirst ? (version === 1 ? widened : shipped) : (version === 1 ? shipped : widened));
        },
        name: (id: string) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
      },
    };
  }

  it("runs a release below the pin that is no looser, and asks an org admin for one that is looser", async () => {
    const { source, state } = releases();
    const t = await world({ builtins: source });
    await t.store.ensureBuiltinSettings(TEST_ORG, "ticket-triage");
    state.latest = 2;
    await t.store.adoptBuiltinVersion({ orgId: TEST_ORG, agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1, by: DANA.developerId });
    // Release 1 (widened) is looser than the pin (release 2): it waits for an org admin.
    const waiting = await t.run(KIT, "ticket-triage", { version: 1 });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(202);
    expect(waiting.body).toMatchObject({ status: "NEEDS_OWNER_APPROVAL" });
    expect(t.tasks()).toEqual([]);
    const [approval] = t.approvals();
    expect(approval).toMatchObject({ subject: { kind: "agent_run_version", agentId: "ticket-triage", version: 1, expectedCurrentVersion: 2 }, approvers: { candidates: [DANA.developerId] } });
    const refused = await t.page(MAYA, approval!.approvalId, "approve");
    expect(refused.statusCode).toBe(403);
    expect((await t.page(DANA, approval!.approvalId, "approve")).statusCode).toBe(200);
    expect(t.tasks()).toHaveLength(1);
    expect(t.tasks()[0]).toMatchObject({ agent: { agentId: "ticket-triage", version: 1, builtin: true } });
    // The pin itself runs by default, and the list says which is which.
    expect((await t.run(KIT, "ticket-triage")).status).toBe(202);
    const listed = await t.call(KIT, "GET", "/v1/app/agents/ticket-triage/versions");
    expect((listed.body.versions as Array<Record<string, unknown>>).map((version) => [version.version, version.safety])).toEqual([[1, "less_safe"], [2, "current"]]);
  });

  it("runs a release below the pin that is no looser at once", async () => {
    const { source, state } = releases();
    state.widenedIsFirst = false;
    const t = await world({ builtins: source });
    await t.store.ensureBuiltinSettings(TEST_ORG, "ticket-triage");
    state.latest = 2;
    await t.store.adoptBuiltinVersion({ orgId: TEST_ORG, agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1, by: DANA.developerId });
    const reply = await t.run(KIT, "ticket-triage", { version: 1 });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body).not.toHaveProperty("status");
    expect(t.approvals()).toEqual([]);
    expect(t.tasks()).toHaveLength(1);
  });
});
