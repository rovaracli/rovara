// Test services, slice 1 (L1): at approval, a `local` dependency whose catalog entry has no pinned digest gets the same fixed "not available yet" words as any backing slice 1 cannot start.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, projectMetaKey, projectRevisionKey, type OrgId } from "@agentx/contracts";
import { proposeTestEnvironment, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "service";
const ON = { TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const postgres = {
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
};
const body = () => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies: [postgres],
});
function deps(serviceCatalog?: () => Promise<ReturnType<typeof verifiedCatalog>>): TestEnvDeps {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {}, definition: { name: PROJECT, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [cmd("pytest", ["-q"])], orchestratorInstructions: "Delegate work." } });
  return { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => Date.UTC(2026, 10, 3, 10, 0, 0), audit: audit.audit, env: ON, ...(serviceCatalog === undefined ? {} : { serviceCatalog }) } as TestEnvDeps;
}
const propose = (d: TestEnvDeps) => proposeTestEnvironment(d, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: body() });

describe("a local dependency without a pinned digest at approval", () => {
  it("is refused with the fixed 'not available yet' words when the catalog does not pin it", async () => {
    await expect(propose(deps(async () => verifiedCatalog(unpinnedCatalog())))).rejects.toThrow(/not available yet/u);
  });
  it("is proposed when the catalog pins it, and when no catalog is at hand (the task's plan then judges it)", async () => {
    await expect(propose(deps(async () => verifiedCatalog(pinnedCatalog())))).resolves.toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/u) as string });
    await expect(propose(deps())).resolves.toBeDefined();
    await expect(propose(deps(async () => { throw new Error("unreadable"); }))).resolves.toBeDefined();
  });
});
