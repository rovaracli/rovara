import { describe, expect, it } from "vitest";
import { AuditEventInputSchema, UI_FLAG_CATALOG, UI_FLAG_NAMES, orgUiFlagsKey } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { UI_FLAGS_PER_MINUTE, routeUiFlags } from "../../packages/broker/src/aws/developer-routes/ui-flags.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes/types.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { ALL_OFF, navUiFlags, operatorForcedOff, settingsFromItem, uiFlagsMapOf } from "../../packages/broker/src/org/ui-flags/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// Runtime per-company UI flags (lane U5): who may read and change them, what a change needs first, that the operator's override wins, and that nothing of another company is seen or touched.

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PATH = "/v1/app/org/ui-flags";
const START = Date.UTC(2026, 10, 11, 9, 0, 0);
type Env = Record<string, string | undefined>;
interface Row { name: string; label: string; enabled: boolean; forcedOff: boolean; state: string }
interface Answer { revision: number; previews: boolean; flags: Row[]; changedAt?: string }
interface Stored { revision: number; previews: boolean; flags: Record<string, boolean>; changedBy?: string }

function world(options: { ledger?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db });
  const clock = { at: START };
  const deps = { documentClient: db, tableName: "state", now: () => clock.at, developer: { signInTableName: "state" }, ...(options.ledger === false ? {} : { audit: capture.audit }) } as unknown as DeveloperRouteDependencies;
  const caller = (orgId: OrgId, role: DeveloperCaller["orgRole"] = "owner", extra: { browser?: boolean } = {}): DeveloperCaller => ({
    developerId: (role === "owner" ? "a" : role === "admin" ? "b" : "c").repeat(64), sessionId: `session-${orgId}-${role}`, amr: "oidc", name: "Maya", orgId, orgRole: role,
    ...(extra.browser === false ? {} : { browserSession: true as const }),
  });
  const signIn = (who: DeveloperCaller, minutesAgo: number | undefined) => db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", ...(minutesAgo === undefined ? {} : { authTime: new Date(clock.at - minutesAgo * 60_000).toISOString() }) });
  const call = (who: DeveloperCaller, method: string, body?: unknown, env: Env = {}, path = PATH) => {
    const request: AdaptedHttpRequest = { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    return routeUiFlags(deps, who, request, path, env) as Promise<Answer>;
  };
  const stored = (orgId: OrgId) => db.get(orgUiFlagsKey(orgId)) as Stored | undefined;
  return { db, capture, clock, deps, caller, signIn, call, stored };
}

const stateOf = (answer: Answer, name: string): Row => answer.flags.find((row) => row.name === name)!;

