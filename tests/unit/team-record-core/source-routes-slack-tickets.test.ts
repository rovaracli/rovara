// Slack and Linear/Jira source rows (Team record source-row lane, task 7): an editor adds, changes and removes a Slack channel or a Linear team / Jira project as a source, and the SERVER decides what
// the place is. Slack: the workspace must be this company's, the channel is read live (public, private, DM, group DM, Slack Connect) and the edition's rules apply; Linear and Jira: the place must be
// one the company's connected app lists, read live. Same harness as `source-routes.test.ts` (copied: it is not exported), plus fakes for the live Slack read and the connected apps.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentXError, developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, slackTeamOrgKey, type OrgId } from "@agentx/contracts";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import type { SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import { classifySlack, linearScope, parseSlackScope, trackerPlaceCheck, type SlackFacts } from "../../../packages/broker/src/team-record/source-places.js";
import { jiraPlacesReader, linearPlacesReader, type ConnectedTracker, type ConnectedTrackersPort } from "../../../packages/broker/src/team-record/tracker-directory.js";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B, caller, world, type World } from "../../support/team-record-core.js";

// ---- people. Every id is a 64-character hex string, as the company's records keep them.
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MAINT = "c".repeat(64), OTHER_ORG_MAINT = "1".repeat(64), OTHER_ORG_OWNER = "2".repeat(64);
type OrgRole = "owner" | "admin" | "member" | "auditor";
interface Who { id: string; orgRole: OrgRole; projectRole: "maintainer" | "contributor" | "viewer" | undefined }
const WHO = {
  owner: { id: OWNER, orgRole: "owner", projectRole: "maintainer" },
  admin: { id: ADMIN, orgRole: "admin", projectRole: "maintainer" },
  maint: { id: MAINT, orgRole: "member", projectRole: "maintainer" },
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

// ---- the places
const TEAM_A = "T0AAAAAAA", TEAM_B = "T0BBBBBBB", TEAM_OTHER = "T0ZZZZZZZ";
const CH = { pub: "C0PUBLIC1", priv: "C0PRIVATE", dm: "D0DIRECT01", mpim: "G0GROUPDM", connect: "C0CONNECT1", connectPrivate: "C0CONNECTP", gone: "C0GONE0001", other: "C0OTHER001" } as const;
const FACTS: Record<string, SlackFacts> = {
  [CH.pub]: { kind: "public", extShared: false },
  [CH.priv]: { kind: "private", extShared: false },
  [CH.dm]: { kind: "im", extShared: false },
  [CH.mpim]: { kind: "mpim", extShared: false },
  [CH.connect]: { kind: "public", extShared: true },
  [CH.connectPrivate]: { kind: "private", extShared: true },
  [CH.other]: { kind: "public", extShared: false },
};
const LINEAR_A = "11111111-aaaa-4aaa-8aaa-111111111111", LINEAR_A2 = "22222222-aaaa-4aaa-8aaa-222222222222", LINEAR_B = "33333333-bbbb-4bbb-8bbb-333333333333";

type Lookup = SlackFacts | "none" | "unreadable" | "throws";
interface App { kind: "linear" | "jira"; scopes: string[] | "fails"; pageSize?: number; reads: number }
interface Harness {
  w: World; audit: ReturnType<typeof capturingAuditDeps>; repos: Map<string, number[]>; ids: { next: number };
  /** The company's bound Slack teams. */ teams: Map<OrgId, Set<string>>;
  /** What the live Slack read answers per channel; `reads` lists what was asked. */ channels: Map<string, Lookup>; reads: string[];
  apps: Map<OrgId, App[]>; trackersOn: boolean; slackOn: boolean; lookupOn: boolean;
  /** The Slack ids each person signed in with (the sign-in store's links), and who is in which channel (`channel-members`): `memberAsks` lists what was asked, as `<slack id>@<channel>`. */
  linked: Map<string, string[]>; members: Map<string, Set<string>>; memberAsks: string[]; memberRead: "ok" | "unreadable" | "throws"; memberOn: boolean; linksOn: boolean;
}
function harness(options: { edition?: "enterprise" | "public" } = {}): Harness {
  const w = world({ edition: options.edition ?? "enterprise" });
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.ms });
  seedCompany(w.db, ORG_A, { [OWNER]: "owner", [ADMIN]: "admin", [MAINT]: "member" }, [{ id: MAINT, project: "web" }], ["web", "api"]);
  seedCompany(w.db, ORG_B, { [OTHER_ORG_OWNER]: "owner", [OTHER_ORG_MAINT]: "member" }, [{ id: OTHER_ORG_MAINT, project: "web" }], ["web"]);
  const channels = new Map<string, Lookup>(Object.entries(FACTS));
  channels.set(CH.gone, "none");
  return {
    w, audit, repos: new Map(), ids: { next: 1 }, teams: new Map([[ORG_A, new Set([TEAM_A])], [ORG_B, new Set([TEAM_B])]]), channels, reads: [],
    apps: new Map<OrgId, App[]>([
      [ORG_A, [{ kind: "linear", scopes: [linearScope(LINEAR_A), linearScope(LINEAR_A2)], reads: 0 }, { kind: "jira", scopes: ["jira:project/ENG", "jira:project/OPS"], reads: 0 }]],
      [ORG_B, [{ kind: "linear", scopes: [linearScope(LINEAR_B)], reads: 0 }]],
    ]),
    trackersOn: true, slackOn: true, lookupOn: true,
    // By default every editor is linked and is in every channel that is not public (so the older tests are about what they say); the new ones change these.
    linked: new Map([[OWNER, ["U0OWNER001"]], [ADMIN, ["U0ADMIN001"]], [MAINT, ["U0MAINT001"]]]),
    members: new Map([CH.priv, CH.dm, CH.mpim, CH.connectPrivate].map((channel) => [channel, new Set(["U0OWNER001", "U0ADMIN001", "U0MAINT001"])] as const)),
    memberAsks: [], memberRead: "ok", memberOn: true, linksOn: true,
  };
}

function trackersOf(h: Harness): ConnectedTrackersPort {
  const tracker = (app: App, index: number): ConnectedTracker => ({
    connectionId: `con_${String(index).padStart(20, "a")}`, system: app.kind === "jira" ? "jira:acme.atlassian.net" : "linear", kind: app.kind,
    async readUsers() { return { users: [] }; },
    async readPlaces({ after, limit }) {
      app.reads += 1;
      if (app.scopes === "fails") throw new Error("the tool is down");
      const size = Math.min(limit, app.pageSize ?? 100), start = after === undefined ? 0 : Number(after);
      return { scopes: app.scopes.slice(start, start + size), ...(start + size < app.scopes.length ? { next: String(start + size) } : {}) };
    },
  });
  return { list: async (orgId) => (h.apps.get(orgId) ?? []).map(tracker), get: async () => undefined };
}

const dependencies = (h: Harness) => ({
  table: h.w.table, modes: h.w.deps.modes, now: () => h.w.clock.ms,
  sources: {
    edition: h.w.deps.edition,
    projectRepositories: async (orgId: OrgId, project: string) => h.repos.get(`${orgId}/${project}`),
    pausedSources: async () => [] as string[],
    newId: () => `change-${String(h.ids.next++)}`,
    ...(h.slackOn ? { slackTeamBound: async (orgId: OrgId, teamId: string) => h.teams.get(orgId)?.has(teamId) === true } : {}),
    ...(h.linksOn ? { slackUserIdsOf: async (developerId: string) => h.linked.get(developerId) ?? [] } : {}),
    ...(h.trackersOn ? { trackerPlace: trackerPlaceCheck(trackersOf(h), { now: () => h.w.clock.ms }) } : {}),
  },
});

