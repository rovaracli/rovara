// Test services, slice 1 (M3): `tx` is install-wide, so a project with NO dependencies must see exactly what it saw before: with `tx` on every user-visible output below is byte-for-byte the output with `tx` off. If this
// fails, `tx` needs a per-project allow-list first. Covered: the setup proposal (sanitized draft), the approve card, the task plans (CHECKS and IMPLEMENT), the Prove report, the evidence pack, and the PR lines the evidence feeds
// (the pull request body takes its testing lines from the pack and has no other test-services input).
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, projectMetaKey, projectRevisionKey, type OrgId, type TestEnvDraft, type TestEnvironmentBody } from "@agentx/contracts";
import { approveTestEnvItemsFor } from "../../packages/broker/src/decisions/test-env-source.js";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { buildEvidencePack } from "../../packages/broker/src/rovara-code/evidence-pack.js";
import { evidenceLines } from "../../packages/broker/src/rovara-code/evidence-lines.js";
import { sanitizeTestEnvDraft } from "../../packages/broker/src/test-env/draft.js";
import { evidenceEnvironmentOf } from "../../packages/broker/src/test-env/evidence-line.js";
import { proveReportFromSetupCheck } from "../../packages/broker/src/test-env/prove-from-setup-check.js";
import { testEnvImplementPlanFor, testEnvPlanFor } from "../../packages/broker/src/test-env/task-plan.js";
import { testEnvironmentForStart } from "../../packages/broker/src/test-env/usable.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "service";
const TASK = "t1";
const ON = { TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
const OFF = { TEST_ENVIRONMENT_ENABLED: "1" };
const NOW = Date.UTC(2026, 10, 3, 10, 0, 0);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const body = (): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const same = (left: unknown, right: unknown): void => { expect(JSON.stringify(left)).toBe(JSON.stringify(right)); };

/** A project with an approved environment WITHOUT dependencies, proposed, proved and approved under `env`, with a task pinned to it. */
async function project(env: NodeJS.ProcessEnv) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {}, definition: { name: PROJECT, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [cmd("pytest", ["-q"])], orchestratorInstructions: "Delegate work." } });
  const deps: TestEnvDeps & { serviceCatalog: () => Promise<ReturnType<typeof verifiedCatalog>> } = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => NOW, audit: audit.audit, env, serviceCatalog: async () => verifiedCatalog(pinnedCatalog()) };
  const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: body() });
  await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "setup", status: "passed", durationMs: 0 }, { step: "full_suite", status: "passed", durationMs: 0 }], services: [], finishedAt: new Date(NOW).toISOString() } });
  const ports = { store: deps, maintainedProjects: async () => [PROJECT], confirmPathOf: async () => undefined };
  const card = await approveTestEnvItemsFor(ports, { orgId: ORG, developerId: "dev_a" }, env);
  await approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision: 0, requestId: "request-12345678", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: NOW - 1_000 });
  const start = await testEnvironmentForStart(deps, { orgId: ORG, project: PROJECT, taskId: TASK }, env);
  db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
  return { deps, card, digest: proposal.digest };
}

describe("a project with no dependencies sees the same with tx on and off", () => {
  it("setup proposal: the sanitized draft is the same, and a draft without candidates gains no key", () => {
    const draft: TestEnvDraft = { environment: body(), valueSources: [{ field: "repos[0].checks[0]", source: "detector:python" }], pendingServices: [], notes: ["Found pytest."], questions: [] };
    const options = (env: NodeJS.ProcessEnv) => ({ env, propose: { catalog: verifiedCatalog(pinnedCatalog()), edition: "public" as const, projectId: PROJECT } });
    const on = sanitizeTestEnvDraft(draft, options(ON));
    same(on, sanitizeTestEnvDraft(draft, options(OFF)));
    same(on, sanitizeTestEnvDraft(draft));
    expect(JSON.stringify(on)).not.toContain("dependencies");
  });

  it("approve card, task plans (CHECKS and IMPLEMENT), evidence environment, pack and PR lines are the same", async () => {
    const on = await project(ON);
    const off = await project(OFF);
    // The same proposal digest (the environment body is hashed without a dependencies key), and the same card.
    expect(on.digest).toBe(off.digest);
    same(on.card, off.card);
    expect(JSON.stringify(on.card)).not.toMatch(/Dependencies|dependenc/iu);
    // The CHECKS plan, whichever switch the plan is asked under; the coding plan does not exist for an environment without dependencies.
    const readiness = [cmd("pytest", ["-q"])];
    const plans = [
      await testEnvPlanFor(on.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness }, ON),
      await testEnvPlanFor(on.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness }, OFF),
      await testEnvPlanFor(off.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness }, OFF),
    ];
    expect(plans[0]).toBeDefined();
    same(plans[0], plans[1]);
    same(plans[0], plans[2]);
    expect(JSON.stringify(plans[0])).not.toContain("dependencies");
    for (const env of [ON, OFF]) expect(await testEnvImplementPlanFor(on.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, env)).toBeUndefined();
    // Evidence: the environment the pack records and everything built from it.
    const chosenOn = await evidenceEnvironmentOf(on.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON);
    const chosenOff = await evidenceEnvironmentOf(off.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, OFF);
    same(chosenOn, chosenOff);
    expect(chosenOn.dependencies).toBeUndefined();
    const checks = [{ id: "readiness:0", label: "pytest -q", source: "project" as const, before: "passed" as const, after: "passed" as const, class: "passing" as const, output: "", durationMs: 7, exitCode: 0 }];
    const pack = (chosen: typeof chosenOn) => buildEvidencePack({ candidateDigest: "c".repeat(64), rawText: undefined, checks, environment: chosen.environment!, storedArtifacts: new Map(), ...(chosen.dependencies === undefined ? {} : { dependencies: chosen.dependencies }) });
    same(pack(chosenOn), pack(chosenOff));
    expect("dependencies" in pack(chosenOn).pack!.environment).toBe(false);
    same(evidenceLines({ pack: pack(chosenOn).pack, mode: "summary" }, "c".repeat(64), 0), evidenceLines({ pack: pack(chosenOff).pack, mode: "summary" }, "c".repeat(64), 0));
    expect(JSON.stringify(evidenceLines({ pack: pack(chosenOn).pack, mode: "summary" }, "c".repeat(64), 0))).not.toMatch(/ran against|Blocked by environment|not available/u);
  });

  it("the Prove report derived from the setup check is the same, with no dependency step", () => {
    const definition = { revision: 4, setup: [], readiness: [cmd("pytest", ["-q"])] };
    const ready = { status: "ready" as const, checkedRevision: 4, checkedAt: new Date(NOW - 3_600_000).toISOString() };
    const derive = () => proveReportFromSetupCheck({ environment: body(), definition, setup: ready, nowMs: NOW });
    const before = process.env.TEST_SERVICES_ENABLED;
    try {
      process.env.TEST_SERVICES_ENABLED = "1";
      const on = derive();
      delete process.env.TEST_SERVICES_ENABLED;
      const off = derive();
      same(on, off);
      expect(JSON.stringify(on)).not.toMatch(/"dependencies"|dependency_usage/u);
    } finally {
      if (before === undefined) delete process.env.TEST_SERVICES_ENABLED; else process.env.TEST_SERVICES_ENABLED = before;
    }
  });
});
