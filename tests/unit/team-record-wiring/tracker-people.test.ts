// Lane team-record-links: linking Linear and Jira people to their Rovara accounts.
//  1. AUTOMATIC: when a company's connected tool reports an email as verified, and it equals (case-insensitive, normalised) the verified sign-in email of a person in the SAME org, the tool user is linked.
//     Nobody else is: an unverified email, a hidden one, one that matches nobody, or one that matches a person of another org. They are listed as unmatched with their name and the tool's id, never an email.
//  2. BOUNDED AND REPEATABLE: pages, people and time are capped; a run that stopped resumes; a second run changes nothing; a tool the company has not connected is never read.
//  3. THE ADMIN'S MAPPING: list, map to a member of the same org (with an audit event), unmap (the link and future rows go; the automatic linker leaves them alone; the person's erase still takes their rows).
//  4. THE READERS: Linear and Jira's real readers (a fake fetch) treat their emails as unverified, skip bots and deactivated people, and call only their own addresses.
import { describe, expect, it, vi } from "vitest";
import { developerOrgKey, orgEmailKey, orgMetaKey, orgProjectCatalogKey, type OrgId } from "@agentx/contracts";
import { OrgConnectionStore, LINEAR_GRAPHQL } from "../../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../../packages/broker/src/connections/org-secrets.js";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { connectedTrackersOf } from "../../../packages/broker/src/team-record/tracker-connections.js";
import { jiraUsersReader, linearUsersReader, syncIsDue, syncTrackerUsers, SYNC_EVERY_MS, USERS_PER_PAGE, USERS_PER_RUN_MAX, type ConnectedTracker, type ConnectedTrackersPort, type TrackerUser } from "../../../packages/broker/src/team-record/tracker-directory.js";
import { putSourceConfig } from "../../../packages/broker/src/team-record/store.js";
import { ERASE_SWEEP_DELAY_MS } from "../../../packages/broker/src/team-record/erase.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../../support/fake-org-secrets.js";
import { ORG_A, ORG_B, T0 } from "../../support/team-record-core.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const VECTORS_ENV = { TEAM_RECORD_VECTORS_ROLE_ARN: "arn:aws:iam::123456789012:role/agentx/ent/vr", TEAM_RECORD_VECTOR_BUCKETS: "agentx-ent-record-vectors", AGENTX_ACCOUNT_ID: "123456789012" } as const;
const T = (extra: Partial<TrackerUser> & { sourceId: string }): TrackerUser => ({ displayName: extra.sourceId, emailVerified: false, ...extra });

/** A fake tool: `pages` are what it lists, `reads` counts what was asked of it. `verifies` is the tool's claim about every email it lists. */
function fakeTracker(input: { system: string; connectionId?: string; kind?: "linear" | "jira"; users: TrackerUser[]; pageSize?: number; reads?: { count: number; limits: number[] }; fail?: boolean }): ConnectedTracker {
  const size = input.pageSize ?? USERS_PER_PAGE;
  return {
    connectionId: input.connectionId ?? "con_aaaaaaaaaaaaaaaaaaaa", system: input.system, kind: input.kind ?? "linear",
    async readUsers({ after, limit }) {
      if (input.reads !== undefined) { input.reads.count += 1; input.reads.limits.push(limit); }
      if (input.fail === true) throw new Error("the tool is down");
      const start = after === undefined ? 0 : Number(after);
      const users = input.users.slice(start, start + size);
      return { users, ...(start + size < input.users.length ? { next: String(start + size) } : {}) };
    },
  };
}
const portOf = (trackers: ConnectedTracker[]): ConnectedTrackersPort => ({
  list: async (orgId) => (orgId === ORG_A ? trackers : []),
  get: async (orgId, connectionId) => (orgId === ORG_A ? trackers.find((tracker) => tracker.connectionId === connectionId) : undefined),
});

