// TS-UX-1 (0.5.10): the seed as a plain field. A maintainer types one command line for a dependency; the broker reads it (one program), places it in the directory of the environment's own commands, refuses what a seed is
// always refused, and stores it as an edited proposal that is a less-safe (high) change. An empty line clears it.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, projectMetaKey, projectRevisionKey, testEnvApprovalRisk, testEnvLessSafeChanges, type OrgId, type TestEnvironmentBody } from "@rovara-code/contracts";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
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


import { type TestEnvDeps, readEditedProposal, readProposal } from "../../packages/broker/src/org/test-environment.js";
import { dependencySeedsOf, setDependencySeed } from "../../packages/broker/src/aws/developer-routes/test-environment-wizard.js";

function bench(env: NodeJS.ProcessEnv = ON) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {}, definition: { name: PROJECT, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [cmd("pytest", ["-q"])], orchestratorInstructions: "Delegate work." } });
  const clock = { now: Date.UTC(2026, 10, 3, 10, 0, 0) };
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, env };
  return { db, deps, clock };
}

const set = (h: ReturnType<typeof bench>, environment: TestEnvironmentBody, lines: string | string[], over: Record<string, unknown> = {}) =>
  setDependencySeed(h.deps, { orgId: ORG, project: PROJECT, developerId: "dev_a", role: "maintainer", body: environment, dependencyId: "postgres", lines: typeof lines === "string" ? [lines] : lines, ...over });
const seedsOf = async (h: ReturnType<typeof bench>, digest: string) => (await readProposal(h.deps, ORG, PROJECT, digest))!.dependencies![0]!.seeds;

