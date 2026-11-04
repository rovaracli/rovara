// Test services, slice 3 (s3-fakes-run), broker side: a fake backing in the plan, only for an APPROVED fixture set of the task's own company; the fixture-set delivery callback and who may call it; the evidence label
// and the unmatched count; and the Prove usage step. With tx off, or with no fake, everything reads as it did.
import { describe, expect, it } from "vitest";
import {
  FixtureSetSchema, TestEnvTaskPlanSchema, TestEnvironmentBodySchema, fixtureEntry, fixtureSetDigest, TEST_SERVICES_FAKE_USAGE_WORDS, testEnvDigest,
  type FixtureSet, type OrgId, type ProjectCommand, type TestEnvironment, type TestEnvironmentBody, type TestServicesUsageRecord, type VerifiedCatalog,
} from "@agentx/contracts";
import { DEPENDENCY_PLAN_REFUSAL_WORDS, dependenciesStartableNow, taskDependencyPlansOf } from "../../packages/broker/src/test-env/dependency-plan.js";
import { approvedFixturesOf, fixtureDigestsOfEnvironment, fixtureDigestsOfPlan, recordsOf, type FixtureStoreFactory } from "../../packages/broker/src/test-env/fixture-lookup.js";
import { createFixtureStore, createMemoryFixturePorts, verifiedFixtureDecision, type FixtureStore } from "../../packages/broker/src/test-env/fixture-store.js";
import { environmentUnusedReason, testEnvironmentForStart } from "../../packages/broker/src/test-env/usable.js";
import { testEnvPlanFor, testEnvImplementPlanFor } from "../../packages/broker/src/test-env/task-plan.js";
import { handleFixtureSetCallback, FIXTURE_DELIVERY_REFUSED, type FixtureDeliveryOperation } from "../../packages/broker/src/aws/broker/fixture-delivery.js";
import { FAKE_USAGE_ITEM_ID, dependencyEvidenceOf, type PinnedDependency, type RawUsage } from "../../packages/broker/src/rovara-code/dependency-evidence.js";
import { packDependencyLines } from "../../packages/broker/src/rovara-code/dependency-lines.js";
import { evidenceEnvironmentOf } from "../../packages/broker/src/test-env/evidence-line.js";
import { dependencyStepsOf } from "../../packages/broker/src/test-env/prove-from-setup-check.js";
import { dependencyCardLines } from "../../packages/broker/src/test-env/dependency-card-lines.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { verifyCapability } from "../../packages/broker/src/aws/broker/admin-and-helpers.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { workspaceKey } from "../../packages/broker/src/aws/broker/admin-and-helpers.js";
import { projectMetaKey, projectRevisionKey } from "@agentx/contracts";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROJECT = "service";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ON = { TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
const NOW = new Date("2026-11-03T10:00:00.000Z");
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });

// ---- a fixture set, and a store that holds it (approved for ORG)

const dependencyOfSet = { id: "payments", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: [] as string[] };
const makeSet = (over: Record<string, unknown> = {}): FixtureSet => FixtureSetSchema.parse({
  schemaVersion: 2, dependency: dependencyOfSet, origin: "written", writtenBy: "Priya", revision: 3, syntheticOnly: true, match,
  entries: [fixtureEntry({ dependency: dependencyOfSet, match }, { method: "GET", path: "/v1/ping", contentType: "", body: "" }, { status: 200, headers: [], contentType: "application/json", body: '{"ok":true}', latencyMs: 0 })],
  faults: [], ...over,
});
const recordedSet = (): FixtureSet => makeSet({ origin: "recorded", writtenBy: undefined, recordedAt: "2026-10-20T08:00:00.000Z", revision: 5 });
const DENY = { accountIds: [], hosts: [], arnPrefixes: [] };
function storeOf(options: { enabled?: () => boolean; signUrl?: (key: string, seconds: number) => string } = {}) {
  const ports = createMemoryFixturePorts(options.signUrl === undefined ? { signUrl: (key, seconds) => `https://fixtures.example.test/${key}?X-Amz-Expires=${String(seconds)}` } : { signUrl: options.signUrl });
  return createFixtureStore({ enabled: options.enabled ?? (() => true), objects: ports.objects, index: ports.index, denyFor: () => Promise.resolve(DENY), now: () => NOW });
}
async function approvedSet(store: FixtureStore, set: FixtureSet, org: OrgId = ORG): Promise<string> {
  const digest = fixtureSetDigest(set);
  const stored = await store.submit(org, set, { actor: "maya", recordedFrom: "written" });
  if (!stored.ok) throw new Error(stored.reason);
  const decision = verifiedFixtureDecision({ orgId: org, actor: "maya", role: "maintainer", action: "approve", digest, signedInAt: new Date(NOW.getTime() - 60_000), schemaSynth: false });
  const approved = await store.approve(org, digest, decision!);
  if (!approved.ok) throw new Error(approved.reason);
  return digest;
}

// ---- an environment with Postgres and a fake

