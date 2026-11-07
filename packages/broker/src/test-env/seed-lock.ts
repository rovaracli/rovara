// Test services, SEED-RISK-1 (owner decision 2026-11-07, "Yes, after security review"): a seed command DETECTED UNCHANGED from the repository's own seed script, whose every dependency is Rovara's own throwaway test
// software, is a MEDIUM change (one maintainer approves it on the card). Owner decision 15: such a seed has the same reach as the project's setup commands (in the working phase it can reach the internet), and that
// is accepted. Everything else about a seed command stays HIGH (a second person). This file is the broker's half:
//
//   - `lockLookSeeds`: when a maintainer proposes what the look found, the BROKER resolves each seed command itself, against the repository at the head of its default branch as the code host gives it
//     (`SeedRepoSource`; the branch must be GitHub's own default branch, and the commit it hashed is kept), never from the worker's report or the model: the command must be one the detectors found (its source a file and line or a detector; `model` or a setup run's source is HIGH), every target
//     must be the sealed test database (`seedTargetsOnlySealedTestDb`), and the contract's resolver (seed-script-lock.ts) must lock it. A lock the body already carried is dropped first and made again, so a lock
//     written by anyone else is never kept. The result for EVERY seed command (locked, or why not) is the proposal's `seedChecks`, written with the proposal by the broker alone.
//   - `seedTrustOf`: the seeds that count as verified for one body: a check that says `locked` for exactly that seed's signature (command and lock hash). A proposal stored without checks (an edit, the seed field, a setup
//     run, a proposal from before this change) verifies nothing: every seed command in it is HIGH. A damaged record verifies nothing.
//   - the worker re-hashes the lock from its checkout before every run of the seed and refuses on a difference (worker service-reset.ts), so a MEDIUM seed never runs with changed ENTRY files. What those files
//     load through packages, aliases or `.env` is not pinned (seed-script-lock.ts says exactly what is).
// Fail closed everywhere: no code host, a read that fails, a host other than GitHub, a source that is not a detector's: no lock, HIGH.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  INDEX_EXPIRY_ATTRIBUTE, SEED_LOCK_REFUSALS, SEED_LOCK_REFUSAL_WORDS, TestEnvironmentBodySchema, projectPk, seedScriptLockOf, seedTargetsOnlySealedTestDb, testEnvSeedSignature,
  type OrgId, type SeedSourceReader, type TestEnvDraft, type TestEnvironmentBody, type TestEnvSeedTrust,
} from "@agentx/contracts";
import { sameCommand } from "./seed-routing.js";

/**
 * One repository of the project as the broker reads it for a seed's lock: its folder in the workspace, the default branch and the ONE commit read, and a reader rooted at a folder inside it at that commit. A repository
 * that cannot be read this way (another host, a tree cut short, a configured branch that is not GitHub's default) is still listed, with why, so a seed in its folder is HIGH and never falls through to a parent repository.
 */
export type SeedRepoSource = { path: string; branch: string; commit: string; readerAt(directory: string): SeedSourceReader } | { path: string; refusal: "no_reader" | "not_default_branch" };
/** The project's repositories for seed locks, or a throw when they cannot be read (then nothing is locked). */
export type SeedRepoSources = (orgId: OrgId, project: string) => Promise<SeedRepoSource[]>;

export const SEED_CHECK_REASONS = [...SEED_LOCK_REFUSALS, "not_detected", "not_sealed", "no_repository", "no_reader", "not_default_branch"] as const;
export type SeedCheckReason = (typeof SEED_CHECK_REASONS)[number];
const REASON_WORDS: Record<SeedCheckReason, string> = {
  ...SEED_LOCK_REFUSAL_WORDS,
  not_detected: "it was not found in the repository by Rovara's detectors (it was proposed by the model or a setup run)",
  not_sealed: "the test environment can reach something other than Rovara's own test database",
  no_repository: "it does not run in one of the project's repositories",
  no_reader: "the repository could not be read to check it",
  not_default_branch: "the project's branch is not the repository's default branch on GitHub",
};

const SignatureSchema = z.string().min(1).max(20_000);
export const SeedCheckSchema = z.discriminatedUnion("verdict", [
  // The branch and the commit the broker hashed (M4): what the approval is of.
  z.object({ verdict: z.literal("locked"), dependencyId: z.string().min(1).max(80), signature: SignatureSchema, from: z.array(z.string().min(1).max(300)).min(1).max(32), branch: z.string().min(1).max(255), commit: z.string().regex(/^[a-f0-9]{40}$/u) }).strict(),
  z.object({ verdict: z.literal("high"), dependencyId: z.string().min(1).max(80), signature: SignatureSchema, reason: z.enum(SEED_CHECK_REASONS) }).strict(),
]);
export type SeedCheck = z.infer<typeof SeedCheckSchema>;
export const SeedChecksSchema = z.array(SeedCheckSchema).max(24 * 8);

