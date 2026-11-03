// Plan 6 Task 20 (owner decision 2026-10-26): linking a Rovara Code session to a Linear issue from the app, the CLI and the API, until Plan 9's Linear intake exists. `POST` and `DELETE`
// /v1/app/sessions/{id}/bindings[/linear]. The caller needs a live "can edit" on the session in their own org (or to own it); the issue key is validated; a session follows one issue and
// an issue follows one session in the org; replacing is explicit; the change is one transaction with its timeline line and its audit record; nothing crosses an org. A binding is a routing
// hint only: it gives nobody any authority on the session.
import { describe, expect, it } from "vitest";
import { orgMemberKey, sessionBindingKey, sessionSurfaceKey, type OrgId } from "@agentx/contracts";
import type { SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { bindSessionSurface } from "../../packages/broker/src/agent-sessions/bindings.js";
import { linearIssueKeyOfTask } from "../../packages/broker/src/rovara-code/linear-close.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const KEY_URL = "https://linear.app/issue/ENG-142";
const LINK = "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug";

function world() {
  const w = sessionWorld();
  const rewrites: Array<{ taskId: string; key: string | undefined }> = [];
  const live = { rewrite: "ok" as "ok" | "fail" | "throw" };
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
  const deps: SessionReadDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async (task) => ({ taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }) as never,
    audit: audit.audit,
    control: { rewritePullRequestLinearLine: async (task: { taskId: string }, key: string | undefined) => { rewrites.push({ taskId: task.taskId, key }); if (live.rewrite === "throw") throw new Error("GitHub down"); return live.rewrite === "fail" ? { updated: 0, failed: 1 } : { updated: 1, failed: 0 }; } } as never,
  };
  const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
  const request = (who: string, method: string, sessionId: string, rest: string, body?: unknown, orgId: OrgId = ORG_A) => routeAgentSessionRequest(
    deps, w.caller(who, orgId), { method, path: `/v1/app/sessions/${sessionId}${rest}`, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    new URL(`/v1/app/sessions/${sessionId}${rest}`, "https://cell.example.com"),
  ) as Promise<{ session: { sessionId: string; bindings: Array<{ kind: string; url: string }> } }>;
  const link = (who: string, sessionId: string, linear: unknown, extra: Record<string, unknown> = {}, orgId: OrgId = ORG_A) => request(who, "POST", sessionId, "/bindings", { linear, ...extra }, orgId);
  const unlink = (who: string, sessionId: string, orgId: OrgId = ORG_A) => request(who, "DELETE", sessionId, "/bindings/linear", undefined, orgId);
  const binding = (sessionId: string, orgId: OrgId = ORG_A) => w.db.get(sessionBindingKey(orgId, sessionId, "linear_issue")) as { binding: { issueId: string; url: string } } | undefined;
  const surface = (issueId: string, orgId: OrgId = ORG_A) => w.db.get(sessionSurfaceKey(orgId, { kind: "linear_issue", issueId, url: KEY_URL }));
  const timeline = (sessionId: string) => w.db.find((item) => typeof item.pk === "string" && item.pk.includes(sessionId) && String(item.sk).startsWith("EVENT#") && typeof item.text === "string" && /Linear/u.test(item.text)).map((item) => item.text);
  /** A task whose workflow is a Rovara Code (1.1.0) one with the given pull request states, or a version 1 one. */
  const withWorkflow = (taskId: string, definitionVersion: "1.0.0" | "1.1.0", states: Array<"OPEN" | "MERGED" | "CLOSED"> = []) => {
    const item = w.db.get({ pk: `DEVTASK#${taskId}`, sk: "META" }) as Record<string, unknown>;
    w.db.set({ ...item, workflow: { definitionVersion, stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: states.map((state, index) => ({ repositoryId: "api", number: index + 1, url: `https://github.com/acme/api/pull/${String(index + 1)}`, state })) } });
  };
  return { ...w, audit, deps, table, link, unlink, request, binding, surface, timeline, rewrites, live, withWorkflow };
}

describe("linking a session to a Linear issue", () => {
  it("binds the issue by key in one transaction with its timeline line and its audit record, and answers the session", async () => {
    const h = world();
    const { sessionId, taskId } = h.seedSession();
    const before = h.db.transactions().length;
    const reply = await h.link(PRIYA, sessionId, "eng-142");
    expect(reply.session.sessionId).toBe(sessionId);
    expect(reply.session.bindings).toEqual([{ kind: "linear_issue", url: KEY_URL }]);
    expect(h.binding(sessionId)?.binding).toEqual({ kind: "linear_issue", issueId: "ENG-142", url: KEY_URL });
    expect(h.surface("ENG-142")).toMatchObject({ sessionId, kind: "linear_issue" });
    expect(h.timeline(sessionId)).toEqual(["Priya linked this session to Linear issue ENG-142."]);
    const written = h.db.transactions().slice(before);
    expect(written).toHaveLength(1);
    // The binding, its reverse item, the timeline line and the audit item are the same transaction.
    expect(JSON.stringify(written[0])).toContain("SESSION_SURFACE");
    expect(JSON.stringify(written[0])).toContain("Priya linked this session");
    expect(JSON.stringify(written[0])).toContain("AUDIT_PENDING");
    const audited = h.audit.recordedBy("session.linked");
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ orgId: ORG_A, actor: { kind: "member", id: PRIYA }, target: { kind: "session", id: sessionId }, related: [taskId], facts: { surface: "linear_issue" } });
    // And it was handed to the audit queue straight after the commit, not left for the sweep.
    expect(h.audit.flushed().map((event) => event.action)).toEqual(["session.linked"]);
    expect(JSON.stringify(audited[0]?.facts)).not.toContain("ENG-142");
    expect(audited[0]?.details).toEqual([{ subject: "org", fields: { issueKey: "ENG-142" } }]);
  });

  it("takes the issue's Linear link and stores the key, Linear's short link and the link's workspace (M8): the workspace only narrows which comments are believed and where an answer is written, it grants nothing", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    const reply = await h.link(PRIYA, sessionId, `${LINK}?x=1#y`);
    expect(h.binding(sessionId)?.binding).toEqual({ kind: "linear_issue", issueId: "ENG-142", url: KEY_URL, workspace: "acme" });
    // The page shows the link into that workspace, built from the key and the workspace only (never the typed slug text).
    expect(reply.session.bindings).toEqual([{ kind: "linear_issue", url: "https://linear.app/acme/issue/ENG-142" }]);
  });

  it("a bare key names no workspace, and the binding stays as before (the workspace is then read from the company's Linear connection)", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    expect(h.binding(sessionId)?.binding).toEqual({ kind: "linear_issue", issueId: "ENG-142", url: KEY_URL });
    const short = h.seedSession();
    await h.link(PRIYA, short.sessionId, "https://linear.app/issue/ENG-143");
    expect(h.binding(short.sessionId)?.binding).toEqual({ kind: "linear_issue", issueId: "ENG-143", url: "https://linear.app/issue/ENG-143" });
  });

  it("is the key the pull request's description says Fixes for", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    expect(await linearIssueKeyOfTask(h.table, { orgId: ORG_A, sessionId })).toBe("ENG-142");
  });

  it("writes nothing for the same link again, and for the same issue by its link", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    const writes = h.db.transactions().length;
    await h.link(PRIYA, sessionId, "ENG-142");
    await h.link(PRIYA, sessionId, "https://linear.app/issue/eng-142");
    expect(h.db.transactions()).toHaveLength(writes);
    expect(h.timeline(sessionId)).toHaveLength(1);
    expect(h.audit.recordedBy("session.linked")).toHaveLength(1);
  });

  it("refuses another issue on a session that follows one, unless replacing is asked for", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    const refused = await code(h.link(PRIYA, sessionId, "ENG-143"));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    expect(refused?.message).toContain("ENG-142");
    expect(refused?.message).not.toContain("ENG-143");
    expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-142");
    expect(h.timeline(sessionId)).toHaveLength(1);
  });

  it("replaces the issue when it is asked for: the old one is let go, the new one bound, and both are on the timeline and in the audit", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    const reply = await h.link(PRIYA, sessionId, "ENG-143", { replace: true });
    expect(reply.session.bindings).toEqual([{ kind: "linear_issue", url: "https://linear.app/issue/ENG-143" }]);
    expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-143");
    expect(h.surface("ENG-142")).toBeUndefined();
    expect(h.surface("ENG-143")).toMatchObject({ sessionId });
    expect(h.timeline(sessionId)).toEqual(expect.arrayContaining(["Priya linked this session to Linear issue ENG-142.", "Priya unlinked Linear issue ENG-142 from this session.", "Priya linked this session to Linear issue ENG-143."]));
    expect(h.audit.recordedBy("session.unlinked")).toHaveLength(1);
    expect(h.audit.recordedBy("session.linked")).toHaveLength(2);
    expect(h.audit.flushed().map((event) => event.action).sort()).toEqual(["session.linked", "session.linked", "session.unlinked"]);
  });

  it("keeps the old issue when the new one already follows another session", async () => {
    const h = world();
    const first = h.seedSession();
    const other = h.seedSession({ owner: ARJUN });
    await h.link(PRIYA, first.sessionId, "ENG-142");
    await h.link(ARJUN, other.sessionId, "ENG-143");
    const refused = await code(h.link(PRIYA, first.sessionId, "ENG-143", { replace: true }));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID", message: "This issue already follows another session." });
    expect(h.binding(first.sessionId)?.binding.issueId).toBe("ENG-142");
    expect(h.surface("ENG-142")).toMatchObject({ sessionId: first.sessionId });
    expect(h.binding(other.sessionId)?.binding.issueId).toBe("ENG-143");
  });

  it("refuses an issue that already follows another session in the org, and writes nothing", async () => {
    const h = world();
    const first = h.seedSession();
    const second = h.seedSession({ owner: ARJUN });
    await h.link(PRIYA, first.sessionId, "ENG-142");
    expect(await code(h.link(ARJUN, second.sessionId, "ENG-142"))).toEqual({ code: "CONFIG_INVALID", message: "This issue already follows another session." });
    expect(h.binding(second.sessionId)).toBeUndefined();
    expect(h.timeline(second.sessionId)).toEqual([]);
    expect(h.audit.recordedBy("session.linked")).toHaveLength(1);
  });

  it("lets two companies follow the same issue key, each its own session, and shows neither the other's", async () => {
    const h = world();
    const a = h.seedSession();
    const b = h.seedSession({ owner: BO, orgId: ORG_B });
    await h.link(PRIYA, a.sessionId, "ENG-142");
    await h.link(BO, b.sessionId, "ENG-142", {}, ORG_B);
    expect(h.surface("ENG-142", ORG_A)).toMatchObject({ sessionId: a.sessionId });
    expect(h.surface("ENG-142", ORG_B)).toMatchObject({ sessionId: b.sessionId });
    expect(await code(h.link(BO, a.sessionId, "ENG-999", {}, ORG_B))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(await code(h.link(PRIYA, b.sessionId, "ENG-999"))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(h.binding(a.sessionId)?.binding.issueId).toBe("ENG-142");
    expect(h.binding(b.sessionId, ORG_B)?.binding.issueId).toBe("ENG-142");
  });

  it.each([
    "ENG", "ENG-", "-142", "ENG-0", "ENG_142", "ENG-142x", "TOOLONGTEAMKEY-1", "ENG-12345678901", "ENG-142 and OPS-1", "ENG-142\n/approve", "", "   ",
    "https://evil.example/acme/issue/ENG-142", "http://linear.app/acme/issue/ENG-142", "https://linear.app/acme/project/ENG-142", "https://linear.app.evil.example/acme/issue/ENG-142",
    "https://user:pw@linear.app/acme/issue/ENG-142", "javascript:alert(1)", `https://linear.app/acme/issue/ENG-142/${"x".repeat(3000)}`,
  ])("refuses %j, in words that do not repeat it", async (value) => {
    const h = world();
    const { sessionId } = h.seedSession();
    const refused = await code(h.link(PRIYA, sessionId, value));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    if (value.trim().length > 3) expect(refused?.message).not.toContain(value.trim());
    expect(h.binding(sessionId)).toBeUndefined();
    expect(h.db.transactions()).toHaveLength(0);
  });

  it("refuses a body that is not exactly { linear, replace? }", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    for (const body of [{}, { linear: 5 }, { linear: "ENG-1", extra: true }, { linear: "ENG-1", replace: "yes" }, { linear: "ENG-1", replace: false }, { kind: "slack_thread" }, { linear: { key: "ENG-1" } }]) {
      expect(await code(h.request(PRIYA, "POST", sessionId, "/bindings", body)), JSON.stringify(body)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(h.binding(sessionId)).toBeUndefined();
  });

  it("links a task session only, and not a session that has ended", async () => {
    const h = world();
    const chain = h.seedSession({ kind: "chain" });
    const local = h.seedSession({ kind: "local" });
    expect(await code(h.link(PRIYA, chain.sessionId, "ENG-142"))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(h.link(PRIYA, local.sessionId, "ENG-142"))).toMatchObject({ code: "CONFIG_INVALID" });
    const ended = h.seedSession({ ended: true });
    expect(await code(h.link(PRIYA, ended.sessionId, "ENG-142"))).toMatchObject({ code: "SESSION_ENDED" });
    expect(h.db.find((item) => typeof item.pk === "string" && item.pk.includes("SESSION_BINDING#"))).toEqual([]);
  });

  it("fails closed when the session's bindings cannot be read: nothing is written", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    const original = h.db.send.bind(h.db);
    h.db.send = ((command: { constructor: { name: string }; input?: { Key?: { pk?: string } } }) => {
      if (command.constructor.name === "GetCommand" && String(command.input?.Key?.pk ?? "").includes("SESSION_BINDING#")) return Promise.reject(Object.assign(new Error("table down"), { name: "ServiceUnavailable" }));
      return original(command as never);
    });
    await expect(h.link(PRIYA, sessionId, "ENG-142")).rejects.toThrow();
    h.db.send = original;
    expect(h.binding(sessionId)).toBeUndefined();
    expect(h.audit.recordedBy("session.linked")).toEqual([]);
  });
});

