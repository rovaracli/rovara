// Company setup recipes (SH29 wiring): the DynamoDB adapter. Every write is one transaction with the row, the counters, the dedupe marker and the audit item. (The company locks are su-musts'.)
import { describe, expect, it } from "vitest";
import { orgPk, SetupRecipeBodySchema, setupFingerprint, setupRecipeDigest, type OrgId, type SetupRecipeBody } from "@rovara-code/contracts";
import { dynamoSetupRecipeStore, recipeAuditEvent } from "../../packages/broker/src/org/setup-recipe-store.js";
import { SETUP_RECIPES_MAX_PER_ORG, SETUP_RECIPES_MAX_PROPOSED, type RecipeAuditEntry, type StoredRecipe } from "../../packages/broker/src/org/setup-recipes.js";
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
  const store = dynamoSetupRecipeStore({ documentClient: db, tableName: "state", now: () => NOW, ...(options.noAudit === true ? {} : { audit: capture.audit }) });
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
    expect(db.get(orgPk(ORG), `SETUP_RECIPE_REVOKED#${last.recipeId}`)?.indexExpiresAt).toBeGreaterThan(NOW / 1000 + 300 * 86_400);
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

describe("history (F3)", () => {
  const live = (db: FakeDynamoDb) => db.find((item) => String(item.sk).startsWith("SETUP_RECIPE#"));
  const history = (db: FakeDynamoDb) => db.find((item) => String(item.sk).startsWith("SETUP_RECIPE_REVOKED#"));

  it("moves a revoked or rejected recipe to its own partition in the same transaction: the live rows no longer hold it, and it is still readable by id", async () => {
    const { db, store } = bench();
    const keep = recipe({ status: "approved", approvedBy: ADMIN, approvedAt: AT });
    const gone = recipe();
    await store.commitRecipe(keep, null, entry(keep, "recipe_created"));
    await store.commitRecipe(gone, null, entry(gone));
    const revoked: StoredRecipe = { ...gone, status: "revoked", revision: 2 };
    expect(await store.commitRecipe(revoked, 1, entry(revoked, "recipe_revoked"))).toBe(true);
    expect(live(db).map((item) => item.recipeId)).toEqual([keep.recipeId]);
    expect(history(db).map((item) => item.recipeId)).toEqual([gone.recipeId]);
    expect(await store.getRecipe(ORG, gone.recipeId)).toEqual(revoked);
    expect((await store.listRecipes(ORG, 10, ["proposed", "approved"])).map((item) => item.recipeId)).toEqual([keep.recipeId]);
    expect((await store.listRecipes(ORG, 10, ["revoked"])).map((item) => item.recipeId)).toEqual([gone.recipeId]);
    expect((await store.listRecipes(ORG, 10)).map((item) => item.recipeId).sort()).toEqual([keep.recipeId, gone.recipeId].sort());
    // A later change to history stays in history, at the revision read; history never comes back to life.
    const scoped: StoredRecipe = { ...revoked, revision: 3, scope: { kind: "projects", projects: ["orders"] } };
    expect(await store.commitRecipe(scoped, 2, entry(scoped, "recipe_scope_changed"))).toBe(true);
    expect(await store.commitRecipe({ ...revoked, status: "approved", revision: 4 }, 3, entry(scoped, "recipe_approved"))).toBe(false);
    expect(live(db)).toHaveLength(1);
  });

  it("a live listing reads no history: a long history neither slows nor breaks it, and a history listing never throws on its size", async () => {
    const { db, store } = bench();
    const keep = recipe({ status: "approved" });
    await store.commitRecipe(keep, null, entry(keep, "recipe_created"));
    for (let index = 0; index < 1200; index += 1) {
      const old = recipe({ status: "revoked", revision: 2 });
      db.set({ ...old, pk: orgPk(ORG), sk: `SETUP_RECIPE_REVOKED#${old.recipeId}`, entityType: "SETUP_RECIPE" });
    }
    const before = db.transactions().length;
    expect((await store.listRecipes(ORG, 250, ["proposed", "approved"])).map((item) => item.recipeId)).toEqual([keep.recipeId]);
    expect((await store.listRecipes(ORG, 1000, ["revoked"])).length).toBeGreaterThan(0);
    expect((await store.listRecipes(ORG, 1000)).length).toBeGreaterThan(1);
    expect(db.transactions().length).toBe(before);
  });
});