const postgres = () => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
});
const payments = (digest: string, over: Record<string, unknown> = {}) => ({
  id: "payments", name: "Payments API", kind: "http_api", family: "http:api.example-pay.com", found: [{ path: "src/pay.ts", line: 3 }], usedBy: ["integration"],
  backing: { kind: "fake", fixtureSetRef: digest, unmatched: "fail" },
  connect: { env: [{ name: "PAYMENTS_API_URL", template: "http://{host}:{port}" }], hostAliases: ["fake-payments"] }, seeds: [], reset: "fresh_per_round", ...over,
});
const body = (dependencies: unknown[] | null): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: DENY, capture: { screenshots: "failed", video: false, traces: false }, ...(dependencies === null ? {} : { dependencies }),
});
const asEnvironment = (environment: TestEnvironmentBody): TestEnvironment => ({ revision: 1, approvedAt: "2026-11-03T10:00:00.000Z", environment });
const catalog = (change?: (entries: Array<Record<string, unknown>>) => void): VerifiedCatalog => verifiedCatalog(pinnedCatalog(change));
const plansOf = (dependencies: unknown[], fixtures: Awaited<ReturnType<typeof approvedFixturesOf>> | undefined, from: VerifiedCatalog | null = catalog()) =>
  taskDependencyPlansOf({ body: body(dependencies), catalog: from ?? undefined, edition: "public", ...(fixtures === undefined ? {} : { fixtures }) });
const reason = (result: ReturnType<typeof plansOf>) => (result.ok ? "ok" : result.reason);

describe("which dependencies are startable now", () => {
  it("includes a fake that fails on a request with no recording and is made new each round, and nothing else about fakes", () => {
    const digest = "a".repeat(64);
    expect(dependenciesStartableNow([payments(digest)] as never)).toBe(true);
    // A made-up answer is not available yet; a restart between checks would lose the fake's ledger.
    expect(dependenciesStartableNow([payments(digest, { backing: { kind: "fake", fixtureSetRef: digest, unmatched: "schema_synth" } })] as never)).toBe(false);
    expect(dependenciesStartableNow([payments(digest, { reset: "between_checks" })] as never)).toBe(false);
    // The coding sandbox gets the same fake, or nothing different.
    expect(dependenciesStartableNow([payments(digest, { workingBacking: { kind: "fake", fixtureSetRef: digest, unmatched: "fail" } })] as never)).toBe(true);
    expect(dependenciesStartableNow([payments(digest, { workingBacking: { kind: "fake", fixtureSetRef: "b".repeat(64), unmatched: "fail" } })] as never)).toBe(false);
    // A fallback is never a thing yet.
    expect(dependenciesStartableNow([payments(digest, { fallback: { kind: "fake", fixtureSetRef: digest, unmatched: "fail" } })] as never)).toBe(false);
  });
  it("is carried out with tx on and refused with tx off (an environment with dependencies is not used at all)", () => {
    const environment = asEnvironment(body([payments("a".repeat(64))]));
    expect(environmentUnusedReason(environment, ON)).toBeUndefined();
    expect(environmentUnusedReason(environment, { TEST_ENVIRONMENT_ENABLED: "1" })).toBe("dependencies_not_connected");
  });
});

