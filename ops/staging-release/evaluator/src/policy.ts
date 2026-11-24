// Parses and strictly validates the pinned policy files. Unknown keys are errors: a policy this evaluator does not fully understand must not be used.
import {
  InputError,
  asArray,
  asBoolean,
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  asString,
  field,
  hasOwn,
  onlyKeys,
  parseJsonText,
  policyRegExp,
  HEX40,
} from "./util.ts";

export type RuleName = "R1" | "R2" | "R3" | "R4" | "R4b" | "R5" | "R6" | "E1" | "R-SIGNKEY";
export const RULE_NAMES: readonly RuleName[] = ["R1", "R2", "R3", "R4", "R4b", "R5", "R6", "E1", "R-SIGNKEY"];

export interface RuleConfig {
  rule: RuleName;
  logicalId: RegExp;
  /** R3 id: the name other rows (R4, R4b, E1) use in `causedBy`. */
  id: string | null;
  repo: string | null;
  imageParameter: string | null;
  causedBy: string | null;
  /** R-SIGNKEY: the NoEcho stack parameter the secret row is driven by. */
  parameter: string | null;
  /** R3 (amendment 3): the row shows only a (Truncated-Signature) of the container list; the image is proven by the template compare plus this image parameter changing to a verified digest. */
  truncatedImage: boolean;
}

export interface ImageParameterConfig {
  key: string;
  repo: string;
  format: "uri" | "digest";
  noneOnly: boolean;
}

export type RowMode = "rules" | "metadata-only" | "none";

export interface StackConfig {
  name: string;
  rowMode: RowMode;
  /** The access stack: the pipeline never deploys it, and a rollback needs zero rows there. */
  access: boolean;
  rules: RuleConfig[];
  imageParameters: ImageParameterConfig[];
}

export interface GateRequirement {
  name: string;
  mayBeSkipped: boolean;
}

export interface PipelineConfig {
  name: "code" | "cloud";
  branch: string;
  ci: { repo: string; workflowFile: string; requiredJobs: string[] };
  requiredGates: GateRequirement[];
  dryRunGate: string | null;
  answersAllowedDiffPaths: string[];
  overridesAllowedDiffPaths: string[];
  noEchoParameters: string[];
  stacks: Map<string, StackConfig>;
}

export interface LockfilePolicy {
  path: string;
  lockfileVersion: number;
  registryHost: string;
  integrity: RegExp;
  blockingGlobs: string[];
}

export interface Policy {
  version: 1;
  maxUnauditedAutoRuns: number;
  gateMaxAgeMinutes: number;
  gateClockSkewMinutes: number;
  skippedGateReasons: string[];
  dryRunIgnorableFailures: string[];
  requiredImageTagPrefix: string;
  /** Files whose text the evaluator reads for `requires:` markers (the release-notes convention, DEC 254zzz441). */
  releaseNotesGlobs: string[];
  allowedCapabilities: string[];
  allowedPathGlobs: string[];
  lockfile: LockfilePolicy;
  lambdaCodeKey: RegExp;
  forbiddenResourceTypes: string[];
  pipelines: Map<"code" | "cloud", PipelineConfig>;
}

function strings(value: unknown, where: string): string[] {
  return asArray(value, where).map((item, index) => asNonEmptyString(item, `${where}[${index}]`));
}