function contextOf(h: Harness, who: Who, body: unknown, over: Partial<SourceWriteContext> = {}): SourceWriteContext {
  return {
    orgRole: who.orgRole, browserSession: true, body: () => body, audit: h.audit.deps,
    ...(h.lookupOn ? {
      slackChannel: async (teamId: string, channelId: string) => {
        h.reads.push(`${teamId}/${channelId}`);
        const answer = h.channels.get(channelId);
        if (answer === "throws") throw new Error("slack went away");
        return answer === undefined || answer === "unreadable" ? undefined : answer;
      },
    } : {}),
    ...(h.memberOn ? {
      slackMember: async (userId: string, channelId: string) => {
        h.memberAsks.push(`${userId}@${channelId}`);
        if (h.memberRead === "throws") throw new Error("slack went away");
        if (h.memberRead === "unreadable") return undefined;
        return h.members.get(channelId)?.has(userId) === true;
      },
    } : {}),
    ...over,
  };
}

const PATH = (project: string) => `/v1/app/projects/${project}/record/sources`;
async function post(h: Harness, who: Who, body: unknown, options: { org?: OrgId; project?: string; context?: Partial<SourceWriteContext> } = {}) {
  return await handleRecordRoute(dependencies(h), {
    method: "POST", path: PATH(options.project ?? "web"), query: {}, caller: caller({ orgId: options.org ?? ORG_A, developerId: who.id, projectRole: who.projectRole }),
    write: contextOf(h, who, body, options.context),
  }) as { status: number; body: Record<string, unknown> };
}
async function getView(h: Harness, who: Who) {
  return await handleRecordRoute(dependencies(h), { method: "GET", path: PATH("web"), query: {}, caller: caller({ orgId: ORG_A, developerId: who.id, projectRole: who.projectRole }), write: contextOf(h, who, undefined) }) as { status: number; body: Record<string, unknown> };
}

const slackScope = (channel: string, team = TEAM_A) => `slack:${team}/${channel}`;
const add = (over: Record<string, unknown> = {}) => ({ action: "add", requestId: randomUUID(), source: "slack", scope: slackScope(CH.pub), retention: "C", audienceDefault: "maintainers", enabled: true, ...over });
const change = (expectedRevision: number, over: Record<string, unknown> = {}) => ({ action: "change", requestId: randomUUID(), source: "slack", scope: slackScope(CH.pub), expectedRevision, ...over });
const remove = (expectedRevision: number, over: Record<string, unknown> = {}) => ({ action: "remove", requestId: randomUUID(), source: "slack", scope: slackScope(CH.pub), expectedRevision, ...over });
const linearAdd = (over: Record<string, unknown> = {}) => add({ source: "linear", scope: linearScope(LINEAR_A), retention: "C", ...over });
const jiraAdd = (over: Record<string, unknown> = {}) => add({ source: "jira", scope: "jira:project/ENG", retention: "C", ...over });

const sourceRows = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE");
const proposals = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_CHANGE"); // no such row is ever written any more (T9)
const claims = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_SCOPE");
const requests = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_REQUEST");
const nothingWritten = (h: Harness) => { expect(sourceRows(h)).toHaveLength(0); expect(proposals(h)).toHaveLength(0); expect(claims(h)).toHaveLength(0); expect(requests(h)).toHaveLength(0); };
const flushed = async (h: Harness) => { await new Promise((resolve) => setTimeout(resolve, 0)); return h.audit.recorded(); };
const INVITE_NEEDED = { status: 422, body: { code: "SLACK_INVITE_NEEDED", message: "Rovara isn't in that channel yet. Type /invite @Rovara in the channel, then try again. You must be in the channel yourself, with your Slack account linked to Rovara." } };
const DIFFERENT_WORKSPACE = { status: 422, body: { code: "SLACK_WRONG_WORKSPACE", message: "That link is for a different Slack workspace." } };
const NOT_ALLOWED = (message: string) => ({ status: 422, body: { code: "SOURCE_NOT_ALLOWED", message } });
const CONNECT_WORDS = "Slack Connect channels can't be used as a source.";
const DM_WORDS = "Direct messages and group messages can't be used as a source in this edition.";

