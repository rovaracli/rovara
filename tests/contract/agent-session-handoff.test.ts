// Plan 5 Task 19: moving a session between a Mac and the cloud. It is ONE session and ONE link across the moves; each stretch on a place is a leg. The authority is the session's
// owner's alone, the destination's rules apply (the company's rule for local agents on a Mac; the project role, the archive state and the owner's budget for the cloud, which is paid
// work), and the legs are atomic: the session is never in two places and never lost if one side fails. Plan 6's `HandoffRuntime` is a fake here.
import { randomUUID } from "node:crypto";
import { PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { SESSION_LEGS_MAX, agentSessionKey, agentXError, liveSessionKey, INDEX_EXPIRY_ATTRIBUTE, SESSION_RETENTION_DAYS, projectMetaKey, sessionEventId, type OrgId } from "@rovara-code/contracts";
import { deviceKey, deviceSessionKey, orgSettingsKey, userChannel, type OrgRole } from "@agentx/cloud-contracts";
import { registerDevice } from "../../packages/broker/src/devices/store.js";
import { recordLocalUpdate, registerLocalSession, listDeviceCommands } from "../../packages/broker/src/devices/local-sessions.js";
import { routeDeviceRequest } from "../../packages/broker/src/devices/routes.js";
import { handoffCancelRequestId, handoffSession, handoffTaskId, makeHandoffRecovery, type HandoffDependencies, type HandoffRuntime } from "../../packages/broker/src/agent-sessions/handoff.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { drainEndedSessions, sweepAgentSessions } from "../../packages/broker/src/agent-sessions/sweep.js";
import { AgentSessionStore } from "../../packages/broker/src/agent-sessions/store.js";
import { sessionView } from "../../packages/broker/src/agent-sessions/read.js";
import { stopSession, type SessionControlHost } from "../../packages/broker/src/agent-sessions/stop.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const iso = (ms: number) => new Date(ms).toISOString();
const hex = (digit: string) => digit.repeat(64);
const SHA = "a".repeat(40);
const SHA_PUSHED = "b".repeat(40);
const NOT_READY = "Moving a session between a Mac and the cloud isn't ready yet.";
const RUNTIME_UNAVAILABLE = "RUNTIME_UNAVAILABLE";

function world(options: { runtime?: boolean; admit?: boolean; control?: boolean } = {}) {
  const w = sessionWorld();
  w.member(ORG_A, hex("1"), "member");
  const log: Array<Record<string, unknown>> = [];
  const published: Array<{ channel: string; events: string[] }> = [];
  const deviceDeps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, log: (entry: Record<string, unknown>) => { log.push(entry); } };
  const calls = {
    starts: [] as Array<Record<string, unknown>>, pushes: [] as Array<Record<string, unknown>>, cancels: [] as Array<{ taskId: string; requestId: string }>,
    admissions: [] as Array<{ payer: unknown; project: string; agentId: string; path: string }>, order: [] as string[],
    /** The session as the cancel found it: the claim (revision and marker) must be in place before anything is cancelled. */
    linkTries: 0,
    atCancel: [] as Array<{ revision: unknown; moving: unknown; owner: unknown }>, systemCancels: [] as Array<{ taskId: string; requestId: string }>,
  };
  const live = {
    startFailure: undefined as Error | undefined, pushFailure: undefined as Error | undefined, cancelFailure: undefined as Error | undefined, budgetRefusal: undefined as string | undefined,
    proxyDown: false, onStart: undefined as undefined | ((call: number) => Promise<void>), push: { repository: "acme/web", branch: "rovara/fix-checkout", headSha: SHA_PUSHED } as unknown,
    repositories: [{ name: "web", url: "https://github.com/acme/web" }] as Array<{ name: string; url: string }>, repositoriesBroken: false,
    /** Runs inside the cancel, as another request would in the moment between the claim and the write. */
    onCancel: undefined as undefined | (() => Promise<void> | void), noMarker: false, wrongTaskId: false, marker: undefined as undefined | { sessionId: string; requestId: string }, badAnswer: false, dieAfterCreate: false,
  };
  /** Runs once, just before the next move's transaction is sent: what another request or the Mac does in the moment between the move's last read and its write. */
  const race = { before: undefined as undefined | (() => Promise<void> | void), beforeClaim: undefined as undefined | (() => Promise<void> | void), beforeCancelClaim: undefined as undefined | (() => Promise<void> | void), beforePending: undefined as undefined | (() => Promise<void> | void) };
  const client = {
    send: async (command: Parameters<typeof w.db.send>[0]) => {
      if (command instanceof UpdateCommand && race.beforeCancelClaim !== undefined && JSON.stringify(command.input).includes(":cancelling")) {
        const run = race.beforeCancelClaim;
        race.beforeCancelClaim = undefined;
        await run();
      }
      if (command instanceof PutCommand && race.beforePending !== undefined && JSON.stringify(command.input).includes("AGENT_SESSION_HANDOFF_PENDING")) {
        const run = race.beforePending;
        race.beforePending = undefined;
        await run();
      }
      if (command instanceof TransactWriteCommand && race.beforeClaim !== undefined && JSON.stringify(command.input).includes(":moving")) {
        const run = race.beforeClaim;
        race.beforeClaim = undefined;
        await run();
      }
      if (command instanceof TransactWriteCommand && JSON.stringify(command.input).includes("LEG#000002")) calls.linkTries += 1;
      if (command instanceof TransactWriteCommand && race.before !== undefined && JSON.stringify(command.input).includes("LEG#0000")) {
        const run = race.before;
        race.before = undefined;
        await run();
      }
      return w.db.send(command);
    },
  };
  const started = new Map<string, string>();
  const runtime: HandoffRuntime = {
    startOnBranch: async (_deps, input) => {
      calls.order.push("start");
      calls.starts.push({ ...input });
      if (live.startFailure !== undefined) throw live.startFailure;
      await live.onStart?.(calls.starts.length);
      const prior = started.get(input.requestId);
      if (prior !== undefined) return { taskId: prior };
      const taskId = live.wrongTaskId ? randomUUID() : input.taskId;
      // As Plan 6's start leaves a task: the owner's, on the project, with no session of its own yet (this module names the session on it).
      w.db.set({
        ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: input.orgId, developerId: input.owner.developerId, developerName: input.owner.name, provider: "oidc", project: input.project,
        workspaceId: randomUUID(), ownerKey: `owner-${input.owner.developerId.slice(0, 6)}`, payer: { kind: "member", developerId: input.owner.developerId }, createdAt: iso(w.clock.now), updatedAt: iso(w.clock.now),
        ...(live.noMarker ? {} : { handoffOf: live.marker ?? input.handoffOf }),
      });
      started.set(input.requestId, taskId);
      if (live.dieAfterCreate) { live.dieAfterCreate = false; throw new Error("the process died after the task was made"); }
      return live.badAnswer ? { taskId: "not-a-task-id" } : { taskId };
    },
    cancelStarted: async (_deps, input) => {
      calls.systemCancels.push({ taskId: input.taskId, requestId: input.requestId });
      const task = w.db.get(taskKey(input.taskId)) as Item | undefined;
      if (task !== undefined) w.db.set({ ...task, cancelledBySystem: true });
    },
    pushToBranch: async (_deps, input) => {
      calls.order.push("push");
      calls.pushes.push({ ...input });
      if (live.pushFailure !== undefined) throw live.pushFailure;
      return live.push as never;
    },
  };
  const control: SessionControlHost = {
    cancelTask: async (task, requestId) => {
      calls.order.push("cancel");
      calls.cancels.push({ taskId: task.taskId, requestId });
      const meta = task.sessionId === undefined ? undefined : (w.db.get(agentSessionKey(ORG_A, task.sessionId, "META")) as Item | undefined);
      calls.atCancel.push({ revision: meta?.["revision"], moving: meta?.["moving"], owner: meta?.["owner"] });
      await live.onCancel?.();
      if (live.cancelFailure !== undefined) throw live.cancelFailure;
    },
    retryWorkflow: async () => { throw new Error("not asked"); },
    startAgentRun: async () => { throw new Error("not asked"); },
  };
  const deps: HandoffDependencies = {
    documentClient: client, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64), log: (entry) => { log.push(entry); },
    taskView: async (task) => ({ taskId: task.taskId, title: "Fix the flaky checkout test", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: iso(T0), updatedAt: iso(T0), events: [] }) as never,
    ...(options.runtime === false ? {} : { handoff: runtime }),
    ...(options.control === false ? {} : { control }),
    ...(options.admit === false ? {} : {
      admitPayer: async (input) => {
        calls.admissions.push({ payer: input.payer, project: input.project, agentId: input.agentId, path: input.path });
        if (live.proxyDown) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the proxy is down");
        if (live.budgetRefusal !== undefined) throw agentXError("BUDGET_EXCEEDED", live.budgetRefusal);
      },
    }),
    projectRepositories: async () => {
      if (live.repositoriesBroken) throw new Error("projects unreadable");
      return live.repositories;
    },
    realtimePublish: {
      endpoint: "https://events.example.com/event", region: "us-east-1", credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetch: (async (_url: unknown, init: { body: string }) => { published.push(JSON.parse(init.body) as { channel: string; events: string[] }); return new Response("{}", { status: 200 }); }) as never,
    },
  };
  const as = (developerId: string, orgRole: OrgRole = "member", orgId: OrgId = ORG_A): DeveloperCaller => ({ ...w.caller(developerId, orgId), orgRole });
  const mac = async (who: string, label = "Priya's MacBook", orgId: OrgId = ORG_A): Promise<string> =>
    (await registerDevice(deviceDeps, as(who, "member", orgId), { requestId: randomUUID(), label, platform: "mac" })).deviceId;
  const setPolicy = (policy: { allowed?: boolean; tools?: string[]; projects?: "all" | string[] }) => w.db.set({
    ...orgSettingsKey(ORG_A, "LOCAL_AGENTS"), entityType: "ORG_LOCAL_AGENTS", orgId: ORG_A, allowed: policy.allowed ?? true,
    tools: policy.tools ?? ["rovara", "claude-code", "codex", "gemini-cli", "cursor-cli"], projects: policy.projects ?? "all", revision: 1,
  });
  const taskOf = (taskId: string) => w.db.get(taskKey(taskId)) as Item | undefined;
  const meta = (sessionId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, "META")) as Item;
  const local = (sessionId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, "LOCAL")) as Item | undefined;
  const under = (sessionId: string, prefix: string) => w.db.find((item) => item.pk === agentSessionKey(ORG_A, sessionId, "META").pk && String(item.sk).startsWith(prefix));
  const commands = (deviceId: string) => w.db.find((item) => item.pk === deviceKey(ORG_A, deviceId).pk && String(item.sk).startsWith("COMMAND#"));
  const patchSession = (sessionId: string, fields: Record<string, unknown>) => w.db.set({ ...meta(sessionId), ...fields });

  /** A session of Priya's Mac on web, shared with Arjun (view). */
  const onMac = async (extra: Record<string, unknown> = {}, label = "Priya's MacBook") => {
    const deviceId = await mac(PRIYA, label);
    const { sessionId } = await registerLocalSession({ ...deps }, as(PRIYA), {
      requestId: randomUUID(), deviceId, tool: "claude-code", title: "Fix the flaky checkout test", project: "web", startedAt: iso(T0 - 120_000),
      shares: [{ principal: { kind: "member", developerId: ARJUN }, level: "view" }], ...extra,
    });
    return { sessionId, deviceId };
  };
  /** A cloud task session of Priya's on web (the task, its first leg, its tile and its sweep entry as the start writes them). */
  const inCloud = (options: { owner?: string; agent?: boolean | "rovara-code" } = {}) => {
    const seeded = w.seedSession({ owner: options.owner ?? PRIYA });
    const subject = { kind: "task", taskId: seeded.taskId };
    const leg = { seq: 1, subject, where: { kind: "cloud" }, startedAt: "2026-10-22T08:00:00.000Z" };
    patchSession(seeded.sessionId, { legs: [leg], payer: { kind: "member", developerId: options.owner ?? PRIYA } });
    w.db.set({ ...agentSessionKey(ORG_A, seeded.sessionId, "LEG#000001"), entityType: "AGENT_SESSION_LEG", orgId: ORG_A, sessionId: seeded.sessionId, ...leg });
    w.db.set({ ...liveSessionKey(ORG_A, seeded.sessionId), entityType: "LIVE_SESSION", orgId: ORG_A, sessionId: seeded.sessionId, kind: "task", project: "web", ownerId: options.owner ?? PRIYA, status: "running", createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z" });
    // As `startTask` leaves every task when agents are set up: the built-in Rovara Code agent is on the task (and a workflow runs the work).
    if (options.agent === "rovara-code") w.db.set({ ...taskOf(seeded.taskId), agent: { agentId: "rovara-code", name: "Rovara Code", version: 1, builtin: true, digest: "d".repeat(64) }, workflow: { revision: 2, stage: "IMPLEMENT", state: "WAITING" } });
    if (options.agent === true) w.db.set({ ...taskOf(seeded.taskId), agent: { agentId: "ticket-triage", name: "Ticket triage", version: 2, builtin: false, digest: "d".repeat(64) } });
    return seeded;
  };
  const body = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), to: "cloud", repository: "acme/web", branch: "feat/checkout-fix", headSha: SHA, summary: "The retry test passes; the flaky wait is still to fix.", ...extra });
  const toMac = (deviceId: string, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), to: "mac", deviceId, ...extra });
  const move = (who: string, sessionId: string, input: unknown, orgId: OrgId = ORG_A, orgRole: OrgRole = "member") => handoffSession(deps, as(who, orgRole, orgId), sessionId, input);
  const view = (who: string, sessionId: string, orgId: OrgId = ORG_A) => sessionView(deps, as(who, "member", orgId), sessionId);
  const writes = () => w.db.transactions().length;
  const removeDevice = (who: string, deviceId: string) => {
    const path = `/v1/app/devices/${deviceId}`;
    return routeDeviceRequest(deviceDeps, as(who), { method: "DELETE", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`));
  };
  const post = (who: string, sessionId: string, input: unknown, orgId: OrgId = ORG_A) => {
    const path = `/v1/app/sessions/${sessionId}/handoff`;
    // The route reads the project's repositories from Plan 3's approvals dependencies, as the broker supplies them.
    return routeAgentSessionRequest({ ...deps, approvals: { ...deps } as never }, as(who, "member", orgId), { method: "POST", path, headers: {}, body: JSON.stringify(input), requestId: "r" }, new URL(`${CELL}${path}`));
  };
  /** Priya's Mac session, followed by Max (maintainer of web, not shared) and by Arjun (shared). */
  return { ...w, log, published, deviceDeps, calls, live, race, runtime, control, deps, as, mac, setPolicy, meta, local, under, commands, taskOf, patchSession, onMac, inCloud, body, toMac, move, view, writes, removeDevice, post };
}

describe("a session on a Mac moves to the cloud", () => {
  it("keeps its id, link, followers, shares and comments, gains leg 2 with the new task, and tells its Mac to stop", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    // A follower, a comment and a share exist before the move.
    w.follower(ORG_A, sessionId, ARJUN);
    w.patchSession(sessionId, { followerCount: 1 });
    w.db.set({ ...agentSessionKey(ORG_A, sessionId, "MESSAGE#000001"), entityType: "AGENT_SESSION_MESSAGE", orgId: ORG_A, sessionId, text: "Looks right to me" });
    const input = w.body();
    const before = w.writes();
    const reply = await w.move(PRIYA, sessionId, input);

    // The cloud task was started on the pushed branch, as the session's owner, with the title as its text and the summary as information.
    expect(w.calls.starts).toHaveLength(1);
    expect(w.calls.starts[0]).toMatchObject({
      orgId: ORG_A, project: "web", owner: { developerId: PRIYA, name: "Priya" }, repository: "acme/web", branch: "feat/checkout-fix", headSha: SHA,
      input: { text: "Fix the flaky checkout test", context: [{ kind: "text", ref: "handoff", title: "Where the work stands", body: "The retry test passes; the flaky wait is still to fix." }] },
    });
    const taskId = (w.meta(sessionId).subject as { taskId: string }).taskId;
    expect(w.db.find((item) => item.entityType === "DEVELOPER_TASK").map((item) => item["taskId"])).toEqual([taskId]);
    expect(w.meta(sessionId)).toMatchObject({
      sessionId, kind: "task", subject: { kind: "task", taskId }, where: { kind: "cloud" }, payer: { kind: "member", developerId: PRIYA }, owner: { developerId: PRIYA }, followerCount: 1,
      project: "web", title: "Fix the flaky checkout test", revision: 2,
    });
    const legs = w.meta(sessionId).legs as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ seq: 1, subject: { kind: "local", deviceId }, where: { kind: "mac", deviceId }, endedAt: iso(T0), endedBy: "handoff" });
    expect(legs[1]).toMatchObject({ seq: 2, subject: { kind: "task", taskId }, where: { kind: "cloud" }, startedAt: iso(T0) });
    expect(legs[1]).not.toHaveProperty("endedAt");
    expect(w.under(sessionId, "LEG#")).toHaveLength(2);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, "LEG#000001"))).toMatchObject({ endedBy: "handoff", endedAt: iso(T0) });
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, "LEG#000002"))).toMatchObject({ seq: 2, subject: { kind: "task", taskId } });
    // The task names the session; the Mac's entry for it is gone and the tile follows the move.
    expect(w.taskOf(taskId)).toMatchObject({ sessionId, orgId: ORG_A, developerId: PRIYA });
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toBeUndefined();
    expect(w.db.get(liveSessionKey(ORG_A, sessionId))).toMatchObject({ kind: "task", where: { kind: "cloud" } });
    // Followers, shares and comments stay.
    expect(w.under(sessionId, "FOLLOWER#")).toHaveLength(1);
    expect(w.under(sessionId, "SHARE#")).toHaveLength(1);
    expect(w.under(sessionId, "MESSAGE#")).toHaveLength(1);
    // The Mac is told to stop: one command, naming the session, from the owner.
    const stops = w.commands(deviceId);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", sessionId, by: { developerId: PRIYA, name: "Priya" } });
    // The handoff event and one transaction for the whole move (plus the request item in it).
    const events = w.under(sessionId, "EVENT#").filter((event) => event.type === "handoff");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: "Priya moved this session to the cloud.", actor: { kind: "member", developerId: PRIYA } });
    expect(w.writes()).toBeGreaterThan(before);
    expect(reply).toMatchObject({ session: { sessionId, where: { kind: "cloud" } } });
  });

  it("is one transaction of fewer than 100 items that carries the legs, the task, the device entry, the stop, the event and the request together", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    const before = w.writes();
    await w.move(PRIYA, sessionId, w.body());
    // The move itself is one transaction; the summary refresh after it is a separate (best effort) one.
    const moves = w.db.transactions().slice(before).filter((tx) => tx.some((item) => JSON.stringify(item).includes("LEG#000002")));
    expect(moves).toHaveLength(1);
    const tx = moves[0]!;
    expect(tx.length).toBeLessThan(100);
    const text = JSON.stringify(tx);
    for (const part of ["LEG#000001", "LEG#000002", `SESSION#${sessionId}`, "COMMAND#", "REQUEST#", "handoff", "DEVTASK#"]) expect(text).toContain(part);
    expect(w.commands(deviceId)).toHaveLength(1);
    // The tile moves in the same transaction (the summary refresh after it may rewrite it, so the transaction's own item is what is checked).
    const tile = tx.find((item) => JSON.stringify(item).includes("LIVE_SESSIONS"))!;
    expect(JSON.stringify(tile)).toContain('":kind":"task"');
    // The Mac hears of its command through the owner's channel.
    expect(w.published.some((post) => post.channel === userChannel(ORG_A, PRIYA) && post.events.some((event) => event.includes("device.command")))).toBe(true);
  });

  it("makes the session follow the task rules from now on: the project's maintainer sees it, who could not see the Mac session", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    expect(await code(w.view(MAX, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    await w.move(PRIYA, sessionId, w.body());
    await expect(w.view(MAX, sessionId)).resolves.toMatchObject({ sessionId, you: { level: "edit" } });
    await expect(w.view(MIA, sessionId)).resolves.toMatchObject({ sessionId, you: { level: "view" } });
    expect(await code(w.view(ZED, sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a repository outside the session's project with the exact text, without calling the runtime or writing", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const before = w.db.items.size;
    expect(await code(w.move(PRIYA, sessionId, w.body({ repository: "acme/billing" })))).toEqual({ code: "CONFIG_INVALID", message: "acme/billing isn't part of web." });
    expect(w.calls.starts).toEqual([]);
    expect(w.calls.admissions).toEqual([]);
    expect(w.db.items.size).toBe(before);
    // The project's repositories are compared as GitHub does (case-insensitively), and the runtime gets the project's own spelling.
    await w.move(PRIYA, sessionId, w.body({ repository: "Acme/Web" }));
    expect(w.calls.starts[0]).toMatchObject({ repository: "acme/web" });
  });

  it("fails closed when the project's repositories cannot be read, and when the deployment cannot list them", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.live.repositoriesBroken = true;
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    const noList = world();
    const second = await noList.onMac();
    delete (noList.deps as { projectRepositories?: unknown }).projectRepositories;
    expect(await code(noList.move(PRIYA, second.sessionId, noList.body()))).toEqual({ code: RUNTIME_UNAVAILABLE, message: NOT_READY });
    expect(w.calls.starts).toEqual([]);
    expect(noList.calls.starts).toEqual([]);
  });

  it("is the owner's alone: a person who can edit, a person who can view, a maintainer and an org admin are refused with the exact text and nothing runs", async () => {
    const w = world();
    const { sessionId } = await w.onMac({ shares: [{ principal: { kind: "member", developerId: MAX }, level: "edit" }, { principal: { kind: "member", developerId: ARJUN }, level: "view" }] });
    const before = w.db.items.size;
    for (const [who, role] of [[MAX, "member"], [ARJUN, "member"]] as const) {
      expect(await code(w.move(who, sessionId, w.body(), ORG_A, role))).toEqual({ code: "FORBIDDEN", message: "Only Priya can move this session." });
    }
    // An org admin has no level on a Mac session at all: it does not exist for them.
    expect(await code(w.move(OLA, sessionId, w.body(), ORG_A, "admin"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.move(ZED, sessionId, w.body()))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.move(BO, sessionId, w.body(), ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.calls.starts).toEqual([]);
    expect(w.calls.admissions).toEqual([]);
    expect(w.db.items.size).toBe(before);
  });

  it("belongs to whoever owns the session now: after a take-over the new owner moves it and the previous owner may not", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    // Priya's cloud session was taken over by Max (the session and its task move together).
    w.patchSession(sessionId, { owner: { developerId: MAX, name: "Max" } });
    const task = w.taskOf((w.meta(sessionId).subject as { taskId: string }).taskId)!;
    w.db.set({ ...task, currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: iso(T0) } });
    const device = await w.mac(MAX, "Max's MacBook");
    expect(await code(w.move(PRIYA, sessionId, w.toMac(device)))).toEqual({ code: "FORBIDDEN", message: "Only Max can move this session." });
    expect(w.calls.cancels).toEqual([]);
  });

  it("answers the exact RUNTIME_UNAVAILABLE text with no runtime, before anything is written", async () => {
    const w = world({ runtime: false });
    const { sessionId } = await w.onMac();
    const before = w.db.items.size;
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: RUNTIME_UNAVAILABLE, message: NOT_READY });
    expect(w.db.items.size).toBe(before);
    expect(w.calls.admissions).toEqual([]);
  });

  it("does not move a chain run, which stays in the cloud", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ kind: "chain" });
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "CONFIG_INVALID", message: "A chain run stays in the cloud." });
    expect(w.calls.starts).toEqual([]);
  });

  it("starts one task for one request id: a repeat answers the stored outcome and writes nothing", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const input = w.body();
    const first = await w.move(PRIYA, sessionId, input);
    const before = w.db.items.size;
    const writesBefore = w.writes();
    const again = await w.move(PRIYA, sessionId, input);
    expect(w.calls.starts).toHaveLength(1);
    expect(w.calls.admissions).toHaveLength(1);
    expect(w.db.items.size).toBe(before);
    expect(w.writes()).toBe(writesBefore);
    expect(again).toMatchObject({ session: { sessionId, where: { kind: "cloud" } } });
    expect(again).toEqual(first);
    expect(w.under(sessionId, "LEG#")).toHaveLength(2);
    // The same id with another body is a mistake; the same id for another action is one too.
    expect(await code(w.move(PRIYA, sessionId, { ...input, summary: "Something else entirely" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(stopSession(w.deps, { ...w.as(PRIYA), name: "Priya" }, sessionId, { requestId: input.requestId }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("a commit whose outcome is unknown, and the session not linked: the task it started is cancelled, the Mac session goes on alone, and the same request id then starts a fresh task", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    const input = w.body();
    w.db.injectFault({ command: "TransactWriteCommand", match: (tx) => JSON.stringify(tx).includes("LEG#000002"), error: { name: "InternalServerError" } });
    await expect(w.move(PRIYA, sessionId, input)).rejects.toMatchObject({ name: "InternalServerError" });
    // Nothing of the move is there: the session is still on the Mac, leg 1 is open, no command, the task has no session.
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", where: { kind: "mac" }, revision: 1 });
    expect(w.under(sessionId, "LEG#")).toHaveLength(1);
    expect(w.commands(deviceId)).toEqual([]);
    // Nobody pays for a task that nobody sees, and the branch is worked in one place only.
    const taskIds = () => w.db.find((item) => item.entityType === "DEVELOPER_TASK").map((item) => item["taskId"] as string);
    expect(taskIds()).toHaveLength(1);
    expect(w.calls.cancels.map((call) => call.taskId)).toEqual(taskIds());
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`))).toMatchObject({ state: "abandoned", attempt: 1 });
    // The same request id later is a new attempt with a new task (the cancelled one is never linked).
    await w.move(PRIYA, sessionId, input);
    expect(w.calls.starts).toHaveLength(2);
    expect(w.calls.starts[0]!["requestId"]).not.toBe(w.calls.starts[1]!["requestId"]);
    expect(w.calls.starts[0]!["taskId"]).not.toBe(w.calls.starts[1]!["taskId"]);
    expect(taskIds()).toHaveLength(2);
    expect(w.meta(sessionId).subject).toMatchObject({ kind: "task", taskId: w.calls.starts[1]!["taskId"] });
    expect(w.calls.cancels).toHaveLength(1);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`))).toBeUndefined();
  });

  it("a commit that was actually written but whose answer was lost is found, not cancelled", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const input = w.body();
    // The table commits, then the answer is lost.
    const original = w.deps.documentClient;
    let lose = true;
    w.deps.documentClient = { send: async (command) => { const reply = await original.send(command); if (lose && command instanceof TransactWriteCommand && JSON.stringify(command.input).includes("LEG#000002")) { lose = false; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); } return reply; } };
    await expect(w.move(PRIYA, sessionId, input)).resolves.toMatchObject({ session: { where: { kind: "cloud" } } });
    expect(w.calls.cancels).toEqual([]);
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", revision: 2 });
  });

  it("gives each request id its own runtime request id, tied to the org and the session", async () => {
    const w = world();
    const first = await w.onMac();
    const second = await w.onMac();
    await w.move(PRIYA, first.sessionId, w.body());
    await w.move(PRIYA, second.sessionId, w.body());
    const ids = w.calls.starts.map((call) => call["requestId"] as string);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("the cloud leg is paid work", () => {
  it("checks the owner's budget for the project before starting anything, as the payer and as a task", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    await w.move(PRIYA, sessionId, w.body());
    expect(w.calls.admissions).toEqual([{ payer: { kind: "member", developerId: PRIYA }, project: "web", agentId: "rovara-code", path: "TASK" }]);
    expect(w.calls.order).toEqual(["start"]);
  });

  it("refuses with the budget's own words when the owner has no room: nothing starts and nothing is written", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.live.budgetRefusal = "Your budget is used up.";
    const before = w.db.items.size;
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "BUDGET_EXCEEDED", message: "Your budget is used up." });
    expect(w.calls.starts).toEqual([]);
    expect(w.db.items.size).toBe(before);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 1 });
  });

  it("charges the owner, not the person who asks: a project viewer who is not the owner never reaches the check", async () => {
    const w = world();
    const { sessionId } = await w.onMac({ shares: [{ principal: { kind: "member", developerId: MAX }, level: "edit" }] });
    expect(await code(w.move(MAX, sessionId, w.body()))).toMatchObject({ code: "FORBIDDEN" });
    expect(w.calls.admissions).toEqual([]);
  });

  it("fails closed when the budget cannot be checked at all, or the check cannot reach the proxy", async () => {
    const none = world({ admit: false });
    const { sessionId } = await none.onMac();
    expect(await code(none.move(PRIYA, sessionId, none.body()))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(none.calls.starts).toEqual([]);
    const down = world();
    const mac = await down.onMac();
    down.live.proxyDown = true;
    expect(await code(down.move(PRIYA, mac.sessionId, down.body()))).toEqual({ code: RUNTIME_UNAVAILABLE, message: "Rovara couldn't check the budget just now. Try again in a moment." });
    expect(down.calls.starts).toEqual([]);
    down.live.proxyDown = false;
    await expect(down.move(PRIYA, mac.sessionId, down.body())).resolves.toBeDefined();
  });

  it("needs a project role that starts work, read now: a viewer, or a person who lost the role, is refused", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.grant(PRIYA, "web", "viewer");
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "FORBIDDEN", message: "You need a role on web that can start work to move this to the cloud." });
    w.members.revoke(ORG_A, "web", PRIYA);
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "FORBIDDEN", message: "You need a role on web that can start work to move this to the cloud." });
    expect(w.calls.starts).toEqual([]);
    expect(w.calls.admissions).toEqual([]);
  });

  it("refuses a project that is archived, and a session with no project", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.db.set({ ...(w.db.get(projectMetaKey(ORG_A, "web")) as Item), status: "archived" });
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(w.calls.starts).toEqual([]);
    const free = world();
    const other = await free.onMac({ project: undefined });
    expect(await code(free.move(PRIYA, other.sessionId, free.body()))).toEqual({ code: "CONFIG_INVALID", message: "This session isn't on a project, so it can't move to the cloud." });
    expect(free.calls.starts).toEqual([]);
  });

  it("does not start a second cloud task when the session is already in the cloud", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    await w.move(PRIYA, sessionId, w.body());
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "CONFIG_INVALID", message: "This session is already in the cloud." });
    expect(w.calls.starts).toHaveLength(1);
    expect(w.calls.admissions).toHaveLength(1);
  });
});