describe("a damaged row (F9)", () => {
  it("can be removed by its key: its counter slot, dedupe marker and place in the live partition are freed, and it is audited", async () => {
    const { db, capture, store } = bench();
    const waiting = recipe({ proposedFromProjectHash: "2".repeat(32) });
    await store.commitRecipe(waiting, null, entry(waiting));
    const other = recipe({ status: "approved" });
    await store.commitRecipe(other, null, entry(other, "recipe_created"));
    db.set({ ...db.get(orgPk(ORG), `SETUP_RECIPE#${waiting.recipeId}`)!, body: { not: "a recipe" } });
    expect(await store.getRecipe(ORG, waiting.recipeId)).toBeUndefined();
    expect(await store.unreadableIds?.(ORG)).toEqual([waiting.recipeId]);
    expect(db.get(orgPk(ORG), "SETUP_RECIPE_COUNTS")).toMatchObject({ live: 2, proposed: 1 });
    expect(await store.revokeUnreadable?.(ORG, waiting.recipeId, { ...entry(waiting, "recipe_revoked"), revision: 2 })).toBe(true);
    expect(db.get(orgPk(ORG), `SETUP_RECIPE#${waiting.recipeId}`)).toBeUndefined();
    expect(db.get(orgPk(ORG), `SETUP_RECIPE_REVOKED#${waiting.recipeId}`)).toMatchObject({ status: "revoked", unreadable: true });
    expect(db.get(orgPk(ORG), "SETUP_RECIPE_COUNTS")).toMatchObject({ live: 1, proposed: 0 });
    expect(await store.unreadableIds?.(ORG)).toEqual([]);
    expect(capture.recordedBy("setup_recipe.revoked")).toHaveLength(1);
    // Nothing to remove the second time, and a readable row is not this method's.
    expect(await store.revokeUnreadable?.(ORG, waiting.recipeId, entry(waiting, "recipe_revoked"))).toBe(false);
    expect(await store.revokeUnreadable?.(ORG, other.recipeId, entry(other, "recipe_revoked"))).toBe(false);
    expect(await store.getRecipe(ORG, other.recipeId)).toEqual(other);
  });

  it("is removed even when the counter has drifted to zero (the row must not outlive a wrong counter)", async () => {
    const { db, store } = bench();
    const stuck = recipe();
    await store.commitRecipe(stuck, null, entry(stuck));
    db.set({ ...db.get(orgPk(ORG), `SETUP_RECIPE#${stuck.recipeId}`)!, body: 7 });
    db.set({ pk: orgPk(ORG), sk: "SETUP_RECIPE_COUNTS", live: 0, proposed: 0 });
    expect(await store.revokeUnreadable?.(ORG, stuck.recipeId, entry(stuck, "recipe_revoked"))).toBe(true);
    expect(db.get(orgPk(ORG), "SETUP_RECIPE_COUNTS")).toMatchObject({ live: 0, proposed: 0 });
  });

  it("another company's key is not reachable", async () => {
    const { db, store } = bench();
    const stuck = recipe();
    await store.commitRecipe(stuck, null, entry(stuck));
    db.set({ ...db.get(orgPk(ORG), `SETUP_RECIPE#${stuck.recipeId}`)!, body: 7 });
    expect(await store.revokeUnreadable?.(OTHER, stuck.recipeId, { ...entry(stuck, "recipe_revoked"), orgId: OTHER })).toBe(false);
    expect(await store.unreadableIds?.(OTHER)).toEqual([]);
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
