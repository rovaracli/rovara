// The pickers' reads (source-row lane, task 10): `GET /v1/app/projects/{p}/record/sources/options?kind=slack|linear|jira&cursor=`. An editor on a live browser session is offered the Slack channels of the
// company's bound workspace, the Linear teams of the company's connected app and the Jira projects of its connections, each marked as available, already a source of this project, claimed by another project
// (without saying which) or not allowed (Slack Connect). Everything comes from the caller's session org; another company gets nothing. Same harness as `source-routes-slack-tickets.test.ts` (copied: not exported).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, slackTeamOrgKey } from "@agentx/cloud-contracts";
import { projectMemberKey, projectMetaKey, type OrgId } from "@rovara-code/contracts";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { eraseWorkspace } from "../../../packages/broker/src/team-record/erase.js";
import { teamRecordPk } from "@rovara-code/contracts";
import { putScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { dynamoRateLimiter } from "../../../packages/broker/src/team-record/query.js";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import type { SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import { linearScope, trackerPlaceCheck, trackerPlaceOptions, type SlackFacts } from "../../../packages/broker/src/team-record/source-places.js";
import { jiraPlaceNamesReader, jiraPlacesReader, linearPlaceNamesReader, linearPlacesReader, type ConnectedTracker, type ConnectedTrackersPort } from "../../../packages/broker/src/team-record/tracker-directory.js";
import { recordWriteContextOf } from "../../../packages/broker/src/aws/developer-routes/team-record-source-write.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B, caller, world, type World } from "../../support/team-record-core.js";

const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MAINT = "c".repeat(64), CONTRIB = "d".repeat(64), AUDITOR = "e".repeat(64), OTHER_ORG_MAINT = "1".repeat(64), OTHER_ORG_OWNER = "2".repeat(64);
type OrgRole = "owner" | "admin" | "member" | "auditor";
interface Who { id: string; orgRole: OrgRole; projectRole: "maintainer" | "contributor" | "viewer" | undefined }
const WHO = {
  owner: { id: OWNER, orgRole: "owner", projectRole: "maintainer" },
  admin: { id: ADMIN, orgRole: "admin", projectRole: "maintainer" },
  maint: { id: MAINT, orgRole: "member", projectRole: "maintainer" },
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
const CH = { pub: "C0PUBLIC1", priv: "C0PRIVATE", dm: "D0DIRECT01", mpim: "G0GROUPDM", connect: "C0CONNECT1", taken: "C0TAKEN001", mine: "C0MINE0001" } as const;
const FACTS: Record<string, SlackFacts> = {
  [CH.pub]: { kind: "public", extShared: false }, [CH.priv]: { kind: "private", extShared: false }, [CH.dm]: { kind: "im", extShared: false }, [CH.mpim]: { kind: "mpim", extShared: false },
  [CH.connect]: { kind: "public", extShared: true }, [CH.taken]: { kind: "public", extShared: false }, [CH.mine]: { kind: "public", extShared: false },
};
const entry = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `name-${id.toLowerCase()}`, kind: FACTS[id]?.kind === "private" ? "private" as const : "public" as const, extShared: FACTS[id]?.extShared ?? false, joined: true, ...over });
const LINEAR_A = "11111111-aaaa-4aaa-8aaa-111111111111", LINEAR_A2 = "22222222-aaaa-4aaa-8aaa-222222222222", LINEAR_B = "33333333-bbbb-4bbb-8bbb-333333333333";

type SlackEntry = ReturnType<typeof entry>;
type SlackList = NonNullable<SourceWriteContext["slackChannels"]>;
interface App { kind: "linear" | "jira"; places: Array<{ scope: string; name: string }>; pageSize?: number; reads: number; fails?: boolean; noNames?: boolean }
interface Harness {
  w: World; audit: ReturnType<typeof capturingAuditDeps>; ids: { next: number };
  /** Which Slack team each company bound. */ teams: Map<OrgId, string>;
  /** Slack pages, answered in order by cursor `p<n>`; `calls` records what was asked. */ pages: SlackEntry[][]; calls: Array<Parameters<SlackList>[0]>; slackFails: "none" | "unreadable" | "throws" | "missing_scope";
  apps: Map<OrgId, App[]>; trackersOn: boolean; listOn: boolean; installTeam: string | undefined;
}
function harness(options: { edition?: "enterprise" | "public" } = {}): Harness {
  const w = world({ edition: options.edition ?? "enterprise" });
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.ms });
  seedCompany(w.db, ORG_A, { [OWNER]: "owner", [ADMIN]: "admin", [MAINT]: "member", [CONTRIB]: "member", [AUDITOR]: "auditor" }, [{ id: MAINT, project: "web" }, { id: CONTRIB, project: "web" }], ["web", "api"]);
  seedCompany(w.db, ORG_B, { [OTHER_ORG_OWNER]: "owner", [OTHER_ORG_MAINT]: "member" }, [{ id: OTHER_ORG_MAINT, project: "web" }], ["web"]);
  return {
    w, audit, ids: { next: 1 }, teams: new Map([[ORG_A, TEAM_A], [ORG_B, TEAM_B]]), pages: [[entry(CH.pub), entry(CH.priv), entry(CH.connect), entry(CH.taken), entry(CH.mine)]], calls: [], slackFails: "none",
    apps: new Map<OrgId, App[]>([
      [ORG_A, [{ kind: "linear", places: [{ scope: linearScope(LINEAR_A), name: "Platform (PLT)" }, { scope: linearScope(LINEAR_A2), name: "Web (WEB)" }], reads: 0 }, { kind: "jira", places: [{ scope: "jira:project/ENG", name: "Engineering (ENG)" }, { scope: "jira:project/OPS", name: "Operations (OPS)" }], reads: 0 }]],
      [ORG_B, [{ kind: "linear", places: [{ scope: linearScope(LINEAR_B), name: "Other company team (OTH)" }], reads: 0 }]],
    ]),
    trackersOn: true, listOn: true, installTeam: TEAM_A,
  };
}