describe("Slack: the server decides what the channel is", () => {
  it("a public channel is saved in both editions, with the row, the claim and an audit event", async () => {
    for (const [edition, retention] of [["enterprise", "C"], ["public", "A"]] as const) {
      const h = harness({ edition });
      expect(await post(h, WHO.maint, add({ retention })), edition).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
      expect(sourceRows(h), edition).toMatchObject([{ workspaceId: ORG_A, project: "web", source: "slack", scope: slackScope(CH.pub), retention, enabled: true, audienceDefault: "maintainers", addedBy: MAINT, revision: 1 }]);
      expect(claims(h)).toHaveLength(1);
      expect(h.reads).toEqual([`${TEAM_A}/${CH.pub}`]);
      expect((await flushed(h)).find((event) => event.action === "record.source_added")).toMatchObject({ facts: { source: "slack", retention, restricted: false } });
    }
  });

  it("a private channel in Public is saved at once and says widened: private_channel (both editions, fix round 1); without a ledger it is refused", async () => {
    const pub = harness({ edition: "public" });
    expect(await post(pub, WHO.owner, add({ scope: slackScope(CH.priv), retention: "A" }), { context: { audit: {} } })).toMatchObject({ status: 503, body: { code: "AUDIT_UNAVAILABLE" } });
    nothingWritten(pub);
    expect(await post(pub, WHO.owner, add({ scope: slackScope(CH.priv), retention: "A" }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(pub)).toHaveLength(1);
    expect((await flushed(pub)).find((event) => event.action === "record.source_added")?.facts).toMatchObject({ restricted: true, widened: "private_channel" });
  });

  it("the words of what was widened come from what the server read, never from the body: a body that names reasons, widened or a kind is refused as invalid", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ scope: slackScope(CH.priv), retention: "D" }))).status).toBe(200);
    for (const extra of [{ reasons: [] }, { widened: "dm" }, { kind: "public" }, { channelKind: "public_channel" }]) {
      const reply = await post(h, WHO.owner, add({ scope: slackScope(CH.priv), ...extra }));
      expect(reply, JSON.stringify(extra)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    }
    expect(sourceRows(h)).toHaveLength(1);
  });

  it("only the exact form slack:<team>/<channel> names a place", async () => {
    const h = harness();
    for (const scope of [`slack:${TEAM_A}`, `slack:${TEAM_A}/`, `slack:${TEAM_A}/${CH.pub}/x`, `slack:${TEAM_A}/c0public1`, `slack:t0aaaaaaa/${CH.pub}`, `github:repo/9`, `slack:${TEAM_A}/${CH.pub} `]) {
      const reply = await post(h, WHO.owner, add({ scope }));
      expect(reply, scope).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
      expect(JSON.stringify(reply.body), scope).not.toContain("T0AAAAAAA");
    }
    expect(h.reads).toEqual([]);
    nothingWritten(h);
  });

  it("the workspace must be this company's: another company's team (and a team nobody bound) is refused as a missing place, and Slack is not even asked", async () => {
    const h = harness();
    for (const team of [TEAM_B, TEAM_OTHER]) {
      const reply = await post(h, WHO.owner, add({ scope: slackScope(CH.pub, team) }));
      expect(reply, team).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID", message: "That place can't be used as a source for this project." } });
      expect(JSON.stringify(reply.body)).not.toContain(team);
    }
    expect(h.reads).toEqual([]);
    nothingWritten(h);
    // Positive control: the same channel of the company's own team is read and saved; and company B can use its own team, independently.
    expect((await post(h, WHO.owner, add())).status).toBe(200);
    expect(h.reads).toEqual([`${TEAM_A}/${CH.pub}`]);
    expect((await post(h, WHO.otherMaint, add({ scope: slackScope(CH.pub, TEAM_B) }), { org: ORG_B })).status).toBe(200);
    expect(sourceRows(h).map((row) => [row.workspaceId, row.scope])).toEqual(expect.arrayContaining([[ORG_A, slackScope(CH.pub)], [ORG_B, slackScope(CH.pub, TEAM_B)]]));
    expect(claims(h)).toHaveLength(2);
    // Company B cannot take company A's team either.
    expect(await post(h, WHO.otherMaint, add({ scope: slackScope(CH.pub, TEAM_A) }), { org: ORG_B })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
  });

  it("a channel Slack does not know is answered with the fixed 'invite Rovara first' code (task 11: this replaces the missing-place answer; it never says whether the channel exists); one that cannot be read fails closed with 503 and writes nothing", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ scope: slackScope(CH.gone) }))).toEqual(INVITE_NEEDED);
    h.channels.set(CH.pub, "unreadable");
    expect(await post(h, WHO.owner, add())).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    h.channels.set(CH.pub, "throws");
    expect(await post(h, WHO.owner, add())).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    nothingWritten(h);
    // The install cannot ask Slack at all (no lookup in the request): the same.
    const bare = harness();
    bare.lookupOn = false;
    expect(await post(bare, WHO.owner, add())).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    nothingWritten(bare);
  });

  it("a route built without the Slack workspace check refuses a Slack add (fail closed)", async () => {
    const h = harness();
    h.slackOn = false;
    expect(await post(h, WHO.owner, add())).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    nothingWritten(h);
  });

  it("Public retention for Slack: C and D are refused; B needs the notes opt-in and is saved with it; A is saved", async () => {
    const h = harness({ edition: "public" });
    for (const retention of ["C", "D"]) expect(await post(h, WHO.owner, add({ retention })), retention).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.owner, add({ retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    nothingWritten(h);
    expect(await post(h, WHO.owner, add({ retention: "B", notesOptIn: true }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(h)).toMatchObject([{ retention: "B", notesOptIn: true }]);
    const other = harness({ edition: "public" });
    expect((await post(other, WHO.owner, add({ retention: "A" }))).status).toBe(200);
  });

  it("a channel another project already holds is refused (the place claim); a repeat of the same request answers the stored outcome without asking Slack again", async () => {
    const h = harness();
    const first = add();
    expect(await post(h, WHO.owner, first)).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(await post(h, WHO.owner, add(), { project: "api" })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID", message: "That place is already used by another project." } });
    expect(sourceRows(h)).toHaveLength(1);
    const reads = h.reads.length;
    expect(await post(h, WHO.owner, first)).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(h.reads).toHaveLength(reads);
    expect(sourceRows(h)).toHaveLength(1);
  });
});

describe("Slack: changing a row", () => {
  const saved = async (h: Harness, over: Record<string, unknown> = {}) => { expect((await post(h, WHO.owner, add(over))).status).toBe(200); };

  it("Public: a retention change to C or D is refused; to B needs the opt-in", async () => {
    const h = harness({ edition: "public" });
    await saved(h, { retention: "A" });
    expect(await post(h, WHO.owner, change(1, { retention: "C" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.owner, change(1, { retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.owner, change(1, { retention: "B", notesOptIn: true }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)).toMatchObject([{ retention: "B", notesOptIn: true, revision: 2 }]);
  });

  it("turning a row off or lowering what it keeps never asks Slack; turning it on, or widening it, reads the channel again and refuses what has become Slack Connect", async () => {
    const h = harness();
    await saved(h);
    const before = h.reads.length;
    expect(await post(h, WHO.owner, change(1, { enabled: false }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(await post(h, WHO.owner, change(2, { retention: "B" }))).toEqual({ status: 200, body: { status: "saved", revision: 3 } });
    expect(h.reads).toHaveLength(before);
    h.channels.set(CH.pub, { kind: "public", extShared: true });
    expect(await post(h, WHO.owner, change(3, { enabled: true }))).toEqual(NOT_ALLOWED(CONNECT_WORDS));
    expect(await post(h, WHO.owner, change(3, { audienceDefault: "project" }))).toEqual(NOT_ALLOWED(CONNECT_WORDS));
    expect(h.reads).toHaveLength(before + 2);
    h.channels.set(CH.pub, "unreadable");
    expect(await post(h, WHO.owner, change(3, { enabled: true }))).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    expect(sourceRows(h)).toMatchObject([{ enabled: false, retention: "B", revision: 3 }]);
  });
});

describe("Slack: a change that turns a row on or widens it says what the channel's class is now (T9: saved at once)", () => {
  const CLASSES = [[CH.priv, "private_channel"], [CH.dm, "dm"], [CH.mpim, "mpim"]] as const;
  const widenedOf = async (h: Harness) => (await flushed(h)).filter((event) => event.action === "record.source_changed").map((event) => event.facts?.widened);

  it("a public row whose channel became private: widening the audience, or turning it on, is saved at once and says private_channel / mpim", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add())).status).toBe(200);
    h.channels.set(CH.pub, { kind: "private", extShared: false });
    expect(await post(h, WHO.owner, change(1, { audienceDefault: "project" }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)).toMatchObject([{ audienceDefault: "project", revision: 2 }]);
    expect(await widenedOf(h)).toEqual(["private_channel"]);

    const off = harness();
    expect((await post(off, WHO.owner, add({ enabled: false }))).status).toBe(200);
    off.channels.set(CH.pub, { kind: "mpim", extShared: false });
    expect(await post(off, WHO.owner, change(1, { enabled: true, retention: "D" }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(off)).toMatchObject([{ enabled: true, retention: "D", revision: 2 }]);
    expect(await widenedOf(off)).toEqual(["retention_raise,mpim"]);
  });

  it("a private, DM or group DM row turned off and back on: turning it off, or narrowing it, never asks Slack and says nothing widened; turning it on says the class", async () => {
    for (const [channel, word] of CLASSES) {
      const h = harness();
      expect((await post(h, WHO.maint, add({ scope: slackScope(channel), audienceDefault: "project" }))).status, channel).toBe(200);
      const reads = h.reads.length;
      expect(await post(h, WHO.owner, change(1, { scope: slackScope(channel), enabled: false })), channel).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
      expect(await post(h, WHO.owner, change(2, { scope: slackScope(channel), audienceDefault: "maintainers" })), channel).toEqual({ status: 200, body: { status: "saved", revision: 3 } });
      expect(h.reads).toHaveLength(reads);
      expect(await post(h, WHO.owner, change(3, { scope: slackScope(channel), enabled: true })), channel).toEqual({ status: 200, body: { status: "saved", revision: 4 } });
      expect(sourceRows(h), channel).toMatchObject([{ enabled: true, revision: 4 }]);
      expect(await widenedOf(h), channel).toEqual([undefined, undefined, word]);
    }
  });

  it("a retention raise alone on a private row says only retention_raise; Public turns a private row on and says private_channel", async () => {
    const h = harness();
    expect((await post(h, WHO.maint, add({ scope: slackScope(CH.priv) }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { scope: slackScope(CH.priv), retention: "D" }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(await widenedOf(h)).toEqual(["retention_raise"]);
    const pub = harness({ edition: "public" });
    expect((await post(pub, WHO.owner, add({ scope: slackScope(CH.priv), retention: "A", enabled: false }))).status).toBe(200);
    expect(await post(pub, WHO.owner, change(1, { scope: slackScope(CH.priv), enabled: true }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(await widenedOf(pub)).toEqual(["private_channel"]);
  });
});

describe("Linear and Jira: the place must be one the connected app lists", () => {
  it("a listed Linear team and a listed Jira project are saved; the stored row keeps what the editor sent for the audience (maintainers first)", async () => {
    const h = harness();
    expect(await post(h, WHO.maint, linearAdd())).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(await post(h, WHO.maint, jiraAdd())).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(h)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "linear", scope: linearScope(LINEAR_A), retention: "C", audienceDefault: "maintainers", enabled: true, addedBy: MAINT, revision: 1 }),
      expect.objectContaining({ source: "jira", scope: "jira:project/ENG", audienceDefault: "maintainers" }),
    ]));
    expect(claims(h)).toHaveLength(2);
    expect((await flushed(h)).filter((event) => event.action === "record.source_added")).toHaveLength(2);
    // Public edition: D is the ordinary default for a tracker.
    const pub = harness({ edition: "public" });
    expect((await post(pub, WHO.owner, linearAdd({ retention: "D", audienceDefault: "project" }))).status).toBe(200);
    expect(sourceRows(pub)).toMatchObject([{ retention: "D", audienceDefault: "project" }]);
  });

  it("an id the app does not list is refused as a missing place, with nothing echoed and nothing written; so is another company's team, a wrong prefix for the kind and a wrong case", async () => {
    const h = harness();
    for (const body of [
      linearAdd({ scope: linearScope("99999999-cccc-4ccc-8ccc-999999999999") }),
      linearAdd({ scope: linearScope(LINEAR_B) }),
      linearAdd({ scope: "jira:project/ENG" }),
      linearAdd({ scope: `linear:team/${LINEAR_A.toUpperCase()}` }),
      jiraAdd({ scope: "jira:project/NOPE" }),
      jiraAdd({ scope: "jira:project/eng" }),
      jiraAdd({ scope: linearScope(LINEAR_A) }),
      jiraAdd({ scope: "jira:site/acme.atlassian.net" }),
    ]) {
      const reply = await post(h, WHO.owner, body);
      expect(reply, String(body.scope)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID", message: "That place can't be used as a source for this project." } });
      expect(JSON.stringify(reply.body)).not.toMatch(/NOPE|9999|bbbb/u);
    }
    nothingWritten(h);
    // Company B's own team is fine for company B, and only there.
    expect((await post(h, WHO.otherMaint, linearAdd({ scope: linearScope(LINEAR_B) }), { org: ORG_B })).status).toBe(200);
    expect(await post(h, WHO.otherMaint, linearAdd({ scope: linearScope(LINEAR_A) }), { org: ORG_B })).toMatchObject({ status: 400 });
  });

  it("a company with no connected app for the kind, or an install without the connections (Jira's admin routes exist only with them), cannot add one", async () => {
    const noJira = harness();
    noJira.apps.set(ORG_A, [{ kind: "linear", scopes: [linearScope(LINEAR_A)], reads: 0 }]);
    expect(await post(noJira, WHO.owner, jiraAdd())).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    const off = harness();
    off.trackersOn = false;
    for (const body of [jiraAdd(), linearAdd()]) expect(await post(off, WHO.owner, body)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    nothingWritten(noJira);
    nothingWritten(off);
  });

  it("the app is read live: a listing that cannot be read, or that ends before the place is found, fails closed with 503; a place on a later page is found", async () => {
    const down = harness();
    down.apps.get(ORG_A)![0]!.scopes = "fails";
    expect(await post(down, WHO.owner, linearAdd())).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    nothingWritten(down);
    // Jira still answers for its own place while the Linear app is down (each kind asks only its own apps).
    expect((await post(down, WHO.owner, jiraAdd())).status).toBe(200);

    const paged = harness();
    const many = Array.from({ length: 450 }, (_, index) => linearScope(`${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-111111111111`));
    paged.apps.set(ORG_A, [{ kind: "linear", scopes: [...many, linearScope(LINEAR_A)], pageSize: 100, reads: 0 }]);
    expect((await post(paged, WHO.owner, linearAdd())).status).toBe(200);
    expect(paged.apps.get(ORG_A)![0]!.reads).toBe(5);

    const endless = harness();
    endless.apps.set(ORG_A, [{ kind: "linear", scopes: Array.from({ length: 3_000 }, (_, index) => linearScope(`${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-111111111111`)), pageSize: 100, reads: 0 }]);
    expect(await post(endless, WHO.owner, linearAdd())).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    expect(endless.apps.get(ORG_A)![0]!.reads).toBeLessThanOrEqual(20);
    nothingWritten(endless);
  });

  it("a place two projects want goes to the first", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, linearAdd())).status).toBe(200);
    expect(await post(h, WHO.owner, linearAdd(), { project: "api" })).toMatchObject({ status: 400, body: { message: "That place is already used by another project." } });
    expect(await post(h, WHO.owner, jiraAdd({ retention: "D" }))).toMatchObject({ status: 200 });
  });

  it("a change to a Linear or Jira row works without asking the app", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, linearAdd())).status).toBe(200);
    const reads = h.apps.get(ORG_A)![0]!.reads;
    expect(await post(h, WHO.owner, change(1, { source: "linear", scope: linearScope(LINEAR_A), audienceDefault: "project", exclude: ["issue:1"] }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)).toMatchObject([{ audienceDefault: "project", exclude: ["issue:1"] }]);
    expect(h.apps.get(ORG_A)![0]!.reads).toBe(reads);
  });
});

describe("removing a Slack, Linear or Jira row", () => {
  it("the removal path works for every kind unchanged: the row and its claim go, the place's data is queued for deletion, nothing else is touched", async () => {
    for (const [source, scope, body] of [["slack", slackScope(CH.pub), add()], ["linear", linearScope(LINEAR_A), linearAdd()], ["jira", "jira:project/ENG", jiraAdd()]] as const) {
      const h = harness();
      expect((await post(h, WHO.maint, body)).status, source).toBe(200);
      expect((await post(h, WHO.owner, add({ scope: slackScope(CH.other) }))).status).toBe(200); // a bystander row
      const reply = await post(h, WHO.maint, remove(1, { source, scope }));
      expect(reply, source).toEqual({ status: 200, body: { status: "removed" } });
      expect(sourceRows(h).map((row) => row.scope), source).toEqual([slackScope(CH.other)]);
      expect(claims(h), source).toHaveLength(1);
      const queued = await listScopeWork(h.w.table, ORG_A, 10);
      expect(queued, source).toMatchObject([{ type: "tombstone", system: source, scope, cause: "excluded", hidePending: true, childPending: true }]);
      expect((await flushed(h)).map((event) => event.action), source).toContain("record.source_removed");
    }
  });

  it("another company cannot remove the row (it answers as a missing one), and the place can be added again by its own company afterwards", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, linearAdd())).status).toBe(200);
    expect(await post(h, WHO.otherMaint, remove(1, { source: "linear", scope: linearScope(LINEAR_A) }), { org: ORG_B })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(sourceRows(h)).toHaveLength(1);
  });
});

describe("the kinds that are still not available", () => {
  it("MCP and plug-in code hosts answer SOURCE_KIND_NOT_YET; Slack, Linear and Jira no longer do", async () => {
    const h = harness();
    for (const [source, scope] of [["mcp", "mcp:srv/x"], ["codehost:gitfarm", "codehost:gitfarm:repo/1"]] as const) {
      expect(await post(h, WHO.owner, add({ source, scope })), source).toEqual({ status: 422, body: { code: "SOURCE_KIND_NOT_YET", message: "That kind of source can't be added yet." } });
    }
    nothingWritten(h);
    for (const body of [add(), linearAdd(), jiraAdd()]) expect((await post(h, WHO.owner, body)).body.code).not.toBe("SOURCE_KIND_NOT_YET");
  });
});

describe("the pure pieces", () => {
  it("classifySlack: Connect first, then the channel's own kind", () => {
    expect(classifySlack({ kind: "public", extShared: false })).toBe("public_channel");
    expect(classifySlack({ kind: "private", extShared: false })).toBe("private_channel");
    expect(classifySlack({ kind: "im", extShared: false })).toBe("dm");
    expect(classifySlack({ kind: "mpim", extShared: false })).toBe("mpim");
    for (const kind of ["public", "private", "im", "mpim"] as const) expect(classifySlack({ kind, extShared: true })).toBe("slack_connect");
  });

  it("parseSlackScope accepts only slack:<team>/<channel>", () => {
    expect(parseSlackScope(slackScope(CH.dm))).toEqual({ teamId: TEAM_A, channelId: CH.dm });
    expect(parseSlackScope("slack:T0AAAAAAA")).toBeUndefined();
    expect(parseSlackScope("slack:T0AAAAAAA/C0PUBLIC1/extra")).toBeUndefined();
    expect(parseSlackScope("slack:T0AAAAAAA/x")).toBeUndefined();
  });

  it("linearPlacesReader lists the workspace's teams (ids in lower case) a page at a time and refuses what it cannot read", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const answer = (nodes: unknown[], more: boolean) => ({ ok: true, text: async () => JSON.stringify({ data: { teams: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? "cur-1" : null } } } }) });
    const fetchFake = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return calls.length === 1 ? answer([{ id: "AAAA-1111" }, { id: "bbbb-2222" }], true) : answer([{ id: "cccc-3333" }, { nope: 1 }], false);
    }) as unknown as typeof fetch;
    const read = linearPlacesReader({ fetch: fetchFake, graphqlUrl: "https://linear.invalid/graphql", apiKey: "k".repeat(8) });
    expect(await read({ limit: 2 })).toEqual({ scopes: [linearScope("aaaa-1111"), linearScope("bbbb-2222")], next: "cur-1" });
    expect(await read({ after: "cur-1", limit: 2 })).toEqual({ scopes: [linearScope("cccc-3333")] });
    expect(calls[0]!.body.variables).toEqual({ first: 2 });
    expect(calls[1]!.body.variables).toEqual({ first: 2, after: "cur-1" });
    await expect(linearPlacesReader({ fetch: (async () => ({ ok: false, text: async () => "" })) as unknown as typeof fetch, graphqlUrl: "https://linear.invalid/graphql", apiKey: "k" })({ limit: 5 })).rejects.toThrow();
    await expect(linearPlacesReader({ fetch: (async () => ({ ok: true, text: async () => "not json" })) as unknown as typeof fetch, graphqlUrl: "https://linear.invalid/graphql", apiKey: "k" })({ limit: 5 })).rejects.toThrow();
  });

  it("jiraPlacesReader lists the site's project keys by position, keeps only well-formed keys, and refuses what it cannot read", async () => {
    const urls: string[] = [];
    const fetchFake = (async (url: string) => {
      urls.push(url);
      return { ok: true, text: async () => JSON.stringify(urls.length === 1 ? { values: [{ key: "ENG" }, { key: "bad key" }, { key: "OPS_1" }], isLast: false } : { values: [{ key: "WEB" }], isLast: true }) };
    }) as unknown as typeof fetch;
    const read = jiraPlacesReader({ fetch: fetchFake, siteUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "t" });
    expect(await read({ limit: 3 })).toEqual({ scopes: ["jira:project/ENG", "jira:project/OPS_1"], next: "3" });
    expect(await read({ after: "3", limit: 3 })).toEqual({ scopes: ["jira:project/WEB"] });
    expect(urls[0]).toBe("https://acme.atlassian.net/rest/api/3/project/search?startAt=0&maxResults=3");
    expect(urls[1]).toBe("https://acme.atlassian.net/rest/api/3/project/search?startAt=3&maxResults=3");
    await expect(read({ after: "-1", limit: 3 })).rejects.toThrow();
    await expect(jiraPlacesReader({ fetch: (async () => ({ ok: false, text: async () => "" })) as unknown as typeof fetch, siteUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "t" })({ limit: 3 })).rejects.toThrow();
  });
});

