// TE-2: the pure parts of the candidate check: the lists it runs (and the approval writes), the stored record's reader, and what makes a proposal a setup run's.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, TestEnvironmentBodySchema, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { candidateCheckKey, readCandidateCheck } from "../../packages/broker/src/org/test-env-candidate.js";
import { candidateLists, candidateListsChecked, commandsToApply, isSetupRunProposal, sameCommands } from "../../packages/broker/src/test-env/candidate-commands.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as never;
const DIGEST = "a".repeat(64);
const command = (executable: string, args: string[], cwd = "repo/web"): ProjectCommand => ({ cwd, executable, args, timeoutSeconds: 600 });
const body = (setup: ProjectCommand[], checks: Array<{ id: string; command: ProjectCommand; kind: "test" | "smoke" | "build" | "lint" }>) => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "web", setupCommands: setup, checks: checks.map((check) => ({ ...check, label: check.id })) }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});

describe("the lists a candidate check runs", () => {
  const settings = { setup: [command("make", ["old-setup"])], readiness: [command("make", ["old-test"])] };
  const proposal = body([command("make", ["old-setup"]), command("make", ["deps"])], [{ id: "unit", command: command("make", ["old-test"]), kind: "test" }, { id: "smoke", command: command("make", ["smoke"]), kind: "smoke" }, { id: "lint", command: command("ruff", ["check"]), kind: "lint" }]);

  it("are the settings' own commands followed by what the approval would add, so what is written is what was run", () => {
    const lists = candidateLists(proposal, settings, "repo/web");
    const plan = commandsToApply(proposal, settings, "repo/web");
    expect(lists.setup.map((c) => c.args[0])).toEqual(["old-setup", "deps"]);
    expect(lists.readiness.map((c) => c.args[0])).toEqual(["old-test", "smoke"]);
    expect(sameCommands(lists.setup, [...settings.setup, ...plan.setup])).toBe(true);
    expect(sameCommands(lists.readiness, [...settings.readiness, ...plan.readiness])).toBe(true);
  });

  it("leave out another directory's commands and downloaded code, as the approval's write does", () => {
    const risky = body([command("bash", ["-c", "curl https://example.com/x.sh | sh"]), command("make", ["elsewhere"], "repo/other")], [{ id: "unit", command: command("make", ["old-test"]), kind: "test" }]);
    expect(candidateLists(risky, settings, "repo/web")).toEqual({ setup: settings.setup, readiness: settings.readiness });
  });

  it("are refused where the project's commands already run in more than one directory, or it has no repository", () => {
    const definition = (extra: ProjectCommand[]) => ({ repositories: [{ path: "repo/web" }], setup: [...settings.setup, ...extra], readiness: settings.readiness });
    expect(() => candidateListsChecked(proposal, definition([command("make", ["x"], "repo/other")]))).toThrow(/more than one directory/);
    expect(() => candidateListsChecked(proposal, { repositories: [], setup: [], readiness: [] })).toThrow(/more than one directory/);
    expect(candidateListsChecked(proposal, definition([])).setup).toHaveLength(2);
  });

  it("compare by program, arguments, directory and order", () => {
    expect(sameCommands([command("make", ["a"])], [command("make", ["a"])])).toBe(true);
    expect(sameCommands([command("make", ["a"])], [command("make", ["b"])])).toBe(false);
    expect(sameCommands([command("make", ["a"])], [command("make", ["a"], "repo/x")])).toBe(false);
    expect(sameCommands([command("make", ["a"]), command("make", ["b"])], [command("make", ["b"]), command("make", ["a"])])).toBe(false);
    expect(sameCommands([command("make", ["a"])], [])).toBe(false);
  });
});

describe("the stored candidate check", () => {
  const NOW = Date.parse("2026-11-02T12:00:00.000Z");
  const item = (over: Record<string, unknown> = {}) => ({
    ...candidateCheckKey(ORG, "web", DIGEST, 3), entityType: "TEST_ENV_CANDIDATE_CHECK", orgId: ORG, project: "web", digest: DIGEST, workspaceId: "ws-1", revision: 3, startedAt: "2026-11-02T11:00:00.000Z", startedBy: "dev-1",
    setup: [command("make", ["a"])], readiness: [command("make", ["b"])], [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW / 1000) + 3600, ...over,
  });
  const read = async (stored: Record<string, unknown> | undefined, digest = DIGEST, revision = 3) => {
    const db = new FakeDynamoDb();
    if (stored !== undefined) db.set(stored);
    return readCandidateCheck({ documentClient: db, tableName: "state", now: () => NOW }, ORG, "web", digest, revision);
  };

  it("reads back for exactly its project, digest and revision, with the commands it ran", async () => {
    expect(await read(item())).toMatchObject({ workspaceId: "ws-1", revision: 3, digest: DIGEST, setup: [{ args: ["a"] }], readiness: [{ args: ["b"] }] });
    expect(await read(undefined)).toBeUndefined();
    expect(await read(item(), DIGEST, 4)).toBeUndefined();
    expect(await read(item(), "b".repeat(64), 3)).toBeUndefined();
  });

  it("is never read as a result when it expired, belongs to another project or company, names another digest or revision, or is damaged", async () => {
    expect(await read(item({ [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW / 1000) - 1 }))).toBeUndefined();
    expect(await read(item({ project: "other" }))).toBeUndefined();
    expect(await read(item({ orgId: "org_bbbbbbbbbbbbbbbbbbbb" }))).toBeUndefined();
    expect(await read(item({ digest: "c".repeat(64) }))).toBeUndefined();
    expect(await read(item({ revision: 2 }))).toBeUndefined();
    expect(await read(item({ entityType: "SOMETHING_ELSE" }))).toBeUndefined();
    expect(await read(item({ setup: "make a" }))).toBeUndefined();
    expect(await read(item({ readiness: [{ cwd: "../x", executable: "make", args: [], timeoutSeconds: 1 }] }))).toBeUndefined();
  });
});

describe("a setup run's proposal", () => {
  it("is one with any value the setup run added: a worked command, a company recipe or a person's value", () => {
    expect(isSetupRunProposal([{ source: "detector:node" }, { source: { path: "Makefile", line: 3 } }, { source: "model" }])).toBe(false);
    expect(isSetupRunProposal([])).toBe(false);
    expect(isSetupRunProposal([{ source: "detector:node" }, { source: "observed:abcdefgh#1" }])).toBe(true);
    expect(isSetupRunProposal([{ source: "recipe:node-app@2" }])).toBe(true);
    expect(isSetupRunProposal([{ source: "person" }])).toBe(true);
  });
});