function trackersOf(h: Harness): ConnectedTrackersPort {
  const tracker = (app: App, index: number): ConnectedTracker => ({
    connectionId: `con_${String(index).padStart(20, "a")}`, system: app.kind === "jira" ? "jira:acme.atlassian.net" : "linear", kind: app.kind,
    async readUsers() { return { users: [] }; },
    async readPlaces({ after, limit }) {
      const start = after === undefined ? 0 : Number(after), size = Math.min(limit, app.pageSize ?? 100);
      return { scopes: app.places.slice(start, start + size).map((place) => place.scope), ...(start + size < app.places.length ? { next: String(start + size) } : {}) };
    },
    ...(app.noNames === true ? {} : {
      async readPlaceNames({ after, limit }) {
        app.reads += 1;
        if (app.fails === true) throw new Error("the tool is down");
        const start = after === undefined ? 0 : Number(after), size = Math.min(limit, app.pageSize ?? 100);
        return { places: app.places.slice(start, start + size), ...(start + size < app.places.length ? { next: String(start + size) } : {}) };
      },
    }),
  });
  return { list: async (orgId) => (h.apps.get(orgId) ?? []).map(tracker), get: async () => undefined };
}

const dependencies = (h: Harness) => ({
  table: h.w.table, modes: h.w.deps.modes, now: () => h.w.clock.ms, limiter: dynamoRateLimiter(h.w.table, () => h.w.clock.ms),
  sources: {
    edition: h.w.deps.edition,
    projectRepositories: async () => undefined,
    pausedSources: async () => [] as string[],
    newId: () => `change-${String(h.ids.next++)}`,
    slackTeamBound: async (orgId: OrgId, teamId: string) => h.teams.get(orgId) === teamId,
    ...(h.trackersOn ? { trackerPlace: trackerPlaceCheck(trackersOf(h), { now: () => h.w.clock.ms }), trackerOptions: trackerPlaceOptions(trackersOf(h)) } : {}),
  },
});

function contextOf(h: Harness, who: Who, body: unknown, over: Partial<SourceWriteContext> = {}): SourceWriteContext {
  return {
    orgRole: who.orgRole, browserSession: true, body: () => body, audit: h.audit.deps,
    slackChannel: async (_team: string, channelId: string) => FACTS[channelId],
    ...(h.installTeam === undefined ? {} : { slackTeamId: h.installTeam }),
    ...(h.listOn ? {
      slackChannels: (async (input: Parameters<SlackList>[0]) => {
        h.calls.push(input);
        if (h.slackFails === "throws") throw new Error("slack went away");
        if (h.slackFails === "unreadable") return { ok: false, error: "unavailable" };
        if (h.slackFails === "missing_scope") return { ok: false, error: "missing_scope" };
        const index = input.cursor === undefined ? 0 : Number(input.cursor.slice(1));
        return { ok: true, channels: h.pages[index] ?? [], ...(index + 1 < h.pages.length ? { next: `p${String(index + 1)}` } : {}) };
      }) satisfies SlackList,
    } : {}),
    ...over,
  };
}

const PATH = (project: string) => `/v1/app/projects/${project}/record/sources`;
type Reply = { status: number; body: Record<string, unknown> };
async function options(h: Harness, who: Who, query: Record<string, string | undefined>, opts: { org?: OrgId; project?: string; context?: Partial<SourceWriteContext> } = {}): Promise<Reply> {
  return await handleRecordRoute(dependencies(h), {
    method: "GET", path: `${PATH(opts.project ?? "web")}/options`, query, caller: caller({ orgId: opts.org ?? ORG_A, developerId: who.id, projectRole: who.projectRole }),
    write: contextOf(h, who, undefined, opts.context),
  }) as Reply;
}
async function post(h: Harness, who: Who, body: unknown, opts: { org?: OrgId; project?: string } = {}): Promise<Reply> {
  return await handleRecordRoute(dependencies(h), {
    method: "POST", path: PATH(opts.project ?? "web"), query: {}, caller: caller({ orgId: opts.org ?? ORG_A, developerId: who.id, projectRole: who.projectRole }), write: contextOf(h, who, body),
  }) as Reply;
}
const slackScope = (channel: string, team = TEAM_A) => `slack:${team}/${channel}`;
const add = (over: Record<string, unknown> = {}) => ({ action: "add", requestId: randomUUID(), source: "slack", scope: slackScope(CH.pub), retention: "C", audienceDefault: "maintainers", enabled: true, ...over });
const optionList = (reply: Reply) => reply.body.options as Array<Record<string, unknown>>;
const stateOf = (reply: Reply, scope: string) => optionList(reply).find((option) => option.scope === scope)?.state;
const FIXED_503 = { status: 503, body: { code: "RUNTIME_UNAVAILABLE", message: "The list can't be read right now." } };

