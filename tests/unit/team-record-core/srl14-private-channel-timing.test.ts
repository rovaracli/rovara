// SRL-14 (owner decision 24b): adding a Slack channel as a source from the web must not tell an editor, by the ANSWER or by the RESPONSE TIME, whether a private channel exists or whether Rovara is in it.
// The cases the caller may not learn about: (A) no such channel, (B) a private channel Rovara is not in, (C) a private channel Rovara is in that the editor is not in, (C') the same with a membership read that
// cannot be read or throws. All four must make the same Slack/table calls in the same order, answer with the identical reply, and take the same time (a fixed floor, driven here by an injected clock and sleep).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, slackTeamOrgKey } from "@agentx/contracts";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import { SLACK_ADDS_PER_EDITOR_PER_MINUTE, SLACK_MEMBERSHIP_MARGIN_MS, SLACK_REFUSAL_FLOOR_MS, realRefusalFloor, type SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import type { SlackFacts } from "../../../packages/broker/src/team-record/source-places.js";
import { slackDirectory } from "../../../packages/broker/src/developer/slack-directory.js";
import { slackChannelOf } from "../../../packages/broker/src/aws/developer-routes/team-record-source-write.js";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { BOT_TOKEN } from "../../support/developer-fakes.js";
import { ORG_A, caller, world, type World } from "../../support/team-record-core.js";

const MAINT = "c".repeat(64);
const AT = "2026-10-01T00:00:00.000Z";
const TEAM = "T0AAAAAAA";
const CH = { gone: "C0GONE0001", privBotOut: "C0PRIVOUT1", privBotIn: "C0PRIVIN01", pub: "C0PUBLIC01", archived: "C0ARCHIVE1" } as const;
const FLOOR = SLACK_REFUSAL_FLOOR_MS;

const INVITE_NEEDED = { status: 422, body: { code: "SLACK_INVITE_NEEDED", message: "Rovara isn't in that channel yet. Type /invite @Rovara in the channel, then try again. You must be in the channel yourself, with your Slack account linked to Rovara. If Rovara and you are both in it already, wait a minute and try again." } };
const NOT_LINKED = { status: 422, body: { code: "SLACK_NOT_LINKED", message: "Link your Slack account to Rovara so it can check you're in that channel, then try again." } };
const UNAVAILABLE = { status: 503, body: { code: "RUNTIME_UNAVAILABLE" } };

/** Slack's answer for a channel as the bot sees it, and how long each call takes (in fake milliseconds). */
interface Slack { facts: SlackFacts | "none"; members: string[]; classMs: number; memberMs: number; memberRead?: "ok" | "unreadable" | "throws" }
interface H {
  w: World; audit: ReturnType<typeof capturingAuditDeps>;
  slack: Map<string, Slack>; linked: string[]; calls: string[]; sleeps: number[];
  ports: { links: boolean; member: boolean; channel: boolean; floor: boolean };
  /** What the class read does besides answering: "returns nothing" or "throws" (the `slackChannel` port itself failing). */
  classRead?: "unreadable" | "throws";
  /** Takes the editor's minute: absent, no limiter. */
  limiter?: { take(key: string, limit: number, windowSeconds: number): Promise<boolean>; keys: string[] };
}

function seed(db: FakeDynamoDb): void {
  db.set({ ...orgMetaKey(ORG_A), orgId: ORG_A, entityType: "ORG", createdAt: AT, approvalMembershipVersion: 3, approvalTrackingSince: AT });
  db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: AT, archiveRevision: 0 });
  db.set({ ...orgMemberKey(ORG_A, MAINT), orgId: ORG_A, developerId: MAINT, role: "member", joinedAt: AT });
  db.set({ ...developerOrgKey(MAINT), orgId: ORG_A, role: "member" });
  db.set({ pk: `DEVELOPER#${MAINT}`, sk: "META", developerId: MAINT, revoked: false });
  db.set({ ...projectMemberKey(ORG_A, MAINT, "web"), ownerKey: MAINT, projectName: "web", role: "developer", projectRole: "maintainer", grantId: "grant-cccc" });
}

