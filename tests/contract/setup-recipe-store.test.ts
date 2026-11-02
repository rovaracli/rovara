// Company setup recipes (SH29 wiring): the DynamoDB adapter. Every write is one transaction with the row, the counters, the dedupe marker, the audit item and (for an approval) the evidence's conditions.
import { describe, expect, it } from "vitest";
import { orgMetaKey, orgPk, SetupRecipeBodySchema, setupFingerprint, setupRecipeDigest, type OrgId, type SetupRecipeBody } from "@agentx/contracts";
import { dynamoSetupRecipeStore, recipeAuditEvent } from "../../packages/broker/src/org/setup-recipe-store.js";
import { SETUP_RECIPES_MAX_PER_ORG, SETUP_RECIPES_MAX_PROPOSED, type RecipeAuditEntry, type StoredLocks, type StoredRecipe } from "../../packages/broker/src/org/setup-recipes.js";
import { secondPersonMembershipCondition } from "../../packages/broker/src/org/second-person-approval.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ADMIN = "a".repeat(64);
const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const AT = new Date(NOW).toISOString();
const cmd = { cwd: "{repo}", executable: "uv", args: ["sync"], timeoutSeconds: 600 };
const body = (label = "Python services"): SetupRecipeBody => SetupRecipeBodySchema.parse({
  schemaVersion: 1, label, buildSystems: ["python"], toolchains: [], setupCommands: [cmd], updateCommands: [],
  checks: [{ id: "unit", label: "Unit tests", command: { ...cmd, executable: "pytest", args: ["-q"] }, kind: "test" }],
  approvedHosts: ["pypi.internal.example.com"], match: { markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"] },
});
let counter = 0;
function recipe(changes: Partial<StoredRecipe> = {}): StoredRecipe {
  counter += 1;
  const made = body(`Recipe ${String(counter)}`);
  return { orgId: ORG, recipeId: `rcp_${counter.toString(16).padStart(20, "0")}`, revision: 1, status: "proposed", body: made, bodyDigest: setupRecipeDigest(made), fingerprint: setupFingerprint(made.match), scope: { kind: "company" }, createdBy: ADMIN, createdAt: AT, updatedAt: AT, ...changes };
}
const entry = (next: StoredRecipe, action: RecipeAuditEntry["action"] = "recipe_proposed"): RecipeAuditEntry => ({ action, orgId: next.orgId, actor: ADMIN, at: AT, proof: "fresh_sign_in", recipeId: next.recipeId, revision: next.revision, bodyDigest: next.bodyDigest });

function bench(options: { noAudit?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db, now: () => NOW });
  const store = dynamoSetupRecipeStore({ documentClient: db as never, tableName: "state", now: () => NOW, ...(options.noAudit === true ? {} : { audit: capture.audit }) });
  return { db, capture, store };
}