describe("the runtime wires the checks (workspace binding from the State table, apps from the connected trackers)", () => {
  function runtimeOf(options: { trackers?: ConnectedTrackersPort } = {}) {
    const db = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
    const clock = { ms: Date.parse("2026-10-30T12:00:00.000Z") };
    seedCompany(db, ORG_A, { [OWNER]: "owner" }, [], ["web"]);
    db.set({ ...slackTeamOrgKey(TEAM_A), orgId: ORG_A });
    db.set({ ...slackTeamOrgKey(TEAM_B), orgId: ORG_B });
    const runtime = createTeamRecordRuntime({
      env: { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" }, documentClient: db, stateTableName: "State", now: () => clock.ms,
      ...(options.trackers === undefined ? {} : { trackers: options.trackers }),
    }) as TeamRecordRuntime;
    return { db, runtime };
  }
  const writeFor = (body: unknown, facts: Lookup | undefined): SourceWriteContext => ({
    orgRole: "owner", browserSession: true, body: () => body,
    ...(facts === undefined ? {} : { slackChannel: async () => (facts === "none" || facts === "unreadable" || facts === "throws" ? (facts === "none" ? "none" as const : undefined) : facts) }),
  });
  const send = (runtime: TeamRecordRuntime, body: unknown, facts?: Lookup) => runtime.routes({ method: "POST", path: PATH("web"), query: {}, caller: { orgId: ORG_A, developerId: OWNER, projectRole: "maintainer" }, write: writeFor(body, facts) });

  it("Slack: the State table's binding decides the workspace; the lookup comes with the request", async () => {
    const { runtime, db } = runtimeOf();
    expect(await send(runtime, add({ scope: slackScope(CH.pub, TEAM_B) }), { kind: "public", extShared: false })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await send(runtime, add(), undefined)).toMatchObject({ status: 503 });
    expect(await send(runtime, add(), { kind: "public", extShared: false })).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_SOURCE")).toHaveLength(1);
  });

  it("Linear and Jira: the connected trackers decide the place; without them (no connections on the install) a Jira add is refused", async () => {
    const h = harness();
    const { runtime } = runtimeOf({ trackers: trackersOf(h) });
    expect(await send(runtime, linearAdd())).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(await send(runtime, jiraAdd({ scope: "jira:project/NOPE" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    const bare = runtimeOf();
    expect(await send(bare.runtime, jiraAdd())).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(agentXError("CONFIG_INVALID", "x").code).toBe("CONFIG_INVALID");
  });
});

// ---- Task 9 (owner decision 2026-11-04): no second person for a source change, in either edition; and the Public edition's "notes with links" switch.
describe("T9: Slack and tracker sources apply at once", () => {
  const events = async (h: Harness, ...actions: string[]) => (await flushed(h)).filter((event) => actions.includes(event.action as string));
  const nothingWaits = async (h: Harness) => {
    expect(proposals(h)).toHaveLength(0);
    expect((await flushed(h)).map((event) => event.action as string)).not.toEqual(expect.arrayContaining(["record.source_change_proposed"]));
  };

  it("Enterprise: a private channel, a DM and a group DM are saved at once, with the row, the claim and widened: private_channel / dm / mpim", async () => {
    for (const [channel, word] of [[CH.priv, "private_channel"], [CH.dm, "dm"], [CH.mpim, "mpim"]] as const) {
      const h = harness();
      expect(await post(h, WHO.maint, add({ scope: slackScope(channel) })), channel).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
      expect(sourceRows(h), channel).toMatchObject([{ source: "slack", scope: slackScope(channel), addedBy: MAINT, revision: 1 }]);
      expect(claims(h)).toHaveLength(1);
      expect((await events(h, "record.source_added"))[0], channel).toMatchObject({ facts: { source: "slack", retention: "C", restricted: true, widened: word } });
      await nothingWaits(h);
    }
  });

  it("Enterprise: a private channel above the default says both words, retention first", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ scope: slackScope(CH.priv), retention: "D" }))).status).toBe(200);
    expect((await events(h, "record.source_added"))[0]).toMatchObject({ facts: { widened: "retention_raise,private_channel" } });
  });

  it("Enterprise: turning on a private channel's row, widening a DM row's audience, or raising its retention is saved at once and says what widened", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ scope: slackScope(CH.priv), enabled: false }))).status).toBe(200);
    expect(await post(h, WHO.maint, change(1, { scope: slackScope(CH.priv), enabled: true }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(await post(h, WHO.maint, change(2, { scope: slackScope(CH.priv), audienceDefault: "project" }))).toEqual({ status: 200, body: { status: "saved", revision: 3 } });
    expect(await post(h, WHO.maint, change(3, { scope: slackScope(CH.priv), retention: "D" }))).toEqual({ status: 200, body: { status: "saved", revision: 4 } });
    expect(sourceRows(h)[0]).toMatchObject({ enabled: true, audienceDefault: "project", retention: "D", revision: 4 });
    const changed = await events(h, "record.source_changed");
    expect(changed.map((event) => event.facts?.widened)).toEqual(["private_channel", "private_channel", "retention_raise"]);
    await nothingWaits(h);
  });

  it("Slack Connect stays refused in both editions, and a DM stays refused in Public (nothing written, no matter who asks)", async () => {
    for (const edition of ["enterprise", "public"] as const) {
      for (const channel of [CH.connect, CH.connectPrivate]) {
        const h = harness({ edition });
        expect(await post(h, WHO.owner, add({ scope: slackScope(channel), retention: edition === "public" ? "A" : "C" })), `${edition} ${channel}`).toEqual(NOT_ALLOWED(CONNECT_WORDS));
        nothingWritten(h);
      }
    }
    for (const channel of [CH.dm, CH.mpim]) {
      const h = harness({ edition: "public" });
      expect(await post(h, WHO.owner, add({ scope: slackScope(channel), retention: "A" })), channel).toEqual(NOT_ALLOWED(DM_WORDS));
      nothingWritten(h);
    }
    // A row that turned into Slack Connect since it was added is refused when it is turned on again.
    const h = harness();
    expect((await post(h, WHO.owner, add({ enabled: false }))).status).toBe(200);
    h.channels.set(CH.pub, { kind: "public", extShared: true });
    expect(await post(h, WHO.owner, change(1, { enabled: true }))).toEqual(NOT_ALLOWED(CONNECT_WORDS));
  });

  it("Public Slack retention: C and D are refused; B only with the notes opt-in; A is saved; a change to B needs the opt-in too", async () => {
    const h = harness({ edition: "public" });
    for (const retention of ["C", "D"]) expect(await post(h, WHO.owner, add({ retention })), retention).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.owner, add({ retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    nothingWritten(h);
    expect((await post(h, WHO.owner, add({ retention: "A" }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.owner, change(1, { retention: "C", notesOptIn: true }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "A", revision: 1 });
  });

  it("the notes switch: Public turns it on with retention B + notesOptIn true, and off with retention A + notesOptIn null, both at once; turning it on says retention_raise (A to B) and off says nothing", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.maint, add({ retention: "A" }))).status).toBe(200);
    expect(await post(h, WHO.maint, change(1, { retention: "B", notesOptIn: true }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "B", notesOptIn: true, revision: 2 });
    const view = await getView(h, WHO.maint);
    expect((view.body.sources as Array<Record<string, unknown>>)[0]).toMatchObject({ retention: "B", notesOptIn: true });
    expect(await post(h, WHO.maint, change(2, { retention: "A", notesOptIn: null }))).toEqual({ status: 200, body: { status: "saved", revision: 3 } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "A", revision: 3 });
    expect(sourceRows(h)[0]).not.toHaveProperty("notesOptIn");
    expect((await events(h, "record.source_changed")).map((event) => event.facts?.widened)).toEqual(["retention_raise", undefined]);
    await nothingWaits(h);
  });

  it("the notes switch on, with no ledger, is refused (it widens what is kept) and nothing moves; turning it off is not", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.maint, add({ retention: "A" }))).status).toBe(200);
    expect(await post(h, WHO.maint, change(1, { retention: "B", notesOptIn: true }), { context: { audit: {} } })).toMatchObject({ status: 503, body: { code: "AUDIT_UNAVAILABLE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "A", revision: 1 });
    expect((await post(h, WHO.maint, change(1, { retention: "B", notesOptIn: true }))).status).toBe(200);
    expect(await post(h, WHO.maint, change(2, { retention: "A", notesOptIn: null }), { context: { audit: {} } })).toEqual({ status: 200, body: { status: "saved", revision: 3 } });
  });

  it("B without the opt-in is never stored, whatever the body: retention B with notesOptIn null (or none, on a row without it) is refused and the row does not move (fix round 1)", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.owner, add({ retention: "B", notesOptIn: true }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { retention: "B", notesOptIn: null }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "B", notesOptIn: true, revision: 1 });
    // The final pair is what counts: a row at A with no opt-in cannot be sent to B without one, and B plus the opt-in stays fine.
    const a = harness({ edition: "public" });
    expect((await post(a, WHO.owner, add({ retention: "A" }))).status).toBe(200);
    expect(await post(a, WHO.owner, change(1, { retention: "B", notesOptIn: null }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(a, WHO.owner, change(1, { retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(a)[0]).toMatchObject({ retention: "A", revision: 1 });
    expect((await post(h, WHO.owner, change(1, { retention: "B", notesOptIn: true }))).status).toBe(200);
  });

  it("taking the opt-in away while the row stays at B is refused (B without the opt-in is never stored); the stored row does not move", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.owner, add({ retention: "B", notesOptIn: true }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { notesOptIn: null }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "B", notesOptIn: true, revision: 1 });
  });

  it("the admin view tells the screen to show the notes switch in Public, and never in Enterprise", async () => {
    const pub = harness({ edition: "public" });
    expect((await getView(pub, WHO.owner)).body).toMatchObject({ notesSwitch: true });
    const ent = harness();
    expect((await getView(ent, WHO.owner)).body).not.toHaveProperty("notesSwitch");
  });

  it("Linear and Jira apply at once in Enterprise even above the default, with widened: retention_raise", async () => {
    const h = harness();
    expect((await post(h, WHO.maint, linearAdd({ retention: "D" }))).status).toBe(200);
    expect((await post(h, WHO.maint, jiraAdd({ retention: "C" }))).status).toBe(200);
    expect((await events(h, "record.source_added")).map((event) => event.facts?.widened)).toEqual(["retention_raise", undefined]);
    await nothingWaits(h);
  });

  it("the old approve and reject bodies are CONFIG_INVALID here too", async () => {
    const h = harness();
    for (const action of ["approve", "reject"]) expect(await post(h, WHO.owner, { action, changeId: "x" }), action).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    nothingWritten(h);
  });
});

// ---- Task 10 (from the Task 9 review, Minor 2): a Slack row keeps the notes opt-in only while its saved retention is B.
describe("T10: the notes opt-in leaves the row whenever the saved retention is not B", () => {
  it("lowering a B row to A drops the opt-in, so a later retention B without an explicit opt-in is refused", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.owner, add({ retention: "B", notesOptIn: true }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { retention: "A" }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "A", revision: 2 });
    expect(sourceRows(h)[0]).not.toHaveProperty("notesOptIn");
    expect(await post(h, WHO.owner, change(2, { retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    // With the explicit opt-in it goes back to B.
    expect(await post(h, WHO.owner, change(2, { retention: "B", notesOptIn: true }))).toEqual({ status: 200, body: { status: "saved", revision: 3 } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "B", notesOptIn: true });
  });

  it("a hand-made add at A with the opt-in does not store it, so B on a later change still needs its own opt-in", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.owner, add({ retention: "A", notesOptIn: true }))).status).toBe(200);
    expect(sourceRows(h)[0]).not.toHaveProperty("notesOptIn");
    expect(await post(h, WHO.owner, change(1, { retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "A", revision: 1 });
  });

  it("a stale opt-in already on a row below B is removed by any change that saves the row (the row below B never carries it)", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.owner, add({ retention: "A" }))).status).toBe(200);
    h.w.db.set({ ...sourceRows(h)[0]!, notesOptIn: true });
    expect(await post(h, WHO.owner, change(1, { enabled: false }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)[0]).toMatchObject({ enabled: false, retention: "A" });
    expect(sourceRows(h)[0]).not.toHaveProperty("notesOptIn");
    expect(await post(h, WHO.owner, change(2, { retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
  });

  it("a B row keeps its opt-in through changes that do not touch retention", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.owner, add({ retention: "B", notesOptIn: true }))).status).toBe(200);
    expect((await post(h, WHO.owner, change(1, { enabled: false }))).status).toBe(200);
    expect(sourceRows(h)[0]).toMatchObject({ retention: "B", notesOptIn: true, enabled: false });
  });
});

