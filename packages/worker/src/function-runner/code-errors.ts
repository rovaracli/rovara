// The one error of the function code store and the zip judge (slice 4, lane W2). A fixed sentence per reason: an entry's name, a link's target and a package's own words are repository text and never appear in it.

/** The limits of one function's code. The runner's own ceilings: a request may ask for less, never for more. */
export const FUNCTION_CODE_LIMITS = {
  /** The most bytes of one zip taken in (Lambda's direct upload is 50 MB; this leaves room for a package the engine took from S3). */
  maxZipBytes: 100 * 1024 * 1024,
  /** A zip without zip64 holds at most 65,534 entries. Real layers (numpy, scipy, pandas, sklearn together) hold about 30,000. */
  maxEntries: 60_000,
  /** Lambda's unzipped limit: the function and all its layers together. */
  maxExpandedBytes: 250 * 1024 * 1024,
  maxNameBytes: 1_024,
  maxSegmentBytes: 255,
  /** Deep enough for nested node_modules and pnpm trees, shallow enough that a path stays far below PATH_MAX. */
  maxDepth: 64,
  /** A link target is a path, so it is short. */
  maxLinkTargetBytes: 1_024,
  /** Lambda allows five layers on a function. */
  maxLayers: 5,
  /** How many links one link may pass through before it counts as a loop. */
  maxLinkHops: 40,
} as const;

export type FunctionCodeProblem =
  | "size"
  | "digest"
  | "unsafe_entry"
  | "unsafe_link"
  | "too_many_entries"
  | "too_large"
  | "unsupported"
  | "corrupt"
  | "write_failed"
  | "budget"
  | "not_found"
  | "bad_request"
  | "run_closed"
  | "timed_out";

const SENTENCES: Record<FunctionCodeProblem, string> = {
  size: "The function's code is not the size announced, or is larger than this runner takes",
  digest: "The function's code is not the package that was announced",
  unsafe_entry: "The function's code package has an entry that is not a plain file, folder or link inside the package",
  unsafe_link: "The function's code package has a link that does not stay inside the package",
  too_many_entries: "The function's code package has more files than this runner unpacks",
  too_large: "The function's code package is larger unpacked than this runner allows",
  unsupported: "The function's code package uses a zip feature this runner does not unpack",
  corrupt: "The function's code package is damaged",
  write_failed: "The function's code could not be written",
  budget: "This worker has no room left for the function's code",
  not_found: "The function's code is not on this worker",
  bad_request: "The request for the function's code is not valid",
  run_closed: "The run this code belongs to has ended",
  timed_out: "The function's code did not arrive in time",
};

/** A fixed sentence per reason, never an entry's name. */
export class FunctionCodeError extends Error {
  constructor(readonly reason: FunctionCodeProblem) {
    super(SENTENCES[reason]);
    this.name = "FunctionCodeError";
  }
}

export interface FunctionCodeLimits {
  maxEntries: number;
  maxExpandedBytes: number;
}

/** The limits to apply: the request's, clamped to the runner's own ceilings. A limit that is not a positive integer is a refusal. */
export function effectiveCodeLimits(requested: { maxEntries: number; maxExpandedBytes: number }): FunctionCodeLimits {
  const entries = requested.maxEntries;
  const bytes = requested.maxExpandedBytes;
  if (!Number.isSafeInteger(entries) || entries < 1 || !Number.isSafeInteger(bytes) || bytes < 1) throw new FunctionCodeError("bad_request");
  return { maxEntries: Math.min(entries, FUNCTION_CODE_LIMITS.maxEntries), maxExpandedBytes: Math.min(bytes, FUNCTION_CODE_LIMITS.maxExpandedBytes) };
}

export const DEFAULT_CODE_LIMITS: FunctionCodeLimits = { maxEntries: FUNCTION_CODE_LIMITS.maxEntries, maxExpandedBytes: FUNCTION_CODE_LIMITS.maxExpandedBytes };
