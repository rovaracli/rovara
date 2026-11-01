// Test environment (wire-testenv): the worker's half of "Rovara proposes the project's test environment". A SETUP_DRAFT run that was asked to detect (`testEnvDetect`) runs the environment detectors (env-detect/) over
// each repository of the workspace and reports ONE draft environment with the source of every value. Nothing is run: detectors read files and a draft is only a proposal. The broker reads it again, refuses anything
// but the safest tier, and a maintainer proves and approves it.
//
// Rules (owner decision "Setup reads the main branch only", ED-1):
//   - only the repositories as the setup draft cloned them: their default branch. A repository with a pull request head checked out (`checkedOut`) is skipped, so a pull request cannot change how Rovara sets a project
//     up or which commands the test drive runs;
//   - a link is never followed: every part of a path is `lstat`ed, a link or a special file is skipped, and a file is opened with O_NOFOLLOW;
//   - bounded: at most 5,000 files listed per repository (env-detect's own cap), a file over 256 KiB is not read, depth 8, and a total of 4 MiB per repository;
//   - the setup agent's own commands are added only through `proposalFromDraft` (it drops a flagged command, a download-and-run command, and one the detectors already propose).
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { TEST_ENV_DRAFT_MAX_BYTES, TestEnvDraftSchema, type SetupDraft, type SetupProposal, type TestEnvDraft, type TestEnvironmentBody } from "@agentx/contracts";
import { ENV_DETECT_MAX_FILE_BYTES, ENV_DETECT_MAX_PATHS, boundedReader, buildEnvironmentDraft, proposalFromDraft, runDetectors } from "./env-detect/index.js";

export interface DetectRepository { name: string; path: string; defaultBranch: string; checkedOut?: unknown }

/** Folders that never hold a project's own build or test setup. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".gradle", ".mvn-cache"]);
const MAX_DEPTH = 8;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The plain files of a directory, as repository-relative POSIX paths, without following any link. Bounded by the file count and the depth. */
export async function listRepositoryFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (found.length > ENV_DETECT_MAX_PATHS || depth > MAX_DEPTH) return;
    let entries: string[];
    try { entries = (await readdir(join(directory, relative))).sort(); } catch { return; }
    for (const name of entries) {
      if (found.length > ENV_DETECT_MAX_PATHS) return;
      if (SKIP_DIRECTORIES.has(name)) continue;
      const path = relative === "" ? name : `${relative}/${name}`;
      let info;
      try { info = await lstat(join(directory, path)); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile()) found.push(path);
    }
  };
  await walk("", 0);
  return found;
}