function harness(edition: "enterprise" | "public" = "enterprise"): H {
  const w = world({ edition });
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
    ...(h.ports.floor ? {
      refusalFloor: {
        ms: FLOOR,
        sleep: async (ms: number) => { h.sleeps.push(ms); h.w.clock.ms += ms; },
        // In fake time: the reads move the fake clock as they run, so the work was "late" when it moved the clock past the allowance.
        within: async <T,>(ms: number, work: Promise<T>): Promise<T | "late"> => { const t0 = h.w.clock.ms; const result = await work; return h.w.clock.ms - t0 > ms ? "late" : result; },
      },
    } : {}),
  },
  ...(h.limiter === undefined ? {} : { limiter: h.limiter }),
});

function contextOf(h: H, body: unknown): SourceWriteContext {
  return {
    orgRole: "member", browserSession: true, body: () => body, audit: h.audit.deps,
    ...(h.ports.channel ? {
      slackChannel: async (_team: string, channelId: string) => {
        h.calls.push(`class:${channelId}`);
        const s = h.slack.get(channelId);
        h.w.clock.ms += s?.classMs ?? 100;
        if (h.classRead === "throws") throw new Error("slack went away");
        if (h.classRead === "unreadable") return undefined;
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
const add = (channel: string, retention = "C") => ({ action: "add", requestId: randomUUID(), source: "slack", scope: slackScope(channel), retention, audienceDefault: "maintainers", enabled: true });
type Reply = { status: number; body: Record<string, unknown> };
async function post(h: H, channel: string, retention = "C"): Promise<Reply> {
  return await handleRecordRoute(dependencies(h), {
    method: "POST", path: "/v1/app/projects/web/record/sources", query: {}, caller: caller({ orgId: ORG_A, developerId: MAINT, projectRole: "maintainer" }), write: contextOf(h, add(channel, retention)),
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

  it("a missing way to read membership or links is the same 503 for every case, and it too is held to the floor", async () => {
    for (const [name, channel, tweak] of REFUSED_CASES) {
      for (const off of ["member", "links"] as const) {
        const r = await attempt(channel, (h) => { tweak(h); h.ports[off] = false; });
        expect(r.reply, `${name} / ${off} off`).toMatchObject(UNAVAILABLE);
        expect(r.elapsed, `${name} / ${off} off`).toBe(FLOOR);
      }
    }
  });

  it("a class read that fails (no way to read it, returns nothing, or throws) is a 503 held to the floor, the same whether or not the channel is one Rovara can see", async () => {
    const variants: Array<[string, (h: H) => void]> = [
      ["no class port", (h) => { h.ports.channel = false; }],
      ["returns nothing", (h) => { h.classRead = "unreadable"; }],
      ["throws", (h) => { h.classRead = "throws"; }],
    ];
    for (const [name, tweak] of variants) {
      for (const channel of [CH.gone, CH.privBotIn]) {
        const r = await attempt(channel, tweak);
        expect(r.reply, `${name} ${channel}`).toMatchObject(UNAVAILABLE);
        expect(r.elapsed, `${name} ${channel}`).toBe(FLOOR);
        expect(r.h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE"), name).toHaveLength(0);
      }
    }
  });

  it("the membership reads are given only until just before the floor: reads still running then count as 'not in', and the refusal goes out AT the floor", async () => {
    // Two linked ids at 1500 ms each (fake work adds up to 3140 ms in all), past the allowance (floor - margin = 2750): the same refusal, and nothing more is slept (the work already took longer).
    const slow = await attempt(CH.privBotIn, (h) => { h.slack.get(CH.privBotIn)!.memberMs = 1_500; h.slack.get(CH.privBotIn)!.members = ["U0MAINT001"]; });
    // the editor IS in the channel but Slack was too slow to say so within the allowance: fail closed, the same refusal
    expect(slow.reply).toEqual(INVITE_NEEDED);
    expect(SLACK_MEMBERSHIP_MARGIN_MS).toBeGreaterThan(0);
    // fast enough: the same member is let in
    const fast = await attempt(CH.privBotIn, (h) => { h.slack.get(CH.privBotIn)!.memberMs = 100; h.slack.get(CH.privBotIn)!.members = ["U0MAINT001"]; });
    expect(fast.reply).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
  });

  it("an editor's minute is counted before the place is read: past the limit every channel gets the same 429 and no Slack call, and a limiter that cannot answer refuses", async () => {
    const take = (taken: string[], failing: boolean) => ({ keys: taken, take: async (key: string, limit: number, windowSeconds: number) => { if (failing) throw new Error("table down"); taken.push(`${key}|${String(limit)}|${String(windowSeconds)}`); return taken.length <= limit; } });
    const h = harness();
    const taken: string[] = [];
    h.limiter = take(taken, false);
    for (let n = 0; n < SLACK_ADDS_PER_EDITOR_PER_MINUTE; n += 1) expect((await post(h, CH.gone)).status).toBe(422);
    h.calls.length = 0;
    const replies = [await post(h, CH.gone), await post(h, CH.privBotIn), await post(h, CH.pub)];
    for (const reply of replies) expect(reply).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
    expect(new Set(replies.map((reply) => JSON.stringify(reply))).size).toBe(1);
    expect(h.calls).toEqual([]);
    // keyed by the editor (person erase removes `RATE#slack-add-web|person:<id>`)
    expect(taken[0]).toBe(`${ORG_A}|slack-add-web|person:${MAINT}|${String(SLACK_ADDS_PER_EDITOR_PER_MINUTE)}|60`);
    const failing = harness();
    failing.limiter = take([], true);
    expect(await post(failing, CH.pub)).toMatchObject({ status: 429 });
  });
});

describe("SRL-14: the legitimate paths are not slowed", () => {
  it("an editor who is in the private channel adds it: one linked id being in is enough, and there is no floor", async () => {
    const r = await attempt(CH.privBotIn, (h) => { h.slack.get(CH.privBotIn)!.members = ["U0ALTID001"]; });
    expect(r.reply).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    // all the linked ids are asked at once (one round trip however many), and the first "yes" is enough
    expect(r.calls).toEqual(["class:<channel>", "links", "member:U0ALTID001@<channel>", "member:U0MAINT001@<channel>"]);
    expect(r.sleeps).toEqual([]);
    expect(r.elapsed).toBe(140 + 900 + 900);
  });

  it("a public channel is added with one class read, no links, no membership read, no floor", async () => {
    const r = await attempt(CH.pub);
    expect(r.reply).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(r.calls).toEqual(["class:<channel>"]);
    expect(r.sleeps).toEqual([]);
  });

  it("a Slack Connect channel (any edition) or a DM / group DM in Public that the editor IS in keeps its own SOURCE_NOT_ALLOWED answer, with no floor", async () => {
    for (const [channel, facts, edition] of [["C0CONNECT1", { kind: "private", extShared: true }, "enterprise"], ["C0CONNECT2", { kind: "private", extShared: true }, "public"], ["D0DIRECT01", { kind: "im", extShared: false }, "public"], ["G0GROUPDM1", { kind: "mpim", extShared: false }, "public"]] as const) {
      const h = harness(edition);
      h.slack.set(channel, { facts, members: ["U0MAINT001"], classMs: 100, memberMs: 100 });
      const started = h.w.clock.ms;
      const reply = await post(h, channel, edition === "public" ? "A" : "C");
      expect(reply, channel).toMatchObject({ status: 422, body: { code: "SOURCE_NOT_ALLOWED" } });
      expect(h.sleeps, channel).toEqual([]);
      expect(h.w.clock.ms - started, channel).toBeLessThan(FLOOR);
    }
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

// The review's finding 1: the ports above are fakes; this runs the REAL Slack directory (its members cache and in-flight read sharing) behind a fake fetch that takes 400 ms per call and counts the calls that actually go out.
describe("SRL-14: with the real Slack directory, every refusal still goes out at the floor (k = 5 linked ids, 400 ms a Slack call)", () => {
  afterEach(() => { vi.useRealTimers(); });
  const LINKED = ["U0AAAAAAA1", "U0AAAAAAA2", "U0AAAAAAA3", "U0AAAAAAA4", "U0AAAAAAA5"];
  const CALL_MS = 400;

  function slackFetch(wire: string[]): typeof fetch {
    return async (input: URL | string | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const channel = url.searchParams.get("channel") ?? "";
      wire.push(`${url.pathname.replace("/api/", "")}:${channel}`);
      await new Promise<void>((resolve) => { setTimeout(resolve, CALL_MS); });
      const visible = channel === CH.privBotIn;
      if (!visible) return Response.json({ ok: false, error: "channel_not_found" });
      if (url.pathname.endsWith("conversations.info")) return Response.json({ ok: true, channel: { id: channel, name: "secret", is_private: true, is_group: true } });
      return Response.json({ ok: true, members: ["U0OTHER001"], response_metadata: { next_cursor: "" } });
    };
  }
  const directoryOn = (wire: string[]) => slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch: slackFetch(wire), now: () => Date.now() });

  /** One refused add through the real directory (`directoryFor` gives each of the 5 membership reads its own directory when they run in separate containers). */
  async function timed(h: H, channel: string, directoryFor: () => ReturnType<typeof slackDirectory>): Promise<{ reply: Reply; ms: number }> {
    h.ports.floor = false;
    const info = directoryFor();
    const write: SourceWriteContext = {
      ...contextOf(h, add(channel)),
      slackChannel: slackChannelOf(async (request) => info.channelClass(request.teamId, request.channelId)),
      slackMember: async (userId, channelId) => { const answer = await directoryFor().channelMembers(userId, [channelId]); return answer.ok ? answer.memberOf.includes(channelId) : undefined; },
    };
    const started = Date.now();
    let reply: Reply | undefined;
    let ms = 0;
    const run = handleRecordRoute({ ...dependencies(h), now: () => Date.now(), sources: { ...dependencies(h).sources, refusalFloor: realRefusalFloor() } }, {
      method: "POST", path: "/v1/app/projects/web/record/sources", query: {}, caller: caller({ orgId: ORG_A, developerId: MAINT, projectRole: "maintainer" }), write,
    }).then((answer) => { reply = answer as Reply; ms = Date.now() - started; });
    while (reply === undefined) await vi.advanceTimersByTimeAsync(5);
    await run;
    return { reply, ms };
  }

  it("no such channel, a private channel Rovara is not in, and a private channel Rovara is in (cold and warm members cache; one container or five) all answer the same refusal at the floor", async () => {
    vi.useFakeTimers();
    const seen: Array<[string, number, string[]]> = [];
    const fresh = () => { const h = harness(); h.linked = LINKED; return h; };
    for (const [name, channel] of [["A: no such channel", CH.gone], ["B: private, Rovara not in", CH.privBotOut]] as const) {
      const wire: string[] = [];
      const one = directoryOn(wire);
      const { reply, ms } = await timed(fresh(), channel, () => one);
      expect(reply, name).toEqual(INVITE_NEEDED);
      seen.push([name, ms, wire]);
    }
    // C in one warm container: the five reads share one Slack read, and a repeat is served from the cache
    const sharedWire: string[] = [];
    const shared = directoryOn(sharedWire);
    const cold = await timed(fresh(), CH.privBotIn, () => shared);
    const coldCalls = sharedWire.length;
    const warm = await timed(fresh(), CH.privBotIn, () => shared);
    expect(cold.reply).toEqual(INVITE_NEEDED);
    expect(warm.reply).toEqual(INVITE_NEEDED);
    seen.push(["C cold", cold.ms, sharedWire.slice(0, coldCalls)], ["C warm", warm.ms, sharedWire.slice(coldCalls)]);
    // A and C with the five reads in five separate containers (no sharing at all)
    const splitMissing: string[] = [];
    const splitA = await timed(fresh(), CH.gone, () => directoryOn(splitMissing));
    expect(splitA.reply).toEqual(INVITE_NEEDED);
    seen.push(["A five containers", splitA.ms, splitMissing]);
    const splitWire: string[] = [];
    const split = await timed(fresh(), CH.privBotIn, () => directoryOn(splitWire));
    expect(split.reply).toEqual(INVITE_NEEDED);
    seen.push(["C five containers", split.ms, splitWire]);
    // The wire counts differ between cases (the members cache and the shared in-flight read decide them; that cannot be made equal); the time must not.
    expect(seen.map(([name, , wire]) => `${name}: ${String(wire.length)}`)).toEqual(["A: no such channel: 2", "B: private, Rovara not in: 2", "C cold: 2", "C warm: 1", "A five containers: 6", "C five containers: 6"]);
    for (const [name, ms] of seen) {
      expect(ms, name).toBeGreaterThanOrEqual(FLOOR);
      expect(ms, name).toBeLessThanOrEqual(FLOOR + 10);
    }
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