describe("the plan of a fake", () => {
  it("pins the approved set by digest, with no image digest and no address", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const fixtures = await approvedFixturesOf(store, ORG, body([payments(digest)]));
    const result = plansOf([postgres(), payments(digest)], fixtures);
    expect(reason(result)).toBe("ok");
    if (!result.ok) throw new Error("no plan");
    const fake = result.dependencies.find((entry) => entry.id === "payments")!;
    expect(fake).toMatchObject({ backing: "fake", catalogId: "fake-server@r1", repository: "svc/fake-server", fake: { fixtureSetRef: digest, unmatched: "fail" }, aliases: ["fake-payments"], seeds: [], reset: "fresh_per_round" });
    expect("digest" in fake).toBe(false);
    expect(JSON.stringify(fake)).not.toMatch(/https?:\/\/fixtures|X-Amz|expires/iu);
    expect(TestEnvTaskPlanSchema.safeParse({ revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], dependencies: result.dependencies }).success).toBe(true);
    expect(fixtureDigestsOfPlan({ dependencies: result.dependencies })).toEqual([digest]);
    // The real software beside it is exactly what slice 1 planned.
    expect(result.dependencies.find((entry) => entry.id === "postgres")).toMatchObject({ backing: "local" });
    expect(result.dependencies.find((entry) => entry.id === "postgres")?.digest).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("needs no pinned catalog for a fake alone (it starts no catalog image), and still needs one beside real software", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const fixtures = await approvedFixturesOf(store, ORG, body([payments(digest)]));
    expect(reason(plansOf([payments(digest)], fixtures, verifiedCatalog(unpinnedCatalog())))).toBe("ok");
    expect(reason(plansOf([postgres(), payments(digest)], fixtures, verifiedCatalog(unpinnedCatalog())))).toBe("not_pinned");
  });
  it("refuses a set that is not approved for this company: another company's, a pending one, a withdrawn one, one nobody holds, and a store that is not there", async () => {
    const store = storeOf();
    const set = makeSet();
    const digest = fixtureSetDigest(set);
    const environment = body([payments(digest)]);
    // nobody holds it
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, environment)))).toBe("fixture_not_approved");
    // pending
    await store.submit(ORG, set, { actor: "maya", recordedFrom: "written" });
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, environment)))).toBe("fixture_not_approved");
    // approved for ORG, asked for by OTHER_ORG
    await approvedSet(store, set);
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, environment)))).toBe("ok");
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, OTHER_ORG, environment)))).toBe("fixture_not_approved");
    // withdrawn
    const withdraw = verifiedFixtureDecision({ orgId: ORG, actor: "maya", role: "maintainer", action: "withdraw", digest, signedInAt: undefined, schemaSynth: false })!;
    expect((await store.withdraw(ORG, digest, withdraw)).ok).toBe(true);
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(store, ORG, environment)))).toBe("fixture_not_approved");
    // no store at all, and no lookup passed to the plan
    expect(reason(plansOf([payments(digest)], await approvedFixturesOf(undefined, ORG, environment)))).toBe("fixture_not_approved");
    expect(reason(plansOf([payments(digest)], undefined))).toBe("fixture_not_approved");
    expect(DEPENDENCY_PLAN_REFUSAL_WORDS.fixture_not_approved).toMatch(/approved/iu);
  });
  it("refuses a set approved for another kind of dependency, a store that throws, and a fake that cannot stand in for a database", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const other = await approvedFixturesOf(store, ORG, body([payments(digest, { family: "http:api.other-pay.com" })]));
    expect(reason(plansOf([payments(digest, { family: "http:api.other-pay.com" })], other))).toBe("fixture_not_approved");
    const broken = { record: () => Promise.reject(new Error("boom")) };
    expect((await approvedFixturesOf(broken, ORG, body([payments(digest)]))).size).toBe(0);
    const fixtures = await approvedFixturesOf(store, ORG, body([payments(digest)]));
    expect(reason(plansOf([payments(digest, { kind: "database", family: "http:api.example-pay.com" })], fixtures))).toBe("not_available_yet");
  });
  it("needs a name to be reached by, no seeds, and the catalog's marked fake server", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const fixtures = await approvedFixturesOf(store, ORG, body([payments(digest)]));
    expect(reason(plansOf([payments(digest, { connect: { env: [], hostAliases: [] } })], fixtures))).toBe("not_available_yet");
    expect(reason(plansOf([payments(digest, { seeds: [{ command: cmd("node", ["seed.js"]) }] })], fixtures))).toBe("not_available_yet");
    const without = catalog((entries) => { entries.splice(0, entries.length, ...entries.filter((entry) => entry["family"] !== "fake-server")); });
    expect(reason(plansOf([payments(digest)], fixtures, without))).toBe("not_available_yet");
    const retired = catalog((entries) => { for (const entry of entries) if (entry["family"] === "fake-server") entry["status"] = "retired"; });
    expect(reason(plansOf([payments(digest)], fixtures, retired))).toBe("not_available_yet");
    const enterpriseOnly = catalog((entries) => { for (const entry of entries) if (entry["family"] === "fake-server") entry["editions"] = ["enterprise"]; });
    expect(reason(plansOf([payments(digest)], fixtures, enterpriseOnly))).toBe("not_in_edition");
  });
  it("lists the digests an environment names, once each, for the checks and for the coding sandbox", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const environment = body([payments(a, { workingBacking: { kind: "fake", fixtureSetRef: a, unmatched: "fail" } }), payments(b, { id: "geo", name: "Geo", family: "http:api.example-pay.com", connect: { env: [{ name: "GEO_URL", template: "http://{host}:{port}" }], hostAliases: ["fake-geo"] } })]);
    expect(fixtureDigestsOfEnvironment(environment)).toEqual([a, b]);
    expect(fixtureDigestsOfEnvironment(body(null))).toEqual([]);
  });
});

// ---- the task's plan, from an approved environment

const projectRow = () => ({
  ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {},
  definition: { name: PROJECT, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [cmd("pytest", ["-q"])], orchestratorInstructions: "Delegate work." },
});
async function approvedWith(environment: TestEnvironmentBody, store: FixtureStore | undefined) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  db.set(projectRow());
  const clock = { now: Date.UTC(2026, 10, 3, 10, 0, 0) };
  const deps: TestEnvDeps & { serviceCatalog?: () => Promise<VerifiedCatalog | undefined> } = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, env: ON, ...(store === undefined ? {} : { fixtureStore: () => store }) };
  deps.serviceCatalog = async () => catalog();
  const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: environment });
  await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "setup", status: "passed", durationMs: 0 }, { step: "full_suite", status: "passed", durationMs: 0 }, { step: "dependencies", status: "passed", durationMs: 1 }, { step: "dependency_usage", status: "passed", durationMs: 0 }], services: [], finishedAt: new Date(clock.now).toISOString() } });
  await approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision: 0, requestId: "request-12345678", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: clock.now - 1_000 });
  const start = await testEnvironmentForStart(deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
  db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
  return { db, deps };
}
const readiness = [cmd("pytest", ["-q"])];