describe("Slack: the channels of the company's bound workspace", () => {
  it("lists id, name and kind as options of this project, available unless said otherwise", async () => {
    const h = harness();
    const reply = await options(h, WHO.maint, { kind: "slack" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ kind: "slack" });
    expect(optionList(reply)).toEqual([
      { scope: slackScope(CH.pub), name: "name-c0public1", joined: true, state: "available" },
      { scope: slackScope(CH.connect), name: "name-c0connect1", joined: true, state: "slack_connect" },
      { scope: slackScope(CH.taken), name: "name-c0taken001", joined: true, state: "available" },
      { scope: slackScope(CH.mine), name: "name-c0mine0001", joined: true, state: "available" },
    ]);
    // Slack is asked only for the company's own bound team, and the strict reply schema holds.
    expect(h.calls).toEqual([{ teamId: TEAM_A }]);
  });

  it("owners, admins and maintainers may list; each state is right: already a source of this project, claimed by another project (it is not named), Slack Connect not allowed", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ scope: slackScope(CH.mine) }))).status).toBe(200);
    expect((await post(h, WHO.owner, add({ scope: slackScope(CH.taken) }), { project: "api" })).status).toBe(200);
    for (const who of [WHO.owner, WHO.admin, WHO.maint]) {
      const reply = await options(h, who, { kind: "slack" });
      expect(reply.status).toBe(200);
      expect(stateOf(reply, slackScope(CH.mine))).toBe("added");
      expect(stateOf(reply, slackScope(CH.taken))).toBe("taken");
      expect(stateOf(reply, slackScope(CH.connect))).toBe("slack_connect");
      expect(stateOf(reply, slackScope(CH.pub))).toBe("available");
      // The other project's name never appears, nor anything beyond the fixed fields.
      expect(JSON.stringify(reply.body)).not.toContain("api");
      for (const option of optionList(reply)) expect(Object.keys(option).sort()).toEqual(["joined", "name", "scope", "state"]);
    }
    // From the other project, "mine" is claimed elsewhere and "taken" is its own.
    const fromApi = await options(h, WHO.owner, { kind: "slack" }, { project: "api" });
    expect(stateOf(fromApi, slackScope(CH.taken))).toBe("added");
    expect(stateOf(fromApi, slackScope(CH.mine))).toBe("taken");
  });

  it("an unjoined public channel stays listed and pickable (state available) with joined: false, so the screen can tell the editor to invite Rovara; a missing flag is not a claim to be joined", async () => {
    const h = harness();
    h.pages = [[entry(CH.pub, { joined: false }), entry(CH.priv)]];
    const reply = await options(h, WHO.maint, { kind: "slack" });
    expect(optionList(reply)).toEqual([
      { scope: slackScope(CH.pub), name: "name-c0public1", joined: false, state: "available" },
    ]);
    const missing = harness();
    missing.pages = [[{ id: CH.pub, name: "bare", kind: "public", extShared: false } as never]];
    expect(optionList(await options(missing, WHO.maint, { kind: "slack" }))[0]).not.toHaveProperty("joined", true);
  });

  it("direct messages and group messages are never asked for or listed, in either edition (the bot sees only its own), even if the read sent them", async () => {
    for (const edition of ["enterprise", "public"] as const) {
      const h = harness({ edition });
      h.pages = [[entry(CH.pub), { id: CH.dm, name: "U0PERSON1", kind: "im", extShared: false, joined: true } as never, { id: CH.mpim, name: "mpdm-a--b-1", kind: "mpim", extShared: false, joined: true } as never, entry(CH.priv)]];
      const shown = await options(h, WHO.maint, { kind: "slack" });
      expect(h.calls[0], edition).toEqual({ teamId: TEAM_A });
      expect(optionList(shown).map((option) => option.scope), edition).toEqual([slackScope(CH.pub)]);
    }
  });

  const manyPages = (h: Harness, count = 12) => { h.pages = Array.from({ length: count }, (_, page) => Array.from({ length: 250 }, (_, index) => entry(`C${String(page)}${String(index).padStart(7, "0")}`))); };
  const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./u;
  const sessions = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_OPTIONS");

  it("pages with a cursor, at most 200 an answer, and the server stops at 10 pages and says the list was cut", async () => {
    const h = harness();
    manyPages(h);
    const seen: string[] = [];
    let cursor: string | undefined;
    let last: Reply | undefined;
    let pages = 0;
    do {
      const reply = await options(h, WHO.maint, { kind: "slack", ...(cursor === undefined ? {} : { cursor }) });
      expect(reply.status).toBe(200);
      expect(optionList(reply).length).toBeLessThanOrEqual(200);
      if (reply.body.next !== undefined) expect(reply.body.next as string).toMatch(SESSION);
      seen.push(...optionList(reply).map((option) => String(option.scope)));
      cursor = reply.body.next as string | undefined;
      last = reply;
      pages += 1;
    } while (cursor !== undefined && pages < 40);
    expect(pages).toBe(10);
    expect(last?.body.truncated).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect(h.calls).toHaveLength(10);
    // The cursor Slack gets is Slack's own, not the session the broker wraps around it.
    expect(h.calls[1]!.cursor).toBe("p1");
  });

  it("a list that ends by itself is not marked cut", async () => {
    const h = harness();
    manyPages(h, 3);
    let cursor: string | undefined;
    let last: Reply | undefined;
    do { last = await options(h, WHO.maint, { kind: "slack", ...(cursor === undefined ? {} : { cursor }) }); cursor = last.body.next as string | undefined; } while (cursor !== undefined);
    expect(last.body).not.toHaveProperty("truncated");
    expect(h.calls).toHaveLength(3);
  });

  it("the page cap is the server's: replaying one cursor never reads past 10 pages in all, a made-up session is refused, and Slack is not asked", async () => {
    const h = harness();
    manyPages(h);
    const first = await options(h, WHO.maint, { kind: "slack" });
    const cursor = first.body.next as string;
    let refused = 0;
    for (let again = 0; again < 15; again += 1) {
      const reply = await options(h, WHO.maint, { kind: "slack", cursor });
      if (reply.status === 400) { refused += 1; expect(reply.body).toMatchObject({ code: "CONFIG_INVALID" }); } else expect(reply.status).toBe(200);
    }
    expect(h.calls).toHaveLength(10); // the first page and nine more, never more
    expect(refused).toBe(6);
    const before = h.calls.length;
    const forged = await options(h, WHO.maint, { kind: "slack", cursor: `${randomUUID()}.p1` });
    expect(forged).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    // A number in place of a session (the old shape) is not a cursor.
    expect(await options(h, WHO.maint, { kind: "slack", cursor: "0.p1" })).toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(before);
  });

  it("a session belongs to one project, one kind and one company: another project, another kind and another company cannot use the cursor", async () => {
    const h = harness();
    manyPages(h, 3);
    const cursor = (await options(h, WHO.owner, { kind: "slack" })).body.next as string;
    const before = h.calls.length;
    expect(await options(h, WHO.owner, { kind: "slack", cursor }, { project: "api" })).toMatchObject({ status: 400 });
    expect(await options(h, WHO.owner, { kind: "jira", cursor })).toMatchObject({ status: 400 });
    h.teams.set(ORG_B, TEAM_A);
    expect(await options(h, WHO.otherMaint, { kind: "slack", cursor }, { org: ORG_B })).toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(before);
    // Positive control: the same project, kind and company may go on.
    expect((await options(h, WHO.owner, { kind: "slack", cursor })).status).toBe(200);
  });

  it("a session expires: after its time the cursor is refused", async () => {
    const h = harness();
    manyPages(h, 3);
    const cursor = (await options(h, WHO.maint, { kind: "slack" })).body.next as string;
    h.w.clock.ms += 16 * 60 * 1000;
    expect(await options(h, WHO.maint, { kind: "slack", cursor })).toMatchObject({ status: 400 });
  });

  it("a session holds no person, no name and no Slack text: ids of the session, the kind, the project and a count", async () => {
    const h = harness();
    manyPages(h, 3);
    await options(h, WHO.maint, { kind: "slack" });
    const rows = sessions(h);
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(MAINT);
    expect(text).not.toContain("name-c0");
    expect(rows[0]).toMatchObject({ kind: "slack", project: "web", pages: 1 });
  });

  it("closing the company removes its listing sessions (they are in the company's own partition, like every other item of it)", async () => {
    const h = harness();
    manyPages(h, 3);
    await options(h, WHO.maint, { kind: "slack" });
    expect(sessions(h)).toHaveLength(1);
    const done = await eraseWorkspace(deleteDeps(h.w).deps, ORG_A, ["web", "api"], "close-1");
    expect(done.complete).toBe(true);
    expect(sessions(h)).toHaveLength(0);
    expect(h.w.db.find((item) => String(item.pk) === teamRecordPk(ORG_A) && !String(item.sk).startsWith("LAKEDEL#"))).toEqual([]);
  });

  it("a page is counted only after it was read: a failed read (Slack down, a throw) does not use up one of the 10", async () => {
    const h = harness();
    manyPages(h, 12);
    const cursor = (await options(h, WHO.maint, { kind: "slack" })).body.next as string;
    for (const how of ["unreadable", "throws", "missing_scope"] as const) {
      h.slackFails = how;
      for (let again = 0; again < 2; again += 1) expect((await options(h, WHO.maint, { kind: "slack", cursor })).status, how).toBe(503);
    }
    h.slackFails = "none";
    h.w.clock.ms += 61_000; // the company's minute (12 Slack reads) is not what is being tested
    let ok = 0;
    for (let again = 0; again < 12; again += 1) if ((await options(h, WHO.maint, { kind: "slack", cursor })).status === 200) ok += 1;
    expect(ok).toBe(9); // the first page was one; six failures took nothing
    expect(sessions(h)[0]).toMatchObject({ pages: 10 });
  });

  it("a page the company's Slack budget refused is not counted either", async () => {
    const h = harness();
    manyPages(h, 40);
    const cursor = (await options(h, WHO.maint, { kind: "slack" })).body.next as string;
    for (let call = 0; call < 11; call += 1) expect((await options(h, WHO.maint, { kind: "slack" })).status).toBe(200); // the minute's 12 are used
    for (let again = 0; again < 3; again += 1) expect((await options(h, WHO.maint, { kind: "slack", cursor })).status).toBe(429);
    h.w.clock.ms += 61_000;
    expect((await options(h, WHO.maint, { kind: "slack", cursor })).status).toBe(200);
    expect(sessions(h).find((item) => item.pages !== 1)).toMatchObject({ pages: 2 });
  });

  it("Slack page reads are rationed per company (12 a minute, shared by every editor), with a fixed 429, and the budget comes back with the next minute", async () => {
    const h = harness();
    manyPages(h, 40);
    const run = async (who: Who) => (await options(h, who, { kind: "slack" })).status;
    for (let call = 0; call < 12; call += 1) expect(await run(call % 2 === 0 ? WHO.maint : WHO.owner), String(call)).toBe(200);
    const denied = await options(h, WHO.admin, { kind: "slack" });
    expect(denied).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
    expect(h.calls).toHaveLength(12);
    // Another company has its own budget.
    h.teams.set(ORG_B, TEAM_A);
    expect((await options(h, WHO.otherMaint, { kind: "slack" }, { org: ORG_B })).status).toBe(200);
    h.w.clock.ms += 61_000;
    expect(await run(WHO.maint)).toBe(200);
  });

  it("a cursor that is not one of ours is refused, and so is a kind that has no picker; Slack is not asked", async () => {
    const h = harness();
    for (const query of [{ kind: "slack", cursor: "nope" }, { kind: "slack", cursor: "99.p1" }, { kind: "slack", cursor: `${randomUUID()}.${"x".repeat(400)}` }, { kind: "slack", cursor: `${randomUUID()}.a b` }, { kind: "mcp" }, { kind: "github" }, { kind: "" }, {}]) {
      expect(await options(h, WHO.maint, query), JSON.stringify(query)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    }
    expect(h.calls).toEqual([]);
  });

  it("another company gets nothing: its workspace is not the install's, Slack is not asked, and nothing of the first company shows; the first company's list is real", async () => {
    const h = harness();
    expect((await options(h, WHO.maint, { kind: "slack" })).status).toBe(200);
    expect(h.calls).toHaveLength(1);
    const other = await options(h, WHO.otherMaint, { kind: "slack" }, { org: ORG_B });
    expect(other).toEqual({ status: 200, body: { kind: "slack", options: [] } });
    expect(h.calls).toHaveLength(1);
    // A company that never bound a workspace gets nothing either.
    h.teams.delete(ORG_B);
    expect(await options(h, WHO.otherMaint, { kind: "slack" }, { org: ORG_B })).toEqual({ status: 200, body: { kind: "slack", options: [] } });
    expect(h.calls).toHaveLength(1);
  });

  it("claims of another company never mark a channel: company B's claim on a place does not show as taken for company A", async () => {
    const h = harness();
    h.teams.set(ORG_B, TEAM_A); // both companies on one workspace is not possible in production; the claim lookups must still be per company
    expect((await post(h, WHO.otherMaint, add({ scope: slackScope(CH.pub) }), { org: ORG_B })).status).toBe(200);
    expect(stateOf(await options(h, WHO.maint, { kind: "slack" }), slackScope(CH.pub))).toBe("available");
  });

  it("only editors on a live browser session: a contributor, an auditor, a stranger and a token are refused, and Slack is not asked", async () => {
    const h = harness();
    expect(await options(h, WHO.contributor, { kind: "slack" })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await options(h, WHO.auditor, { kind: "slack" })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await options(h, WHO.stranger, { kind: "slack" })).toMatchObject({ status: 404, body: { code: "PROJECT_NOT_FOUND" } });
    expect(await options(h, WHO.maint, { kind: "slack" }, { context: { browserSession: false } })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await options(h, WHO.maint, { kind: "slack" }, { context: { orgRole: "viewer" } })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(h.calls).toEqual([]);
    // Positive control: the same maintainer on a browser session is served.
    expect((await options(h, WHO.maint, { kind: "slack" })).status).toBe(200);
  });

  it("a write method on the options path is refused", async () => {
    const h = harness();
    const reply = await handleRecordRoute(dependencies(h), { method: "POST", path: `${PATH("web")}/options`, query: { kind: "slack" }, caller: caller({ developerId: MAINT, projectRole: "maintainer" }), write: contextOf(h, WHO.maint, add()) });
    expect(reply).toMatchObject({ status: 405 });
  });

  it("unreadable is a fixed 503: Slack down, a thrown read, no listing wired, no team known", async () => {
    for (const how of ["unreadable", "throws"] as const) {
      const h = harness();
      h.slackFails = how;
      expect(await options(h, WHO.maint, { kind: "slack" }), how).toEqual(FIXED_503);
    }
    const none = harness();
    none.listOn = false;
    expect(await options(none, WHO.maint, { kind: "slack" })).toEqual(FIXED_503);
    const noTeam = harness();
    noTeam.installTeam = undefined;
    expect(await options(noTeam, WHO.maint, { kind: "slack" })).toEqual(FIXED_503);
    expect(noTeam.calls).toEqual([]);
  });

  it("a bot without the listing scopes says so in one fixed sentence", async () => {
    const h = harness();
    h.slackFails = "missing_scope";
    expect(await options(h, WHO.maint, { kind: "slack" })).toEqual({ status: 503, body: { code: "SLACK_SCOPE_MISSING", message: "Rovara can't list channels. Ask an admin to reinstall the Slack app." } });
  });

  it("names are capped and nothing but the fixed fields leaves: a long or odd name is cut, and Slack's own fields never pass through", async () => {
    const h = harness();
    h.pages = [[{ ...entry(CH.pub, { name: "x".repeat(500) }), topic: "secret topic", creator: "U123" } as SlackEntry]];
    const reply = await options(h, WHO.maint, { kind: "slack" });
    expect(String(optionList(reply)[0]!.name).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(reply.body)).not.toContain("secret topic");
  });
});

