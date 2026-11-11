// Test services, slice 1 (L1) and slice 2 (pre-pull of every pinned local entry): at approval, a `local` dependency whose catalog entry has no pinned digest gets the same fixed "not available yet" words as any backing slice 1 cannot start.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, projectMetaKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { TEST_SERVICES_MIN_CATALOG_REVISION, isPrepulledEntry, taskDependencyPlansOf } from "../../packages/broker/src/test-env/dependency-plan.js";
import { proposeTestEnvironment, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { digestOfId, pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
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
  return { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => Date.UTC(2026, 10, 3, 10, 0, 0), audit: audit.audit, env: ON, ...(serviceCatalog === undefined ? {} : { serviceCatalog }) };
}
const propose = (d: TestEnvDeps) => proposeTestEnvironment(d, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: body() });

const bodyFor = (catalogId: string) => TestEnvironmentBodySchema.parse({ ...body(), dependencies: [{ ...postgres, backing: { kind: "local", catalogId, config: {} } }] });

describe("a pinned entry and the worker's pre-pull list", () => {
  it("is startable at approval for every pinned local entry, not only the default: postgres@15, @16 and @17 are all pre-pulled", async () => {
    const source = async () => verifiedCatalog(pinnedCatalog());
    for (const catalogId of ["postgres@15", "postgres@16", "postgres@17"]) {
      await expect(proposeTestEnvironment(deps(source), { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: bodyFor(catalogId) }), catalogId).resolves.toBeDefined();
    }
  });
  it("plans every pinned local entry, and a retired or not-yet-pinned one is refused with the fixed words", () => {
    const catalog = verifiedCatalog(pinnedCatalog());
    for (const catalogId of ["postgres@15", "postgres@16", "postgres@17"]) {
      expect(taskDependencyPlansOf({ body: bodyFor(catalogId), catalog, edition: "public", projectId: PROJECT }).ok, catalogId).toBe(true);
    }
    const retired = verifiedCatalog(pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "postgres@15")!["status"] = "retired"; }));
    const result = taskDependencyPlansOf({ body: bodyFor("postgres@15"), catalog: retired, edition: "public", projectId: PROJECT });
    expect(result.ok).toBe(false);
  });
  it("keeps refusing what the worker would not have pulled: an entry missing from the pre-pull list is 'not available yet' at approval and at plan time", async () => {
    // A catalog with more images than a worker pre-pulls has no list at all (the schema's cap), so nothing in it is pre-pulled, and no error escapes.
    const many = pinnedCatalog((entries) => {
      const template = entries.find((entry) => entry["id"] === "redis@7")!;
      for (let index = 0; index < 20; index += 1) {
        const copy = structuredClone(template);
        copy["id"] = `redis@9${String(index)}`;
        copy["version"] = `9${String(index)}`;
        const image = copy["image"] as { digest?: string };
        image.digest = digestOfId(copy["id"] as string);
        entries.push(copy);
      }
    });
    const catalog = verifiedCatalog(many);
    expect(isPrepulledEntry(catalog, "postgres@16")).toBe(false);
    await expect(proposeTestEnvironment(deps(async () => catalog), { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: bodyFor("postgres@16") })).rejects.toThrow(/not available yet/u);
    const result = taskDependencyPlansOf({ body: bodyFor("postgres@16"), catalog, edition: "public", projectId: PROJECT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_available_yet");
  });
});

describe("a local dependency without a pinned digest at approval", () => {
  it("is refused with the fixed 'not available yet' words when the catalog does not pin it", async () => {
    await expect(propose(deps(async () => verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION))))).rejects.toThrow(/not available yet/u);
  });
  it("is proposed when the catalog pins it, and when no catalog is at hand (the task's plan then judges it)", async () => {
    await expect(propose(deps(async () => verifiedCatalog(pinnedCatalog())))).resolves.toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/u) as string });
    await expect(propose(deps())).resolves.toBeDefined();
    await expect(propose(deps(async () => { throw new Error("unreadable"); }))).resolves.toBeDefined();
  });
});