describe("approving an environment with a fake", () => {
  it("needs the fixture set to be approved for the company; without a store, or for a set nobody approved, it is refused in fixed words", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    await expect(approvedWith(body([payments(digest)]), store)).resolves.toBeDefined();
    await expect(approvedWith(body([payments(digest)]), undefined)).rejects.toThrow(/approved set of answers/iu);
    await expect(approvedWith(body([payments("c".repeat(64))]), store)).rejects.toThrow(/approved set of answers/iu);
  });
});

describe("the plan of a task with a fake (checks and coding)", () => {
  it("builds the checks plan and the coding plan with the fake, from the approved set", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const h = await approvedWith(body([postgres(), payments(digest)]), store);
    const plan = (await testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON))!;
    expect(plan.digest).toBe(testEnvDigest(body([postgres(), payments(digest)])));
    expect(plan.dependencies?.map((entry) => [entry.id, entry.backing])).toEqual([["postgres", "local"], ["payments", "fake"]]);
    expect(TestEnvTaskPlanSchema.safeParse(plan).success).toBe(true);
    const coding = (await testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON))!;
    expect(coding.dependencies).toEqual(plan.dependencies);
    expect(fixtureDigestsOfPlan(plan)).toEqual([digest]);
  });
  it("refuses the run, in fixed words, when the set was withdrawn after the approval, and never sends a plan without the fake", async () => {
    const store = storeOf();
    const set = makeSet();
    const digest = await approvedSet(store, set);
    const h = await approvedWith(body([payments(digest)]), store);
    const withdraw = verifiedFixtureDecision({ orgId: ORG, actor: "maya", role: "maintainer", action: "withdraw", digest, signedInAt: undefined, schemaSynth: false })!;
    await store.withdraw(ORG, digest, withdraw);
    await expect(testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.fixture_not_approved);
    await expect(testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.fixture_not_approved);
    // no store wired in the dispatching broker
    delete h.deps.fixtureStore;
    await expect(testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.fixture_not_approved);
  });
  it("with tx off, nothing is read and no plan is built", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const h = await approvedWith(body([payments(digest)]), store);
    expect(await testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness }, { TEST_ENVIRONMENT_ENABLED: "1" })).toBeUndefined();
    expect(await testEnvImplementPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, { TEST_ENVIRONMENT_ENABLED: "1" })).toBeUndefined();
  });
});

// ---- the callback

const SIGNING = { callbackSigningKey: "k".repeat(32) } as never;
describe("the fixture-set capability", () => {
  it("is granted only to an operation whose plan names fixture sets, and carries no other power with it", () => {
    const without = issueCapability(SIGNING, WORKSPACE, "op", 1, {});
    const withIt = issueCapability(SIGNING, WORKSPACE, "op", 1, { fixtureDelivery: true });
    expect(() => verifyCapability(SIGNING, without, "fixture-set")).toThrow(/does not allow fixture-set/u);
    expect(verifyCapability(SIGNING, withIt, "fixture-set").actions).toContain("fixture-set");
    // Another action, and another operation's token, are not it.
    expect(verifyCapability(SIGNING, withIt, "events").workspaceId).toBe(WORKSPACE);
    expect(() => verifyCapability({ callbackSigningKey: "z".repeat(32) } as never, withIt, "fixture-set")).toThrow(/signature/u);
  });
  it("runs out with the capability", () => {
    const real = Date.now;
    try {
      const token = issueCapability(SIGNING, WORKSPACE, "op", 1, { fixtureDelivery: true });
      Date.now = () => real() + 10 * 3600 * 1000;
      expect(() => verifyCapability(SIGNING, token, "fixture-set")).toThrow(/does not allow fixture-set/u);
    } finally { Date.now = real; }
  });
});

