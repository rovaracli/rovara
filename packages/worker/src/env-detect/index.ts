// Runs the detectors over a bounded reader and merges what they found. Bounded: a repository with more than 5,000 files is cut (and says so), a file over 256 KiB is not read, and a detection reads at most 6 MiB, of which
// 2 MiB are kept for the files that say how the repository is built and run (manifests, CI, Docker, compose, Makefile, README): source files and other settings can use the other 4 MiB, so they never starve those.
import type { ProjectCommand } from "@rovara-code/contracts";
import { detectBrazil } from "./brazil.js";
import { detectIacResources } from "./iac-resources.js";
import { detectTestFakes } from "./test-fakes.js";
import { detectEnvConfig } from "./env-config.js";
import { detectCiServices } from "./ci-services.js";
import { detectCompose } from "./compose.js";
import { mergeCandidates } from "./dependency-candidates.js";
import { detectGo } from "./go.js";
import { detectIac } from "./iac.js";
import { detectJava } from "./java.js";
import { sameCommandLine } from "./command-alias.js";
import { detectNode } from "./node.js";
import { detectPython } from "./python.js";
import { detectSdkCalls, detectServices } from "./services.js";
import { isImportantPath } from "./read-priority.js";
import { detectSeedFiles } from "./seed-files.js";
import { emptyDetection, type DependencyCandidate, type Detection, type Detector, type RepositoryReader } from "./types.js";

export const DETECTORS: ReadonlyArray<{ name: string; run: Detector }> = [
  { name: "python", run: detectPython },
  { name: "node", run: detectNode },
  { name: "java", run: detectJava },
  { name: "go", run: detectGo },
  { name: "iac", run: detectIac },
  { name: "services", run: detectServices },
  { name: "brazil", run: detectBrazil },
  { name: "compose", run: detectCompose },
  { name: "ci", run: detectCiServices },
  { name: "env", run: detectEnvConfig },
  { name: "sdk", run: detectSdkCalls },
  { name: "test-fakes", run: detectTestFakes },
  { name: "iac-resources", run: detectIacResources },
  { name: "seed-files", run: detectSeedFiles },
];

/** The detectors that only report dependency candidates (test services D1-D7). The language detectors also report their manifests' drivers, which `legacyOnly` drops. */
export const DEPENDENCY_DETECTOR_NAMES: ReadonlySet<string> = new Set(["compose", "ci", "env", "sdk", "test-fakes", "iac-resources", "seed-files"]);

export const ENV_DETECT_MAX_PATHS = 5_000;
export const ENV_DETECT_MAX_FILE_BYTES = 256 * 1_024;
/** The most a detection reads in all (the hard cap: cost stays bounded). */
export const ENV_DETECT_MAX_TOTAL_BYTES = 6 * 1_048_576;
/** The part of the total only the build and run files (see `read-priority.ts`) may use: every other file is cut at the total less this. */
export const ENV_DETECT_RESERVED_BYTES = 2 * 1_048_576;
/** How many skipped important files a detection names. */
export const ENV_DETECT_MAX_SKIPPED_NAMED = 8;

/**
 * A reader over a directory's files given by the caller: paths are cut to the limit, a path outside the list reads as missing, and the byte budget is shared by every detector. `load` returns a file's text (or
 * undefined); it is the caller's, bound to the workspace.
 */
