// Wiring lane B, LR-W3: a write that loosens the tier-0 approval to "auto" (project or company) needs a SECOND person: a different eligible maintainer or admin approves a proposal.
// Stricter writes apply directly. A company floor can only be stricter. Nothing loosens while automatic go-live is not enabled.
import { describe, expect, it } from "vitest";
import {
  approveTier0Change, cancelTier0Change, requestTier0Change, type Tier0Change, type Tier0ChangeStore, type Tier0Deps, type Tier0Level, type Tier0Scope, type Tier0SettingsStore,
} from "../../../packages/broker/src/lessons/tier0-setting.js";
import { Audit, Clock, PROJECT, WS } from "./lesson-helpers.js";

const PROJECT_SCOPE: Tier0Scope = { kind: "project", workspaceId: WS, project: PROJECT };
const COMPANY_SCOPE: Tier0Scope = { kind: "company", workspaceId: WS };
const scopeId = (s: Tier0Scope): string => (s.kind === "project" ? `p:${s.workspaceId}:${s.project}` : `c:${s.workspaceId}`);

class Settings implements Tier0SettingsStore {
  values = new Map<string, Tier0Level>();
  writes: Array<{ scope: string; value: Tier0Level; by: string }> = [];
  failWrite = false;
  async read(scope: Tier0Scope): Promise<Tier0Level | undefined> { return this.values.get(scopeId(scope)); }
  /** Runs between a caller's read and its write: another writer got in. */
  beforeWrite: (() => void) | undefined;
  async write(scope: Tier0Scope, value: Tier0Level, meta: { by: string; at: number }, from: Tier0Level): Promise<boolean> {
    if (this.failWrite) throw new Error("down");
    this.beforeWrite?.();
    const current = this.values.get(scopeId(scope)) ?? (scope.kind === "project" ? "one" : "auto");
    if (current !== from) return false;
    this.values.set(scopeId(scope), value); this.writes.push({ scope: scopeId(scope), value, by: meta.by });
    return true;
  }
}
class Changes implements Tier0ChangeStore {
  rows = new Map<string, Tier0Change>();
  async create(change: Tier0Change): Promise<boolean> { if (this.rows.has(change.id)) return false; this.rows.set(change.id, structuredClone(change)); return true; }
  async get(_scope: Tier0Scope, id: string): Promise<Tier0Change | undefined> { const c = this.rows.get(id); return c === undefined ? undefined : structuredClone(c); }
  async open(scope: Tier0Scope, now: number): Promise<Tier0Change | undefined> { return [...this.rows.values()].find((c) => scopeId(c.scope) === scopeId(scope) && c.state === "pending" && c.expiresAt > now); }
  async transition(_scope: Tier0Scope, id: string, from: Tier0Change["state"], to: Tier0Change["state"]): Promise<boolean> {
    const c = this.rows.get(id); if (c === undefined || c.state !== from) return false; c.state = to; return true;
  }
}

function world(over: { eligible?: string[]; owners?: string[]; autoEnabled?: boolean; complete?: boolean } = {}) {
  const settings = new Settings();
  const changes = new Changes();
  const audit = new Audit();
  const clock = new Clock();
  const group = { complete: over.complete ?? true, membershipVersion: 3, ownerIds: over.owners ?? ["owner"], eligibleIds: over.eligible ?? ["owner", "ann", "bob"], lastEligibleLossAtMs: null as number | null };
  const authority = { calls: 0, failing: false, async eligibility() { this.calls += 1; if (this.failing) throw new Error("down"); return group; } };
  const deps: Tier0Deps = { settings, changes, audit, authority, now: clock.now, autoApplyEnabled: () => over.autoEnabled ?? true, newId: (() => { let n = 0; return () => `chg-${++n}`; })() };
  return { deps, settings, changes, audit, clock, authority, group };
}

