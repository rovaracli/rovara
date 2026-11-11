import { describe, expect, it } from "vitest";
import { MAINTAINERS_GROUP } from "@rovara-code/contracts";
import { AclSnapshotSchema, AudienceSchema, type Audience } from "@agentx/cloud-contracts";
import { LIVE_CHECK_CACHE_MS, createLiveCheckCache, ownList, satisfiesAcl, visibleWithoutLiveCheck, type Visible } from "../../../packages/broker/src/team-record/acl.js";
import { viewerOfCaller } from "../../../packages/broker/src/team-record/access.js";
import type { ReadAudience } from "../../../packages/broker/src/team-record/types.js";
import { ORG_A, caller, filterRows as filterVisible } from "../../support/team-record-core.js";

const acl = (extra: Record<string, unknown> = {}): Audience => ({ kind: "restricted", acl: { source: "github", scope: "github:repo/9", principals: ["123"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none", ...extra } as never });
const row = (audience: Audience, extra: Partial<Visible & { scope: string; id: string }> = {}) => ({ audience, id: "r", ...extra });
const person = (extra = {}): ReadAudience => ({ kind: "caller", caller: caller(extra) });
const shared: ReadAudience = { kind: "shared", orgId: ORG_A };

describe("permission filter: the matrix", () => {
  it("shows a project-wide row to anyone with a project role, and to nobody without one", async () => {
    const rows = [row({ kind: "project" })];
    expect((await filterVisible(rows, person())).visible).toHaveLength(1);
    expect((await filterVisible(rows, person({ projectRole: "viewer" }))).visible).toHaveLength(1);
    const none = await filterVisible(rows, person({ projectRole: undefined }));
    expect(none.visible).toHaveLength(0);
    expect(none.withheld).toBe(1);
  });

  it("shows a restricted row only when the caller's identity at that source is a principal", async () => {
    const rows = [row(acl())];
    expect((await filterVisible(rows, person())).visible).toHaveLength(1);
    expect((await filterVisible(rows, person({ identities: { ids: { github: ["999"] }, groups: {} } }))).withheld).toBe(1);
    // an id at another source never matches, even if the string is equal
    expect((await filterVisible(rows, person({ identities: { ids: { slack: ["123"] }, groups: {} } }))).withheld).toBe(1);
  });

  it("an unmapped person matches nothing, and an empty snapshot is nobody", async () => {
    expect((await filterVisible([row(acl())], person({ identities: { ids: {}, groups: {} } }))).visible).toHaveLength(0);
    expect(satisfiesAcl(caller(), (acl({ principals: [] }) as unknown as { acl: never }).acl)).toBe(false);
    expect(satisfiesAcl(caller(), (acl({ principals: undefined, groups: [] }) as unknown as { acl: never }).acl)).toBe(false);
  });

  it("source groups and the maintainers group", async () => {
    const team = row(acl({ source: "slack", scope: "slack:T1/C1", principals: undefined, groups: ["T1"] }));
    expect((await filterVisible([team], person({ identities: { ids: {}, groups: { slack: ["T1"] } } }))).visible).toHaveLength(1);
    expect((await filterVisible([team], person({ identities: { ids: {}, groups: { slack: ["T2"] } } }))).visible).toHaveLength(0);
    const maintainers = row(acl({ principals: undefined, groups: [MAINTAINERS_GROUP] }));
    expect((await filterVisible([maintainers], person({ projectRole: "maintainer" }))).visible).toHaveLength(1);
    expect((await filterVisible([maintainers], person({ projectRole: "contributor" }))).visible).toHaveLength(0);
    expect((await filterVisible([maintainers], person({ projectRole: "viewer" }))).visible).toHaveLength(0);
  });

  it("a shared task sees only project-wide rows, never a restricted one", async () => {
    const result = await filterVisible([row({ kind: "project" }, { id: "p" }), row(acl(), { id: "r" })], shared);
    expect(result.visible.map((entry) => entry.id)).toEqual(["p"]);
    expect(result.withheld).toBe(1);
  });

  it("a tombstoned row is hidden and not counted as withheld", async () => {
    const tombstone = { at: "2026-10-30T10:00:00.000Z", cause: "source_deleted" as const };
    const result = await filterVisible([row({ kind: "project" }, { tombstone })], person());
    expect(result).toEqual({ visible: [], withheld: 0 });
    expect(visibleWithoutLiveCheck(person(), row({ kind: "project" }, { tombstone }))).toBe(false);
  });

  it("hides a scope with unfinished work from everyone, restricted or not", async () => {
    const hidden = new Set(["github:repo/9"]);
    expect((await filterVisible([row(acl())], person(), { pending: { scopes: hidden, sourceHashes: new Set() } })).visible).toHaveLength(0);
    expect((await filterVisible([row({ kind: "project" }, { scope: "github:repo/9" })], person(), { pending: { scopes: hidden, sourceHashes: new Set() } })).visible).toHaveLength(0);
    expect((await filterVisible([row({ kind: "project" }, { scope: "github:repo/10" })], person(), { pending: { scopes: hidden, sourceHashes: new Set() } })).visible).toHaveLength(1);
  });
});

describe("permission filter: the live re-check", () => {
  const live = row(acl({ liveCheck: "on_read" }));
  it("shows an on_read row only when the source says yes", async () => {
    expect((await filterVisible([live], person(), { liveCheck: async () => true })).visible).toHaveLength(1);
    expect((await filterVisible([live], person(), { liveCheck: async () => false })).withheld).toBe(1);
  });
  it("hides it when there is no checker or the checker throws (fail closed), and does not cache a failure", async () => {
    expect((await filterVisible([live], person())).visible).toHaveLength(0);
    const cache = createLiveCheckCache();
    let calls = 0;
    const flaky = async () => { calls += 1; if (calls === 1) throw new Error("source down"); return true; };
    expect((await filterVisible([live], person(), { liveCheck: flaky, cache })).visible).toHaveLength(0);
    expect((await filterVisible([live], person(), { liveCheck: flaky, cache })).visible).toHaveLength(1);
  });
  it("a row that fails the snapshot is never live-checked", async () => {
    let calls = 0;
    await filterVisible([live], person({ identities: { ids: {}, groups: {} } }), { liveCheck: async () => { calls += 1; return true; } });
    expect(calls).toBe(0);
  });
  it("asks once per caller and scope in one read, and reuses the answer for 15 minutes", async () => {
    const cache = createLiveCheckCache();
    let now = 1_000_000;
    let calls = 0;
    const liveCheck = async () => { calls += 1; return true; };
    await filterVisible([live, live, live], person(), { liveCheck, cache, now: () => now });
    expect(calls).toBe(1);
    now += LIVE_CHECK_CACHE_MS - 1;
    await filterVisible([live], person(), { liveCheck, cache, now: () => now });
    expect(calls).toBe(1);
    now += 2;
    await filterVisible([live], person(), { liveCheck, cache, now: () => now });
    expect(calls).toBe(2);
  });
  it("keeps one person's answer from serving another", async () => {
    const cache = createLiveCheckCache();
    const answers: Record<string, boolean> = { "dev-1": true, "dev-2": false };
    const liveCheck = async ({ caller: who }: { caller: { developerId: string } }) => answers[who.developerId] === true;
    expect((await filterVisible([live], person(), { liveCheck, cache })).visible).toHaveLength(1);
    expect((await filterVisible([live], person({ developerId: "dev-2" }), { liveCheck, cache })).visible).toHaveLength(0);
  });
  it("never live-checks for a shared task (it sees no restricted row anyway)", async () => {
    let calls = 0;
    const result = await filterVisible([live], shared, { liveCheck: async () => { calls += 1; return true; } });
    expect(result.visible).toHaveLength(0);
    expect(calls).toBe(0);
  });
});

// Convergence W0-3 review H2: Code's `AclSnapshotSchema.source` takes any id, Cloud's takes the closed list of systems it captures from. Cloud keeps its own (owed-upstream.json), and the lookups by source
// read the caller's lists by their own keys, so even a source that named a property every record inherits finds nothing instead of throwing.
describe("the source of a snapshot", () => {
  const snapshot = (source: unknown) => ({ source, scope: "s", principals: ["1"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" });

  it("is a closed list: a source Cloud does not capture from is refused, whatever its spelling", () => {
    for (const source of ["constructor", "__proto__", "toString", "hasownproperty", "examplehost", "codehost:", "Slack", "slack:x", ""]) {
      expect(AclSnapshotSchema.safeParse(snapshot(source)).success, source).toBe(false);
      expect(AudienceSchema.safeParse({ kind: "restricted", acl: snapshot(source) }).success, source).toBe(false);
    }
    for (const source of ["slack", "github", "linear", "jira", "mcp", "rovara", "codehost:examplehost"]) expect(AclSnapshotSchema.safeParse(snapshot(source)).success, source).toBe(true);
  });

  it("finds no list for a source named like an inherited property: it denies and does not throw (acl.ts, access.ts)", () => {
    const hostile = { source: "constructor", scope: "s", principals: ["123"], groups: [MAINTAINERS_GROUP, "g"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } as never;
    for (const source of ["constructor", "__proto__", "hasOwnProperty"]) {
      const someone = caller({ identities: { ids: { github: ["123"] }, groups: { github: ["g"] } } });
      expect(() => satisfiesAcl(someone, { ...hostile, source })).not.toThrow();
      expect(satisfiesAcl(someone, { ...hostile, source }), source).toBe(false);
      const viewer = viewerOfCaller(someone);
      expect(viewer.ids(source), source).toEqual([]);
      expect(viewer.groups(source), source).toEqual([]);
    }
    // a maintainer still gets the maintainers group at any source, as before
    expect(satisfiesAcl(caller({ projectRole: "maintainer" }), { ...hostile, source: "constructor" })).toBe(true);
    expect(ownList({ github: ["1"] }, "github")).toEqual(["1"]);
  });
});
