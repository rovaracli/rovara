// Test services, wide AWS plans (owner decisions 109 and 115): what the front (the safety layer in front of the AWS Emulator) records for things it knows without seeing a request, and the fixed words Rovara says for each.
//
// The front writes these into the request ledger as operations whose names are NOT AWS operation names (`heavy-function:native-code`, `cloudformation:nested`, `stepfunctions:resource`, `lambda-limit:30s`), so the usage
// record's operation-name rule (`AwsOperationNameSchema`, upper camel case, Code's contract) would drop them to a bare count. The worker therefore turns each one it knows into a FIXED upper camel case word before it
// writes the record (`frontMarkerWord`), and the broker turns the word back into fixed sentences (`describeFrontMarker`). Nothing the program or a repository wrote is in either: the words come from the tables below, and a reason
// the tables do not list becomes the `Other` word of its family. A function's name is NOT in the ledger summary (only in the front's per-entry list), so no sentence names one.
//
// Where a marker is recorded (front README, "Lambda functions the engine cannot run" and "Calls between services inside the engine"):
//   - service `lambda`, operation `heavy-function:<reason>`: a function the engine accepts and cannot run (image, runtime, x86-native, native-code, unchecked); counted unsupported.
//   - service `lambda`, operation `lambda-limit:<30s|sfn-10s>`: a function the engine cut off at its own limit (30 s, or 10 s under Step Functions; decision 115, a later front lane).
//   - service `cloudformation-unchecked`, operation `cloudformation:<reason>`: a template the front could not read with certainty (counted out of the plan).
//   - service `targets-unchecked`, operation `<source>:<reason>`: a call between services the front could not read or place (counted out of the plan).
// Browser-safe: no import.

/** The service keys under which the front records what it could not check. They are not AWS services: a run's plan never names them. */
export const FRONT_CLOUDFORMATION_UNCHECKED_SERVICE = "cloudformation-unchecked";
export const FRONT_TARGETS_UNCHECKED_SERVICE = "targets-unchecked";
export const FRONT_UNCHECKED_SERVICES = [FRONT_CLOUDFORMATION_UNCHECKED_SERVICE, FRONT_TARGETS_UNCHECKED_SERVICE] as const;

export const FRONT_HEAVY_FUNCTION_REASONS = ["image", "runtime", "x86-native", "native-code", "unchecked"] as const;
export const FRONT_LIMIT_KINDS = ["30s", "sfn-10s"] as const;
export const FRONT_CLOUDFORMATION_REASONS = ["nested", "transform", "unreadable", "unmapped", "unparsed", "custom"] as const;
export const FRONT_TARGET_SOURCES = ["stepfunctions", "eventbridge", "scheduler", "pipes", "ssm"] as const;
export const FRONT_TARGET_REASONS = ["resource", "dynamic", "arn", "intrinsic", "unreadable", "script"] as const;

export type FrontMarker =
  | { kind: "heavy_function"; reason: (typeof FRONT_HEAVY_FUNCTION_REASONS)[number] | "other" }
  | { kind: "lambda_limit"; limit: (typeof FRONT_LIMIT_KINDS)[number] | "other" }
  | { kind: "cloudformation_unchecked"; reason: (typeof FRONT_CLOUDFORMATION_REASONS)[number] | "other" }
  | { kind: "targets_unchecked"; source: (typeof FRONT_TARGET_SOURCES)[number] | "other"; reason: (typeof FRONT_TARGET_REASONS)[number] | "other" };

const pascal = (value: string): string => value.split("-").map((part) => (part === "" ? "" : `${part[0]!.toUpperCase()}${part.slice(1)}`)).join("");
const listed = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/** The marker a ledger entry (service, operation as the front wrote it) stands for, or undefined for any other entry. Pure. */
export function frontMarkerOfLedger(service: string, operation: string): FrontMarker | undefined {
  if (service === "lambda" && operation.startsWith("heavy-function:")) {
    const reason = operation.slice("heavy-function:".length);
    return { kind: "heavy_function", reason: listed(FRONT_HEAVY_FUNCTION_REASONS, reason) ? reason : "other" };
  }
  if (service === "lambda" && operation.startsWith("lambda-limit:")) {
    const limit = operation.slice("lambda-limit:".length);
    // A limit the tables do not list (a new engine cut-off) is still an engine limit: it is worded as such, never dropped.
    return { kind: "lambda_limit", limit: listed(FRONT_LIMIT_KINDS, limit) ? limit : "other" };
  }
  if (service === FRONT_CLOUDFORMATION_UNCHECKED_SERVICE) {
    // Anything the front records under this service is something it could not check; an operation without the `cloudformation:` prefix, or with a reason the tables do not list, is the `other` reason.
    const reason = operation.startsWith("cloudformation:") ? operation.slice("cloudformation:".length) : "";
    return { kind: "cloudformation_unchecked", reason: listed(FRONT_CLOUDFORMATION_REASONS, reason) ? reason : "other" };
  }
  if (service === FRONT_TARGETS_UNCHECKED_SERVICE) {
    const [source = "", reason = ""] = operation.split(":");
    if (operation.split(":").length === 2 && listed(FRONT_TARGET_SOURCES, source)) return { kind: "targets_unchecked", source, reason: listed(FRONT_TARGET_REASONS, reason) ? reason : "other" };
    return { kind: "targets_unchecked", source: "other", reason: "other" };
  }
  return undefined;
}

/** Short names of the target sources, for the record's words: a word of 32 or more letters would read as a secret (`looksLikeSecretValue`), and the record refuses it. */
const SOURCE_WORD: Readonly<Record<(typeof FRONT_TARGET_SOURCES)[number] | "other", string>> = { stepfunctions: "Sfn", eventbridge: "Eb", scheduler: "Sched", pipes: "Pipes", ssm: "Ssm", other: "Other" };