describe("a move to the cloud never loses the session", () => {
  it("leaves the session on the Mac, untouched, when the cloud task cannot start, and the same request can be tried again", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    const input = w.body();
    const before = w.db.items.size;
    w.live.startFailure = agentXError("RUNTIME_UNAVAILABLE", "the branch could not be read");
    expect(await code(w.move(PRIYA, sessionId, input))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.db.items.size).toBe(before + 1);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", where: { kind: "mac", deviceId }, revision: 1 });
    expect(w.commands(deviceId)).toEqual([]);
    w.live.startFailure = undefined;
    await expect(w.move(PRIYA, sessionId, input)).resolves.toMatchObject({ session: { where: { kind: "cloud" } } });
  });

  it("refuses a task that is not the owner's, or not this org's, or has a session already (a runtime that misbehaves), cancels it and leaves the Mac session alone", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const original = w.runtime.startOnBranch.bind(w.runtime);
    w.runtime.startOnBranch = async (deps, input) => {
      const made = await original(deps, input);
      const task = w.taskOf(made.taskId)!;
      w.db.set({ ...task, developerId: ARJUN });
      return made;
    };
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 1 });
    expect(w.calls.cancels).toHaveLength(1);
  });

  it("does not use a task of another org, of another project, or one that already has a session; its own is cancelled, another org's is never touched", async () => {
    for (const [fields, cancels] of [[{ project: "ops" }, 1], [{ sessionId: "ses_00000000000000000042" }, 1], [{ orgId: ORG_B }, 0]] as const) {
      const w = world();
      const { sessionId } = await w.onMac();
      const original = w.runtime.startOnBranch.bind(w.runtime);
      w.runtime.startOnBranch = async (deps, input) => {
        const made = await original(deps, input);
        w.db.set({ ...w.taskOf(made.taskId)!, ...fields });
        return made;
      };
      expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: RUNTIME_UNAVAILABLE, message: "The move could not be completed right now. Try again in a moment." });
      expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 1 });
      expect(w.calls.cancels).toHaveLength(cancels);
    }
  });

  it("cancels the task it started when the Mac session ended while the task was starting, and the session is untouched", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    w.live.onStart = async () => {
      await recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "succeeded" });
    };
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    const taskId = w.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]!["taskId"] as string;
    expect(w.calls.cancels).toEqual([{ taskId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string }]);
    expect(w.taskOf(taskId)).not.toHaveProperty("sessionId");
    expect(w.meta(sessionId)).toMatchObject({ kind: "local" });
    expect((w.meta(sessionId).legs as unknown[])).toHaveLength(1);
    expect(w.commands(deviceId)).toEqual([]);
  });

  it("is never on two places: two moves at once with different request ids commit exactly one, and the loser's task is cancelled, not the winner's", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const winner = w.body();
    const loser = w.body();
    w.live.onStart = async (call) => {
      // While the loser's task is starting, the winner's whole move commits.
      if (call === 1) await w.move(PRIYA, sessionId, winner);
    };
    expect(await code(w.move(PRIYA, sessionId, loser))).toEqual({ code: "CONFIG_INVALID", message: "This session is already in the cloud." });
    const winnerTask = (w.meta(sessionId).subject as { taskId: string }).taskId;
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", where: { kind: "cloud" }, revision: 2 });
    expect((w.meta(sessionId).legs as unknown[])).toHaveLength(2);
    const started = w.db.find((item) => item.entityType === "DEVELOPER_TASK").map((item) => item["taskId"] as string);
    expect(started).toHaveLength(2);
    const cancelled = w.calls.cancels.map((call) => call.taskId);
    expect(cancelled).toEqual(started.filter((id) => id !== winnerTask));
    expect(w.taskOf(winnerTask)).toMatchObject({ sessionId });
    // One stop command only: the loser wrote none.
    expect(w.commands((w.meta(sessionId).legs as Array<{ where: { deviceId?: string } }>)[0]!.where.deviceId!)).toHaveLength(1);
  });

  it("goes on when only the session's revision moved (a share was added while the task started): the move is rebuilt from what is there now", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.live.onStart = async () => {
      w.patchSession(sessionId, { revision: 5 });
    };
    await w.move(PRIYA, sessionId, w.body());
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", revision: 6 });
    expect(w.calls.cancels).toEqual([]);
  });

  it("does not move a session whose owner changed while the task started", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.live.onStart = async () => {
      w.patchSession(sessionId, { owner: { developerId: ARJUN, name: "Arjun" } });
    };
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toMatchObject({ code: "FORBIDDEN" });
    expect(w.calls.cancels).toHaveLength(1);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local" });
  });

  it("refuses a late update from the Mac after the move, writes nothing to the Mac's state, and the device stops once", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    const stateBefore = { ...w.local(sessionId) };
    await w.move(PRIYA, sessionId, w.body());
    const writes = w.writes();
    expect(await code(recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "running", step: "still going" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.writes()).toBe(writes);
    expect(w.local(sessionId)).toEqual(stateBefore);
    const polled = await listDeviceCommands(w.deviceDeps, { orgId: ORG_A, developerId: PRIYA }, deviceId, "0");
    expect(polled.commands).toEqual([expect.objectContaining({ kind: "stop", sessionId, from: "Priya" })]);
    // The session does not show up among the Mac's open sessions any more.
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toBeUndefined();
  });

  it("moves a session whose Mac was removed in the meantime, writing no command for a device that cannot take one", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    // The device was removed, and the removal has not ended its session yet (it is found and ended by a later run).
    w.db.set({ ...(w.db.get(deviceKey(ORG_A, deviceId)) as Item), revokedAt: iso(T0) });
    await w.move(PRIYA, sessionId, w.body());
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", where: { kind: "cloud" } });
    expect(w.commands(deviceId)).toEqual([]);
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toBeUndefined();
  });

  it("will not move a session that has ended, or one with 20 legs already", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.patchSession(sessionId, { endedAt: iso(T0), summary: { ...(w.meta(sessionId).summary as Item), status: "succeeded" } });
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    const crowded = world();
    const other = await crowded.onMac();
    const legs = Array.from({ length: SESSION_LEGS_MAX }, (_, index) => ({ seq: index + 1, subject: { kind: "local", deviceId: other.deviceId, tool: "claude-code" }, where: { kind: "mac", deviceId: other.deviceId, label: "Priya's MacBook" }, startedAt: iso(T0), ...(index < SESSION_LEGS_MAX - 1 ? { endedAt: iso(T0), endedBy: "handoff" } : {}) }));
    crowded.patchSession(other.sessionId, { legs });
    expect(await code(crowded.move(PRIYA, other.sessionId, crowded.body()))).toEqual({ code: "CONFIG_INVALID", message: "This session has moved as often as it can." });
    expect(crowded.calls.starts).toEqual([]);
    expect(w.calls.starts).toEqual([]);
  });

  it("validates the body: a short sha, a bad branch, extra fields, an empty summary and a summary over 8 KiB are refused before any check", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    for (const bad of [{ headSha: "abc" }, { branch: "../x" }, { summary: "  " }, { summary: "x".repeat(8193) }, { repository: "no-slash" }, { extra: true }, { to: "moon" }]) {
      expect(await code(w.move(PRIYA, sessionId, w.body(bad)))).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(w.calls.admissions).toEqual([]);
    // The summary reaches the cloud as information with secrets redacted.
    await w.move(PRIYA, sessionId, w.body({ summary: `Use ghp_${"a1".repeat(18)} to push` }));
    expect(JSON.stringify(w.calls.starts[0]!["input"])).not.toContain("ghp_");
  });
});