describe("Linear teams and Jira projects of the company's connected apps", () => {
  it("lists the places with their names as options of this project", async () => {
    const h = harness();
    expect(await options(h, WHO.maint, { kind: "linear" })).toEqual({
      status: 200,
      body: { kind: "linear", options: [{ scope: linearScope(LINEAR_A), name: "Platform (PLT)", state: "available" }, { scope: linearScope(LINEAR_A2), name: "Web (WEB)", state: "available" }] },
    });
    expect(await options(h, WHO.maint, { kind: "jira" })).toEqual({
      status: 200,
      body: { kind: "jira", options: [{ scope: "jira:project/ENG", name: "Engineering (ENG)", state: "available" }, { scope: "jira:project/OPS", name: "Operations (OPS)", state: "available" }] },
    });
    expect(h.calls).toEqual([]); // Slack is not involved.
  });

  it("marks what this project already has and what another project holds (not named)", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ source: "linear", scope: linearScope(LINEAR_A) }))).status).toBe(200);
    expect((await post(h, WHO.owner, add({ source: "jira", scope: "jira:project/ENG" }), { project: "api" })).status).toBe(200);
    const linear = await options(h, WHO.maint, { kind: "linear" });
    expect(stateOf(linear, linearScope(LINEAR_A))).toBe("added");
    expect(stateOf(linear, linearScope(LINEAR_A2))).toBe("available");
    const jira = await options(h, WHO.maint, { kind: "jira" });
    expect(stateOf(jira, "jira:project/ENG")).toBe("taken");
    expect(stateOf(jira, "jira:project/OPS")).toBe("available");
    expect(JSON.stringify(jira.body)).not.toContain("api");
    for (const option of optionList(jira)) expect(Object.keys(option).sort()).toEqual(["name", "scope", "state"]);
  });

  it("another company gets only its own apps' places, and nothing of the first company's shows; a company with no app of the kind gets an empty list", async () => {
    const h = harness();
    const mine = await options(h, WHO.maint, { kind: "linear" });
    const theirs = await options(h, WHO.otherMaint, { kind: "linear" }, { org: ORG_B });
    expect(optionList(theirs)).toEqual([{ scope: linearScope(LINEAR_B), name: "Other company team (OTH)", state: "available" }]);
    expect(JSON.stringify(theirs.body)).not.toContain(LINEAR_A);
    expect(JSON.stringify(mine.body)).not.toContain(LINEAR_B);
    expect(await options(h, WHO.otherMaint, { kind: "jira" }, { org: ORG_B })).toEqual({ status: 200, body: { kind: "jira", options: [] } });
  });

  it("pages by cursor, 100 at a time, and stops at the total bound", async () => {
    const h = harness();
    const places = Array.from({ length: 1500 }, (_, index) => ({ scope: `jira:project/K${String(index).padStart(4, "0")}`, name: `Project ${String(index)}` }));
    h.apps.set(ORG_A, [{ kind: "jira", places, reads: 0 }]);
    const seen: string[] = [];
    let cursor: string | undefined;
    let last: Reply | undefined;
    let pages = 0;
    do {
      const reply = await options(h, WHO.maint, { kind: "jira", ...(cursor === undefined ? {} : { cursor }) });
      expect(reply.status).toBe(200);
      expect(optionList(reply).length).toBeLessThanOrEqual(100);
      seen.push(...optionList(reply).map((option) => String(option.scope)));
      cursor = reply.body.next as string | undefined;
      last = reply;
      pages += 1;
    } while (cursor !== undefined && pages < 40);
    expect(pages).toBe(10);
    expect(last?.body.truncated).toBe(true);
    expect(seen).toHaveLength(1000);
    expect(new Set(seen).size).toBe(1000);
  });

  it("goes on to the next connection when one is read to its end (the screen shows a place that two connections both list once)", async () => {
    const h = harness();
    h.apps.set(ORG_A, [
      { kind: "jira", places: [{ scope: "jira:project/ENG", name: "Engineering (ENG)" }], reads: 0 },
      { kind: "jira", places: [{ scope: "jira:project/ENG", name: "Engineering again" }, { scope: "jira:project/OPS", name: "Operations (OPS)" }], pageSize: 1, reads: 0 },
    ]);
    const scopes: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const reply = await options(h, WHO.maint, { kind: "jira", ...(cursor === undefined ? {} : { cursor }) });
      scopes.push(...optionList(reply).map((option) => String(option.scope)));
      cursor = reply.body.next as string | undefined;
      guard += 1;
    } while (cursor !== undefined && guard < 20);
    expect([...new Set(scopes)].sort()).toEqual(["jira:project/ENG", "jira:project/OPS"]);
  });

  it("unreadable is a fixed 503: a failing app, an app that cannot list names, an install with no connections; a cursor of another shape is refused", async () => {
    const down = harness();
    down.apps.get(ORG_A)![0]!.fails = true;
    expect(await options(down, WHO.maint, { kind: "linear" })).toEqual(FIXED_503);
    const mute = harness();
    mute.apps.get(ORG_A)![1]!.noNames = true;
    expect(await options(mute, WHO.maint, { kind: "jira" })).toEqual(FIXED_503);
    const off = harness();
    off.trackersOn = false;
    expect(await options(off, WHO.maint, { kind: "linear" })).toEqual(FIXED_503);
    const h = harness();
    h.apps.set(ORG_A, [{ kind: "jira", places: [{ scope: "jira:project/ENG", name: "Engineering (ENG)" }, { scope: "jira:project/OPS", name: "Operations (OPS)" }], pageSize: 1, reads: 0 }]);
    const session = String((await options(h, WHO.maint, { kind: "jira" })).body.next).split(".")[0]!;
    // A connection number past the company's last connection is an empty page, not a failure.
    expect(await options(h, WHO.maint, { kind: "jira", cursor: `${session}.7.abc` })).toEqual({ status: 200, body: { kind: "jira", options: [] } });
    expect(await options(h, WHO.maint, { kind: "jira", cursor: "garbage" })).toMatchObject({ status: 400 });
  });

  it("only editors on a live browser session, as for Slack; the apps are not read for anyone else", async () => {
    const h = harness();
    const app = h.apps.get(ORG_A)![0]!;
    expect(await options(h, WHO.contributor, { kind: "linear" })).toMatchObject({ status: 403 });
    expect(await options(h, WHO.maint, { kind: "linear" }, { context: { browserSession: false } })).toMatchObject({ status: 403 });
    expect(await options(h, WHO.stranger, { kind: "linear" })).toMatchObject({ status: 404 });
    expect(app.reads).toBe(0);
    expect((await options(h, WHO.maint, { kind: "linear" })).status).toBe(200);
    expect(app.reads).toBe(1);
  });
});