export function boundedReader(paths: readonly string[], load: (path: string) => Promise<string | undefined>): { reader: RepositoryReader; truncated: boolean; bytesRead(): number } {
  const kept = paths.filter((path) => path.length > 0 && path.length <= 512 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\")).slice(0, ENV_DETECT_MAX_PATHS);
  const allowed = new Set(kept);
  let total = 0;
  let exhausted = false;
  const skipped: string[] = [];
  const cache = new Map<string, string | undefined>();
  return {
    reader: {
      paths: kept,
      truncated: paths.length > ENV_DETECT_MAX_PATHS,
      budgetExhausted: () => exhausted,
      skippedImportant: () => skipped,
      async read(path) {
        if (!allowed.has(path)) return undefined;
        if (cache.has(path)) return cache.get(path);
        let text: string | undefined;
        try { text = await load(path); } catch { text = undefined; }
        if (text !== undefined) {
          const size = Buffer.byteLength(text);
          const important = isImportantPath(path);
          // A build or run file may use the whole budget; any other file stops at the total less the reserve.
          const cut = size > ENV_DETECT_MAX_FILE_BYTES ? "size" : total + size > (important ? ENV_DETECT_MAX_TOTAL_BYTES : ENV_DETECT_MAX_TOTAL_BYTES - ENV_DETECT_RESERVED_BYTES) ? "budget" : undefined;
          if (cut === "budget") exhausted = true;
          if (cut !== undefined) {
            if (important && skipped.length < ENV_DETECT_MAX_SKIPPED_NAMED + 1) skipped.push(path);
            text = undefined;
          } else total += size;
        }
        cache.set(path, text);
        return text;
      },
    },
    truncated: paths.length > ENV_DETECT_MAX_PATHS,
    bytesRead: () => total,
  };
}

/** The most of each thing a detection carries (the environment's own schema limits, with room for the proposal's common full-suite globs). */
export const ENV_DETECT_MAX_CHECKS = 32;
export const ENV_DETECT_MAX_SETUP_COMMANDS = 20;
export const ENV_DETECT_MAX_FULL_SUITE_GLOBS = 90;

/** The same directory and the same program with the same arguments; `npm test` and `npm run test` (and the other spellings of one package.json script) are the same command. */
const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && sameCommandLine(left, right);

/** `unit` taken by another detector becomes `unit-java`, then `unit-java-2`: always a valid, unused check id. */
function freeId(id: string, detector: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  const base = `${id}-${detector}`.slice(0, 64).replace(/[-_]+$/u, "");
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Runs every detector and merges what they found into one detection. Order is precedence. A check whose command (program, arguments, directory) another detector already proposed is dropped, keeping the first
 * one's citation; a check whose id is taken by a different command is KEPT under `<id>-<detector>` rather than silently replaced; setup commands, globs, services, notes and questions are de-duplicated; and the
 * environment's limits hold, each cut saying so. `legacyOnly` runs the detectors that existed before test services, without any dependency candidate (used when the full pass was stopped for taking too long).
 */
export async function runDetectors(reader: RepositoryReader, cwd: string, options: { legacyOnly?: boolean; /** Run only the detectors with these names (a caller that wants one kind of finding). */ only?: readonly string[] } = {}): Promise<Detection> {
  const merged = emptyDetection();
  const candidates: DependencyCandidate[] = [];
  const ids = new Set<string>();
  let cutChecks = false;
  for (const detector of DETECTORS) {
    if (options.only !== undefined && !options.only.includes(detector.name)) continue;
    if (options.legacyOnly === true && DEPENDENCY_DETECTOR_NAMES.has(detector.name)) continue;
    let part: Partial<Detection>;
    try { part = await detector.run({ repo: reader, cwd }); } catch { merged.notes.push(`The ${detector.name} detector could not finish.`); continue; }
    merged.setupCommands.push(...(part.setupCommands ?? []));
    if (part.seedCommands !== undefined && part.seedCommands.length > 0) merged.seedCommands = [...(merged.seedCommands ?? []), ...part.seedCommands];
    if (part.databaseScripts !== undefined && part.databaseScripts.length > 0) merged.databaseScripts = [...(merged.databaseScripts ?? []), ...part.databaseScripts];
    if (options.legacyOnly !== true && part.seedFiles !== undefined && part.seedFiles.length > 0) merged.seedFiles = [...(merged.seedFiles ?? []), ...part.seedFiles];
    for (const check of part.checks ?? []) {
      if (merged.checks.some((existing) => sameCommand(existing.value.command, check.value.command))) continue;
      if (merged.checks.length >= ENV_DETECT_MAX_CHECKS) { cutChecks = true; continue; }
      const id = freeId(check.value.id, detector.name, ids);
      ids.add(id);
      merged.checks.push(id === check.value.id ? check : { ...check, value: { ...check.value, id } });
    }
    merged.services.push(...(part.services ?? []));
    merged.iac.push(...(part.iac ?? []));
    if (options.legacyOnly !== true) candidates.push(...(part.dependencies ?? []));
    merged.fullSuiteOn.push(...(part.fullSuiteOn ?? []));
    merged.notes.push(...(part.notes ?? []));
    merged.questions.push(...(part.questions ?? []));
  }
  const dedupe = <T>(list: T[], key: (item: T) => string): T[] => { const seen = new Set<string>(); return list.filter((item) => { const k = key(item); if (seen.has(k)) return false; seen.add(k); return true; }); };
  merged.setupCommands = dedupe(merged.setupCommands, (item) => JSON.stringify(item.value));
  if (merged.seedCommands !== undefined) merged.seedCommands = dedupe(merged.seedCommands, (item) => JSON.stringify(item.value)).slice(0, 8);
  merged.fullSuiteOn = dedupe(merged.fullSuiteOn, (item) => item.value);
  merged.services = dedupe(merged.services, (item) => `${item.value.kind}:${item.value.target}`);
  // Dependency candidates (test services D1-D7): present only when a detector found one, so a repository with none gives today's detection byte for byte.
  if (candidates.length > 0) merged.dependencies = mergeCandidates(candidates);
  if (reader.budgetExhausted?.() === true) merged.notes.push("Some files were not read: the read budget ran out.");
  const skipped = reader.skippedImportant?.() ?? [];
  if (skipped.length > 0) merged.notes.push(`These files, which say how the repository is built and run, were not read (too large or the read budget ran out): ${skipped.slice(0, ENV_DETECT_MAX_SKIPPED_NAMED).map((path) => path.slice(0, 120)).join(", ")}${skipped.length > ENV_DETECT_MAX_SKIPPED_NAMED ? ", and more" : ""}.`);
  if (cutChecks) merged.notes.push(`More than ${String(ENV_DETECT_MAX_CHECKS)} checks were found; the first ${String(ENV_DETECT_MAX_CHECKS)} are proposed.`);
  if (merged.setupCommands.length > ENV_DETECT_MAX_SETUP_COMMANDS) { merged.setupCommands = merged.setupCommands.slice(0, ENV_DETECT_MAX_SETUP_COMMANDS); merged.notes.push(`More than ${String(ENV_DETECT_MAX_SETUP_COMMANDS)} setup commands were found; the first ${String(ENV_DETECT_MAX_SETUP_COMMANDS)} are proposed.`); }
  if (merged.fullSuiteOn.length > ENV_DETECT_MAX_FULL_SUITE_GLOBS) { merged.fullSuiteOn = merged.fullSuiteOn.slice(0, ENV_DETECT_MAX_FULL_SUITE_GLOBS); merged.notes.push(`More than ${String(ENV_DETECT_MAX_FULL_SUITE_GLOBS)} full-suite paths were found; the first ${String(ENV_DETECT_MAX_FULL_SUITE_GLOBS)} are proposed.`); }
  merged.notes = [...new Set(merged.notes)];
  merged.questions = [...new Set(merged.questions)];
  return merged;
}

export { emptyDetection, type DependencyCandidate, type Detection, type RepositoryReader } from "./types.js";
export { buildEnvironmentDraft, proposalFromDraft, type EnvironmentDraft, type PendingService } from "./propose.js";