/** A draft seed's source as the detectors give it: a file and line, or a detector. `model`, a setup run's observation, a company recipe or a person is not detected. */
function detectedSource(source: unknown): boolean {
  if (typeof source === "string") return /^detector:[a-z0-9_-]{1,40}$/u.test(source);
  return typeof source === "object" && source !== null && typeof (source as { path?: unknown }).path === "string" && typeof (source as { line?: unknown }).line === "number";
}

/** The repository a command runs in, and the command's folder inside it ("" at its root); undefined when it runs in none. */
function repositoryOf(sources: readonly SeedRepoSource[], cwd: string): { source: SeedRepoSource; directory: string } | undefined {
  const clean = cwd.replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, "");
  for (const source of [...sources].sort((left, right) => right.path.length - left.path.length)) {
    const root = source.path.replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, "");
    if (clean === root) return { source, directory: "" };
    if (root === "" || root === ".") return { source, directory: clean === "." ? "" : clean };
    if (clean.startsWith(`${root}/`)) return { source, directory: clean.slice(root.length + 1) };
  }
  return undefined;
}

/**
 * The proposal body with each eligible seed command locked by the broker, and the check of every seed command. `detected` is the draft's own seed commands (with their sources); `sources` the project's repositories
 * (undefined: no reader, nothing is locked). Never throws: a failure is a HIGH check.
 */