describe("task 11 B: a pasted Slack link or ID is accepted, read again on the server", () => {
  const withTeam = { context: { slackTeamId: TEAM_A } } as const;
  const forms: Array<[string, string]> = [
    ["a bare channel ID", CH.pub],
    ["a workspace link", `https://acme.slack.com/archives/${CH.pub}`],
    ["a message link", `https://acme.slack.com/archives/${CH.pub}/p1700000000123456?thread_ts=1700000000.123456&cid=${CH.pub}`],
    ["an app link of the bound workspace", `https://app.slack.com/client/${TEAM_A}/${CH.pub}`],
    ["the full place", slackScope(CH.pub)],
  ];
  it.each(forms)("%s is saved as the exact place slack:<bound team>/<channel>, read live, and the row, claim and request hold that place", async (_name, scope) => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ scope }), withTeam)).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(h.reads).toEqual([`${TEAM_A}/${CH.pub}`]);
    expect(sourceRows(h).map((row) => row.scope)).toEqual([slackScope(CH.pub)]);
    expect(claims(h)).toHaveLength(1);
    // The same place again, in another form, is the same source (stale), not a second row.
    expect(await post(h, WHO.owner, add({ scope: slackScope(CH.pub) }), withTeam)).toMatchObject({ status: 409 });
  });

  it("a link for another Slack workspace answers one fixed sentence, writes nothing and never asks Slack", async () => {
    const h = harness();
    for (const scope of [`https://app.slack.com/client/${TEAM_OTHER}/${CH.pub}`, `https://app.slack.com/client/${TEAM_B}/${CH.pub}`, slackScope(CH.pub, TEAM_OTHER)]) {
      const reply = await post(h, WHO.owner, add({ scope }), withTeam);
      expect(reply, scope).toEqual(DIFFERENT_WORKSPACE);
      expect(JSON.stringify(reply.body)).not.toContain(TEAM_OTHER);
    }
    expect(h.reads).toEqual([]);
    nothingWritten(h);
  });

  it("an enterprise-id app link takes the install's workspace; junk is the plain missing-place answer; Slack is not asked about junk", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ scope: `https://app.slack.com/client/E0ENTERPR/${CH.pub}` }), withTeam)).status).toBe(200);
    expect(sourceRows(h).map((row) => row.scope)).toEqual([slackScope(CH.pub)]);
    const junk = harness();
    for (const scope of ["general", "#general", "https://evil.com/archives/C0PUBLIC1", `http://acme.slack.com/archives/${CH.pub}`, "https://acme.slack.com/team/U0123ABCD", `${CH.pub} ${CH.priv}`]) {
      expect(await post(junk, WHO.owner, add({ scope }), withTeam), scope).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID", message: "That place can't be used as a source for this project." } });
    }
    expect(junk.reads).toEqual([]);
    nothingWritten(junk);
  });

  it("a bare ID or workspace link needs the install's workspace: an install that does not know it fails closed with 503", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ scope: CH.pub }))).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    expect(h.reads).toEqual([]);
    nothingWritten(h);
  });

  it("another company's editor pasting the first company's workspace link gets the missing-place answer, as before, and Slack is not asked", async () => {
    const h = harness();
    expect(await post(h, WHO.otherMaint, add({ scope: `https://app.slack.com/client/${TEAM_A}/${CH.pub}` }), { org: ORG_B, context: { slackTeamId: TEAM_A } })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID", message: "That place can't be used as a source for this project." } });
    expect(h.reads).toEqual([]);
  });

  it("only a Slack add reads the form: a Linear scope or a repository is not rewritten", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ source: "linear", scope: CH.pub }), withTeam)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    nothingWritten(h);
  });

  it("a private channel pasted as a link is classified by the server, saved at once in Enterprise and audited as widening a private channel", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ scope: `https://acme.slack.com/archives/${CH.priv}` }), withTeam)).status).toBe(200);
    expect((await flushed(h)).find((event) => event.action === "record.source_added")?.facts).toMatchObject({ restricted: true, widened: "private_channel" });
  });

  it("the replay of a request answers the stored outcome whether the first body carried a link or the place", async () => {
    const h = harness();
    const requestId = randomUUID();
    const link = add({ requestId, scope: `https://acme.slack.com/archives/${CH.pub}` });
    expect(await post(h, WHO.owner, link, withTeam)).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(await post(h, WHO.owner, link, withTeam)).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(h)).toHaveLength(1);
    expect(h.reads).toHaveLength(1);
  });
});