function parseRule(raw: unknown, where: string): RuleConfig {
  const record = asRecord(raw, where);
  onlyKeys(record, ["rule", "id", "logicalIdPattern", "repo", "imageParameter", "causedBy", "parameter", "truncatedImage"], where);
  const rule = asString(field(record, "rule", where), `${where}.rule`);
  if (!(RULE_NAMES as readonly string[]).includes(rule)) throw new InputError("policy-invalid", `${where}.rule "${rule}" is not a known rule`);
  const optional = (key: string): string | null => (hasOwn(record, key) ? asNonEmptyString(record[key], `${where}.${key}`) : null);
  const config: RuleConfig = {
    rule: rule as RuleName,
    logicalId: policyRegExp(field(record, "logicalIdPattern", where), `${where}.logicalIdPattern`),
    id: optional("id"),
    repo: optional("repo"),
    imageParameter: optional("imageParameter"),
    causedBy: optional("causedBy"),
    parameter: optional("parameter"),
    truncatedImage: hasOwn(record, "truncatedImage") ? asBoolean(record.truncatedImage, `${where}.truncatedImage`) : false,
  };
  if (config.rule === "R3" && (config.id === null || config.repo === null)) throw new InputError("policy-invalid", `${where}: R3 needs id and repo`);
  if (config.rule === "R-SIGNKEY" && config.parameter === null) throw new InputError("policy-invalid", `${where}: R-SIGNKEY needs parameter`);
  if (config.truncatedImage && (config.rule !== "R3" || config.imageParameter === null)) throw new InputError("policy-invalid", `${where}: truncatedImage needs an R3 rule with imageParameter`);
  if (config.rule === "R2" && config.imageParameter === null) throw new InputError("policy-invalid", `${where}: R2 needs imageParameter`);
  if ((config.rule === "R4" || config.rule === "R4b" || config.rule === "E1") && config.causedBy === null) throw new InputError("policy-invalid", `${where}: ${config.rule} needs causedBy`);
  return config;
}

function parseStack(name: string, raw: unknown, where: string): StackConfig {
  const record = asRecord(raw, where);
  onlyKeys(record, ["rowMode", "access", "rules", "imageParameters"], where);
  const rowMode = asString(field(record, "rowMode", where), `${where}.rowMode`);
  if (rowMode !== "rules" && rowMode !== "metadata-only" && rowMode !== "none") throw new InputError("policy-invalid", `${where}.rowMode is not known`);
  const rules = asArray(field(record, "rules", where), `${where}.rules`).map((item, index) => parseRule(item, `${where}.rules[${index}]`));
  if (rowMode !== "rules" && rules.length > 0) throw new InputError("policy-invalid", `${where}: rules need rowMode "rules"`);
  const imageParameters = asArray(field(record, "imageParameters", where), `${where}.imageParameters`).map((item, index): ImageParameterConfig => {
    const at = `${where}.imageParameters[${index}]`;
    const p = asRecord(item, at);
    onlyKeys(p, ["key", "repo", "format", "noneOnly"], at);
    const format = asString(field(p, "format", at), `${at}.format`);
    if (format !== "uri" && format !== "digest") throw new InputError("policy-invalid", `${at}.format is not known`);
    return { key: asNonEmptyString(field(p, "key", at), `${at}.key`), repo: asNonEmptyString(field(p, "repo", at), `${at}.repo`), format, noneOnly: hasOwn(p, "noneOnly") ? asBoolean(p.noneOnly, `${at}.noneOnly`) : false };
  });
  // Every rule that names another row (`causedBy`) must name an R3 id declared in the same stack.
  const r3Ids = new Set(rules.filter((r) => r.rule === "R3").map((r) => r.id));
  for (const rule of rules) {
    if (rule.causedBy !== null && !r3Ids.has(rule.causedBy)) throw new InputError("policy-invalid", `${where}: causedBy "${rule.causedBy}" is not an R3 id of this stack`);
  }
  return { name, rowMode, access: hasOwn(record, "access") ? asBoolean(record.access, `${where}.access`) : false, rules, imageParameters };
}