export async function lockLookSeeds(body: TestEnvironmentBody, detected: TestEnvDraft["seedCommands"], sources: SeedRepoSources | undefined, scope: { orgId: OrgId; project: string }): Promise<{ body: TestEnvironmentBody; checks: SeedCheck[] }> {
  const dependencies = body.dependencies ?? [];
  if (!dependencies.some((dependency) => dependency.seeds.some((seed) => "command" in seed))) return { body, checks: [] };
  let repositories: SeedRepoSource[] | undefined;
  try { repositories = sources === undefined ? undefined : await sources(scope.orgId, scope.project); } catch { repositories = undefined; }
  const checks: SeedCheck[] = [];
  const next = [];
  for (const dependency of dependencies) {
    const seeds = [];
    for (const seed of dependency.seeds) {
      if (!("command" in seed)) { seeds.push(seed); continue; }
      const plain = { command: seed.command };
      const high = (reason: SeedCheckReason) => { seeds.push(plain); checks.push({ verdict: "high", dependencyId: dependency.id, signature: testEnvSeedSignature(dependency.id, plain), reason }); };
      if (!(detected ?? []).some((item) => sameCommand(item.command, seed.command) && JSON.stringify(item.command.env ?? null) === JSON.stringify(seed.command.env ?? null) && detectedSource(item.source))) { high("not_detected"); continue; }
      if (!seedTargetsOnlySealedTestDb(body, dependency.id)) { high("not_sealed"); continue; }
      if (repositories === undefined) { high("no_reader"); continue; }
      const where = repositoryOf(repositories, seed.command.cwd);
      if (where === undefined) { high("no_repository"); continue; }
      const source = where.source;
      if ("refusal" in source) { high(source.refusal); continue; }
      const resolved = await seedScriptLockOf(seed.command, source.readerAt(where.directory));
      if (!resolved.ok) { high(resolved.refusal); continue; }
      const locked = { command: seed.command, lock: resolved.lock };
      seeds.push(locked);
      checks.push({ verdict: "locked", dependencyId: dependency.id, signature: testEnvSeedSignature(dependency.id, locked), from: resolved.lock.from, branch: source.branch, commit: source.commit });
    }
    next.push({ ...dependency, seeds });
  }
  const parsed = TestEnvironmentBodySchema.safeParse({ ...body, dependencies: next });
  if (!parsed.success) {
    // Never expected (a lock only adds a bounded field); fail closed to the body without any lock.
    const unlocked = { ...body, dependencies: dependencies.map((dependency) => ({ ...dependency, seeds: dependency.seeds.map((seed) => ("command" in seed ? { command: seed.command } : seed)) })) };
    return { body: TestEnvironmentBodySchema.parse(unlocked), checks: checks.map((check) => (check.verdict === "locked" ? { verdict: "high", dependencyId: check.dependencyId, signature: check.signature.replace(/#[a-f0-9]{64}$/u, ""), reason: "unreadable" } : check)) };
  }
  return { body: parsed.data, checks };
}

/** The checks a proposal was stored with, read again strictly: anything damaged reads as none (every seed HIGH). */
export function parseSeedChecks(stored: unknown): SeedCheck[] {
  const parsed = SeedChecksSchema.safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** The seeds of `body` the broker verified: a `locked` check for exactly the seed's signature (command and lock hash). The contract then also requires every target to be the sealed test database. */
export function seedTrustOf(checks: readonly SeedCheck[], body: TestEnvironmentBody): TestEnvSeedTrust {
  const locked = new Set(checks.flatMap((check) => (check.verdict === "locked" ? [check.signature] : [])));
  const verifiedSeeds = new Set<string>();
  for (const dependency of body.dependencies ?? []) {
    for (const seed of dependency.seeds) {
      if (!("command" in seed) || seed.lock === undefined) continue;
      const signature = testEnvSeedSignature(dependency.id, seed);
      if (locked.has(signature)) verifiedSeeds.add(signature);
    }
  }
  return { verifiedSeeds };
}

/** The medium reason, in full, for the setup page (I3: who approves, what is pinned, and that it has the reach of setup). */
const mediumReason = (check: Extract<SeedCheck, { verdict: "locked" }>): string =>
  `Medium: the seed runs the repository's own script, unchanged on ${check.branch} at ${check.commit.slice(0, 12)} (${check.from.join(", ")}). Rovara checks those files again before every run. It runs against Rovara's throwaway test database, with the same access as your setup commands (in the working phase it can reach the internet). One maintainer can approve it.`;

/** The card's short lines (a card shows at most 100 characters of each reason). */
export function seedCardLinesOf(risks: ReadonlyArray<{ risk: "medium" | "high"; reason: string }>, checks: readonly SeedCheck[], body: TestEnvironmentBody): string[] {
  const lines: string[] = [];
  const trust = seedTrustOf(checks, body).verifiedSeeds ?? new Set<string>();
  for (const check of checks) {
    if (check.verdict !== "locked" || !trust.has(check.signature)) continue;
    lines.push(`Seed: the repository's own script, unchanged on ${check.branch} (${check.from.join(", ")}).`, "One maintainer approves; it has the same access as setup and is rechecked each run.");
    break;
  }
  for (const entry of risks) if (entry.risk === "high") lines.push(entry.reason);
  return [...new Set(lines)];
}

/** Each seed command's risk and why, in fixed words, for the card and the setup page. */
export function seedRisksOf(checks: readonly SeedCheck[], body: TestEnvironmentBody): Array<{ dependencyId: string; risk: "medium" | "high"; reason: string }> {
  const trust = seedTrustOf(checks, body).verifiedSeeds ?? new Set<string>();
  const bySignature = new Map(checks.map((check) => [check.signature, check] as const));
  const out: Array<{ dependencyId: string; risk: "medium" | "high"; reason: string }> = [];
  for (const dependency of body.dependencies ?? []) {
    for (const seed of dependency.seeds) {
      if (!("command" in seed)) continue;
      const signature = testEnvSeedSignature(dependency.id, seed);
      const check = bySignature.get(signature);
      if (check?.verdict === "locked" && trust.has(signature) && seedTargetsOnlySealedTestDb(body, dependency.id)) {
        out.push({ dependencyId: dependency.id, risk: "medium", reason: mediumReason(check).slice(0, 400) });
      } else {
        const why = check?.verdict === "high" ? REASON_WORDS[check.reason] : check?.verdict === "locked" ? REASON_WORDS.not_sealed : "it was set or changed by a person, not detected unchanged from the repository";
        out.push({ dependencyId: dependency.id, risk: "high", reason: `Seed is high risk: ${why}.`.slice(0, 400) });
      }
    }
  }
  return out;
}

// ---- which locked proposal a look made

/**
 * The look's proposal is shown by recomputing it from the draft (no locks), so the broker keeps a pointer from that digest to the LOCKED proposal it stored. The pointer carries no authority: the proposal it names is
 * read and checked again like any other.
 */
type Table = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string };
const lookKey = (orgId: OrgId, project: string, digest: string) => ({ pk: projectPk(orgId, project), sk: `TESTENV#LOOKLOCK#${digest}` });
const DIGEST = /^[a-f0-9]{64}$/u;

export async function recordLockedLook(table: Table, scope: { orgId: OrgId; project: string; lookDigest: string; lockedDigest: string; expiresAtMs: number }): Promise<void> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...lookKey(scope.orgId, scope.project, scope.lookDigest), entityType: "TEST_ENV_LOOK_LOCK", orgId: scope.orgId, project: scope.project, lookDigest: scope.lookDigest, lockedDigest: scope.lockedDigest, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(scope.expiresAtMs / 1000) } }));
}

export async function lockedLookOf(table: Table, scope: { orgId: OrgId; project: string; lookDigest: string; nowMs: number }): Promise<string | undefined> {
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: lookKey(scope.orgId, scope.project, scope.lookDigest), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined || item["orgId"] !== scope.orgId || item["project"] !== scope.project || item["lookDigest"] !== scope.lookDigest || typeof item["lockedDigest"] !== "string" || !DIGEST.test(item["lockedDigest"])) return undefined;
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires * 1000 <= scope.nowMs) return undefined;
  return item["lockedDigest"];
}