describe("final fix 2: every tracker page is rationed, and a bad cursor costs nothing", () => {
  const manyPlaces = (h: Harness, kind: "linear" | "jira" = "jira") => {
    const places = Array.from({ length: 5000 }, (_, index) => ({ scope: kind === "jira" ? `jira:project/K${String(index).padStart(4, "0")}` : linearScope(`${"1".repeat(8)}-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`), name: `P${String(index)}` }));
    h.apps.set(ORG_A, [{ kind, places, reads: 0, pageSize: 1 }]);
    return h.apps.get(ORG_A)![0]!;
  };
  it("Linear and Jira pages are rationed per company (30 a minute, every editor and every page counts), with a fixed 429; the tool is not asked past it; the minute gives it back", async () => {
    const h = harness();
    const app = manyPlaces(h);
    let cursor = (await options(h, WHO.maint, { kind: "jira" })).body.next as string; // first page opens the session
    expect(app.reads).toBe(1);
    // 29 more reads in the minute, from different editors, mixing first pages and later pages (the session allows 10 pages, so first pages carry the rest)
    for (let call = 1; call < 30; call += 1) {
      const who = call % 2 === 0 ? WHO.maint : WHO.owner;
      const reply = await options(h, who, call % 3 === 0 && call < 9 ? { kind: "jira", cursor } : { kind: "jira" });
      expect(reply.status, String(call)).toBe(200);
      if (call % 3 === 0 && call < 9) cursor = (reply.body.next as string | undefined) ?? cursor;
    }
    expect(app.reads).toBe(30);
    const denied = await options(h, WHO.admin, { kind: "jira" });
    expect(denied).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
    const deniedLater = await options(h, WHO.maint, { kind: "jira", cursor });
    expect(deniedLater).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
    expect(app.reads).toBe(30);
    // Another company has its own budget; Linear has its own too (a different tool and key).
    h.apps.get(ORG_B)![0]!.reads = 0;
    expect((await options(h, WHO.otherMaint, { kind: "linear" }, { org: ORG_B })).status).toBe(200);
    expect((await options(h, WHO.maint, { kind: "linear" })).status).toBe(200);
    h.w.clock.ms += 61_000;
    expect((await options(h, WHO.maint, { kind: "jira" })).status).toBe(200);
    expect(app.reads).toBe(31);
  });

  it("a failed tracker read still uses the company's minute: failures cannot repeat past it, and the tool is not asked once it is spent", async () => {
    const h = harness();
    const app = manyPlaces(h);
    const cursor = (await options(h, WHO.maint, { kind: "jira" })).body.next as string;
    app.fails = true;
    const statuses: number[] = [];
    for (let again = 0; again < 40; again += 1) statuses.push((await options(h, WHO.maint, { kind: "jira", cursor })).status);
    expect(statuses.filter((status) => status === 503)).toHaveLength(29); // the first page used one of the 30
    expect(statuses.filter((status) => status === 429)).toHaveLength(11);
    expect(app.reads).toBe(30);
    // The failures gave their session page back (a failed read is not a page), but not the company's minute.
    expect(sessionsOf(h)[0]).toMatchObject({ pages: 1 });
  });

  const sessionsOf = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_OPTIONS");

  it("the inner tracker cursor is checked before the tool is called, the session is not spent and the minute is not used", async () => {
    const h = harness();
    const app = manyPlaces(h);
    const session = String((await options(h, WHO.maint, { kind: "jira" })).body.next).split(".")[0]!;
    const readsBefore = app.reads;
    for (const inner of ["abc", "1", "100.abc", "x.1", "1.a b", `1.${"x".repeat(301)}`]) {
      expect(await options(h, WHO.maint, { kind: "jira", cursor: `${session}.${inner}` }), inner).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    }
    expect(app.reads).toBe(readsBefore);
    expect(sessionsOf(h)[0]).toMatchObject({ pages: 1 });
    // The company's minute is untouched: 29 more reads still go through.
    for (let call = 0; call < 29; call += 1) expect((await options(h, WHO.maint, { kind: "jira" })).status, String(call)).toBe(200);
  });

  it("one person may open 60 first pages a minute, whatever the kind, and the 61st is refused (429) before anything is read; another person is not affected", async () => {
    const h = harness();
    const jira = manyPlaces(h);
    for (let call = 0; call < 30; call += 1) expect((await options(h, WHO.maint, { kind: "jira" })).status, `jira ${String(call)}`).toBe(200);
    h.apps.set(ORG_A, [{ kind: "linear", places: Array.from({ length: 5000 }, (_, index) => ({ scope: linearScope(`${"2".repeat(8)}-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`), name: `L${String(index)}` })), reads: 0, pageSize: 1 }]);
    for (let call = 0; call < 30; call += 1) expect((await options(h, WHO.maint, { kind: "linear" })).status, `linear ${String(call)}`).toBe(200);
    // 60 are spent. Slack's own company budget is untouched, so only the person's limit can refuse this.
    const slackBefore = h.calls.length;
    expect(await options(h, WHO.maint, { kind: "slack" })).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
    expect(h.calls.length).toBe(slackBefore);
    expect(jira.reads).toBe(30);
    expect((await options(h, WHO.owner, { kind: "slack" })).status).toBe(200);
    h.w.clock.ms += 61_000;
    expect((await options(h, WHO.maint, { kind: "slack" })).status).toBe(200);
  });
});