describe("who may use the route", () => {
  it("refuses a member on both methods, and changes nothing", async () => {
    const w = world();
    const member = w.caller(ORG_A, "member");
    w.signIn(member, 0);
    await expect(w.call(member, "GET")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.call(member, "PUT", { expectedRevision: 0, flags: { look: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.stored(ORG_A)).toBeUndefined();
    expect(w.capture.recordedBy("company.ui_flags_changed")).toEqual([]);
  });

  it("answers an owner and an admin", async () => {
    const w = world();
    for (const role of ["owner", "admin"] as const) {
      const who = w.caller(ORG_A, role);
      w.signIn(who, 0);
      expect(await w.call(who, "GET")).toMatchObject({ revision: 0, previews: false });
    }
  });

  it("refuses a caller that is not a live browser session, on both methods", async () => {
    const w = world();
    const token = w.caller(ORG_A, "owner", { browser: false });
    w.signIn(token, 0);
    await expect(w.call(token, "GET")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.call(token, "PUT", { expectedRevision: 0, flags: { look: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.stored(ORG_A)).toBeUndefined();
  });

  it("ignores another path and refuses a method it does not take", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    expect(await w.call(owner, "GET", undefined, {}, "/v1/app/org/other")).toBeUndefined();
    for (const method of ["POST", "DELETE", "PATCH"]) await expect(w.call(owner, method, { expectedRevision: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GET", () => {
  it("is everything off by default, with all the known flags in catalog order", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const answer = await w.call(owner, "GET");
    expect(answer.revision).toBe(0);
    expect(answer.changedAt).toBeUndefined();
    expect(answer.flags.map((row) => row.name)).toEqual([...UI_FLAG_NAMES]);
    expect(UI_FLAG_CATALOG.map((entry) => entry.name)).toEqual([...UI_FLAG_NAMES]);
    for (const row of answer.flags) expect(row).toMatchObject({ enabled: false, forcedOff: false, state: "off" });
  });
});

describe("PUT", () => {
  it("needs a fresh sign-in, and changes nothing without one", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const body = { expectedRevision: 0, flags: { look: true } };
    for (const age of [11, 60, undefined]) {
      w.signIn(owner, age);
      await expect(w.call(owner, "PUT", body), String(age)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    }
    w.db.delete(`SESSION#${owner.sessionId}`, "META");
    await expect(w.call(owner, "PUT", body)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(w.stored(ORG_A)).toBeUndefined();
    expect(w.capture.recordedBy("company.ui_flags_changed")).toEqual([]);
    w.signIn(owner, 9);
    expect(await w.call(owner, "PUT", body)).toMatchObject({ revision: 1 });
  });

  it("turns flags on and off, merges what it names and keeps the rest, and writes one audit event per change", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 1);
    const first = await w.call(owner, "PUT", { expectedRevision: 0, flags: { look: true, nav: true } });
    expect(first).toMatchObject({ revision: 1, previews: false });
    expect(stateOf(first, "look")).toMatchObject({ enabled: true, state: "on" });
    expect(stateOf(first, "home")).toMatchObject({ enabled: false, state: "off" });
    const second = await w.call(owner, "PUT", { expectedRevision: 1, flags: { nav: false, home: true }, previews: true });
    expect(second.revision).toBe(2);
    expect(stateOf(second, "look")).toMatchObject({ enabled: true, state: "on" });
    expect(stateOf(second, "nav")).toMatchObject({ enabled: false, state: "preview" });
    expect(stateOf(second, "home")).toMatchObject({ enabled: true, state: "on" });
    expect(stateOf(second, "work")).toMatchObject({ enabled: false, state: "preview" });
    expect(w.stored(ORG_A)).toMatchObject({ revision: 2, previews: true, flags: { look: true, nav: false, home: true }, changedBy: owner.developerId });
    const events = w.capture.recordedBy("company.ui_flags_changed");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ orgId: ORG_A, actor: { id: owner.developerId }, target: { kind: "org", id: ORG_A }, facts: { revision: 1, turnedOn: "look+nav", turnedOff: "none", previews: "same" } });
    expect(events[1]).toMatchObject({ facts: { revision: 2, turnedOn: "home", turnedOff: "nav", previews: "on" } });
    for (const event of events) expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
    expect(await w.call(owner, "GET")).toEqual(second);
  });

  it("writes the audit event in the same transaction as the change: no ledger, no change", async () => {
    const w = world({ ledger: false });
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await expect(w.call(owner, "PUT", { expectedRevision: 0, flags: { look: true } })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(w.stored(ORG_A)).toBeUndefined();
  });

  it("refuses a flag name outside the closed list, and any other field, without storing anything or repeating what was sent", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    const bodies: unknown[] = [
      { expectedRevision: 0, flags: { secretInput: true } }, { expectedRevision: 0, flags: { look: true, companyRules: true } }, { expectedRevision: 0, flags: { __proto__x: true } },
      { expectedRevision: 0, flags: { look: "yes" } }, { expectedRevision: 0, flags: { look: 1 } }, { expectedRevision: 0, flags: [] }, { expectedRevision: 0, flags: null },
      { expectedRevision: 0, flags: { look: true }, orgId: ORG_B }, { flags: { look: true } }, { expectedRevision: -1, flags: { look: true } }, { expectedRevision: 0.5, flags: { look: true } },
      { expectedRevision: 0 }, { expectedRevision: 0, flags: {} }, { expectedRevision: 0, previews: "on" }, [], "look", null,
    ];
    for (const body of bodies) {
      const error = await w.call(owner, "PUT", body).catch((caught: unknown) => caught as Error);
      expect(error, JSON.stringify(body)).toMatchObject({ code: "CONFIG_INVALID" });
      expect((error as Error).message).not.toContain("secretInput");
    }
    expect(w.stored(ORG_A)).toBeUndefined();
    expect(w.capture.recordedBy("company.ui_flags_changed")).toEqual([]);
  });

  it("accepts a previews-only change", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    const answer = await w.call(owner, "PUT", { expectedRevision: 0, previews: true });
    expect(answer).toMatchObject({ revision: 1, previews: true });
    expect(stateOf(answer, "look")).toMatchObject({ enabled: false, state: "preview" });
  });

  it("is fenced by the revision: a stale write is CHANGE_STALE and changes nothing", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const admin = w.caller(ORG_A, "admin");
    w.signIn(owner, 0); w.signIn(admin, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, flags: { look: true } });
    await expect(w.call(admin, "PUT", { expectedRevision: 0, flags: { look: false } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(w.call(admin, "PUT", { expectedRevision: 5, flags: { look: false } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.stored(ORG_A)).toMatchObject({ revision: 1, flags: { look: true } });
    expect(w.capture.recordedBy("company.ui_flags_changed")).toHaveLength(1);
    expect(await w.call(admin, "PUT", { expectedRevision: 1, flags: { look: false } })).toMatchObject({ revision: 2 });
  });

  it("lets only one of two racing writes win", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    const results = await Promise.allSettled([w.call(owner, "PUT", { expectedRevision: 0, flags: { look: true } }), w.call(owner, "PUT", { expectedRevision: 0, flags: { nav: true } })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(w.stored(ORG_A)).toMatchObject({ revision: 1 });
    expect(w.capture.recordedBy("company.ui_flags_changed")).toHaveLength(1);
  });

  it("writing the value already in force still moves the revision and is audited", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, flags: { look: true } });
    const again = await w.call(owner, "PUT", { expectedRevision: 1, flags: { look: true } });
    expect(again.revision).toBe(2);
    expect(w.capture.recordedBy("company.ui_flags_changed")[1]).toMatchObject({ facts: { revision: 2, turnedOn: "none", turnedOff: "none", previews: "same" } });
  });

  it("never touches another company's flags, and a company sees only its own", async () => {
    const w = world();
    const a = w.caller(ORG_A), b = w.caller(ORG_B);
    w.signIn(a, 0); w.signIn(b, 0);
    await w.call(a, "PUT", { expectedRevision: 0, flags: { look: true }, previews: true });
    expect(await w.call(b, "GET")).toMatchObject({ revision: 0, previews: false });
    expect(stateOf(await w.call(b, "GET"), "look")).toMatchObject({ enabled: false, state: "off" });
    expect(await w.call(b, "PUT", { expectedRevision: 0, flags: { nav: true } })).toMatchObject({ revision: 1 });
    expect(w.stored(ORG_A)).toMatchObject({ revision: 1, flags: { look: true } });
    expect(w.stored(ORG_A)?.flags.nav).toBeUndefined();
    expect(w.capture.recordedBy("company.ui_flags_changed").map((event) => event.orgId)).toEqual([ORG_A, ORG_B]);
  });

  it("is rate limited for the whole company", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    for (let i = 0; i < UI_FLAGS_PER_MINUTE; i += 1) await w.call(owner, "PUT", { expectedRevision: i, flags: { look: i % 2 === 0 } });
    await expect(w.call(owner, "PUT", { expectedRevision: UI_FLAGS_PER_MINUTE, flags: { look: true } })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    w.clock.at += 61_000;
    w.signIn(owner, 0);
    expect(await w.call(owner, "PUT", { expectedRevision: UI_FLAGS_PER_MINUTE, flags: { look: true } })).toMatchObject({ revision: UI_FLAGS_PER_MINUTE + 1 });
  });
});

describe("the operator's override", () => {
  it("wins over a company that turned the flag on, and over previews", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, flags: { look: true, nav: true }, previews: true });
    const forced: Env = { UI_FLAGS_FORCE_OFF: "look-home" };
    const answer = await w.call(owner, "GET", undefined, forced);
    expect(stateOf(answer, "look")).toMatchObject({ enabled: true, forcedOff: true, state: "off" });
    expect(stateOf(answer, "home")).toMatchObject({ enabled: false, forcedOff: true, state: "off" });
    expect(stateOf(answer, "nav")).toMatchObject({ enabled: true, forcedOff: false, state: "on" });
    expect(stateOf(answer, "work")).toMatchObject({ forcedOff: false, state: "preview" });
    // The nav answer: the same states.
    expect(await navUiFlags({ documentClient: w.db, tableName: "state", now: w.deps.now }, ORG_A, forced)).toMatchObject({ look: "off", home: "off", nav: "on", work: "preview" });
    // A change while forced is stored (the company's wish) but changes nothing people get.
    const put = await w.call(owner, "PUT", { expectedRevision: 1, flags: { home: true } }, forced);
    expect(stateOf(put, "home")).toMatchObject({ enabled: true, state: "off" });
  });

  it("forces everything off with `all`, reads `none` and empty as no hold, and fails closed on a value it cannot read", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, flags: Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, true])), previews: true });
    for (const [value, held] of [["all", UI_FLAG_NAMES.length], ["none", 0], ["", 0], [undefined, 0], ["look", 1], ["look-nav", 2], ["lok", UI_FLAG_NAMES.length], ["look-", UI_FLAG_NAMES.length], ["look-nope", UI_FLAG_NAMES.length], ["LOOK", UI_FLAG_NAMES.length], ["look nav", UI_FLAG_NAMES.length]] as const) {
      const answer = await w.call(owner, "GET", undefined, { UI_FLAGS_FORCE_OFF: value });
      expect(answer.flags.filter((row) => row.forcedOff).length, String(value)).toBe(held);
      expect(operatorForcedOff({ UI_FLAGS_FORCE_OFF: value }).size, String(value)).toBe(held);
    }
  });
});