describe("task 11 C: a channel Rovara is not in answers the fixed 'invite Rovara first' code", () => {
  it("whatever form it was typed in, a channel the bot cannot read (Slack: channel_not_found or not_in_channel, both are 'none') is SLACK_INVITE_NEEDED, never whether it exists, and nothing is written", async () => {
    const h = harness();
    for (const scope of [slackScope(CH.gone), CH.gone, `https://acme.slack.com/archives/${CH.gone}`, `https://app.slack.com/client/${TEAM_A}/${CH.gone}`]) {
      expect(await post(h, WHO.owner, add({ scope }), { context: { slackTeamId: TEAM_A } }), scope).toEqual(INVITE_NEEDED);
    }
    expect(JSON.stringify(INVITE_NEEDED)).not.toMatch(/exist|private|public/u);
    nothingWritten(h);
    // Positive control: a channel Slack can read is saved.
    expect((await post(h, WHO.owner, add())).status).toBe(200);
  });

  it("turning a Slack row on again for a channel that is gone from Slack's view is the same fixed answer (the row stays as it was)", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ enabled: false }))).status).toBe(200);
    h.channels.set(CH.pub, "none");
    expect(await post(h, WHO.owner, change(1, { enabled: true }))).toEqual(INVITE_NEEDED);
    expect(sourceRows(h)[0]!.enabled).toBe(false);
  });

  it("Slack being unreachable is still the plain 503, not the invite sentence", async () => {
    const h = harness();
    h.channels.set(CH.pub, "unreadable");
    expect(await post(h, WHO.owner, add())).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
  });
});