describe("a session in the cloud moves to a Mac", () => {
  it("cancels the task, then pushes its branch, then moves the legs in one transaction, and answers where the work was pushed", async () => {
    const w = world();
    const { sessionId, taskId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    w.patchSession(sessionId, { summary: { ...(w.meta(sessionId).summary as Item), step: "Fixing the checkout test", status: "stopped" } });
    const input = w.toMac(deviceId);
    const before = w.writes();
    const reply = await w.move(PRIYA, sessionId, input);
    // The tile moves in the move's own transaction (the summary refresh after it may rewrite it).
    const tx = w.db.transactions().slice(before).find((items) => JSON.stringify(items).includes("LEG#000002"))!;
    expect(JSON.stringify(tx.find((item) => JSON.stringify(item).includes("LIVE_SESSIONS")))).toContain('":kind":"local"');

    expect(w.calls.order).toEqual(["cancel", "push"]);
    // The cancel has an id of its own (not the client's, which could collide with an id used on the task page).
    expect(w.calls.cancels).toEqual([{ taskId, requestId: handoffCancelRequestId(ORG_A, sessionId, input.requestId) }]);
    expect(input.requestId).not.toBe(handoffCancelRequestId(ORG_A, sessionId, input.requestId));
    expect(w.calls.pushes).toEqual([{ orgId: ORG_A, taskId }]);
    expect(reply).toEqual({ repository: "acme/web", branch: "rovara/fix-checkout", headSha: SHA_PUSHED, summary: expect.stringContaining("Bump the Stripe SDK") as string });
    expect(Object.keys(reply).sort()).toEqual(["branch", "headSha", "repository", "summary"]);
    // The claim moved the revision on once, the move once more.
    expect(w.meta(sessionId)).toMatchObject({
      kind: "local", subject: { kind: "local", deviceId, tool: "rovara" }, where: { kind: "mac", deviceId, label: "Priya's MacBook" }, owner: { developerId: PRIYA }, revision: 3,
    });
    expect(w.meta(sessionId)).not.toHaveProperty("payer");
    const legs = w.meta(sessionId).legs as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ seq: 1, subject: { kind: "task", taskId }, endedBy: "handoff", endedAt: iso(T0) });
    expect(legs[1]).toMatchObject({ seq: 2, subject: { kind: "local", deviceId, tool: "rovara" }, where: { kind: "mac", deviceId } });
    expect(w.under(sessionId, "LEG#")).toHaveLength(2);
    expect(w.local(sessionId)).toMatchObject({ sessionId, deviceId, status: "running", turnCount: 0 });
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toMatchObject({ sessionId, deviceId });
    expect(w.db.get(liveSessionKey(ORG_A, sessionId))).toMatchObject({ kind: "local", where: { kind: "mac", deviceId } });
    const events = w.under(sessionId, "EVENT#").filter((event) => event.type === "handoff");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: "Priya moved this session to Priya's MacBook.", eventId: sessionEventId("handoff", input.requestId) });
  });

  it("clears the task's sessionId so a later continue of that task cannot drive the session", async () => {
    const w = world();
    const { sessionId, taskId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    await w.move(PRIYA, sessionId, w.toMac(deviceId));
    expect(w.taskOf(taskId)).not.toHaveProperty("sessionId");
    // The task is looked up by id: it has no session any more.
    const store = new AgentSessionStore(w.deps);
    expect(await store.getForTask(ORG_A, w.taskOf(taskId) as never)).toBeUndefined();
    // The task carries on in the cloud (cancelled, then said to be running again by a continue): the session on the Mac does not change.
    w.db.set({ ...w.taskOf(taskId)!, status: "COMPLETE", updatedAt: iso(T0 + 60_000) });
    await refreshSessionSummary({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined }, ORG_A, sessionId);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", where: { kind: "mac" } });
    expect((w.meta(sessionId).summary as Item)["status"]).not.toBe("succeeded");
  });

  it("drops the followers who cannot see a session on a Mac (the shares only), keeps those who can, and the count follows", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
    for (const who of [MAX, ARJUN, MIA, hex("1")]) w.follower(ORG_A, sessionId, who);
    w.patchSession(sessionId, { followerCount: 4 });
    const deviceId = await w.mac(PRIYA);
    await w.move(PRIYA, sessionId, w.toMac(deviceId));
    const left = w.under(sessionId, "FOLLOWER#").map((item) => item["developerId"]);
    expect(left).toEqual([ARJUN]);
    expect(w.meta(sessionId)["followerCount"]).toBe(1);
    expect(await code(w.view(MAX, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    await expect(w.view(ARJUN, sessionId)).resolves.toMatchObject({ sessionId });
  });

  it("keeps a follower that the read-only check cannot decide (the project's channel might give them access); it only drops one that surely has none", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "web" }, "view");
    // Zed holds no grant on web: only the project's channel (which the check does not ask) could make this share reach them.
    w.follower(ORG_A, sessionId, ZED);
    w.follower(ORG_A, sessionId, MAX);
    w.patchSession(sessionId, { followerCount: 2 });
    const deviceId = await w.mac(PRIYA);
    await w.move(PRIYA, sessionId, w.toMac(deviceId));
    // Max holds a grant on web, so the project share reaches him; Zed stays followed, undecided.
    expect(w.under(sessionId, "FOLLOWER#").map((item) => item["developerId"]).sort()).toEqual([MAX, ZED].sort());
    expect(w.meta(sessionId)["followerCount"]).toBe(2);
  });

  it("drops more lost followers than one transaction holds: the rest go right after, and the count is right", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const ids = Array.from({ length: 95 }, (_, index) => `${String(index).padStart(2, "0")}${"c".repeat(62)}`);
    for (const id of ids) w.follower(ORG_A, sessionId, id);
    w.follower(ORG_A, sessionId, ARJUN);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
    w.patchSession(sessionId, { followerCount: 96 });
    const deviceId = await w.mac(PRIYA);
    const before = w.writes();
    await w.move(PRIYA, sessionId, w.toMac(deviceId));
    const tx = w.db.transactions().slice(before).find((items) => JSON.stringify(items).includes("LEG#000002"))!;
    expect(tx.length).toBeLessThanOrEqual(100);
    expect(w.under(sessionId, "FOLLOWER#").map((item) => item["developerId"])).toEqual([ARJUN]);
    expect(w.meta(sessionId)["followerCount"]).toBe(1);
  });

  it("applies the company's rule for local agents before touching the task: the tool, the project and a rule that cannot be read", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    w.setPolicy({ tools: ["codex"] });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: "rovara isn't allowed in your company. Ask an admin to allow it." });
    w.setPolicy({ projects: ["ops"] });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: "Local agents aren't allowed on web. Ask an admin to allow them." });
    w.setPolicy({ allowed: false });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toMatchObject({ code: "LOCAL_AGENT_NOT_ALLOWED" });
    w.db.set({ ...orgSettingsKey(ORG_A, "LOCAL_AGENTS"), entityType: "ORG_LOCAL_AGENTS", orgId: ORG_A, allowed: "yes" });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.calls.cancels).toEqual([]);
    expect(w.calls.pushes).toEqual([]);
    expect(w.meta(sessionId)).toMatchObject({ kind: "task" });
  });

  it("uses the tool an earlier Mac leg used, so the company's rule for that tool applies", async () => {
    const w = world();
    const mac = await w.onMac();
    await w.move(PRIYA, mac.sessionId, w.body());
    w.setPolicy({ tools: ["rovara"] });
    expect(await code(w.move(PRIYA, mac.sessionId, w.toMac(mac.deviceId)))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: "claude-code isn't allowed in your company. Ask an admin to allow it." });
    w.setPolicy({ tools: ["claude-code"] });
    await w.move(PRIYA, mac.sessionId, w.toMac(mac.deviceId));
    expect(w.meta(mac.sessionId).subject).toMatchObject({ kind: "local", tool: "claude-code" });
  });

  it("needs a Mac that is the owner's own and not removed, and a role on the project: each refusal comes before the task is cancelled", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const arjuns = await w.mac(ARJUN, "Arjun's MacBook");
    expect(await code(w.move(PRIYA, sessionId, w.toMac(arjuns)))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.move(PRIYA, sessionId, w.toMac("dvc_0000000000000000none")))).toMatchObject({ code: "NOT_FOUND" });
    const gone = await w.mac(PRIYA, "Old MacBook");
    await w.removeDevice(PRIYA, gone);
    expect(await code(w.move(PRIYA, sessionId, w.toMac(gone)))).toMatchObject({ code: "NOT_FOUND" });
    const mine = await w.mac(PRIYA);
    w.members.revoke(ORG_A, "web", PRIYA);
    expect(await code(w.move(PRIYA, sessionId, w.toMac(mine)))).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "You no longer have a role on web, so this session can't move to your Mac." });
    expect(w.calls.cancels).toEqual([]);
    expect(w.calls.pushes).toEqual([]);
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", revision: 1 });
  });

  it("refuses a Mac that already has its 20 open sessions", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    for (let index = 0; index < 20; index += 1) await registerLocalSession({ ...w.deps }, w.as(PRIYA), {
      requestId: randomUUID(), deviceId, tool: "claude-code", title: `Session ${String(index)}`, project: "web", startedAt: iso(T0 - 1000), shares: [{ principal: { kind: "member", developerId: ARJUN }, level: "view" }],
    });
    const { sessionId } = w.inCloud();
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: "CONFIG_INVALID", message: "This Mac already has 20 open sessions. End one first." });
    expect(w.calls.cancels).toEqual([]);
  });

  it("is the owner's alone, and a viewer of the project or an admin who is not the owner never cancels the task", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    expect(await code(w.move(MAX, sessionId, w.toMac(deviceId)))).toEqual({ code: "FORBIDDEN", message: "Only Priya can move this session." });
    expect(await code(w.move(MIA, sessionId, w.toMac(deviceId)))).toEqual({ code: "FORBIDDEN", message: "Only Priya can move this session." });
    expect(await code(w.move(OLA, sessionId, w.toMac(deviceId), ORG_A, "admin"))).toEqual({ code: "FORBIDDEN", message: "Only Priya can move this session." });
    expect(await code(w.move(ZED, sessionId, w.toMac(deviceId)))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.move(BO, sessionId, w.toMac(deviceId), ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.calls.cancels).toEqual([]);
    expect(w.meta(sessionId)).toMatchObject({ kind: "task" });
  });

  it("moves a Rovara Code task as the broker really leaves it (the built-in agent is on the task, a workflow runs it); only another agent's run stays in the cloud", async () => {
    const w = world();
    const code1 = w.inCloud({ agent: "rovara-code" });
    const deviceId = await w.mac(PRIYA);
    await expect(w.move(PRIYA, code1.sessionId, w.toMac(deviceId))).resolves.toMatchObject({ headSha: SHA_PUSHED });
    expect(w.calls.cancels).toHaveLength(1);
    expect(w.meta(code1.sessionId)).toMatchObject({ kind: "local" });
    // A built-in agent that is not Rovara Code, and a custom agent called "rovara-code", are agent-step runs.
    const triage = w.inCloud({ agent: true });
    expect(await code(w.move(PRIYA, triage.sessionId, w.toMac(await w.mac(PRIYA, "Second"))))).toEqual({ code: "CONFIG_INVALID", message: "An agent run stays in the cloud." });
    const otherBuiltin = w.inCloud();
    w.db.set({ ...w.taskOf(otherBuiltin.taskId)!, agent: { agentId: "ticket-triage", name: "Ticket triage", version: 1, builtin: true, digest: "d".repeat(64) } });
    expect(await code(w.move(PRIYA, otherBuiltin.sessionId, w.toMac(await w.mac(PRIYA, "Fourth"))))).toEqual({ code: "CONFIG_INVALID", message: "An agent run stays in the cloud." });
    const custom = w.inCloud();
    w.db.set({ ...w.taskOf(custom.taskId)!, agent: { agentId: "rovara-code", name: "Rovara Code", version: 1, builtin: false, digest: "d".repeat(64) } });
    expect(await code(w.move(PRIYA, custom.sessionId, w.toMac(await w.mac(PRIYA, "Third"))))).toEqual({ code: "CONFIG_INVALID", message: "An agent run stays in the cloud." });
    expect(w.calls.cancels).toHaveLength(1);
  });

  it("moves a task that runs the project's process layer like a Rovara Code task: the layer is Rovara Code with the project's rules, not an agent-step run", async () => {
    const w = world();
    const layer = w.inCloud();
    w.db.set({ ...w.taskOf(layer.taskId)!, agent: { agentId: "agt_pppppppppppppppppppp", name: "web process", version: 1, builtin: false, process: true, digest: "d".repeat(64) } });
    const deviceId = await w.mac(PRIYA);
    await expect(w.move(PRIYA, layer.sessionId, w.toMac(deviceId))).resolves.toMatchObject({ headSha: SHA_PUSHED });
    expect(w.meta(layer.sessionId)).toMatchObject({ kind: "local" });
  });

  it("refuses an agent-step run, which stays in the cloud, and a session that is already on a Mac", async () => {
    const w = world();
    const agent = w.inCloud({ agent: true });
    const deviceId = await w.mac(PRIYA);
    expect(await code(w.move(PRIYA, agent.sessionId, w.toMac(deviceId)))).toEqual({ code: "CONFIG_INVALID", message: "An agent run stays in the cloud." });
    const mac = await w.onMac();
    expect(await code(w.move(PRIYA, mac.sessionId, w.toMac(deviceId)))).toEqual({ code: "CONFIG_INVALID", message: "This session is already on a Mac." });
    expect(w.calls.cancels).toEqual([]);
  });

  it("answers the exact RUNTIME_UNAVAILABLE text with no runtime, and with no way to cancel", async () => {
    const none = world({ runtime: false });
    const a = none.inCloud();
    const deviceId = await none.mac(PRIYA);
    expect(await code(none.move(PRIYA, a.sessionId, none.toMac(deviceId)))).toEqual({ code: RUNTIME_UNAVAILABLE, message: NOT_READY });
    const noCancel = world({ control: false });
    const b = noCancel.inCloud();
    const second = await noCancel.mac(PRIYA);
    expect(await code(noCancel.move(PRIYA, b.sessionId, noCancel.toMac(second)))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(noCancel.calls.pushes).toEqual([]);
  });

  it("writes nothing and pushes nothing when the cancel is refused; the same request can be tried again", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    const input = w.toMac(deviceId);
    const before = w.db.items.size;
    w.live.cancelFailure = agentXError("WORKSPACE_BUSY", "the task changed while cancelling");
    expect(await code(w.move(PRIYA, sessionId, input))).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(w.calls.pushes).toEqual([]);
    expect(w.db.items.size).toBe(before);
    w.live.cancelFailure = undefined;
    await expect(w.move(PRIYA, sessionId, input)).resolves.toMatchObject({ branch: "rovara/fix-checkout" });
  });

  it("keeps the session in the cloud, unchanged, when the push fails, and finishes on the same request id (the cancel is asked again)", async () => {
    const w = world();
    const { sessionId, taskId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    const input = w.toMac(deviceId);
    w.live.pushFailure = agentXError("RUNTIME_UNAVAILABLE", "GitHub is unreachable");
    expect(await code(w.move(PRIYA, sessionId, input))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", subject: { taskId }, revision: 2 });
    expect(w.taskOf(taskId)).toMatchObject({ sessionId });
    expect(w.local(sessionId)).toBeUndefined();
    w.live.pushFailure = undefined;
    await expect(w.move(PRIYA, sessionId, input)).resolves.toMatchObject({ headSha: SHA_PUSHED });
    const cancelId = handoffCancelRequestId(ORG_A, sessionId, input.requestId);
    expect(w.calls.cancels).toEqual([{ taskId, requestId: cancelId }, { taskId, requestId: cancelId }]);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local" });
  });

  it("refuses an answer from the runtime that is not a branch it pushed, before anything is written", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    for (const bad of [{ repository: "acme/web", branch: "rovara/x", headSha: "short" }, { repository: "acme/web", branch: "--force", headSha: SHA }, null, {}]) {
      w.live.push = bad;
      expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
      expect(w.meta(sessionId)).toMatchObject({ kind: "task", revision: expect.any(Number) as number });
    }
  });

  it("is atomic: a commit that fails leaves the legs, the task, the Mac entry and the state as they were, and a repeat finishes it and then answers the stored answer", async () => {
    const w = world();
    const { sessionId, taskId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    const input = w.toMac(deviceId);
    w.db.injectFault({ command: "TransactWriteCommand", match: (tx) => JSON.stringify(tx).includes("LEG#000002"), error: { name: "InternalServerError" } });
    await expect(w.move(PRIYA, sessionId, input)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", revision: 2 });
    expect(w.under(sessionId, "LEG#")).toHaveLength(1);
    expect(w.taskOf(taskId)).toMatchObject({ sessionId });
    expect(w.local(sessionId)).toBeUndefined();
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toBeUndefined();
    const done = await w.move(PRIYA, sessionId, input);
    const pushes = w.calls.pushes.length;
    const writes = w.writes();
    const again = await w.move(PRIYA, sessionId, input);
    expect(again).toEqual(done);
    expect(w.calls.pushes).toHaveLength(pushes);
    expect(w.writes()).toBe(writes);
    expect(w.under(sessionId, "EVENT#").filter((event) => event.type === "handoff")).toHaveLength(1);
  });

  it("does not move a session whose task is not its own (another org's task) and does not cancel it", async () => {
    const w = world();
    const { sessionId, taskId } = w.inCloud();
    w.db.set({ ...w.taskOf(taskId)!, orgId: ORG_B });
    const deviceId = await w.mac(PRIYA);
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.calls.cancels).toEqual([]);
  });
});

