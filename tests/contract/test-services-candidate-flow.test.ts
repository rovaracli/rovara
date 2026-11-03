// Test services, slice 1 (Prove, end to end through the real broker): a proposal's candidate check is sent the pinned dependencies, the worker's usage record comes back in its result and is kept on the check (scoped by
// org, validated, once), and Prove derives its two dependency steps from it. With tx off nothing of this exists (golden).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvDigest, type TestEnvironmentBody, type TestServicesUsageRecord } from "../../packages/contracts/src/index.js";
import { keepCandidateUsage } from "../../packages/broker/src/org/test-env-candidate.js";
import { proposeTestEnvironment } from "../../packages/broker/src/org/test-environment.js";
import { OMAR } from "../support/developer-task-broker.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { ENV, NAME, command, draftBody, errorOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; delete process.env.TEST_SERVICES_ENABLED; vi.restoreAllMocks(); });

const postgres = {
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
};
const withDependency = (): TestEnvironmentBody => draftBody({ dependencies: [postgres], repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }] }] });
const usage = (over: Partial<TestServicesUsageRecord> = {}): TestServicesUsageRecord => ({ schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 840, resetCount: 1 }], unknownCalls: { domains: [], otherCount: 0 }, ...over });

interface Candidate { workspaceId: string; digest: string; revision: number; usage?: unknown }
const candidates = (t: Bench) => t.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Candidate[];
const prepareOf = (t: Bench, workspaceId: string) => String((t.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
const outboxPayload = (t: Bench, workspaceId: string) => (t.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId)[0] as unknown as { invocation: { payload: Record<string, unknown> } }).invocation.payload;
/** The steps of the Prove report the broker stored (derived from the candidate check). */
const proveSteps = (t: Bench) => ((t.db.find((item) => item.entityType === "TEST_ENV_PROVE")[0] as unknown as { report: { steps: Array<{ step: string; status: string }> } }).report.steps.map((entry) => ({ step: entry.step, status: entry.status })));
const store = (t: Bench) => ({ documentClient: t.db, tableName: "state", now: () => Date.now() });
async function proposeAndCheck(t: Bench, body: TestEnvironmentBody) {
  const proposal = await proposeTestEnvironment(store(t), { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body });
  const started = await t.dev(OMAR, "POST", `${ENV}/check`, { digest: proposal.digest, requestId: randomUUID() });
  return { digest: proposal.digest, started };
}
const bench = () => setupWizardBench({ autoCandidate: false, brokerExtra: { serviceCatalog: async () => verifiedCatalog(pinnedCatalog()) } });
const on = async <T>(run: () => Promise<T>): Promise<T> => { process.env.TEST_SERVICES_ENABLED = "1"; return withSwitch("1", run); };

describe("the candidate check of a proposal with dependencies", () => {
  it("is sent the pinned plan in the prepare payload, and a proposal without dependencies is sent none", async () => {
    const t = await bench();
    await on(async () => {
      const { started } = await proposeAndCheck(t, withDependency());
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      const [record] = candidates(t);
      const sent = outboxPayload(t, record!.workspaceId)["testServices"] as { dependencies: Array<{ id: string; catalogId: string; digest: string; repository: string }> };
      expect(sent.dependencies.map((entry) => [entry.id, entry.catalogId, entry.repository])).toEqual([["postgres", "postgres@16", "svc/postgres"]]);
      expect(sent.dependencies[0]!.digest).toMatch(/^[a-f0-9]{64}$/u);
    });
  });

  it("is refused, in fixed words and before anything is written, when no catalog can pin it", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await on(async () => {
      const { started } = await proposeAndCheck(t, withDependency());
      expect(started.status).toBe(400);
      expect(errorOf(started).message).toContain("could not be checked");
      expect(candidates(t)).toEqual([]);
    });
  });

  it("carries no testServices for a proposal without dependencies, with tx on or off (golden)", async () => {
    const t = await bench();
    await withSwitch("1", async () => {
      const { started } = await proposeAndCheck(t, draftBody());
      expect(started.status).toBe(202);
      expect(outboxPayload(t, candidates(t)[0]!.workspaceId)).not.toHaveProperty("testServices");
    });
    await on(async () => {
      const second = await bench();
      const { started } = await proposeAndCheck(second, draftBody());
      expect(started.status).toBe(202);
      expect(outboxPayload(second, candidates(second)[0]!.workspaceId)).not.toHaveProperty("testServices");
    });
  });
});