describe("final fix 2: private channels are not in the Slack picker", () => {
  it("a private channel the read sent anyway is dropped on the broker side, and a public one is listed", async () => {
    const h = harness();
    h.pages = [[entry(CH.priv), entry(CH.pub)]];
    const reply = await options(h, WHO.maint, { kind: "slack" });
    expect(optionList(reply).map((option) => option.scope)).toEqual([slackScope(CH.pub)]);
    expect(JSON.stringify(reply.body)).not.toContain("private");
    expect(JSON.stringify(reply.body)).not.toContain("name-c0private");
  });
});

describe("final fix 2: a place another project (or a tap) is clearing shows as being cleared, with no project named", () => {
  const work = (scope: string, project: string | undefined) => putScopeWork(h0.w.table, ORG_A, { type: "tombstone", system: "slack", cause: "excluded", hidePending: true, hidden: 0, childPending: true, requestId: randomUUID(), scope, ...(project === undefined ? {} : { project }), at: AT, queuedAtSeconds: 1 });
  let h0: Harness;
  it("marks it 'clearing' for the other project, not for the project that removed it (its own list says so), and names nobody", async () => {
    h0 = harness();
    await work(slackScope(CH.taken), "api");
    await work(slackScope(CH.mine), undefined);
    const fromWeb = await options(h0, WHO.maint, { kind: "slack" });
    expect(stateOf(fromWeb, slackScope(CH.taken))).toBe("clearing");
    expect(stateOf(fromWeb, slackScope(CH.mine))).toBe("clearing");
    expect(stateOf(fromWeb, slackScope(CH.pub))).toBe("available");
    expect(JSON.stringify(fromWeb.body)).not.toContain("api");
    const fromApi = await options(h0, WHO.owner, { kind: "slack" }, { project: "api" });
    expect(stateOf(fromApi, slackScope(CH.taken))).toBe("available"); // its own removal: its Sources tab lists it as being removed
    expect(stateOf(fromApi, slackScope(CH.mine))).toBe("clearing");
    // A text-only job never closes a place and is not shown as clearing.
    const other = harness();
    h0 = other;
    await putScopeWork(other.w.table, ORG_A, { type: "tombstone", system: "slack", cause: "excluded", hidePending: true, hidden: 0, childPending: true, textOnly: true, requestId: randomUUID(), scope: slackScope(CH.pub), project: "api", at: AT, queuedAtSeconds: 1 });
    expect(stateOf(await options(other, WHO.maint, { kind: "slack" }), slackScope(CH.pub))).toBe("available");
  });
  it("a queue that cannot be read leaves the page as it was (the server's sentence still refuses the add)", async () => {
    h0 = harness();
    await work(slackScope(CH.taken), "api");
    h0.w.db.injectFault({ command: "QueryCommand", match: (input) => JSON.stringify(input.ExpressionAttributeValues ?? {}).includes("DELQ#"), error: { name: "InternalServerError" }, times: 5 });
    const reply = await options(h0, WHO.maint, { kind: "slack" });
    expect(reply.status).toBe(200);
    expect(stateOf(reply, slackScope(CH.taken))).toBe("available");
  });
});

