// srv/needs-broker-ui-2, items 5 and 6: the Finished list for the Team and Company scopes (`GET /v1/app/sessions?scope=team|company&status=ended`), and how a finished session ended
// (`finishedAs`, mapped from the summary's stored status model only). The scoped list reads only the indexes that already exist and shows only sessions the caller can open now.
import { describe, expect, it } from "vitest";
import { FINISHED_AS, SessionListReaderSchema, SessionListSchema, TASK_STATUS_ANSWERED_REASON, orgMemberKey } from "@agentx/cloud-contracts";
import { agentSessionKey, mySessionsKey, projectMemberKey, projectSessionsKey, type OrgId } from "@rovara-code/contracts";
import { finishedAsOf } from "../../packages/broker/src/agent-sessions/finished-as.js";
import { listFinishedScope } from "../../packages/broker/src/agent-sessions/finished-scope.js";
import { listSessions, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { ARJUN, BO, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, CELL, sessionWorld } from "../support/agent-session-world.js";

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const flip = (text: string) => `${text.slice(0, 5)}${text[5] === "A" ? "B" : "A"}${text.slice(6)}`;

function scopedWorld() {
  const w = sessionWorld();
  const deps: SessionReadDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => { throw new Error("not read by a list"); },
  };
  /** Writes the index rows a start writes for a session, at `createdAt` (and the session's own created time to match). */
  const index = (sessionId: string, orgId: OrgId, createdAt: string) => {
    const meta = w.db.get(agentSessionKey(orgId, sessionId, "META"))!;
    w.db.set({ ...meta, createdAt });
    const owner = (meta.owner as { developerId: string }).developerId;
    w.db.set({ ...mySessionsKey(orgId, owner, createdAt, sessionId), entityType: "MY_SESSION", orgId, sessionId, developerId: owner, createdAt });
    if (meta.project !== undefined) w.db.set({ ...projectSessionsKey(orgId, meta.project as string, createdAt, sessionId), entityType: "PROJECT_SESSION", orgId, sessionId, project: meta.project, createdAt });
  };
  const display = (sessionId: string, shown: Record<string, unknown> | undefined, orgId: OrgId = ORG_A) => {
    const meta = w.db.get(agentSessionKey(orgId, sessionId, "META"))!;
    w.db.set({ ...meta, summary: { ...(meta.summary as Record<string, unknown>), ...(shown === undefined ? {} : { display: shown }) } });
  };
  const shareWith = (sessionId: string, developerId: string) => w.seedShare(ORG_A, sessionId, { kind: "member", developerId }, "view");

  const a = w.seedSession({ ended: true });                      // Priya's, on web
  const b = w.seedSession({ ended: true, owner: ARJUN });        // Arjun's, on web
  const c = w.seedSession({ ended: true, project: "ops" });      // Priya's, on ops (only Priya, as owner, and the admin can open it)
  const d = w.seedSession({ ended: true, kind: "local" });       // Priya's Mac session, on web, shared with nobody
  const e = w.seedSession({});                                   // Priya's, on web, still open
  const g = w.seedSession({ ended: true, project: null });       // Priya's, on no project
  const h = w.seedSession({ ended: true, people: [{ developerId: ARJUN, role: "denied" }] }); // Priya's, on web, Arjun is denied on it
  const f = w.seedSession({ ended: true, orgId: ORG_B, owner: BO }); // Bo's, in the other org, on its web
  index(a.sessionId, ORG_A, "2026-10-22T08:01:00.000Z");
  index(b.sessionId, ORG_A, "2026-10-22T08:02:00.000Z");
  index(c.sessionId, ORG_A, "2026-10-22T08:03:00.000Z");
  index(d.sessionId, ORG_A, "2026-10-22T08:04:00.000Z");
  index(e.sessionId, ORG_A, "2026-10-22T08:05:00.000Z");
  index(g.sessionId, ORG_A, "2026-10-22T08:06:00.000Z");
  index(h.sessionId, ORG_A, "2026-10-22T08:07:00.000Z");
  index(f.sessionId, ORG_B, "2026-10-22T08:08:00.000Z");
  const ids = { a: a.sessionId, b: b.sessionId, c: c.sessionId, d: d.sessionId, e: e.sessionId, g: g.sessionId, h: h.sessionId, f: f.sessionId };
  const list = (who: string, scope: string, extra: Partial<Parameters<typeof listFinishedScope>[2]> = {}, orgId: OrgId = ORG_A) =>
    listFinishedScope(deps, w.caller(who, orgId), { scope, status: "ended", ...extra });
  const ofIds = (page: { sessions: Array<{ sessionId: string }> }) => page.sessions.map((tile) => tile.sessionId);
  return { w, deps, ids, list, ofIds, shareWith, display };
}