describe("stricter writes apply directly", () => {
  it("project: one to two applies at once, by an eligible person, with an audit event", async () => {
    const w = world();
    const result = await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "two", requestedBy: "ann" });
    expect(result).toEqual({ ok: true, status: "applied", value: "two" });
    expect(w.settings.values.get(scopeId(PROJECT_SCOPE))).toBe("two");
    expect(w.audit.actions()).toEqual(["lesson.tier0_setting_changed"]);
    expect(w.changes.rows.size).toBe(0);
  });
  it("company floor: none to one applies directly; a floor can only be raised without a second person", async () => {
    const w = world();
    expect(await requestTier0Change(w.deps, { scope: COMPANY_SCOPE, value: "one", requestedBy: "owner" })).toEqual({ ok: true, status: "applied", value: "one" });
    expect(await requestTier0Change(w.deps, { scope: COMPANY_SCOPE, value: "two", requestedBy: "owner" })).toEqual({ ok: true, status: "applied", value: "two" });
    expect(w.settings.values.get(scopeId(COMPANY_SCOPE))).toBe("two");
  });
  it("ANY loosening needs a second person, not only a move to auto: two to one opens a proposal and changes nothing", async () => {
    const w = world({ autoEnabled: false });
    w.settings.values.set(scopeId(PROJECT_SCOPE), "two");
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "one", requestedBy: "ann" })).toEqual({ ok: true, status: "needs_approval", changeId: "chg-1" });
    expect(w.settings.writes).toEqual([]);
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "ann" })).toEqual({ ok: false, code: "second_person_required" });
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: true, value: "one" });
    expect(w.settings.values.get(scopeId(PROJECT_SCOPE))).toBe("one");
  });
  it("the same at company level: a floor of two lowered to one needs a second admin; auto-apply being off does not stop a loosening that is not to auto", async () => {
    const w = world({ autoEnabled: false });
    w.settings.values.set(scopeId(COMPANY_SCOPE), "two");
    expect(await requestTier0Change(w.deps, { scope: COMPANY_SCOPE, value: "one", requestedBy: "owner" })).toMatchObject({ status: "needs_approval" });
    expect(w.settings.values.get(scopeId(COMPANY_SCOPE))).toBe("two");
    expect(await approveTier0Change(w.deps, { scope: COMPANY_SCOPE, changeId: "chg-1", approverId: "ann" })).toEqual({ ok: true, value: "one" });
  });
  it("a write that loses to a stricter write made in between is stale and changes nothing (the write is conditional)", async () => {
    const w = world();
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    w.settings.beforeWrite = () => w.settings.values.set(scopeId(PROJECT_SCOPE), "two");
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "stale" });
    expect(w.settings.values.get(scopeId(PROJECT_SCOPE))).toBe("two");
    const direct = world();
    direct.settings.beforeWrite = () => direct.settings.values.set(scopeId(PROJECT_SCOPE), "two");
    expect(await requestTier0Change(direct.deps, { scope: PROJECT_SCOPE, value: "one", requestedBy: "ann" })).toEqual({ ok: false, code: "stale" });
  });
  it("an unchanged value is a no-op that still needs an eligible person", async () => {
    const w = world();
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "one", requestedBy: "ann" })).toMatchObject({ ok: true, status: "applied" });
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "one", requestedBy: "stranger" })).toEqual({ ok: false, code: "not_eligible" });
  });
});

describe("loosening to auto needs a second person", () => {
  it("is refused as a direct write: it opens a proposal and changes nothing", async () => {
    const w = world();
    const result = await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    expect(result).toEqual({ ok: true, status: "needs_approval", changeId: "chg-1" });
    expect(w.settings.writes).toEqual([]);
    expect(w.audit.actions()).toEqual(["lesson.tier0_setting_proposed"]);
  });
  it("the proposer cannot approve their own change, in any way (no sole-owner exception)", async () => {
    const w = world({ eligible: ["owner"], owners: ["owner"] });
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "owner" });
    w.clock.advance(3 * 86_400_000);
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "owner" })).toEqual({ ok: false, code: "second_person_required" });
    const w2 = world();
    await requestTier0Change(w2.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "Ann" });
    expect(await approveTier0Change(w2.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: " ann " })).toEqual({ ok: false, code: "second_person_required" });
    expect(w.settings.writes).toEqual([]);
    expect(w2.settings.writes).toEqual([]);
  });
  it("a different eligible maintainer or admin approves and the value changes, audited, once", async () => {
    const w = world();
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: true, value: "auto" });
    expect(w.settings.values.get(scopeId(PROJECT_SCOPE))).toBe("auto");
    expect(w.audit.actions()).toEqual(["lesson.tier0_setting_proposed", "lesson.tier0_setting_changed"]);
    expect(w.audit.events.at(-1)).toMatchObject({ actor: "bob", facts: { from: "one", to: "auto", scope: "project", proposedBy: "ann" } });
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "owner" })).toEqual({ ok: false, code: "not_pending" });
    expect(w.settings.writes).toHaveLength(1);
  });
  it("an approver who is not an eligible maintainer or admin is refused, and so is a proposer who is not", async () => {
    const w = world();
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(w.settings.writes).toEqual([]);
  });
  it("a proposer who lost eligibility before the approval cannot get it through", async () => {
    const w = world();
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    w.group.eligibleIds = ["owner", "bob"];
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toMatchObject({ ok: false });
    expect(w.settings.writes).toEqual([]);
  });
  it("company level: the same rule, by a second company admin", async () => {
    const w = world();
    w.settings.values.set(scopeId(COMPANY_SCOPE), "one");
    expect(await requestTier0Change(w.deps, { scope: COMPANY_SCOPE, value: "auto", requestedBy: "owner" })).toMatchObject({ status: "needs_approval" });
    expect(await approveTier0Change(w.deps, { scope: COMPANY_SCOPE, changeId: "chg-1", approverId: "owner" })).toEqual({ ok: false, code: "second_person_required" });
    expect(await approveTier0Change(w.deps, { scope: COMPANY_SCOPE, changeId: "chg-1", approverId: "ann" })).toEqual({ ok: true, value: "auto" });
    expect(w.settings.values.get(scopeId(COMPANY_SCOPE))).toBe("auto");
  });
  it("a change belongs to its scope: approving it under another scope finds nothing", async () => {
    const w = world();
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    expect(await approveTier0Change(w.deps, { scope: COMPANY_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "not_found" });
    expect(await approveTier0Change(w.deps, { scope: { kind: "project", workspaceId: WS, project: "other" }, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "not_found" });
  });
  it("a proposal expires after 7 days, goes stale when the value moved meanwhile, and only one is open per scope", async () => {
    const w = world();
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "bob" })).toEqual({ ok: false, code: "already_open" });
    w.settings.values.set(scopeId(PROJECT_SCOPE), "two");
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "stale" });
    const late = world();
    await requestTier0Change(late.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    late.clock.advance(7 * 86_400_000 + 1);
    expect(await approveTier0Change(late.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "expired" });
    expect(await requestTier0Change(late.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "bob" })).toMatchObject({ ok: true, status: "needs_approval" });
  });
  it("a proposal can be cancelled by an eligible person, and then cannot be approved", async () => {
    const w = world();
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    expect(await cancelTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", actorId: "mallory" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await cancelTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", actorId: "owner" })).toEqual({ ok: true });
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "not_pending" });
  });
});