/** A file's text, or undefined when it is a link, too large, not UTF-8 text or unreadable. */
export async function readRepositoryFile(directory: string, path: string): Promise<string | undefined> {
  let handle;
  try {
    // O_NOFOLLOW covers the last part of the path only: a link in the middle (a folder that points elsewhere) is caught by checking where the path really ends up.
    const [base, real] = await Promise.all([realpath(directory), realpath(join(directory, path))]);
    if (!real.startsWith(`${base}${sep}`)) return undefined;
    handle = await open(join(directory, path), READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size > ENV_DETECT_MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(Math.min(info.size, ENV_DETECT_MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The commands the setup agent proposed for one repository, as the draft the environment builder fills its gaps from. */
function agentDraftFor(proposal: SetupProposal | undefined, repository: string): SetupDraft {
  const commands = (items: SetupProposal["setup"]) => items.filter((item) => item.value.repo === repository).flatMap((item) => item.value.commands).slice(0, 20);
  return {
    basedOnRevision: proposal?.basedOnRevision ?? 0,
    setupCommands: proposal === undefined ? [] : commands(proposal.setup),
    testCommands: proposal === undefined ? [] : commands(proposal.tests),
    allowedDomains: [], secretsNeeded: [],
    flaggedCommands: (proposal?.flaggedCommands ?? []).map((item) => ({ command: item.command, reason: item.reason })).slice(0, 40),
    notes: "",
  };
}

/** `unit` already taken by another repository becomes `unit-2`, `unit-3`: every check id of the environment is unique. */
function uniqueId(id: string, taken: Set<string>): string {
  let candidate = id;
  for (let n = 2; taken.has(candidate); n += 1) {
    const suffix = `-${String(n)}`;
    candidate = `${id.slice(0, 64 - suffix.length)}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * The draft environment of a workspace: the detectors' findings for every repository (default branch only), merged into one sandbox-tier environment, with the setup agent's commands added where code found none.
 * Undefined when there is nothing to propose (no repository was readable, or no detector found a check) or the merged environment is not valid: a draft that cannot be proposed is not reported.
 */
export async function detectTestEnvironment(input: { rootPath: string; repositories: readonly DetectRepository[]; setupProposal?: SetupProposal | undefined }): Promise<TestEnvDraft | undefined> {
  const environments: TestEnvironmentBody[] = [];
  const valueSources: TestEnvDraft["valueSources"] = [];
  const pending: TestEnvDraft["pendingServices"] = [];
  const notes: string[] = [];
  const questions: string[] = [];
  const takenIds = new Set<string>();
  for (const repository of input.repositories) {
    if (repository.checkedOut !== undefined) { notes.push(`A pull request's files were checked out in ${repository.name}; only the default branch is read, so it was left out.`); continue; }
    const directory = join(input.rootPath, repository.path);
    const paths = await listRepositoryFiles(directory);
    const { reader } = boundedReader(paths, (path) => readRepositoryFile(directory, path));
    const detection = await runDetectors(reader, repository.path);
    const draft = buildEnvironmentDraft(detection, { repositoryId: repository.name, nightlyBranch: repository.defaultBranch });
    if ("ok" in draft) { notes.push(`The setup of ${repository.name} could not be put together from what was found.`); continue; }
    // The setup agent fills only the gaps: its commands go through the same schema, and a flagged one is dropped.
    const filled = proposalFromDraft(draft, agentDraftFor(input.setupProposal, repository.name), { cwd: repository.path });
    const environment = filled.ok ? filled.proposal.environment : draft.environment;
    const sources = filled.ok ? filled.proposal.valueSources : draft.valueSources;
    const index = environments.length;
    // Check ids are unique across repositories; the fields that name a check by position keep their meaning.
    const renamed = new Map<string, string>();
    const repoEnv: TestEnvironmentBody = {
      ...environment,
      repos: environment.repos.map((repo) => ({ ...repo, checks: repo.checks.map((check) => { const id = uniqueId(check.id, takenIds); renamed.set(check.id, id); return id === check.id ? check : { ...check, id }; }) })),
    };
    repoEnv.selection = { ...repoEnv.selection, alwaysRun: repoEnv.selection.alwaysRun.map((id) => renamed.get(id) ?? id) };
    environments.push(repoEnv);
    for (const item of sources) valueSources.push({ field: item.field.replace(/^repos\[0\]/u, `repos[${String(index)}]`), source: item.source });
    pending.push(...draft.pendingServices.map((service) => ({ kind: service.kind, target: service.target })));
    notes.push(...draft.notes);
    questions.push(...draft.questions);
  }
  const first = environments[0];
  if (first === undefined) return undefined;
  const merged: TestEnvironmentBody = {
    ...first,
    repos: environments.flatMap((environment) => environment.repos),
    selection: {
      method: environments.some((environment) => environment.selection.method === "coverage_map") ? "coverage_map" : "full",
      alwaysRun: [...new Set(environments.flatMap((environment) => environment.selection.alwaysRun))],
      fullSuiteOn: [...new Set(environments.flatMap((environment) => environment.selection.fullSuiteOn))].slice(0, 100),
    },
  };
  if (merged.repos.every((repo) => repo.checks.length === 0)) return undefined;
  const reported = TestEnvDraftSchema.safeParse({
    environment: merged,
    valueSources: valueSources.slice(0, 400),
    pendingServices: dedupe(pending, (service) => `${service.kind}:${service.target}`).slice(0, 32),
    notes: [...new Set(notes)].map(plainLine).filter((line) => line !== "").slice(0, 60),
    questions: [...new Set(questions)].map(plainLine).filter((line) => line !== "").slice(0, 60),
  });
  // A draft the broker would refuse for its size is not reported (the setup draft's result stays small).
  return reported.success && Buffer.byteLength(JSON.stringify(reported.data), "utf8") <= TEST_ENV_DRAFT_MAX_BYTES ? reported.data : undefined;
}

const plainLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 400);
function dedupe<T>(list: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((item) => { const k = key(item); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * What a SETUP_DRAFT run adds to its result when it was asked to detect (`testEnvDetect`): the draft environment under `testEnvironmentDraft`, or nothing. NEVER throws and never fails the run: the setup proposal is
 * the run's product, the environment draft is an addition.
 */
export async function testEnvDraftResult(input: { rootPath: string; repositories: readonly DetectRepository[]; setupProposal?: SetupProposal | undefined }): Promise<{ testEnvironmentDraft?: TestEnvDraft }> {
  try {
    const draft = await detectTestEnvironment(input);
    return draft === undefined ? {} : { testEnvironmentDraft: draft };
  } catch {
    return {};
  }
}
