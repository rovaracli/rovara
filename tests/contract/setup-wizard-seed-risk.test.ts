// SEED-RISK-1, through the whole broker: the look's propose locks a detected seed command from the repository as GitHub gives it at the default branch's head, the setup page shows that proposal (not the unlocked
// one it recomputes from the draft) as MEDIUM with the reason, and one maintainer approves it with one press. A model's seed, or a GitHub that cannot be read, stays HIGH.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionCardsViewSchema, type TestEnvDraft } from "../../packages/contracts/src/index.js";
import { OMAR } from "../support/developer-task-broker.js";
import { ENV, command, draftBody, draftOf, setupWizardBench, withSwitch } from "../support/setup-wizard-testenv.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

afterEach(() => { delete process.env.TEST_SERVICES_ENABLED; delete process.env.DECISION_CARDS_ENABLED; vi.restoreAllMocks(); });

const SEED = command("npm", ["run", "seed"], 900);
const FILES: Record<string, string> = { "package.json": JSON.stringify({ scripts: { seed: "node db/seed.js" } }), "db/seed.js": "const { Client } = require('pg');\n" };
const postgres = { family: "postgres", kind: "database", evidence: [{ path: "src/db.ts", line: 2 }], strength: "used", hints: { envNames: ["DATABASE_URL"] } };
const draftWith = (source: unknown): TestEnvDraft => ({ ...draftOf(draftBody()), dependencies: [postgres], seedCommands: [{ command: SEED, source }] } as unknown as TestEnvDraft);
function bench(options: { down?: boolean; truncated?: boolean; mode?: string; type?: string; defaultBranch?: string } = {}) {
  const reads: string[] = [];
  const github = {
    reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(),
    // M1: GitHub's own default branch, compared with the project's.
    getRepositoryIdentity: vi.fn(async () => ({ defaultBranch: options.defaultBranch ?? "main" })),
    getDefaultBranchHead: vi.fn(async () => "c".repeat(40)),
    listTreeAtCommit: vi.fn(async () => {
      if (options.down === true) throw new Error("GitHub returned 502");
      return { truncated: options.truncated === true, entries: Object.keys(FILES).map((path) => ({ path, mode: path === "db/seed.js" ? options.mode ?? "100644" : "100644", type: path === "db/seed.js" ? options.type ?? "blob" : "blob", sha: "a".repeat(40) })) };
    }),
    getFileAtCommit: vi.fn(async (_url: string, path: string) => { reads.push(path); return FILES[path]; }),
  };
  return { reads, t: setupWizardBench({ brokerExtra: { serviceCatalog: async () => verifiedCatalog(pinnedCatalog()), githubPullRequests: github } }) };
}
/** The candidate check of the digest passed, and its worker reported that Postgres started healthy (what a Prove of an environment with dependencies reads). */
function checked(t: Awaited<ReturnType<typeof bench>["t"]>, digest: string): void {
  const workspaceId = t.candidatePassed(digest);
  const record = t.db.find((item) => item.digest === digest && item.workspaceId === workspaceId && item.entityType !== "TEST_ENV_PROPOSAL")[0]!;
  t.db.set({ ...record, usage: { schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 840, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 } } });
}
type Shown = { digest: string; risk: string; lessSafe: string[]; needs: { secondPerson: boolean; freshSignIn: boolean }; seedRisks: Array<{ dependencyId: string; risk: string; reason: string }> };

describe("a detected seed command through the setup routes", () => {
  it("is locked at propose, shown as MEDIUM with its reason, and approved by one maintainer with one press", async () => {
    process.env.TEST_SERVICES_ENABLED = "1";
    const { t: started, reads } = bench();
    const t = await started;
    await withSwitch("1", async () => {
      await t.drafted(draftWith({ path: "package.json", line: 4 }));
      expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      expect(reads).toEqual(["package.json", "db/seed.js"]);
      const shown = (await t.state()).proposal as unknown as Shown;
      expect(shown).toMatchObject({ risk: "medium", lessSafe: [], needs: { secondPerson: false, freshSignIn: false } });
      expect(shown.seedRisks.map((entry) => [entry.dependencyId, entry.risk])).toEqual([["postgres", "medium"]]);
      expect(shown.seedRisks[0]!.reason).toMatch(/^Medium: one maintainer can approve it\. The seed runs the repository's own script, unchanged on main at c{12} \(2 files\)\./u);
      checked(t, shown.digest);
      const proved = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest: shown.digest });
      expect(proved.status, JSON.stringify(proved.body)).toBe(200);
      // The decision card says the same: MEDIUM, the reason first, and a one-press approve.
      process.env.DECISION_CARDS_ENABLED = "1";
      const listed = await t.dev(OMAR, "GET", "/v1/app/decisions");
      const { requestId: _gateway, ...own } = listed.body; void _gateway;
      const card = DecisionCardsViewSchema.parse(own).cards.find((item) => item.kind === "approve_test_env")!;
      expect(card).toMatchObject({ risk: "medium" });
      expect(card.riskReasons.slice(1, 3)).toEqual(["Seed: the repository's own script, unchanged on main (db/seed.js, package.json).", "One maintainer approves; it has the same access as setup and is rechecked each run."]);
      expect(card.actions.map((action) => action.kind)).toContain("approve");
      const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest: shown.digest, expectedRevision: 0 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({ revision: 1 });
    });
  });

  const FOUND = { path: "package.json", line: 4 };
  it.each([
    ["the model proposed it", "model", {}],
    ["GitHub could not be read", FOUND, { down: true }],
    ["GitHub cut the tree listing short", FOUND, { truncated: true }],
    ["the seed file is a link", FOUND, { mode: "120000" }],
    ["the seed file is a submodule", FOUND, { mode: "160000", type: "commit" }],
    ["the project's branch is not GitHub's default branch", FOUND, { defaultBranch: "trunk" }],
  ] as const)("stays HIGH with a second person when %s", async (_name, source, options) => {
    process.env.TEST_SERVICES_ENABLED = "1";
    const { t: started } = bench(options);
    const t = await started;
    await withSwitch("1", async () => {
      await t.drafted(draftWith(source));
      expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      const shown = (await t.state()).proposal as unknown as Shown;
      expect(shown).toMatchObject({ risk: "high", lessSafe: ["dependency_seed"], needs: { secondPerson: true } });
      expect(shown.seedRisks[0]).toMatchObject({ risk: "high" });
      checked(t, shown.digest);
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest: shown.digest })).status).toBe(200);
      expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest: shown.digest, expectedRevision: 0 })).status).not.toBe(200);
    });
  });
});