/** The fixed upper camel case word a marker is written as in the usage record (it passes `AwsOperationNameSchema`, so under 32 letters). */
export function frontMarkerWord(marker: FrontMarker): string {
  switch (marker.kind) {
    case "heavy_function": return `HeavyFunction${pascal(marker.reason)}`;
    case "lambda_limit": return `LambdaLimit${pascal(marker.limit)}`;
    case "cloudformation_unchecked": return `CfnUnchecked${pascal(marker.reason)}`;
    case "targets_unchecked": return `Unchecked${SOURCE_WORD[marker.source]}${pascal(marker.reason)}`;
  }
}

const ALL_MARKERS: readonly FrontMarker[] = [
  ...[...FRONT_HEAVY_FUNCTION_REASONS, "other" as const].map((reason): FrontMarker => ({ kind: "heavy_function", reason })),
  ...[...FRONT_LIMIT_KINDS, "other" as const].map((limit): FrontMarker => ({ kind: "lambda_limit", limit })),
  ...[...FRONT_CLOUDFORMATION_REASONS, "other" as const].map((reason): FrontMarker => ({ kind: "cloudformation_unchecked", reason })),
  ...[...FRONT_TARGET_SOURCES, "other" as const].flatMap((source) => [...FRONT_TARGET_REASONS, "other" as const].map((reason): FrontMarker => ({ kind: "targets_unchecked", source, reason }))),
];
const MARKER_OF_WORD: ReadonlyMap<string, FrontMarker> = new Map(ALL_MARKERS.map((marker) => [frontMarkerWord(marker), marker]));

/** The marker a usage record's operation word stands for, or undefined for any other word. The service must be the one the marker is recorded under. */
export function frontMarkerOfWord(service: string, word: string): FrontMarker | undefined {
  const marker = MARKER_OF_WORD.get(word);
  if (marker === undefined) return undefined;
  const expected = marker.kind === "cloudformation_unchecked" ? FRONT_CLOUDFORMATION_UNCHECKED_SERVICE : marker.kind === "targets_unchecked" ? FRONT_TARGETS_UNCHECKED_SERVICE : "lambda";
  return service === expected ? marker : undefined;
}

/** True for the services the front records unchecked markers under. */
export const isFrontUncheckedService = (service: string): boolean => (FRONT_UNCHECKED_SERVICES as readonly string[]).includes(service);

// ---- the words

const HEAVY_FUNCTION_WORDS: Readonly<Record<(typeof FRONT_HEAVY_FUNCTION_REASONS)[number] | "other", string>> = {
  image: "a container image", runtime: "a runtime other than Python or Node.js", "x86-native": "x86-64 native code", "native-code": "native code", unchecked: "a package too large to inspect", other: "a function the engine cannot run",
};
const TARGET_SOURCE_WORDS: Readonly<Record<(typeof FRONT_TARGET_SOURCES)[number] | "other", string>> = {
  stepfunctions: "Step Functions", eventbridge: "EventBridge", scheduler: "EventBridge Scheduler", pipes: "EventBridge Pipes", ssm: "Systems Manager Automation", other: "a service call",
};
const TARGET_REASON_WORDS: Readonly<Record<(typeof FRONT_TARGET_REASONS)[number] | "other", string>> = {
  resource: "a task resource that could not be read", dynamic: "a target chosen while running", arn: "a target ARN that could not be read", intrinsic: "a definition built with functions",
  unreadable: "a definition that could not be read", script: "a script or another document that runs", other: "something that could not be read",
};
const CLOUDFORMATION_REASON_WORDS: Readonly<Record<(typeof FRONT_CLOUDFORMATION_REASONS)[number] | "other", string>> = {
  nested: "nested stacks", transform: "macros and transforms", unreadable: "a template that could not be read", unmapped: "a resource type outside the emulator's services", unparsed: "a template that could not be parsed",
  custom: "custom resources", other: "something in a template that could not be read",
};

/** What one marker says: a fixed `item` (what it is about, at most 80 characters, the part the pull request shows in full) and `reason` (the fixed words after it, at most 100). */
export interface FrontMarkerWords { id: string; text: string; reason: string }

/** The fixed sentences of a marker for the evidence. Pure; nothing but the tables above. */
export function describeFrontMarker(marker: FrontMarker): FrontMarkerWords {
  switch (marker.kind) {
    case "heavy_function":
      return { id: `lambda-heavy-${marker.reason}`, text: `Lambda function was not run locally (${HEAVY_FUNCTION_WORDS[marker.reason]})`, reason: "the function runner is not available yet" };
    case "lambda_limit":
      return { id: `lambda-limit-${marker.limit}`, text: marker.limit === "30s" ? "Lambda function ran longer than the local limit (30 s)" : marker.limit === "sfn-10s" ? "Lambda function ran longer than the local limit (10 s under Step Functions)" : "Lambda function ran longer than the engine's local limit", reason: "not tested locally" };
    case "cloudformation_unchecked":
      return { id: `not-checked-cloudformation-${marker.reason}`, text: "Resources a CloudFormation template creates", reason: `not checked: ${CLOUDFORMATION_REASON_WORDS[marker.reason]}` };
    case "targets_unchecked":
      return { id: `not-checked-${marker.source}-${marker.reason}`, text: `AWS calls made through ${TARGET_SOURCE_WORDS[marker.source]}`, reason: `not checked: ${TARGET_REASON_WORDS[marker.reason]}` };
  }
}
