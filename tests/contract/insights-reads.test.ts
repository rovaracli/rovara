/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- the replies are JSON bodies read field by field in assertions; each answer is also parsed by its contract schema where the shape is the point */
// Insights (srv/insights-reads): the reads and the viewer grant, over the session world (a small company with an owner, an admin, a viewer-grant member, a maintainer, members, an Auditor and a second company).
// Every guard here has a case that fails when the guard is removed (the mutations are listed in the lane report): the reader's scope, content hidden from a reader who cannot open the task (names stay),
// the per-person spend filter, the company boundary, the grant writer's owner/admin check, its browser-only rule, its idempotency and its audit.
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentSessionKey, liveSessionKey, orgMemberKey, spendCounterKey, spendRequestKey, openSpendRequestsKey, type OrgId, type SessionStatus } from "../../packages/contracts/src/index.js";
import { InsightsAccessReaderSchema, InsightsOverviewSchema, InsightsSpendSchema, InsightsStuckSchema } from "../../packages/contracts/src/app-insights.js";
import { routeInsights, type InsightsDependencies } from "../../packages/broker/src/insights/routes.js";
import { grantHolds } from "../../packages/broker/src/insights/scope.js";
import { chosenNameKey } from "../../packages/broker/src/developer/chosen-name.js";
import { changeInsightsAccess } from "../../packages/broker/src/insights/access-grant.js";
import { insightsRowKeyOf, opaqueRowId } from "../../packages/broker/src/insights/row-id.js";
import type { LiveDependencies } from "../../packages/broker/src/agent-sessions/live.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { ARJUN, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(loadSlackBroker);
afterEach(() => { delete process.env.INSIGHTS_ENABLED; });

const OWNER = "1".repeat(64), AUDITOR = "2".repeat(64), BO_ADMIN = "3".repeat(64), STRANGER = "4".repeat(64), BO = "9".repeat(64);
const HOUR = 3_600_000;
const ROW_KEY = insightsRowKeyOf("k".repeat(64));
/** The opaque id a metadata row carries for a session or a spending request (company A unless said). */
const opaque = (rawId: string, orgId: OrgId = ORG_A) => opaqueRowId(ROW_KEY, orgId, rawId);
const ON = { INSIGHTS_ENABLED: "1" } as NodeJS.ProcessEnv;
type Item = Record<string, unknown>;
type Extra = { [K in keyof InsightsDependencies]?: InsightsDependencies[K] | undefined };
type Reply = { status: number; body: Record<string, any> } | { code: string; message: string };
const iso = (ms: number) => new Date(ms).toISOString();

function company() {
  const w = sessionWorld();
  w.member(ORG_A, OWNER, "owner");
  w.member(ORG_A, AUDITOR, "auditor");
  w.member(ORG_B, BO_ADMIN, "admin");
  // ZED is a member with no project role who holds the viewer grant (given by Ola: the ledger says so, the record does not).
  const grantTo = (who: string, at = "2026-10-10T00:00:00.000Z") => w.db.set({ ...w.db.get(orgMemberKey(ORG_A, who))!, insightsViewer: true, insightsGrantedAt: at });
  grantTo(ZED);
  const sent: unknown[] = [];
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
  let beforeTransact: (() => void) | undefined;
  const client = { send: async (command: unknown) => {
    sent.push(command);
    if (command instanceof TransactWriteCommand && beforeTransact !== undefined) { const run = beforeTransact; beforeTransact = undefined; run(); }
    return w.db.send(command as never);
  } };
  const sessions = (): LiveDependencies => ({
    documentClient: client, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64), taskView: async () => ({}) as never,
  });
  const deps = (extra: Extra = {}): InsightsDependencies => ({
    documentClient: client, tableName: "state", now: () => w.clock.now, signInTableName: "state", projectMembers: w.members, sessions: sessions(), rowKey: ROW_KEY, audit: { ...audit.audit, tableName: "state" }, ...extra,
  }) as InsightsDependencies;
  let minute = 0;
  const seed = (o: { owner?: string; project?: string | null; status?: SessionStatus; needs?: string[]; pending?: number; kind?: "task" | "local"; ageHours: number; orgId?: OrgId; ended?: boolean; people?: Array<{ developerId: string; role: "owner" | "commenter" | "viewer" | "denied" }>; title?: string; step?: string }) => {
    const orgId = o.orgId ?? ORG_A;
    minute += 1;
    const seeded = w.seedSession({ kind: o.kind ?? "task", owner: o.owner ?? PRIYA, ...(o.project === undefined ? {} : { project: o.project }), orgId, ...(o.people === undefined ? {} : { people: o.people }) });
    const meta = w.db.get(agentSessionKey(orgId, seeded.sessionId, "META")) as Item & { kind: string; project?: string; revision: number; createdAt: string };
    const updatedAt = iso(T0 - o.ageHours * HOUR - minute);
    const summary = { status: o.status ?? "needs_person", ...(o.step === undefined ? {} : { step: o.step }), costUsd: 0, needsPeople: o.needs ?? [], pendingApprovals: o.pending ?? 0, digest: "d".repeat(64), computedAt: updatedAt };
    const record: Item & { kind: string; project?: string; revision: number; createdAt: string } = { ...meta, updatedAt, summary, summaryRevision: 2, title: o.title ?? "Rotate the payment keys", ...(o.ended === true ? { endedAt: iso(T0 - HOUR) } : {}) };
    w.db.set(record);
    w.db.set({ ...liveSessionKey(orgId, seeded.sessionId), entityType: "LIVE_SESSION", orgId, sessionId: seeded.sessionId, kind: record.kind, ...(record.project === undefined ? {} : { project: record.project }),
      ownerId: o.owner ?? PRIYA, title: record.title, status: summary.status, summary, summaryRevision: 2, revision: record.revision, createdAt: record.createdAt, updatedAt, ...(o.ended === true ? { endedAt: iso(T0 - HOUR) } : {}) });
    return seeded;
  };
  const caller = (who: string, orgRole: string, orgId: OrgId = ORG_A, browser = true) => ({ developerId: who, orgId, orgRole, ...(browser ? { browserSession: true as const } : {}) });
  const call = async (who: ReturnType<typeof caller>, method: string, path: string, body?: unknown, extra: Extra = {}): Promise<Reply> => {
    try {
      const reply = await routeInsights(deps(extra), who, { method, path: path.split("?")[0], headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) } as never, new URL(`${CELL}${path}`), ON);
      return reply === undefined ? { code: "UNROUTED", message: "" } : { status: reply.statusCode, body: reply.body as Record<string, any> };
    } catch (error) { const e = error as { code?: string; message: string }; return { code: e.code ?? "ERROR", message: e.message.replace(`${String(e.code)}: `, "") }; }
  };
  const who = { owner: caller(OWNER, "owner"), admin: caller(OLA, "admin"), viewer: caller(ZED, "member"), maintainer: caller(MAX, "member"), member: caller(PRIYA, "member"), reader: caller(MIA, "member"), auditor: caller(AUDITOR, "auditor"), bo: caller(BO_ADMIN, "admin", ORG_B), stranger: caller(STRANGER, "member") };
  return { ...w, seed, call, caller, who, deps, audit, sent, transact: (run: () => void) => { beforeTransact = run; }, grantTo };
}
type World = ReturnType<typeof company>;
const ok = (reply: Reply) => { if (!("status" in reply)) throw new Error(`expected 200, got ${reply.code}: ${reply.message}`); return reply.body; };
const code = (reply: Reply) => ("code" in reply ? reply.code : `HTTP ${reply.status}`);

