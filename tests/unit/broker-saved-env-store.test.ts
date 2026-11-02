// Saved project images (SV wiring): the DynamoDB adapter of the registry's store. One row per project, written with the audit event in ONE transaction, fenced by the row's version; deleted projects are found
// through the sparse due index until their registry deletion is final.
import { describe, expect, it } from "vitest";
import { WORKFLOW_DISPATCH_DUE_INDEX, orgPk, type OrgId, type SavedEnvManifest } from "@agentx/contracts";
import { SAVED_ENV_JOB_LEASE_MS, type SavedEnvAuditEntry, type SavedEnvImageRecord, type SavedEnvState } from "../../packages/broker/src/test-env/saved-env.js";
import { SAVED_ENV_PURGE_PARTITION, dynamoSavedEnvStore } from "../../packages/broker/src/test-env/saved-env-store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const AT = new Date(NOW).toISOString();
const DIGEST = `sha256:${"1".repeat(64)}`;
const LEASE_TOKEN = "lease-secret-token-0123456789abcdef";

function bench(options: { noAudit?: boolean; now?: () => number } = {}) {
  const clock = { now: options.now ?? (() => NOW) };
  const db = new FakeDynamoDb({ indexKeys: { [WORKFLOW_DISPATCH_DUE_INDEX.name]: { partition: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, sort: WORKFLOW_DISPATCH_DUE_INDEX.sortKey } } });
  const capture = capturingAuditDeps({ db, now: () => NOW });
  const store = dynamoSavedEnvStore({ documentClient: db, tableName: "state", now: () => clock.now(), ...(options.noAudit === true ? {} : { audit: capture.audit }) });
  return { db, capture, store, clock };
}
const manifest = (): SavedEnvManifest => ({ schemaVersion: 1, environmentKey: "c".repeat(64), testEnvRevision: 4, commits: [{ repositoryId: "svc", sha: "f".repeat(40) }], proveReportDigest: "b".repeat(64), imageDigest: DIGEST, builtAt: AT });
const image = (): SavedEnvImageRecord => ({ approved: { revision: 4, digest: "a".repeat(64) }, digest: DIGEST, tag: "kcccc-1", manifest: manifest(), recordedAt: AT, status: "ready" });
const state = (changes: Partial<SavedEnvState> = {}): SavedEnvState => ({ orgId: ORG, projectId: "web", version: 1, enabled: true, images: [], health: "never_proved", ...changes });
const entry = (action: SavedEnvAuditEntry["action"] = "rebuild_queued", extra: Partial<SavedEnvAuditEntry> = {}): SavedEnvAuditEntry => ({ action, orgId: ORG, projectId: "web", at: AT, ...extra });

