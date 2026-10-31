// Wiring lane B, LR-W3: the stored tier-0 setting, its proposals and the settings reader over the TeamRecord table; the whole path from a loosening request to the effective approval.
import { learningModeKey, learningModeLockKey } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { dynamoLearningSettings, DynamoTier0Settings } from "../../../packages/broker/src/lessons/dynamo-settings.js";
import { approversRequired, resolveLearning } from "../../../packages/broker/src/lessons/policy.js";
import { approveTier0Change, requestTier0Change, type Tier0Deps, type Tier0Scope } from "../../../packages/broker/src/lessons/tier0-setting.js";
import { eraseWorkspace } from "../../../packages/broker/src/team-record/erase.js";
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
  const deps: Tier0Deps = { settings: store, changes: store, audit, authority: { eligibility: async () => group }, now: clock.now, autoApplyEnabled: () => autoEnabled };
  return { w, store, deps, clock, audit, reader: dynamoLearningSettings(w.table, store) };
}

describe("the stored setting and its proposals", () => {
  it("round-trips per scope; another workspace or project sees nothing", async () => {
    const { store } = setup();
    expect(await store.read(project())).toBeUndefined();
    await store.write(project(), "two", { by: "ann", at: 1 });
    await store.write(company(), "one", { by: "owner", at: 1 });
    expect([await store.read(project()), await store.read(company())]).toEqual(["two", "one"]);
    expect(await store.read(project(ORG_B))).toBeUndefined();
    expect(await store.read({ kind: "project", workspaceId: ORG_A, project: "api" })).toBeUndefined();
  });
  it("a stored value that is not valid is an error, never the default", async () => {
    const { store, w } = setup();
    await store.write(project(), "two", { by: "ann", at: 1 });
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
  it("the workspace erase wipes the company setting and the proposals", async () => {
    const { w, store } = setup();
    await store.write(company(), "one", { by: "owner", at: 1 });
    await store.write(project(), "two", { by: "ann", at: 1 });
    await store.create({ id: "c1", scope: company(), from: "one", to: "auto", proposedBy: "ann", at: 1, expiresAt: 100, state: "pending" });
    const result = await eraseWorkspace(deleteDeps(w).deps, ORG_A, ["web"], "close-1");
    expect(result.complete).toBe(true);
    // (The lake delete queue stays until the lake job has run.)
    expect(w.db.find((item) => String(item.pk).startsWith(`WS#${ORG_A}#`) && !String(item.sk).startsWith("LAKEDEL#"))).toEqual([]);
  });
});