// Final review 3, I1: a private channel is added from the web only by a person who is in it (by one of their linked Slack ids, chosen by the server), as the Slack-side Add checks. Everyone else gets the one neutral answer.
describe("Slack: the editor must be in a private channel to add it from the web", () => {
  it("a member adds it (their linked id is asked, nobody else's), and a second linked id is tried when the first is not in", async () => {
    const h = harness();
    expect(await post(h, WHO.maint, add({ scope: slackScope(CH.priv) }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(h.memberAsks).toEqual([`U0MAINT001@${CH.priv}`]);
    const second = harness();
    second.linked.set(MAINT, ["U0ALTID001", "U0MAINT001"]);
    expect(await post(second, WHO.maint, add({ scope: slackScope(CH.priv) }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(second.memberAsks).toEqual([`U0ALTID001@${CH.priv}`, `U0MAINT001@${CH.priv}`]);
  });

  it("a non-member, an editor with no linked Slack id, a channel Rovara is not in and a channel that does not exist all get the identical reply, and nothing is written", async () => {
    const nonMember = harness();
    nonMember.members.set(CH.priv, new Set(["U0OWNER001"]));
    const unlinked = harness();
    unlinked.linked.delete(MAINT);
    const botNotIn = harness();
    botNotIn.channels.set("C0NOSUCH01", "none");
    const replies = [
      await post(nonMember, WHO.maint, add({ scope: slackScope(CH.priv) })),
      await post(unlinked, WHO.maint, add({ scope: slackScope(CH.priv) })),
      await post(botNotIn, WHO.maint, add({ scope: slackScope(CH.gone) })),
      await post(botNotIn, WHO.maint, add({ scope: slackScope("C0NOSUCH01") })),
    ];
    for (const reply of replies) expect(reply).toEqual(INVITE_NEEDED);
    nothingWritten(nonMember); nothingWritten(unlinked); nothingWritten(botNotIn);
    // an editor with no linked id is never asked about membership: there is nobody to ask for
    expect(unlinked.memberAsks).toEqual([]);
    expect(await flushed(nonMember)).toEqual([]);
  });

  it("existence is not told through the other refusals either: a private Slack Connect channel, a DM and a group DM answer a non-member with the same neutral reply, not 'not allowed'", async () => {
    const h = harness();
    for (const channel of [CH.connectPrivate, CH.dm, CH.mpim, CH.priv]) h.members.set(channel, new Set(["U0OWNER001"]));
    for (const channel of [CH.connectPrivate, CH.dm, CH.mpim]) expect(await post(h, WHO.maint, add({ scope: slackScope(channel) })), channel).toEqual(INVITE_NEEDED);
    // a member still gets the edition's own answer for each
    h.members.get(CH.connectPrivate)!.add("U0MAINT001");
    expect(await post(h, WHO.maint, add({ scope: slackScope(CH.connectPrivate) }))).toEqual(NOT_ALLOWED(CONNECT_WORDS));
    nothingWritten(h);
  });

  it("a membership that cannot be read fails closed as 'unavailable', and so does a missing way to read it or the sign-in store's links; nothing is written", async () => {
    for (const make of [
      (h: Harness) => { h.memberRead = "unreadable"; },
      (h: Harness) => { h.memberRead = "throws"; },
      (h: Harness) => { h.memberOn = false; },
      (h: Harness) => { h.linksOn = false; },
    ]) {
      const h = harness();
      make(h);
      expect(await post(h, WHO.maint, add({ scope: slackScope(CH.priv) }))).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
      nothingWritten(h);
    }
  });

  it("a public channel is not affected: an unlinked editor and a person in no channel add it, and membership is never asked", async () => {
    const h = harness();
    h.linked.clear(); h.members.clear();
    expect(await post(h, WHO.maint, add({ scope: slackScope(CH.pub) }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    const bare = harness({ edition: "public" });
    bare.memberOn = false; bare.linksOn = false;
    expect(await post(bare, WHO.owner, add({ scope: slackScope(CH.pub), retention: "A" }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(h.memberAsks).toEqual([]);
    // a public Slack Connect channel keeps its own answer
    expect(await post(h, WHO.maint, add({ scope: slackScope(CH.connect) }))).toEqual(NOT_ALLOWED(CONNECT_WORDS));
  });

  it("the Slack-side Add has already checked the presser in the channel itself: the route does not ask again for that actor", async () => {
    const h = harness();
    h.linked.clear();
    const reply = await post(h, WHO.maint, add({ scope: slackScope(CH.priv) }), { context: { browserSession: false, actor: "slack_interaction" } });
    expect(reply).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(h.memberAsks).toEqual([]);
  });

  it("the people asked are the editor's own links, never the request's: a body naming a Slack id changes nothing", async () => {
    const h = harness();
    h.members.set(CH.priv, new Set(["U0OWNER001"]));
    expect(await post(h, WHO.maint, add({ scope: slackScope(CH.priv), slackUserId: "U0OWNER001" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.maint, add({ scope: slackScope(CH.priv) }))).toEqual(INVITE_NEEDED);
    expect(h.memberAsks).toEqual([`U0MAINT001@${CH.priv}`]);
  });
});
