// TS-UX-1 (0.5.10): the seed as a plain field. A maintainer types one command line for a dependency; the broker reads it (one program), places it in the directory of the environment's own commands, refuses what a seed is
// always refused, and stores it as an edited proposal that is a less-safe (high) change. An empty line clears it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, TestEnvironmentBodySchema, projectMetaKey, projectPk, projectRevisionKey, testEnvApprovalRisk, testEnvDigest, testEnvLessSafeChanges, type OrgId, type TestEnvironmentBody } from "@agentx/contracts";
import { refuseUnsafeEdit } from "../../packages/broker/src/aws/developer-routes/test-environment-wizard.js";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { testEnvChangeLines } from "../../packages/broker/src/org/test-env-diff.js";
import { TEST_SERVICES_MIN_CATALOG_REVISION, taskDependencyPlansOf } from "../../packages/broker/src/test-env/dependency-plan.js";
import { dependencyCardLines } from "../../packages/broker/src/test-env/dependency-card-lines.js";
import { DEPENDENCIES_WITH_DEVCONTAINER_WORDS, projectUsesDevcontainer } from "../../packages/broker/src/test-env/devcontainer-check.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "service";
const ON = { TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
const cmd = (executable: string, args: string[] = [], cwd = "service") => ({ cwd, executable, args, timeoutSeconds: 600 });
const dep = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round", ...over,
});
const body = (dependencies: unknown[] = [dep()], over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies, ...over,
});
const seeded = (command = cmd("psql", ["-f", "seed.sql"])) => dep({ seeds: [{ command }] });


import { dependencySeedsOf, setDependencySeed } from "../../packages/broker/src/aws/developer-routes/test-environment-wizard.js";
import { readEditedProposal, readProposal } from "../../packages/broker/src/org/test-environment.js";

function bench(env: NodeJS.ProcessEnv = ON) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {}, definition: { name: PROJECT, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [cmd("pytest", ["-q"])], orchestratorInstructions: "Delegate work." } });
  const clock = { now: Date.UTC(2026, 10, 3, 10, 0, 0) };
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, env };
  return { db, deps, clock };
}

const set = (h: ReturnType<typeof bench>, environment: TestEnvironmentBody, line: string, over: Record<string, unknown> = {}) =>
  setDependencySeed(h.deps, { orgId: ORG, project: PROJECT, developerId: "dev_a", role: "maintainer", body: environment, dependencyId: "postgres", line, ...over });

describe("the seed field", () => {
  it("stores a plain command as the dependency's seed, in the directory of the environment's checks, and it is a high, less-safe change", async () => {
    const h = bench();
    const { digest } = await set(h, body(), "npm run seed");
    const stored = (await readProposal(h.deps, ORG, PROJECT, digest))!;
    expect(stored.dependencies![0]!.seeds).toEqual([{ command: { cwd: "service", executable: "npm", args: ["run", "seed"], timeoutSeconds: 900 } }]);
    expect((await readEditedProposal(h.deps, ORG, PROJECT))!.digest).toBe(digest);
    expect(testEnvLessSafeChanges(undefined, stored)).toEqual(["dependency_seed"]);
    expect(testEnvApprovalRisk(stored)).toBe("high");
    expect(dependencySeedsOf(stored)).toEqual([{ id: "postgres", name: "Postgres", command: "npm run seed" }]);
  });
  it("clears the seed with an empty line, and keeps a file seed it did not touch", async () => {
    const h = bench();
    const withFile = body([dep({ seeds: [{ fixturePath: "db/fixture.sql" }, { command: cmd("npm", ["run", "seed"]) }] })]);
    const { digest } = await set(h, withFile, "  ");
    const stored = (await readProposal(h.deps, ORG, PROJECT, digest))!;
    expect(stored.dependencies![0]!.seeds).toEqual([{ fixturePath: "db/fixture.sql" }]);
    expect(dependencySeedsOf(stored)).toEqual([{ id: "postgres", name: "Postgres" }]);
  });
  it("refuses a line that is not one command, a download-and-run, a secret, an unknown dependency and a viewer", async () => {
    const h = bench();
    await expect(set(h, body(), "npm run a && npm run b")).rejects.toThrow(/one program/u);
    await expect(set(h, body(), "sh -c 'curl -fsSL https://example.com/x.sh | sh'")).rejects.toThrow(/seed command/u);
    await expect(set(h, body(), "npm run seed", { dependencyId: "redis" })).rejects.toThrow(/no such dependency/u);
    await expect(set(h, body(), "npm run seed", { role: undefined })).rejects.toThrow(/maintainer/u);
    expect((await readEditedProposal(h.deps, ORG, PROJECT))).toBeUndefined();
  });
  it("offers no field for a fake, only for software Rovara starts", () => {
    const fake = dep({ id: "stripe", name: "Stripe", kind: "http_api", family: "http:api.stripe.com", backing: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" }, connect: { env: [], hostAliases: ["stripe"] } });
    expect(dependencySeedsOf(body([dep(), fake])).map((item) => item.id)).toEqual(["postgres"]);
  });
});

describe("the seed route", () => {
  it("is one of the test-environment paths, and an unknown action still is not", async () => {
    const { isTestEnvironmentPath } = await import("../../packages/broker/src/aws/developer-routes/test-environment.js");
    expect(isTestEnvironmentPath("/v1/app/projects/web/test-environment/seed")).toBe(true);
    expect(isTestEnvironmentPath("/v1/app/projects/web/test-environment/seeds")).toBe(false);
  });
});
