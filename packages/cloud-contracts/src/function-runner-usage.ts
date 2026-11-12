// Slice 4, lane C1: what a run's worker reports about the Lambda functions the function runner (or the engine) ran, and the fixed evidence lines the broker derives from it (design section 7).
//
// It rides beside the services usage record as its own result key (`testServicesFunctions`), not inside it: `TestServicesUsageRecordSchema` is Rovara Code's strict contract, and a new field there is a Code change (owed
// upstream, see the lane report). The rules are the record's rules: bounded, fixed words, counts as coarse buckets (a test that picks how often it calls a function could otherwise carry a value in the count: TS-SEAL-1),
// a function name shown only when it is a plain Lambda name that is not secret-shaped (the rest are counted in `otherFunctions` and named nowhere), and no path, payload, host, variable, log line or error text anywhere.
// Never fed back to the agent or a model. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { looksLikeSecretValue } from "@rovara-code/contracts";
import { FUNCTION_RUNNER_RUNTIMES } from "./function-runner-catalog.js";

export const FUNCTION_RUNNER_USAGE_SCHEMA_VERSION = 1;
/** The key under which the functions record rides in a run's result, next to `testServicesUsage`. */
export const FUNCTION_RUNNER_USAGE_RESULT_KEY = "testServicesFunctions";
export const FUNCTION_RUNNER_USAGE_LIMITS = { functions: 50 } as const;
/** Where a function ran: the Rovara function runner (a gVisor sandbox), the engine (in-process), or nowhere (`unsupported`: the run says why in a fixed word). */
export const FUNCTION_RUN_PLACES = ["runner", "engine", "unsupported"] as const;
/** Why a function was not run, in fixed words (never an error message). `ceiling`: it ran past the engine's 28 s wait limit. */
export const FUNCTION_UNSUPPORTED_REASONS = ["x86_native_code", "runtime", "ceiling", "payload_size", "runner_unavailable", "other"] as const;
export type FunctionRunPlace = (typeof FUNCTION_RUN_PLACES)[number];
export type FunctionUnsupportedReason = (typeof FUNCTION_UNSUPPORTED_REASONS)[number];
/** The values a count may take: the lower bound of its bucket (1, 2 to 5, 6 to 20, 21 or more) or 0. Same rule as the services record's `bucketCount`. */
export const FUNCTION_COUNT_BUCKETS = [0, 1, 2, 6, 21] as const;
const Bucket = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(6), z.literal(21)]);

/**
 * Whether a function name looks like it carries a secret, beyond the services record's `looksLikeSecretValue` (a run of 32 or more of letters, digits, `-` and `_`, AWS key ids, `sk_live_`, GitHub and Slack tokens, PEM headers):
 * Anthropic keys (`sk-ant-`, `sk-`), a JWT (`eyJ`), the words password, passwd, secret, token and credential (any case), and a long run of letters and digits with no separator (24 or more: base64 text has no `-` or `_` left in it
 * once a name's own character set is applied). A name that trips any of these is not shown: it is counted in `otherFunctions`.
 */
const SENSITIVE_NAME = [/sk-ant-/iu, /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]{8,}/u, /eyJ/u, /pass(?:word|wd)|secret|token|credential|api[-_]?key|private[-_]?key/iu, /[A-Za-z0-9]{24,}/u];
export const functionNameLooksSensitive = (name: string): boolean => SENSITIVE_NAME.some((pattern) => pattern.test(name)) || looksLikeSecretValue(name) || looksLikeSecretValue(name.toUpperCase());

/** A Lambda function name that may be shown: AWS's own character set, 1 to 64, and nothing secret-shaped in it or in its upper-case form (see `functionNameLooksSensitive`). */
export const FunctionNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/u)
  .refine((name) => !functionNameLooksSensitive(name), { message: "a function name, not a secret" });

export const FunctionRunnerUsageRowSchema = z
  .object({
    name: FunctionNameSchema,
    where: z.enum(FUNCTION_RUN_PLACES),
    /** The runtime it ran as (`python3.12`), on a runner row only. */
    runtime: z.enum(FUNCTION_RUNNER_RUNTIMES).optional(),
    invocations: Bucket,
    /** Environment starts (a cold start is the first call into a new sandbox). Runner rows only. */
    cold: Bucket,
    /** Calls that ended at the engine's wait ceiling (listed as unsupported, never as a code failure). */
    atCeiling: Bucket,
    reason: z.enum(FUNCTION_UNSUPPORTED_REASONS).optional(),
  })
  .strict()
  .superRefine((row, context) => {
    const problem = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
    if (row.where === "runner" && row.runtime === undefined) problem("runtime", "a runner row names the runtime it ran as");
    if (row.where !== "runner" && (row.runtime !== undefined || row.cold !== 0)) problem("where", "only a runner row has a runtime and cold starts");
    if (row.where === "unsupported" && row.reason === undefined) problem("reason", "an unsupported function names why");
    if (row.where !== "unsupported" && row.reason !== undefined && !(row.where === "runner" && row.reason === "ceiling")) problem("reason", "only an unsupported function, or a runner function that hit the ceiling, has a reason");
    if (row.atCeiling > 0 && row.where !== "runner") problem("atCeiling", "only a runner function has a ceiling");
    if (row.atCeiling > row.invocations) problem("atCeiling", "no more ceiling calls than calls");
    if (row.cold > row.invocations) problem("cold", "no more cold starts than calls");
  });
