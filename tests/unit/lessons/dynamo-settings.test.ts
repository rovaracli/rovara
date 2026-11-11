// Wiring lane B, LR-W3: the stored tier-0 setting (read only in production since lessons connect fix 1), the sole-owner switch and its proposals, and the settings reader over the TeamRecord table.
import { learningModeKey, learningModeLockKey, teamRecordPk } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { dynamoLearningSettings, DynamoPresetStore, DynamoSoleOwnerSwitch, DynamoTier0Settings } from "../../../packages/broker/src/lessons/dynamo-settings.js";
import { approversRequired, resolveLearning } from "../../../packages/broker/src/lessons/policy.js";
import { approveSoleOwnerSwitch, setSoleOwnerSwitch, type SoleOwnerSwitchDeps, type Tier0Scope } from "../../../packages/broker/src/lessons/sole-owner-switch.js";
import { eraseWorkspace, erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { ORG_A, ORG_B, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { Audit, Clock } from "./lesson-helpers.js";

const project = (workspaceId = ORG_A): Tier0Scope => ({ kind: "project", workspaceId, project: "web" });
const company = (workspaceId = ORG_A): Tier0Scope => ({ kind: "company", workspaceId });

function setup() {
  const w = world();
  const store = new DynamoTier0Settings(w.table);
  const sole = new DynamoSoleOwnerSwitch(w.table);
  const clock = new Clock();
  const audit = new Audit();
  const group = { complete: true, membershipVersion: 1, ownerIds: ["owner"], eligibleIds: ["owner", "ann", "bob"], lastEligibleLossAtMs: null };
  const authority = { eligibility: async () => group };
  return { w, store, sole, authority, clock, audit, reader: dynamoLearningSettings(w.table, store) };
}

describe("the stored setting", () => {
  it("round-trips per scope; another workspace or project sees nothing", async () => {
    const { store } = setup();
    expect(await store.read(project())).toBeUndefined();
    await store.write(project(), "two", { by: "ann", at: 1 }, "one");
    await store.write(company(), "one", { by: "owner", at: 1 }, "auto");
    expect([await store.read(project()), await store.read(company())]).toEqual(["two", "one"]);
    expect(await store.read(project(ORG_B))).toBeUndefined();
    expect(await store.read({ kind: "project", workspaceId: ORG_A, project: "api" })).toBeUndefined();
  });
  it("a conditional write: absent means the default, a different current value is refused", async () => {
    const { store } = setup();
    expect(await store.write(project(), "two", { by: "ann", at: 1 }, "auto")).toBe(false);
    expect(await store.write(project(), "two", { by: "ann", at: 1 }, "one")).toBe(true);
    expect(await store.write(project(), "one", { by: "bob", at: 2 }, "one")).toBe(false);
    expect(await store.read(project())).toBe("two");
    expect(await store.write(company(), "one", { by: "owner", at: 1 }, "auto")).toBe(true);
    expect(await store.write(company(), "auto", { by: "owner", at: 1 }, "two")).toBe(false);
    expect(await store.write(project(), "one", { by: "bob", at: 3 }, "two")).toBe(true);
  });
  it("a stored value that is not valid is an error, never the default", async () => {
    const { store, w } = setup();
    await store.write(project(), "two", { by: "ann", at: 1 }, "one");
    w.db.set({ ...w.db.find((i) => i.entityType === "LESSON_SETTINGS")[0]!, tier0: "loose" });
    await expect(store.read(project())).rejects.toThrow();
  });
});

describe("the fenced write", () => {
  const metaCheck = (version: number) => ({ ConditionCheck: { TableName: "TeamRecord", Key: { pk: teamRecordPk(ORG_A, undefined), sk: "FENCE#META" }, ConditionExpression: "approvalMembershipVersion = :v", ExpressionAttributeValues: { ":v": version } } });
  it("commits the setting together with the membership conditions; a changed membership writes nothing", async () => {
    const { w, store } = setup();
    w.db.set({ pk: teamRecordPk(ORG_A, undefined), sk: "FENCE#META", approvalMembershipVersion: 4 });
    expect(await store.write(company(), "two", { by: "owner", at: 1 }, "auto", { membershipVersion: 3, conditions: [metaCheck(3)] })).toBe(false);
    expect(await store.read(company())).toBeUndefined();
    expect(await store.write(company(), "two", { by: "owner", at: 1 }, "auto", { membershipVersion: 4, conditions: [metaCheck(4)] })).toBe(true);
    expect(await store.read(company())).toBe("two");
    // a stale value is still refused inside the transaction
    expect(await store.write(company(), "one", { by: "owner", at: 2 }, "auto", { membershipVersion: 4, conditions: [metaCheck(4)] })).toBe(false);
    expect(await store.read(company())).toBe("two");
  });
});

describe("the company sole-owner switch", () => {
  it("is ON until set, per workspace, and an invalid stored value is an error (the caller treats it as OFF)", async () => {
    const { w, sole } = setup();
    expect(await sole.read(ORG_A)).toBe(true);
    expect(await sole.write(ORG_A, false, { by: "owner", at: 1 }, true)).toBe(true);
    expect(await sole.read(ORG_A)).toBe(false);
    expect(await sole.read(ORG_B)).toBe(true);
    // conditional on the value read: a stale `from` writes nothing
    expect(await sole.write(ORG_A, true, { by: "owner", at: 2 }, true)).toBe(false);
    expect(await sole.write(ORG_A, true, { by: "owner", at: 2 }, false)).toBe(true);
    expect(await sole.read(ORG_A)).toBe(true);
    w.db.set({ pk: teamRecordPk(ORG_B, undefined), sk: "LESSONSET#COMPANYSOLE", entityType: "LESSON_SOLE_OWNER_SETTING", enabled: "no" });
    await expect(sole.read(ORG_B)).rejects.toThrow();
  });
  it("writing it does not disturb the company floor, and the workspace erase wipes it and its proposals", async () => {
    const { w, store, sole } = setup();
    await store.write(company(), "two", { by: "owner", at: 1 }, "auto");
    await sole.write(ORG_A, false, { by: "owner", at: 2 }, true);
    await sole.create({ id: "s1", workspaceId: ORG_A, from: false, to: true, proposedBy: "owner", at: 1, expiresAt: 100, state: "pending" });
    expect(await store.read(company())).toBe("two");
    expect(await sole.read(ORG_A)).toBe(false);
    expect((await eraseWorkspace(deleteDeps(w).deps, ORG_A, [], "close-sole")).complete).toBe(true);
    expect(w.db.find((item) => String(item.pk).startsWith(`WS#${ORG_A}#`) && !String(item.sk).startsWith("LAKEDEL#"))).toEqual([]);
  });
  it("the person erase replaces the proposer on a switch proposal", async () => {
    const { w, sole } = setup();
    await sole.create({ id: "s1", workspaceId: ORG_A, from: false, to: true, proposedBy: "dev-ann", at: 1, expiresAt: 100, state: "pending" });
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-ann" }, "e-sole");
    expect(await sole.get(ORG_A, "s1")).toMatchObject({ proposedBy: "0".repeat(64), state: "pending" });
  });
  it("the whole path: switched off the exception is refused for a sole admin, and it comes back ON only through a second admin", async () => {
    const { sole, authority, clock, audit } = setup();
    const one = { complete: true, membershipVersion: 1, ownerIds: ["owner"], eligibleIds: ["owner"], lastEligibleLossAtMs: null };
    const switchDeps: SoleOwnerSwitchDeps = { store: sole, audit, authority: { eligibility: async () => one }, now: clock.now };
    expect(await setSoleOwnerSwitch(switchDeps, { workspaceId: ORG_A, enabled: false, requestedBy: "owner" })).toEqual({ ok: true, status: "applied", enabled: false });
    // back ON: a proposal; the proposer alone cannot approve it, even as the only admin
    const back = await setSoleOwnerSwitch(switchDeps, { workspaceId: ORG_A, enabled: true, requestedBy: "owner" });
    expect(back).toMatchObject({ ok: true, status: "needs_approval" });
    const changeId = (back as { changeId: string }).changeId;
    expect(await approveSoleOwnerSwitch(switchDeps, { workspaceId: ORG_A, changeId, approverId: "owner" })).toEqual({ ok: false, code: "second_person_required" });
    expect(await sole.read(ORG_A)).toBe(false);
    expect(authority).toBeDefined();
    const two = { ...one, eligibleIds: ["owner", "ann"] };
    const withAnn = { ...switchDeps, authority: { eligibility: async () => two } };
    expect(await approveSoleOwnerSwitch(withAnn, { workspaceId: ORG_A, changeId, approverId: "ann" })).toEqual({ ok: true, enabled: true });
    expect(await sole.read(ORG_A)).toBe(true);
  });
});

describe("the whole path, through the settings reader", () => {
  it("a project with nothing set needs a person for tier 0; the record core's default mode is Suggest", async () => {
    const { reader } = setup();
    const resolved = await resolveLearning(reader, ORG_A, "web");
    expect(resolved.mode).toBe("Suggest");
    expect(approversRequired(0, resolved.approval)).toBe(1);
  });
  it("the stored tier-0 setting and the company floor are still read: a stored project value, and a floor that holds it down", async () => {
    const { reader, store } = setup();
    await store.write(project(), "two", { by: "ann", at: 1 }, "one");
    expect(approversRequired(0, (await resolveLearning(reader, ORG_A, "web")).approval)).toBe(2);
    await store.write(company(), "one", { by: "owner", at: 1 }, "auto");
    await store.write(project(), "auto", { by: "ann", at: 2 }, "two");
    expect((await resolveLearning(reader, ORG_A, "web")).approval.tier0).toBe("one");
  });
  it("the project mode and the company lock are read, and an invalid or unreadable one is Off", async () => {
    const { reader, w } = setup();
    w.db.set({ ...learningModeKey(ORG_A, "web"), entityType: "TEAM_RECORD_MODE", mode: "on" });
    expect((await resolveLearning(reader, ORG_A, "web")).mode).toBe("On");
    w.db.set({ ...learningModeLockKey(ORG_A), entityType: "TEAM_RECORD_MODE_LOCK", mode: "collect" });
    expect((await resolveLearning(reader, ORG_A, "web")).mode).toBe("Collect");
    w.db.set({ ...learningModeKey(ORG_A, "web"), entityType: "TEAM_RECORD_MODE", mode: "banana" });
    expect((await resolveLearning(reader, ORG_A, "web")).mode).toBe("Off");
    const broken = dynamoLearningSettings({ documentClient: { send: async () => { throw new Error("down"); } }, tableName: "x" }, new DynamoTier0Settings(w.table));
    expect((await resolveLearning(broken, ORG_A, "web")).mode).toBe("Off");
  });
});

describe("erasing", () => {
  it("a project with more than 1000 set snapshots still gets a proposal's proposer replaced (the snapshots sort ahead of the proposals)", async () => {
    const { w, sole } = setup();
    await sole.create({ id: "c1", workspaceId: ORG_A, from: false, to: true, proposedBy: "dev-ann", at: 1, expiresAt: 100, state: "pending" });
    for (let version = 1; version <= 1_200; version += 1) w.db.set({ pk: `WS#${ORG_A}#P#web`, sk: `LESSONSET#SNAP#${String(version).padStart(12, "0")}`, entityType: "LESSON_SNAPSHOT", setVersion: version, at: version, members: [] });
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-ann" }, "e9");
    expect(await sole.get(ORG_A, "c1")).toMatchObject({ proposedBy: "0".repeat(64) });
  });
  it("erasing a person replaces them on the settings and proposal rows (project and company) with the stand-in id, and keeps everyone else", async () => {
    const { w, store, sole } = setup();
    await store.write(project(), "two", { by: "dev-ann", at: 1 }, "one");
    await store.write(company(), "one", { by: "dev-ann", at: 1 }, "auto");
    await sole.create({ id: "c1", workspaceId: ORG_A, from: false, to: true, proposedBy: "dev-ann", at: 1, expiresAt: 100, state: "pending" });
    await sole.create({ id: "c2", workspaceId: ORG_A, from: false, to: true, proposedBy: "dev-bob", at: 1, expiresAt: 100, state: "pending" });
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-ann" }, "e1");
    const dump = JSON.stringify(w.db.find((item) => String(item.pk).startsWith(`WS#${ORG_A}#`) && !String(item.sk).startsWith("LAKEDEL#") && !String(item.sk).startsWith("ERASE")));
    expect(dump).not.toContain("dev-ann");
    expect(dump).toContain("dev-bob");
    expect(await store.read(project())).toBe("two");
    expect(await sole.get(ORG_A, "c1")).toMatchObject({ proposedBy: "0".repeat(64), state: "pending" });
  });
  it("the workspace erase wipes the company setting and the proposals", async () => {
    const { w, store, sole } = setup();
    await store.write(company(), "one", { by: "owner", at: 1 }, "auto");
    await store.write(project(), "two", { by: "ann", at: 1 }, "one");
    await sole.create({ id: "c1", workspaceId: ORG_A, from: false, to: true, proposedBy: "ann", at: 1, expiresAt: 100, state: "pending" });
    const result = await eraseWorkspace(deleteDeps(w).deps, ORG_A, ["web"], "close-1");
    expect(result.complete).toBe(true);
    // (The lake delete queue stays until the lake job has run.)
    expect(w.db.find((item) => String(item.pk).startsWith(`WS#${ORG_A}#`) && !String(item.sk).startsWith("LAKEDEL#"))).toEqual([]);
  });
});

describe("the learning preset (Standard / Regulated) on its own items", () => {
  it("is read by the settings reader at project and company level, resolves to the stricter, and a tier-0 write never replaces it", async () => {
    const { w, store, reader } = setup();
    const presets = new DynamoPresetStore(w.table);
    expect((await resolveLearning(reader, ORG_A, "web")).preset).toBe("standard");
    expect(await presets.write({ kind: "company", workspaceId: ORG_A }, "regulated", { by: "owner", at: 1 }, "standard")).toBe(true);
    expect((await resolveLearning(reader, ORG_A, "web")).preset).toBe("regulated");
    expect((await resolveLearning(reader, ORG_B, "web")).preset).toBe("standard");
    expect(await presets.write(project(), "regulated", { by: "ann", at: 2 }, "standard")).toBe(true);
    await store.write(project(), "two", { by: "ann", at: 3 }, "one");
    expect(await presets.read(project())).toBe("regulated");
    expect(await reader.read(ORG_A, "web")).toMatchObject({ preset: "regulated", companyPreset: "regulated" });
  });
  it("holds no person (the erase has nothing to rewrite), lives under the LESSONSET prefix the project and workspace erase wipe, and an invalid stored value fails closed to Off", async () => {
    const { w, reader } = setup();
    const presets = new DynamoPresetStore(w.table);
    await presets.write(project(), "regulated", { by: "ann", at: 2 }, "standard");
    const item = w.db.find((i) => i.entityType === "LESSON_PRESET")[0]!;
    expect(String(item.sk)).toMatch(/^LESSONSET#/u);
    expect(JSON.stringify(item)).not.toMatch(/updatedBy|ann|owner/u);
    w.db.set({ ...item, preset: "loose" });
    await expect(presets.read(project())).rejects.toThrow();
    expect(await resolveLearning(reader, ORG_A, "web")).toMatchObject({ mode: "Off", preset: "regulated" });
  });
});

describe("the preset's conditional write and its loosening proposals", () => {
  it("writes only against the value it read (an absent item is Standard), so a stricter write made in between is never overwritten", async () => {
    const { w } = setup();
    const presets = new DynamoPresetStore(w.table);
    expect(await presets.write(project(), "regulated", { by: "ann", at: 1 }, "regulated")).toBe(false);
    expect(await presets.write(project(), "regulated", { by: "ann", at: 1 }, "standard")).toBe(true);
    expect(await presets.write(project(), "standard", { by: "bob", at: 2 }, "standard")).toBe(false);
    expect(await presets.read(project())).toBe("regulated");
    expect(await presets.write(project(), "standard", { by: "bob", at: 2 }, "regulated")).toBe(true);
    expect(await presets.read(project())).toBe("standard");
  });
  it("proposals are stored under the prefix the person erase rewrites and move state once", async () => {
    const { w } = setup();
    const presets = new DynamoPresetStore(w.table);
    const change = { id: "pc1", scope: project(), from: "regulated" as const, to: "standard" as const, proposedBy: "ann", at: 1, expiresAt: 100, state: "pending" as const, soleEligibleAtProposal: false };
    expect(await presets.create(change)).toBe(true);
    expect(await presets.create(change)).toBe(false);
    const row = w.db.find((i) => i.entityType === "LESSON_PRESET_CHANGE")[0]!;
    expect(String(row.sk)).toMatch(/^LESSONSET#TIER0CHG#PRESET#/u);
    expect(await presets.open(project(), 50)).toMatchObject({ id: "pc1", proposedBy: "ann" });
    expect(await presets.open(project(), 200)).toBeUndefined();
    expect(await presets.transition(project(), "pc1", "pending", "applied")).toBe(true);
    expect(await presets.transition(project(), "pc1", "pending", "cancelled")).toBe(false);
    expect(await presets.open(project(), 50)).toBeUndefined();
  });
});

