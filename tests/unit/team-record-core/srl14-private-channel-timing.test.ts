// SRL-14 (owner decision 24b): adding a Slack channel as a source from the web must not tell an editor, by the ANSWER or by the RESPONSE TIME, whether a private channel exists or whether Rovara is in it.
// The cases the caller may not learn about: (A) no such channel, (B) a private channel Rovara is not in, (C) a private channel Rovara is in that the editor is not in, (C') the same with a membership read that
// cannot be read or throws. All four must make the same Slack/table calls in the same order, answer with the identical reply, and take the same time (a fixed floor, driven here by an injected clock and sleep).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, slackTeamOrgKey } from "@agentx/contracts";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import { SLACK_REFUSAL_FLOOR_MS, type SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import type { SlackFacts } from "../../../packages/broker/src/team-record/source-places.js";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, caller, world, type World } from "../../support/team-record-core.js";

const MAINT = "c".repeat(64);
const AT = "2026-10-01T00:00:00.000Z";
const TEAM = "T0AAAAAAA";
const CH = { gone: "C0GONE0001", privBotOut: "C0PRIVOUT1", privBotIn: "C0PRIVIN01", pub: "C0PUBLIC01", archived: "C0ARCHIVE1" } as const;
const FLOOR = SLACK_REFUSAL_FLOOR_MS;

const INVITE_NEEDED = { status: 422, body: { code: "SLACK_INVITE_NEEDED", message: "Rovara isn't in that channel yet. Type /invite @Rovara in the channel, then try again. You must be in the channel yourself, with your Slack account linked to Rovara." } };
const NOT_LINKED = { status: 422, body: { code: "SLACK_NOT_LINKED", message: "Link your Slack account to Rovara so it can check you're in that channel, then try again." } };
const UNAVAILABLE = { status: 503, body: { code: "RUNTIME_UNAVAILABLE" } };

/** Slack's answer for a channel as the bot sees it, and how long each call takes (in fake milliseconds). */
interface Slack { facts: SlackFacts | "none"; members: string[]; classMs: number; memberMs: number; memberRead?: "ok" | "unreadable" | "throws" }
interface H {
  w: World; audit: ReturnType<typeof capturingAuditDeps>;
  slack: Map<string, Slack>; linked: string[]; calls: string[]; sleeps: number[];
  ports: { links: boolean; member: boolean; channel: boolean; floor: boolean };
}

function seed(db: FakeDynamoDb): void {
  db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A, entityType: "ORG", createdAt: AT, approvalMembershipVersion: 3, approvalTrackingSince: AT });
  db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: AT, archiveRevision: 0 });
  db.set({ ...orgMemberKey(ORG_A, MAINT), orgId: ORG_A, developerId: MAINT, role: "member", joinedAt: AT });
  db.set({ ...developerOrgKey(MAINT), orgId: ORG_A, role: "member" });
  db.set({ pk: `DEVELOPER#${MAINT}`, sk: "META", developerId: MAINT, revoked: false });
  db.set({ ...projectMemberKey(ORG_A, MAINT, "web"), ownerKey: MAINT, projectName: "web", role: "developer", projectRole: "maintainer", grantId: "grant-cccc" });
}

function harness(): H {
  const w = world();
  seed(w.db);
  const slack = new Map<string, Slack>([
    [CH.gone, { facts: "none", members: [], classMs: 90, memberMs: 40 }],
    [CH.privBotOut, { facts: "none", members: [], classMs: 100, memberMs: 45 }],
    [CH.privBotIn, { facts: { kind: "private", extShared: false }, members: ["U0OTHER001"], classMs: 140, memberMs: 900 }],
    [CH.archived, { facts: { kind: "private", extShared: false }, members: ["U0OTHER001"], classMs: 140, memberMs: 300 }],
    [CH.pub, { facts: { kind: "public", extShared: false }, members: [], classMs: 120, memberMs: 0 }],
  ]);
  return { w, audit: capturingAuditDeps({ db: w.db, now: () => w.clock.ms }), slack, linked: ["U0ALTID001", "U0MAINT001"], calls: [], sleeps: [], ports: { links: true, member: true, channel: true, floor: true } };
}

const dependencies = (h: H) => ({
  table: h.w.table, modes: h.w.deps.modes, now: () => h.w.clock.ms,
  sources: {
    edition: h.w.deps.edition,
    projectRepositories: async () => [] as number[],
    pausedSources: async () => [] as string[],
    slackTeamBound: async () => true,
    ...(h.ports.links ? { slackUserIdsOf: async () => { h.calls.push("links"); return h.linked; } } : {}),
    ...(h.ports.floor ? { refusalFloor: { ms: FLOOR, sleep: async (ms: number) => { h.sleeps.push(ms); h.w.clock.ms += ms; } } } : {}),
  },
});

