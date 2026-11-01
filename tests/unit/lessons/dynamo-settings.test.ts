// Wiring lane B, LR-W3: the stored tier-0 setting, its proposals and the settings reader over the TeamRecord table; the whole path from a loosening request to the effective approval.
import { learningModeKey, learningModeLockKey, teamRecordPk } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { dynamoLearningSettings, DynamoTier0Settings } from "../../../packages/broker/src/lessons/dynamo-settings.js";
import { approversRequired, resolveLearning } from "../../../packages/broker/src/lessons/policy.js";
import { approveTier0Change, requestTier0Change, type Tier0Deps, type Tier0Scope } from "../../../packages/broker/src/lessons/tier0-setting.js";
import { eraseWorkspace, erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { ORG_A, ORG_B, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { Audit, Clock } from "./lesson-helpers.js";

const project = (workspaceId = ORG_A): Tier0Scope => ({ kind: "project", workspaceId, project: "web" });
const company = (workspaceId = ORG_A): Tier0Scope => ({ kind: "company", workspaceId });

function setup(autoEnabled = true) {
  const w = world();
  const store = new DynamoTier0Settings(w.table);
  const clock = new Clock();
  const audit = new Audit();
  const group = { complete: true, membershipVersion: 1, ownerIds: ["owner"], eligibleIds: ["owner", "ann", "bob"], lastEligibleLossAtMs: null };
  const deps: Tier0Deps = { settings: store, changes: store, audit, authority: { eligibility: async () => group }, now: clock.now, autoApplyEnabled: () => autoEnabled, soleOwnerLoosening: (workspaceId) => store.soleOwnerLoosening(workspaceId) };
  return { w, store, deps, clock, audit, reader: dynamoLearningSettings(w.table, store) };
}

describe("the stored setting and its proposals", () => {
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
  it("a proposal is claimed once: of two approvers only one moves it", async () => {
    const { store } = setup();
    const change = { id: "c1", scope: project(), from: "one" as const, to: "auto" as const, proposedBy: "ann", at: 1, expiresAt: 100, state: "pending" as const };
    expect(await store.create(change)).toBe(true);
    expect(await store.create(change)).toBe(false);
    expect(await store.open(project(), 50)).toMatchObject({ id: "c1" });
    expect(await store.open(project(), 100)).toBeUndefined();
    expect(await Promise.all([store.transition(project(), "c1", "pending", "applied"), store.transition(project(), "c1", "pending", "applied")])).toEqual([true, false]);
    expect(await store.open(project(), 50)).toBeUndefined();
    expect(await store.get(project(), "c1")).toMatchObject({ state: "applied" });
    expect(await store.get(project(ORG_B), "c1")).toBeUndefined();
  });
});

describe("a proposal remembers whether its proposer was the only eligible person", () => {
  it("the flag round-trips; an older row without it reads as absent", async () => {
    const { w, store } = setup();
    await store.create({ id: "c1", scope: company(), from: "two", to: "one", proposedBy: "owner", at: 1, expiresAt: 100, state: "pending", soleEligibleAtProposal: true });
    expect(await store.get(company(), "c1")).toMatchObject({ soleEligibleAtProposal: true });
    w.db.set({ pk: teamRecordPk(ORG_A, undefined), sk: "LESSONSET#TIER0CHG#old", entityType: "LESSON_TIER0_CHANGE", id: "old", scope: company(), from: "two", to: "one", proposedBy: "owner", at: 1, expiresAt: 100, state: "pending" });
    expect((await store.get(company(), "old"))?.soleEligibleAtProposal).toBeUndefined();
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
    const { w, store } = setup();
    expect(await store.soleOwnerLoosening(ORG_A)).toBe(true);
    await store.setSoleOwnerLoosening(ORG_A, false, 1);
    expect(await store.soleOwnerLoosening(ORG_A)).toBe(false);
    expect(await store.soleOwnerLoosening(ORG_B)).toBe(true);
    await store.setSoleOwnerLoosening(ORG_A, true, 2);
    expect(await store.soleOwnerLoosening(ORG_A)).toBe(true);
    w.db.set({ pk: teamRecordPk(ORG_B, undefined), sk: "LESSONSET#COMPANYSOLE", entityType: "LESSON_SOLE_OWNER_SETTING", enabled: "no" });
    await expect(store.soleOwnerLoosening(ORG_B)).rejects.toThrow();
  });
  it("writing it does not disturb the company floor, and the workspace erase wipes it", async () => {
    const { w, store } = setup();
    await store.write(company(), "two", { by: "owner", at: 1 }, "auto");
    await store.setSoleOwnerLoosening(ORG_A, false, 2);
    await store.write(company(), "one", { by: "owner", at: 3 }, "two").catch(() => false);
    expect(await store.read(company())).toBe("one");
    expect(await store.soleOwnerLoosening(ORG_A)).toBe(false);
    expect((await eraseWorkspace(deleteDeps(w).deps, ORG_A, [], "close-sole")).complete).toBe(true);
    expect(w.db.find((item) => String(item.pk).startsWith(`WS#${ORG_A}#`) && !String(item.sk).startsWith("LAKEDEL#"))).toEqual([]);
  });
  it("the whole path: a sole admin loosens alone through the stored switch; switched off it is refused", async () => {
    const { store, deps, clock } = setup();
    const solo = { ...deps, authority: { eligibility: async () => ({ complete: true, membershipVersion: 1, ownerIds: ["owner"], eligibleIds: ["owner"], lastEligibleLossAtMs: null }) } };
    await requestTier0Change(solo, { scope: company(), value: "two", requestedBy: "owner" });
    expect(await requestTier0Change(solo, { scope: company(), value: "one", requestedBy: "owner" })).toMatchObject({ status: "needs_approval" });
    await store.setSoleOwnerLoosening(ORG_A, false, clock.now());
    const pending = await store.open(company(), clock.now());
    expect(await approveTier0Change(solo, { scope: company(), changeId: pending!.id, approverId: "owner" })).toEqual({ ok: false, code: "second_person_required" });
    await store.setSoleOwnerLoosening(ORG_A, true, clock.now());
    expect(await approveTier0Change(solo, { scope: company(), changeId: pending!.id, approverId: "owner" })).toEqual({ ok: true, value: "one" });
    expect(await store.read(company())).toBe("one");
  });
});

describe("the whole path, through the settings reader", () => {
  it("a project with nothing set needs a person for tier 0; the record core's default mode is Suggest", async () => {
    const { reader } = setup();
    const resolved = await resolveLearning(reader, ORG_A, "web");
    expect(resolved.mode).toBe("Suggest");
    expect(approversRequired(0, resolved.approval)).toBe(1);
  });
  it("auto-apply only after a second person approves, and a company floor holds it down", async () => {
    const { reader, deps } = setup();
    await requestTier0Change(deps, { scope: project(), value: "auto", requestedBy: "ann" });
    expect(approversRequired(0, (await resolveLearning(reader, ORG_A, "web")).approval)).toBe(1);
    await approveTier0Change(deps, { scope: project(), changeId: (await deps.changes.open(project(), deps.now()))!.id, approverId: "bob" });
    expect(approversRequired(0, (await resolveLearning(reader, ORG_A, "web")).approval)).toBe(0);
    await requestTier0Change(deps, { scope: company(), value: "one", requestedBy: "owner" });
    expect(approversRequired(0, (await resolveLearning(reader, ORG_A, "web")).approval)).toBe(1);
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
  it("a project with more than 1000 set snapshots still gets its proposals' proposer replaced (the snapshots sort ahead of the proposals)", async () => {
    const { w, store } = setup();
    await store.create({ id: "c1", scope: project(), from: "two", to: "one", proposedBy: "dev-ann", at: 1, expiresAt: 100, state: "pending" });
    for (let version = 1; version <= 1_200; version += 1) w.db.set({ pk: `WS#${ORG_A}#P#web`, sk: `LESSONSET#SNAP#${String(version).padStart(12, "0")}`, entityType: "LESSON_SNAPSHOT", setVersion: version, at: version, members: [] });
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-ann" }, "e9");
    expect(await store.get(project(), "c1")).toMatchObject({ proposedBy: "0".repeat(64) });
  });
  it("erasing a person replaces them on the settings and proposal rows (project and company) with the stand-in id, and keeps everyone else", async () => {
    const { w, store } = setup();
    await store.write(project(), "two", { by: "dev-ann", at: 1 }, "one");
    await store.write(company(), "one", { by: "dev-ann", at: 1 }, "auto");
    await store.create({ id: "c1", scope: project(), from: "two", to: "one", proposedBy: "dev-ann", at: 1, expiresAt: 100, state: "pending" });
    await store.create({ id: "c2", scope: company(), from: "one", to: "auto", proposedBy: "dev-bob", at: 1, expiresAt: 100, state: "pending" });
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-ann" }, "e1");
    const dump = JSON.stringify(w.db.find((item) => String(item.pk).startsWith(`WS#${ORG_A}#`) && !String(item.sk).startsWith("LAKEDEL#") && !String(item.sk).startsWith("ERASE")));
    expect(dump).not.toContain("dev-ann");
    expect(dump).toContain("dev-bob");
    expect(await store.read(project())).toBe("two");
    expect(await store.get(project(), "c1")).toMatchObject({ proposedBy: "0".repeat(64), state: "pending" });
  });
  it("the workspace erase wipes the company setting and the proposals", async () => {
    const { w, store } = setup();
    await store.write(company(), "one", { by: "owner", at: 1 }, "auto");
    await store.write(project(), "two", { by: "ann", at: 1 }, "one");
    await store.create({ id: "c1", scope: company(), from: "one", to: "auto", proposedBy: "ann", at: 1, expiresAt: 100, state: "pending" });
    const result = await eraseWorkspace(deleteDeps(w).deps, ORG_A, ["web"], "close-1");
    expect(result.complete).toBe(true);
    // (The lake delete queue stays until the lake job has run.)
    expect(w.db.find((item) => String(item.pk).startsWith(`WS#${ORG_A}#`) && !String(item.sk).startsWith("LAKEDEL#"))).toEqual([]);
  });
});