describe("the navigation answer's flags", () => {
  const table = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", now: () => START }) as never;
  it("is every flag off for a company that never changed anything, and carries the company's own states after a change", async () => {
    const w = world();
    expect(await navUiFlags(table(w.db), ORG_A, {})).toEqual(ALL_OFF);
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, flags: { home: true }, previews: true });
    const nav = await navUiFlags(table(w.db), ORG_A, {});
    expect(nav.home).toBe("on");
    expect(nav.look).toBe("preview");
    expect(Object.keys(nav).sort()).toEqual([...UI_FLAG_NAMES].sort());
    expect(await navUiFlags(table(w.db), ORG_B, {})).toEqual(ALL_OFF);
  });

  it("gives every flag off when the read fails, never an error and never a flag left on", async () => {
    const w = world();
    w.db.set({ ...orgUiFlagsKey(ORG_A), flags: { look: true }, previews: true, revision: 1 });
    const broken = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "state", now: () => START } as never;
    expect(await navUiFlags(broken, ORG_A, {})).toEqual(ALL_OFF);
  });

  it("reads a stored row that does not read as off: unknown names, non-boolean values and a bad revision are ignored", () => {
    expect(settingsFromItem(undefined)).toEqual({ flags: {}, previews: false, revision: 0 });
    const odd = settingsFromItem({ flags: { look: true, nav: "yes", unknownFlag: true, home: false }, previews: "true", revision: 3 });
    expect(odd).toEqual({ flags: { look: true, home: false }, previews: false, revision: 3 });
    expect(uiFlagsMapOf(odd, new Set()).look).toBe("on");
    // A row whose revision does not read is unreadable as a whole: nothing in it is trusted.
    const unreadable = settingsFromItem({ flags: { look: true }, previews: true, revision: "3" });
    expect(unreadable).toEqual({ flags: {}, previews: false, revision: 0, unreadableRevision: { value: "3" } });
    expect(uiFlagsMapOf(unreadable, new Set())).toEqual(ALL_OFF);
    expect(uiFlagsMapOf(settingsFromItem({ flags: "look", revision: 2 }), new Set()).look).toBe("off");
  });
});

