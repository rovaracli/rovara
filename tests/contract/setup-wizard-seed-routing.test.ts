// TS-UX-1 (0.5.10) review fixes, through the whole broker: a migrate or seed command leaves the SETUP proposal only when a database dependency actually took it as its seed (I-1), the seed field shows and edits every
// command and the audit line says what changed (I-2, M-4), and the role is checked before anything else is read (M-1).
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_ENV_DRAFT_RESULT_KEY, type TestEnvDraft } from "../../packages/contracts/src/index.js";
import { SEED_LEFT_OUT_OF_SETUP_NOTE } from "../../packages/broker/src/test-env/seed-routing.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { ENV, NAME, command, draftBody, draftOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

void TEST_ENV_DRAFT_RESULT_KEY;
afterEach(() => { delete process.env.TEST_SERVICES_ENABLED; vi.restoreAllMocks(); });

const SETUP = ["npm ci", "npx prisma migrate deploy"];
const setupProposal = (commands = SETUP) => ({ setup: [{ repo: "web", commands, confidence: "high", from: [{ kind: "inferred", repo: "web", note: "a package.json" }] }], tests: [], notes: "ok" });
const MIGRATE = command("npx", ["prisma", "migrate", "deploy"], 900);
const environment = () => draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("npm", ["ci"], 900), MIGRATE], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }] }] });
const draftWith = (candidates: unknown[]): TestEnvDraft => ({
  ...draftOf(environment()),
  valueSources: [{ field: "repos[0].setupCommands[0]", source: "model" }, { field: "repos[0].setupCommands[1]", source: "model" }],
  dependencies: candidates, seedCommands: [{ command: MIGRATE, source: "model" }],
} as unknown as TestEnvDraft);
const postgres = { family: "postgres", kind: "database", evidence: [{ path: "src/db.ts", line: 2 }], strength: "used", hints: { envNames: ["DATABASE_URL"] } };
const redis = { family: "redis", kind: "cache", evidence: [{ path: "src/cache.ts", line: 1 }], strength: "used", hints: {} };
const bench = () => setupWizardBench({ brokerExtra: { serviceCatalog: async () => verifiedCatalog(pinnedCatalog()) } });
const setupCommandsOf = async (t: Bench) => {
  const reply = await t.dev(OMAR, "GET", `/v1/app/projects/${NAME}/setup-draft`);
  const proposal = reply.body.proposal as { setup: Array<{ value: { commands: string[] } }>; notes: string };
  return { commands: proposal.setup.flatMap((item) => item.value.commands), notes: proposal.notes };
};

describe("I-1: setup keeps its migrate step unless a dependency took it", () => {
  it("test environment on, test services OFF: the setup proposal and the proposed environment both keep the migrate step, and no note says it was offered as a seed", async () => {
    const t = await bench();
    await withSwitch("1", async () => {
      await t.drafted(draftWith([postgres]), { setupProposal: setupProposal() });
      const seen = await setupCommandsOf(t);
      expect(seen.commands).toEqual(SETUP);
      expect(seen.notes).not.toContain(SEED_LEFT_OUT_OF_SETUP_NOTE);
      expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      expect((await t.state()).proposal!.runs[0]!.setup).toEqual(SETUP);
    });
  });
  it("no database could be proposed (a Django or SQLite project: the code names a database URL, only a cache could be backed): the migrate step stays in both", async () => {
    const t = await bench();
    process.env.TEST_SERVICES_ENABLED = "1";
    await withSwitch("1", async () => {
      await t.drafted(draftWith([redis]), { setupProposal: setupProposal() });
      expect((await setupCommandsOf(t)).commands).toEqual(SETUP);
      expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      expect((await t.state()).proposal!.runs[0]!.setup).toEqual(SETUP);
    });
  });
  it("services ON and a database proposed: the migrate step moves to the dependency's seed, out of the setup proposal and the environment's setup, with the note (positive control)", async () => {
    const t = await bench();
    process.env.TEST_SERVICES_ENABLED = "1";
    await withSwitch("1", async () => {
      await t.drafted(draftWith([postgres]), { setupProposal: setupProposal(["npm ci", "npx prisma migrate deploy", "npm run build"]) });
      const seen = await setupCommandsOf(t);
      expect(seen.commands).toEqual(["npm ci", "npm run build"]);
      expect(seen.notes).toContain(SEED_LEFT_OUT_OF_SETUP_NOTE);
      expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      const { proposal } = await t.state();
      expect(proposal!.runs[0]!.setup).toEqual(["npm ci"]);
      expect(proposal).toMatchObject({ lessSafe: ["dependency_seed"], risk: "high" });
      expect((proposal as unknown as { dependencySeeds: unknown }).dependencySeeds).toEqual([{ id: "postgres", name: "Postgres", commands: ["npx prisma migrate deploy"] }]);
    });
  });
});

describe("the seed route", () => {
  const seedBody = (digest: string, over: Record<string, unknown> = {}) => ({ digest, dependencyId: "postgres", commands: ["npx prisma migrate deploy", "npm run seed"], ...over });
  const proposed = async (t: Bench) => {
    process.env.TEST_SERVICES_ENABLED = "1";
    await t.drafted(draftWith([postgres]), { setupProposal: setupProposal() });
    expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
    return (await t.state()).proposal!.digest;
  };

  it("checks the role before the dependency or the proposal is looked up: a viewer is refused FORBIDDEN whatever they send, a maintainer gets the real answer", async () => {
    const t = await bench();
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      await t.person(MAYA, "member", "viewer");
      const probes = [seedBody(digest), seedBody(digest, { dependencyId: "no-such-dependency" }), seedBody("f".repeat(64)), seedBody(digest, { commands: ["npm run a && npm run b"] })];
      for (const body of probes) {
        const reply = await t.web(MAYA, "POST", `${ENV}/seed`, body);
        expect(reply.status, JSON.stringify(reply.body)).toBe(403);
        expect((reply.body.error as { code: string }).code).toBe("FORBIDDEN");
      }
      // Nothing was stored, and the same unknown dependency is a plain answer for a maintainer.
      expect(t.db.find((item) => item.entityType === "TEST_ENV_PROPOSAL")).toHaveLength(1);
      const own = await t.web(OMAR, "POST", `${ENV}/seed`, seedBody(digest, { dependencyId: "no-such-dependency" }));
      expect(own.status).toBe(400);
    });
  });
  it("sets every command in order, and the audit line says which dependency and whether it was set or cleared", async () => {
    const t = await bench();
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const set = await t.web(OMAR, "POST", `${ENV}/seed`, seedBody(digest, { commands: ["npx prisma migrate deploy", "npm run seed"] }));
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      const shown = (set.body as { proposal: { digest: string; dependencySeeds: unknown } }).proposal;
      expect(shown.dependencySeeds).toEqual([{ id: "postgres", name: "Postgres", commands: ["npx prisma migrate deploy", "npm run seed"] }]);
      const cleared = await t.web(OMAR, "POST", `${ENV}/seed`, seedBody(shown.digest, { commands: [] }));
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      const events = log.mock.calls.map((call) => { try { return JSON.parse(String(call[0])) as Record<string, string>; } catch { return {}; } }).filter((entry) => entry.event === "developer.test_env_seed_set");
      expect(events).toMatchObject([{ dependencyId: "postgres", change: "set", commands: "2" }, { dependencyId: "postgres", change: "cleared", commands: "0" }]);
      expect(events.every((entry) => typeof entry.digest === "string" && entry.digest.length === 64)).toBe(true);
    });
  });
});
