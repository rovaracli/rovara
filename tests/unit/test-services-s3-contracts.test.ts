// Test services, slice 3 (s3-fakes-run, T1): the contracts a fake server in a round needs. A plan dependency may be a fake (a pinned fixture set digest, no image digest), the usage record has a row for every fake, the
// fixture-set callback has its two shapes, and the catalog marks the three helpers that run from the worker's own image.
import { describe, expect, it } from "vitest";
import { FixtureSetCallbackReplySchema, FixtureSetCallbackRequestSchema, ServiceCatalogSchema, TEST_SERVICES_FAKE_PLAN_FEATURE, TEST_SERVICES_PLAN_FEATURE, TestServicesUsageRecordSchema, testServicesFakeUsageVerdict, type TestServicesUsageRecord } from "@rovara-code/contracts";
import { TaskDependencyPlanSchema, WORKER_INVOCATION_FEATURES } from "@agentx/cloud-contracts";
import { pinnedCatalog, unpinnedCatalog } from "../support/catalog-pinning.js";

const FIXTURE = "a".repeat(64);
const fakePlan = (over: Record<string, unknown> = {}) => ({
  id: "payments", name: "Payments API", kind: "http_api", family: "http:api.example-pay.com", backing: "fake", catalogId: "fake-server@r1", repository: "svc/fake-server",
  fake: { fixtureSetRef: FIXTURE, unmatched: "fail" }, config: {}, aliases: ["fake-payments"], connect: [{ name: "PAYMENTS_API_URL", template: "http://{host}:{port}" }], seeds: [], reset: "fresh_per_round", ...over,
});
const localPlan = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: "b".repeat(64),
  config: {}, aliases: ["postgres"], connect: [], seeds: [], reset: "fresh_per_round", ...over,
});
const row = (over: Record<string, unknown> = {}) => ({ id: "payments", ledger: "read", matched: 2, unmatched: 0, synthesized: 0, faults: 0, foreign: 0, ...over });
const record = (fakes?: unknown[]): TestServicesUsageRecord => TestServicesUsageRecordSchema.parse({
  schemaVersion: 1, dependencies: [{ id: "payments", started: true, healthy: true, startMs: 10, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 }, ...(fakes === undefined ? {} : { fakes }),
});

describe("a fake in the task plan", () => {
  it("is a pinned fixture set and no image digest", () => {
    expect(TaskDependencyPlanSchema.safeParse(fakePlan()).success).toBe(true);
  });
  it("refuses a fake with an image digest, with no fixture set, or that does not run the fake server", () => {
    expect(TaskDependencyPlanSchema.safeParse(fakePlan({ digest: "c".repeat(64) })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(fakePlan({ fake: undefined })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(fakePlan({ catalogId: "postgres@16" })).success).toBe(false);
  });
  it("refuses a fixture set that is not a digest, and a policy that makes up answers (not available yet)", () => {
    expect(TaskDependencyPlanSchema.safeParse(fakePlan({ fake: { fixtureSetRef: "https://x.invalid/set", unmatched: "fail" } })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(fakePlan({ fake: { fixtureSetRef: FIXTURE, unmatched: "schema_synth" } })).success).toBe(false);
  });
  it("keeps every other entry as it was: an image still needs its digest and has no fixture set", () => {
    expect(TaskDependencyPlanSchema.safeParse(localPlan()).success).toBe(true);
    expect(TaskDependencyPlanSchema.safeParse(localPlan({ digest: undefined })).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(localPlan({ fake: { fixtureSetRef: FIXTURE, unmatched: "fail" } })).success).toBe(false);
  });
  it("has a feature string the worker must list", () => {
    expect(TEST_SERVICES_FAKE_PLAN_FEATURE).toBe("task.testServices.fake.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_FAKE_PLAN_FEATURE);
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_PLAN_FEATURE);
  });
});

describe("the fixture-set callback", () => {
  it("asks for a digest and nothing else", () => {
    expect(FixtureSetCallbackRequestSchema.safeParse({ digest: FIXTURE }).success).toBe(true);
    for (const bad of [{}, { digest: "abc" }, { digest: FIXTURE, orgId: "org_aaaaaaaaaaaaaaaaaaaa" }, { digest: FIXTURE, url: "https://x.invalid" }]) expect(FixtureSetCallbackRequestSchema.safeParse(bad).success).toBe(false);
  });
  it("is answered with an https address only", () => {
    const reply = { digest: FIXTURE, url: "https://bucket.s3.us-west-2.amazonaws.com/private/org/fixtures/x?X-Amz-Signature=1", expiresAt: "2026-11-03T10:15:00.000Z" };
    expect(FixtureSetCallbackReplySchema.safeParse(reply).success).toBe(true);
    for (const url of ["http://bucket.invalid/x", "file:///etc/passwd", "https://a b", ""]) expect(FixtureSetCallbackReplySchema.safeParse({ ...reply, url }).success).toBe(false);
  });
});

describe("the usage record of a fake", () => {
  it("has no fakes field unless a fake ran (the earlier record, byte for byte)", () => {
    expect("fakes" in record()).toBe(false);
  });
  it("lists a fake once and says nothing for a ledger that was not read", () => {
    expect(record([row()]).fakes).toHaveLength(1);
    expect(TestServicesUsageRecordSchema.safeParse({ ...record(), fakes: [row(), row()] }).success).toBe(false);
    expect(TestServicesUsageRecordSchema.safeParse({ ...record(), fakes: [row({ ledger: "unreadable" })] }).success).toBe(false);
    expect(TestServicesUsageRecordSchema.safeParse({ ...record(), fakes: [row({ ledger: "unreadable", matched: 0 })] }).success).toBe(true);
  });
  it("is clean only for a fake whose ledger was read with no unmatched and no foreign call", () => {
    expect(testServicesFakeUsageVerdict(record([row()]), ["payments"])).toEqual({ ok: true });
    expect(testServicesFakeUsageVerdict(record([row({ unmatched: 1 })]), ["payments"])).toEqual({ ok: false, problem: "unmatched", ids: ["payments"] });
    expect(testServicesFakeUsageVerdict(record([row({ foreign: 1 })]), ["payments"])).toEqual({ ok: false, problem: "foreign", ids: ["payments"] });
  });
  it("fails closed: no record, no row, or an unreadable ledger is never a pass", () => {
    expect(testServicesFakeUsageVerdict(undefined, ["payments"])).toEqual({ ok: false, problem: "not_checked", ids: ["payments"] });
    expect(testServicesFakeUsageVerdict(record(), ["payments"])).toEqual({ ok: false, problem: "not_checked", ids: ["payments"] });
    expect(testServicesFakeUsageVerdict(record([row({ ledger: "unreadable", matched: 0 })]), ["payments"])).toEqual({ ok: false, problem: "not_checked", ids: ["payments"] });
  });
});

describe("the catalog's worker-image helpers", () => {
  const helpers = ["fake-server", "dns-helper", "test-account-proxy"];
  it("marks exactly the three helpers the worker image runs, and pins none of them", () => {
    const catalog = unpinnedCatalog();
    expect(catalog.entries.filter((entry) => entry.workerImage === true).map((entry) => entry.family).sort()).toEqual([...helpers].sort());
    const pinned = pinnedCatalog();
    for (const entry of pinned.entries.filter((candidate) => helpers.includes(candidate.family))) expect(entry.image.digest).toBeUndefined();
  });
  it("refuses the mark on real software, and on a helper that carries a pin", () => {
    const raw = JSON.parse(JSON.stringify(unpinnedCatalog())) as { entries: Array<Record<string, unknown>> };
    const postgres = raw.entries.find((entry) => entry["family"] === "postgres")!;
    postgres["workerImage"] = true;
    expect(ServiceCatalogSchema.safeParse(raw).success).toBe(false);
    delete postgres["workerImage"];
    const fake = raw.entries.find((entry) => entry["family"] === "fake-server")!;
    raw["pinned" as never] = true as never;
    (fake["image"] as { digest?: string }).digest = "d".repeat(64);
    expect(ServiceCatalogSchema.safeParse(raw).success).toBe(false);
  });
});