function contextOf(h: H, body: unknown): SourceWriteContext {
  return {
    orgRole: "member", browserSession: true, body: () => body, audit: h.audit.deps,
    ...(h.ports.channel ? {
      slackChannel: async (_team: string, channelId: string) => {
        h.calls.push(`class:${channelId}`);
        const s = h.slack.get(channelId);
        h.w.clock.ms += s?.classMs ?? 100;
        return s?.facts ?? "none";
      },
    } : {}),
    ...(h.ports.member ? {
      slackMember: async (userId: string, channelId: string) => {
        h.calls.push(`member:${userId}@${channelId}`);
        const s = h.slack.get(channelId);
        h.w.clock.ms += s?.memberMs ?? 40;
        if (s?.memberRead === "throws") throw new Error("slack went away");
        if (s === undefined || s.facts === "none" || s.memberRead === "unreadable") return undefined; // Slack cannot show the bot this channel's members
        return s.members.includes(userId);
      },
    } : {}),
  };
}

const slackScope = (channel: string) => `slack:${TEAM}/${channel}`;
const add = (channel: string) => ({ action: "add", requestId: randomUUID(), source: "slack", scope: slackScope(channel), retention: "C", audienceDefault: "maintainers", enabled: true });
type Reply = { status: number; body: Record<string, unknown> };
async function post(h: H, channel: string): Promise<Reply> {
  return await handleRecordRoute(dependencies(h), {
    method: "POST", path: "/v1/app/projects/web/record/sources", query: {}, caller: caller({ orgId: ORG_A, developerId: MAINT, projectRole: "maintainer" }), write: contextOf(h, add(channel)),
  }) as Reply;
}
/** One attempt on a fresh harness: the reply, the calls made, the sleeps asked for and the (fake) time the whole call took. */
async function attempt(channel: string, tweak: (h: H) => void = () => undefined) {
  const h = harness();
  tweak(h);
  const started = h.w.clock.ms;
  const reply = await post(h, channel);
  return { h, reply, calls: h.calls.map((call) => call.replace(channel, "<channel>")), sleeps: h.sleeps, elapsed: h.w.clock.ms - started };
}
const rows = (h: H) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE");

const REFUSED_CASES: Array<[string, string, (h: H) => void]> = [
  ["A: no such channel", CH.gone, () => undefined],
  ["B: private channel, Rovara not in it", CH.privBotOut, () => undefined],
  ["C: private channel, Rovara in it, the editor is not", CH.privBotIn, () => undefined],
  ["C-archived: an archived private channel Rovara is still in, the editor is not", CH.archived, () => undefined],
  ["C': as C, the membership read cannot be read", CH.privBotIn, (h) => { h.slack.get(CH.privBotIn)!.memberRead = "unreadable"; }],
  ["C'': as C, the membership read throws", CH.privBotIn, (h) => { h.slack.get(CH.privBotIn)!.memberRead = "throws"; }],
];