describe("a stored row whose revision does not read", () => {
  const MALFORMED: unknown[] = ["abc", "3", 0, -2, 1.5, null, { m: 1 }, true];
  const seed = (w: ReturnType<typeof world>, revision: unknown) => w.db.set({ ...orgUiFlagsKey(ORG_A), entityType: "UI_FLAGS", orgId: ORG_A, flags: { look: true, nav: true }, previews: true, revision, changedAt: "2026-11-11T09:00:00.000Z" });

  it("reads as every flag off, in the admin answer and the navigation answer, and does not lock the admin out", async () => {
    for (const revision of MALFORMED) {
      const w = world();
      seed(w, revision);
      const owner = w.caller(ORG_A);
      w.signIn(owner, 0);
      const read = await w.call(owner, "GET");
      expect(read, JSON.stringify(revision)).toMatchObject({ revision: 0, previews: false });
      for (const row of read.flags) expect(row, JSON.stringify(revision)).toMatchObject({ enabled: false, state: "off" });
      expect(await navUiFlags({ documentClient: w.db, tableName: "state", now: w.deps.now }, ORG_A, {})).toEqual(ALL_OFF);
      // The next change replaces the row (a conditional write on what is stored) and the company is back in service.
      const put = await w.call(owner, "PUT", { expectedRevision: 0, flags: { home: true } });
      expect(put, JSON.stringify(revision)).toMatchObject({ revision: 1, previews: false });
      expect(stateOf(put, "home")).toMatchObject({ enabled: true, state: "on" });
      expect(stateOf(put, "look")).toMatchObject({ enabled: false, state: "off" });
      expect(w.stored(ORG_A)).toMatchObject({ revision: 1, flags: { home: true } });
      expect(w.capture.recordedBy("company.ui_flags_changed")).toHaveLength(1);
      expect(await w.call(owner, "PUT", { expectedRevision: 1, flags: { nav: true } })).toMatchObject({ revision: 2 });
    }
  });

  it("is still fenced: two writers who both read the unreadable row cannot both replace it", async () => {
    const w = world();
    seed(w, "abc");
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    const results = await Promise.allSettled([w.call(owner, "PUT", { expectedRevision: 0, flags: { look: true } }), w.call(owner, "PUT", { expectedRevision: 0, flags: { nav: true } })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "CHANGE_STALE" } }]);
    expect(w.stored(ORG_A)?.revision).toBe(1);
  });

  it("a write made against a row that turned unreadable meanwhile is stale, not a silent overwrite", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, flags: { look: true } });
    seed(w, "garbled");
    await expect(w.call(owner, "PUT", { expectedRevision: 1, flags: { nav: true } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.stored(ORG_A)?.revision).toBe("garbled");
  });

  it("a row with no revision at all is replaced the same way", async () => {
    const w = world();
    w.db.set({ ...orgUiFlagsKey(ORG_A), entityType: "UI_FLAGS", orgId: ORG_A, flags: { look: true }, previews: true });
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    expect(await w.call(owner, "GET")).toMatchObject({ revision: 0 });
    expect(await w.call(owner, "PUT", { expectedRevision: 0, flags: { home: true } })).toMatchObject({ revision: 1 });
  });
});