describe("the options route does not disturb the sources read", () => {
  it("GET .../record/sources still answers the editors' view, and a member's reply is the same as before", async () => {
    const h = harness();
    const view = await handleRecordRoute(dependencies(h), { method: "GET", path: PATH("web"), query: {}, caller: caller({ developerId: MAINT, projectRole: "maintainer" }), write: contextOf(h, WHO.maint, undefined) }) as Reply;
    expect(view.status).toBe(200);
    expect(view.body.canEdit).toBe(true);
    const member = await handleRecordRoute(dependencies(h), { method: "GET", path: PATH("web"), query: {}, caller: caller({ developerId: CONTRIB, projectRole: "contributor" }), write: contextOf(h, WHO.contributor, undefined) }) as Reply;
    expect(member).toEqual({ status: 200, body: { sources: [] } });
  });
});

describe("the names the pickers show", () => {
  const answer = (value: unknown) => ({ ok: true, text: async () => JSON.stringify(value) });
  it("linearPlaceNamesReader gives each team's scope and its name with its key; the scope reader still gives scopes only", async () => {
    const body = { data: { teams: { nodes: [{ id: "AAAA-1111", key: "PLT", name: "Platform" }, { id: "bbbb-2222", key: "WEB" }, { id: "cccc-3333", name: "  " }, { nope: 1 }], pageInfo: { hasNextPage: true, endCursor: "cur-1" } } } };
    const fetchFake = (async () => answer(body)) as unknown as typeof fetch;
    const input = { fetch: fetchFake, graphqlUrl: "https://linear.invalid/graphql", apiKey: "k".repeat(8) };
    expect(await linearPlaceNamesReader(input)({ limit: 5 })).toEqual({
      places: [{ scope: linearScope("aaaa-1111"), name: "Platform (PLT)" }, { scope: linearScope("bbbb-2222"), name: "WEB" }, { scope: linearScope("cccc-3333"), name: "cccc-3333" }], next: "cur-1",
    });
    expect(await linearPlacesReader(input)({ limit: 5 })).toEqual({ scopes: [linearScope("aaaa-1111"), linearScope("bbbb-2222"), linearScope("cccc-3333")], next: "cur-1" });
    await expect(linearPlaceNamesReader({ ...input, fetch: (async () => ({ ok: false, text: async () => "" })) as unknown as typeof fetch })({ limit: 5 })).rejects.toThrow();
  });

  it("jiraPlaceNamesReader gives each project's scope and its name with its key, keeps only well-formed keys, and the scope reader is unchanged", async () => {
    const fetchFake = (async () => answer({ values: [{ key: "ENG", name: "Engineering" }, { key: "bad key", name: "x" }, { key: "OPS_1" }], isLast: false })) as unknown as typeof fetch;
    const input = { fetch: fetchFake, siteUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "t" };
    expect(await jiraPlaceNamesReader(input)({ limit: 3 })).toEqual({ places: [{ scope: "jira:project/ENG", name: "Engineering (ENG)" }, { scope: "jira:project/OPS_1", name: "OPS_1" }], next: "3" });
    expect(await jiraPlacesReader(input)({ limit: 3 })).toEqual({ scopes: ["jira:project/ENG", "jira:project/OPS_1"], next: "3" });
  });
});