function worldOf(options: { trackers?: ConnectedTracker[]; audit?: boolean; vectors?: boolean } = {}) {
  const db = new FakeDynamoDb({ indexKeys });
  const events: Array<{ action: string; actor: { id: string }; target: { kind: string; id: string }; facts?: Record<string, unknown> }> = [];
  const clock = { at: T0 };
  db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A });
  db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  // Priya and Sam are members of company A; Olga is a member of company B. Verified sign-in emails (the pointer the company roster keeps).
  for (const [developerId, orgId, email] of [["dev-priya", ORG_A, "priya@acme.test"], ["dev-sam", ORG_A, "sam@acme.test"], ["dev-olga", ORG_B, "olga@other.test"]] as const) {
    db.set({ ...developerOrgKey(developerId), entityType: "DEVELOPER_ORG", orgId, role: "member" });
    db.set({ ...orgEmailKey(email), entityType: "ORG_EMAIL", developerId, orgId });
  }
  const aws = options.vectors === true ? vectorFakes() : undefined;
  const runtime = createTeamRecordRuntime({
    env: { ...(options.vectors === true ? VECTORS_ENV : {}), ...ON }, documentClient: db, stateTableName: "State", now: () => clock.at,
    ...(aws === undefined ? {} : { sdk: aws.sdk, sts: aws.sts }),
    ...(options.trackers === undefined ? {} : { trackers: portOf(options.trackers) }),
    ...(options.audit === false ? {} : { audit: async (event) => { events.push(event as never); } }),
  }) as TeamRecordRuntime;
  return { db, runtime, events, clock };
}

function vectorFakes() {
  const command = (name: string) => ({ [name]: class { constructor(readonly input: Record<string, unknown>) {} get commandName() { return name; } } });
  const sdk = async (name: string): Promise<Record<string, unknown>> => {
    if (name === "@aws-sdk/client-bedrock-runtime") return { BedrockRuntimeClient: class { async send() { return { body: Buffer.from(JSON.stringify({ embedding: Array.from({ length: 1024 }, () => 0.01) })) }; } }, ...command("InvokeModelCommand") };
    if (name === "@aws-sdk/client-s3vectors") return { S3VectorsClient: class { async send(c: { commandName: string }) { return c.commandName === "QueryVectorsCommand" || c.commandName === "GetVectorsCommand" ? { vectors: [] } : {}; } }, ...command("PutVectorsCommand"), ...command("QueryVectorsCommand"), ...command("GetVectorsCommand"), ...command("DeleteVectorsCommand"), ...command("CreateIndexCommand") };
    throw Object.assign(new Error("not available"), { name: "SdkUnavailableError" });
  };
  const sts = { async assumeRole() { return { credentials: { accessKeyId: "AKIA-1", secretAccessKey: "s", sessionToken: "t" }, expiresAtMs: T0 + 3_600_000 }; } };
  return { sdk, sts };
}

const linksOf = (db: FakeDynamoDb) => db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_LINK");
const unmatchedOf = (db: FakeDynamoDb) => db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_UNMATCHED");
const sync = (runtime: TeamRecordRuntime, connectionId = "con_aaaaaaaaaaaaaaaaaaaa") => runtime.trackerPeople.syncConnection(ORG_A, connectionId);