describe("a move that races another write is decided by the table, not by what it read", () => {
  it("to the cloud: a session that ended between the last read and the write is not moved; the task is cancelled and nothing of the move is written", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    w.race.before = () => w.patchSession(sessionId, { endedAt: iso(T0), summary: { ...(w.meta(sessionId).summary as Item), status: "succeeded" } });
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 1 });
    expect(w.under(sessionId, "LEG#")).toHaveLength(1);
    expect(w.commands(deviceId)).toEqual([]);
    expect(w.calls.cancels).toHaveLength(1);
    expect(w.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]).not.toHaveProperty("sessionId");
  });

  it("to the cloud: a session that changed owner in that moment is not moved by its old owner", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.race.before = () => w.patchSession(sessionId, { owner: { developerId: ARJUN, name: "Arjun" } });
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "FORBIDDEN", message: "Only Arjun can move this session." });
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", owner: { developerId: ARJUN } });
    expect(w.calls.cancels).toHaveLength(1);
  });

  it("to the cloud: the very same request landing twice at once commits once and both calls answer the session; no task is cancelled", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    const input = w.body();
    w.race.before = async () => { await w.move(PRIYA, sessionId, input); };
    const reply = await w.move(PRIYA, sessionId, input);
    expect(reply).toMatchObject({ session: { sessionId, where: { kind: "cloud" } } });
    expect(w.calls.cancels).toEqual([]);
    expect(w.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(1);
    expect(w.under(sessionId, "EVENT#").filter((event) => event.type === "handoff")).toHaveLength(1);
    expect(w.under(sessionId, "LEG#")).toHaveLength(2);
    expect(w.commands(deviceId)).toHaveLength(1);
    expect(w.meta(sessionId)).toMatchObject({ revision: 2 });
  });

  it("to the cloud: a task that was given a session of someone else in that moment is not taken; the move is refused as busy and the Mac session is untouched", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    w.race.before = () => { const task = w.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]!; w.db.set({ ...task, sessionId: "ses_00000000000000000042" }); };
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: RUNTIME_UNAVAILABLE, message: "This session is busy right now. Try again." });
    // The task that could not be linked is cancelled: nothing pays for work nobody sees.
    expect(w.calls.cancels).toHaveLength(1);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 1 });
    expect(w.under(sessionId, "LEG#")).toHaveLength(1);
    expect(w.commands(deviceId)).toEqual([]);
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toBeDefined();
  });

  it("to the cloud: the Mac removed in that moment still lets the move happen, with no command for it", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    w.race.before = () => { w.db.set({ ...(w.db.get(deviceKey(ORG_A, deviceId)) as Item), revokedAt: iso(T0) }); };
    await w.move(PRIYA, sessionId, w.body());
    expect(w.meta(sessionId)).toMatchObject({ kind: "task" });
    expect(w.commands(deviceId)).toEqual([]);
  });

  it("to a Mac: a session that ended in that moment is not moved; its state, its legs and its task are as they were", async () => {
    const w = world();
    const { sessionId, taskId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    w.race.before = () => w.patchSession(sessionId, { endedAt: iso(T0), summary: { ...(w.meta(sessionId).summary as Item), status: "succeeded" } });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", subject: { taskId } });
    expect(w.under(sessionId, "LEG#")).toHaveLength(1);
    expect(w.taskOf(taskId)).toMatchObject({ sessionId });
    expect(w.local(sessionId)).toBeUndefined();
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toBeUndefined();
  });

  it("to a Mac: a session that changed owner in that moment is not moved by its old owner", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    w.race.before = () => w.patchSession(sessionId, { owner: { developerId: ARJUN, name: "Arjun" } });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: "FORBIDDEN", message: "Only Arjun can move this session." });
    expect(w.meta(sessionId)).toMatchObject({ kind: "task" });
    expect(w.local(sessionId)).toBeUndefined();
  });

  it("to a Mac: a take-over that lands before the cancel refuses the old owner's move, and the new owner's task is NOT cancelled", async () => {
    const w = world();
    const { sessionId, taskId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    // Arjun takes the session over just before the claim (the session and its task move together; the revision moves).
    w.race.beforeClaim = () => {
      w.patchSession(sessionId, { owner: { developerId: ARJUN, name: "Arjun" }, revision: 2 });
      w.db.set({ ...w.taskOf(taskId)!, currentOwner: { developerId: ARJUN, name: "Arjun", provider: "oidc", since: iso(T0) } });
    };
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: "FORBIDDEN", message: "Only Arjun can move this session." });
    expect(w.calls.cancels).toEqual([]);
    expect(w.calls.pushes).toEqual([]);
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", owner: { developerId: ARJUN } });
    expect(w.meta(sessionId)).not.toHaveProperty("moving");
  });

  it("to a Mac: a session that ended in the moment of the claim is not claimed, and nothing is cancelled", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    w.race.beforeClaim = () => w.patchSession(sessionId, { endedAt: iso(T0), summary: { ...(w.meta(sessionId).summary as Item), status: "succeeded" } });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.calls.cancels).toEqual([]);
    expect(w.meta(sessionId)).not.toHaveProperty("moving");
  });

  it("to a Mac: the move claims the session before it cancels (the revision moves and a marker is set), so a take-over decided on the old revision cannot land after; the marker is gone when the move is done", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    let takeOver: unknown;
    w.live.onCancel = async () => {
      // A take-over applies conditional on the revision it was asked at (Task 12b): the claim has moved it.
      takeOver = await code(w.db.send(new UpdateCommand({
        TableName: "state", Key: agentSessionKey(ORG_A, sessionId, "META"), UpdateExpression: "SET #owner = :owner ADD #revision :one",
        ConditionExpression: "attribute_exists(pk) AND #revision = :revision", ExpressionAttributeNames: { "#owner": "owner", "#revision": "revision" },
        ExpressionAttributeValues: { ":owner": { developerId: ARJUN, name: "Arjun" }, ":one": 1, ":revision": 1 },
      })));
    };
    await w.move(PRIYA, sessionId, w.toMac(deviceId));
    expect(w.calls.atCancel).toEqual([{ revision: 2, moving: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, until: iso(T0 + 300_000) }, owner: expect.objectContaining({ developerId: PRIYA }) as unknown }]);
    expect(takeOver).toMatchObject({ code: undefined });
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", owner: { developerId: PRIYA }, revision: 3 });
    expect(w.meta(sessionId)).not.toHaveProperty("moving");
  });

  it("to a Mac: while another move holds the claim, a different request is refused; the same request goes on, and an expired claim is taken over", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    const mine = randomUUID();
    w.patchSession(sessionId, { moving: { requestId: randomUUID(), until: iso(T0 + 120_000) } });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: RUNTIME_UNAVAILABLE, message: "This session is being moved right now. Try again in a minute." });
    expect(w.calls.cancels).toEqual([]);
    w.patchSession(sessionId, { moving: { requestId: mine, until: iso(T0 + 120_000) } });
    await expect(w.move(PRIYA, sessionId, w.toMac(deviceId, { requestId: mine }))).resolves.toMatchObject({ headSha: SHA_PUSHED });
    const again = world();
    const second = again.inCloud();
    const device = await again.mac(PRIYA);
    again.patchSession(second.sessionId, { moving: { requestId: randomUUID(), until: iso(T0 - 1000) } });
    await expect(again.move(PRIYA, second.sessionId, again.toMac(device))).resolves.toMatchObject({ headSha: SHA_PUSHED });
  });

  it("to a Mac: a person who followed in that moment is judged too (the count it read no longer holds), and the count ends right", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    w.follower(ORG_A, sessionId, MAX);
    w.patchSession(sessionId, { followerCount: 1 });
    const deviceId = await w.mac(PRIYA);
    w.race.before = () => { w.follower(ORG_A, sessionId, MIA); w.patchSession(sessionId, { followerCount: 2 }); };
    await w.move(PRIYA, sessionId, w.toMac(deviceId));
    expect(w.under(sessionId, "FOLLOWER#")).toEqual([]);
    expect(w.meta(sessionId)["followerCount"]).toBe(0);
  });

  it("to a Mac: the Mac removed in that moment is refused, with nothing written for it", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    w.race.before = () => { w.db.set({ ...(w.db.get(deviceKey(ORG_A, deviceId)) as Item), revokedAt: iso(T0) }); };
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.meta(sessionId)).toMatchObject({ kind: "task", revision: 2 });
    expect(w.local(sessionId)).toBeUndefined();
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toBeUndefined();
  });

  it("to a Mac: the Mac's state changed in that moment (a late write of an earlier leg), the new leg starts from what is there now", async () => {
    const w = world();
    const mac = await w.onMac();
    await w.move(PRIYA, mac.sessionId, w.body());
    w.race.before = () => { w.db.set({ ...(w.local(mac.sessionId) as Item), rev: 9, turnCount: 7 }); };
    await w.move(PRIYA, mac.sessionId, w.toMac(mac.deviceId));
    expect(w.local(mac.sessionId)).toMatchObject({ rev: 10, turnCount: 7, status: "running" });
  });

  it("to a Mac: the very same request landing twice at once commits once and both calls answer the same branch", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    const input = w.toMac(deviceId);
    w.race.before = async () => { await w.move(PRIYA, sessionId, input); };
    const reply = await w.move(PRIYA, sessionId, input);
    expect(reply).toMatchObject({ headSha: SHA_PUSHED });
    expect(w.under(sessionId, "EVENT#").filter((event) => event.type === "handoff")).toHaveLength(1);
    expect(w.under(sessionId, "LEG#")).toHaveLength(2);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 4 });
  });
});

