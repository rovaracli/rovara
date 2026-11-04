// "Your private channels" in the Add form's Slack picker (source-row lane, task 11, A): `GET .../record/sources/options?kind=slack-private&cursor=`. An editor is offered the private channels that BOTH Rovara and
// they are in, found with their OWN linked Slack user id (read by the server from the sign-in store, never from the request). Nobody sees a private channel name they are not in. Everything comes from the caller's
// session org. Same harness shape as `source-options.test.ts` (copied: not exported).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, slackTeamOrgKey, teamRecordPk, type OrgId } from "@agentx/contracts";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { dynamoRateLimiter } from "../../../packages/broker/src/team-record/query.js";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import type { SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import { recordWriteContextOf } from "../../../packages/broker/src/aws/developer-routes/team-record-source-write.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B, caller, world, type World } from "../../support/team-record-core.js";

const OWNER = "a".repeat(64), MAINT = "c".repeat(64), MAINT2 = "9".repeat(64), CONTRIB = "d".repeat(64), AUDITOR = "e".repeat(64), OTHER_ORG_MAINT = "1".repeat(64), UNLINKED = "8".repeat(64);
type OrgRole = "owner" | "admin" | "member" | "auditor";
interface Who { id: string; orgRole: OrgRole; projectRole: "maintainer" | "contributor" | "viewer" | undefined }
const WHO = {
  owner: { id: OWNER, orgRole: "owner", projectRole: "maintainer" },
  maint: { id: MAINT, orgRole: "member", projectRole: "maintainer" },
  maint2: { id: MAINT2, orgRole: "member", projectRole: "maintainer" },
  unlinked: { id: UNLINKED, orgRole: "member", projectRole: "maintainer" },
  contributor: { id: CONTRIB, orgRole: "member", projectRole: "contributor" },
  auditor: { id: AUDITOR, orgRole: "auditor", projectRole: "maintainer" },
  stranger: { id: "f".repeat(64), orgRole: "member", projectRole: undefined },
  otherMaint: { id: OTHER_ORG_MAINT, orgRole: "member", projectRole: "maintainer" },
} as const satisfies Record<string, Who>;

const AT = "2026-10-01T00:00:00.000Z";
function seedCompany(db: FakeDynamoDb, orgId: OrgId, people: Record<string, OrgRole>, maintainers: Array<{ id: string; project: string }>, projects: string[]): void {
  db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG", createdAt: AT, approvalMembershipVersion: 3, approvalTrackingSince: AT });
  for (const project of projects) db.set({ ...projectMetaKey(orgId, project), entityType: "PROJECT_META", name: project, status: "active", createdAt: AT, archiveRevision: 0 });
  for (const [id, role] of Object.entries(people)) {
    db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role, joinedAt: AT });
    db.set({ ...developerOrgKey(id), orgId, role });
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false });
  }
  for (const { id, project } of maintainers) db.set({ ...projectMemberKey(orgId, id, project), ownerKey: id, projectName: project, role: "developer", projectRole: "maintainer", grantId: `grant-${id.slice(0, 4)}` });
}

const TEAM_A = "T0AAAAAAA", TEAM_B = "T0BBBBBBB";
const U1 = "U0PERSON1", U1B = "U0PERSON1B", U2 = "U0PERSON2", U_OTHER_ORG = "U0OTHERORG";
const priv = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `secret-${id.toLowerCase()}`, kind: "private" as const, extShared: false, joined: true, ...over });
const CH = { a: "C0PRIVATEA", b: "C0PRIVATEB", c: "G0PRIVATEC", connect: "C0PRIVCONN", taken: "C0PRIVTAKE", mine: "C0PRIVMINE", of2: "C0ONLYUSR2", pub: "C0PUBLIC01" } as const;
const slackScope = (channel: string, team = TEAM_A) => `slack:${team}/${channel}`;

