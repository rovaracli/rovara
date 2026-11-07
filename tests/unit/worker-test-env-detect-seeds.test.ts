// TS-UX-1 (0.5.10): a seed or migration command needs a database that exists only inside the test environment, so the draft never puts one in SETUP. It is the database dependency's seed (carried in the draft,
// attached by the broker). Only when a database was found: with none, nothing says the command needs one, and the setup commands stay as they were.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestEnvDraftSchema, formatCommandLine, type SetupProposal } from "@agentx/contracts";
import { SEED_LEFT_OUT_OF_SETUP_NOTE, detectTestEnvironment, withoutRoutedSeeds } from "../../packages/worker/src/test-env-detect.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "te-detect-seeds-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function write(path: string, text: string) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); }
const repo = { name: "svc", path: "svc", defaultBranch: "main" };
const proposal = (setup: string[]) => ({
  basedOnRevision: 3, notes: "",
  setup: setup.length === 0 ? [] : [{ id: "setup-svc", value: { repo: "svc", commands: setup }, from: [], confidence: "high", risk: "safe" }],
  tests: [], flaggedCommands: [],
}) as unknown as SetupProposal;
const PACKAGE = JSON.stringify({ scripts: { test: "vitest run", seed: "node scripts/seed.js" }, dependencies: {} });
const DB_CODE = "export const url = process.env.DATABASE_URL;\n";
const setupLines = (draft: Awaited<ReturnType<typeof detectTestEnvironment>>) => draft!.environment.repos[0]!.setupCommands.map(formatCommandLine);

describe("seed commands are the database's, never setup's", () => {
  it("offers a package.json seed script as the seed when a database is found from code, and leaves it out of setup", async () => {
    await write("svc/package.json", PACKAGE);
    await write("svc/src/db.ts", DB_CODE);
    const draft = await detectTestEnvironment({ rootPath: root, repositories: [repo] });
    expect(TestEnvDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft!.dependencies!.map((item) => item.family)).toEqual(["postgres"]);
    expect(draft!.seedCommands!.map((seed) => formatCommandLine(seed.command))).toEqual(["npm run seed"]);
    expect(draft!.seedCommands![0]).toMatchObject({ source: { path: "package.json", line: 1 }, command: { cwd: "svc" } });
    expect(setupLines(draft)).not.toContain("npm run seed");
  });
  it("moves the setup agent's own seed command out of setup, keeping its other commands", async () => {
    await write("svc/package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    await write("svc/src/db.ts", DB_CODE);
    const draft = await detectTestEnvironment({ rootPath: root, repositories: [repo], setupProposal: proposal(["npm ci", "npm run db:seed", "npx prisma migrate deploy"]) });
    expect(setupLines(draft)).toContain("npm ci");
    expect(setupLines(draft).some((line) => /seed|migrate/u.test(line))).toBe(false);
    expect(draft!.seedCommands!.map((seed) => [formatCommandLine(seed.command), seed.source])).toEqual([["npm run db:seed", "model"], ["npx prisma migrate deploy", "model"]]);
  });
  it("changes nothing when no database was found (positive control: the same command is routed once a database is)", async () => {
    await write("svc/package.json", JSON.stringify({ scripts: { test: "vitest run", seed: "node seed.js" } }));
    const draft = await detectTestEnvironment({ rootPath: root, repositories: [repo], setupProposal: proposal(["npm run seed"]) });
    expect(setupLines(draft)).toContain("npm run seed");
    expect(draft!.seedCommands).toBeUndefined();
    await write("svc/src/db.ts", DB_CODE);
    const routed = await detectTestEnvironment({ rootPath: root, repositories: [repo], setupProposal: proposal(["npm run seed"]) });
    expect(setupLines(routed)).not.toContain("npm run seed");
  });
  it("takes the routed seed out of the setup proposal too, with one note, and leaves it alone when nothing was routed", async () => {
    await write("svc/package.json", PACKAGE);
    await write("svc/src/db.ts", DB_CODE);
    const original = proposal(["npm ci", "npm run seed"]);
    const draft = await detectTestEnvironment({ rootPath: root, repositories: [repo], setupProposal: original });
    const stripped = withoutRoutedSeeds(original, draft);
    expect(stripped.setup[0]!.value.commands).toEqual(["npm ci"]);
    expect(stripped.notes).toContain(SEED_LEFT_OUT_OF_SETUP_NOTE);
    expect(withoutRoutedSeeds(stripped, draft)).toBe(stripped);
    const onlySeed = withoutRoutedSeeds(proposal(["npm run seed"]), draft);
    expect(onlySeed.setup).toEqual([]);
    expect(withoutRoutedSeeds(original, undefined)).toBe(original);
  });
});