describe("recipes", () => {
  it("writes the row and the audit together, reads them back for its own company only, and keeps the audit to ids and digests", async () => {
    const { db, capture, store } = bench();
    const first = recipe();
    expect(await store.commitRecipe(first, null, entry(first))).toBe(true);
    expect(await store.getRecipe(ORG, first.recipeId)).toEqual(first);
    expect(await store.getRecipe(OTHER, first.recipeId)).toBeUndefined();
    expect(await store.listRecipes(OTHER, 10)).toEqual([]);
    expect(await store.listRecipes(ORG, 10, ["approved"])).toEqual([]);
    expect(await store.listRecipes(ORG, 10, ["proposed"])).toEqual([first]);
    expect(db.get(orgPk(ORG), "SETUP_RECIPE_COUNTS")).toMatchObject({ live: 1, proposed: 1 });
    const [event] = capture.recordedBy("setup_recipe.proposed");
    expect(event).toMatchObject({ target: { kind: "org", id: ORG }, actor: { kind: "member", id: ADMIN }, facts: { recipeId: first.recipeId, revision: 1, bodyDigest: first.bodyDigest, authority: "fresh_sign_in" } });
    expect(JSON.stringify(event)).not.toContain("pypi.internal");
    expect(JSON.stringify(event)).not.toContain("Recipe ");
  });

  it("refuses every write when there is no audit ledger, and writes nothing", async () => {
    const { db, store } = bench({ noAudit: true });
    const first = recipe();
    await expect(store.commitRecipe(first, null, entry(first))).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await store.getRecipe(ORG, first.recipeId)).toBeUndefined();
    expect(db.get(orgPk(ORG), "SETUP_RECIPE_COUNTS")).toBeUndefined();
  });

  it("changes a row only from the revision the caller read; a stale or missing revision writes nothing and no audit", async () => {
    const { capture, store } = bench();
    const first = recipe();
    await store.commitRecipe(first, null, entry(first));
    const approved: StoredRecipe = { ...first, status: "approved", revision: 2, approvedBy: ADMIN, approvedAt: AT };
    expect(await store.commitRecipe(approved, 5, entry(approved, "recipe_approved"))).toBe(false);
    expect(await store.commitRecipe({ ...approved, recipeId: "rcp_" + "f".repeat(20) }, 1, entry(approved, "recipe_approved"))).toBe(false);
    expect(await store.commitRecipe(first, null, entry(first))).toBe(false);
    expect(await store.getRecipe(ORG, first.recipeId)).toEqual(first);
    expect(capture.recordedBy("setup_recipe.approved")).toEqual([]);
    expect(await store.commitRecipe(approved, 1, entry(approved, "recipe_approved"))).toBe(true);
    expect(await store.commitRecipe({ ...approved, revision: 3 }, 1, entry(approved, "recipe_approved"))).toBe(false);
  });

  it("counts live recipes with a condition in the transaction: the 200th is the last, a revoked one frees its place, and a revoked row gets a retention time", async () => {
    const { db, store } = bench();
    db.set({ pk: orgPk(ORG), sk: "SETUP_RECIPE_COUNTS", live: SETUP_RECIPES_MAX_PER_ORG - 1, proposed: 0 });
    const last = recipe({ status: "approved", approvedBy: ADMIN, approvedAt: AT });
    expect(await store.commitRecipe(last, null, entry(last, "recipe_created"))).toBe(true);
    const over = recipe({ status: "approved" });
    expect(await store.commitRecipe(over, null, entry(over, "recipe_created"))).toBe(false);
    expect(await store.getRecipe(ORG, over.recipeId)).toBeUndefined();
    const revoked: StoredRecipe = { ...last, status: "revoked", revision: 2 };
    expect(await store.commitRecipe(revoked, 1, entry(revoked, "recipe_revoked"))).toBe(true);
    expect(db.get(orgPk(ORG), "SETUP_RECIPE_COUNTS")).toMatchObject({ live: SETUP_RECIPES_MAX_PER_ORG - 1 });
    expect(db.get(orgPk(ORG), `SETUP_RECIPE#${last.recipeId}`)?.indexExpiresAt).toBeGreaterThan(NOW / 1000 + 300 * 86_400);
    expect(await store.commitRecipe(over, null, entry(over, "recipe_created"))).toBe(true);
  });

  it("caps the recipes waiting for an admin with the same condition", async () => {
    const { db, store } = bench();
    db.set({ pk: orgPk(ORG), sk: "SETUP_RECIPE_COUNTS", live: SETUP_RECIPES_MAX_PROPOSED, proposed: SETUP_RECIPES_MAX_PROPOSED });
    const waiting = recipe();
    expect(await store.commitRecipe(waiting, null, entry(waiting))).toBe(false);
    const approved = recipe({ status: "approved" });
    expect(await store.commitRecipe(approved, null, entry(approved, "recipe_created"))).toBe(true);
  });

  it("keeps one waiting proposal per project and body: a second write of the same proposal is refused, and the place frees when it is decided", async () => {
    const { store } = bench();
    const first = recipe({ proposedFromProjectHash: "1".repeat(32) });
    const again = { ...recipe({ proposedFromProjectHash: "1".repeat(32) }), body: first.body, bodyDigest: first.bodyDigest };
    expect(await store.commitRecipe(first, null, entry(first))).toBe(true);
    expect(await store.commitRecipe(again, null, entry(again))).toBe(false);
    const revoked: StoredRecipe = { ...first, status: "revoked", revision: 2 };
    expect(await store.commitRecipe(revoked, 1, entry(revoked, "recipe_revoked"))).toBe(true);
    expect(await store.commitRecipe(again, null, entry(again))).toBe(true);
  });

  it("does not return a row whose body digest is not its body's", async () => {
    const { db, store } = bench();
    const first = recipe();
    await store.commitRecipe(first, null, entry(first));
    db.set({ ...db.get(orgPk(ORG), `SETUP_RECIPE#${first.recipeId}`)!, bodyDigest: "0".repeat(64) });
    expect(await store.getRecipe(ORG, first.recipeId)).toBeUndefined();
    expect(await store.listRecipes(ORG, 10)).toEqual([]);
  });
});