type MemberRead = NonNullable<SourceWriteContext["slackMemberChannels"]>;
interface Harness {
  w: World; audit: ReturnType<typeof capturingAuditDeps>;
  /** Which Slack team each company bound. */ teams: Map<OrgId, string>;
  /** Each person's linked Slack user ids, as the server's sign-in store holds them. */ linked: Map<string, string[]>; linkedReads: string[]; linkedFails: boolean;
  /** What Slack answers per Slack user id, one array per page (cursor `p<n>`). */ byUser: Map<string, Array<ReturnType<typeof priv>[]>>;
  calls: Array<Parameters<MemberRead>[0]>; slackFails: "none" | "unreadable" | "throws" | "missing_scope";
  listOn: boolean; linksOn: boolean; installTeam: string | undefined;
}
function harness(options: { edition?: "enterprise" | "public" } = {}): Harness {
  const w = world({ edition: options.edition ?? "enterprise" });
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.ms });
  seedCompany(w.db, ORG_A, { [OWNER]: "owner", [MAINT]: "member", [MAINT2]: "member", [UNLINKED]: "member", [CONTRIB]: "member", [AUDITOR]: "auditor" }, [{ id: MAINT, project: "web" }, { id: MAINT2, project: "web" }, { id: UNLINKED, project: "web" }, { id: CONTRIB, project: "web" }], ["web", "api"]);
  seedCompany(w.db, ORG_B, { [OTHER_ORG_MAINT]: "member" }, [{ id: OTHER_ORG_MAINT, project: "web" }], ["web"]);
  return {
    w, audit, teams: new Map([[ORG_A, TEAM_A], [ORG_B, TEAM_B]]),
    linked: new Map([[MAINT, [U1]], [MAINT2, [U2]], [OWNER, [U1B]], [OTHER_ORG_MAINT, [U_OTHER_ORG]]]), linkedReads: [], linkedFails: false,
    byUser: new Map([[U1, [[priv(CH.a), priv(CH.b), priv(CH.connect, { extShared: true }), priv(CH.taken), priv(CH.mine)]]], [U2, [[priv(CH.of2)]]], [U1B, [[priv(CH.c)]]], [U_OTHER_ORG, [[priv(CH.a)]]]]),
    calls: [], slackFails: "none", listOn: true, linksOn: true, installTeam: TEAM_A,
  };
}

const dependencies = (h: Harness) => ({
  table: h.w.table, modes: h.w.deps.modes, now: () => h.w.clock.ms, limiter: dynamoRateLimiter(h.w.table, () => h.w.clock.ms),
  sources: {
    edition: h.w.deps.edition, projectRepositories: async () => undefined, pausedSources: async () => [] as string[], newId: () => randomUUID(),
    slackTeamBound: async (orgId: OrgId, teamId: string) => h.teams.get(orgId) === teamId,
    ...(h.linksOn ? { slackUserIdsOf: async (developerId: string) => { h.linkedReads.push(developerId); if (h.linkedFails) throw new Error("the sign-in store is down"); return h.linked.get(developerId) ?? []; } } : {}),
  },
});

function contextOf(h: Harness, who: Who, body: unknown, over: Partial<SourceWriteContext> = {}): SourceWriteContext {
  return {
    orgRole: who.orgRole, browserSession: true, body: () => body, audit: h.audit.deps,
    slackChannel: async () => ({ kind: "private" as const, extShared: false }),
    ...(h.installTeam === undefined ? {} : { slackTeamId: h.installTeam }),
    ...(h.listOn ? {
      slackMemberChannels: (async (input: Parameters<MemberRead>[0]) => {
        h.calls.push(input);
        if (h.slackFails === "throws") throw new Error("slack went away");
        if (h.slackFails === "unreadable") return { ok: false, error: "unavailable" };
        if (h.slackFails === "missing_scope") return { ok: false, error: "missing_scope" };
        const pages = h.byUser.get(input.userId) ?? [];
        const index = input.cursor === undefined ? 0 : Number(input.cursor.slice(1));
        return { ok: true, channels: pages[index] ?? [], ...(index + 1 < pages.length ? { next: `p${String(index + 1)}` } : {}) };
      }) satisfies MemberRead,
    } : {}),
    ...over,
  };
}

const PATH = (project: string) => `/v1/app/projects/${project}/record/sources`;
type Reply = { status: number; body: Record<string, unknown> };
async function options(h: Harness, who: Who, query: Record<string, string | undefined>, opts: { org?: OrgId; project?: string; context?: Partial<SourceWriteContext> } = {}): Promise<Reply> {
  return await handleRecordRoute(dependencies(h), {
    method: "GET", path: `${PATH(opts.project ?? "web")}/options`, query, caller: caller({ orgId: opts.org ?? ORG_A, developerId: who.id, projectRole: who.projectRole }), write: contextOf(h, who, undefined, opts.context),
  }) as Reply;
}
async function post(h: Harness, who: Who, body: unknown): Promise<Reply> {
  return await handleRecordRoute(dependencies(h), { method: "POST", path: PATH("web"), query: {}, caller: caller({ developerId: who.id, projectRole: who.projectRole }), write: contextOf(h, who, body) }) as Reply;
}
const optionList = (reply: Reply) => reply.body.options as Array<Record<string, unknown>>;
const scopesOf = (reply: Reply) => optionList(reply).map((option) => option.scope);
const PRIVATE = { kind: "slack-private" };
const FIXED_503 = { status: 503, body: { code: "RUNTIME_UNAVAILABLE", message: "The list can't be read right now." } };
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./u;