describe("automatic linking by a verified email", () => {
  const users = [
    T({ sourceId: "lin-priya", displayName: "Priya R", email: "  Priya@ACME.test ", emailVerified: true }),
    T({ sourceId: "lin-sam", displayName: "Sam K", email: "sam@acme.test", emailVerified: false }),
    T({ sourceId: "lin-hidden", displayName: "Hidden H", emailVerified: true }),
    T({ sourceId: "lin-nobody", displayName: "Nobody N", email: "nobody@acme.test", emailVerified: true }),
    T({ sourceId: "lin-olga", displayName: "Olga O", email: "olga@other.test", emailVerified: true }),
  ];

  it("links only a verified email that matches a person of the SAME org (case and spacing ignored); everyone else is listed unmatched with a name and a tool id", async () => {
    const { db, runtime } = worldOf({ trackers: [fakeTracker({ system: "linear", users })] });
    expect(await sync(runtime)).toMatchObject({ read: 5, linked: 1, unmatched: 4, complete: true });
    expect(linksOf(db).map((item) => [item.sk, item.developerId, item.via])).toStrictEqual([["TRLINK#linear#lin-priya", "dev-priya", "verified_email"]]);
    expect(unmatchedOf(db).map((item) => item.sourceId).sort()).toStrictEqual(["lin-hidden", "lin-nobody", "lin-olga", "lin-sam"]);
    // The unmatched list holds the name the tool showed and its id, and never an email.
    const everythingKept = JSON.stringify([...unmatchedOf(db), ...linksOf(db), ...db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_SYNC")]);
    for (const email of ["priya@", "sam@", "nobody@", "olga@", "acme.test", "other.test"]) expect(everythingKept.toLowerCase(), email).not.toContain(email);
    // Olga is a person of another company: not linked to anyone here.
    expect(linksOf(db).some((item) => item.developerId === "dev-olga")).toBe(false);
    const listed = await runtime.trackerPeople.list(ORG_A);
    expect(listed.unmatched.find((user) => user.sourceId === "lin-sam")).toMatchObject({ system: "linear", displayName: "Sam K" });
    expect(listed.linked.map((user) => [user.sourceId, user.developerId, user.via])).toStrictEqual([["lin-priya", "dev-priya", "verified_email"]]);
  });

  it("a tool that reports nothing as verified links nobody, even when the emails match exactly", async () => {
    const { db, runtime } = worldOf({ trackers: [fakeTracker({ system: "linear", users: users.map((user) => ({ ...user, emailVerified: false })) })] });
    expect(await sync(runtime)).toMatchObject({ linked: 0, unmatched: 5 });
    expect(linksOf(db)).toStrictEqual([]);
  });

  it("is repeatable: the second run changes nothing, and a person already linked is not linked again", async () => {
    const { db, runtime } = worldOf({ trackers: [fakeTracker({ system: "linear", users })] });
    await sync(runtime);
    const before = JSON.stringify(db.find(() => true).filter((item) => item.entityType !== "TEAM_RECORD_TRACKER_SYNC" && item.entityType !== "TEAM_RECORD_TRACKER_UNMATCHED").map((item) => [item.pk, item.sk, item.at, item.developerId]));
    const second = await sync(runtime);
    expect(second).toMatchObject({ read: 5, linked: 0, alreadyLinked: 1, unmatched: 4 });
    expect(JSON.stringify(db.find(() => true).filter((item) => item.entityType !== "TEAM_RECORD_TRACKER_SYNC" && item.entityType !== "TEAM_RECORD_TRACKER_UNMATCHED").map((item) => [item.pk, item.sk, item.at, item.developerId]))).toBe(before);
    expect(unmatchedOf(db)).toHaveLength(4);
  });

  it("a person the tool no longer lists leaves the unmatched list after a complete read; a person who gets linked leaves it at once", async () => {
    const list = [...users];
    const tracker = fakeTracker({ system: "linear", users: list });
    const { db, runtime, clock } = worldOf({ trackers: [tracker] });
    await sync(runtime);
    clock.at += 1_000;
    list.splice(list.findIndex((user) => user.sourceId === "lin-nobody"), 1);
    list[list.findIndex((user) => user.sourceId === "lin-sam")] = { ...list.find((user) => user.sourceId === "lin-sam")!, emailVerified: true };
    await sync(runtime);
    expect(unmatchedOf(db).map((item) => item.sourceId).sort()).toStrictEqual(["lin-hidden", "lin-olga"]);
    expect(linksOf(db).map((item) => item.developerId).sort()).toStrictEqual(["dev-priya", "dev-sam"]);
  });

  it("an erased person is not brought back: their tool user stays out of the lists and is not linked again", async () => {
    const { db, runtime, clock } = worldOf({ trackers: [fakeTracker({ system: "linear", users })], vectors: true });
    await sync(runtime);
    expect(linksOf(db)).toHaveLength(1);
    await runtime.erase.person(ORG_A, "dev-priya");
    await runtime.jobs.run("hourly");
    clock.at += ERASE_SWEEP_DELAY_MS + 1;
    await runtime.jobs.run("hourly");
    expect(linksOf(db)).toStrictEqual([]);
    await sync(runtime);
    expect(linksOf(db)).toStrictEqual([]);
    expect(unmatchedOf(db).map((item) => item.sourceId)).not.toContain("lin-priya");
    expect(JSON.stringify(db.find((item) => item.entityType === "TEAM_RECORD_TRACKER_UNMATCHED"))).not.toContain("Priya R");
  });

  it("never replaces an admin's mapping and never relinks a tool user an admin unmapped", async () => {
    const { db, runtime } = worldOf({ trackers: [fakeTracker({ system: "linear", users })] });
    await sync(runtime);
    // The admin maps Sam's tool user, then Priya's link is removed by the admin: the linker leaves both alone.
    expect(await runtime.trackerPeople.map(ORG_A, { system: "linear", sourceId: "lin-sam", developerId: "dev-sam", by: "dev-priya", requestId: "req-1" })).toBe("mapped");
    expect(await runtime.trackerPeople.unmap(ORG_A, { system: "linear", sourceId: "lin-priya", by: "dev-priya", requestId: "req-2" })).toBe("unmapped");
    await sync(runtime);
    expect(linksOf(db).map((item) => [item.sourceId ?? item.sk, item.via])).toStrictEqual([["TRLINK#linear#lin-sam", "admin"]]);
    expect(unmatchedOf(db).map((item) => item.sourceId)).toContain("lin-priya");
  });
});

describe("reads are bounded", () => {
  const many = (count: number): TrackerUser[] => Array.from({ length: count }, (_, i) => T({ sourceId: `lin-${String(i)}` }));

  it("a run that is out of time stops after its page, records a cursor, and is due again at once", async () => {
    const clock = { at: T0 };
    const db = new FakeDynamoDb({ indexKeys });
    db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A });
    const reads = { count: 0, limits: [] as number[] };
    const base = fakeTracker({ system: "linear", users: many(450), pageSize: 100, reads });
    const tracker: ConnectedTracker = { ...base, readUsers: async (page) => { clock.at += 600; return base.readUsers(page); } };
    const table = { documentClient: db, tableName: "TeamRecord" };
    const deps = { table, now: () => clock.at, linkByVerifiedEmail: async () => false };
    const first = await syncTrackerUsers(deps, ORG_A, tracker, { maxMs: 1_000 });
    expect(first).toMatchObject({ read: 200, complete: false });
    expect(reads.count).toBe(2);
    expect(await syncIsDue(table, ORG_A, tracker.connectionId, clock.at)).toBe(true);
    const second = await syncTrackerUsers(deps, ORG_A, tracker, { maxMs: 100_000 });
    expect(second).toMatchObject({ read: 250, complete: true });
    expect(reads.limits.every((limit) => limit === USERS_PER_PAGE)).toBe(true);
    expect(await syncIsDue(table, ORG_A, tracker.connectionId, clock.at)).toBe(false);
    expect(await syncIsDue(table, ORG_A, tracker.connectionId, clock.at + SYNC_EVERY_MS)).toBe(true);
  });

  it("never reads more people than the cap in one run", async () => {
    const reads = { count: 0, limits: [] as number[] };
    const { runtime } = worldOf({ trackers: [fakeTracker({ system: "linear", users: many(USERS_PER_RUN_MAX + 500), reads })] });
    const result = (await sync(runtime))!;
    expect(result.read).toBe(USERS_PER_RUN_MAX);
    expect(result.complete).toBe(false);
  });

  it("a tool that fails changes nothing and is tried again next time", async () => {
    const { db, runtime } = worldOf({ trackers: [fakeTracker({ system: "linear", users: many(3), fail: true })] });
    expect(await sync(runtime)).toMatchObject({ failed: true, complete: false, read: 0 });
    expect(linksOf(db)).toStrictEqual([]);
    expect(unmatchedOf(db)).toStrictEqual([]);
  });
});