describe("the row", () => {
  it("writes the row and its audit event together and reads it back for its own company only", async () => {
    const { db, capture, store } = bench();
    const job = { jobId: "job1", leaseToken: LEASE_TOKEN, reason: "no_image" as const, approved: { revision: 4, digest: "a".repeat(64) }, commits: { svc: "f".repeat(40) }, expectedKey: "c".repeat(64), createdAt: AT, leaseUntil: new Date(NOW + 1000).toISOString() };
    const first = state({ images: [image()], job });
    expect(await store.commit(first, null, entry("rebuild_queued", { reason: "no_image" }))).toBe(true);
    expect(await store.get(ORG, "web")).toEqual(first);
    expect(await store.get(OTHER, "web")).toBeUndefined();
    expect(db.get(orgPk(ORG), "SAVED_ENV#web")).toMatchObject({ version: 1, entityType: "SAVED_ENV" });
    const [event] = capture.recordedBy("saved_env.changed");
    expect(event).toMatchObject({ target: { kind: "project", name: "web" }, actor: { kind: "system", id: "rovara" }, facts: { change: "rebuild_queued", cause: "no_image" } });
    // the ledger holds fixed words and a digest: never the job's lease token
    expect(JSON.stringify(event)).not.toContain(LEASE_TOKEN);
  });

  it("names the person who pressed Reset as the actor", async () => {
    const { capture, store } = bench();
    await store.commit(state({ resetRequested: true }), null, entry("reset_requested", { actor: "dev_1" }));
    expect(capture.recordedBy("saved_env.changed")[0]).toMatchObject({ actor: { kind: "member", id: "dev_1" }, facts: { change: "reset_requested" } });
  });

  it("changes a row only from the version the caller read: a stale, missing or skipped version writes nothing and no audit", async () => {
    const { capture, store } = bench();
    await store.commit(state(), null, entry());
    const next = state({ version: 2, health: "healthy" });
    expect(await store.commit(next, 5, entry("build_recorded"))).toBe(false);
    expect(await store.commit({ ...next, version: 3 }, 1, entry("build_recorded"))).toBe(false);
    expect(await store.commit(state(), null, entry())).toBe(false);
    expect((await store.get(ORG, "web"))?.health).toBe("never_proved");
    expect(capture.recordedBy("saved_env.changed")).toHaveLength(1);
    expect(await store.commit(next, 1, entry("build_recorded"))).toBe(true);
    // two writers at the same version: the second loses
    expect(await store.commit({ ...next, version: 2, health: "needs_repair" }, 1, entry("build_failed"))).toBe(false);
    expect((await store.get(ORG, "web"))?.health).toBe("healthy");
  });

  it("refuses a write whose ids are not the entry's, or whose state does not parse, and writes nothing", async () => {
    const { db, store } = bench();
    expect(await store.commit(state(), null, { ...entry(), projectId: "other" })).toBe(false);
    expect(await store.commit(state(), null, { ...entry(), orgId: OTHER })).toBe(false);
    expect(await store.commit({ ...state(), health: "great" as never }, null, entry())).toBe(false);
    expect(db.get(orgPk(ORG), "SAVED_ENV#web")).toBeUndefined();
  });

  it("refuses a ledgered change when there is no audit ledger, and writes nothing; activity needs none", async () => {
    const { db, store } = bench({ noAudit: true });
    await expect(store.commit(state(), null, entry())).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    await expect(store.audit(entry("scan_started", { digest: DIGEST }))).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(db.get(orgPk(ORG), "SAVED_ENV#web")).toBeUndefined();
    expect(await store.commit(state({ lastPushAt: AT }), null, entry("activity", { reason: "push" }))).toBe(true);
  });

  it("refuses a change whose audit event is not valid, and writes nothing", async () => {
    const { db, store } = bench();
    await expect(store.commit(state(), null, entry("images_deleted", { count: 1.5 }))).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(db.get(orgPk(ORG), "SAVED_ENV#web")).toBeUndefined();
  });

  it("writes the dispatcher's hand-over of a lease as the row alone, so the dispatcher needs no ledger", async () => {
    const { capture, store } = bench({ noAudit: true });
    expect(await store.commit(state({ lastPushAt: AT }), null, entry("rebuild_queued", { reason: "dispatched" }))).toBe(true);
    expect(capture.recordedBy("saved_env.changed")).toEqual([]);
  });

  it("audits a setting change with the person and the new value only", async () => {
    const { capture, store } = bench();
    await store.commit(state({ enabled: false }), null, entry("setting_changed", { enabled: false, actor: "dev_1" }));
    expect(capture.recordedBy("saved_env.setting_changed")[0]).toMatchObject({ target: { kind: "project", name: "web" }, actor: { kind: "member", id: "dev_1" }, facts: { enabled: false } });
    expect(capture.recordedBy("saved_env.changed")).toEqual([]);
  });

  it("writes activity as the row alone, with no ledger event", async () => {
    const { capture, store } = bench();
    expect(await store.commit(state({ lastTaskAt: AT }), null, entry("activity", { reason: "task" }))).toBe(true);
    expect(capture.recordedBy("saved_env.changed")).toEqual([]);
    expect((await store.get(ORG, "web"))?.lastTaskAt).toBe(AT);
  });

  it("writes an audit entry that is not tied to the row alone, with its digest and count", async () => {
    const { capture, store } = bench();
    await store.audit(entry("images_deleted", { digest: DIGEST, count: 2, reason: "walk" }));
    expect(capture.recordedBy("saved_env.changed")[0]).toMatchObject({ facts: { change: "images_deleted", digest: DIGEST, count: 2, cause: "walk" } });
  });

  it("treats a stored row that does not read back as an error, never as no row", async () => {
    const { db, store } = bench();
    db.set({ pk: orgPk(ORG), sk: "SAVED_ENV#web", entityType: "SAVED_ENV", orgId: ORG, projectId: "web", version: 1, enabled: "yes", images: [], health: "healthy" });
    await expect(store.get(ORG, "web")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("does not store undefined attributes, and a row with an unknown attribute does not read back", async () => {
    const { db, store } = bench();
    await store.commit(state({ job: undefined, lastFailure: undefined }), null, entry());
    expect(Object.keys(db.get(orgPk(ORG), "SAVED_ENV#web") ?? {})).not.toContain("job");
    db.set({ ...(db.get(orgPk(ORG), "SAVED_ENV#web") as Record<string, unknown>), surprise: 1 } as never);
    await expect(store.get(ORG, "web")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("deleted projects", () => {
  const deleted = (changes: Partial<SavedEnvState> = {}): SavedEnvState => state({ deleted: true, deletedAt: AT, ...changes });

  it("lists a deleted project until its registry deletion is final, and only through the due index", async () => {
    const { db, store } = bench();
    await store.commit(state({ projectId: "alive" }), null, entry("rebuild_queued", { projectId: "alive" }));
    await store.commit(deleted(), null, entry("project_deleted"));
    expect(db.get(orgPk(ORG), "SAVED_ENV#web")).toMatchObject({ [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: SAVED_ENV_PURGE_PARTITION });
    expect(db.get(orgPk(ORG), "SAVED_ENV#alive")?.[WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]).toBeUndefined();
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([{ orgId: ORG, projectId: "web" }]);
  });

  it("lists a project purged too early again once the lease has passed, and drops it once a purge finished after deletedAt plus the lease", async () => {
    const { db, store, clock } = bench();
    const row = deleted({ registryPurgedAt: new Date(NOW + 1000).toISOString() });
    await store.commit(row, null, entry("project_deleted"));
    // purged one second after the delete: due again at deletedAt plus the lease, not before
    expect(db.get(orgPk(ORG), "SAVED_ENV#web")?.[WORKFLOW_DISPATCH_DUE_INDEX.sortKey]).toContain(String(NOW + SAVED_ENV_JOB_LEASE_MS).padStart(15, "0"));
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([]);
    clock.now = () => NOW + SAVED_ENV_JOB_LEASE_MS + 5;
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([{ orgId: ORG, projectId: "web" }]);
    const final = { ...row, version: 2, registryPurgedAt: new Date(NOW + SAVED_ENV_JOB_LEASE_MS + 1).toISOString() };
    expect(await store.commit(final, 1, entry("images_deleted", { reason: "purged" }))).toBe(true);
    expect(db.get(orgPk(ORG), "SAVED_ENV#web")?.[WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]).toBeUndefined();
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([]);
  });

  it("checks the row itself, not the eventually consistent index", async () => {
    const { db, store } = bench();
    await store.commit(deleted(), null, entry("project_deleted"));
    // the index still lists the row, but the row was registered again meanwhile
    const live = db.get(orgPk(ORG), "SAVED_ENV#web") as Record<string, unknown>;
    db.set({ ...live, deleted: false });
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([]);
    // or its purge finished after the lease, though the index still lists it
    db.set({ ...live, registryPurgedAt: new Date(NOW + SAVED_ENV_JOB_LEASE_MS + 1).toISOString() });
    expect(await store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS)).toEqual([]);
  });
});
