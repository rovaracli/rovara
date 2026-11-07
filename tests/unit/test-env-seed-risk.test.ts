// SEED-RISK-1 (owner decision 2026-11-07): a seed command DETECTED UNCHANGED from the repository's own script, run only on Rovara's sealed test database, is MEDIUM (one maintainer approves); anything else stays HIGH.
// The broker locks it from the repository itself (never the worker's word), stores its own checks with the proposal, and the approval reads them again from the store.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, projectMetaKey, projectPk, projectRevisionKey, seedScriptLockOf, testEnvApprovalRisk, testEnvLessSafeChanges, type OrgId, type TestEnvironmentBody } from "@agentx/contracts";
import { approveTestEnvironment, proposalSeedTrust, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { lockLookSeeds, seedRisksOf, seedTrustOf, type SeedRepoSources } from "../../packages/broker/src/test-env/seed-lock.js";
import { treeReader } from "../../packages/broker/src/aws/broker/seed-lock-wiring.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "web";
const ON = { TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
const cmd = (executable: string, args: string[] = [], cwd = "repo/web") => ({ cwd, executable, args, timeoutSeconds: 900 });
const SEED = cmd("npm", ["run", "seed"]);
const dep = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [{ command: SEED }], reset: "fresh_per_round", ...over,
});
const body = (dependencies: unknown[] = [dep()], over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies, ...over,
});
const detected = [{ command: SEED, source: { path: "package.json", line: 4 } }];

/** The repository as the code host gives it: one tree listing and file reads at one commit (repository-relative paths). */
const FILES: Record<string, string> = { "package.json": JSON.stringify({ scripts: { seed: "node db/seed.js" } }), "db/seed.js": "const { Client } = require('pg');\n" };
function sources(files: Record<string, string> = FILES, options: { failRead?: boolean; failAll?: boolean } = {}): SeedRepoSources & { reads: string[] } {
  const reads: string[] = [];
  const entries = Object.keys(files).map((path) => ({ path, mode: "100644", type: "blob" }));
  const fn = (async () => {
    if (options.failAll === true) throw new Error("GitHub is down");
    return [{ path: "repo/web", readerAt: (directory: string) => treeReader(entries, directory, async (path) => { reads.push(path); if (options.failRead === true) throw new Error("HTTP 502"); return files[path]; }) }];
  }) as SeedRepoSources & { reads: string[] };
  fn.reads = reads;
  return fn;
}

function bench() {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {}, definition: { name: PROJECT, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [cmd("npm", ["test"])], orchestratorInstructions: "Delegate work." } });
  const clock = { now: Date.UTC(2026, 10, 7, 10, 0, 0) };
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, env: ON };
  return { db, deps, clock };
}
async function proposeAndProve(h: ReturnType<typeof bench>, environment: TestEnvironmentBody, seedChecks?: Parameters<typeof proposeTestEnvironment>[1]["seedChecks"]) {
  const proposed = await proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: environment, ...(seedChecks === undefined ? {} : { seedChecks }) });
  await recordTestEnvProveReport(h.deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposed.digest, steps: [{ step: "setup", status: "passed", durationMs: 0 }, { step: "full_suite", status: "passed", durationMs: 0 }, { step: "dependencies", status: "passed", durationMs: 0 }, { step: "dependency_usage", status: "passed", durationMs: 0 }], services: [], finishedAt: new Date(h.clock.now).toISOString() } });
  return proposed;
}
const approveOnePress = (h: ReturnType<typeof bench>, digest: string) => approveTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, digest, expectedRevision: 0, requestId: "request-12345678", approvedBy: "dev_a", role: "maintainer" });
const scope = { orgId: ORG, project: PROJECT };

describe("a detected seed command, unchanged from the repository, on the sealed test database", () => {
  it("is locked by the broker from the repository and is MEDIUM: one maintainer approves with one press", async () => {
    const source = sources();
    const locked = await lockLookSeeds(body(), detected, source, scope);
    const seed = locked.body.dependencies![0]!.seeds[0]!;
    expect("command" in seed && seed.lock?.from).toEqual(["db/seed.js", "package.json"]);
    expect(source.reads).toEqual(["package.json", "db/seed.js"]);
    expect(locked.checks).toEqual([expect.objectContaining({ verdict: "locked", dependencyId: "postgres" })]);
    const h = bench();
    const proposed = await proposeAndProve(h, locked.body, locked.checks);
    expect(proposed).toMatchObject({ risk: "medium", lessSafe: [] });
    // No second person and no fresh sign-in: the approval itself reads the broker's checks again from the proposal item.
    expect(await approveOnePress(h, proposed.digest)).toMatchObject({ revision: 1, lessSafe: [] });
    expect(seedRisksOf(locked.checks, locked.body)[0]).toEqual({ dependencyId: "postgres", risk: "medium", reason: "Seed detected unchanged from db/seed.js, package.json, runs only on the test database." });
  });

  it("positive control: the same locked body stored WITHOUT the broker's checks (an edit) is HIGH and the one-press approval is refused", async () => {
    const locked = await lockLookSeeds(body(), detected, sources(), scope);
    const h = bench();
    const proposed = await proposeAndProve(h, locked.body);
    expect(proposed).toMatchObject({ risk: "high", lessSafe: ["dependency_seed"] });
    await expect(approveOnePress(h, proposed.digest)).rejects.toThrow(/sign in again|second person/u);
    expect(seedRisksOf([], locked.body)[0]!.reason).toMatch(/^Seed is high risk: it was set or changed by a person/u);
  });
});