/** Four stuck sessions in company A, one running, one ended, and one stuck session in company B. */
function stuckWorld() {
  const c = company();
  c.project(ORG_B, "web");
  const s1 = c.seed({ project: "web", status: "needs_person", needs: [ARJUN], ageHours: 30, title: "Retry the payment webhook" });
  const s2 = c.seed({ project: "ops", status: "failed", ageHours: 80, title: "Fix the ops deploy" });
  const s3 = c.seed({ project: "web", owner: ARJUN, status: "paused", ageHours: 5, title: "Backfill the invoices", people: [{ developerId: ARJUN, role: "owner" }, { developerId: MAX, role: "denied" }] });
  const s4 = c.seed({ kind: "local", project: null, status: "stopped", ageHours: 10, title: "Local experiment on my Mac" });
  const running = c.seed({ project: "web", status: "running", ageHours: 2 });
  const ended = c.seed({ project: "web", status: "needs_person", ageHours: 3, ended: true });
  const other = c.seed({ orgId: ORG_B, project: "web", owner: BO, status: "needs_person", ageHours: 40, title: "Company B secret plan" });
  return { c, s1, s2, s3, s4, running, ended, other };
}
const rows = (body: Record<string, any>) => body.items as Array<Record<string, any>>;
const ids = (body: Record<string, any>) => rows(body).map((item) => item.itemId);
const CONTENT = ["title", "reason", "link"] as const;