describe("a tool the company has not connected is never read", () => {
  it("nothing is read for a connection the org does not have, for another org's connection, or when no tracker port is wired; the hourly job reads only connected, due tools", async () => {
    const reads = { count: 0, limits: [] as number[] };
    const tracker = fakeTracker({ system: "linear", users: [T({ sourceId: "lin-sam" })], reads });
    const { runtime, clock } = worldOf({ trackers: [tracker] });
    expect(await runtime.trackerPeople.syncConnection(ORG_A, "con_zzzzzzzzzzzzzzzzzzzz")).toBeUndefined();
    expect(await runtime.trackerPeople.syncConnection(ORG_B, "con_aaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
    expect(reads.count).toBe(0);
    // The hourly job: an org that never wrote is not in the directory; connecting puts it there.
    await runtime.jobs.run("hourly");
    expect(reads.count).toBe(0);
    await sync(runtime);
    expect(reads.count).toBe(1);
    await runtime.jobs.run("hourly");
    expect(reads.count).toBe(1);
    clock.at += SYNC_EVERY_MS + 1;
    const summary = await runtime.jobs.run("hourly");
    expect(reads.count).toBe(2);
    expect(summary.details.trackersSynced).toBe(1);
    const none = worldOf();
    expect(await none.runtime.trackerPeople.syncConnection(ORG_A, "con_aaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
    expect(none.db.find((item) => String(item.sk).startsWith("TR"))).toStrictEqual([]);
  });
});

describe("an org that connected its tools before it wrote anything", () => {
  it("is in the scheduled jobs' directory as soon as one of its changes is refused for want of a linked person, so the hourly read finds its people", async () => {
    const reads = { count: 0, limits: [] as number[] };
    const { db, runtime } = worldOf({ trackers: [fakeTracker({ system: "linear", users: [T({ sourceId: "lin-priya", email: "priya@acme.test", emailVerified: true })], reads })] });
    await putSourceConfig({ documentClient: db, tableName: "TeamRecord" }, { workspaceId: ORG_A, project: "web", source: "linear", scope: "linear:team/t1", enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-sam", updatedAt: "2026-10-30T10:00:00.000Z" }, { edition: "enterprise" });
    expect((await runtime.jobs.run("hourly")).orgs).toBe(0);
    await runtime.taps.hook({ orgId: ORG_A, hook: { source: "linear", project: "web", tenant: { organizationId: "lin-org", teamId: "t1" } }, body: { type: "Issue", action: "create", organizationId: "lin-org", actor: { id: "lin-priya" }, data: { id: "i1", teamId: "t1", title: "t", creatorId: "lin-priya", updatedAt: "2026-10-30T10:00:00.000Z" } } });
    expect(linksOf(db)).toStrictEqual([]);
    const summary = await runtime.jobs.run("hourly");
    expect(summary.orgs).toBe(1);
    expect(reads.count).toBe(1);
    expect(linksOf(db).map((item) => item.developerId)).toStrictEqual(["dev-priya"]);
  });
});

describe("the admin's mapping", () => {
  const priya = { system: "linear", sourceId: "lin-priya", by: "dev-sam" };
  const users = [T({ sourceId: "lin-priya", displayName: "Priya R" }), T({ sourceId: "lin-sam", displayName: "Sam K" })];
  const hook = { source: "linear" as const, project: "web", tenant: { organizationId: "lin-org", teamId: "t1" } };
  const issue = (action: "create" | "update", actor: string, at: string, title: string) => ({ type: "Issue", action, organizationId: "lin-org", actor: { id: actor }, ...(action === "update" ? { updatedFrom: { title: "old" } } : {}), data: { id: "lin42", teamId: "t1", title, creatorId: actor, updatedAt: at } });

  async function world() {
    const w = worldOf({ trackers: [fakeTracker({ system: "linear", users })], vectors: true });
    await putSourceConfig({ documentClient: w.db, tableName: "TeamRecord" }, { workspaceId: ORG_A, project: "web", source: "linear", scope: "linear:team/t1", enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-sam", updatedAt: "2026-10-30T10:00:00.000Z" }, { edition: "enterprise" });
    await sync(w.runtime);
    return w;
  }

  it("maps an unmatched tool user to a member of the same org, with an audit event; their changes are then stored under that person", async () => {
    const { db, runtime, events } = await world();
    await runtime.taps.hook({ orgId: ORG_A, hook, body: issue("create", "lin-priya", "2026-10-30T10:00:00.000Z", "before mapping") });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
    expect(await runtime.trackerPeople.map(ORG_A, { ...priya, developerId: "dev-priya", requestId: "req-1" })).toBe("mapped");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "record.tracker_person_mapped", actor: { id: "dev-sam" }, target: { kind: "member", id: "dev-priya" }, facts: { source: "linear" } });
    expect(JSON.stringify(events)).not.toContain("lin-priya");
    expect(JSON.stringify(events)).not.toContain("Priya R");
    expect(unmatchedOf(db).map((item) => item.sourceId)).toStrictEqual(["lin-sam"]);
    await runtime.taps.hook({ orgId: ORG_A, hook, body: issue("create", "lin-priya", "2026-10-30T10:01:00.000Z", "after mapping") });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT").map((row) => (row.actor as { developerId: string }).developerId)).toStrictEqual(["dev-priya"]);
    expect(await runtime.trackerPeople.list(ORG_A)).toMatchObject({ linked: [{ sourceId: "lin-priya", developerId: "dev-priya", via: "admin", displayName: "Priya R" }] });
  });

  it("refuses a person of another org, a tool user nobody listed, and a mapping the ledger could not record (nothing changes)", async () => {
    const { db, runtime, events } = await world();
    expect(await runtime.trackerPeople.map(ORG_A, { ...priya, developerId: "dev-olga", requestId: "req-1" })).toBe("not_member");
    expect(await runtime.trackerPeople.map(ORG_A, { system: "linear", sourceId: "lin-ghost", developerId: "dev-sam", by: "dev-sam", requestId: "req-2" })).toBe("not_found");
    expect(await runtime.trackerPeople.map(ORG_A, { system: "slack:T1", sourceId: "lin-priya", developerId: "dev-sam", by: "dev-sam", requestId: "req-3" })).toBe("not_found");
    expect(linksOf(db)).toStrictEqual([]);
    expect(events).toStrictEqual([]);
    const noLedger = worldOf({ trackers: [fakeTracker({ system: "linear", users })], audit: false });
    await sync(noLedger.runtime);
    expect(await noLedger.runtime.trackerPeople.map(ORG_A, { ...priya, developerId: "dev-priya", requestId: "req-4" })).toBe("audit_unavailable");
    expect(linksOf(noLedger.db)).toStrictEqual([]);
    const failing = worldOf({ trackers: [fakeTracker({ system: "linear", users })] });
    await sync(failing.runtime);
    const brokenRuntime = createTeamRecordRuntime({ env: ON, documentClient: failing.db, stateTableName: "State", now: () => T0, audit: async () => { throw new Error("ledger down"); } })!;
    expect(await brokenRuntime.trackerPeople.map(ORG_A, { ...priya, developerId: "dev-priya", requestId: "req-5" })).toBe("audit_unavailable");
    expect(linksOf(failing.db)).toStrictEqual([]);
  });

  it("unmapping removes the link with an audit event; future changes are not stored and are counted; rows already stored are still found by the person's erase", async () => {
    const { db, runtime, events, clock } = await world();
    await runtime.trackerPeople.map(ORG_A, { ...priya, developerId: "dev-priya", requestId: "req-1" });
    await runtime.taps.hook({ orgId: ORG_A, hook, body: issue("create", "lin-priya", "2026-10-30T10:00:00.000Z", "PRIYA-WORDS-QZ") });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toHaveLength(1);
    expect(await runtime.trackerPeople.unmap(ORG_A, { system: "linear", sourceId: "lin-priya", by: "dev-sam", requestId: "req-2" })).toBe("unmapped");
    expect(events.map((event) => [event.action, event.target.id])).toStrictEqual([["record.tracker_person_mapped", "dev-priya"], ["record.tracker_person_unmapped", "dev-priya"]]);
    expect(linksOf(db)).toStrictEqual([]);
    expect(unmatchedOf(db).map((item) => item.sourceId).sort()).toStrictEqual(["lin-priya", "lin-sam"]);
    expect(await runtime.trackerPeople.unmap(ORG_A, { system: "linear", sourceId: "lin-priya", by: "dev-sam", requestId: "req-3" })).toBe("not_found");
    await runtime.taps.hook({ orgId: ORG_A, hook, body: issue("update", "lin-priya", "2026-10-30T10:05:00.000Z", "AFTER-UNMAP-QZ") });
    expect(JSON.stringify(db.find(() => true))).not.toContain("AFTER-UNMAP-QZ");
    expect(db.find((item) => item.entityType === "TEAM_RECORD_SKIPPED").map((item) => item.skipped)).toStrictEqual([1]);
    // The automatic linker does not put them back (the mapping page is where it is decided).
    await sync(runtime);
    expect(linksOf(db)).toStrictEqual([]);
    // Erasing the person: their stored row goes (found by their developer id), and nothing of the tool user they were unmapped from is left either.
    await runtime.erase.person(ORG_A, "dev-priya");
    await runtime.jobs.run("hourly");
    clock.at += ERASE_SWEEP_DELAY_MS + 1;
    await runtime.jobs.run("hourly");
    expect(db.find((item) => item.entityType === "TEAM_RECORD_EVENT")).toStrictEqual([]);
    expect(JSON.stringify(db.find(() => true))).not.toContain("PRIYA-WORDS-QZ");
    expect(db.find((item) => JSON.stringify(item).includes("lin-priya")).map((item) => `${item.entityType as string}`)).toStrictEqual([]);
  });
});

describe("the real readers", () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("Linear: one POST per page to its fixed address with the key, bots and deactivated people left out, and every email unverified", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json({ data: { users: { nodes: [
        { id: "u1", name: "Priya R", displayName: "priya", email: "priya@acme.test", active: true, app: false },
        { id: "u2", name: "A Bot", displayName: "bot", email: "bot@acme.test", active: true, app: true },
        { id: "u3", name: "Gone G", displayName: "gone", email: "gone@acme.test", active: false, app: false },
        { id: "u4", name: "priya2@acme.test", displayName: "", email: null, active: true, app: false },
      ], pageInfo: { hasNextPage: true, endCursor: "c1" } } } });
    }) as unknown as typeof fetch;
    const page = await linearUsersReader({ fetch: fetcher, graphqlUrl: LINEAR_GRAPHQL, apiKey: "lin_api_test" })({ limit: 100 });
    expect(page.users.map((user) => [user.sourceId, user.emailVerified, user.email])).toStrictEqual([["u1", false, "priya@acme.test"], ["u4", false, undefined]]);
    expect(page.users[1]!.displayName).toBe("[email]");
    expect(page.next).toBe("c1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(LINEAR_GRAPHQL);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("lin_api_test");
    expect(calls[0]!.init.redirect).toBe("error");
    await expect(linearUsersReader({ fetch: async () => json({}, 401), graphqlUrl: LINEAR_GRAPHQL, apiKey: "k" })({ limit: 10 })).rejects.toThrow();
  });

  it("Jira: GET on the connection's own site with basic auth, real people only, a hidden email is none, every email unverified, and it pages by position", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const people = (count: number) => Array.from({ length: count }, (_, i) => ({ accountId: `acc-${String(i)}`, accountType: i === 1 ? "app" : "atlassian", active: i !== 2, displayName: `P${String(i)}`, ...(i === 0 ? { emailAddress: "p0@acme.test" } : {}) }));
    const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json(people(5)); }) as unknown as typeof fetch;
    const read = jiraUsersReader({ fetch: fetcher, siteUrl: "https://acme.atlassian.net", email: "svc@acme.test", apiToken: "tok" });
    const page = await read({ limit: 5 });
    expect(page.users.map((user) => [user.sourceId, user.email, user.emailVerified])).toStrictEqual([["acc-0", "p0@acme.test", false], ["acc-3", undefined, false], ["acc-4", undefined, false]]);
    expect(page.next).toBe("5");
    expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/users/search?startAt=0&maxResults=5");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("svc@acme.test:tok").toString("base64")}`);
    await read({ after: "5", limit: 5 });
    expect(calls[1]!.url).toContain("startAt=5");
    await expect(read({ after: "-1", limit: 5 })).rejects.toThrow();
  });
});