describe("everything else stays HIGH", () => {
  it("a seed whose source is the model (or a setup run) is HIGH whatever its text, and nothing is read", async () => {
    for (const source of ["model", "person", "recipe:shared-node@1"]) {
      const repo = sources();
      const locked = await lockLookSeeds(body(), [{ command: SEED, source }], repo, scope);
      expect(locked.checks).toEqual([expect.objectContaining({ verdict: "high", reason: "not_detected" })]);
      expect(repo.reads).toEqual([]);
      expect(testEnvApprovalRisk(locked.body, seedTrustOf(locked.checks, locked.body))).toBe("high");
    }
  });

  it("an edited command (not the one the detectors found) is HIGH", async () => {
    const edited = body([dep({ seeds: [{ command: cmd("npm", ["run", "seed:all"]) }] })]);
    const locked = await lockLookSeeds(edited, detected, sources({ ...FILES, "package.json": JSON.stringify({ scripts: { "seed:all": "node db/seed.js" } }) }), scope);
    expect(locked.checks).toEqual([expect.objectContaining({ verdict: "high", reason: "not_detected" })]);
    expect(testEnvLessSafeChanges(undefined, locked.body, seedTrustOf(locked.checks, locked.body))).toEqual(["dependency_seed"]);
  });

  it("a broker read failure is HIGH: the code host down, or a file read that fails", async () => {
    for (const repo of [sources(FILES, { failAll: true }), sources(FILES, { failRead: true }), undefined]) {
      const locked = await lockLookSeeds(body(), detected, repo, scope);
      expect(locked.checks[0]).toMatchObject({ verdict: "high" });
      expect(locked.body.dependencies![0]!.seeds[0]).toEqual({ command: SEED });
      expect(testEnvApprovalRisk(locked.body, seedTrustOf(locked.checks, locked.body))).toBe("high");
    }
  });

  it("a hash the worker (or anyone) wrote into the body is ignored: the broker drops it and hashes the repository itself", async () => {
    const forged = body([dep({ seeds: [{ command: SEED, lock: { version: 1, hash: "f".repeat(64), from: ["package.json"] } }] })]);
    const locked = await lockLookSeeds(forged, detected, sources(), scope);
    const own = await seedScriptLockOf(SEED, treeReader(Object.keys(FILES).map((path) => ({ path, mode: "100644", type: "blob" })), "", async (path) => FILES[path]));
    const seed = locked.body.dependencies![0]!.seeds[0]!;
    expect(own.ok && "command" in seed && seed.lock?.hash).toBe(own.ok ? own.lock.hash : "x");
    expect("command" in seed && seed.lock?.hash).not.toBe("f".repeat(64));
    // And a forged lock never matches a broker check: the honest checks do not verify the forged body.
    expect(testEnvApprovalRisk(forged, seedTrustOf(locked.checks, forged))).toBe("high");
  });

  it("a seed that could reach anything but the sealed test database is HIGH (a fake behind it, another tier), even with a broker check stored for it", async () => {
    const fakeWorking = body([dep({ workingBacking: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" } })]);
    const locked = await lockLookSeeds(fakeWorking, detected, sources(), scope);
    expect(locked.checks).toEqual([expect.objectContaining({ verdict: "high", reason: "not_sealed" })]);
    // Defence in depth: a check that says `locked` does not lower a body whose target is not sealed (the contract judges the target again).
    const good = await lockLookSeeds(body(), detected, sources(), scope);
    const lockedSeed = good.body.dependencies![0]!.seeds[0]!;
    const unsealed = body([dep({ seeds: [lockedSeed], workingBacking: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" } })]);
    expect(testEnvApprovalRisk(unsealed, seedTrustOf(good.checks, unsealed))).toBe("high");
    expect(testEnvLessSafeChanges(undefined, unsealed, seedTrustOf(good.checks, unsealed))).toEqual(["dependency_seed"]);
    expect(seedRisksOf(good.checks, unsealed)[0]!.risk).toBe("high");
  });

  it("a damaged check record on the proposal item verifies nothing", async () => {
    const locked = await lockLookSeeds(body(), detected, sources(), scope);
    const h = bench();
    const proposed = await proposeAndProve(h, locked.body, locked.checks);
    const key = { pk: projectPk(ORG, PROJECT), sk: `TESTENV#PROPOSAL#${proposed.digest}` };
    const item = h.db.get(key)!;
    h.db.set({ ...item, seedChecks: [{ verdict: "locked", dependencyId: "postgres" }] });
    expect((await proposalSeedTrust(h.deps, ORG, PROJECT, proposed.digest, locked.body)).verifiedSeeds?.size ?? 0).toBe(0);
    await expect(approveOnePress(h, proposed.digest)).rejects.toThrow(/sign in again|second person/u);
  });
});