describe("no paid work is left unlinked", () => {
  const pendingOf = (w: ReturnType<typeof world>, sessionId: string, requestId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${requestId}`)) as Item | undefined;

  it("writes a pending record before the task starts (with the task id it will have), hands the runtime the id and the marker, and removes the record when the move is done", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const input = w.body();
    let during: Item | undefined;
    w.live.onStart = async () => { during = pendingOf(w, sessionId, input.requestId); };
    await w.move(PRIYA, sessionId, input);
    const start = w.calls.starts[0]!;
    expect(during).toMatchObject({ state: "started", attempt: 1, taskId: start["taskId"], startedAt: iso(T0), orgId: ORG_A, sessionId });
    expect(start["handoffOf"]).toEqual({ sessionId, requestId: input.requestId });
    expect(w.taskOf(start["taskId"] as string)).toMatchObject({ handoffOf: { sessionId, requestId: input.requestId } });
    expect(w.meta(sessionId).subject).toMatchObject({ taskId: start["taskId"] });
    expect(pendingOf(w, sessionId, input.requestId)).toBeUndefined();
  });

  it("refuses a runtime that does not mark the task or answers another task than the one asked for, and cancels what it made", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.live.noMarker = true;
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.calls.cancels).toHaveLength(1);
    w.live.noMarker = false;
    w.live.wrongTaskId = true;
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 1 });
    expect(w.calls.cancels.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses a task whose marker names another session or another request, and an answer that is not a task id; what it made is cancelled", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.live.marker = { sessionId: "ses_00000000000000000042", requestId: randomUUID() };
    const input = w.body();
    w.live.marker = { sessionId: "ses_00000000000000000042", requestId: input.requestId };
    expect(await code(w.move(PRIYA, sessionId, input))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.calls.cancels).toHaveLength(1);
    const other = w.body();
    w.live.marker = { sessionId, requestId: randomUUID() };
    expect(await code(w.move(PRIYA, sessionId, other))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.calls.cancels).toHaveLength(2);
    w.live.marker = undefined;
    w.live.badAnswer = true;
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.calls.cancels).toHaveLength(3);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local" });
  });

  it("a move whose start died after the task was made resumes the same attempt: the same task and the same start time", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const input = w.body();
    w.live.dieAfterCreate = true;
    await expect(w.move(PRIYA, sessionId, input)).rejects.toThrow("died");
    expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "started", attempt: 1 });
    w.clock.now += 30_000;
    let during: Item | undefined;
    w.live.onStart = async () => { during = pendingOf(w, sessionId, input.requestId); };
    await w.move(PRIYA, sessionId, input);
    expect(w.calls.starts[1]!["taskId"]).toBe(w.calls.starts[0]!["taskId"]);
    expect(during).toMatchObject({ attempt: 1, startedAt: iso(T0) });
    expect(w.meta(sessionId).subject).toMatchObject({ taskId: w.calls.starts[0]!["taskId"] });
  });

  it("a newer attempt's record is not overwritten by an older one's write: the write is conditional on the record it read, so it resumes the newer attempt", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const input = w.body();
    // Attempt 1 is cancelled (unknown outcome); then, between a repeat's read and its write, another copy of the request has begun attempt 5.
    w.db.injectFault({ command: "TransactWriteCommand", match: (tx) => JSON.stringify(tx).includes("LEG#000002"), error: { name: "InternalServerError" } });
    await expect(w.move(PRIYA, sessionId, input)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "abandoned", attempt: 1 });
    w.race.beforePending = () => {
      w.db.set({ ...agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`), entityType: "AGENT_SESSION_HANDOFF_PENDING", orgId: ORG_A, sessionId, requestId: input.requestId, attempt: 5, taskId: handoffTaskId(ORG_A, sessionId, input.requestId, 5), state: "started", by: PRIYA, startedAt: iso(T0) });
    };
    await w.move(PRIYA, sessionId, input);
    expect(w.calls.starts[1]!["taskId"]).toBe(handoffTaskId(ORG_A, sessionId, input.requestId, 5));
  });

  it("an attempt that was replaced by a newer one is not cancelled by the older one's failure", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const input = w.body();
    const newer = handoffTaskId(ORG_A, sessionId, input.requestId, 2);
    w.race.before = () => {
      w.db.set({ ...agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`), entityType: "AGENT_SESSION_HANDOFF_PENDING", orgId: ORG_A, sessionId, requestId: input.requestId, attempt: 2, taskId: newer, state: "started", by: PRIYA, startedAt: iso(T0) });
    };
    expect(await code(w.move(PRIYA, sessionId, input))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ attempt: 2, state: "started" });
    expect(w.calls.systemCancels).toEqual([]);
    // Attempt 1's own task is still cancelled by the caller's cancel only if it is still its attempt: here the record moved on, so the older task is left to the newer attempt's rules.
    expect(w.calls.cancels.every((call) => call.taskId !== newer)).toBe(true);
  });

  it("a task the runtime made under another id is cancelled only if it is marked as this very move's", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    w.live.wrongTaskId = true;
    w.live.marker = { sessionId, requestId: randomUUID() };
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toMatchObject({ code: RUNTIME_UNAVAILABLE });
    expect(w.calls.cancels).toEqual([]);
  });

  it("a cancel that failed leaves the attempt 'cancelling': a repeat finishes that cancel first and then starts the next attempt; it never resumes a task that was being cancelled", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const input = w.body();
    w.live.cancelFailure = agentXError("WORKSPACE_BUSY", "busy");
    w.db.injectFault({ command: "TransactWriteCommand", match: (tx) => JSON.stringify(tx).includes("LEG#000002"), error: { name: "InternalServerError" } });
    await expect(w.move(PRIYA, sessionId, input)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "cancelling", attempt: 1 });
    const first = w.calls.starts[0]!["taskId"];
    w.live.cancelFailure = undefined;
    w.calls.cancels.length = 0;
    await w.move(PRIYA, sessionId, input);
    expect(w.calls.cancels.map((call) => call.taskId)).toEqual([first]);
    expect(w.calls.starts[1]!["taskId"]).toBe(handoffTaskId(ORG_A, sessionId, input.requestId, 2));
    expect(w.meta(sessionId).subject).toMatchObject({ taskId: w.calls.starts[1]!["taskId"] });
  });

  it("two copies of one request starting at once never overwrite each other's attempt: the later one finds the newer record and resumes it, so one request id starts one task", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const input = w.body();
    // Another copy of the request got as far as its record (attempt 2, after an earlier attempt was cancelled) between this one's read and its write.
    w.race.beforePending = () => {
      w.db.set({ ...agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`), entityType: "AGENT_SESSION_HANDOFF_PENDING", orgId: ORG_A, sessionId, requestId: input.requestId, attempt: 2, taskId: handoffTaskId(ORG_A, sessionId, input.requestId, 2), state: "started", by: PRIYA, startedAt: iso(T0) });
    };
    await w.move(PRIYA, sessionId, input);
    expect(w.calls.starts).toHaveLength(1);
    expect(w.calls.starts[0]!["taskId"]).toBe(handoffTaskId(ORG_A, sessionId, input.requestId, 2));
    expect(w.meta(sessionId).subject).toMatchObject({ taskId: handoffTaskId(ORG_A, sessionId, input.requestId, 2) });
  });

  it("a repeat that is refused cancels nothing for an attempt that was already cancelled, or whose task is linked", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    const input = w.body();
    w.db.injectFault({ command: "TransactWriteCommand", match: (tx) => JSON.stringify(tx).includes("LEG#000002"), error: { name: "InternalServerError" } });
    await expect(w.move(PRIYA, sessionId, input)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(w.calls.cancels).toHaveLength(1);
    expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "abandoned" });
    await recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "succeeded" });
    w.clock.now += 5 * 60_000;
    expect(await code(w.move(PRIYA, sessionId, input))).toMatchObject({ code: "SESSION_ENDED" });
    expect(w.calls.cancels).toHaveLength(1);
    // A started attempt whose task already names a session is not cancelled either.
    const linked = world();
    const mac = await linked.onMac();
    const again = linked.body();
    linked.live.cancelFailure = agentXError("WORKSPACE_BUSY", "busy");
    linked.db.injectFault({ command: "TransactWriteCommand", match: (tx) => JSON.stringify(tx).includes("LEG#000002"), error: { name: "InternalServerError" } });
    await expect(linked.move(PRIYA, mac.sessionId, again)).rejects.toMatchObject({ name: "InternalServerError" });
    const task = linked.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]!;
    linked.db.set({ ...task, sessionId: mac.sessionId });
    await recordLocalUpdate({ ...linked.deps }, linked.as(PRIYA), mac.sessionId, { requestId: randomUUID(), deviceId: mac.deviceId, status: "succeeded" });
    linked.clock.now += 5 * 60_000;
    linked.live.cancelFailure = undefined;
    linked.calls.cancels.length = 0;
    expect(await code(linked.move(PRIYA, mac.sessionId, again))).toMatchObject({ code: "SESSION_ENDED" });
    expect(linked.calls.cancels).toEqual([]);
  });

  it("when even the cancel fails after an unknown outcome and the Mac ends its session, the repeat of the request cancels the orphan before it says the session ended", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    const input = w.body();
    w.live.cancelFailure = agentXError("WORKSPACE_BUSY", "busy");
    w.db.injectFault({ command: "TransactWriteCommand", match: (tx) => JSON.stringify(tx).includes("LEG#000002"), error: { name: "InternalServerError" } });
    await expect(w.move(PRIYA, sessionId, input)).rejects.toMatchObject({ name: "InternalServerError" });
    const orphan = (w.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]!)["taskId"] as string;
    expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "cancelling" });
    // The Mac ends its own session (no stop command was committed); a minute and a half later the owner repeats the request.
    await recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "succeeded" });
    w.clock.now += 90_000;
    w.live.cancelFailure = undefined;
    w.calls.cancels.length = 0;
    expect(await code(w.move(PRIYA, sessionId, input))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.calls.cancels.map((call) => call.taskId)).toEqual([orphan]);
    expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "abandoned" });
  });

  it("a repeat that comes at once does not cancel a move that may still be committing (a started attempt younger than a minute)", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    const input = w.body();
    w.live.dieAfterCreate = true;
    await expect(w.move(PRIYA, sessionId, input)).rejects.toThrow("died");
    await recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "succeeded" });
    w.clock.now += 5_000;
    expect(await code(w.move(PRIYA, sessionId, input))).toMatchObject({ code: "SESSION_ENDED" });
    expect(w.calls.cancels).toEqual([]);
    expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "started" });
  });

  describe("the session sweep", () => {
    const recovery = (w: ReturnType<typeof world>) => makeHandoffRecovery({ ...w.deps, handoff: w.runtime });
    const orphaned = async (w: ReturnType<typeof world>) => {
      const mac = await w.onMac();
      const input = w.body();
      w.live.dieAfterCreate = true;
      await expect(w.move(PRIYA, mac.sessionId, input)).rejects.toThrow("died");
      return { ...mac, input, taskId: (w.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]!)["taskId"] as string };
    };
    const sweep = (w: ReturnType<typeof world>) => sweepAgentSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined, recoverHandoffs: recovery(w) }, w.clock.now);

    it("cancels a marked task that never got linked, once it is older than the window, through the runtime, and marks it done", async () => {
      const w = world();
      const { sessionId, input, taskId } = await orphaned(w);
      w.clock.now += 5 * 60_000;
      await sweep(w);
      expect(w.calls.systemCancels).toEqual([]);
      w.clock.now += 6 * 60_000;
      await sweep(w);
      expect(w.calls.systemCancels).toEqual([{ taskId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string }]);
      expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "abandoned" });
      await sweep(w);
      expect(w.calls.systemCancels).toHaveLength(1);
    });

    it("R1: the drain keeps an ended session's work item while a young attempt remains, and the attempt is cancelled once it is old enough", async () => {
      const w = world();
      const { sessionId, deviceId, taskId } = await orphaned(w);
      // The Mac ends its own session a minute after the cut-off start.
      w.clock.now += 60_000;
      await recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "succeeded" });
      const work = () => w.db.find((item) => item.entityType === "ENDED_AGENT_SESSION" && item.sessionId === sessionId);
      expect(work()).toHaveLength(1);
      const drain = () => drainEndedSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined, recoverHandoffs: recovery(w) }, w.clock.now);
      await drain();
      expect(w.calls.systemCancels).toEqual([]);
      expect(work()).toHaveLength(1);
      w.clock.now += 11 * 60_000;
      await drain();
      expect(w.calls.systemCancels).toEqual([{ taskId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string }]);
      expect(work()).toHaveLength(0);
      expect(pendingOf(w, sessionId, w.db.find((item) => String(item.sk).startsWith("HANDOFF_PENDING#"))[0]!["requestId"] as string)).toMatchObject({ state: "abandoned" });
    });

    it("R1: an ended session with no attempt is drained at once, and the wait ends after a day", async () => {
      const w = world();
      const { sessionId, deviceId } = await w.onMac();
      await recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "succeeded" });
      const drain = () => drainEndedSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined, recoverHandoffs: recovery(w) }, w.clock.now);
      await drain();
      expect(w.db.find((item) => item.entityType === "ENDED_AGENT_SESSION" && item.sessionId === sessionId)).toHaveLength(0);
      // A runtime that can never cancel: the item is kept for a day and then let go.
      const stuck = world();
      const orphan = await orphaned(stuck);
      stuck.runtime.cancelStarted = async () => { throw new Error("runtime down"); };
      await recordLocalUpdate({ ...stuck.deps }, stuck.as(PRIYA), orphan.sessionId, { requestId: randomUUID(), deviceId: orphan.deviceId, status: "succeeded" });
      const drainStuck = () => drainEndedSessions({ documentClient: stuck.db, tableName: "state", now: () => stuck.clock.now, log: () => undefined, recoverHandoffs: recovery(stuck) }, stuck.clock.now);
      stuck.clock.now += 12 * 60_000;
      await drainStuck();
      expect(stuck.db.find((item) => item.entityType === "ENDED_AGENT_SESSION")).toHaveLength(1);
      stuck.clock.now += 25 * 3_600_000;
      await drainStuck();
      expect(stuck.db.find((item) => item.entityType === "ENDED_AGENT_SESSION")).toHaveLength(0);
    });

    it("R2, the link wins: a link that commits between the sweep's read and its claim is never cancelled", async () => {
      const w = world();
      const { sessionId, input } = await orphaned(w);
      w.clock.now += 11 * 60_000;
      // The link commits (it deletes the pending record) just before the sweep claims the cancel.
      w.race.beforeCancelClaim = () => { w.db.delete(agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`)); };
      await sweep(w);
      expect(w.calls.systemCancels).toEqual([]);
      expect(w.calls.cancels).toEqual([]);
    });

    it("R2, the link wins against a refused repeat too", async () => {
      const w = world();
      const { sessionId, deviceId, input } = await orphaned(w);
      await recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "succeeded" });
      w.clock.now += 90_000;
      w.race.beforeCancelClaim = () => { w.db.delete(agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`)); };
      expect(await code(w.move(PRIYA, sessionId, input))).toMatchObject({ code: "SESSION_ENDED" });
      expect(w.calls.cancels).toEqual([]);
    });

    it("R2, the cancel wins: a link that meets a claimed cancel is refused whole, and the session is never linked to the cancelled task", async () => {
      const w = world();
      const { sessionId } = await w.onMac();
      const input = w.body();
      // The sweep (or a refused repeat) claimed the cancel after this move's last read and before its link.
      w.race.before = () => { const key = agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`); w.db.set({ ...(w.db.get(key) as Item), state: "cancelling" }); };
      expect(await code(w.move(PRIYA, sessionId, input))).toEqual({ code: RUNTIME_UNAVAILABLE, message: "This session is busy right now. Try again." });
      expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 1 });
      expect(w.under(sessionId, "LEG#")).toHaveLength(1);
      // Refused at once, not retried to exhaustion.
      expect(w.calls.linkTries).toBe(1);
      const task = w.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]!;
      expect(task).not.toHaveProperty("sessionId");
      expect(w.calls.cancels).toHaveLength(1);
      expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "abandoned" });
    });

    it("the sweep without a runtime to ask cancels nothing and forgets nothing: the attempt waits", async () => {
      const w = world();
      const { sessionId, input } = await orphaned(w);
      w.clock.now += 11 * 60_000;
      const quiet = makeHandoffRecovery({ ...w.deps, handoff: undefined });
      const session = (await new AgentSessionStore(w.deps).get(ORG_A, sessionId))!;
      expect(await quiet(session)).toBe("pending");
      expect(pendingOf(w, sessionId, input.requestId)).toMatchObject({ state: "cancelling" });
      expect(w.calls.systemCancels).toEqual([]);
      expect(await recovery(w)(session)).toBe("clear");
      expect(w.calls.systemCancels).toHaveLength(1);
    });

    it("R2: a link whose pending record is gone (taken away by something else) is refused at once and cancels nothing it cannot prove is its own", async () => {
      const w = world();
      const { sessionId } = await w.onMac();
      const input = w.body();
      w.race.before = () => { w.db.delete(agentSessionKey(ORG_A, sessionId, `HANDOFF_PENDING#${input.requestId}`)); };
      expect(await code(w.move(PRIYA, sessionId, input))).toEqual({ code: RUNTIME_UNAVAILABLE, message: "This session is busy right now. Try again." });
      expect(w.calls.linkTries).toBe(1);
      expect(w.meta(sessionId)).toMatchObject({ kind: "local", revision: 1 });
    });

    it("a missing task record is not forgotten: the runtime is asked to cancel it by its derived id each time, and only a long wait proves it was never made", async () => {
      const w = world();
      const mac = await w.onMac();
      const input = w.body();
      w.live.startFailure = new Error("the start failed before it made anything that is visible");
      await expect(w.move(PRIYA, mac.sessionId, input)).rejects.toThrow("visible");
      const taskId = handoffTaskId(ORG_A, mac.sessionId, input.requestId, 1);
      w.clock.now += 11 * 60_000;
      await sweep(w);
      expect(w.calls.systemCancels.map((call) => call.taskId)).toEqual([taskId]);
      expect(pendingOf(w, mac.sessionId, input.requestId)).toMatchObject({ state: "cancelling" });
      // The runtime writes the record late: the next sweep cancels it.
      w.db.set({ ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: ORG_A, developerId: PRIYA, project: "web", handoffOf: { sessionId: mac.sessionId, requestId: input.requestId } });
      w.clock.now += 60_000;
      await sweep(w);
      expect(w.calls.systemCancels.map((call) => call.taskId)).toEqual([taskId, taskId]);
      expect(pendingOf(w, mac.sessionId, input.requestId)).toMatchObject({ state: "abandoned" });
      // Another start that never made anything: after an hour it is let go.
      const other = world();
      const second = await other.onMac();
      const again = other.body();
      other.live.startFailure = new Error("the start failed before it made anything that is visible");
      await expect(other.move(PRIYA, second.sessionId, again)).rejects.toThrow("visible");
      other.clock.now += 11 * 60_000;
      await sweep(other);
      expect(pendingOf(other, second.sessionId, again.requestId)).toMatchObject({ state: "cancelling" });
      other.clock.now += 61 * 60_000;
      await sweep(other);
      expect(pendingOf(other, second.sessionId, again.requestId)).toMatchObject({ state: "abandoned" });
    });

    it("leaves a task alone when the move was recorded, when the task has a session, or when it is another org's", async () => {
      const w = world();
      const first = await orphaned(w);
      // The move was in fact recorded (its request item is there).
      w.db.set({ ...agentSessionKey(ORG_A, first.sessionId, `REQUEST#${first.input.requestId}`), entityType: "AGENT_SESSION_REQUEST", orgId: ORG_A, action: "handoff", by: PRIYA, at: iso(T0), sessionId: first.sessionId });
      w.clock.now += 11 * 60_000;
      await sweep(w);
      expect(w.calls.systemCancels).toEqual([]);
      expect(pendingOf(w, first.sessionId, first.input.requestId)).toMatchObject({ state: "abandoned" });

      const second = world();
      const linked = await orphaned(second);
      second.db.set({ ...second.taskOf(linked.taskId)!, sessionId: linked.sessionId });
      second.clock.now += 11 * 60_000;
      await sweep(second);
      expect(second.calls.systemCancels).toEqual([]);
      expect(pendingOf(second, linked.sessionId, linked.input.requestId)).toMatchObject({ state: "abandoned" });

      const third = world();
      const foreign = await orphaned(third);
      third.db.set({ ...third.taskOf(foreign.taskId)!, orgId: ORG_B });
      third.clock.now += 11 * 60_000;
      await sweep(third);
      expect(third.calls.systemCancels).toEqual([]);
      expect(pendingOf(third, foreign.sessionId, foreign.input.requestId)).toMatchObject({ state: "abandoned" });
    });
  });
});