describe("the Finished list for the Team and Company scopes", () => {
  it("lists a contributor's team: the ended sessions on the projects they hold a role on, newest first, with a session they can't open left out", async () => {
    const s = scopedWorld();
    // Arjun is a contributor on web: Priya's task session, his own, and not her Mac session (nothing shared), not her ops one, not the one that denies him, not the open one, not the other org's.
    const page = await s.list(ARJUN, "team");
    expect(s.ofIds(page)).toEqual([s.ids.b, s.ids.a]);
    expect(SessionListSchema.parse(page)).toEqual(page);
    expect(SessionListReaderSchema.safeParse(page).success).toBe(true);
    expect(page.sessions.every((tile) => tile.endedAt !== undefined)).toBe(true);
    expect(page.next).toBeUndefined();
    // The session that denies him is a positive control: the team it belongs to does list it for someone who may open it.
    expect(s.ofIds(await s.list(PRIYA, "team"))).toContain(s.ids.h);
    expect(s.ofIds(await s.list(ARJUN, "team"))).not.toContain(s.ids.h);
  });

  it("never shows a session the caller can't open, and takes a share or a revoked role into account on the next call", async () => {
    const s = scopedWorld();
    expect(s.ofIds(await s.list(ARJUN, "company"))).toEqual([s.ids.b, s.ids.a]);
    // Priya's Mac session joins his list only when it is shared with him.
    s.shareWith(s.ids.d, ARJUN);
    expect(s.ofIds(await s.list(ARJUN, "team"))).toEqual([s.ids.d, s.ids.b, s.ids.a]);
    // His role is read now: once the grant is gone, so is the whole project from his list.
    s.w.members.revoke(ORG_A, "web", ARJUN);
    s.w.db.delete(projectMemberKey(ORG_A, ARJUN, "web"));
    const after = await s.list(ARJUN, "company");
    expect(s.ofIds(after)).toEqual([s.ids.b]); // only his own, which the company scope reads from his own index
    expect(s.ofIds(await s.list(ARJUN, "team"))).toEqual([]);
    // A person with no role at all sees nothing, in either scope.
    expect(s.ofIds(await s.list(ZED, "team"))).toEqual([]);
    expect(s.ofIds(await s.list(ZED, "company"))).toEqual([]);
  });

  it("lists the company scope: the team's, the caller's own on any project or none, and an admin's reach into every project", async () => {
    const s = scopedWorld();
    // Priya: web's ended task sessions (a, b, h), her own on ops (c), on no project (g) and her Mac one (d), newest first.
    expect(s.ofIds(await s.list(PRIYA, "company"))).toEqual([s.ids.h, s.ids.g, s.ids.d, s.ids.c, s.ids.b, s.ids.a]);
    // Her team is only what she holds a role on, and her Mac session is her own, so not the team's.
    expect(s.ofIds(await s.list(PRIYA, "team"))).toEqual([s.ids.h, s.ids.b, s.ids.a]);
    // The org admin (an admin on record: the caller object here says "member") has no grant, so the team (the Live wall's rule) is empty, and the company scope reaches every project's
    // task sessions, but not a Mac session nobody shared with them.
    expect(s.ofIds(await s.list(OLA, "team"))).toEqual([]);
    expect(s.ofIds(await s.list(OLA, "company"))).toEqual([s.ids.h, s.ids.c, s.ids.b, s.ids.a]);
    // A viewer and a maintainer read the team the same way.
    expect(s.ofIds(await s.list(MIA, "team"))).toEqual([s.ids.h, s.ids.b, s.ids.a]);
    expect(s.ofIds(await s.list(MAX, "team"))).toEqual([s.ids.h, s.ids.b, s.ids.a]);
  });

  it("never shows another company's sessions, and never shows ours to another company", async () => {
    const s = scopedWorld();
    for (const scope of ["team", "company"]) {
      expect(s.ofIds(await s.list(BO, scope, {}, ORG_B)), scope).toEqual([s.ids.f]);
      for (const who of [PRIYA, ARJUN, OLA, ZED, MAX]) expect(s.ofIds(await s.list(who, scope)), `${scope} ${who}`).not.toContain(s.ids.f);
    }
    // A stale index row of ours that names the other org's session (or one whose record is the other org's) shows nothing.
    s.w.db.set({ ...projectSessionsKey(ORG_A, "web", "2026-10-22T08:09:00.000Z", s.ids.f), entityType: "PROJECT_SESSION", orgId: ORG_B, sessionId: s.ids.f, project: "web", createdAt: "2026-10-22T08:09:00.000Z" });
    s.w.db.set({ ...projectSessionsKey(ORG_A, "web", "2026-10-22T08:10:00.000Z", s.ids.f), entityType: "PROJECT_SESSION", orgId: ORG_A, sessionId: s.ids.f, project: "web", createdAt: "2026-10-22T08:10:00.000Z" });
    expect(s.ofIds(await s.list(PRIYA, "company"))).not.toContain(s.ids.f);
    expect(s.ofIds(await s.list(BO, "company", {}, ORG_B))).toEqual([s.ids.f]);
  });

  it("answers an empty list to someone who is no longer a member of the org", async () => {
    const s = scopedWorld();
    expect((await s.list(ARJUN, "company")).sessions.length).toBeGreaterThan(0);
    s.w.db.delete(orgMemberKey(ORG_A, ARJUN));
    expect(await s.list(ARJUN, "company")).toEqual({ sessions: [] });
    expect(await s.list(ARJUN, "team")).toEqual({ sessions: [] });
  });

  it("uses the live org role, not the one the caller was signed in with", async () => {
    const s = scopedWorld();
    // Ola is an admin on record. A caller object that says "member" still gets the admin's reach, and one that says "admin" gets a member's once the record says member.
    const asMember = { ...s.w.caller(OLA), orgRole: "member" as const };
    expect(s.ofIds(await listFinishedScope(s.deps, asMember, { scope: "company", status: "ended" }))).toEqual([s.ids.h, s.ids.c, s.ids.b, s.ids.a]);
    s.w.members.setOrgRole(ORG_A, OLA, "member");
    s.w.db.set({ ...orgMemberKey(ORG_A, OLA), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: OLA, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
    const asAdmin = { ...s.w.caller(OLA), orgRole: "admin" as const };
    expect(s.ofIds(await listFinishedScope(s.deps, asAdmin, { scope: "company", status: "ended" }))).toEqual([]);
  });

  it("pages across the partitions with one opaque cursor, each session once, bound to the scope and the person", async () => {
    const s = scopedWorld();
    const everything = s.ofIds(await s.list(PRIYA, "company"));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await s.list(PRIYA, "company", { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.sessions.length).toBeLessThanOrEqual(2);
      seen.push(...s.ofIds(page));
      cursor = page.next;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(everything);
    const first = await s.list(PRIYA, "company", { limit: 2 });
    expect(first.next).toEqual(expect.any(String));
    expect(first.next).not.toMatch(/ses_[0-9a-z]{20}/);
    // Another scope, another person, or a changed cursor is refused without echoing it.
    expect(await code(s.list(PRIYA, "team", { cursor: first.next! }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.list(ARJUN, "company", { cursor: first.next! }))).toMatchObject({ code: "CONFIG_INVALID" });
    const refused = await code(s.list(PRIYA, "company", { cursor: flip(first.next!) }));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    expect(refused?.message).not.toContain(first.next!.slice(0, 20));
  });

  it("refuses what it does not list: no status, open, another selector, an unknown scope, a bad limit", async () => {
    const s = scopedWorld();
    expect(await code(listFinishedScope(s.deps, s.w.caller(PRIYA), { scope: "company" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.list(PRIYA, "company", { status: "open" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.list(PRIYA, "company", { owner: "me" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.list(PRIYA, "company", { project: "web" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.list(PRIYA, "everyone"))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.list(PRIYA, "company", { limit: 0 }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.list(PRIYA, "company", { limit: 101 }))).toMatchObject({ code: "CONFIG_INVALID" });
    // The old list still refuses a scope it was not given, and keeps its own message for none.
    expect(await code(listSessions(s.deps, s.w.caller(PRIYA), { scope: "team", status: "ended" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(listSessions(s.deps, s.w.caller(PRIYA), { status: "ended" }))).toEqual({ code: "CONFIG_INVALID", message: "Choose one of owner, project or shared." });
  });
});

describe("how a finished session ended (finishedAs)", () => {
  const summary = (display?: unknown) => ({ summary: { status: "succeeded", display } }) as never;
  it("maps each stored outcome, and anything else is plainly finished", () => {
    // merged: the stored state is Merged
    expect(finishedAsOf(summary({ state: "merged", next: "Nothing; this task is complete." }))).toBe("merged");
    // closed: its owner closed it (a Closed with no reason)
    expect(finishedAsOf(summary({ state: "closed", next: "Nothing; this task is closed." }))).toBe("closed");
    // finished_no_code: a question that needed no code change
    expect(finishedAsOf(summary({ state: "closed", reason: TASK_STATUS_ANSWERED_REASON }))).toBe("finished_no_code");
    // a Closed that carries another reason, or that can still be retried, is not "closed by its owner"
    expect(finishedAsOf(summary({ state: "closed", reason: "every step finished and the changes wait in the task's workspace" }))).toBe("finished");
    expect(finishedAsOf(summary({ state: "closed", reason: "the run was cancelled before it finished", retryable: true }))).toBe("finished");
    expect(finishedAsOf(summary({ state: "closed", retryable: true }))).toBe("finished");
    // other stored states, a failed run, a run that finished
    for (const state of ["failed", "finished_run", "needs_you", "building"]) expect(finishedAsOf(summary({ state })), state).toBe("finished");
    // nothing stored (an older summary), a state this build does not know, a malformed display
    expect(finishedAsOf(summary(undefined))).toBe("finished");
    expect(finishedAsOf(summary({ state: "frozen_solid" }))).toBe("finished");
    expect(finishedAsOf(summary({ state: "merged", extra: true }))).toBe("finished");
    expect(finishedAsOf(summary("merged"))).toBe("finished");
    expect(finishedAsOf(summary(null))).toBe("finished");
  });

  it("is on the tile of an ended session only, in every list that shows ended sessions, and parses with the schemas", async () => {
    const s = scopedWorld();
    s.display(s.ids.a, { state: "merged" });
    s.display(s.ids.b, { state: "closed" });
    s.display(s.ids.g, { state: "closed", reason: TASK_STATUS_ANSWERED_REASON });
    s.display(s.ids.h, { state: "failed", reason: "the run stopped with an error" });
    const company = await s.list(PRIYA, "company");
    const by = Object.fromEntries(company.sessions.map((tile) => [tile.sessionId, tile.finishedAs]));
    expect(by).toEqual({ [s.ids.a]: "merged", [s.ids.b]: "closed", [s.ids.g]: "finished_no_code", [s.ids.h]: "finished", [s.ids.c]: "finished", [s.ids.d]: "finished" });
    expect(Object.values(by).every((value) => (FINISHED_AS as readonly string[]).includes(value as string))).toBe(true);
    expect(SessionListSchema.parse(company)).toEqual(company);
    expect(SessionListReaderSchema.safeParse(company).success).toBe(true);
    // The caller's own list says the same, and an open session carries none.
    const mine = await listSessions(s.deps, s.w.caller(PRIYA), { owner: "me" });
    expect(Object.fromEntries(mine.sessions.map((tile) => [tile.sessionId, tile.finishedAs]))).toMatchObject({ [s.ids.a]: "merged", [s.ids.g]: "finished_no_code" });
    expect(mine.sessions.find((tile) => tile.sessionId === s.ids.e)).not.toHaveProperty("finishedAs");
  });
});
