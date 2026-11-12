// What the runner client does with a function's code after the store has judged and unpacked it (slice 4, lane W3): decide whether the worker (arm64) can run it, run the arm64 wheel swap when it holds x86_64 native code, and
// turn every refusal into the {type, message} the front keeps as the function's own error. Messages are fixed sentences; a package's own words (file names, wheel names) never go into one beyond a cleaned name and version.
import { dirname } from "node:path";
import { swapToArm64, pythonOfRuntime, type PackageSwapReport } from "./arm64-swap.js";
import { FUNCTION_CODE_LIMITS, FunctionCodeError, type FunctionCodeProblem } from "./code-errors.js";
import type { MaterializedCode } from "./code-store.js";
import { directoryInputs } from "./directory-inputs.js";
import { classifyNative, type NativeClassification, type PackageFileInput } from "./native-classify.js";
import { removeBeneath, writeBeneath } from "./no-follow-write.js";
import type { WheelIndex } from "./wheel-index.js";

/** A refusal the front turns into the function's error: `type` is kept (Rovara.Unsupported, InvalidParameterValueException ...). */
export class RegistrationRefusal extends Error {
  constructor(readonly errorType: string, message: string) {
    super(message);
    this.name = "RegistrationRefusal";
  }
}

export const UNSUPPORTED = "Rovara.Unsupported";
export const RUNNER_ERROR = "Rovara.RunnerError";
export const INVALID_PARAMETER = "InvalidParameterValueException";

const TYPE_OF_PROBLEM: Record<FunctionCodeProblem, string> = {
  size: INVALID_PARAMETER, digest: INVALID_PARAMETER, unsafe_entry: INVALID_PARAMETER, unsafe_link: INVALID_PARAMETER, too_many_entries: INVALID_PARAMETER, too_large: INVALID_PARAMETER,
  unsupported: INVALID_PARAMETER, corrupt: INVALID_PARAMETER, bad_request: INVALID_PARAMETER,
  budget: UNSUPPORTED, write_failed: RUNNER_ERROR, not_found: RUNNER_ERROR, run_closed: RUNNER_ERROR, timed_out: RUNNER_ERROR,
};

/** The refusal for any error the code store (or this module) raised; anything else is the runner's own failure, in a fixed sentence. */
export function refusalOf(error: unknown): RegistrationRefusal {
  if (error instanceof RegistrationRefusal) return error;
  if (error instanceof FunctionCodeError) return new RegistrationRefusal(TYPE_OF_PROBLEM[error.reason], error.message);
  return new RegistrationRefusal(RUNNER_ERROR, "The function runner failed while preparing the function's code");
}

const clean = (text: string, max: number): string => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, max);

export interface NativeOutcome {
  /** The classifier's verdict over the files as they are now (after a swap, the swapped files). */
  native: NativeClassification;
  /** One report per distribution the swap looked at; empty when nothing was x86_64. */
  swap: readonly PackageSwapReport[];
  /** True when the swap replaced files on disk. */
  swapped: boolean;
}

function inputsOf(root: string): { files: PackageFileInput[]; nonFiles: Map<string, "dir" | "symlink" | "other"> } {
  const files: PackageFileInput[] = [];
  const nonFiles = new Map<string, "dir" | "symlink" | "other">();
  for (const prefix of ["task", "opt"] as const) {
    const walked = directoryInputs(`${root}/${prefix}`);
    if (walked.truncated) throw new FunctionCodeError("too_many_entries");
    nonFiles.set(prefix, "dir");
    for (const file of walked.files) files.push({ ...file, path: `${prefix}/${file.path}` });
    for (const [path, kind] of walked.nonFiles) nonFiles.set(`${prefix}/${path}`, kind);
  }
  return { files, nonFiles };
}

const X86_ONLY = "native code built for x86_64; local runs are arm64";

/**
 * Decides whether a materialized function can run on this (arm64) worker. Pure arm64 or no native code: yes. x86_64 or mixed native code: a Python function gets the wheel swap (the same versions' aarch64 wheels, verified) when
 * `wheelIndex` is given, and runs only if the swap leaves no x86_64 or doubtful native file; everything else (Node addons, bundled binaries, a runtime with no swap, no index) is refused as Rovara.Unsupported until the qemu lane lands.
 * The tree is edited in place with no-follow writes; a refusal leaves it half edited, so the caller discards it.
 */
export async function resolveNativeCode(code: MaterializedCode, options: { runtime: string; wheelIndex?: WheelIndex | undefined }): Promise<NativeOutcome> {
  const native = code.native;
  if (!native.complete) throw new RegistrationRefusal(UNSUPPORTED, "The function's code has more files than the runner can check for native code");
  if (!code.needsArchAction) return { native, swap: [], swapped: false };
  const python = pythonOfRuntime(options.runtime);
  if (python === undefined || options.wheelIndex === undefined) throw new RegistrationRefusal(UNSUPPORTED, X86_ONLY);
  const root = dirname(code.taskDir);
  const { files, nonFiles } = inputsOf(root);
  const result = await swapToArm64(files, options.wheelIndex, { python, nonFiles, maxTotalAddedBytes: FUNCTION_CODE_LIMITS.maxExpandedBytes });
  if (!result.fullyArm64) {
    const failed = result.reports.find((report) => report.status !== "swapped");
    const why = failed === undefined ? (result.unowned.length > 0 ? "a native file that no installed package owns" : "native code the swap cannot replace") : `${clean(failed.name, 64)} ${clean(failed.version, 32)}: ${failed.status}`;
    throw new RegistrationRefusal(UNSUPPORTED, `${X86_ONLY}, and no arm64 build could take its place (${why})`);
  }
  for (const path of result.edits.remove) await removeBeneath(root, path);
  // A file the wheel replaces is not in `remove` (it is in `add`): it goes first, because the no-follow write refuses to create over anything.
  for (const add of result.edits.add) {
    await removeBeneath(root, add.path);
    await writeBeneath(root, add.path, add.data, add.executable);
  }
  // The disk is the truth: classify what is there now, and hold the result to Lambda's unpacked limit.
  const after = inputsOf(root);
  const verdict = classifyNative(after.files);
  const bytes = after.files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > FUNCTION_CODE_LIMITS.maxExpandedBytes) throw new RegistrationRefusal(INVALID_PARAMETER, new FunctionCodeError("too_large").message);
  if (!verdict.complete || verdict.arch === "x86_64" || verdict.arch === "mixed") {
    // The first file that is still not arm64, by its path as the classifier cleaned it (control characters replaced, capped): it is the customer's own file name, shown in the customer's own function error.
    const first = verdict.offenders[0];
    throw new RegistrationRefusal(UNSUPPORTED, `${X86_ONLY}; after the swap ${String(verdict.offenderCount)} native file(s) are still not arm64${first === undefined ? "" : `, first: ${first.path} (${first.kind})`}`);
  }
  return { native: verdict, swap: result.reports, swapped: true };
}