describe("a request id belongs to one action", () => {
  it("a stop's request id cannot be used for a move, and a move's cannot be used for a stop; the task is not cancelled again", async () => {
    const w = world();
    const { sessionId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    const requestId = randomUUID();
    await stopSession(w.deps, { ...w.as(PRIYA), name: "Priya" }, sessionId, { requestId });
    expect(w.calls.cancels).toHaveLength(1);
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId, { requestId })))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(w.calls.cancels).toHaveLength(1);
    expect(w.calls.pushes).toEqual([]);
  });
});

describe("the number of legs", () => {
  it("a cloud session with 20 legs is refused before its task is cancelled", async () => {
    const w = world();
    const { sessionId, taskId } = w.inCloud();
    const deviceId = await w.mac(PRIYA);
    const legs = Array.from({ length: SESSION_LEGS_MAX }, (_, index) => ({ seq: index + 1, subject: { kind: "task", taskId }, where: { kind: "cloud" }, startedAt: iso(T0), ...(index < SESSION_LEGS_MAX - 1 ? { endedAt: iso(T0), endedBy: "handoff" } : {}) }));
    w.patchSession(sessionId, { legs });
    expect(await code(w.move(PRIYA, sessionId, w.toMac(deviceId)))).toEqual({ code: "CONFIG_INVALID", message: "This session has moved as often as it can." });
    expect(w.calls.cancels).toEqual([]);
  });

  it("a session that reached 20 legs in the moment of the write is not moved, and the started task is cancelled", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    w.race.before = () => w.patchSession(sessionId, {
      revision: 2,
      legs: Array.from({ length: SESSION_LEGS_MAX }, (_, index) => ({ seq: index + 1, subject: { kind: "local", deviceId, tool: "claude-code" }, where: { kind: "mac", deviceId, label: "Priya's MacBook" }, startedAt: iso(T0), ...(index < SESSION_LEGS_MAX - 1 ? { endedAt: iso(T0), endedBy: "handoff" } : {}) })),
    });
    expect(await code(w.move(PRIYA, sessionId, w.body()))).toEqual({ code: "CONFIG_INVALID", message: "This session has moved as often as it can." });
    expect(w.calls.cancels).toHaveLength(1);
    expect(w.meta(sessionId)).toMatchObject({ kind: "local" });
  });
});