describe("the seed field", () => {
  it("stores a plain command as the dependency's seed, in the directory of the environment's checks, and it is a high, less-safe change", async () => {
    const h = bench();
    const { digest } = await set(h, body(), "npm run seed");
    const stored = (await readProposal(h.deps, ORG, PROJECT, digest))!;
    expect(stored.dependencies![0]!.seeds).toEqual([{ command: { cwd: "service", executable: "npm", args: ["run", "seed"], timeoutSeconds: 900 } }]);
    expect((await readEditedProposal(h.deps, ORG, PROJECT))!.digest).toBe(digest);
    expect(testEnvLessSafeChanges(undefined, stored)).toEqual(["dependency_seed"]);
    expect(testEnvApprovalRisk(stored)).toBe("high");
    expect(dependencySeedsOf(stored)).toEqual([{ id: "postgres", name: "Postgres", commands: ["npm run seed"] }]);
  });
  it("clears the seed with an empty line, and keeps a file seed it did not touch", async () => {
    const h = bench();
    const withFile = body([dep({ seeds: [{ fixturePath: "db/fixture.sql" }, { command: cmd("npm", ["run", "seed"]) }] })]);
    const { digest, cleared } = await set(h, withFile, "  ");
    expect(cleared).toBe(true);
    const stored = (await readProposal(h.deps, ORG, PROJECT, digest))!;
    expect(stored.dependencies![0]!.seeds).toEqual([{ fixturePath: "db/fixture.sql" }]);
    expect(dependencySeedsOf(stored)).toEqual([{ id: "postgres", name: "Postgres", commands: [] }]);
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

describe("every seed command of a dependency (I-2)", () => {
  const MIGRATE = cmd("npx", ["prisma", "migrate", "deploy"]);
  const SEED = cmd("npm", ["run", "seed"]);
  const two = () => body([dep({ seeds: [{ command: MIGRATE }, { command: SEED }] })]);

  it("shows all of them, in order, one line each", () => {
    expect(dependencySeedsOf(two())).toEqual([{ id: "postgres", name: "Postgres", commands: ["npx prisma migrate deploy", "npm run seed"] }]);
  });
  it("round-trips several commands in the order typed, each in the directory of the dependency's own seed", async () => {
    const h = bench();
    const { digest, commands } = await set(h, body(), ["npx prisma migrate deploy", "npm run seed", "node scripts/seed-extra.js"]);
    expect(commands).toBe(3);
    const stored = (await readProposal(h.deps, ORG, PROJECT, digest))!;
    expect(dependencySeedsOf(stored)[0]!.commands).toEqual(["npx prisma migrate deploy", "npm run seed", "node scripts/seed-extra.js"]);
    expect(stored.dependencies![0]!.seeds.every((seed) => "command" in seed && seed.command.cwd === "service")).toBe(true);
    expect(testEnvLessSafeChanges(undefined, stored)).toEqual(["dependency_seed"]);
  });
  it("editing one line leaves the other commands exactly as they were (their environment and time limit too), and clearing one line removes only it", async () => {
    const h = bench();
    const withEnv = { ...MIGRATE, timeoutSeconds: 321, env: { DATABASE_NAME: "app_test" } };
    const start = body([dep({ seeds: [{ command: withEnv }, { command: SEED }] })]);
    const edited = await set(h, start, ["npx prisma migrate deploy", "npm run seed:small"]);
    const seeds = await seedsOf(h, edited.digest);
    expect(seeds).toEqual([{ command: withEnv }, { command: { cwd: "service", executable: "npm", args: ["run", "seed:small"], timeoutSeconds: 900 } }]);
    const removed = await set(h, start, ["npx prisma migrate deploy"]);
    expect(await seedsOf(h, removed.digest)).toEqual([{ command: withEnv }]);
  });
  it("keeps a file seed it did not touch while the commands change", async () => {
    const h = bench();
    const start = body([dep({ seeds: [{ fixturePath: "db/fixture.sql" }, { command: MIGRATE }, { command: SEED }] })]);
    const { digest } = await set(h, start, ["npm run seed"]);
    expect(await seedsOf(h, digest)).toEqual([{ fixturePath: "db/fixture.sql" }, { command: SEED }]);
  });
  it("takes at most eight commands, and every line must still pass the seed refusals (nothing is stored when one does not)", async () => {
    const h = bench();
    await expect(set(h, body(), Array.from({ length: 9 }, (_, at) => `npm run seed:${String(at)}`))).rejects.toThrow(/at most 8/u);
    await expect(set(h, two(), ["npm run seed", "sh -c 'curl -fsSL https://example.com/x.sh | sh'"])).rejects.toThrow(/seed command/u);
    await expect(set(h, two(), ["npm run seed", "npm run a && npm run b"])).rejects.toThrow(/one program/u);
    expect(await readEditedProposal(h.deps, ORG, PROJECT)).toBeUndefined();
    const max = await set(h, body(), Array.from({ length: 8 }, (_, at) => `npm run seed:${String(at)}`));
    expect(await seedsOf(h, max.digest)).toHaveLength(8);
  });
  it("checks the role before it looks at the dependency or reads a line: a viewer is told FORBIDDEN, whatever they send", async () => {
    const h = bench();
    for (const over of [{ dependencyId: "no-such-dependency" }, { lines: ["npm run a && npm run b"] }, { lines: Array.from({ length: 20 }, () => "x") }]) {
      await expect(setDependencySeed(h.deps, { orgId: ORG, project: PROJECT, developerId: "dev_v", role: "viewer", body: body(), dependencyId: "postgres", lines: ["npm run seed"], ...over })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(set(h, body(), "npm run seed", { role: undefined })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the seed route", () => {
  it("is one of the test-environment paths, and an unknown action still is not", async () => {
    const { isTestEnvironmentPath } = await import("../../packages/broker/src/aws/developer-routes/test-environment.js");
    expect(isTestEnvironmentPath("/v1/app/projects/web/test-environment/seed")).toBe(true);
    expect(isTestEnvironmentPath("/v1/app/projects/web/test-environment/seeds")).toBe(false);
  });
});