describe("the fixture-set callback", () => {
  const TASK = "task-1";
  async function world(over: { taskOrg?: OrgId; closed?: boolean; cancelled?: boolean } = {}) {
    const store = storeOf();
    const digest = await approvedSet(store, makeSet());
    const db = new FakeDynamoDb();
    db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: over.taskOrg ?? ORG, project: PROJECT, workspaceId: WORKSPACE, ...(over.closed === true ? { closedAt: "2026-11-03T09:00:00.000Z" } : {}) });
    db.set({ ...taskPointerKey(WORKSPACE), entityType: "DEVELOPER_TASK_POINTER", taskId: TASK, developerId: "dev_a", ...(over.cancelled === true ? { cancelledAt: "2026-11-03T09:00:00.000Z" } : {}) });
    db.set({ ...workspaceKey(WORKSPACE), entityType: "WORKSPACE", orgId: over.taskOrg ?? ORG, projectName: PROJECT });
    const deps = { documentClient: db, tableName: "t", fixtureStore: () => store };
    const operation = (change: Partial<FixtureDeliveryOperation> = {}): FixtureDeliveryOperation => ({ kind: "task", workflowMode: "CHECKS", status: "RUNNING", workspaceId: WORKSPACE, orgId: ORG, fixtureSetDigests: [digest], ...change });
    return { deps, digest, operation, store };
  }
  const refused = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "delivered"; } catch (error) { return (error as Error).message.replace(/^[A-Z_]+: /u, ""); } };

  it("hands the run a fresh 15-minute address of the set its plan named, and nothing else", async () => {
    const w = await world();
    const reply = await handleFixtureSetCallback(w.deps, w.operation(), { digest: w.digest }, ON);
    expect(Object.keys(reply).sort()).toEqual(["digest", "expiresAt", "url"]);
    expect(reply.digest).toBe(w.digest);
    expect(reply.url).toMatch(/^https:\/\/fixtures\.example\.test\/private\/org_a+\/fixtures\/[a-f0-9]{64}\?X-Amz-Expires=900$/u);
    expect(Date.parse(reply.expiresAt)).toBe(NOW.getTime() + 15 * 60_000);
    // A coding run and a candidate check's preparation may ask too.
    expect((await handleFixtureSetCallback(w.deps, w.operation({ workflowMode: "IMPLEMENT" }), { digest: w.digest }, ON)).digest).toBe(w.digest);
    expect((await handleFixtureSetCallback(w.deps, w.operation({ kind: "prepare", workflowMode: undefined }), { digest: w.digest }, ON)).digest).toBe(w.digest);
  });
  it("refuses a digest that is not in the plan, even an approved set of the same company", async () => {
    const w = await world();
    const other = await approvedSet(w.store, makeSet({ revision: 9 }));
    expect(await refused(handleFixtureSetCallback(w.deps, w.operation(), { digest: other }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    expect(await refused(handleFixtureSetCallback(w.deps, w.operation({ fixtureSetDigests: [] }), { digest: w.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    expect(await refused(handleFixtureSetCallback(w.deps, w.operation({ fixtureSetDigests: undefined }), { digest: w.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
  });
  it("refuses another company: the operation's org is the only one asked, so a set held by another company reads like a set nobody holds", async () => {
    const w = await world();
    // The plan names a digest, but the operation (and its task) belong to OTHER_ORG, which holds no such set.
    const otherWorld = await world({ taskOrg: OTHER_ORG });
    const asOther = otherWorld.operation({ orgId: OTHER_ORG, fixtureSetDigests: [w.digest] });
    // ... against the very store that holds the set for ORG: the store answers for the operation's org only.
    expect(await refused(handleFixtureSetCallback({ ...otherWorld.deps, fixtureStore: () => w.store }, asOther, { digest: w.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    expect((await handleFixtureSetCallback({ ...w.deps, fixtureStore: () => w.store }, w.operation(), { digest: w.digest }, ON)).digest).toBe(w.digest);
    // A task of another company than the operation says.
    const mismatched = await world({ taskOrg: OTHER_ORG });
    expect(await refused(handleFixtureSetCallback(mismatched.deps, mismatched.operation(), { digest: mismatched.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    // The body cannot name an org, a project or an address.
    for (const extra of [{ orgId: OTHER_ORG }, { project: PROJECT }, { url: "https://x.invalid" }]) expect(await refused(handleFixtureSetCallback(w.deps, w.operation(), { digest: w.digest, ...extra }, ON))).toMatch(/not the shape/u);
    // No org on the operation, no delivery.
    expect(await refused(handleFixtureSetCallback(w.deps, w.operation({ orgId: undefined }), { digest: w.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
  });
  it("refuses an expired task: a closed or cancelled task, and an operation that is not running", async () => {
    const closed = await world({ closed: true });
    expect(await refused(handleFixtureSetCallback(closed.deps, closed.operation(), { digest: closed.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    const cancelled = await world({ cancelled: true });
    expect(await refused(handleFixtureSetCallback(cancelled.deps, cancelled.operation(), { digest: cancelled.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    const w = await world();
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED", "ACCEPTED"]) expect(await refused(handleFixtureSetCallback(w.deps, w.operation({ status }), { digest: w.digest }, ON)), status).toBe(FIXTURE_DELIVERY_REFUSED);
  });
  it("refuses a withdrawn set, an operation of another kind, a task of another mode, and a broker with no store, all in the same words", async () => {
    const w = await world();
    const withdraw = verifiedFixtureDecision({ orgId: ORG, actor: "maya", role: "maintainer", action: "withdraw", digest: w.digest, signedInAt: undefined, schemaSynth: false })!;
    expect(await refused(handleFixtureSetCallback(w.deps, w.operation({ kind: "publish" }), { digest: w.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    expect(await refused(handleFixtureSetCallback(w.deps, w.operation({ workflowMode: "REVIEW" }), { digest: w.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    expect(await refused(handleFixtureSetCallback({ ...w.deps, fixtureStore: undefined }, w.operation(), { digest: w.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
    await w.store.withdraw(ORG, w.digest, withdraw);
    expect(await refused(handleFixtureSetCallback(w.deps, w.operation(), { digest: w.digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
  });
  it("hands on nothing but an https address: an address the store signs over http is refused", async () => {
    const store = storeOf({ signUrl: (key) => `http://fixtures.example.test/${key}` });
    const digest = await approvedSet(store, makeSet());
    const db = new FakeDynamoDb();
    db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG, project: PROJECT, workspaceId: WORKSPACE });
    db.set({ ...taskPointerKey(WORKSPACE), entityType: "DEVELOPER_TASK_POINTER", taskId: TASK, developerId: "dev_a" });
    expect(await refused(handleFixtureSetCallback({ documentClient: db, tableName: "t", fixtureStore: () => store }, { kind: "task", workflowMode: "CHECKS", status: "RUNNING", workspaceId: WORKSPACE, orgId: ORG, fixtureSetDigests: [digest] }, { digest }, ON))).toBe(FIXTURE_DELIVERY_REFUSED);
  });
  it("with tx off, answers nothing and reads nothing", async () => {
    const w = await world();
    let reads = 0;
    const counting = { send: (command: unknown) => { reads += 1; return w.deps.documentClient.send(command as never); } };
    expect(await refused(handleFixtureSetCallback({ ...w.deps, documentClient: counting }, w.operation(), { digest: w.digest }, { TEST_ENVIRONMENT_ENABLED: "1" }))).toBe(FIXTURE_DELIVERY_REFUSED);
    expect(reads).toBe(0);
  });
});

// ---- evidence and Prove

const pinnedFake = (fake: PinnedDependency["fake"]): PinnedDependency[] => [{ id: "postgres", name: "Postgres", backing: "local" }, { id: "payments", name: "payments API", backing: "fake", ...(fake === undefined ? {} : { fake }) }];
const fakeRow = (over: Record<string, unknown> = {}) => ({ id: "payments", ledger: "read", matched: 4, unmatched: 0, synthesized: 0, faults: 0, foreign: 0, ...over });
const usageOf = (fakes?: unknown[]): RawUsage => ({
  schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 800, resetCount: 0 }, { id: "payments", started: true, healthy: true, startMs: 300, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 }, ...(fakes === undefined ? {} : { fakes }),
}) as RawUsage;
const packOf = (dependencies: ReturnType<typeof dependencyEvidenceOf>["dependencies"]) => ({ environment: { dependencies } }) as never;

describe("what the evidence says about a fake", () => {
  it("says hand-written for a written set and recorded for a recorded one, from the store, in the fixed words", () => {
    const written = dependencyEvidenceOf(pinnedFake({ origin: "hand_written", revision: 3 }), usageOf([fakeRow()]));
    expect(written.dependencies[1]).toMatchObject({ backing: "fake", label: "hand_written_fake", fixtureRevision: 3, startedMs: 300, usage: { requests: 4, unmatched: 0, faults: 0 } });
    expect(packDependencyLines(packOf(written.dependencies), 0).lines).toEqual(["Integration tests ran against: Postgres (real), payments API (hand-written fake, rev 3)."]);
    const recorded = dependencyEvidenceOf(pinnedFake({ origin: "recorded", revision: 5, recordedAt: "2026-10-20T08:00:00.000Z" }), usageOf([fakeRow()]));
    expect(recorded.dependencies[1]).toMatchObject({ label: "recorded_fake", fixtureRevision: 5, recordedAt: "2026-10-20T08:00:00.000Z" });
    expect(packDependencyLines(packOf(recorded.dependencies), 0).lines[0]).toBe("Integration tests ran against: Postgres (real), payments API (recorded fake, rev 5).");
    expect(packDependencyLines(packOf(recorded.dependencies), 0).notTested).toContain("- payments API: answers were recorded on 2026-10-20; real behaviour may have changed");
    expect(packDependencyLines(packOf(written.dependencies), 0).notTested).toContain("- payments API: answers were written by hand, not recorded");
  });
  it("never lets the worker set the label: a recorded set whose date is not known reads as the less trusted word, and so does a store that could not be read", () => {
    expect(dependencyEvidenceOf(pinnedFake({ origin: "recorded" }), usageOf([fakeRow()])).dependencies[1]!.label).toBe("hand_written_fake");
    expect(dependencyEvidenceOf(pinnedFake(undefined), usageOf([fakeRow()])).dependencies[1]!.label).toBe("hand_written_fake");
  });
  it("counts an unmatched request, and does not show the result as a clean run", () => {
    const result = dependencyEvidenceOf(pinnedFake({ origin: "hand_written", revision: 3 }), usageOf([fakeRow({ unmatched: 2 })]));
    expect(result.dependencies[1]!.usage).toEqual({ requests: 6, unmatched: 2, faults: 0 });
    expect(result.notTested).toContainEqual({ kind: "environment", id: FAKE_USAGE_ITEM_ID, text: `${TEST_SERVICES_FAKE_USAGE_WORDS.unmatched}: payments API`, reason: "no recording" });
  });
  it("says a fake's requests could not be checked when its ledger was not read, and when the record has no row for it; a clean fake adds nothing", () => {
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written" }), usageOf([fakeRow({ ledger: "unreadable", matched: 0 })])).notTested.map((item) => item.id)).toEqual([FAKE_USAGE_ITEM_ID]);
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written" }), usageOf([])).notTested.map((item) => item.id)).toEqual([FAKE_USAGE_ITEM_ID]);
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written" }), usageOf([fakeRow()])).notTested).toEqual([]);
  });
  it("shows a fake that did not start as not available, never as a fake that ran", () => {
    const record = { ...usageOf([fakeRow()]), dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 800, resetCount: 0 }, { id: "payments", started: false, healthy: false, startMs: 0, resetCount: 0, failure: "start_failed" }] } as RawUsage;
    expect(dependencyEvidenceOf(pinnedFake({ origin: "hand_written" }), record).dependencies[1]).toEqual({ name: "payments API", backing: "none", label: "not_available" });
  });
  it("reads the label from the store for the organisation of the task, by the pinned digest", async () => {
    const store = storeOf();
    const digest = await approvedSet(store, recordedSet());
    const h = await approvedWith(body([payments(digest)]), store);
    const chosen = await evidenceEnvironmentOf({ ...h.deps, fixtureStore: () => store }, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(chosen.dependencies).toEqual([{ id: "payments", name: "Payments API", backing: "fake", fake: { origin: "recorded", revision: 5, recordedAt: "2026-10-20T08:00:00.000Z" } }]);
    // Another company's task sees nothing of it.
    const elsewhere = await evidenceEnvironmentOf({ ...h.deps, fixtureStore: () => store }, { orgId: OTHER_ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(elsewhere.dependencies).toBeUndefined();
  });
});

describe("the Prove usage step with a fake", () => {
  const planned = (digest = "a".repeat(64)) => body([payments(digest)]);
  const record = (fakes?: unknown[]): TestServicesUsageRecord => ({ ...usageOf(fakes), dependencies: [{ id: "payments", started: true, healthy: true, startMs: 300, resetCount: 0 }] }) as TestServicesUsageRecord;
  const stepOf = (name: string, steps: ReturnType<typeof dependencyStepsOf>) => (steps === "not_checked" ? "not_checked" : steps.find((step) => step.step === name)?.status);
  it("passes for a fake whose ledger was read and shows no unmatched and no foreign call", () => {
    expect(stepOf("dependency_usage", dependencyStepsOf(planned(), record([fakeRow()])))).toBe("passed");
  });
  it("fails on an unmatched request, a foreign call, an unreadable ledger and a record with no row", () => {
    for (const fakes of [[fakeRow({ unmatched: 1 })], [fakeRow({ foreign: 1 })], [fakeRow({ ledger: "unreadable", matched: 0 })], []]) expect(stepOf("dependency_usage", dependencyStepsOf(planned(), record(fakes)))).toBe("failed");
    expect(stepOf("dependency_usage", dependencyStepsOf(planned(), { ...record(), fakes: undefined }))).toBe("failed");
  });
  it("still starts the fake as a dependency, and an environment without a fake gets the steps it had", () => {
    expect(stepOf("dependencies", dependencyStepsOf(planned(), record([fakeRow()])))).toBe("passed");
    const postgresOnly = body([postgres()]);
    expect(stepOf("dependency_usage", dependencyStepsOf(postgresOnly, { schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 1, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 } }))).toBe("passed");
  });
});

// ---- tx off, or no fake: today, byte for byte; and the one-line hunks of the hot files

describe("with no fake in the plan nothing is added", () => {
  it("names no fixture set, and grants no fixture-set power (the capability's actions are what they were)", () => {
    expect(fixtureDigestsOfPlan(undefined)).toEqual([]);
    expect(fixtureDigestsOfPlan({ dependencies: [] })).toEqual([]);
    const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    const plain = claims(issueCapability(SIGNING, WORKSPACE, "op", 1, {}));
    expect(plain.actions).toEqual(["artifacts", "events", "result"]);
    expect(claims(issueCapability(SIGNING, WORKSPACE, "op", 1, { fixtureDelivery: false })).actions).toEqual(plain.actions);
    expect(claims(issueCapability(SIGNING, WORKSPACE, "op", 1, { fixtureDelivery: true })).actions).toEqual([...plain.actions, "fixture-set"]);
  });
  it("is slice 2's plan for real software and Rovara local AWS: no fixture lookup is made", async () => {
    let asked = 0;
    const counting = { record: () => { asked += 1; return Promise.reject(new Error("never")); } };
    expect((await approvedFixturesOf(counting, ORG, body([postgres()]))).size).toBe(0);
    expect(asked).toBe(0);
    const result = taskDependencyPlansOf({ body: body([postgres()]), catalog: catalog(), edition: "public" });
    expect(result.ok && result.dependencies.map((entry) => [entry.id, "fake" in entry])).toEqual([["postgres", false]]);
  });
});

import { readFileSync } from "node:fs";
describe("the one-line hunks in the shared files", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  it("wires the callback, the capability and the digests, and nothing more, in the shared broker files", () => {
    expect(read("packages/broker/src/aws/broker/handler.ts")).toContain("nightly-result|fixture-set");
    expect(read("packages/broker/src/aws/broker/callbacks.ts")).toContain('if (action === "fixture-set")');
    expect(read("packages/broker/src/aws/broker/callbacks.ts")).toContain("handleFixtureSetCallback(");
    expect(read("packages/broker/src/aws/broker/task-operations.ts")).toContain("fixtureDelivery: fixtureDigests.length > 0");
    expect(read("packages/broker/src/aws/broker/task-operations.ts")).toContain("if (fixtureDigests.length > 0) operation.fixtureSetDigests = fixtureDigests;");
    expect(read("packages/broker/src/aws/broker/workspace-preparation.ts")).toContain("fixtureDigests.length > 0 ? { fixtureDelivery: true } : {}");
    expect(read("packages/broker/src/aws/ec2-delivery.ts")).toContain("dependency.backing === \"fake\"");
    expect(read("packages/broker/src/aws/broker/evidence-wiring.ts")).toContain("...fixtureStoreForRoutes(dependencies)");
  });
  it("hands the fixture store (the install's factory) to the routes that approve and plan a fake, and to the callback, the task's plan and the evidence", () => {
    expect(read("packages/broker/src/aws/broker/handler.ts")).toContain("...fixtureStoreForRoutes(dependencies),");
    expect(read("packages/broker/src/aws/broker/callbacks.ts")).toContain("...fixtureStoreForRoutes(dependencies) }, operation, body)");
    expect(read("packages/broker/src/aws/broker/task-operations.ts")).toContain("serviceCatalog: dependencies.serviceCatalog, ...fixtureStoreForRoutes(dependencies) }");
    expect(read("packages/broker/src/aws/developer-routes/test-environment.ts")).toContain("{ fixtureStore: deps.fixtureStore }");
    expect(read("packages/broker/src/aws/developer-routes/types.ts")).toContain("fixtureStore?: (denyFor");
  });
});

describe("the approve card", () => {
  it("says whether a fake's answers were recorded or written by hand when the store is asked, and 'a fake' when it is not", async () => {
    const store = storeOf();
    const written = await approvedSet(store, makeSet());
    const recorded = await approvedSet(store, recordedSet());
    const environment = body([payments(written), payments(recorded, { id: "geo", name: "Geo API", connect: { env: [], hostAliases: ["fake-geo"] } })]);
    const origins = await approvedFixturesOf(store, ORG, environment);
    const lines = dependencyCardLines(environment.dependencies!, origins);
    expect(lines).toContain("Payments API: answers from a hand-written fake. Found in src/pay.ts, line 3.");
    expect(lines).toContain("Geo API: answers from a recorded fake. Found in src/pay.ts, line 3.");
    expect(dependencyCardLines(environment.dependencies!)[0]).toBe("Payments API: answers from a fake. Found in src/pay.ts, line 3.");
    // the other company's store answer is no origin
    expect(dependencyCardLines(environment.dependencies!, await approvedFixturesOf(store, OTHER_ORG, environment))[0]).toBe("Payments API: answers from a fake. Found in src/pay.ts, line 3.");
  });
});

describe("the install's store is a factory over the production list", () => {
  it("a read of rows asks for no production list at all (it would fail closed if it did), and a delivery asks for the project's approved list", async () => {
    const ports = createMemoryFixturePorts({ signUrl: (key, seconds) => `https://fixtures.example.test/${key}?X-Amz-Expires=${String(seconds)}` });
    const asked: string[] = [];
    const factory: FixtureStoreFactory = (denyFor) => createFixtureStore({ enabled: () => true, objects: ports.objects, index: ports.index, denyFor: (org) => { asked.push(org); return denyFor(org); }, now: () => NOW });
    // set up through a store with an empty list, then read rows through the factory with a list that cannot be had
    const digest = await approvedSet(factory(() => Promise.resolve(DENY)) as FixtureStore, makeSet());
    asked.length = 0;
    const found = await approvedFixturesOf(recordsOf((denyFor) => factory(denyFor)), ORG, body([payments(digest)]));
    expect(found.get(digest)?.origin).toBe("hand_written");
    expect(asked).toEqual([]);
    expect(recordsOf(undefined)).toBeUndefined();
    const reader = recordsOf(() => factory(() => Promise.reject(new Error("no list"))));
    expect((await reader!.record(ORG, digest)).ok).toBe(true);
  });
});