describe("your private channels: whose list it is", () => {
  it("is asked with the editor's own linked Slack id, from the server's store, for the company's bound team; names show only in this reply", async () => {
    const h = harness();
    const reply = await options(h, WHO.maint, PRIVATE);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ kind: "slack-private" });
    expect(h.linkedReads).toEqual([MAINT]);
    expect(h.calls).toEqual([{ teamId: TEAM_A, userId: U1 }]);
    expect(optionList(reply)).toEqual([
      { scope: slackScope(CH.a), name: `secret-${CH.a.toLowerCase()}`, joined: true, state: "available" },
      { scope: slackScope(CH.b), name: `secret-${CH.b.toLowerCase()}`, joined: true, state: "available" },
      { scope: slackScope(CH.connect), name: `secret-${CH.connect.toLowerCase()}`, joined: true, state: "slack_connect" },
      { scope: slackScope(CH.taken), name: `secret-${CH.taken.toLowerCase()}`, joined: true, state: "available" },
      { scope: slackScope(CH.mine), name: `secret-${CH.mine.toLowerCase()}`, joined: true, state: "available" },
    ]);
  });

  it("nothing in the request can choose another user: extra query fields, a user id in the cursor or in the kind are ignored or refused, and Slack is only ever asked about the editor's own ids", async () => {
    const h = harness();
    const reply = await options(h, WHO.maint, { ...PRIVATE, user: U2, userId: U2, slackUserId: U2, slack_user: U2 });
    expect(reply.status).toBe(200);
    expect(scopesOf(reply)).not.toContain(slackScope(CH.of2));
    expect(h.calls.map((call) => call.userId)).toEqual([U1]);
    for (const query of [{ kind: `slack-private:${U2}` }, { kind: "slack-private", cursor: `${U2}` }, { kind: "slack-private", cursor: `${randomUUID()}.1.${U2}` }]) {
      const refused = await options(h, WHO.maint, query);
      expect(refused.status, JSON.stringify(query)).toBeGreaterThanOrEqual(400);
    }
    expect(h.calls.map((call) => call.userId).filter((id) => id !== U1)).toEqual([]);
  });

  it("an editor never sees another editor's private list: each is asked about their own id only, and the other's channel is absent (positive control: each sees their own)", async () => {
    const h = harness();
    const first = await options(h, WHO.maint, PRIVATE);
    const second = await options(h, WHO.maint2, PRIVATE);
    expect(scopesOf(second)).toEqual([slackScope(CH.of2)]);
    expect(scopesOf(first)).toContain(slackScope(CH.a));
    expect(scopesOf(first)).not.toContain(slackScope(CH.of2));
    expect(scopesOf(second)).not.toContain(slackScope(CH.a));
    expect(h.calls.map((call) => call.userId)).toEqual([U1, U2]);
    expect(h.linkedReads).toEqual([MAINT, MAINT2]);
  });

  it("an editor with several linked Slack ids on the team: each is asked in turn, the results are merged, and a channel in both lists shows once per page", async () => {
    const h = harness();
    h.linked.set(MAINT, [U1, U2]);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const reply = await options(h, WHO.maint, { ...PRIVATE, ...(cursor === undefined ? {} : { cursor }) });
      expect(reply.status).toBe(200);
      seen.push(...scopesOf(reply).map(String));
      cursor = reply.body.next as string | undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(h.calls.map((call) => call.userId)).toEqual([U1, U2]);
    expect(seen).toEqual(expect.arrayContaining([slackScope(CH.a), slackScope(CH.of2)]));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("an editor with no linked Slack account gets notLinked and an empty list, and Slack is not asked (positive control: a linked editor is served)", async () => {
    const h = harness();
    const reply = await options(h, WHO.unlinked, PRIVATE);
    expect(reply).toEqual({ status: 200, body: { kind: "slack-private", options: [], notLinked: true } });
    expect(h.calls).toEqual([]);
    expect(h.linkedReads).toEqual([UNLINKED]);
    expect((await options(h, WHO.maint, PRIVATE)).status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("another company gets nothing: its editor's linked id is never asked about the install's workspace, and no name of the first company shows; the first company's list is real", async () => {
    const h = harness();
    const other = await options(h, WHO.otherMaint, PRIVATE, { org: ORG_B });
    expect(other).toEqual({ status: 200, body: { kind: "slack-private", options: [] } });
    expect(h.calls).toEqual([]);
    expect(JSON.stringify(other)).not.toContain("secret");
    // Positive control: company B's editor on a company that DID bind the install's workspace is served.
    h.teams.set(ORG_B, TEAM_A);
    const served = await options(h, WHO.otherMaint, PRIVATE, { org: ORG_B });
    expect(h.calls).toEqual([{ teamId: TEAM_A, userId: U_OTHER_ORG }]);
    expect(scopesOf(served)).toEqual([slackScope(CH.a)]);
  });

  it("claims of another company never mark a private channel as taken for this one", async () => {
    const h = harness();
    expect((await post(h, WHO.maint, { action: "add", requestId: randomUUID(), source: "slack", scope: slackScope(CH.taken), retention: "C", audienceDefault: "maintainers", enabled: true })).status).toBe(200);
    const same = await options(h, WHO.maint, PRIVATE);
    expect(optionList(same).find((option) => option.scope === slackScope(CH.taken))?.state).toBe("added");
    h.teams.set(ORG_B, TEAM_A);
    h.byUser.set(U_OTHER_ORG, [[priv(CH.taken)]]);
    const other = await options(h, WHO.otherMaint, PRIVATE, { org: ORG_B });
    expect(optionList(other).find((option) => option.scope === slackScope(CH.taken))?.state).toBe("available");
  });
});

describe("your private channels: who may ask", () => {
  it("only editors on a live browser session: a contributor, an auditor, a stranger and a token are refused, and neither the sign-in store nor Slack is asked", async () => {
    const h = harness();
    expect(await options(h, WHO.contributor, PRIVATE)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await options(h, WHO.auditor, PRIVATE)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await options(h, WHO.stranger, PRIVATE)).toMatchObject({ status: 404, body: { code: "PROJECT_NOT_FOUND" } });
    expect(await options(h, WHO.maint, PRIVATE, { context: { browserSession: false } })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await options(h, WHO.maint, PRIVATE, { context: { orgRole: "viewer" } })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(h.linkedReads).toEqual([]);
    expect(h.calls).toEqual([]);
    expect((await options(h, WHO.maint, PRIVATE)).status).toBe(200);
  });

  it("the same maintainers, admins and owners as the other pickers (an owner with a linked id is served)", async () => {
    const h = harness();
    const reply = await options(h, WHO.owner, PRIVATE);
    expect(scopesOf(reply)).toEqual([slackScope(CH.c)]);
    expect(h.calls).toEqual([{ teamId: TEAM_A, userId: U1B }]);
  });
});

describe("your private channels: Slack Connect, kinds, states", () => {
  it("Slack Connect channels are listed but marked not allowed (slack_connect); a public channel or a direct message the read sent anyway is dropped on the broker side", async () => {
    const h = harness();
    h.byUser.set(U1, [[priv(CH.a), priv(CH.connect, { extShared: true }), { ...priv(CH.pub), kind: "public" } as never, { ...priv("D0DIRECT01"), kind: "im" } as never]]);
    const reply = await options(h, WHO.maint, PRIVATE);
    expect(optionList(reply).map((option) => [option.scope, option.state])).toEqual([[slackScope(CH.a), "available"], [slackScope(CH.connect), "slack_connect"]]);
  });

  it("added and taken: a place that is a source of this project is added; another project's claim is taken without naming the project", async () => {
    const h = harness();
    const add = (project: string, scope: string) => handleRecordRoute(dependencies(h), { method: "POST", path: PATH(project), query: {}, caller: caller({ developerId: OWNER, projectRole: "maintainer" }), write: contextOf(h, WHO.owner, { action: "add", requestId: randomUUID(), source: "slack", scope, retention: "C", audienceDefault: "maintainers", enabled: true }) });
    expect(((await add("web", slackScope(CH.mine))) as Reply).status).toBe(200);
    expect(((await add("api", slackScope(CH.taken))) as Reply).status).toBe(200);
    const reply = await options(h, WHO.maint, PRIVATE);
    const state = (channel: string) => optionList(reply).find((option) => option.scope === slackScope(channel))?.state;
    expect([state(CH.mine), state(CH.taken), state(CH.a)]).toEqual(["added", "taken", "available"]);
    expect(JSON.stringify(reply.body)).not.toContain("api");
  });

  it("adding one from the list saves at once in Enterprise, audited as widening a private channel", async () => {
    const h = harness();
    const reply = await post(h, WHO.maint, { action: "add", requestId: randomUUID(), source: "slack", scope: slackScope(CH.a), retention: "C", audienceDefault: "maintainers", enabled: true });
    expect(reply.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.audit.recorded().find((event) => event.action === "record.source_added")?.facts).toMatchObject({ restricted: true, widened: "private_channel" });
  });
});

describe("your private channels: pages, the cap and the limits", () => {
  const many = (count: number) => Array.from({ length: 12 }, (_page, page) => Array.from({ length: count }, (_item, index) => priv(`C${String(page).padStart(2, "0")}${String(index).padStart(6, "0")}`)));

  it("pages with a cursor, at most 200 an answer, and the server stops at 10 pages and says the list was cut; Slack's own cursor is what Slack gets", async () => {
    const h = harness();
    h.byUser.set(U1, many(300));
    const seen: string[] = [];
    let cursor: string | undefined;
    let last: Reply | undefined;
    let pages = 0;
    do {
      const reply = await options(h, WHO.maint, { ...PRIVATE, ...(cursor === undefined ? {} : { cursor }) });
      expect(reply.status).toBe(200);
      expect(optionList(reply).length).toBeLessThanOrEqual(200);
      if (reply.body.next !== undefined) expect(reply.body.next as string).toMatch(SESSION);
      seen.push(...scopesOf(reply).map(String));
      cursor = reply.body.next as string | undefined;
      last = reply;
      pages += 1;
      h.w.clock.ms += 6_000;
    } while (cursor !== undefined && pages < 40);
    expect(pages).toBe(10);
    expect(last?.body.truncated).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect(h.calls).toHaveLength(10);
    expect(h.calls[1]).toEqual({ teamId: TEAM_A, userId: U1, cursor: "p1" });
  });

  it("the page cap is the server's: replaying one cursor never reads past 10 pages in all; a made-up session is refused and Slack is not asked", async () => {
    const h = harness();
    h.byUser.set(U1, many(10));
    const first = await options(h, WHO.maint, PRIVATE);
    const cursor = first.body.next as string;
    expect(cursor).toMatch(SESSION);
    let served = 1;
    for (let call = 0; call < 14; call += 1) {
      h.w.clock.ms += 6_000;
      const reply = await options(h, WHO.maint, { ...PRIVATE, cursor });
      if (reply.status === 200) served += 1; else expect(reply).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    }
    expect(served).toBe(10);
    const before = h.calls.length;
    expect(await options(h, WHO.maint, { ...PRIVATE, cursor: `${randomUUID()}.p1` })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(h.calls).toHaveLength(before);
  });

  it("a session belongs to one kind and one project: the public list and another project cannot use the private list's cursor", async () => {
    const h = harness();
    h.byUser.set(U1, many(10));
    const first = await options(h, WHO.maint, PRIVATE);
    const cursor = first.body.next as string;
    const before = h.calls.length;
    expect(await options(h, WHO.maint, { kind: "slack", cursor })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await options(h, WHO.maint, { ...PRIVATE, cursor }, { project: "api" })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(h.calls).toHaveLength(before);
    h.w.clock.ms += 6_000;
    expect((await options(h, WHO.maint, { ...PRIVATE, cursor })).status).toBe(200);
  });

  it("a private session belongs to the person who opened it: another editor's use of the cursor is refused, Slack is not asked and the owner's budget is not spent", async () => {
    const h = harness();
    h.byUser.set(U1, many(10));
    h.byUser.set(U2, many(10));
    const first = await options(h, WHO.maint, PRIVATE);
    const cursor = first.body.next as string;
    const before = h.calls.length;
    for (let call = 0; call < 12; call += 1) {
      h.w.clock.ms += 6_000;
      expect(await options(h, WHO.maint2, { ...PRIVATE, cursor }), String(call)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    }
    expect(h.calls).toHaveLength(before);
    // The owner still has every one of the 10 pages.
    let served = 1;
    for (let call = 0; call < 14; call += 1) { h.w.clock.ms += 6_000; if ((await options(h, WHO.maint, { ...PRIVATE, cursor })).status === 200) served += 1; }
    expect(served).toBe(10);
  });

  it("what the session keeps of the person is a salted hash, never the developer id", async () => {
    const h = harness();
    h.byUser.set(U1, many(10));
    await options(h, WHO.maint, PRIVATE);
    const [item] = h.w.db.find((entry) => entry.entityType === "TEAM_RECORD_SOURCE_OPTIONS");
    expect(item!.person).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(item)).not.toContain(MAINT);
  });

  it("a session holds no person, no Slack user id, no name: only ids of the session, the kind, the project and a count", async () => {
    const h = harness();
    h.byUser.set(U1, many(10));
    await options(h, WHO.maint, PRIVATE);
    const items = h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_OPTIONS");
    expect(items).toHaveLength(1);
    const text = JSON.stringify(items);
    for (const secret of [U1, MAINT, "secret", CH.a]) expect(text).not.toContain(secret);
    expect(items[0]).toMatchObject({ kind: "slack-private", project: "web", pages: 1 });
    expect(items[0]!.pk).toBe(teamRecordPk(ORG_A));
  });

  it("a failed read (Slack down, a throw, missing scope) does not use up a page", async () => {
    const h = harness();
    h.byUser.set(U1, many(10));
    const first = await options(h, WHO.maint, PRIVATE);
    const cursor = first.body.next as string;
    for (const how of ["unreadable", "throws", "missing_scope"] as const) {
      h.slackFails = how;
      h.w.clock.ms += 6_000;
      expect((await options(h, WHO.maint, { ...PRIVATE, cursor })).status, how).toBe(503);
    }
    h.slackFails = "none";
    let served = 1;
    for (let call = 0; call < 14; call += 1) { h.w.clock.ms += 6_000; if ((await options(h, WHO.maint, { ...PRIVATE, cursor })).status === 200) served += 1; }
    expect(served).toBe(10);
  });

  it("private page reads are rationed per company (12 a minute, every editor counts), separately from the public list, with a fixed 429; the minute gives it back", async () => {
    const h = harness();
    h.byUser.set(U1, many(10));
    h.byUser.set(U2, many(10));
    for (let call = 0; call < 12; call += 1) expect((await options(h, call % 2 === 0 ? WHO.maint : WHO.maint2, PRIVATE)).status, String(call)).toBe(200);
    expect(await options(h, WHO.maint, PRIVATE)).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
    expect(h.calls).toHaveLength(12);
    h.w.clock.ms += 61_000;
    expect((await options(h, WHO.maint, PRIVATE)).status).toBe(200);
  });

  it("one person may open 60 first pages a minute across all kinds (the bucket the other pickers use): past it the private list is refused (429) before anything is read; another person is not affected", async () => {
    const h = harness();
    const limiter = dynamoRateLimiter(h.w.table, () => h.w.clock.ms);
    for (let call = 0; call < 60; call += 1) expect(await limiter.take(`${ORG_A}|source-options|person:${MAINT}`, 60, 60)).toBe(true);
    expect(await options(h, WHO.maint, PRIVATE)).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
    expect(h.calls).toEqual([]);
    expect((await options(h, WHO.maint2, PRIVATE)).status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });
});

describe("your private channels: failures are fixed", () => {
  it("Slack down or a thrown read is the fixed 503; a bot without groups:read says so in one fixed sentence", async () => {
    for (const how of ["unreadable", "throws"] as const) {
      const h = harness();
      h.slackFails = how;
      expect(await options(h, WHO.maint, PRIVATE), how).toEqual(FIXED_503);
    }
    const scope = harness();
    scope.slackFails = "missing_scope";
    expect(await options(scope, WHO.maint, PRIVATE)).toEqual({ status: 503, body: { code: "SLACK_SCOPE_MISSING", message: "Rovara can't list channels. Ask an admin to reinstall the Slack app." } });
  });

  it("the sign-in store down or not wired, no listing wired, no team known: the fixed 503, and Slack is not asked", async () => {
    const down = harness();
    down.linkedFails = true;
    expect(await options(down, WHO.maint, PRIVATE)).toEqual(FIXED_503);
    const noLinks = harness();
    noLinks.linksOn = false;
    expect(await options(noLinks, WHO.maint, PRIVATE)).toEqual(FIXED_503);
    const noList = harness();
    noList.listOn = false;
    expect(await options(noList, WHO.maint, PRIVATE)).toEqual(FIXED_503);
    const noTeam = harness();
    noTeam.installTeam = undefined;
    expect(await options(noTeam, WHO.maint, PRIVATE)).toEqual(FIXED_503);
    expect([down, noLinks, noList, noTeam].flatMap((h) => h.calls)).toEqual([]);
  });

  it("names are capped and nothing but the fixed fields leaves", async () => {
    const h = harness();
    h.byUser.set(U1, [[priv(CH.a, { name: "x".repeat(500), secretField: "leak" })]]);
    const reply = await options(h, WHO.maint, PRIVATE);
    expect(optionList(reply)[0]).toEqual({ scope: slackScope(CH.a), name: "x".repeat(200), joined: true, state: "available" });
  });
});

describe("the broker's own request builds the private read from the identity function's answers", () => {
  const request = {} as never;
  const callerOf = { orgRole: "owner", browserSession: true } as never;
  const contextWith = (developer: Record<string, unknown>) => recordWriteContextOf({ developer } as never, callerOf, request);
  it("passes the install's team and the user the route chose, and maps the answers", async () => {
    const asked: unknown[] = [];
    const replies: unknown[] = [{ ok: true, channels: [priv(CH.a)], next: "abc=" }, { ok: false, error: "missing_scope" }, { ok: false, error: "slack_unavailable" }, { ok: false, error: "invalid_request" }];
    const ctx = contextWith({ slackTeamId: TEAM_A, memberChannels: async (input: unknown) => { asked.push(input); return replies.shift(); } });
    expect(await ctx.slackMemberChannels!({ teamId: TEAM_A, userId: U1, cursor: "abc=" })).toEqual({ ok: true, channels: [priv(CH.a)], next: "abc=" });
    expect(asked).toEqual([{ kind: "member-channels", teamId: TEAM_A, userId: U1, cursor: "abc=" }]);
    expect(await ctx.slackMemberChannels!({ teamId: TEAM_A, userId: U1 })).toEqual({ ok: false, error: "missing_scope" });
    expect(asked[1]).toEqual({ kind: "member-channels", teamId: TEAM_A, userId: U1 });
    expect(await ctx.slackMemberChannels!({ teamId: TEAM_A, userId: U1 })).toEqual({ ok: false, error: "unavailable" });
    expect(await ctx.slackMemberChannels!({ teamId: TEAM_A, userId: U1 })).toEqual({ ok: false, error: "unavailable" });
  });

  it("an install with no such read, or no Slack team, offers none (the private group is then unavailable)", () => {
    expect(contextWith({ slackTeamId: TEAM_A }).slackMemberChannels).toBeUndefined();
    expect(contextWith({ memberChannels: async () => ({ ok: true, channels: [] }) }).slackMemberChannels).toBeUndefined();
  });
});

describe("the runtime wires the editor's linked Slack ids from the sign-in store", () => {
  it("uses slackUserIdsOf of the runtime's inputs: the linked editor is served, an unlinked one is notLinked; the workspace binding still decides whose it is", async () => {
    const h = harness();
    const db = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
    seedCompany(db, ORG_A, { [OWNER]: "owner", [MAINT]: "member" }, [{ id: MAINT, project: "web" }], ["web"]);
    db.set({ ...slackTeamOrgKey(TEAM_A), orgId: ORG_A });
    const runtime = createTeamRecordRuntime({
      env: { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" }, documentClient: db, stateTableName: "State", now: () => h.w.clock.ms,
      slackUserIdsOf: async (developerId: string) => h.linked.get(developerId) ?? [],
    }) as TeamRecordRuntime;
    const read = (developerId: string) => runtime.routes({ method: "GET", path: `${PATH("web")}/options`, query: PRIVATE, caller: { orgId: ORG_A, developerId, projectRole: "maintainer" }, write: contextOf(h, WHO.maint, undefined) });
    expect(await read(MAINT)).toMatchObject({ status: 200, body: { kind: "slack-private", options: expect.arrayContaining([expect.objectContaining({ scope: slackScope(CH.a) })]) as unknown } });
    expect(await read(UNLINKED)).toEqual({ status: 200, body: { kind: "slack-private", options: [], notLinked: true } });
    expect(h.calls.map((call) => call.userId)).toEqual([U1]);
  });
});