describe("the company switcher and Continue in your own tool (decision 98: `companies` and `continue`)", () => {
  const NEW = ["companies", "continue"] as const;
  const table = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", now: () => START }) as never;

  it("are off by default, in the admin answer (wired, with plain words) and in the navigation answer", async () => {
    const w = world();
    const answer = await w.call(w.caller(ORG_A), "GET");
    expect(stateOf(answer, "companies")).toMatchObject({ label: "Companies", wired: true, enabled: false, forcedOff: false, state: "off" });
    expect(stateOf(answer, "continue")).toMatchObject({ label: "Continue in your own tool", wired: true, enabled: false, forcedOff: false, state: "off" });
    const nav = await navUiFlags(table(w.db), ORG_A, {});
    expect(nav.companies).toBe("off");expect(nav.continue).toBe("off");
  });

  for (const name of NEW) {
    it(`stores, answers and audits \`${name}\` like every other flag, for an owner and an admin`, async () => {
      const w = world();
      const owner = w.caller(ORG_A), admin = w.caller(ORG_A, "admin");
      w.signIn(owner, 0); w.signIn(admin, 0);
      const on = await w.call(owner, "PUT", { expectedRevision: 0, flags: { [name]: true } });
      expect(stateOf(on, name)).toMatchObject({ enabled: true, state: "on" });
      expect(w.stored(ORG_A)).toMatchObject({ revision: 1, flags: { [name]: true }, changedBy: owner.developerId });
      expect((await navUiFlags(table(w.db), ORG_A, {}))[name]).toBe("on");
      const off = await w.call(admin, "PUT", { expectedRevision: 1, flags: { [name]: false }, previews: true });
      expect(stateOf(off, name)).toMatchObject({ enabled: false, state: "preview" });
      expect((await navUiFlags(table(w.db), ORG_A, {}))[name]).toBe("preview");
      const events = w.capture.recordedBy("company.ui_flags_changed");
      expect(events.map((event) => event.facts)).toMatchObject([{ revision: 1, turnedOn: name, turnedOff: "none", previews: "same" }, { revision: 2, turnedOn: "none", turnedOff: name, previews: "on" }]);
      expect(events.map((event) => event.actor.id)).toEqual([owner.developerId, admin.developerId]);
      for (const event of events) expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
    });

    it(`refuses \`${name}\` to a member and to a caller that is not a live browser session, and needs a fresh sign-in`, async () => {
      const w = world();
      const member = w.caller(ORG_A, "member"), token = w.caller(ORG_A, "owner", { browser: false }), owner = w.caller(ORG_A);
      w.signIn(member, 0); w.signIn(token, 0); w.signIn(owner, 30);
      await expect(w.call(member, "PUT", { expectedRevision: 0, flags: { [name]: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(w.call(token, "PUT", { expectedRevision: 0, flags: { [name]: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(w.call(owner, "PUT", { expectedRevision: 0, flags: { [name]: true } })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
      expect(w.stored(ORG_A)).toBeUndefined();
      expect(w.capture.recordedBy("company.ui_flags_changed")).toEqual([]);
    });

    it(`fences \`${name}\` by the revision and keeps it to its own company`, async () => {
      const w = world();
      const a = w.caller(ORG_A), b = w.caller(ORG_B);
      w.signIn(a, 0); w.signIn(b, 0);
      await w.call(a, "PUT", { expectedRevision: 0, flags: { [name]: true } });
      await expect(w.call(a, "PUT", { expectedRevision: 0, flags: { [name]: false } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
      expect(w.stored(ORG_A)).toMatchObject({ revision: 1, flags: { [name]: true } });
      expect(stateOf(await w.call(b, "GET"), name)).toMatchObject({ enabled: false, state: "off" });
      expect((await navUiFlags(table(w.db), ORG_B, {}))[name]).toBe("off");
      expect(w.stored(ORG_B)).toBeUndefined();
    });

    it(`lets the operator hold \`${name}\` off over the company's choice and over previews`, async () => {
      const w = world();
      const owner = w.caller(ORG_A);
      w.signIn(owner, 0);
      await w.call(owner, "PUT", { expectedRevision: 0, flags: { companies: true, continue: true }, previews: true });
      const forced: Env = { UI_FLAGS_FORCE_OFF: name };
      const other = name === "companies" ? "continue" : "companies";
      const answer = await w.call(owner, "GET", undefined, forced);
      expect(stateOf(answer, name)).toMatchObject({ enabled: true, forcedOff: true, state: "off" });
      expect(stateOf(answer, other)).toMatchObject({ enabled: true, forcedOff: false, state: "on" });
      expect(await navUiFlags(table(w.db), ORG_A, forced)).toMatchObject({ [name]: "off", [other]: "on", look: "preview" });
      expect(operatorForcedOff({ UI_FLAGS_FORCE_OFF: `look-${name}` })).toEqual(new Set(["look", name]));
    });
  }

  it("audits every flag turned on at once within the fact length limit", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, flags: Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, true])) });
    const [event] = w.capture.recordedBy("company.ui_flags_changed");
    expect(event?.facts?.turnedOn).toBe(UI_FLAG_NAMES.join("+"));
    expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
  });

  it("reads a row an older broker wrote (no `companies` or `continue`) as both off, and keeps the row's other flags", async () => {
    const w = world();
    w.db.set({ ...orgUiFlagsKey(ORG_A), entityType: "UI_FLAGS", orgId: ORG_A, flags: { look: true, insights: true }, previews: false, revision: 4, changedAt: "2026-11-11T09:00:00.000Z" });
    const nav = await navUiFlags(table(w.db), ORG_A, {});
    expect(nav).toMatchObject({ look: "on", insights: "on", companies: "off", continue: "off" });
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 4, flags: { continue: true } });
    expect(w.stored(ORG_A)).toMatchObject({ revision: 5, flags: { look: true, insights: true, continue: true } });
    expect(w.stored(ORG_A)?.flags.companies).toBeUndefined();
  });

  it("ignores a stored name a newer broker may add later, as an older broker ignores these two", () => {
    const settings = settingsFromItem({ flags: { companies: true, continue: false, laterScreen: true }, previews: false, revision: 2 });
    expect(settings.flags).toEqual({ companies: true, continue: false });
    expect(uiFlagsMapOf(settings, new Set())).toMatchObject({ companies: "on", continue: "off" });
  });
});