describe("one session across many legs", () => {
  it("goes Mac, cloud, Mac, cloud with the same id, numbered legs, a fresh Mac state each time, and the transcript count kept", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.onMac();
    await recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "running", turns: [{ at: iso(T0), role: "person", text: "go" }, { at: iso(T0), role: "agent", text: "ok" }] });
    await w.move(PRIYA, sessionId, w.body());
    w.clock.now += 60_000;
    await w.move(PRIYA, sessionId, w.toMac(deviceId));
    expect(w.local(sessionId)).toMatchObject({ status: "running", turnCount: 2, deviceId });
    const lasts = Math.floor(w.clock.now / 1000) + SESSION_RETENTION_DAYS * 86_400;
    expect(w.local(sessionId)![INDEX_EXPIRY_ATTRIBUTE]).toBe(lasts);
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))![INDEX_EXPIRY_ATTRIBUTE]).toBe(lasts);
    // The Mac can post again on the new leg.
    await expect(recordLocalUpdate({ ...w.deps }, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "running", turns: [{ at: iso(T0), role: "person", text: "back" }] })).resolves.toMatchObject({ accepted: 1 });
    expect(w.local(sessionId)).toMatchObject({ turnCount: 3 });
    w.clock.now += 60_000;
    await w.move(PRIYA, sessionId, w.body());
    const legs = w.meta(sessionId).legs as Array<{ seq: number; endedAt?: string }>;
    expect(legs.map((leg) => leg.seq)).toEqual([1, 2, 3, 4]);
    // A leg keeps the moment its move ended it.
    expect(legs.map((leg) => leg.endedAt)).toEqual([iso(T0), iso(T0 + 60_000), iso(T0 + 120_000), undefined]);
    expect(legs.filter((leg) => leg.endedAt === undefined)).toHaveLength(1);
    expect(w.meta(sessionId)).toMatchObject({ sessionId, kind: "task", revision: 5 });
    expect(w.under(sessionId, "LEG#")).toHaveLength(4);
    expect(w.commands(deviceId)).toHaveLength(2);
  });
});

