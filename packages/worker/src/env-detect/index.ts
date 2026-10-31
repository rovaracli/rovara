// Runs the detectors over a bounded reader and merges what they found. Bounded: a repository with more than 5,000 files is cut (and says so), a file over 256 KiB is not read, and a detection reads at most 4 MiB.
import { detectBrazil } from "./brazil.js";
import { detectIac } from "./iac.js";
import { detectNode } from "./node.js";
import { detectPython } from "./python.js";
import { detectServices } from "./services.js";
import { emptyDetection, type Detection, type Detector, type RepositoryReader } from "./types.js";

export const DETECTORS: ReadonlyArray<{ name: string; run: Detector }> = [
  { name: "python", run: detectPython },
  { name: "node", run: detectNode },
  { name: "iac", run: detectIac },
  { name: "services", run: detectServices },
  { name: "brazil", run: detectBrazil },
];

export const ENV_DETECT_MAX_PATHS = 5_000;
export const ENV_DETECT_MAX_FILE_BYTES = 256 * 1_024;
export const ENV_DETECT_MAX_TOTAL_BYTES = 4 * 1_048_576;

/**
 * A reader over a directory's files given by the caller: paths are cut to the limit, a path outside the list reads as missing, and the byte budget is shared by every detector. `load` returns a file's text (or
 * undefined); it is the caller's, bound to the workspace.
 */
export function boundedReader(paths: readonly string[], load: (path: string) => Promise<string | undefined>): { reader: RepositoryReader; truncated: boolean; bytesRead(): number } {
  const kept = paths.filter((path) => path.length > 0 && path.length <= 512 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\")).slice(0, ENV_DETECT_MAX_PATHS);
  const allowed = new Set(kept);
  let total = 0;
  const cache = new Map<string, string | undefined>();
  return {
    reader: {
      paths: kept,
      async read(path) {
        if (!allowed.has(path)) return undefined;
        if (cache.has(path)) return cache.get(path);
        let text: string | undefined;
        try { text = await load(path); } catch { text = undefined; }
        if (text !== undefined && (Buffer.byteLength(text) > ENV_DETECT_MAX_FILE_BYTES || total + Buffer.byteLength(text) > ENV_DETECT_MAX_TOTAL_BYTES)) text = undefined;
        if (text !== undefined) total += Buffer.byteLength(text);
        cache.set(path, text);
        return text;
      },
    },
    truncated: paths.length > ENV_DETECT_MAX_PATHS,
    bytesRead: () => total,
  };
}

export async function runDetectors(reader: RepositoryReader, cwd: string): Promise<Detection> {
  const merged = emptyDetection();
  const ids = new Set<string>();
  for (const detector of DETECTORS) {
    let part: Partial<Detection>;
    try { part = await detector.run({ repo: reader, cwd }); } catch { merged.notes.push(`The ${detector.name} detector could not finish.`); continue; }
    merged.setupCommands.push(...(part.setupCommands ?? []));
    for (const check of part.checks ?? []) {
      // The first detector to name a check id keeps it (the list order is the precedence).
      if (!ids.has(check.value.id)) { ids.add(check.value.id); merged.checks.push(check); }
    }
    merged.services.push(...(part.services ?? []));
    merged.iac.push(...(part.iac ?? []));
    merged.fullSuiteOn.push(...(part.fullSuiteOn ?? []));
    merged.notes.push(...(part.notes ?? []));
    merged.questions.push(...(part.questions ?? []));
  }
  const dedupe = <T>(list: T[], key: (item: T) => string): T[] => { const seen = new Set<string>(); return list.filter((item) => { const k = key(item); if (seen.has(k)) return false; seen.add(k); return true; }); };
  merged.setupCommands = dedupe(merged.setupCommands, (item) => JSON.stringify(item.value));
  merged.fullSuiteOn = dedupe(merged.fullSuiteOn, (item) => item.value);
  merged.services = dedupe(merged.services, (item) => `${item.value.kind}:${item.value.target}`);
  merged.notes = [...new Set(merged.notes)];
  merged.questions = [...new Set(merged.questions)];
  return merged;
}

export { emptyDetection, type Detection, type RepositoryReader } from "./types.js";
export { buildEnvironmentDraft, proposalFromDraft, type EnvironmentDraft, type PendingService } from "./propose.js";