function parsePipeline(name: "code" | "cloud", raw: unknown, where: string): PipelineConfig {
  const record = asRecord(raw, where);
  onlyKeys(record, ["branch", "ci", "requiredGates", "dryRunGate", "answers", "overrides", "noEchoParameters", "stacks"], where);
  const ci = asRecord(field(record, "ci", where), `${where}.ci`);
  onlyKeys(ci, ["repo", "workflowFile", "requiredJobs"], `${where}.ci`);
  const requiredJobs = strings(field(ci, "requiredJobs", `${where}.ci`), `${where}.ci.requiredJobs`);
  if (requiredJobs.length === 0) throw new InputError("policy-invalid", `${where}.ci.requiredJobs must not be empty`);
  const gates = asArray(field(record, "requiredGates", where), `${where}.requiredGates`).map((item, index): GateRequirement => {
    const at = `${where}.requiredGates[${index}]`;
    const g = asRecord(item, at);
    onlyKeys(g, ["name", "mayBeSkipped"], at);
    return { name: asNonEmptyString(field(g, "name", at), `${at}.name`), mayBeSkipped: asBoolean(field(g, "mayBeSkipped", at), `${at}.mayBeSkipped`) };
  });
  if (gates.length === 0) throw new InputError("policy-invalid", `${where}.requiredGates must not be empty`);
  const diffPaths = (key: "answers" | "overrides"): string[] => {
    const part = asRecord(field(record, key, where), `${where}.${key}`);
    onlyKeys(part, ["allowedDiffPaths"], `${where}.${key}`);
    return strings(field(part, "allowedDiffPaths", `${where}.${key}`), `${where}.${key}.allowedDiffPaths`);
  };
  const dryRunRaw = field(record, "dryRunGate", where);
  const stacksRaw = asRecord(field(record, "stacks", where), `${where}.stacks`);
  const stacks = new Map<string, StackConfig>();
  for (const stackName of Object.keys(stacksRaw)) stacks.set(stackName, parseStack(stackName, stacksRaw[stackName], `${where}.stacks.${stackName}`));
  if (stacks.size === 0) throw new InputError("policy-invalid", `${where}.stacks must not be empty`);
  return {
    name,
    branch: asNonEmptyString(field(record, "branch", where), `${where}.branch`),
    ci: { repo: asNonEmptyString(field(ci, "repo", `${where}.ci`), `${where}.ci.repo`), workflowFile: asNonEmptyString(field(ci, "workflowFile", `${where}.ci`), `${where}.ci.workflowFile`), requiredJobs },
    requiredGates: gates,
    dryRunGate: dryRunRaw === null ? null : asNonEmptyString(dryRunRaw, `${where}.dryRunGate`),
    answersAllowedDiffPaths: diffPaths("answers"),
    overridesAllowedDiffPaths: diffPaths("overrides"),
    noEchoParameters: strings(field(record, "noEchoParameters", where), `${where}.noEchoParameters`),
    stacks,
  };
}