describe("the route", () => {
  it("POST /v1/app/sessions/{id}/handoff moves the session, and any other method or path is not found", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const reply = await w.post(PRIYA, sessionId, w.body()) as { session: { sessionId: string; where: { kind: string } } };
    expect(reply.session).toMatchObject({ sessionId, where: { kind: "cloud" } });
    const path = `/v1/app/sessions/${sessionId}/handoff`;
    expect(await code(routeAgentSessionRequest(w.deps, w.as(PRIYA), { method: "GET", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`)))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.post(PRIYA, "ses_00000000000000009999", w.body()))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.post(BO, sessionId, w.body(), ORG_B))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not offer anyone the 'handoff' action (the Mac move is unfinished and hidden, owner decision 14), while the owner's move itself still works", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const owner = (await w.view(PRIYA, sessionId)).you;
    expect(owner.actions).not.toContain("handoff");
    expect((await w.view(ARJUN, sessionId)).you.actions).not.toContain("handoff");
    // Positive controls: the owner is still offered their other actions, and the move route still moves the session.
    expect(owner).toMatchObject({ owner: true });
    expect(owner.actions).toEqual(expect.arrayContaining(["watch", "comment", "stop"]));
    const moved = await w.post(PRIYA, sessionId, w.body()) as { session: { sessionId: string; where: { kind: string } } };
    expect(moved.session).toMatchObject({ sessionId, where: { kind: "cloud" } });
  });
});

describe("S3: a move to the cloud keeps the owner's own words", () => {
  it("the cloud task's text is the session's title as stored, an address in it included", async () => {
    const w = world();
    const { sessionId } = await w.onMac();
    const title = `Add ${["omar", "example.test"].join(String.fromCharCode(64))} to the allow list`;
    w.patchSession(sessionId, { title });
    await w.move(PRIYA, sessionId, w.body());
    expect(w.calls.starts[0]).toMatchObject({ input: { text: title } });
  });
});