describe("the record that comes back", () => {
  it("is kept on the check, out of the operation's stored result, and Prove derives its steps from it", async () => {
    const t = await bench();
    await on(async () => {
      const { digest } = await proposeAndCheck(t, withDependency());
      const [record] = candidates(t);
      await t.finish(record!.workspaceId, prepareOf(t, record!.workspaceId), "SUCCEEDED", { result: { testServicesUsage: usage() } });
      expect(candidates(t)[0]!.usage).toEqual(usage());
      const stored = t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === record!.workspaceId)[0] as unknown as { result?: Record<string, unknown> };
      expect(JSON.stringify(stored.result ?? {})).not.toContain("testServicesUsage");
      const proved = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(proved.status, JSON.stringify(proved.body)).toBe(200);
      const steps = proveSteps(t);
      expect(steps).toEqual(expect.arrayContaining([{ step: "dependencies", status: "passed" }, { step: "dependency_usage", status: "passed" }]));
      expect(testEnvDigest(withDependency())).toBe(digest);
    });
  });

  it("fails the Prove steps when the record says a dependency was unhealthy or an unknown name was called", async () => {
    for (const record of [usage({ dependencies: [{ id: "postgres", started: true, healthy: false, startMs: 30_000, resetCount: 0, failure: "not_healthy" }] }), usage({ unknownCalls: { domains: [{ domain: "example-pay.com", count: 2 }], otherCount: 0 } })]) {
      const t = await bench();
      await on(async () => {
        const { digest } = await proposeAndCheck(t, withDependency());
        const [candidate] = candidates(t);
        await t.finish(candidate!.workspaceId, prepareOf(t, candidate!.workspaceId), "SUCCEEDED", { result: { testServicesUsage: record } });
        await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
        expect(proveSteps(t).filter((entry) => entry.step === "dependencies" || entry.step === "dependency_usage").some((entry) => entry.status === "failed")).toBe(true);
      });
    }
  });

  it("with no record the Prove is refused, in fixed words", async () => {
    const t = await bench();
    await on(async () => {
      const { digest } = await proposeAndCheck(t, withDependency());
      const [candidate] = candidates(t);
      await t.finish(candidate!.workspaceId, prepareOf(t, candidate!.workspaceId), "SUCCEEDED", {});
      const refused = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(refused.status).toBe(400);
      expect(errorOf(refused).message).toContain("did not start its dependencies");
    });
  });

  it("refuses, logs and keeps nothing for a record that does not parse, one that arrives with tx off, and a second one", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await bench();
    await on(async () => {
      await proposeAndCheck(t, withDependency());
      const [candidate] = candidates(t);
      const attempt = (result: unknown, env?: NodeJS.ProcessEnv) => keepCandidateUsage(store(t), { orgId: TEST_ORG, workspaceId: candidate!.workspaceId, result, ...(env === undefined ? {} : { env }) });
      expect(await attempt({ testServicesUsage: { ...usage(), extra: 1 } })).toBe("refused");
      expect(await attempt({ testServicesUsage: "text" })).toBe("refused");
      expect(await attempt({ testServicesUsage: usage() }, { TEST_ENVIRONMENT_ENABLED: "1" })).toBe("refused");
      expect(candidates(t)[0]!.usage).toBeUndefined();
      expect(await attempt({ testServicesUsage: usage() })).toBe("kept");
      expect(await attempt({ testServicesUsage: usage({ unknownCalls: { domains: [], otherCount: 9 } }) })).toBe("refused");
      expect(candidates(t)[0]!.usage).toEqual(usage());
      const lines = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("test_services.usage_refused"));
      expect(lines).toHaveLength(4);
      expect(lines.join("\n")).not.toContain("startMs");
    });
  });

  it("is written only after the terminal transaction committed: a repeated report cannot add the record to a result that already ended without one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await bench();
    await on(async () => {
      await proposeAndCheck(t, withDependency());
      const [candidate] = candidates(t);
      const operation = prepareOf(t, candidate!.workspaceId);
      await t.finish(candidate!.workspaceId, operation, "SUCCEEDED", {});
      // The operation has ended. A second report of the same status, now carrying the record, is the repeat the terminal path answers with the stored operation: it never reaches the hook.
      await t.finish(candidate!.workspaceId, operation, "SUCCEEDED", { result: { testServicesUsage: usage() } });
      expect(candidates(t)[0]!.usage).toBeUndefined();
    });
  });

  it("a callback for a workspace whose fence moved on keeps nothing (the record is written only after the terminal transaction's fence check held)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await bench();
    await on(async () => {
      await proposeAndCheck(t, withDependency());
      const [candidate] = candidates(t);
      const operation = prepareOf(t, candidate!.workspaceId);
      const meta = t.db.get(`WORKSPACE#${candidate!.workspaceId}`, "META") as Record<string, unknown>;
      t.db.set({ ...meta, fence: Number(meta["fence"]) + 1 });
      await expect(t.finish(candidate!.workspaceId, operation, "SUCCEEDED", { result: { testServicesUsage: usage() } })).rejects.toThrow();
      expect(candidates(t)[0]!.usage).toBeUndefined();
    });
  });

  it("is scoped by org: another org's report, and a workspace that is no candidate check, keep nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await bench();
    await on(async () => {
      await proposeAndCheck(t, withDependency());
      const [candidate] = candidates(t);
      expect(await keepCandidateUsage(store(t), { orgId: "org_bbbbbbbbbbbbbbbbbbbb", workspaceId: candidate!.workspaceId, result: { testServicesUsage: usage() } })).toBe("refused");
      expect(await keepCandidateUsage(store(t), { orgId: TEST_ORG, workspaceId: randomUUID(), result: { testServicesUsage: usage() } })).toBe("refused");
      expect(candidates(t)[0]!.usage).toBeUndefined();
    });
  });

  it("is inert for a result without the key: nothing is read or written", async () => {
    const db = { send: vi.fn(async () => { throw new Error("must not be called"); }) };
    for (const result of [{}, { other: 1 }, undefined, null, "text", []]) {
      expect(await keepCandidateUsage({ documentClient: db, tableName: "t", now: Date.now }, { orgId: TEST_ORG, workspaceId: "ws", result })).toBe("none");
    }
    expect(db.send).not.toHaveBeenCalled();
  });
});