describe("SRL-14: the refusal for a channel the editor is not proven in is the same in every case", () => {
  it("answers the identical reply (status, code and sentence), byte for byte, whatever the channel is, and writes nothing", async () => {
    const serialised = new Set<string>();
    for (const [name, channel, tweak] of REFUSED_CASES) {
      const { h, reply } = await attempt(channel, tweak);
      expect(reply, name).toEqual(INVITE_NEEDED);
      serialised.add(JSON.stringify(reply));
      expect(rows(h), name).toHaveLength(0);
    }
    expect(serialised.size).toBe(1);
  });

  it("an editor with no linked Slack id gets the identical SLACK_NOT_LINKED in every case, with no membership read", async () => {
    const serialised = new Set<string>();
    for (const [name, channel, tweak] of REFUSED_CASES) {
      const { reply, calls } = await attempt(channel, (h) => { tweak(h); h.linked = []; });
      expect(reply, name).toEqual(NOT_LINKED);
      serialised.add(JSON.stringify(reply));
      expect(calls.some((call) => call.startsWith("member:")), name).toBe(false);
    }
    expect(serialised.size).toBe(1);
  });

  it("makes the same Slack and table calls in the same order in every case: one class read, the editor's links, then one membership read per linked id on the channel asked about", async () => {
    const seen = new Set<string>();
    for (const [name, channel, tweak] of REFUSED_CASES) {
      const { calls } = await attempt(channel, tweak);
      expect(calls, name).toEqual(["class:<channel>", "links", "member:U0ALTID001@<channel>", "member:U0MAINT001@<channel>"]);
      seen.add(JSON.stringify(calls));
    }
    expect(seen.size).toBe(1);
  });

  it("takes exactly the floor in every case, however long Slack took for each, and sleeps only the rest of it", async () => {
    const results = [];
    for (const [name, channel, tweak] of REFUSED_CASES) {
      const r = await attempt(channel, tweak);
      results.push(r);
      expect(r.elapsed, name).toBe(FLOOR);
      expect(r.sleeps, name).toHaveLength(1);
    }
    // The cases really did differ in Slack time (so the equal total is the floor's doing): A/B are fast, C is slow.
    const slackTime = results.map((r) => FLOOR - r.sleeps[0]!);
    expect(new Set(slackTime).size).toBeGreaterThan(1);
    expect(Math.min(...slackTime)).toBeLessThan(Math.max(...slackTime));
    // A refusal for an editor with no linked id is held to the same floor.
    for (const [name, channel, tweak] of REFUSED_CASES) {
      const r = await attempt(channel, (h) => { tweak(h); h.linked = []; });
      expect(r.elapsed, name).toBe(FLOOR);
    }
  });

  it("a Slack that is already slower than the floor is not slowed further (no sleep)", async () => {
    const r = await attempt(CH.privBotIn, (h) => { h.slack.get(CH.privBotIn)!.memberMs = FLOOR; });
    expect(r.reply).toEqual(INVITE_NEEDED);
    expect(r.sleeps).toEqual([]);
    expect(r.elapsed).toBeGreaterThan(FLOOR);
  });

  it("a channel that cannot be shown to the editor's linked ids stays the same when the member port or the links are missing: the same 503 for every case, and no floor", async () => {
    for (const [name, channel, tweak] of REFUSED_CASES) {
      for (const off of ["member", "links"] as const) {
        const r = await attempt(channel, (h) => { tweak(h); h.ports[off] = false; });
        expect(r.reply, `${name} / ${off} off`).toMatchObject(UNAVAILABLE);
      }
    }
  });

  it("Slack's own class read failing is the same plain 503 for every channel (nothing channel specific), and is not padded", async () => {
    const r = await attempt(CH.privBotIn, (h) => { h.ports.channel = false; });
    expect(r.reply).toMatchObject(UNAVAILABLE);
    expect(r.sleeps).toEqual([]);
  });
});

describe("SRL-14: the legitimate paths are not slowed", () => {
  it("an editor who is in the private channel adds it: the reads stop at the first linked id that is in, and there is no floor", async () => {
    const r = await attempt(CH.privBotIn, (h) => { h.slack.get(CH.privBotIn)!.members = ["U0ALTID001"]; });
    expect(r.reply).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(r.calls).toEqual(["class:<channel>", "links", "member:U0ALTID001@<channel>"]);
    expect(r.sleeps).toEqual([]);
    expect(r.elapsed).toBe(140 + 900);
  });

  it("a public channel is added with one class read, no links, no membership read, no floor", async () => {
    const r = await attempt(CH.pub);
    expect(r.reply).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(r.calls).toEqual(["class:<channel>"]);
    expect(r.sleeps).toEqual([]);
  });

  it("the Slack-side Add button (the presser was already checked in the channel) reads nothing about membership and is not padded", async () => {
    const h = harness();
    const reply = await handleRecordRoute(dependencies(h), {
      method: "POST", path: "/v1/app/projects/web/record/sources", query: {}, caller: caller({ orgId: ORG_A, developerId: MAINT, projectRole: "maintainer" }),
      write: { ...contextOf(h, add(CH.privBotIn)), browserSession: false, actor: "slack_interaction" },
    }) as Reply;
    expect(reply).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(h.calls).toEqual([`class:${CH.privBotIn}`]);
    expect(h.sleeps).toEqual([]);
  });
});

describe("SRL-14: the runtime applies the floor with a real timer", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a refusal made by the real runtime is held back for the whole floor", async () => {
    vi.useFakeTimers();
    const db = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
    seed(db);
    db.set({ ...slackTeamOrgKey(TEAM), orgId: ORG_A });
    const runtime = createTeamRecordRuntime({
      env: { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" }, documentClient: db, stateTableName: "State", now: () => Date.now(),
      slackUserIdsOf: async () => ["U0MAINT001"],
    }) as TeamRecordRuntime;
    const write: SourceWriteContext = {
      orgRole: "member", browserSession: true, body: () => add(CH.gone),
      slackChannel: async () => "none", slackMember: async () => undefined,
    };
    let done: Reply | undefined;
    const pending = runtime.routes({ method: "POST", path: "/v1/app/projects/web/record/sources", query: {}, caller: { orgId: ORG_A, developerId: MAINT, projectRole: "maintainer" }, write }).then((reply) => { done = reply as Reply; });
    await vi.advanceTimersByTimeAsync(FLOOR - 1);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toEqual(INVITE_NEEDED);
  });
});