describe("who sees what", () => {
  it("gives an owner and an admin the company, a viewer the company, a maintainer only their projects, and everyone else nothing", async () => {
    const { c } = stuckWorld();
    const got = async (who: ReturnType<World["caller"]>) => ok(await c.call(who, "GET", "/v1/app/insights"));
    expect(InsightsOverviewSchema.parse(await got(c.who.owner))).toMatchObject({ enabled: true, viewer: { role: "owner", via: ["owner"], scope: { kind: "company" }, canSeePerPerson: true } });
    expect(await got(c.who.admin)).toMatchObject({ viewer: { role: "admin", via: ["admin"], scope: { kind: "company" }, canSeePerPerson: true, contentLevel: "full_where_readable" } });
    expect(await got(c.who.viewer)).toMatchObject({ viewer: { role: "member", via: ["viewer_grant"], scope: { kind: "company" }, canSeePerPerson: false, contentLevel: "metadata_only_elsewhere" } });
    expect(await got(c.who.maintainer)).toMatchObject({ viewer: { role: "member", via: ["maintainer"], scope: { kind: "projects", projects: ["web"] }, canSeePerPerson: false } });
    // Nothing for a plain member, a project viewer, a person with no record, and the Auditor (with a session that says Auditor, or one that says member).
    for (const who of [c.who.member, c.who.reader, c.who.stranger, c.who.auditor, c.caller(AUDITOR, "member")]) expect(code(await c.call(who, "GET", "/v1/app/insights")), who.developerId).toBe("FORBIDDEN");
    for (const path of ["/stuck", "/spend", "/shipped", "/flow"]) {
      expect(code(await c.call(c.who.member, "GET", `/v1/app/insights${path}`))).toBe("FORBIDDEN");
      expect(code(await c.call(c.who.auditor, "GET", `/v1/app/insights${path}`))).toBe("FORBIDDEN");
    }
  });

  it("never gives the Auditor a scope, even one that holds a project grant, and never trusts a session that says Auditor", async () => {
    const { c } = stuckWorld();
    // The Auditor holds no project role in the real store; if a stale grant row existed it still must not open Insights (the dispatcher's allow-list is positive, and this check refuses again).
    c.grant(AUDITOR, "web", "maintainer");
    for (const path of ["/v1/app/insights", "/v1/app/insights/stuck", "/v1/app/insights/spend"]) expect(code(await c.call(c.who.auditor, "GET", path)), path).toBe("FORBIDDEN");
    expect(code(await c.call(c.caller(AUDITOR, "member"), "GET", "/v1/app/insights"))).toBe("FORBIDDEN");
    // A session that says Auditor is refused although the record is a maintainer's member record.
    expect(code(await c.call(c.caller(MAX, "auditor"), "GET", "/v1/app/insights"))).toBe("FORBIDDEN");
    expect(code(await c.call(c.caller(MAX, "somethingnew"), "GET", "/v1/app/insights/stuck"))).toBe("FORBIDDEN");
    expect(code(await c.call(c.caller(MAX, "member"), "GET", "/v1/app/insights"))).toBe("HTTP 200");
  });

  it("combines what a person holds: a maintainer who is also a viewer sees the company", async () => {
    const { c } = stuckWorld();
    c.grantTo(MAX);
    expect(ok(await c.call(c.who.maintainer, "GET", "/v1/app/insights")).viewer).toMatchObject({ via: ["viewer_grant", "maintainer"], scope: { kind: "company" } });
  });

  it("reads the role from the member record now, not from the session", async () => {
    const { c } = stuckWorld();
    // The session says admin; the record says member with nothing else: no scope.
    c.db.set({ ...c.db.get(orgMemberKey(ORG_A, OLA))!, role: "member" });
    expect(code(await c.call(c.who.admin, "GET", "/v1/app/insights/spend"))).toBe("FORBIDDEN");
    // And a record that is the Auditor's, whatever the session says.
    c.db.set({ ...c.db.get(orgMemberKey(ORG_A, OWNER))!, role: "auditor" });
    expect(code(await c.call(c.who.owner, "GET", "/v1/app/insights/spend"))).toBe("FORBIDDEN");
  });

  it("is off while the switch is off: the overview says so and every other path is not found", async () => {
    const { c } = stuckWorld();
    for (const value of [undefined, "0", "true", " 1"]) {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { INSIGHTS_ENABLED: value };
      const run = async (path: string, who = c.who.owner) => routeInsights(c.deps(), who, { method: "GET", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`), env);
      expect((await run("/v1/app/insights"))?.body).toMatchObject({ enabled: false });
      expect(InsightsOverviewSchema.safeParse((await run("/v1/app/insights"))?.body).success).toBe(true);
      for (const path of ["/v1/app/insights/stuck", "/v1/app/insights/spend", "/v1/app/insights/shipped", "/v1/app/insights/flow", "/v1/app/org/insights-access"]) expect(await run(path), `${String(value)} ${path}`).toBeUndefined();
    }
  });
});

describe("stuck work", () => {
  it("lists the open work that needs someone, the longest wait first, from the company's index only", async () => {
    const { c, s1, s2, s3, s4, running, ended, other } = stuckWorld();
    const body = InsightsStuckSchema.parse(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck")));
    // Positive control: the list is not empty, the sessions that need someone are on it, and the one that is running or ended is not.
    // The admin opens the task sessions (raw id) but not the one on someone's Mac (s4: a metadata row, opaque id).
    expect(ids(body)).toEqual([s2.sessionId, s1.sessionId, opaque(s4.sessionId), s3.sessionId]);
    expect(ids(body)).not.toContain(running.sessionId);
    expect(ids(body)).not.toContain(ended.sessionId);
    // Company B's session and its words never appear for company A, and A's never for B.
    expect(JSON.stringify(body)).not.toContain(other.sessionId);
    expect(JSON.stringify(body)).not.toContain("Company B secret plan");
    const theirs = InsightsStuckSchema.parse(ok(await c.call(c.who.bo, "GET", "/v1/app/insights/stuck")));
    expect(ids(theirs)).toEqual([other.sessionId]);
    expect(theirs.items[0]).toMatchObject({ visibility: "full", title: "Company B secret plan" });
    expect(JSON.stringify(theirs)).not.toContain(s1.sessionId);
    expect(body.summary).toMatchObject({ total: 4, over24h: 2, over72h: 1, byNextActorKind: { person: 3, role: 1, group: 0 }, byBlocker: { decision: 2, failure: 1, budget: 1 } });
    expect(body.coverage).toEqual({ sources: ["sessions", "spend_requests"], notCovered: ["change_approvals", "plan_reviews", "merge_readiness", "handoff_blockers"], partial: false, truncated: false });
    expect(rows(body)[1]).toMatchObject({ sinceKind: "last_update", ageHours: 30, state: "needs_you", stateWords: "Needs you", blocker: "decision", project: "web" });
  });

  it("shows names on every row and content only where the reader could open the task", async () => {
    const { c, s1, s2, s3, s4 } = stuckWorld();
    // An admin opens task sessions (view) but not a session on someone's Mac: that row is metadata, with names.
    const admin = ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck"));
    const byId = (body: Record<string, any>) => Object.fromEntries(rows(body).map((item) => [item.itemId, item]));
    expect(byId(admin)[s1.sessionId]).toMatchObject({ visibility: "full", title: "Retry the payment webhook", link: `${CELL}/app/sessions/${s1.sessionId}`, nextActor: { kind: "person", name: "Arjun" }, owner: { id: PRIYA, name: "Priya" } });
    expect(byId(admin)[s2.sessionId]).toMatchObject({ visibility: "full", title: "Fix the ops deploy", nextActor: { kind: "person", name: "Priya", role: "owner" } });
    const local = byId(admin)[opaque(s4.sessionId)];
    expect(local).toMatchObject({ visibility: "metadata", owner: { id: PRIYA, name: "Priya" }, nextActor: { kind: "person", name: "Priya", role: "owner" }, project: "No project" });
    for (const field of CONTENT) expect(local, field).not.toHaveProperty(field);
    // A viewer-grant member has no project role: EVERY row is metadata, and every row still names who owns it and who it waits on. Not one word of content, anywhere in the answer.
    const viewer = ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/stuck"));
    // Every viewer row carries the opaque id (stable: the same work reads the same for the admin's metadata row), never the session id, and the raw id appears nowhere in the answer.
    expect(ids(viewer)).toEqual([s2, s1, s4, s3].map((seeded) => opaque(seeded.sessionId)));
    for (const seeded of [s1, s2, s3, s4]) expect(JSON.stringify(viewer), seeded.sessionId).not.toContain(seeded.sessionId);
    for (const item of rows(viewer)) {
      expect(item.visibility, item.itemId).toBe("metadata");
      for (const field of CONTENT) expect(item, `${item.itemId} ${field}`).not.toHaveProperty(field);
      expect(item.owner.name, item.itemId).toMatch(/^(Priya|Arjun)$/u);
      expect(item.nextActor.kind, item.itemId).not.toBe("unknown");
    }
    expect(byId(viewer)[opaque(s1.sessionId)]).toMatchObject({ nextActor: { kind: "person", name: "Arjun" }, owner: { name: "Priya" } });
    expect(byId(viewer)[opaque(s3.sessionId)]).toMatchObject({ owner: { name: "Arjun" }, blocker: "budget", nextActor: { kind: "role", role: "approver" } });
    for (const phrase of ["Retry the payment webhook", "Fix the ops deploy", "Backfill the invoices", "Local experiment", "app/sessions"]) expect(JSON.stringify(viewer)).not.toContain(phrase);
  });

  it("scopes a maintainer to their projects, and a maintainer the task denies sees metadata only", async () => {
    const { c, s1, s2, s3, s4 } = stuckWorld();
    const body = ok(await c.call(c.who.maintainer, "GET", "/v1/app/insights/stuck"));
    // s1 the maintainer can open (raw id); s3 is denied to them by a Task People entry (a metadata row, opaque id).
    expect(ids(body).sort()).toEqual([s1.sessionId, opaque(s3.sessionId)].sort());
    expect(JSON.stringify(body)).not.toContain(s3.sessionId);
    for (const out of [s2, s4]) for (const id of [out.sessionId, opaque(out.sessionId)]) expect(ids(body)).not.toContain(id);
    expect(body.summary.total).toBe(2);
    const by = Object.fromEntries(rows(body).map((item) => [item.itemId, item]));
    expect(by[s1.sessionId]).toMatchObject({ visibility: "full", title: "Retry the payment webhook" });
    // Max is denied on the task of s3 (a Task People entry): the row stays, with names, without content.
    expect(by[opaque(s3.sessionId)]).toMatchObject({ visibility: "metadata", owner: { name: "Arjun" } });
    for (const field of CONTENT) expect(by[opaque(s3.sessionId)]).not.toHaveProperty(field);
    expect(JSON.stringify(body)).not.toContain("Backfill the invoices");
    // A project outside the scope is refused with one sentence whether or not it exists; inside it, the list narrows.
    for (const project of ["ops", "nope", "Not A Name"]) expect(code(await c.call(c.who.maintainer, "GET", `/v1/app/insights/stuck?project=${encodeURIComponent(project)}`)), project).toBe("FORBIDDEN");
    expect(ids(ok(await c.call(c.who.maintainer, "GET", "/v1/app/insights/stuck?project=web"))).sort()).toEqual([s1.sessionId, opaque(s3.sessionId)].sort());
    // A company reader: an unknown project is not found; a known one narrows.
    expect(code(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck?project=nope"))).toBe("PROJECT_NOT_FOUND");
    expect(ids(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck?project=ops")))).toEqual([s2.sessionId]);
  });

  it("does not trust an index or a record that names another company", async () => {
    const { c, s1, other } = stuckWorld();
    // A tile in A's index that says company B, and one that is A's but whose session record says company B.
    c.db.set({ ...(c.db.get(liveSessionKey(ORG_B, other.sessionId)) as Item), ...liveSessionKey(ORG_A, other.sessionId) });
    const planted = c.seed({ project: "web", status: "needs_person", ageHours: 50, title: "Planted" });
    c.db.set({ ...(c.db.get(agentSessionKey(ORG_A, planted.sessionId, "META")) as Item), orgId: ORG_B });
    const body = ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck"));
    expect(ids(body)).toContain(s1.sessionId);
    expect(ids(body)).not.toContain(other.sessionId);
    expect(ids(body)).not.toContain(planted.sessionId);
  });

  it("pages with an opaque cursor, the summary covering the whole list, and refuses a bad parameter", async () => {
    const { c, s1, s2, s3, s4 } = stuckWorld();
    const first = ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck?limit=3"));
    expect(ids(first)).toEqual([s2.sessionId, s1.sessionId, opaque(s4.sessionId)]);
    expect(first.summary.total).toBe(4);
    expect(typeof first.next).toBe("string");
    const second = ok(await c.call(c.who.admin, "GET", `/v1/app/insights/stuck?limit=3&cursor=${first.next as string}`));
    expect(ids(second)).toEqual([s3.sessionId]);
    expect(second.next).toBeUndefined();
    // A viewer pages the same list: the cursor handed out names the opaque id of the last row, never a session id, and the second page continues from it.
    const v1 = ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/stuck?limit=2"));
    const cursorText = Buffer.from(v1.next as string, "base64url").toString("utf8");
    for (const seeded of [s1, s2, s3, s4]) expect(cursorText, seeded.sessionId).not.toContain(seeded.sessionId);
    expect(cursorText).toContain(opaque(s1.sessionId));
    const v2 = ok(await c.call(c.who.viewer, "GET", `/v1/app/insights/stuck?limit=2&cursor=${v1.next as string}`));
    expect([...ids(v1), ...ids(v2)]).toEqual([s2, s1, s4, s3].map((seeded) => opaque(seeded.sessionId)));
    expect(ids(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck?minAgeHours=24")))).toEqual([s2.sessionId, s1.sessionId]);
    for (const query of ["limit=0", "limit=101", "limit=x", "minAgeHours=-1", "cursor=nonsense", "limit=2.5"]) expect(code(await c.call(c.who.admin, "GET", `/v1/app/insights/stuck?${query}`)), query).toBe("CONFIG_INVALID");
  });

  it("adds an open budget request to its session's row and lists one that belongs to no session as a metadata row", async () => {
    const { c, s3 } = stuckWorld();
    const task = (c.db.get(agentSessionKey(ORG_A, s3.sessionId, "META")) as { subject: { taskId: string } }).subject.taskId;
    const request = (id: string, extra: Item) => {
      const record = { orgId: ORG_A, spendRequestId: id, kind: "run_limit", amountUsd: 5, reason: "needs more", requestedBy: { kind: "system" }, approverRole: "org_admin", approverIds: [OLA], status: "PENDING", createdAt: iso(T0 - 20 * HOUR), expiresAt: iso(T0 + 24 * HOUR), ...extra };
      c.db.set({ ...spendRequestKey(ORG_A, id), entityType: "SPEND_REQUEST", ...record });
      c.db.set({ ...openSpendRequestsKey(ORG_A, record.createdAt, id), entityType: "SPEND_REQUEST_OPEN", orgId: ORG_A, spendRequestId: id, approverIds: record.approverIds });
    };
    request("spr_00000000000000000001", { taskId: task, scope: { kind: "task", taskId: task } });
    request("spr_00000000000000000002", { kind: "month", scope: { kind: "project", project: "ops" }, approverRole: "project_maintainer", createdAt: iso(T0 - 6 * HOUR) });
    request("spr_00000000000000000003", { createdAt: iso(T0 - 7 * HOUR), expiresAt: iso(T0 - HOUR) }); // expired: not listed
    const body = InsightsStuckSchema.parse(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck")));
    const by = Object.fromEntries(rows(body).map((item) => [item.itemId, item]));
    // The session's own row, now with the request as its blocker and the older of the two times.
    expect(by[s3.sessionId]).toMatchObject({ blocker: "spend", sinceKind: "state", ageHours: 20, nextActor: { kind: "role", role: "admin" }, visibility: "full" });
    expect(by[opaque("spr_00000000000000000002")]).toMatchObject({ visibility: "metadata", project: "ops", blocker: "spend", state: "unknown", stateWords: "Waiting for a budget decision", nextActor: { kind: "role", role: "maintainer" } });
    // The budget request that belongs to no session is a metadata row: its opaque id, and the spending request id appears nowhere in the answer (for the admin, or for a viewer).
    expect(Object.keys(by)).not.toContain("spr_00000000000000000002");
    expect(JSON.stringify(body)).not.toContain("spr_0000000000000000000");
    expect(JSON.stringify(ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/stuck")))).not.toContain("spr_0000000000000000000");
    expect(Object.keys(by)).not.toContain(opaque("spr_00000000000000000003"));
    expect(body.summary.byBlocker.spend).toBe(2);
    // A maintainer of web sees the request that rides on their session; the month request names ops, so not that one.
    const mine = ok(await c.call(c.who.maintainer, "GET", "/v1/app/insights/stuck"));
    expect(ids(mine)).not.toContain(opaque("spr_00000000000000000002"));
    expect(rows(mine).find((item) => item.itemId === opaque(s3.sessionId))?.blocker).toBe("spend");
  });

  it("makes the opaque id stable, different in every company and for every row, and refuses to list without its key", async () => {
    const { c, s1, s2, other } = stuckWorld();
    // Stable across requests, and the same work has the same id for every reader who cannot open it.
    const first = ids(ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/stuck")));
    expect(ids(ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/stuck")))).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    for (const id of first) expect(id).toMatch(/^itm_[0-9a-f]{32}$/u);
    // Different in every company (the same raw id in another company gives another token) and under another install key.
    expect(opaque(s1.sessionId, ORG_B)).not.toBe(opaque(s1.sessionId));
    expect(opaqueRowId(insightsRowKeyOf("j".repeat(64)), ORG_A, s1.sessionId)).not.toBe(opaque(s1.sessionId));
    expect(opaque(s1.sessionId)).not.toBe(opaque(s2.sessionId));
    // Company B's viewer-level reader would see B's own token for B's work, which company A's list never holds.
    expect(first).not.toContain(opaque(other.sessionId, ORG_B));
    // No key, no list: a metadata row must never fall back to the raw id.
    for (const rowKey of [undefined, ""]) {
      const answer = ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck", undefined, { rowKey }));
      expect(InsightsStuckSchema.parse(answer), String(rowKey)).toMatchObject({ status: "unavailable", items: [], summary: { total: 0 } });
      expect(JSON.stringify(answer)).not.toContain(s1.sessionId);
    }
    expect(() => insightsRowKeyOf(undefined)).toThrow();
  });

  it("says when a source is missing instead of failing, and answers unavailable with nothing to read", async () => {
    const { c } = stuckWorld();
    const without = ok(await c.call(c.who.admin, "GET", "/v1/app/insights/stuck", undefined, { sessions: undefined }));
    expect(without).toMatchObject({ status: "unavailable", items: [], coverage: { sources: ["spend_requests"], partial: true } });
  });
});

describe("spend", () => {
  function spendWorld() {
    const c = company();
    const counter = (org: OrgId, sk: string, spentUsd: number, committedUsd: number) => c.db.set({ ...spendCounterKey(org, "2026-10", sk), entityType: "SPEND_COUNTER", spentUsd, committedUsd });
    counter(ORG_A, "ORG", 100, 120); counter(ORG_A, "PROJECT#web", 60, 70); counter(ORG_A, "PROJECT#ops", 40, 50);
    counter(ORG_A, `MEMBER#${PRIYA}`, 30, 35); counter(ORG_A, `MEMBER#${ARJUN}`, 70, 80);
    counter(ORG_B, "ORG", 999, 999); counter(ORG_B, "PROJECT#web", 999, 999); counter(ORG_B, `MEMBER#${BO}`, 999, 999);
    return c;
  }
  it("gives an owner and an admin the company, each project and each person", async () => {
    const c = spendWorld();
    for (const who of [c.who.owner, c.who.admin]) {
      const body = InsightsSpendSchema.parse(ok(await c.call(who, "GET", "/v1/app/insights/spend")));
      expect(body).toMatchObject({ month: "2026-10", scope: "company", totals: { spentUsd: 100, committedUsd: 120 }, outcomes: { status: "unavailable" } });
      expect(body.byProject).toEqual([
        { project: "web", spentUsd: 60, committedUsd: 70, people: null, shipped: null, costPerShippedUsd: null }, { project: "ops", spentUsd: 40, committedUsd: 50, people: null, shipped: null, costPerShippedUsd: null },
      ]);
      expect(body.byPerson).toEqual([{ developerId: ARJUN, name: "Arjun", spentUsd: 70 }, { developerId: PRIYA, name: "Priya", spentUsd: 30 }]);
    }
  });

  it("gives a viewer and a maintainer no per-person figure at all: the key is absent, in any shape, and the member counters are never read", async () => {
    const c = spendWorld();
    c.sent.length = 0;
    const viewer = ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/spend"));
    expect(viewer.totals).toEqual({ spentUsd: 100, committedUsd: 120 });
    expect(viewer.byProject.map((row: Item) => row.project)).toEqual(["web", "ops"]);
    const maintainer = ok(await c.call(c.who.maintainer, "GET", "/v1/app/insights/spend"));
    expect(maintainer.scope).toBe("projects");
    expect(maintainer.byProject.map((row: Item) => row.project)).toEqual(["web"]);
    expect(maintainer).not.toHaveProperty("totals");
    for (const body of [viewer, maintainer]) {
      expect(body).not.toHaveProperty("byPerson");
      expect(body).not.toHaveProperty("byMember");
      expect(JSON.stringify(body)).not.toMatch(new RegExp(`${PRIYA}|${ARJUN}|MEMBER#|Arjun|Priya`, "u"));
      expect(InsightsSpendSchema.safeParse(body).success).toBe(true);
    }
    // Positive control: the reads that served the admin did ask for the member counters; the ones that served the others did not.
    const prefixes = (commands: unknown[]) => commands.filter((command): command is QueryCommand => command instanceof QueryCommand).map((command) => command.input.ExpressionAttributeValues?.[":prefix"]);
    expect(prefixes(c.sent)).not.toContain("MEMBER#");
    c.sent.length = 0;
    await c.call(c.who.admin, "GET", "/v1/app/insights/spend");
    expect(prefixes(c.sent)).toContain("MEMBER#");
  });

  it("keeps a maintainer to their projects and a company reader to the company's", async () => {
    const c = spendWorld();
    expect(code(await c.call(c.who.maintainer, "GET", "/v1/app/insights/spend?project=ops"))).toBe("FORBIDDEN");
    expect(ok(await c.call(c.who.maintainer, "GET", "/v1/app/insights/spend?project=web")).byProject).toHaveLength(1);
    expect(code(await c.call(c.who.admin, "GET", "/v1/app/insights/spend?project=nope"))).toBe("PROJECT_NOT_FOUND");
    expect(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/spend?project=ops")).byProject.map((row: Item) => row.project)).toEqual(["ops"]);
    // Company B's counters are never in company A's answer, and the reverse.
    const theirs = ok(await c.call(c.who.bo, "GET", "/v1/app/insights/spend"));
    expect(theirs.totals.spentUsd).toBe(999);
    expect(theirs.byPerson).toEqual([{ developerId: BO, name: "Bo", spentUsd: 999 }]);
    expect(JSON.stringify(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/spend")))).not.toContain("999");
    expect(code(await c.call(c.who.admin, "GET", "/v1/app/insights/spend?month=2026-13"))).toBe("CONFIG_INVALID");
    expect(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/spend?month=2026-09"))).toMatchObject({ month: "2026-09", totals: { spentUsd: 0 } });
  });
});

describe("shipped and flow", () => {
  it("say they are not available, with no figure, and check their parameters", async () => {
    const { c } = stuckWorld();
    expect(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/shipped"))).toEqual({ status: "unavailable", collectingSince: null, weeks: [] });
    expect(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/flow?days=90"))).toEqual({ days: 90, status: "unavailable", collectingSince: null, minSamples: 5, byProject: [] });
    expect(ok(await c.call(c.who.admin, "GET", "/v1/app/insights/flow"))).toMatchObject({ days: 30 });
    for (const path of ["/shipped?weeks=0", "/shipped?weeks=27", "/flow?days=14", "/flow?days=x"]) expect(code(await c.call(c.who.admin, "GET", `/v1/app/insights${path}`)), path).toBe("CONFIG_INVALID");
    expect(code(await c.call(c.who.member, "GET", "/v1/app/insights/shipped"))).toBe("FORBIDDEN");
    const overview = ok(await c.call(c.who.admin, "GET", "/v1/app/insights"));
    expect(overview.panels).toMatchObject({ shipped: { status: "unavailable" }, flow: { status: "unavailable" }, spend: { outcomesStatus: "unavailable" } });
    expect(overview.capture).toEqual({ workEvents: "off", since: null, retentionMonths: 13 });
  });
});

describe("the viewer grant", () => {
  const PATH = "/v1/app/org/insights-access";
  const body = (who: string, action: "grant" | "revoke" = "grant", requestId = "11111111-1111-4111-8111-111111111111") => ({ action, requestId, developerId: who });
  const events = (c: World) => c.audit.recorded().filter((event) => event.action.startsWith("insights_access."));
  const writes = (c: World) => c.db.transactions().length;

  it("lists who holds it for an owner or admin, and for no one else", async () => {
    const { c } = stuckWorld();
    for (const who of [c.who.owner, c.who.admin]) {
      const list = InsightsAccessReaderSchema.parse(ok(await c.call(who, "GET", PATH)));
      // No ledger lookup is wired here: the date is always there, the name of who gave it is left out, never guessed.
      expect(list).toEqual({ viewers: [{ person: { id: ZED, name: "Zed" }, grantedAt: "2026-10-10T00:00:00.000Z" }], eligibleCount: 4 });
      expect(list.viewers[0]).not.toHaveProperty("grantedBy");
    }
    for (const who of [c.who.viewer, c.who.maintainer, c.who.member, c.who.auditor, c.who.stranger]) expect(code(await c.call(who, "GET", PATH)), who.developerId).toBe("FORBIDDEN");
    // Another company's members are not counted or listed.
    const theirs = ok(await c.call(c.who.bo, "GET", PATH));
    expect(theirs).toEqual({ viewers: [], eligibleCount: 1 });
  });

  it("names who gave a grant from the ledger, for exactly that grant, and leaves the name out when the ledger cannot say", async () => {
    const { c } = stuckWorld();
    const asked: Array<Array<{ developerId: string; at: string }>> = [];
    const ledger = (answer: Map<string, string> | Error): Extra => ({ grantedBy: async (_caller, grants) => { asked.push([...grants]); if (answer instanceof Error) throw answer; return answer; } });
    // The ledger names Ola: the list shows her, resolved live.
    const named = ok(await c.call(c.who.admin, "GET", PATH, undefined, ledger(new Map([[ZED, OLA]]))));
    expect(named.viewers).toEqual([{ person: { id: ZED, name: "Zed" }, grantedBy: { id: OLA, name: "Ola" }, grantedAt: "2026-10-10T00:00:00.000Z" }]);
    expect(asked).toEqual([[{ developerId: ZED, at: "2026-10-10T00:00:00.000Z" }]]);
    // A granter who was erased reads "A former member", from the live name items; the stored id is not what is shown.
    c.db.set({ ...chosenNameKey(OLA), entityType: "DEVELOPER_NAME", developerId: OLA, erased: true, erasedAt: "2026-10-12T00:00:00.000Z" });
    expect(ok(await c.call(c.who.admin, "GET", PATH, undefined, ledger(new Map([[ZED, OLA]])))).viewers[0].grantedBy).toMatchObject({ name: "A former member" });
    // A ledger that fails, or does not know the grant: the date only, no name, no guess; the answer is still 200 and still lists the grant.
    for (const answer of [new Error("ledger down"), new Map<string, string>()]) {
      const reply = ok(await c.call(c.who.admin, "GET", PATH, undefined, ledger(answer)));
      expect(reply.viewers).toEqual([{ person: { id: ZED, name: "Zed" }, grantedAt: "2026-10-10T00:00:00.000Z" }]);
    }
    // Only an owner or admin reaches the lookup at all.
    asked.length = 0;
    expect(code(await c.call(c.who.viewer, "GET", PATH, undefined, ledger(new Map([[ZED, OLA]]))))).toBe("FORBIDDEN");
    expect(asked).toEqual([]);
  });

  it("grants on the member's record, audits it in the same transaction, and takes effect at the next read", async () => {
    const { c } = stuckWorld();
    const before = ok(await c.call(c.who.maintainer, "GET", "/v1/app/insights/spend"));
    expect(before.scope).toBe("projects");
    const memberBefore = { ...c.db.get(orgMemberKey(ORG_A, MAX))! };
    const answer = ok(await c.call(c.who.admin, "POST", PATH, body(MAX)));
    expect(answer.viewers.map((viewer: Item) => (viewer.person as { id: string }).id).sort()).toEqual([MAX, ZED].sort());
    expect(answer.eligibleCount).toBe(3);
    const record = c.db.get(orgMemberKey(ORG_A, MAX))!;
    expect(record).toMatchObject({ role: "member", insightsViewer: true, insightsGrantedAt: iso(T0) });
    // The record gains exactly a flag and a time: no person id of the granter (or anyone) is written to it.
    expect(Object.keys(record).filter((key) => !(key in memberBefore)).sort()).toEqual(["insightsGrantedAt", "insightsViewer"]);
    expect(JSON.stringify(record)).not.toContain(OLA);
    // One transaction: the actor's role check, the member change, the request item and the audit item.
    const [transaction] = c.db.transactions().slice(-1);
    expect(transaction!.map((entry) => Object.keys(entry)[0])).toEqual(["ConditionCheck", "Update", "Put", "Put"]);
    expect(events(c)).toEqual([expect.objectContaining({ action: "insights_access.granted", actor: { kind: "member", id: OLA }, target: { kind: "member", id: MAX }, orgId: ORG_A })]);
    // Effect: no cache. The role is still a member's: a grant is not a role.
    expect(ok(await c.call(c.who.maintainer, "GET", "/v1/app/insights/spend")).scope).toBe("company");
    expect(c.db.get(orgMemberKey(ORG_A, MAX))!.role).toBe("member");
  });

  it("answers a repeat of the same request with the stored outcome and writes nothing, and refuses the same id with another body", async () => {
    const { c } = stuckWorld();
    ok(await c.call(c.who.admin, "POST", PATH, body(MAX)));
    const [done, audited] = [writes(c), events(c).length];
    expect(ok(await c.call(c.who.admin, "POST", PATH, body(MAX)))).toMatchObject({ eligibleCount: 3 });
    expect(writes(c)).toBe(done);
    expect(events(c)).toHaveLength(audited);
    // The same id for another person, or another action, is refused and writes nothing.
    expect(code(await c.call(c.who.admin, "POST", PATH, body(MIA)))).toBe("CONFIG_INVALID");
    expect(code(await c.call(c.who.admin, "POST", PATH, body(MAX, "revoke")))).toBe("CONFIG_INVALID");
    expect(c.db.get(orgMemberKey(ORG_A, MIA))).not.toHaveProperty("insightsViewer");
    expect(c.db.get(orgMemberKey(ORG_A, MAX))).toHaveProperty("insightsViewer", true);
    // A new request for a grant already held, and a revoke of one not held, are 200: no member changes and no audit event is written (only the request item is: see the no-op test).
    const memberNow = { ...c.db.get(orgMemberKey(ORG_A, MAX))! }, miaNow = { ...c.db.get(orgMemberKey(ORG_A, MIA))! };
    ok(await c.call(c.who.admin, "POST", PATH, body(MAX, "grant", "22222222-2222-4222-8222-222222222222")));
    ok(await c.call(c.who.admin, "POST", PATH, body(MIA, "revoke", "33333333-3333-4333-8333-333333333333")));
    expect(c.db.get(orgMemberKey(ORG_A, MAX))).toEqual(memberNow);
    expect(c.db.get(orgMemberKey(ORG_A, MIA))).toEqual(miaNow);
    expect(events(c)).toHaveLength(audited);
    // A late replay of the first request after the opposite action changes nothing.
    ok(await c.call(c.who.admin, "POST", PATH, body(MAX, "revoke", "44444444-4444-4444-8444-444444444444")));
    expect(c.db.get(orgMemberKey(ORG_A, MAX))).not.toHaveProperty("insightsViewer");
    const afterRevoke = writes(c);
    ok(await c.call(c.who.admin, "POST", PATH, body(MAX)));
    expect(writes(c)).toBe(afterRevoke);
    expect(c.db.get(orgMemberKey(ORG_A, MAX))).not.toHaveProperty("insightsViewer");
  });

  it("takes the request id for a no-op too: a grant already held and a revoke of one not held replay with the same body and are refused with another", async () => {
    const { c } = stuckWorld();
    const requestItem = (id: string) => c.db.get({ pk: `ORG#${ORG_A}#INSIGHTS_ACCESS_REQUEST`, sk: id });
    const GRANT_NOOP = "55555555-5555-4555-8555-555555555555", REVOKE_NOOP = "66666666-6666-4666-8666-666666666666";
    const zed = { ...c.db.get(orgMemberKey(ORG_A, ZED))! }, mia = { ...c.db.get(orgMemberKey(ORG_A, MIA))! };
    const audited = events(c).length;
    // ZED already holds the grant; MIA does not. Both are no-ops: 200, the list as it is, no member change, no audit event, but the id is recorded.
    expect(ok(await c.call(c.who.admin, "POST", PATH, body(ZED, "grant", GRANT_NOOP))).viewers).toHaveLength(1);
    ok(await c.call(c.who.admin, "POST", PATH, body(MIA, "revoke", REVOKE_NOOP)));
    expect(requestItem(GRANT_NOOP)).toMatchObject({ action: "grant", requestId: GRANT_NOOP });
    expect(requestItem(REVOKE_NOOP)).toMatchObject({ action: "revoke", requestId: REVOKE_NOOP });
    expect(c.db.get(orgMemberKey(ORG_A, ZED))).toEqual(zed);
    expect(c.db.get(orgMemberKey(ORG_A, MIA))).toEqual(mia);
    expect(events(c)).toHaveLength(audited);
    // Positive control: the id with the same body replays (200, nothing more written) ...
    const done = writes(c);
    ok(await c.call(c.who.admin, "POST", PATH, body(ZED, "grant", GRANT_NOOP)));
    ok(await c.call(c.who.admin, "POST", PATH, body(MIA, "revoke", REVOKE_NOOP)));
    expect(writes(c)).toBe(done);
    // ... and with another person or another action it is refused, and the grant that would have followed does not happen.
    expect(code(await c.call(c.who.admin, "POST", PATH, body(MIA, "grant", GRANT_NOOP)))).toBe("CONFIG_INVALID");
    expect(code(await c.call(c.who.admin, "POST", PATH, body(ZED, "revoke", GRANT_NOOP)))).toBe("CONFIG_INVALID");
    expect(code(await c.call(c.who.admin, "POST", PATH, body(MIA, "grant", REVOKE_NOOP)))).toBe("CONFIG_INVALID");
    expect(c.db.get(orgMemberKey(ORG_A, MIA))).not.toHaveProperty("insightsViewer");
    expect(c.db.get(orgMemberKey(ORG_A, ZED))).toHaveProperty("insightsViewer", true);
    // The no-op does not skip the actor's live check: a demoted actor writes nothing.
    c.db.set({ ...c.db.get(orgMemberKey(ORG_A, OLA))!, role: "member" });
    expect(code(await c.call(c.who.admin, "POST", PATH, body(ZED, "grant", "77777777-7777-4777-8777-777777777777")))).toBe("FORBIDDEN");
    expect(requestItem("77777777-7777-4777-8777-777777777777")).toBeUndefined();
  });

  it("revokes at the next request and audits it", async () => {
    const { c } = stuckWorld();
    expect(ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/spend")).scope).toBe("company");
    const answer = ok(await c.call(c.who.owner, "POST", PATH, body(ZED, "revoke")));
    expect(answer).toMatchObject({ viewers: [], eligibleCount: 5 });
    expect(c.db.get(orgMemberKey(ORG_A, ZED))).not.toHaveProperty("insightsGrantedAt");
    expect(code(await c.call(c.who.viewer, "GET", "/v1/app/insights/spend"))).toBe("FORBIDDEN");
    expect(events(c).map((event) => event.action)).toEqual(["insights_access.revoked"]);
  });

  it("is for a live owner or admin from a live browser session: a token, a member, a maintainer, a viewer and the Auditor write nothing", async () => {
    const { c } = stuckWorld();
    const before = writes(c);
    const token = { ...c.who.admin, browserSession: undefined } as never;
    expect(code(await c.call(token, "POST", PATH, body(MAX)))).toBe("FORBIDDEN");
    for (const who of [c.who.maintainer, c.who.viewer, c.who.member, c.who.auditor, c.who.stranger]) expect(code(await c.call(who, "POST", PATH, body(MIA))), who.developerId).toBe("FORBIDDEN");
    expect(writes(c)).toBe(before);
    expect(events(c)).toEqual([]);
    expect(c.db.get(orgMemberKey(ORG_A, MAX))).not.toHaveProperty("insightsViewer");
    // The role is read from the member record now: an admin demoted since their session began cannot grant.
    c.db.set({ ...c.db.get(orgMemberKey(ORG_A, OLA))!, role: "member" });
    expect(code(await c.call(c.who.admin, "POST", PATH, body(MAX)))).toBe("FORBIDDEN");
    expect(writes(c)).toBe(before);
  });

  it("refuses a token at the writer itself, whoever the token stands for", async () => {
    const { c } = stuckWorld();
    const before = writes(c);
    const token = { developerId: OLA, orgId: ORG_A, orgRole: "admin" };
    await expect(changeInsightsAccess(c.deps(), token, body(MAX))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writes(c)).toBe(before);
    expect(c.db.get(orgMemberKey(ORG_A, MAX))).not.toHaveProperty("insightsViewer");
    await expect(changeInsightsAccess(c.deps(), c.who.member, body(MAX))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writes(c)).toBe(before);
  });

  it("refuses the write when the actor is demoted between the read and the commit", async () => {
    const { c } = stuckWorld();
    c.transact(() => c.db.set({ ...c.db.get(orgMemberKey(ORG_A, OLA))!, role: "member" }));
    expect(code(await c.call(c.who.admin, "POST", PATH, body(MAX)))).toBe("CHANGE_STALE");
    expect(c.db.get(orgMemberKey(ORG_A, MAX))).not.toHaveProperty("insightsViewer");
    expect(events(c)).toEqual([]);
  });

  it("refuses an owner, an admin and the Auditor as the person, finds no one who is not a member, and echoes nothing", async () => {
    const { c } = stuckWorld();
    const before = writes(c);
    for (const target of [OWNER, OLA, AUDITOR]) expect(code(await c.call(c.who.admin, "POST", PATH, body(target, "grant", `5555555${target.slice(0, 1)}-5555-4555-8555-555555555555`))), target).toBe("CONFIG_INVALID");
    expect((await c.call(c.who.admin, "POST", PATH, body(AUDITOR, "grant", "66666666-6666-4666-8666-666666666666")) as { message: string }).message).toBe("An Auditor reads the audit log only.");
    // A person of another company, and one nobody knows, are the same not-found, with a fixed sentence.
    for (const target of [BO, BO_ADMIN, STRANGER]) {
      const reply = await c.call(c.who.admin, "POST", PATH, body(target, "grant", `7777777${target.slice(0, 1)}-7777-4777-8777-777777777777`));
      expect(reply).toEqual({ code: "NOT_FOUND", message: "Not found." });
    }
    expect(writes(c)).toBe(before);
    expect(c.db.get(orgMemberKey(ORG_B, BO_ADMIN))).not.toHaveProperty("insightsViewer");
    expect(code(await c.call(c.who.admin, "POST", PATH, { action: "grant", developerId: MAX }))).toBe("CONFIG_INVALID");
    expect(code(await c.call(c.who.admin, "POST", PATH, { ...body(MAX), role: "admin" }))).toBe("CONFIG_INVALID");
    expect(code(await c.call(c.who.admin, "POST", PATH, body("Priya")))).toBe("CONFIG_INVALID");
  });

  it("needs the audit ledger: with none, nothing is granted", async () => {
    const { c } = stuckWorld();
    expect(code(await c.call(c.who.admin, "POST", PATH, body(MAX), { audit: undefined }))).toBe("AUDIT_UNAVAILABLE");
    expect(c.db.get(orgMemberKey(ORG_A, MAX))).not.toHaveProperty("insightsViewer");
  });

  it("is void once a role change touched the record, and never counts for an Auditor or an unreadable record", async () => {
    const { c } = stuckWorld();
    const record = c.db.get(orgMemberKey(ORG_A, ZED))!;
    expect(grantHolds(record)).toBe(true);
    // A role change after the grant (the record is a member again): not a viewer until an admin gives it again.
    c.db.set({ ...record, roleUpdatedAt: "2026-10-11T00:00:00.000Z" });
    expect(code(await c.call(c.who.viewer, "GET", "/v1/app/insights/spend"))).toBe("FORBIDDEN");
    expect(ok(await c.call(c.who.admin, "GET", PATH))).toMatchObject({ viewers: [], eligibleCount: 5 });
    // A role change BEFORE the grant is fine.
    c.db.set({ ...record, roleUpdatedAt: "2026-10-09T00:00:00.000Z" });
    expect(ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/spend")).scope).toBe("company");
    for (const bad of [{ role: "auditor" }, { role: "admin" }, { insightsGrantedAt: "soon" }, { insightsViewer: "yes" }, { roleUpdatedAt: "later" }]) expect(grantHolds({ ...record, ...bad }), JSON.stringify(bad)).toBe(false);
    c.db.set({ ...record, role: "auditor" });
    expect(code(await c.call(c.caller(ZED, "member"), "GET", "/v1/app/insights/spend"))).toBe("FORBIDDEN");
    // A grant gives an owner or an admin nothing extra, and a regrant after a role change replaces the stale one.
    c.db.set({ ...record, roleUpdatedAt: "2026-10-11T00:00:00.000Z" });
    ok(await c.call(c.who.admin, "POST", PATH, body(ZED, "grant", "88888888-8888-4888-8888-888888888888")));
    expect(ok(await c.call(c.who.viewer, "GET", "/v1/app/insights/spend")).scope).toBe("company");
  });
});
