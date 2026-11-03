// The detector pass under a hard wall-clock limit (test services, hostile-repository safety). A repository's files are untrusted text, and a pattern that backtracks on a crafted file can run for minutes in
// one synchronous call, which no timer in the same thread can interrupt. So the pass runs in a worker thread (`detect-thread.ts`) and the starting thread keeps the clock:
//   - the thread has no file access: it asks this thread for each file's text, and this thread answers through the bounded reader (path list, 256 KiB per file, 4 MiB in all), so it only ever sees text the
//     reader already allows;
//   - the thread has its own memory limit, and `terminate()` frees its heap with it;
//   - on the limit (default 60 s, `timeoutMs`) the thread is ended and the detection is made again WITHOUT the dependency detectors, by a second thread with a shorter limit (10 s at most), so a repository
//     that only trips a new detector still gets today's detection. If that one is stopped too, the detection is empty. Either way it says "Some checks took too long and were stopped.";
//   - if a thread cannot be started at all (no compiled entry file), the pass runs in this thread exactly as before: the guard never makes detection worse than it was.
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { runDetectors } from "./index.js";
import { emptyDetection, type Detection, type RepositoryReader } from "./types.js";

export const ENV_DETECT_TIMEOUT_MS = 60_000;
export const ENV_DETECT_FALLBACK_TIMEOUT_MS = 10_000;
export const ENV_DETECT_TIMEOUT_NOTE = "Some checks took too long and were stopped.";
const THREAD_MEMORY_MB = 1_024;

export interface ThreadEntry { url: URL; execArgv: string[] }
export interface GuardOptions {
  /** The limit for the whole detector pass, in milliseconds. */
  timeoutMs?: number | undefined;
  /** The thread's entry file; by default the compiled `detect-thread.js` beside this file, or its source with `tsx` when running from source. */
  entry?: ThreadEntry | undefined;
}

export function defaultThreadEntry(): ThreadEntry {
  const compiled = new URL("./detect-thread.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return { url: compiled, execArgv: [] };
  return { url: new URL("./detect-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

type Attempt = { kind: "done"; detection: Detection } | { kind: "stopped" } | { kind: "unavailable" };

function attempt(reader: RepositoryReader, cwd: string, legacyOnly: boolean, timeoutMs: number, entry: ThreadEntry): Promise<Attempt> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(entry.url, {
        workerData: { paths: [...reader.paths], truncated: reader.truncated === true, cwd, legacyOnly },
        execArgv: entry.execArgv,
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: THREAD_MEMORY_MB, maxYoungGenerationSizeMb: 64 },
      });
    } catch {
      resolve({ kind: "unavailable" });
      return;
    }
    let settled = false;
    let started = false;
    const finish = (value: Attempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ kind: "stopped" }), timeoutMs);
    worker.on("message", (message: { type: string; id?: number; path?: string; detection?: Detection }) => {
      started = true;
      if (message.type === "read" && typeof message.path === "string") {
        const { id, path } = message;
        reader.read(path).then(
          (text) => { if (!settled) worker.postMessage({ type: "text", id, text, exhausted: reader.budgetExhausted?.() === true }); },
          () => { if (!settled) worker.postMessage({ type: "text", id, text: undefined, exhausted: false }); },
        );
      } else if (message.type === "done" && message.detection !== undefined) finish({ kind: "done", detection: message.detection });
      else if (message.type === "failed") finish({ kind: "stopped" });
    });
    // A thread that cannot load its entry file never sends a message: that is "unavailable" (run in this thread), not "too slow".
    worker.on("error", () => finish(started ? { kind: "stopped" } : { kind: "unavailable" }));
    worker.on("exit", () => finish(started ? { kind: "stopped" } : { kind: "unavailable" }));
  });
}

/** `runDetectors` under a wall-clock limit. Same result as `runDetectors` for any repository that finishes in time. */
export async function runDetectorsGuarded(reader: RepositoryReader, cwd: string, options: GuardOptions = {}): Promise<Detection> {
  const timeoutMs = options.timeoutMs ?? ENV_DETECT_TIMEOUT_MS;
  const entry = options.entry ?? defaultThreadEntry();
  const full = await attempt(reader, cwd, false, timeoutMs, entry);
  if (full.kind === "done") return full.detection;
  if (full.kind === "unavailable") return runDetectors(reader, cwd);
  const legacy = await attempt(reader, cwd, true, Math.min(ENV_DETECT_FALLBACK_TIMEOUT_MS, timeoutMs), entry);
  const base = legacy.kind === "done" ? legacy.detection : emptyDetection();
  return { ...base, notes: [...new Set([...base.notes, ENV_DETECT_TIMEOUT_NOTE])] };
}