describe("the company floor can only be stricter", () => {
  it("a project cannot set a value below the company floor, even with a second person", async () => {
    const w = world();
    w.settings.values.set(scopeId(COMPANY_SCOPE), "two");
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "one", requestedBy: "ann" })).toEqual({ ok: false, code: "below_company_floor" });
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" })).toEqual({ ok: false, code: "below_company_floor" });
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "two", requestedBy: "ann" })).toMatchObject({ ok: true, status: "applied" });
  });
  it("a floor raised after a project proposal opened stops the approval", async () => {
    const w = world();
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    w.settings.values.set(scopeId(COMPANY_SCOPE), "one");
    expect(await approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "below_company_floor" });
    expect(w.settings.writes).toEqual([]);
  });
});

describe("fails closed", () => {
  it("nothing loosens to auto while automatic go-live is not enabled", async () => {
    const w = world({ autoEnabled: false });
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" })).toEqual({ ok: false, code: "auto_apply_not_enabled" });
    expect(w.changes.rows.size).toBe(0);
    const open = world();
    await requestTier0Change(open.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    const closed: Tier0Deps = { ...open.deps, autoApplyEnabled: () => false };
    expect(await approveTier0Change(closed, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "auto_apply_not_enabled" });
    expect(open.settings.writes).toEqual([]);
  });
  it("an unknown value, an incomplete or failing eligibility answer, and a failing audit stop the change", async () => {
    const w = world();
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "loose" as never, requestedBy: "ann" })).toEqual({ ok: false, code: "invalid_value" });
    expect(await requestTier0Change(world({ complete: false }).deps, { scope: PROJECT_SCOPE, value: "two", requestedBy: "ann" })).toEqual({ ok: false, code: "eligibility_unavailable" });
    w.authority.failing = true;
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "two", requestedBy: "ann" })).toEqual({ ok: false, code: "eligibility_unavailable" });
    const a = world();
    a.audit.emit = async () => { throw new Error("audit down"); };
    expect(await requestTier0Change(a.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(a.changes.rows.size).toBe(0);
    const b = world();
    await requestTier0Change(b.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    b.audit.emit = async () => { throw new Error("audit down"); };
    expect(await approveTier0Change(b.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).toEqual({ ok: false, code: "audit_unavailable" });
    expect(b.settings.writes).toEqual([]);
    expect(b.changes.rows.get("chg-1")?.state).toBe("pending");
  });
  it("a failed settings write leaves the stricter value in force", async () => {
    const w = world();
    await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "auto", requestedBy: "ann" });
    w.settings.failWrite = true;
    await expect(approveTier0Change(w.deps, { scope: PROJECT_SCOPE, changeId: "chg-1", approverId: "bob" })).rejects.toThrow();
    expect(w.settings.values.get(scopeId(PROJECT_SCOPE))).toBeUndefined();
  });
  it("tightening is never blocked by an audit outage (the kill switch side)", async () => {
    const w = world();
    w.audit.emit = async () => { throw new Error("audit down"); };
    expect(await requestTier0Change(w.deps, { scope: PROJECT_SCOPE, value: "two", requestedBy: "ann" })).toMatchObject({ ok: true, status: "applied" });
  });
});