describe("a saved Linear or Jira connection is read once; the full path from the connection store", () => {
  it("saving a Linear connection with a key reads its users through the app's own connection and links the verified; a connection without a secret, or of another type, reads nothing", async () => {
    const fake = new FakeOrgSecrets({ env: "staging", now: () => T0 });
    const db = new FakeDynamoDb({ indexKeys });
    db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A });
    db.set({ ...developerOrgKey("dev-priya"), entityType: "DEVELOPER_ORG", orgId: ORG_A, role: "member" });
    db.set({ ...orgEmailKey("priya@acme.test"), entityType: "ORG_EMAIL", developerId: "dev-priya", orgId: ORG_A });
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => T0 });
    const deps = { documentClient: db, tableName: "State", env: "staging", secrets, now: () => T0 };
    const seen: Array<{ url: string; authorization: string }> = [];
    const fetcher = (async (url: string, init: RequestInit) => { seen.push({ url, authorization: (init.headers as Record<string, string>).authorization ?? "" }); return new Response(JSON.stringify({ data: { users: { nodes: [{ id: "u1", name: "Priya R", displayName: "Priya", email: "priya@acme.test", active: true, app: false }], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 }); }) as unknown as typeof fetch;
    const trackers = connectedTrackersOf({ deps, fetch: fetcher });
    const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => T0, trackers })!;
    const afterSave = vi.fn(async (saved: { orgId: OrgId; connectionId: string; type: string; hasSecret: boolean }) => {
      if ((saved.type === "linear" || saved.type === "jira") && saved.hasSecret) await runtime.trackerPeople.syncConnection(saved.orgId, saved.connectionId);
    });
    const store = new OrgConnectionStore({ ...deps, afterSave, checkEndpoint: async () => undefined });
    await store.put({ orgId: ORG_A, connection: { connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Linear", access: "read" }, by: "a".repeat(64) });
    expect(afterSave).toHaveBeenCalledWith({ orgId: ORG_A, connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", hasSecret: false });
    expect(seen).toStrictEqual([]);
    await store.put({ orgId: ORG_A, connection: { connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Linear", access: "read" }, secret: { apiKey: "lin_api_test_key" }, by: "a".repeat(64) });
    expect(seen).toStrictEqual([{ url: LINEAR_GRAPHQL, authorization: "lin_api_test_key" }]);
    // Linear reports no verification, so Priya is listed for the admin to map, not linked.
    expect(unmatchedOf(db).map((item) => item.sourceId)).toStrictEqual(["u1"]);
    expect(linksOf(db)).toStrictEqual([]);
    // A failing afterSave never fails the save.
    const failing = new OrgConnectionStore({ ...deps, afterSave: async () => { throw new Error("boom"); }, checkEndpoint: async () => undefined });
    await expect(failing.put({ orgId: ORG_A, connection: { connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Linear 2", access: "read" }, by: "a".repeat(64) })).resolves.toBeDefined();
    // The list offers only Linear and Jira connections that have a secret, of this org.
    expect((await trackers.list(ORG_A)).map((tracker) => [tracker.connectionId, tracker.system])).toStrictEqual([["con_aaaaaaaaaaaaaaaaaaaa", "linear"]]);
    expect(await trackers.list(ORG_B)).toStrictEqual([]);
    expect(await trackers.get(ORG_B, "con_aaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
  });
});
