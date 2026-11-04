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
import { readApproverRoster } from "../../../packages/broker/src/org/second-person-evidence.js";
import { secondPersonFromRecords } from "../../../packages/broker/src/org/test-environment.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../../support/audit-capture.js";
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
    ...(h.trackersOn ? { trackerPlace: trackerPlaceCheck(trackersOf(h), { now: () => h.w.clock.ms }) } : {}),
  },
});

function contextOf(h: Harness, who: Who, body: unknown, over: Partial<SourceWriteContext> = {}): SourceWriteContext {
  const evidence = { documentClient: h.w.db, tableName: AUDIT_CAPTURE_TABLE, signInTableName: "signin", now: () => h.w.clock.ms };
  return {
    orgRole: who.orgRole, browserSession: true, body: () => body, audit: h.audit.deps,
    secondPerson: secondPersonFromRecords({ ...evidence, soleOwnerTable: h.w.table }),
    roster: (scope) => readApproverRoster(evidence, scope),
    freshSignIn: async () => undefined,
    ...(h.lookupOn ? {
      slackChannel: async (teamId: string, channelId: string) => {
        h.reads.push(`${teamId}/${channelId}`);
        const answer = h.channels.get(channelId);
        if (answer === "throws") throw new Error("slack went away");
        return answer === undefined || answer === "unreadable" ? undefined : answer;
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
const proposals = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_CHANGE");
const claims = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_SCOPE");
const requests = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_REQUEST");
const nothingWritten = (h: Harness) => { expect(sourceRows(h)).toHaveLength(0); expect(proposals(h)).toHaveLength(0); expect(claims(h)).toHaveLength(0); expect(requests(h)).toHaveLength(0); };
const flushed = async (h: Harness) => { await new Promise((resolve) => setTimeout(resolve, 0)); return h.audit.recorded(); };
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

  it("a private channel in Public is saved at once (explicit add, no second person); in Enterprise it waits for a second person with the reason private_channel", async () => {
    const pub = harness({ edition: "public" });
    expect(await post(pub, WHO.owner, add({ scope: slackScope(CH.priv), retention: "A" }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(pub)).toHaveLength(1);
    expect(proposals(pub)).toHaveLength(0);

    const ent = harness();
    const reply = await post(ent, WHO.owner, add({ scope: slackScope(CH.priv), retention: "C" }));
    expect(reply).toMatchObject({ status: 202, body: { status: "needs_approval" } });
    expect(sourceRows(ent)).toHaveLength(0);
    expect(claims(ent)).toHaveLength(0);
    expect(proposals(ent)).toMatchObject([{ kind: "add", source: "slack", scope: slackScope(CH.priv), reasons: ["private_channel"], proposedBy: OWNER }]);
    expect((await flushed(ent)).map((event) => event.action)).toContain("record.source_change_proposed");
  });

  it("a DM and a group DM: refused in Public (SOURCE_NOT_ALLOWED, nothing written); in Enterprise they wait with the reasons dm and mpim", async () => {
    for (const channel of [CH.dm, CH.mpim]) {
      const pub = harness({ edition: "public" });
      expect(await post(pub, WHO.owner, add({ scope: slackScope(channel), retention: "A" })), channel).toEqual(NOT_ALLOWED(DM_WORDS));
      nothingWritten(pub);
    }
    for (const [channel, reason] of [[CH.dm, "dm"], [CH.mpim, "mpim"]] as const) {
      const ent = harness();
      expect(await post(ent, WHO.owner, add({ scope: slackScope(channel) })), channel).toMatchObject({ status: 202 });
      expect(proposals(ent)).toMatchObject([{ reasons: [reason] }]);
      expect(sourceRows(ent)).toHaveLength(0);
    }
  });

  it("a Slack Connect channel (public or private) is refused in both editions, and nothing is written", async () => {
    for (const edition of ["enterprise", "public"] as const) {
      for (const channel of [CH.connect, CH.connectPrivate]) {
        const h = harness({ edition });
        expect(await post(h, WHO.owner, add({ scope: slackScope(channel), retention: "A" })), `${edition} ${channel}`).toEqual(NOT_ALLOWED(CONNECT_WORDS));
        nothingWritten(h);
      }
    }
  });

  it("the reasons come from what the server read, in the order of the design, and never from the body: a body that names reasons or a kind is refused as invalid", async () => {
    const h = harness();
    const both = await post(h, WHO.owner, add({ scope: slackScope(CH.priv), retention: "D" }));
    expect(both.status).toBe(202);
    expect(proposals(h)).toMatchObject([{ reasons: ["private_channel", "retention_raise"] }]);
    for (const extra of [{ reasons: [] }, { kind: "public" }, { channelKind: "public_channel" }]) {
      const reply = await post(h, WHO.owner, add({ scope: slackScope(CH.priv), ...extra }));
      expect(reply, JSON.stringify(extra)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    }
    // The admin view shows the stored reasons, not anything a client sent.
    const view = await getView(h, WHO.owner);
    expect(view.body.pending).toMatchObject([{ source: "slack", scope: slackScope(CH.priv), kind: "add", reasons: ["private_channel", "retention_raise"] }]);
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

  it("a channel Slack does not know is refused as a missing place; one that cannot be read fails closed with 503 and writes nothing", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ scope: slackScope(CH.gone) }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
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

  it("approval reads the channel again: a second person approves a private channel; a channel that turned into Slack Connect meanwhile is refused and stays waiting", async () => {
    const h = harness();
    const proposed = await post(h, WHO.maint, add({ scope: slackScope(CH.priv) }));
    expect(proposed.status).toBe(202);
    const changeId = proposed.body.changeId as string;
    h.channels.set(CH.priv, { kind: "private", extShared: true });
    expect(await post(h, WHO.owner, { action: "approve", changeId })).toEqual(NOT_ALLOWED(CONNECT_WORDS));
    expect(sourceRows(h)).toHaveLength(0);
    expect(proposals(h)).toHaveLength(1);
    h.channels.set(CH.priv, "unreadable");
    expect(await post(h, WHO.owner, { action: "approve", changeId })).toMatchObject({ status: 503 });
    expect(proposals(h)).toHaveLength(1);
    h.channels.set(CH.priv, { kind: "private", extShared: false });
    expect(await post(h, WHO.owner, { action: "approve", changeId })).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(h)).toMatchObject([{ source: "slack", scope: slackScope(CH.priv) }]);
    expect((await flushed(h)).find((event) => event.action === "record.source_added")).toMatchObject({ facts: { restricted: true } });
  });

  it("a channel that became a DM-like place needing more care than the waiting change says is not applied (the change is made again)", async () => {
    const h = harness();
    const proposed = await post(h, WHO.maint, add({ scope: slackScope(CH.pub), retention: "D" }));
    expect(proposed.body.status).toBe("needs_approval");
    expect(proposals(h)).toMatchObject([{ reasons: ["retention_raise"] }]);
    h.channels.set(CH.pub, { kind: "private", extShared: false });
    expect(await post(h, WHO.owner, { action: "approve", changeId: proposed.body.changeId })).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)).toHaveLength(0);
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

  it("a retention raise in Enterprise still waits for a second person, with the reason retention_raise only (the channel was approved when it was added)", async () => {
    const h = harness();
    await saved(h, { retention: "C" });
    expect(await post(h, WHO.owner, change(1, { retention: "D" }))).toMatchObject({ status: 202 });
    expect(proposals(h)).toMatchObject([{ kind: "change", reasons: ["retention_raise"] }]);
  });
});

describe("Slack: a change that turns a row on or widens it brings the reasons of the channel's class now (fix round 1)", () => {
  const CLASSES = [[CH.priv, "private_channel"], [CH.dm, "dm"], [CH.mpim, "mpim"]] as const;
  /** A row for a channel of this class in Enterprise, added and approved by a second person. */
  async function approvedRow(h: Harness, channel: string, over: Record<string, unknown> = {}) {
    const proposed = await post(h, WHO.maint, add({ scope: slackScope(channel), ...over }));
    expect(proposed.status).toBe(202);
    expect(await post(h, WHO.owner, { action: "approve", changeId: proposed.body.changeId })).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
  }

  it("a public row whose channel became private: widening the audience, or turning it on, waits for a second person with private_channel", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add())).status).toBe(200);
    h.channels.set(CH.pub, { kind: "private", extShared: false });
    expect(await post(h, WHO.owner, change(1, { audienceDefault: "project" }))).toMatchObject({ status: 202, body: { status: "needs_approval" } });
    expect(proposals(h)).toMatchObject([{ kind: "change", reasons: ["private_channel"] }]);
    expect(sourceRows(h)).toMatchObject([{ audienceDefault: "maintainers", revision: 1 }]);

    const off = harness();
    expect((await post(off, WHO.owner, add({ enabled: false }))).status).toBe(200);
    off.channels.set(CH.pub, { kind: "mpim", extShared: false });
    expect(await post(off, WHO.owner, change(1, { enabled: true, retention: "D" }))).toMatchObject({ status: 202 });
    expect(proposals(off)).toMatchObject([{ reasons: ["mpim", "retention_raise"] }]);
    expect(sourceRows(off)).toMatchObject([{ enabled: false, revision: 1 }]);
  });

  it("a private, DM or group DM row turned off and back on waits for a second person; turning it off, or narrowing it, stays immediate and never asks Slack", async () => {
    for (const [channel, reason] of CLASSES) {
      const h = harness();
      await approvedRow(h, channel, { audienceDefault: "project" });
      const reads = h.reads.length;
      expect(await post(h, WHO.owner, change(1, { scope: slackScope(channel), enabled: false })), channel).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
      expect(await post(h, WHO.owner, change(2, { scope: slackScope(channel), audienceDefault: "maintainers" })), channel).toEqual({ status: 200, body: { status: "saved", revision: 3 } });
      expect(h.reads).toHaveLength(reads);
      expect(await post(h, WHO.owner, change(3, { scope: slackScope(channel), enabled: true })), channel).toMatchObject({ status: 202 });
      expect(proposals(h), channel).toMatchObject([{ kind: "change", reasons: [reason] }]);
      expect(sourceRows(h), channel).toMatchObject([{ enabled: false, revision: 3 }]);
      // The second person applies it, and the row is on.
      expect(await post(h, WHO.admin, { action: "approve", changeId: proposals(h)[0]!.id })).toEqual({ status: 200, body: { status: "saved", revision: 4 } });
      expect(sourceRows(h), channel).toMatchObject([{ enabled: true, revision: 4 }]);
    }
  });

  it("a retention raise alone on an approved private row still waits only for retention_raise, and Public needs no second person to turn a private row on", async () => {
    const h = harness();
    await approvedRow(h, CH.priv);
    expect(await post(h, WHO.owner, change(1, { scope: slackScope(CH.priv), retention: "D" }))).toMatchObject({ status: 202 });
    expect(proposals(h)).toMatchObject([{ reasons: ["retention_raise"] }]);
    const pub = harness({ edition: "public" });
    expect((await post(pub, WHO.owner, add({ scope: slackScope(CH.priv), retention: "A", enabled: false }))).status).toBe(200);
    expect(await post(pub, WHO.owner, change(1, { scope: slackScope(CH.priv), enabled: true }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
  });

  it("approving a change reads the channel again: Slack Connect is refused, an unreadable channel is 503, nothing is applied and the change stays; a class that now needs more care is made again", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add())).status).toBe(200);
    h.channels.set(CH.pub, { kind: "private", extShared: false });
    const waiting = await post(h, WHO.maint, change(1, { audienceDefault: "project" }));
    const changeId = waiting.body.changeId as string;
    h.channels.set(CH.pub, { kind: "private", extShared: true });
    expect(await post(h, WHO.owner, { action: "approve", changeId })).toEqual(NOT_ALLOWED(CONNECT_WORDS));
    h.channels.set(CH.pub, "unreadable");
    expect(await post(h, WHO.owner, { action: "approve", changeId })).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    h.channels.set(CH.pub, "throws");
    expect(await post(h, WHO.owner, { action: "approve", changeId })).toMatchObject({ status: 503 });
    expect(proposals(h)).toHaveLength(1);
    expect(sourceRows(h)).toMatchObject([{ audienceDefault: "maintainers", revision: 1 }]);
    h.channels.set(CH.pub, { kind: "private", extShared: false });
    expect(await post(h, WHO.owner, { action: "approve", changeId })).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)).toMatchObject([{ audienceDefault: "project", revision: 2 }]);

    // A change waiting only for retention_raise, on a row that is turned on, whose channel became private: made again.
    const drift = harness();
    expect((await post(drift, WHO.owner, add({ enabled: false }))).status).toBe(200);
    const only = await post(drift, WHO.maint, change(1, { enabled: true, retention: "D" }));
    expect(proposals(drift)).toMatchObject([{ reasons: ["retention_raise"] }]);
    drift.channels.set(CH.pub, { kind: "private", extShared: false });
    expect(await post(drift, WHO.owner, { action: "approve", changeId: only.body.changeId })).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(drift)).toMatchObject([{ enabled: false, revision: 1 }]);
  });

  it("approving a retention raise on a row that stays as it is reads the channel (Connect refuses) but a private class alone does not make it stale", async () => {
    const h = harness();
    await approvedRow(h, CH.priv);
    const raise = await post(h, WHO.maint, change(1, { scope: slackScope(CH.priv), retention: "D" }));
    expect(raise.status).toBe(202);
    h.channels.set(CH.priv, { kind: "private", extShared: true });
    expect(await post(h, WHO.owner, { action: "approve", changeId: raise.body.changeId })).toEqual(NOT_ALLOWED(CONNECT_WORDS));
    h.channels.set(CH.priv, { kind: "private", extShared: false });
    expect(await post(h, WHO.owner, { action: "approve", changeId: raise.body.changeId })).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
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

  it("a place two projects want goes to the first; a Linear Enterprise raise above the default waits for a second person with retention_raise", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, linearAdd())).status).toBe(200);
    expect(await post(h, WHO.owner, linearAdd(), { project: "api" })).toMatchObject({ status: 400, body: { message: "That place is already used by another project." } });
    expect(await post(h, WHO.owner, jiraAdd({ retention: "D" }))).toMatchObject({ status: 202 });
    expect(proposals(h)).toMatchObject([{ source: "jira", reasons: ["retention_raise"] }]);
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
    orgRole: "owner", browserSession: true, body: () => body, freshSignIn: async () => undefined,
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