export function parsePolicy(text: unknown): Policy {
  const record = asRecord(parseJsonText(text, "policy"), "policy");
  onlyKeys(record, [
    "version", "notes", "maxUnauditedAutoRuns", "gateMaxAgeMinutes", "gateClockSkewMinutes", "skippedGateReasons", "dryRunIgnorableFailures",
    "requiredImageTagPrefix", "releaseNotesGlobs", "allowedCapabilities", "allowedPathGlobs", "lockfile", "lambdaCodeKeyPattern",
    "forbiddenResourceTypes", "pipelines",
  ], "policy");
  if (field(record, "version", "policy") !== 1) throw new InputError("policy-invalid", "policy.version must be 1");
  const lock = asRecord(field(record, "lockfile", "policy"), "policy.lockfile");
  onlyKeys(lock, ["path", "lockfileVersion", "registryHost", "integrityPattern", "blockingGlobs"], "policy.lockfile");
  const pipelinesRaw = asRecord(field(record, "pipelines", "policy"), "policy.pipelines");
  onlyKeys(pipelinesRaw, ["code", "cloud"], "policy.pipelines");
  const pipelines = new Map<"code" | "cloud", PipelineConfig>();
  for (const name of ["code", "cloud"] as const) pipelines.set(name, parsePipeline(name, field(pipelinesRaw, name, "policy.pipelines"), `policy.pipelines.${name}`));
  const policy: Policy = {
    version: 1,
    maxUnauditedAutoRuns: asFiniteNumber(field(record, "maxUnauditedAutoRuns", "policy"), "policy.maxUnauditedAutoRuns"),
    gateMaxAgeMinutes: asFiniteNumber(field(record, "gateMaxAgeMinutes", "policy"), "policy.gateMaxAgeMinutes"),
    gateClockSkewMinutes: asFiniteNumber(field(record, "gateClockSkewMinutes", "policy"), "policy.gateClockSkewMinutes"),
    skippedGateReasons: strings(field(record, "skippedGateReasons", "policy"), "policy.skippedGateReasons"),
    dryRunIgnorableFailures: strings(field(record, "dryRunIgnorableFailures", "policy"), "policy.dryRunIgnorableFailures"),
    requiredImageTagPrefix: asNonEmptyString(field(record, "requiredImageTagPrefix", "policy"), "policy.requiredImageTagPrefix"),
    releaseNotesGlobs: strings(field(record, "releaseNotesGlobs", "policy"), "policy.releaseNotesGlobs"),
    allowedCapabilities: strings(field(record, "allowedCapabilities", "policy"), "policy.allowedCapabilities"),
    allowedPathGlobs: strings(field(record, "allowedPathGlobs", "policy"), "policy.allowedPathGlobs"),
    lockfile: {
      path: asNonEmptyString(field(lock, "path", "policy.lockfile"), "policy.lockfile.path"),
      lockfileVersion: asFiniteNumber(field(lock, "lockfileVersion", "policy.lockfile"), "policy.lockfile.lockfileVersion"),
      registryHost: asNonEmptyString(field(lock, "registryHost", "policy.lockfile"), "policy.lockfile.registryHost"),
      integrity: policyRegExp(field(lock, "integrityPattern", "policy.lockfile"), "policy.lockfile.integrityPattern"),
      blockingGlobs: strings(field(lock, "blockingGlobs", "policy.lockfile"), "policy.lockfile.blockingGlobs"),
    },
    lambdaCodeKey: policyRegExp(field(record, "lambdaCodeKeyPattern", "policy"), "policy.lambdaCodeKeyPattern"),
    forbiddenResourceTypes: strings(field(record, "forbiddenResourceTypes", "policy"), "policy.forbiddenResourceTypes"),
    pipelines,
  };
  if (policy.maxUnauditedAutoRuns < 0 || policy.gateMaxAgeMinutes <= 0 || policy.gateClockSkewMinutes < 0) throw new InputError("policy-invalid", "policy numbers are out of range");
  return policy;
}

/** manual-paths.txt: one glob per line; `#` starts a comment line. A line with a NUL or an absolute path is rejected. */
export function parseManualPaths(text: unknown): string[] {
  const globs = lines(text, "manual-paths").map((line) => {
    if (line.startsWith("/") || line.includes("\\") || line.includes("..")) throw new InputError("policy-invalid", `manual-paths line "${line}" is not a repository-relative glob`);
    return line;
  });
  if (globs.length === 0) throw new InputError("policy-invalid", "manual-paths is empty");
  return globs;
}

export interface RollbackFloor {
  pipeline: "code" | "cloud";
  sha: string;
}

/** rollback-floor.txt: `<pipeline> <40-hex sha>   # comment`. A malformed line is an error, never skipped. */
export function parseRollbackFloors(text: unknown): RollbackFloor[] {
  return lines(text, "rollback-floor").map((line) => {
    const match = /^(code|cloud)\s+([0-9a-f]{40})(?:\s+#.*)?$/.exec(line);
    if (match === null || !HEX40.test(match[2] as string)) throw new InputError("policy-invalid", `rollback-floor line "${line}" is malformed`);
    return { pipeline: match[1] as "code" | "cloud", sha: match[2] as string };
  });
}

function lines(text: unknown, where: string): string[] {
  const body = asString(text, where);
  if (body.includes("\0")) throw new InputError("policy-invalid", `${where} contains a NUL byte`);
  return body.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}