export type FunctionRunnerUsageRow = z.infer<typeof FunctionRunnerUsageRowSchema>;

export const FunctionRunnerUsageSchema = z
  .object({
    schemaVersion: z.literal(FUNCTION_RUNNER_USAGE_SCHEMA_VERSION),
    /** `unreadable`: the runner's or the front's counts could not be read (fail closed: no rows then, and the broker says "could not be checked", never "no functions"). */
    ledger: z.enum(["read", "unreadable"]),
    functions: z.array(FunctionRunnerUsageRowSchema).max(FUNCTION_RUNNER_USAGE_LIMITS.functions),
    /** Functions not shown: a name that is not a plain name, and every function past the list. */
    otherFunctions: Bucket,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.ledger !== "read" && (record.functions.length > 0 || record.otherFunctions > 0)) context.addIssue({ code: "custom", path: ["ledger"], message: "a ledger that was not read says nothing" });
    if (new Set(record.functions.map((row) => row.name)).size !== record.functions.length) context.addIssue({ code: "custom", path: ["functions"], message: "a function is listed once" });
  });
export type FunctionRunnerUsage = z.infer<typeof FunctionRunnerUsageSchema>;

/** The lower bound of the bucket a count falls in; 0 stays 0 and a count that is not a number is 0. */
export function functionCountBucket(count: number): 0 | 1 | 2 | 6 | 21 {
  if (!(count >= 1)) return 0;
  return count >= 21 ? 21 : count >= 6 ? 6 : count >= 2 ? 2 : 1;
}

const RANGE: Readonly<Record<number, string>> = { 1: "1", 2: "2 to 5", 6: "6 to 20", 21: "21 or more" };
const UNSUPPORTED_WORDS: Readonly<Record<FunctionUnsupportedReason, string>> = {
  x86_native_code: "unsupported (x86_64 native code)",
  runtime: "unsupported (a runtime the function runner does not run yet)",
  ceiling: "unsupported (ran past the local engine's wait limit)",
  payload_size: "unsupported (a triggered payload over the size limit)",
  runner_unavailable: "unsupported (the function runner was not available on this worker)",
  other: "unsupported",
};
export const FUNCTION_RUNNER_EVIDENCE_NOT_CHECKED = "Lambda function runs could not be checked";

/**
 * The evidence line of one function, in fixed words (design section 7): where it ran and how often. Built only from the record's own fields; no word of it comes from the worker.
 *   resize: 21 or more invocations, ran in the Rovara function runner (gVisor, python3.12, arm64); 2 to 5 cold; 1 at the 28 s ceiling (unsupported)
 *   notify: 2 to 5 invocations, ran in the engine (AWS Emulator, in-process Python or Node)
 *   legacy: unsupported (x86_64 native code)
 */
export function functionRunnerEvidenceLine(row: FunctionRunnerUsageRow): string {
  if (row.where === "unsupported") return `${row.name}: ${UNSUPPORTED_WORDS[row.reason ?? "other"]}`;
  const calls = row.invocations === 0 ? "no invocations" : `${RANGE[row.invocations]} ${row.invocations === 1 ? "invocation" : "invocations"}`;
  if (row.where === "engine") return `${row.name}: ${calls}, ran in the engine (AWS Emulator, in-process Python or Node)`;
  const cold = row.cold === 0 ? "" : `; ${RANGE[row.cold]} cold`;
  const ceiling = row.atCeiling === 0 ? "" : `; ${RANGE[row.atCeiling]} at the 28 s ceiling (unsupported)`;
  return `${row.name}: ${calls}, ran in the Rovara function runner (gVisor, ${row.runtime ?? "unknown runtime"}, arm64)${cold}${ceiling}`;
}

/** All the lines of a record, in the record's order, with one more for the functions not shown. A record that was not read is the single "could not be checked" line, never an empty list. */
export function functionRunnerEvidenceLines(usage: FunctionRunnerUsage | undefined): string[] {
  if (usage === undefined || usage.ledger === "unreadable") return [FUNCTION_RUNNER_EVIDENCE_NOT_CHECKED];
  const lines = usage.functions.map(functionRunnerEvidenceLine);
  if (usage.otherFunctions > 0) lines.push(`${RANGE[usage.otherFunctions]} more ${usage.otherFunctions === 1 ? "function" : "functions"} not named`);
  return lines;
}