describe("who may link and unlink", () => {
  /** The table of levels: what each way of holding a session lets a person do. */
  it.each([
    ["the owner", PRIYA, undefined, true],
    ["a maintainer of the project (edit by their grant)", MAX, undefined, true],
    ["a person it is shared with at edit", ARJUN, "edit", true],
    ["a person it is shared with at use", ARJUN, "use", false],
    ["a person it is shared with at view", ARJUN, "view", false],
    ["a project viewer, even shared at edit", MIA, "edit", false],
    ["an org admin with no grant (view)", OLA, undefined, false],
  ] as const)("%s", async (_name, who, shared, allowed) => {
    const h = world();
    const { sessionId } = h.seedSession();
    if (shared !== undefined) h.seedShare(ORG_A, sessionId, { kind: "member", developerId: who }, shared);
    if (allowed) {
      await h.link(who, sessionId, "ENG-142");
      expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-142");
      await h.unlink(who, sessionId);
      expect(h.binding(sessionId)).toBeUndefined();
    } else {
      expect(await code(h.link(who, sessionId, "ENG-142"))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
      expect(h.binding(sessionId)).toBeUndefined();
      // And a binding someone else made is not undone by them.
      await h.link(PRIYA, sessionId, "ENG-142");
      expect(await code(h.unlink(who, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
      expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-142");
    }
  });

  it("is not found for a member with no role on the project, and for a person of another company", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    expect(await code(h.link(ZED, sessionId, "ENG-142"))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(await code(h.link(BO, sessionId, "ENG-142", {}, ORG_B))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(await code(h.unlink(BO, sessionId, ORG_B))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(h.binding(sessionId)).toBeUndefined();
  });

  it("is not found for a member who has left the company, even the owner, and writes nothing", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    h.db.delete(orgMemberKey(ORG_A, PRIYA));
    const writes = h.db.transactions().length;
    expect(await code(h.link(PRIYA, sessionId, "ENG-143", { replace: true }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(h.unlink(PRIYA, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(h.db.transactions()).toHaveLength(writes);
    expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-142");
  });

  it("reads the level at the time of the request: a share lowered afterwards ends the right", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    h.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    await h.link(ARJUN, sessionId, "ENG-142");
    h.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
    expect(await code(h.unlink(ARJUN, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-142");
  });

  it("gives the linker no new authority: a binding changes nobody's level on the session", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    // Zed has no role on the project; the Linear issue's other participants are nobody here. The binding names no person.
    expect(await code(h.request(ZED, "GET", sessionId, ""))).toMatchObject({ code: "NOT_FOUND" });
    expect(h.binding(sessionId)).not.toHaveProperty("by");
    expect(JSON.stringify(h.binding(sessionId))).not.toMatch(/level|owner|share/u);
  });
});

describe("unlinking", () => {
  it("lets go of both items in one transaction with its timeline line and audit record, and leaves the Slack thread alone", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await bindSessionSurface(h.table, { orgId: ORG_A, sessionId, binding: { kind: "slack_thread", teamId: "T0TEAM001", channelId: "C0CHAN001", threadTs: "1695500000.000031" } });
    await h.link(PRIYA, sessionId, "ENG-142");
    const before = h.db.transactions().length;
    const reply = await h.unlink(PRIYA, sessionId);
    expect(reply.session.bindings.map((entry) => entry.kind)).toEqual(["slack_thread"]);
    expect(h.binding(sessionId)).toBeUndefined();
    expect(h.surface("ENG-142")).toBeUndefined();
    expect(h.db.get(sessionBindingKey(ORG_A, sessionId, "slack_thread"))).toBeDefined();
    expect(h.timeline(sessionId)).toContain("Priya unlinked Linear issue ENG-142 from this session.");
    expect(h.db.transactions().slice(before)).toHaveLength(1);
    expect(h.audit.recordedBy("session.unlinked")).toHaveLength(1);
    expect(h.audit.flushed().map((event) => event.action)).toContain("session.unlinked");
    expect(h.audit.recordedBy("session.unlinked")[0]).toMatchObject({ target: { kind: "session", id: sessionId }, facts: { surface: "linear_issue" }, details: [{ subject: "org", fields: { issueKey: "ENG-142" } }] });
  });

  it("does not act on a binding item that says it belongs to another company", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    h.db.set({ ...sessionBindingKey(ORG_A, sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_B, sessionId, binding: { kind: "linear_issue", issueId: "ENG-142", url: KEY_URL }, at: "2026-10-22T09:00:00.000Z" });
    await h.unlink(PRIYA, sessionId);
    expect(h.db.transactions()).toHaveLength(0);
    expect(h.db.get(sessionBindingKey(ORG_A, sessionId, "linear_issue"))).toBeDefined();
  });

  it("frees the issue for another session", async () => {
    const h = world();
    const first = h.seedSession();
    const second = h.seedSession({ owner: ARJUN });
    await h.link(PRIYA, first.sessionId, "ENG-142");
    await h.unlink(PRIYA, first.sessionId);
    await h.link(ARJUN, second.sessionId, "ENG-142");
    expect(h.surface("ENG-142")).toMatchObject({ sessionId: second.sessionId });
  });

  it("writes nothing when the session follows no issue, and answers the session", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    const reply = await h.unlink(PRIYA, sessionId);
    expect(reply.session.sessionId).toBe(sessionId);
    expect(h.db.transactions()).toHaveLength(0);
    expect(h.audit.recordedBy("session.unlinked")).toEqual([]);
  });

  it("works on a session that has ended, so its issue can be freed", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    h.db.set({ ...(h.db.get({ pk: `ORG#${ORG_A}#SESSION#${sessionId}`, sk: "META" }) as Record<string, unknown>), endedAt: "2026-10-22T08:30:00.000Z" });
    await h.unlink(PRIYA, sessionId);
    expect(h.surface("ENG-142")).toBeUndefined();
  });

  it("does not undo a binding that was replaced by another call at the same moment", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    const original = h.db.send.bind(h.db);
    let swapped = false;
    h.db.send = (async (command: { constructor: { name: string } }) => {
      if (!swapped && command.constructor.name === "TransactWriteCommand") {
        swapped = true;
        // Another call replaced the binding between the read and the write.
        h.db.set({ ...sessionBindingKey(ORG_A, sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_A, sessionId, binding: { kind: "linear_issue", issueId: "ENG-777", url: "https://linear.app/issue/ENG-777" }, at: "2026-10-22T09:30:00.000Z" });
      }
      return original(command as never);
    });
    await h.unlink(PRIYA, sessionId).catch(() => undefined);
    h.db.send = original;
    expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-777");
  });
});

describe("the routes", () => {
  it("answers only POST /bindings and DELETE /bindings/linear, and nothing else under them", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    for (const [method, rest] of [["GET", "/bindings"], ["PUT", "/bindings"], ["DELETE", "/bindings"], ["POST", "/bindings/linear"], ["GET", "/bindings/linear"], ["DELETE", "/bindings/slack"], ["POST", "/bindings/"], ["DELETE", "/bindings/linear/x"]] as const) {
      expect(await code(h.request(PRIYA, method, sessionId, rest, method === "POST" ? { linear: "ENG-142" } : undefined)), `${method} ${rest}`).toEqual({ code: "NOT_FOUND", message: "route not found" });
    }
    expect(await code(h.request(PRIYA, "POST", "not-a-session", "/bindings", { linear: "ENG-142" }))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(h.binding(sessionId)).toBeUndefined();
  });
});

describe("replacing is one transaction", () => {
  it("lets the old issue go and binds the new one together, with both timeline lines and both audit records", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    const before = h.db.transactions().length;
    await h.link(PRIYA, sessionId, "ENG-143", { replace: true });
    const written = h.db.transactions().slice(before);
    expect(written).toHaveLength(1);
    const text = JSON.stringify(written[0]);
    expect(text).toContain("Priya unlinked Linear issue ENG-142");
    expect(text).toContain("Priya linked this session to Linear issue ENG-143");
    expect(h.audit.flushed().map((event) => event.action).sort()).toEqual(["session.linked", "session.linked", "session.unlinked"]);
    expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-143");
    expect(h.surface("ENG-142")).toBeUndefined();
  });

  it("leaves the session exactly as it was when another session takes the new issue in between, and sends no audit record for it", async () => {
    const h = world();
    const first = h.seedSession();
    const other = h.seedSession({ owner: ARJUN });
    await h.link(PRIYA, first.sessionId, "ENG-142");
    const original = h.db.send.bind(h.db);
    let taken = false;
    h.db.send = (async (command: { constructor: { name: string } }) => {
      if (!taken && command.constructor.name === "TransactWriteCommand") {
        taken = true;
        h.db.set({ ...sessionSurfaceKey(ORG_A, { kind: "linear_issue", issueId: "ENG-143", url: KEY_URL }), entityType: "SESSION_SURFACE", orgId: ORG_A, sessionId: other.sessionId, kind: "linear_issue", at: "2026-10-22T09:30:00.000Z" });
      }
      return original(command as never);
    });
    expect(await code(h.link(PRIYA, first.sessionId, "ENG-143", { replace: true }))).toEqual({ code: "CONFIG_INVALID", message: "This issue already follows another session." });
    h.db.send = original;
    expect(h.binding(first.sessionId)?.binding.issueId).toBe("ENG-142");
    expect(h.surface("ENG-142")).toMatchObject({ sessionId: first.sessionId });
    expect(h.audit.recorded().map((event) => event.action)).toEqual(["session.linked"]);
    expect(h.timeline(first.sessionId)).toEqual(["Priya linked this session to Linear issue ENG-142."]);
  });

  it("says so, and changes nothing, when the old link is gone by the time the replacement is made", async () => {
    const h = world();
    const { sessionId } = h.seedSession();
    await h.link(PRIYA, sessionId, "ENG-142");
    const original = h.db.send.bind(h.db);
    let reads = 0;
    h.db.send = (async (command: { constructor: { name: string }; input?: { Key?: { pk?: string; sk?: string } } }) => {
      if (command.constructor.name === "GetCommand" && String(command.input?.Key?.sk) === "BINDING#linear_issue") {
        reads += 1;
        // The first read is the route's; the second is the replacement's own.
        if (reads === 2) h.db.delete(sessionBindingKey(ORG_A, sessionId, "linear_issue"));
      }
      return original(command as never);
    });
    expect(await code(h.link(PRIYA, sessionId, "ENG-143", { replace: true }))).toEqual({ code: "CONFIG_INVALID", message: "This session's link changed just now. Check it and try again." });
    h.db.send = original;
    expect(h.surface("ENG-143")).toBeUndefined();
    expect(h.audit.recorded().map((event) => event.action)).toEqual(["session.linked"]);
  });

  it("changes nothing, and records nothing, when the old link was removed or replaced by another call in between", async () => {
    for (const change of ["removed", "replaced"] as const) {
      const h = world();
      const { sessionId } = h.seedSession();
      await h.link(PRIYA, sessionId, "ENG-142");
      const original = h.db.send.bind(h.db);
      let done = false;
      h.db.send = (async (command: { constructor: { name: string } }) => {
        if (!done && command.constructor.name === "TransactWriteCommand") {
          done = true;
          const key = sessionBindingKey(ORG_A, sessionId, "linear_issue");
          if (change === "removed") h.db.delete(key);
          else h.db.set({ ...key, entityType: "AGENT_SESSION_BINDING", orgId: ORG_A, sessionId, binding: { kind: "linear_issue", issueId: "ENG-777", url: "https://linear.app/issue/ENG-777" }, at: "2026-10-22T09:30:00.000Z" });
        }
        return original(command as never);
      });
      expect(await code(h.link(PRIYA, sessionId, "ENG-143", { replace: true })), change).toMatchObject({ code: "CONFIG_INVALID" });
      h.db.send = original;
      expect(h.surface("ENG-143"), change).toBeUndefined();
      expect(h.audit.recorded().map((event) => event.action), change).toEqual(["session.linked"]);
    }
  });
});

describe("the open pull request's description follows the binding at once", () => {
  it("is rewritten after a link, an unlink and a replace on a version 2 task with an open pull request, and says so", async () => {
    const h = world();
    const { sessionId, taskId } = h.seedSession();
    h.withWorkflow(taskId, "1.1.0", ["OPEN"]);
    expect(await h.link(PRIYA, sessionId, "ENG-142")).toMatchObject({ pullRequest: { description: "updated" } });
    expect(await h.link(PRIYA, sessionId, "ENG-143", { replace: true })).toMatchObject({ pullRequest: { description: "updated" } });
    expect(await h.unlink(PRIYA, sessionId)).toMatchObject({ pullRequest: { description: "updated" } });
    expect(h.rewrites).toEqual([{ taskId, key: "ENG-142" }, { taskId, key: "ENG-143" }, { taskId, key: undefined }]);
  });

  it("tells the person to edit it by hand when it could not be rewritten, naming the issue it may still say", async () => {
    for (const how of ["fail", "throw"] as const) {
      const h = world();
      const { sessionId, taskId } = h.seedSession();
      h.withWorkflow(taskId, "1.1.0", ["OPEN"]);
      await h.link(PRIYA, sessionId, "ENG-142");
      h.live.rewrite = how;
      const reply = await h.unlink(PRIYA, sessionId) as unknown as { pullRequest: { description: string; note: string } };
      expect(reply.pullRequest.description, how).toBe("failed");
      expect(reply.pullRequest.note, how).toContain("ENG-142");
      expect(reply.pullRequest.note, how).toMatch(/edit it on GitHub/u);
      expect(h.binding(sessionId), how).toBeUndefined();
    }
  });

  it("says the first description will carry it when no pull request is open yet, and leaves a merged or closed one alone", async () => {
    const h = world();
    const { sessionId, taskId } = h.seedSession();
    h.withWorkflow(taskId, "1.1.0", []);
    expect(await h.link(PRIYA, sessionId, "ENG-142")).toMatchObject({ pullRequest: { description: "next_update" } });
    const done = world();
    const second = done.seedSession();
    done.withWorkflow(second.taskId, "1.1.0", ["MERGED", "CLOSED"]);
    expect(await done.link(PRIYA, second.sessionId, "ENG-142")).toMatchObject({ pullRequest: { description: "next_update" } });
    expect(done.rewrites).toEqual([]);
  });

  it("says a version 1 task's description will not carry it, so the person writes it there", async () => {
    const h = world();
    const { sessionId, taskId } = h.seedSession();
    h.withWorkflow(taskId, "1.0.0", ["OPEN"]);
    const reply = await h.link(PRIYA, sessionId, "ENG-142") as unknown as { pullRequest: { description: string; note: string } };
    expect(reply.pullRequest.description).toBe("not_for_version");
    expect(reply.pullRequest.note).toMatch(/won't say Fixes ENG-142/u);
    expect(h.rewrites).toEqual([]);
  });

  it("does not fail the call when nothing can rewrite descriptions in this deployment", async () => {
    const h = world();
    const { sessionId, taskId } = h.seedSession();
    h.withWorkflow(taskId, "1.1.0", ["OPEN"]);
    const bare = { ...h.deps, control: undefined } as never;
    const reply = await routeAgentSessionRequest(bare, h.caller(PRIYA, ORG_A), { method: "POST", path: `/v1/app/sessions/${sessionId}/bindings`, headers: {}, requestId: "r", body: JSON.stringify({ linear: "ENG-142" }) }, new URL(`/v1/app/sessions/${sessionId}/bindings`, "https://cell.example.com")) as { pullRequest: { description: string } };
    expect(reply.pullRequest.description).toBe("failed");
    expect(h.binding(sessionId)?.binding.issueId).toBe("ENG-142");
  });
});