describe("the broker's own request builds the Slack listing from the identity function's answers", () => {
  const request = {} as never;
  const callerOf = { orgRole: "owner", browserSession: true } as never;
  const contextWith = (developer: Record<string, unknown>) => recordWriteContextOf({ developer } as never, callerOf, request);
  it("passes the install's team, asks for exactly what the route asked and maps the answers", async () => {
    const asked: unknown[] = [];
    const replies: unknown[] = [{ ok: true, channels: [{ id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: true }], next: "abc=" }, { ok: false, error: "missing_scope" }, { ok: false, error: "slack_unavailable" }, { ok: false, error: "invalid_request" }];
    const ctx = contextWith({ slackTeamId: TEAM_A, channelList: async (input: unknown) => { asked.push(input); return replies.shift(); } });
    expect(ctx.slackTeamId).toBe(TEAM_A);
    expect(await ctx.slackChannels!({ teamId: TEAM_A, cursor: "abc=" })).toEqual({ ok: true, channels: [{ id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: true }], next: "abc=" });
    expect(asked).toEqual([{ kind: "channel-list", teamId: TEAM_A, cursor: "abc=" }]);
    expect(await ctx.slackChannels!({ teamId: TEAM_A })).toEqual({ ok: false, error: "missing_scope" });
    expect(asked[1]).toEqual({ kind: "channel-list", teamId: TEAM_A });
    expect(await ctx.slackChannels!({ teamId: TEAM_A })).toEqual({ ok: false, error: "unavailable" });
    expect(await ctx.slackChannels!({ teamId: TEAM_A })).toEqual({ ok: false, error: "unavailable" }); // an identity function without channel-list
  });

  it("the editor's channel membership is read through channel-members for exactly the user and channel asked (final review 3, I1); an install without it offers none", async () => {
    const asked: unknown[] = [];
    const replies: unknown[] = [{ ok: true, memberOf: ["C0PRIVATE"] }, { ok: true, memberOf: [] }, { ok: false, error: "slack_unavailable" }];
    const ctx = contextWith({ channelMembers: async (input: unknown) => { asked.push(input); return replies.shift(); } });
    expect(await ctx.slackMember!("U0MAINT001", "C0PRIVATE")).toBe(true);
    expect(await ctx.slackMember!("U0MAINT001", "C0PRIVATE")).toBe(false);
    expect(await ctx.slackMember!("U0MAINT001", "C0PRIVATE")).toBeUndefined();
    expect(asked[0]).toEqual({ kind: "channel-members", slackUserId: "U0MAINT001", channelIds: ["C0PRIVATE"] });
    expect(recordWriteContextOf({} as never, callerOf, request).slackMember).toBeUndefined();
  });

  it("an install with no such read, or no Slack team, offers neither (the picker then falls back to typing)", () => {
    expect(contextWith({ slackTeamId: TEAM_A }).slackChannels).toBeUndefined();
    expect(contextWith({ channelList: async () => ({ ok: true, channels: [] }) }).slackTeamId).toBeUndefined();
    expect(recordWriteContextOf({} as never, callerOf, request).slackChannels).toBeUndefined();
  });
});

describe("the runtime wires the pickers (workspace binding from the State table, apps from the connected trackers)", () => {
  function runtimeOf(h: Harness, trackers: boolean) {
    const db = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
    seedCompany(db, ORG_A, { [OWNER]: "owner" }, [], ["web"]);
    db.set({ ...slackTeamOrgKey(TEAM_A), orgId: ORG_A });
    db.set({ ...slackTeamOrgKey(TEAM_B), orgId: ORG_B });
    return createTeamRecordRuntime({
      env: { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" }, documentClient: db, stateTableName: "State", now: () => h.w.clock.ms,
      ...(trackers ? { trackers: trackersOf(h) } : {}),
    }) as TeamRecordRuntime;
  }
  const read = (runtime: TeamRecordRuntime, h: Harness, kind: string, install: string = TEAM_A) => runtime.routes({
    method: "GET", path: `${PATH("web")}/options`, query: { kind }, caller: { orgId: ORG_A, developerId: OWNER, projectRole: "maintainer" }, write: contextOf(h, WHO.owner, undefined, { slackTeamId: install }),
  });

  it("Slack: the State table's binding decides whose workspace it is; the company's own is listed, another's is empty", async () => {
    const h = harness();
    const runtime = runtimeOf(h, false);
    expect(await read(runtime, h, "slack")).toMatchObject({ status: 200, body: { kind: "slack", options: expect.arrayContaining([expect.objectContaining({ scope: slackScope(CH.pub) })]) as unknown } });
    h.calls.length = 0;
    expect(await read(runtime, h, "slack", TEAM_B)).toEqual({ status: 200, body: { kind: "slack", options: [] } });
    expect(h.calls).toEqual([]);
  });

  it("Linear and Jira: the connected trackers list the places; an install with none answers a fixed 503", async () => {
    const h = harness();
    expect(await read(runtimeOf(h, true), h, "linear")).toMatchObject({ status: 200, body: { kind: "linear", options: [expect.objectContaining({ name: "Platform (PLT)" }), expect.anything()] } });
    expect(await read(runtimeOf(h, false), h, "jira")).toEqual(FIXED_503);
  });
});