describe("locks", () => {
  const locks = (changes: Partial<StoredLocks> = {}): StoredLocks => ({ orgId: ORG, revision: 1, locks: { setupAgentOff: true }, updatedBy: ADMIN, updatedAt: AT, ...changes });
  const lockEntry = (next: StoredLocks, action: RecipeAuditEntry["action"] = "locks_changed"): RecipeAuditEntry => ({ action, orgId: ORG, actor: ADMIN, at: AT, proof: "fresh_sign_in", revision: next.revision, previousDigest: "1".repeat(64), nextDigest: "2".repeat(64), loosened: false });

  it("writes only against the revision read, and reads back a damaged row as an error, never as no locks", async () => {
    const { db, store } = bench();
    expect(await store.getLocks(ORG)).toBeUndefined();
    expect(await store.commitLocks(locks(), null, lockEntry(locks()), [])).toBe(true);
    expect(await store.getLocks(ORG)).toEqual(locks());
    expect(await store.commitLocks(locks({ revision: 2 }), null, lockEntry(locks({ revision: 2 })), [])).toBe(false);
    expect(await store.commitLocks(locks({ revision: 2 }), 7, lockEntry(locks({ revision: 2 })), [])).toBe(false);
    expect(await store.getLocks(OTHER)).toBeUndefined();
    db.set({ ...db.get(orgPk(ORG), "SETUP_LOCKS")!, locks: { setupAgentOff: false } });
    await expect(store.getLocks(ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("puts the approval's conditions in the SAME transaction: a changed membership version writes nothing", async () => {
    const { db, capture, store } = bench();
    db.set({ ...orgMetaKey(ORG), approvalMembershipVersion: 7 });
    await store.commitLocks(locks(), null, lockEntry(locks()), []);
    const fence = (version: number) => [{ ConditionCheck: { TableName: "state", Key: orgMetaKey(ORG), ...secondPersonMembershipCondition(version) } }];
    const next = locks({ revision: 2, locks: {} });
    const approval: RecipeAuditEntry = { ...lockEntry(next, "locks_change_approved"), loosened: true, approvalMode: "second_person", membershipVersion: 8 };
    expect(await store.commitLocks(next, 1, approval, fence(8))).toBe(false);
    expect(await store.getLocks(ORG)).toEqual(locks());
    expect(capture.recordedBy("setup_locks.approved")).toEqual([]);
    const sent = db.transactions().at(-1)!;
    expect(sent.some((item) => "ConditionCheck" in item)).toBe(true);
    const approved: RecipeAuditEntry = { ...approval, membershipVersion: 7 };
    expect(await store.commitLocks(next, 1, approved, fence(7))).toBe(true);
    expect(await store.getLocks(ORG)).toEqual(next);
    expect(capture.recordedBy("setup_locks.approved")[0]).toMatchObject({ facts: { loosened: true, approvalMode: "second_person", membershipVersion: 7, revision: 2 } });
  });
});

describe("audit events", () => {
  it("keep their ids apart by recipe, revision and action", () => {
    const first = recipe();
    const one = recipeAuditEvent(entry(first));
    const two = recipeAuditEvent({ ...entry(first), revision: 2 });
    const three = recipeAuditEvent(entry(first, "recipe_revoked"));
    expect(new Set([one.eventId, two.eventId, three.eventId]).size).toBe(3);
    expect(recipeAuditEvent(entry(first)).eventId).toBe(one.eventId);
  });
});
