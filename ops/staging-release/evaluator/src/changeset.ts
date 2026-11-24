// Rules E (parameters), F (rows: an allow-list), G (no IAM / data / new resources), H (stack scope), I (images) and E1 (plan v3 sections 3 and 9 (c)).
// Every row of every change set must match ONE rule with EVERY detail covered; the live and the new template are then compared as a second, independent check.
import type { PipelineConfig, Policy, RuleConfig, StackConfig } from "./policy.ts";
import type { Fail } from "./checks.ts";
import { REGION } from "./checks.ts";
import {
  InputError,
  asArray,
  asBoolean,
  asNonEmptyString,
  asRecord,
  asString,
  deepDiff,
  deepEqual,
  field,
  globToRegExp,
  hasOwn,
  isRecord,
  jsonValue,
  onlyKeys,
  parseJsonText,
  pathText,
  type DiffEntry,
} from "./util.ts";

const METADATA_KEYS = ["aws:cdk:path", "aws:asset:path", "aws:asset:property", "aws:asset:is-bundled"];
const KNOWN_AFTER_APPLY = "{{changeSet:KNOWN_AFTER_APPLY}}";

interface Detail {
  attribute: string;
  name: string | null;
  path: string | null;
  requiresRecreation: string | null;
  before: unknown;
  after: unknown;
  hasBefore: boolean;
  hasAfter: boolean;
  changeSource: string | null;
  causingEntity: string | null;
  evaluation: string | null;
  changeType: string | null;
}

interface Row {
  stack: string;
  logicalId: string;
  type: string;
  action: string;
  replacement: string | null;
  scope: string[];
  details: Detail[];
  beforeContext: unknown;
  afterContext: unknown;
  policyAction: string | null;
}

export interface VerifiedImage {
  repo: string;
  digest: string;
}

interface ParamEffective {
  key: string;
  live: string;
  next: string;
  usePrevious: boolean;
  noEcho: boolean;
}

interface StackCtx {
  config: StackConfig;
  liveTemplate: Record<string, unknown>;
  newTemplate: Record<string, unknown>;
  liveResources: Record<string, unknown>;
  newResources: Record<string, unknown>;
  params: Map<string, ParamEffective>;
}

export interface RowVerdict {
  stack: string;
  logicalId: string;
  resourceType: string;
  action: string;
  rule: string | null;
}

export interface ChangeSetResult {
  rows: RowVerdict[];
  verifiedDigests: Set<string>;
  verified: VerifiedImage[];
}

function opt(record: Record<string, unknown>, key: string): unknown {
  return hasOwn(record, key) ? record[key] : undefined;
}

function optString(record: Record<string, unknown>, key: string, where: string): string | null {
  const v = opt(record, key);
  if (v === undefined || v === null) return null;
  return asString(v, `${where}.${key}`);
}

function parseDetail(raw: unknown, where: string): Detail {
  const d = asRecord(raw, where);
  onlyKeys(d, ["Target", "Evaluation", "ChangeSource", "CausingEntity"], where);
  const t = asRecord(field(d, "Target", where), `${where}.Target`);
  onlyKeys(t, ["Attribute", "Name", "RequiresRecreation", "Path", "BeforeValue", "AfterValue", "AttributeChangeType", "Drift"], `${where}.Target`);
  if (opt(t, "Drift") !== undefined && t.Drift !== null) throw new InputError("unknown-field", `${where}.Target.Drift is set`);
  return {
    attribute: asNonEmptyString(field(t, "Attribute", `${where}.Target`), `${where}.Target.Attribute`),
    name: optString(t, "Name", `${where}.Target`),
    path: optString(t, "Path", `${where}.Target`),
    requiresRecreation: optString(t, "RequiresRecreation", `${where}.Target`),
    before: opt(t, "BeforeValue"),
    after: opt(t, "AfterValue"),
    hasBefore: hasOwn(t, "BeforeValue"),
    hasAfter: hasOwn(t, "AfterValue"),
    changeSource: optString(d, "ChangeSource", where),
    causingEntity: optString(d, "CausingEntity", where),
    evaluation: optString(d, "Evaluation", where),
    changeType: optString(t, "AttributeChangeType", `${where}.Target`),
  };
}

/** Amendment 2: CloudFormation emits every reference-driven change as a pair, a Static ParameterReference/ResourceReference detail and a Dynamic DirectModification detail on the same attribute, name and path.
 *  The Dynamic twin is folded away only when exactly such a Static partner exists; a Dynamic DirectModification on its own stays a detail and is judged by the rule. */
function foldPairs(details: Detail[]): Detail[] {
  return details.filter((d) => {
    if (d.evaluation !== "Dynamic" || d.changeSource !== "DirectModification" || d.causingEntity !== null) return true;
    return !details.some((o) => o !== d && o.evaluation === "Static" && (o.changeSource === "ParameterReference" || o.changeSource === "ResourceReference") && o.attribute === d.attribute && o.name === d.name && o.path === d.path);
  });
}

function parseRow(stack: string, raw: unknown, where: string): Row {
  const change = asRecord(raw, where);
  onlyKeys(change, ["Type", "HookInvocationCount", "ResourceChange"], where);
  if (change.Type !== "Resource") throw new InputError("row-type", `${where}.Type is "${String(change.Type)}": hooks and other change kinds are never routine`);
  const rc = asRecord(field(change, "ResourceChange", where), `${where}.ResourceChange`);
  const w = `${where}.ResourceChange`;
  onlyKeys(rc, ["Action", "LogicalResourceId", "PhysicalResourceId", "ResourceType", "Replacement", "Scope", "Details", "ChangeSetId", "ModuleInfo", "BeforeContext", "AfterContext", "PolicyAction"], w);
  if (opt(rc, "ModuleInfo") !== undefined && rc.ModuleInfo !== null) throw new InputError("row-module", `${w}.ModuleInfo is set: modules are never routine`);
  const ctx = (key: string): unknown => {
    const v = opt(rc, key);
    return v === undefined || v === null ? null : jsonValue(v, `${w}.${key}`);
  };
  return {
    stack,
    logicalId: asNonEmptyString(field(rc, "LogicalResourceId", w), `${w}.LogicalResourceId`),
    type: asNonEmptyString(field(rc, "ResourceType", w), `${w}.ResourceType`),
    action: asNonEmptyString(field(rc, "Action", w), `${w}.Action`),
    replacement: optString(rc, "Replacement", w),
    scope: asArray(opt(rc, "Scope") ?? [], `${w}.Scope`).map((s, i) => asString(s, `${w}.Scope[${i}]`)),
    details: foldPairs(asArray(opt(rc, "Details") ?? [], `${w}.Details`).map((x, i) => parseDetail(x, `${w}.Details[${i}]`))),
    beforeContext: ctx("BeforeContext"),
    afterContext: ctx("AfterContext"),
    policyAction: optString(rc, "PolicyAction", w),
  };
}

// ---------- templates ----------

function templateOf(value: unknown, where: string): { template: Record<string, unknown>; resources: Record<string, unknown> } {
  const template = asRecord(jsonValue(value, where), where);
  return { template, resources: asRecord(field(template, "Resources", where), `${where}.Resources`) };
}

type PathPred = (path: (string | number)[], entry: DiffEntry) => boolean;

/** Amendment 1/7 (template side): only the four CDK/asset metadata keys may differ, and only by being removed or rewritten. The whole Metadata block may go only when it holds nothing else
 *  (never AWS::CloudFormation::Init, authentication or any other key). */
const metadataPath: PathPred = (path, entry) => {
  if (path[0] !== "Metadata") return false;
  if (path.length === 1) return entry.kind === "remove" && isRecord(entry.before) && Object.keys(entry.before).every((k) => METADATA_KEYS.includes(k));
  return typeof path[1] === "string" && METADATA_KEYS.includes(path[1]) && entry.kind !== "add";
};

/** Amendment 1 (row side): a Metadata detail is tolerated inside any rule only as the Remove of one of the four metadata paths by DirectModification. */
function metadataDetailProblems(row: Row): string[] {
  const problems: string[] = [];
  for (const d of row.details) {
    if (d.attribute !== "Metadata") continue;
    const key = d.path !== null && d.path.startsWith("/Metadata/") ? d.path.slice("/Metadata/".length) : null;
    if (key === null || !METADATA_KEYS.includes(key)) problems.push(`metadata detail "${String(d.path)}" is not one of the CDK/asset metadata paths`);
    if (d.changeSource !== "DirectModification") problems.push(`metadata detail "${String(d.path)}" change source is "${String(d.changeSource)}"`);
    if (d.changeType !== null && d.changeType !== "Remove") problems.push(`metadata detail "${String(d.path)}" is a ${d.changeType}, not a Remove`);
  }
  return problems;
}
const propertyUnder = (...names: string[]): PathPred => (path) => path[0] === "Properties" && typeof path[1] === "string" && names.includes(path[1]);

function diffOk(diffs: DiffEntry[], allowed: PathPred[]): string[] {
  return diffs.filter((d) => !allowed.some((pred) => pred(d.path, d))).map((d) => pathText(d.path));
}

// ---------- image helpers ----------

const IMAGE_URI = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]*)@(sha256:[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function imageDigestOf(value: string): string | null {
  const uri = IMAGE_URI.exec(value);
  if (uri !== null) return uri[4] as string;
  return DIGEST.test(value) ? value : null;
}

/** answers.json / overrides.json image values: exactly a digest this run verified, or a full URI in this account and region for a verified (repo, digest). */
export function documentImageOk(value: string, verified: readonly VerifiedImage[], accountId: string): boolean {
  if (DIGEST.test(value)) return verified.some((v) => v.digest === value);
  const m = IMAGE_URI.exec(value);
  return m !== null && m[1] === accountId && m[2] === REGION && verified.some((v) => v.repo === m[3] && v.digest === m[4]);
}

// ---------- the run-wide context ----------

interface Run {
  policy: Policy;
  pipeline: PipelineConfig;
  accountId: string;
  verified: VerifiedImage[];
  stacks: Map<string, StackCtx>;
  iamRowCount: number;
  fail: Fail;
}

function verifiedImage(run: Run, repo: string, digest: string): boolean {
  return run.verified.some((v) => v.repo === repo && v.digest === digest);
}

/** Checks a full image URI against this account, region, exact repo and the verified digests. Returns a problem text or null. */
function imageUriProblem(run: Run, value: unknown, repo: string): string | null {
  if (typeof value !== "string") return "image value is not a string";
  if (value === KNOWN_AFTER_APPLY) return "image value is not known before apply";
  const m = IMAGE_URI.exec(value);
  if (m === null) return `image value "${value}" is not <account>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:<64 hex>`;
  if (m[1] !== run.accountId) return "image is in another account";
  if (m[2] !== REGION) return `image is in region ${m[2]}`;
  if (m[3] !== repo) return `image repo "${m[3]}" is not "${repo}"`;
  return verifiedImage(run, repo, m[4] as string) ? null : `digest ${m[4]} was not built or reused by this run for ${repo}`;
}

// ---------- parameters (rule E) and images (rule I) ----------

function checkParameters(run: Run, stackName: string, stack: StackCtx, csParams: unknown, liveParams: unknown): void {
  const fail = (code: string, message: string): void => run.fail("E", code, `${stackName}: ${message}`);
  const live = new Map<string, Record<string, unknown>>();
  for (const [i, raw] of asArray(liveParams, `${stackName} live parameters`).entries()) {
    const p = asRecord(raw, `${stackName} live parameters[${i}]`);
    live.set(asNonEmptyString(field(p, "ParameterKey", "live parameter"), "live ParameterKey"), p);
  }
  const next = new Map<string, Record<string, unknown>>();
  for (const [i, raw] of asArray(csParams, `${stackName} change-set parameters`).entries()) {
    const p = asRecord(raw, `${stackName} change-set parameters[${i}]`);
    next.set(asNonEmptyString(field(p, "ParameterKey", "change-set parameter"), "change-set ParameterKey"), p);
  }
  const templateParams = isRecord(stack.newTemplate.Parameters) ? stack.newTemplate.Parameters : {};
  for (const key of new Set([...live.keys(), ...next.keys()])) {
    const l = live.get(key);
    const n = next.get(key);
    if (l === undefined || n === undefined) {
      fail("param-set", `parameter "${key}" exists only ${l === undefined ? "in the change set" : "live"}`);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- API values are strings; a non-string stays unequal to anything, as before
    const lv = String(opt(l, "ResolvedValue") ?? opt(l, "ParameterValue") ?? "");
    const usePrevious = n.UsePreviousValue === true;
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- same as above
    const nv = usePrevious ? lv : String(opt(n, "ResolvedValue") ?? opt(n, "ParameterValue") ?? "");
    const def = isRecord(templateParams[key]) ? templateParams[key] : {};
    const noEcho = def.NoEcho === true || def.NoEcho === "true" || lv === "****";
    stack.params.set(key, { key, live: lv, next: nv, usePrevious, noEcho });
    if (noEcho) {
      if (!run.pipeline.noEchoParameters.includes(key)) fail("noecho", `NoEcho parameter "${key}" is not allowed`);
      else if (!(usePrevious ? opt(n, "ParameterValue") === undefined || n.ParameterValue === "****" : n.ParameterValue === "****")) fail("noecho", `NoEcho parameter "${key}" shows a value (expected the masked ****)`);
      continue;
    }
    // Both the parameter value and its resolved value must stay put: an SSM-typed parameter whose path moves while it resolves to the same value is a change too.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- API values are strings; a non-string compares unequal, as in the resolved-value compare
    const rawChanged = !usePrevious && String(opt(l, "ParameterValue") ?? "") !== String(opt(n, "ParameterValue") ?? "");
    if (lv === nv) {
      if (rawChanged) fail("param-changed", `parameter "${key}" changed its value (it resolves the same)`);
      continue;
    }
    const image = stack.config.imageParameters.find((p) => p.key === key);
    if (image === undefined) {
      fail("param-changed", `parameter "${key}" changed and is not an allowed image parameter`);
      continue;
    }
    if (image.noneOnly) {
      fail("param-changed", `parameter "${key}" may only stay "none"`);
      continue;
    }
    if (usePrevious) continue;
    if (image.format === "uri") {
      const problem = imageUriProblem(run, nv, image.repo);
      if (problem !== null) fail("image", `${key}: ${problem}`);
    } else {
      if (!DIGEST.test(nv)) fail("image", `${key}: "${nv}" is not sha256:<64 hex>`);
      else if (!verifiedImage(run, image.repo, nv)) fail("image", `${key}: digest ${nv} was not built or reused by this run for ${image.repo}`);
    }
  }
  for (const image of stack.config.imageParameters) {
    if (!image.noneOnly) continue;
    const p = stack.params.get(image.key);
    if (p !== undefined && (p.live !== "none" || p.next !== "none")) fail("param-changed", `parameter "${image.key}" must be none and stay none`);
  }
}

function changedImageParam(stack: StackCtx, key: string): ParamEffective | null {
  const p = stack.params.get(key);
  const cfg = stack.config.imageParameters.find((x) => x.key === key);
  return p !== undefined && cfg !== undefined && !cfg.noneOnly && p.live !== p.next ? p : null;
}

// ---------- row verification ----------

const ANY = null;

function detailBasics(d: Detail, wantName: string | null, wantRecreate: string | null): string[] {
  const out: string[] = [];
  if (d.attribute !== "Properties") out.push(`detail attribute "${d.attribute}" is not Properties`);
  if (wantName !== null && d.name !== wantName) out.push(`detail name "${String(d.name)}" is not "${wantName}"`);
  if (wantRecreate !== null && d.requiresRecreation !== wantRecreate) out.push(`detail ${String(d.name)} RequiresRecreation is "${String(d.requiresRecreation)}"`);
  return out;
}

function pathSegments(d: Detail): string[] | null {
  if (d.path === null || !d.path.startsWith("/Properties/")) return null;
  return d.path.split("/").slice(1);
}

function scopeSubset(row: Row, allowed: readonly string[]): string[] {
  return row.scope.filter((s) => !allowed.includes(s)).map((s) => `scope "${s}" is not allowed`);
}

function contextDiffs(row: Row): DiffEntry[] | null {
  if (row.beforeContext === null || row.afterContext === null) return null;
  return deepDiff(row.beforeContext, row.afterContext);
}

function resourceBothPresent(stack: StackCtx, id: string): string[] {
  return hasOwn(stack.liveResources, id) && hasOwn(stack.newResources, id) ? [] : [`resource ${id} is not in both the live and the new template`];
}

function templateDiff(stack: StackCtx, id: string): DiffEntry[] {
  return deepDiff(stack.liveResources[id], stack.newResources[id]);
}

function lambdaRow(run: Run, stack: StackCtx, row: Row): string[] {
  const problems = [...resourceBothPresent(stack, row.logicalId), ...metadataDetailProblems(row)];
  if (row.action !== "Modify") problems.push(`action "${row.action}" is not Modify`);
  if (row.replacement !== "False") problems.push(`replacement is "${String(row.replacement)}"`);
  problems.push(...scopeSubset(row, ["Properties", "Metadata"]));
  if (row.policyAction !== null) problems.push("PolicyAction is set");
  if (row.details.length === 0) problems.push("no details");
  const envKeys: string[] = [];
  for (const d of row.details) {
    if (d.attribute === "Metadata") continue;
    const seg = pathSegments(d);
    if (seg === null) {
      problems.push(`detail without a /Properties/ path (${String(d.name)})`);
      continue;
    }
    if (seg.length === 3 && seg[1] === "Code" && seg[2] === "S3Key") {
      problems.push(...detailBasics(d, "Code", ANY));
      if (d.changeSource !== "DirectModification") problems.push("Code.S3Key change source is not DirectModification");
      if (typeof d.after !== "string" || !run.policy.lambdaCodeKey.test(d.after)) problems.push("Code.S3Key after-value is not an asset key");
    } else if (seg.length === 4 && seg[1] === "Environment" && seg[2] === "Variables") {
      problems.push(...detailBasics(d, "Environment", ANY));
      const changed = d.changeSource === "ParameterReference" && d.causingEntity !== null ? changedImageParam(stack, d.causingEntity) : null;
      if (changed === null) problems.push(`env var ${seg[3]} is not an image-parameter change (source ${String(d.changeSource)}, cause ${String(d.causingEntity)})`);
      else {
        if (d.before !== changed.live) problems.push(`env var ${seg[3]} before-value is not the live image value`);
        if (d.after !== changed.next) problems.push(`env var ${seg[3]} after-value is not the new image value`);
        envKeys.push(seg[3] as string);
      }
    } else problems.push(`property ${d.path ?? ""} is not allowed on a Lambda row`);
  }
  const s3Key: PathPred = (p) => p[0] === "Properties" && p[1] === "Code" && p[2] === "S3Key" && p.length === 3;
  const bad = diffOk(templateDiff(stack, row.logicalId), [s3Key, metadataPath]);
  if (bad.length > 0) problems.push(`template differs outside Code.S3Key: ${bad.join(", ")}`);
  const ctx = contextDiffs(row);
  if (ctx !== null) {
    const env: PathPred = (p) => p[0] === "Properties" && p[1] === "Environment" && p[2] === "Variables" && typeof p[3] === "string" && envKeys.includes(p[3]) && p.length === 4;
    const badCtx = diffOk(ctx, [s3Key, env, metadataPath]);
    if (badCtx.length > 0) problems.push(`row context differs outside the allowed properties: ${badCtx.join(", ")}`);
  }
  return problems;
}

function ssmRow(stack: StackCtx, row: Row, rule: RuleConfig): string[] {
  const problems = [...resourceBothPresent(stack, row.logicalId), ...metadataDetailProblems(row)];
  if (row.action !== "Modify" || row.replacement !== "False") problems.push("must be Modify with Replacement False");
  problems.push(...scopeSubset(row, ["Properties", "Metadata"]));
  if (row.policyAction !== null) problems.push("PolicyAction is set");
  const changed = rule.imageParameter === null ? null : changedImageParam(stack, rule.imageParameter);
  let value = 0;
  for (const d of row.details) {
    if (d.attribute === "Metadata") continue;
    if (d.path !== "/Properties/Value") {
      problems.push(`detail path "${String(d.path)}" is not /Properties/Value`);
      continue;
    }
    value += 1;
    problems.push(...detailBasics(d, "Value", ANY));
    if (d.changeSource !== "ParameterReference" || d.causingEntity !== rule.imageParameter) problems.push(`Value is not caused by the ${String(rule.imageParameter)} parameter`);
    if (changed === null) problems.push("the image parameter did not change");
    else if (d.after !== changed.next) problems.push("Value after-value is not the new image value");
  }
  if (value !== 1) problems.push(`expected exactly one Value detail, found ${value}`);
  const bad = diffOk(templateDiff(stack, row.logicalId), [metadataPath]);
  if (bad.length > 0) problems.push(`template differs: ${bad.join(", ")}`);
  const ctx = contextDiffs(row);
  if (ctx !== null) {
    const bad2 = diffOk(ctx, [(p) => p[0] === "Properties" && p[1] === "Value" && p.length === 2, metadataPath]);
    if (bad2.length > 0) problems.push(`row context differs: ${bad2.join(", ")}`);
  }
  return problems;
}

const TRUNCATED = /^\(Truncated-Signature\):/;

function taskDefRow(run: Run, stack: StackCtx, row: Row, rule: RuleConfig): string[] {
  const repo = rule.repo as string;
  const problems = [...resourceBothPresent(stack, row.logicalId), ...metadataDetailProblems(row)];
  if (row.action !== "Modify") problems.push(`action "${row.action}" is not Modify`);
  if (row.replacement !== "True") problems.push(`replacement is "${String(row.replacement)}", task definitions replace`);
  problems.push(...scopeSubset(row, ["Properties", "Metadata"]));
  if (row.policyAction !== null && row.policyAction !== "ReplaceAndDelete") problems.push(`PolicyAction "${row.policyAction}" is not allowed`);
  let images = 0;
  for (const d of row.details) {
    if (d.attribute === "Metadata") continue;
    if (rule.truncatedImage) {
      // Amendment 3: the gateway ServeTask row shows only a (Truncated-Signature) of the container list. The change is proven by the template compare below plus
      // the gateway image parameter moving to a digest this run built or reused (checked in the parameter step); any other container change shows in the template diff.
      const imageParam = rule.imageParameter === null ? null : changedImageParam(stack, rule.imageParameter);
      if (d.path !== "/Properties/ContainerDefinitions" || d.name !== "ContainerDefinitions" || d.changeSource !== "DirectModification") {
        problems.push(`property ${String(d.path ?? d.name)} is not the truncated container list`);
        continue;
      }
      if (typeof d.before !== "string" || typeof d.after !== "string" || !TRUNCATED.test(d.before) || !TRUNCATED.test(d.after)) problems.push("the container list is not shown as a truncated signature");
      if (imageParam === null) problems.push(`the image parameter ${String(rule.imageParameter)} did not change`);
      else if (!DIGEST.test(imageParam.next) || !verifiedImage(run, repo, imageParam.next)) problems.push(`the new ${String(rule.imageParameter)} digest is not one this run built or reused`);
      images += 1;
      continue;
    }
    if (d.path === null || !/^\/Properties\/ContainerDefinitions\/\d+\/Image$/.test(d.path)) {
      problems.push(`property ${String(d.path ?? d.name)} is not a container image`);
      continue;
    }
    images += 1;
    problems.push(...detailBasics(d, "ContainerDefinitions", ANY));
    problems.push(...[imageUriProblem(run, d.after, repo)].filter((x): x is string => x !== null));
    if (d.changeSource === "ParameterReference") {
      const changed = d.causingEntity === null ? null : changedImageParam(stack, d.causingEntity);
      if (changed === null) problems.push(`image is not caused by a changed image parameter (${String(d.causingEntity)})`);
      else if (typeof d.after === "string" && imageDigestOf(changed.next) !== imageDigestOf(d.after)) problems.push("image digest differs from the parameter's new digest");
    } else if (d.changeSource !== "DirectModification") problems.push(`image change source "${String(d.changeSource)}" is not allowed`);
  }
  if (images === 0) problems.push("no container image detail");
  const imagePath: PathPred = (p) => p[0] === "Properties" && p[1] === "ContainerDefinitions" && typeof p[2] === "number" && p[3] === "Image";
  // A truncated row shows no image value, so its template must not move at all (the image changes only through the verified image parameter); a visible row may move the Image expression because each detail's after-value is verified above.
  const bad = diffOk(templateDiff(stack, row.logicalId), rule.truncatedImage ? [metadataPath] : [imagePath, metadataPath]);
  if (bad.length > 0) problems.push(`template differs outside the container image: ${bad.join(", ")}`);
  const ctx = contextDiffs(row);
  if (ctx !== null) {
    const bad2 = diffOk(ctx, [imagePath, metadataPath]);
    if (bad2.length > 0) problems.push(`row context differs outside the container image: ${bad2.join(", ")}`);
  }
  return problems;
}

/** R4 and R4b: the row only follows an R3 replacement; the resource's template JSON is byte-identical (so not even the metadata moves). */
function followsRow(stack: StackCtx, row: Row, rule: RuleConfig, r3: Map<string, string>, propertyName: string, pathPattern: RegExp): string[] {
  const problems = [...resourceBothPresent(stack, row.logicalId), ...metadataDetailProblems(row)];
  if (row.action !== "Modify" || row.replacement !== "False") problems.push("must be Modify with Replacement False");
  problems.push(...scopeSubset(row, ["Properties", "Metadata"]));
  if (row.policyAction !== null) problems.push("PolicyAction is set");
  const cause = r3.get(rule.causedBy as string);
  if (cause === undefined) problems.push(`no verified R3 row "${String(rule.causedBy)}" in this change set`);
  const own = row.details.filter((d) => d.attribute !== "Metadata");
  if (own.length === 0) problems.push("no property details");
  for (const d of own) {
    problems.push(...detailBasics(d, propertyName, ANY));
    if (d.path === null || !pathPattern.test(d.path)) problems.push(`detail path "${String(d.path)}" is not the expected property path`);
    if (d.changeSource !== "ResourceReference") problems.push(`change source "${String(d.changeSource)}" is not ResourceReference`);
    if (cause !== undefined && d.causingEntity !== cause) problems.push(`caused by "${String(d.causingEntity)}", not by the R3 row "${cause}"`);
  }
  const bad = diffOk(templateDiff(stack, row.logicalId), [metadataPath]);
  if (bad.length > 0) problems.push(`the resource's template JSON differs live vs new: ${bad.join(", ")}`);
  const ctx = contextDiffs(row);
  if (ctx !== null) {
    const bad2 = diffOk(ctx, [(p) => p[0] === "Properties" && p[1] === propertyName, metadataPath]);
    if (bad2.length > 0) problems.push(`row context differs: ${bad2.join(", ")}`);
  }
  return problems;
}

const POLICY_ARN = /^(arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:task-definition\/)([A-Za-z0-9_-]+):(\d+)$/;

/** The E1 document check, used after deploy (PostCheck: the deployed policy against the old deployed policy and the schedule's target ARN). */
export function checkE1Documents(before: unknown, after: unknown, scheduleTargetArn?: string): string[] {
  const problems: string[] = [];
  try {
    const b = typeof before === "string" ? parseJsonText(before, "before policy") : before;
    const a = typeof after === "string" ? parseJsonText(after, "after policy") : after;
    const diffs = deepDiff(b, a);
    if (diffs.length !== 1) return [`the policy differs in ${diffs.length} places, expected exactly one`];
    const d = diffs[0] as DiffEntry;
    if (d.kind !== "change" || d.path.length < 3 || d.path[0] !== "Statement" || typeof d.path[1] !== "number" || d.path[2] !== "Resource" || (d.path.length === 4 ? typeof d.path[3] !== "number" : d.path.length !== 3)) {
      return [`the difference is at ${pathText(d.path)}, not a statement Resource`];
    }
    const statements = (b as { Statement: unknown[] }).Statement;
    const statement = statements[d.path[1]];
    const actions = isRecord(statement) ? statement.Action : undefined;
    const runTask = actions === "ecs:RunTask" || (Array.isArray(actions) && actions.length === 1 && actions[0] === "ecs:RunTask");
    if (!runTask || !isRecord(statement) || statement.Effect !== "Allow") return ["the changed statement is not the ecs:RunTask allow statement"];
    const mb = typeof d.before === "string" ? POLICY_ARN.exec(d.before) : null;
    const ma = typeof d.after === "string" ? POLICY_ARN.exec(d.after) : null;
    if (mb === null || ma === null) return ["the changed resource is not an ECS task-definition ARN"];
    if (mb[1] !== ma[1] || mb[2] !== ma[2]) problems.push("the task-definition family or prefix changed");
    if (Number(ma[3]) <= Number(mb[3])) problems.push("the task-definition revision did not go up");
    if (scheduleTargetArn !== undefined && d.after !== scheduleTargetArn) problems.push("the new ARN is not the schedule target's task-definition ARN");
  } catch (error) {
    problems.push(error instanceof InputError ? error.message : "the policy documents could not be compared");
  }
  return problems;
}

/** E1 (amendment 5): CloudFormation shows the policy row as ONE DirectModification detail at /Properties/PolicyDocument/Statement/<n>/Resource with after-value {{changeSet:KNOWN_AFTER_APPLY}}
 *  and no CausingEntity. The row proves nothing by itself, so E1 rests on (1) that exact shape, (2) the resource's template JSON being identical live vs new, (3) the statement it points at being
 *  the ecs:RunTask allow whose Resource is exactly {"Ref": <the verified R3 PriceFetchTask logical id>}, (4) this being the only AWS::IAM::* row of the whole run, and (5) the PostCheck document check. */
function e1Row(run: Run, stack: StackCtx, row: Row, rule: RuleConfig, r3: Map<string, string>): string[] {
  const problems = [...resourceBothPresent(stack, row.logicalId), ...metadataDetailProblems(row)];
  if (row.action !== "Modify" || row.replacement !== "False") problems.push("must be Modify with Replacement False");
  if (row.scope.length !== 1 || row.scope[0] !== "Properties") problems.push("scope must be exactly [Properties]");
  if (row.policyAction !== null) problems.push("PolicyAction is set");
  if (run.iamRowCount !== 1) problems.push(`E1 must be the only AWS::IAM::* row of the whole run (found ${run.iamRowCount})`);
  const cause = r3.get(rule.causedBy as string);
  if (cause === undefined) problems.push(`no verified R3 row "${String(rule.causedBy)}" in this change set`);
  if (row.details.length !== 1) problems.push(`expected exactly one detail, found ${row.details.length}`);
  const d = row.details[0];
  if (d !== undefined) {
    problems.push(...detailBasics(d, "PolicyDocument", ANY));
    const match = d.path === null ? null : /^\/Properties\/PolicyDocument\/Statement\/(\d+)\/Resource$/.exec(d.path);
    if (match === null) problems.push(`detail path "${String(d.path)}" is not a statement Resource`);
    if (d.changeSource !== "DirectModification") problems.push(`change source "${String(d.changeSource)}" is not DirectModification`);
    if (d.causingEntity !== null) problems.push("the detail names a causing entity (a different shape)");
    if (d.after !== KNOWN_AFTER_APPLY) problems.push("after-value is not {{changeSet:KNOWN_AFTER_APPLY}} (a visible value means something other than a replaced task definition)");
    if (match !== null && cause !== undefined && hasOwn(stack.newResources, row.logicalId)) {
      const res = stack.newResources[row.logicalId];
      const props = isRecord(res) && isRecord(res.Properties) ? res.Properties : undefined;
      const doc = props !== undefined && isRecord(props.PolicyDocument) ? props.PolicyDocument : undefined;
      const statements = doc !== undefined && Array.isArray(doc.Statement) ? doc.Statement : [];
      const st: unknown = statements[Number(match[1])];
      const actions = isRecord(st) ? st.Action : undefined;
      const runTask = actions === "ecs:RunTask" || (Array.isArray(actions) && actions.length === 1 && actions[0] === "ecs:RunTask");
      if (!isRecord(st) || st.Effect !== "Allow" || !runTask || !deepEqual(st.Resource, { Ref: cause })) problems.push(`statement ${match[1]} is not the ecs:RunTask allow on {"Ref": "${cause}"}`);
    }
  }
  if (hasOwn(stack.liveResources, row.logicalId) && hasOwn(stack.newResources, row.logicalId) && !deepEqual(stack.liveResources[row.logicalId], stack.newResources[row.logicalId])) {
    problems.push("the resource's template JSON differs live vs new");
  }
  if (row.beforeContext !== null && row.afterContext !== null) {
    const b = isRecord(row.beforeContext) ? row.beforeContext.Properties : undefined;
    const a = isRecord(row.afterContext) ? row.afterContext.Properties : undefined;
    if (isRecord(b) && isRecord(a) && hasOwn(b, "PolicyDocument") && hasOwn(a, "PolicyDocument") && typeof b.PolicyDocument !== "string") problems.push(...checkE1Documents(b.PolicyDocument, a.PolicyDocument));
  }
  return problems;
}

/** R-SIGNKEY (amendment 6): the callback signing-key Secret row that every control-plane preview carries (the CLI passes the NoEcho key on every deploy). Exactly this logical id, one SecretString detail
 *  driven by the NoEcho parameter (values are masked, so equality is unprovable), and the secret resource's template JSON identical live vs new (DeletionPolicy, UpdateReplacePolicy, name, everything). */
function signKeyRow(stack: StackCtx, row: Row, rule: RuleConfig): string[] {
  const problems = [...resourceBothPresent(stack, row.logicalId), ...metadataDetailProblems(row)];
  if (row.type !== "AWS::SecretsManager::Secret" || row.action !== "Modify" || row.replacement !== "False") problems.push("must be a Modify of the Secret with Replacement False");
  problems.push(...scopeSubset(row, ["Properties", "Metadata"]));
  if (row.policyAction !== null) problems.push("PolicyAction is set");
  const own = row.details.filter((d) => d.attribute !== "Metadata");
  if (own.length !== 1) problems.push(`expected exactly one property detail, found ${own.length}`);
  for (const d of own) {
    if (d.path !== "/Properties/SecretString" || d.name !== "SecretString" || d.changeSource !== "ParameterReference" || d.causingEntity !== rule.parameter) problems.push(`the detail is not SecretString driven by parameter ${String(rule.parameter)}`);
    for (const v of [d.before, d.after]) if (v !== undefined && v !== "****") problems.push("a visible secret value (the masked form is ****)");
  }
  const p = rule.parameter === null ? undefined : stack.params.get(rule.parameter);
  if (p === undefined || !p.noEcho) problems.push(`parameter ${String(rule.parameter)} is not a NoEcho parameter of this change set`);
  const bad = diffOk(templateDiff(stack, row.logicalId), [metadataPath]);
  if (bad.length > 0) problems.push(`the secret's template JSON differs live vs new: ${bad.join(", ")}`);
  return problems;
}

function bucketDeploymentRow(stack: StackCtx, row: Row): string[] {
  const problems = [...resourceBothPresent(stack, row.logicalId), ...metadataDetailProblems(row)];
  // Amendment 4: CloudFormation reports Replacement "Conditional" for Custom::CDKBucketDeployment (never True).
  if (row.action !== "Modify" || (row.replacement !== "False" && row.replacement !== "Conditional")) problems.push(`must be Modify with Replacement False or Conditional (got ${String(row.replacement)})`);
  problems.push(...scopeSubset(row, ["Properties", "Metadata"]));
  if (row.policyAction !== null) problems.push("PolicyAction is set");
  let n = 0;
  for (const d of row.details) {
    if (d.attribute === "Metadata") continue;
    n += 1;
    problems.push(...detailBasics(d, null, ANY));
    if (d.name !== "SourceObjectKeys" && d.name !== "SourceMarkers") problems.push(`property "${String(d.name)}" is not SourceObjectKeys or SourceMarkers`);
    if (d.path === null || d.name === null || !(d.path === `/Properties/${d.name}` || d.path.startsWith(`/Properties/${d.name}/`))) problems.push(`detail path "${String(d.path)}" is not under /Properties/${String(d.name)}`);
    if (d.changeSource !== "DirectModification") problems.push("change source is not DirectModification");
  }
  if (n === 0) problems.push("no property details");
  const bad = diffOk(templateDiff(stack, row.logicalId), [propertyUnder("SourceObjectKeys", "SourceMarkers"), metadataPath]);
  if (bad.length > 0) problems.push(`template differs outside SourceObjectKeys/SourceMarkers: ${bad.join(", ")}`);
  const ctx = contextDiffs(row);
  if (ctx !== null) {
    const bad2 = diffOk(ctx, [propertyUnder("SourceObjectKeys", "SourceMarkers"), metadataPath]);
    if (bad2.length > 0) problems.push(`row context differs: ${bad2.join(", ")}`);
  }
  return problems;
}

/** R7: every detail is a Metadata Remove of the CDK/asset paths, and the template difference is only those keys (never AWS::CloudFormation::Init and the like). */
function metadataRow(stack: StackCtx, row: Row): string[] {
  const problems = [...resourceBothPresent(stack, row.logicalId), ...metadataDetailProblems(row)];
  if (row.action !== "Modify" || row.replacement !== "False") problems.push("must be Modify with Replacement False");
  // Real rows list "Properties" in Scope even when every Detail is a Metadata Remove (P0 replay); the template compare below is what proves nothing else moved.
  problems.push(...scopeSubset(row, ["Metadata", "Properties"]));
  if (row.policyAction !== null) problems.push("PolicyAction is set");
  const bad = diffOk(templateDiff(stack, row.logicalId), [metadataPath]);
  if (bad.length > 0) problems.push(`metadata difference outside the CDK/asset keys: ${bad.join(", ")}`);
  const ctx = contextDiffs(row);
  if (ctx !== null) {
    const bad2 = diffOk(ctx, [metadataPath]);
    if (bad2.length > 0) problems.push(`row context differs: ${bad2.join(", ")}`);
  }
  return problems;
}

const RULE_TYPE: Record<string, string> = {
  R1: "AWS::Lambda::Function",
  R6: "AWS::Lambda::Function",
  R2: "AWS::SSM::Parameter",
  R3: "AWS::ECS::TaskDefinition",
  R4: "AWS::ECS::Service",
  R4b: "AWS::Events::Rule",
  R5: "Custom::CDKBucketDeployment",
  E1: "AWS::IAM::Policy",
  "R-SIGNKEY": "AWS::SecretsManager::Secret",
};

function forbiddenType(run: Run, type: string): boolean {
  return run.policy.forbiddenResourceTypes.some((glob) => globToRegExp(glob.replace(/\*/g, "**"), false).test(type));
}

interface RowOutcome {
  rule: string | null;
}

function evaluateStack(run: Run, stackName: string, stack: StackCtx, rows: Row[], out: RowVerdict[]): void {
  const record = (row: Row, rule: string | null): void => {
    out.push({ stack: stackName, logicalId: row.logicalId, resourceType: row.type, action: row.action, rule });
  };
  const reject = (row: Row, rule: string, problems: string[]): void => {
    record(row, null);
    run.fail(rule === "G" || rule === "H" ? rule : "F", "row-rejected", `${stackName}/${row.logicalId} (${row.type}) failed ${rule}: ${problems.join("; ")}`);
  };
  const noRows = stack.config.rowMode === "none";
  const metadataOnly = stack.config.rowMode === "metadata-only";
  const r3 = new Map<string, string>();
  const pending: Row[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.logicalId)) {
      reject(row, "uniqueness", ["the logical id appears twice in the change set"]);
      continue;
    }
    seen.add(row.logicalId);
    if (noRows) {
      reject(row, "H", [`stack ${stackName} must have no rows`]);
      continue;
    }
    // R8: CDK metadata.
    if (row.type === "AWS::CDK::Metadata" && (row.action === "Modify" || row.action === "Remove")) {
      const bad = row.action === "Modify" && !(hasOwn(stack.liveResources, row.logicalId) && hasOwn(stack.newResources, row.logicalId)) ? ["resource missing from a template"] : [];
      if (bad.length > 0) reject(row, "R8", bad);
      else record(row, "R8");
      continue;
    }
    // R7: metadata only.
    if (row.details.length > 0 && row.details.every((d) => d.attribute === "Metadata")) {
      const problems = metadataRow(stack, row);
      if (problems.length > 0) reject(row, "R7", problems);
      else record(row, "R7");
      continue;
    }
    if (metadataOnly) {
      reject(row, "H", [`stack ${stackName} may only have metadata rows (a real ${row.type} row is not routine here)`]);
      continue;
    }
    const rule = stack.config.rules.find((r) => RULE_TYPE[r.rule] === row.type && r.logicalId.test(row.logicalId));
    if (rule === undefined) {
      if (forbiddenType(run, row.type)) reject(row, "G", [`resource type ${row.type} is never routine (no IAM, data, network or new resources)`]);
      else reject(row, "F", ["no allow-list rule matches this resource type and logical id in this stack"]);
      continue;
    }
    if (rule.rule === "R4" || rule.rule === "R4b" || rule.rule === "E1") {
      pending.push(row);
      continue;
    }
    let problems: string[];
    if (rule.rule === "R1" || rule.rule === "R6") problems = lambdaRow(run, stack, row);
    else if (rule.rule === "R-SIGNKEY") problems = signKeyRow(stack, row, rule);
    else if (rule.rule === "R2") problems = ssmRow(stack, row, rule);
    else if (rule.rule === "R3") problems = taskDefRow(run, stack, row, rule);
    else problems = bucketDeploymentRow(stack, row);
    if (problems.length > 0) reject(row, rule.rule, problems);
    else {
      record(row, rule.rule);
      if (rule.rule === "R3") r3.set(rule.id as string, row.logicalId);
    }
  }
  for (const row of pending) {
    const rule = stack.config.rules.find((r) => RULE_TYPE[r.rule] === row.type && r.logicalId.test(row.logicalId)) as RuleConfig;
    let problems: string[];
    if (rule.rule === "R4") problems = followsRow(stack, row, rule, r3, "TaskDefinition", /^\/Properties\/TaskDefinition$/);
    else if (rule.rule === "R4b") problems = followsRow(stack, row, rule, r3, "Targets", /^\/Properties\/Targets\/\d+\/EcsParameters\/TaskDefinitionArn$/);
    else problems = e1Row(run, stack, row, rule, r3);
    if (problems.length > 0) reject(row, rule.rule, problems);
    else record(row, rule.rule);
  }
}

/** Evaluates a template Condition with known parameter values. Returns null when anything is unknown (the caller then treats the resource as possibly deployed). */
function conditionValue(name: string, conditions: unknown, params: Map<string, string>, depth = 0): boolean | null {
  if (depth > 12 || !isRecord(conditions) || !hasOwn(conditions, name)) return null;
  const operand = (node: unknown): string | boolean | null => {
    if (typeof node === "string") return node;
    if (isRecord(node)) {
      const keys = Object.keys(node);
      if (keys.length !== 1) return null;
      const key = keys[0] as string;
      const arg = node[key];
      if (key === "Ref" && typeof arg === "string") return params.has(arg) ? (params.get(arg) as string) : arg === "AWS::Region" ? REGION : null;
      if (key === "Condition" && typeof arg === "string") return conditionValue(arg, conditions, params, depth + 1);
      return evalNode(node);
    }
    return null;
  };
  const evalNode = (node: unknown): boolean | null => {
    if (!isRecord(node)) return null;
    const keys = Object.keys(node);
    if (keys.length !== 1) return null;
    const key = keys[0] as string;
    const arg = node[key];
    if (key === "Condition" && typeof arg === "string") return conditionValue(arg, conditions, params, depth + 1);
    if (!Array.isArray(arg)) return null;
    if (key === "Fn::Equals" && arg.length === 2) {
      const a = operand(arg[0]);
      const b = operand(arg[1]);
      return a === null || b === null ? null : a === b;
    }
    const parts = arg.map((x) => evalNode(x));
    if (key === "Fn::Not" && parts.length === 1) return parts[0] === null ? null : !parts[0];
    if ((key === "Fn::And" || key === "Fn::Or") && parts.length >= 2) {
      if (parts.some((p) => p === null)) return null;
      return key === "Fn::And" ? parts.every((p) => p === true) : parts.some((p) => p === true);
    }
    return null;
  };
  return evalNode(conditions[name]);
}

/** Is this resource deployed? false only when its Condition is known to be false; true when it has none or it is true; null when unknown. */
function deployed(resource: unknown, template: Record<string, unknown>, params: Map<string, string>): boolean | null {
  if (!isRecord(resource) || resource.Condition === undefined) return true;
  if (typeof resource.Condition !== "string") return null;
  return conditionValue(resource.Condition, template.Conditions, params);
}

/** Template-level checks that are independent of the rows. */
function checkTemplates(run: Run, stackName: string, stack: StackCtx, rows: Row[]): void {
  const fail = (rule: string, code: string, message: string): void => run.fail(rule, code, `${stackName}: ${message}`);
  const keys = new Set([...Object.keys(stack.liveTemplate), ...Object.keys(stack.newTemplate)]);
  // Amendment 7: the preview synth has no CDKMetadataAvailable condition, the deploy path does: exempt exactly that one condition, and only as a removal (or no difference).
  const conditionsMinusCdk = (template: Record<string, unknown>): unknown => {
    const c = template.Conditions;
    if (!isRecord(c)) return c;
    return Object.fromEntries(Object.entries(c).filter(([k]) => k !== "CDKMetadataAvailable"));
  };
  const cdkConditionOnlyRemoved = (): boolean => !(isRecord(stack.newTemplate.Conditions) && hasOwn(stack.newTemplate.Conditions, "CDKMetadataAvailable"));
  for (const key of keys) {
    if (key === "Resources") continue;
    if (key === "Conditions" && hasOwn(stack.liveTemplate, key) && hasOwn(stack.newTemplate, key) && cdkConditionOnlyRemoved() && deepEqual(conditionsMinusCdk(stack.liveTemplate), conditionsMinusCdk(stack.newTemplate))) continue;
    if (!hasOwn(stack.liveTemplate, key) || !hasOwn(stack.newTemplate, key) || !deepEqual(stack.liveTemplate[key], stack.newTemplate[key])) {
      fail("E", "template-section", `template section "${key}" differs from live (parameters, outputs, conditions, mappings, rules, transform and metadata must be identical)`);
    }
  }
  // CAPABILITY_AUTO_EXPAND is on every real change set (P0 saw it on all previews); it is accepted only because no transform may exist: no top-level Transform (compared above) and no Fn::Transform anywhere.
  if (JSON.stringify(stack.newTemplate).includes('"Fn::Transform"') || JSON.stringify(stack.newTemplate).includes('"Transform"')) fail("E", "transform", "the new template uses a macro or transform");
  const withRow = new Set(rows.map((r) => r.logicalId));
  for (const id of new Set([...Object.keys(stack.liveResources), ...Object.keys(stack.newResources)])) {
    if (withRow.has(id)) continue;
    const l = hasOwn(stack.liveResources, id) ? stack.liveResources[id] : undefined;
    const n = hasOwn(stack.newResources, id) ? stack.newResources[id] : undefined;
    const isCdkMeta = (v: unknown): boolean => isRecord(v) && v.Type === "AWS::CDK::Metadata";
    if (id === "CDKMetadata" && (l === undefined || isCdkMeta(l)) && (n === undefined || isCdkMeta(n))) continue;
    if (deepEqual(l, n)) continue;
    // A resource whose Condition is false in both templates (with each side's own parameters) does not exist in the stack, so CloudFormation shows no row for it (P0 replay: the optional email sender and the provider secret reads).
    const liveParams = new Map([...stack.params.values()].map((p) => [p.key, p.live] as [string, string]));
    const newParams = new Map([...stack.params.values()].map((p) => [p.key, p.next] as [string, string]));
    if (l !== undefined && n !== undefined && deployed(l, stack.liveTemplate, liveParams) === false && deployed(n, stack.newTemplate, newParams) === false) continue;
    fail("G", "template-no-row", `resource ${id} differs between the live and the new template but the change set has no row for it (DeletionPolicy, UpdateReplacePolicy, UpdatePolicy, Condition, DependsOn or a hidden change)`);
  }
}

const ENVELOPE_KEYS = ["Changes", "ChangeSetName", "ChangeSetId", "StackId", "StackName", "Description", "Parameters", "CreationTime", "ExecutionStatus", "Status", "StatusReason", "NotificationARNs", "RollbackConfiguration", "Capabilities", "Tags", "ParentChangeSetId", "IncludeNestedStacks", "RootChangeSetId", "OnStackFailure", "ImportExistingResources", "StackDriftStatus", "DeploymentMode", "DeploymentConfig", "NextToken"];

/** The DescribeChangeSet top level is an allow-list too (keys seen on real previews): no notification targets, no rollback triggers, no import, no special deployment mode. */
function envelopeProblems(cs: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(cs)) if (!ENVELOPE_KEYS.includes(key)) problems.push(`unknown change-set field "${key}"`);
  const empty = (v: unknown): boolean => v === undefined || v === null;
  if (!(empty(cs.NotificationARNs) || (Array.isArray(cs.NotificationARNs) && cs.NotificationARNs.length === 0))) problems.push("NotificationARNs is not empty");
  const rb = cs.RollbackConfiguration;
  if (!(empty(rb) || (isRecord(rb) && Object.keys(rb).length === 0))) problems.push("RollbackConfiguration is not empty");
  if (!empty(cs.OnStackFailure)) problems.push("OnStackFailure is set");
  if (!(empty(cs.ImportExistingResources) || cs.ImportExistingResources === false)) problems.push("ImportExistingResources is set");
  if (!empty(cs.DeploymentMode)) problems.push("DeploymentMode is set");
  if (!(empty(cs.DeploymentConfig) || deepEqual(cs.DeploymentConfig, { Mode: "STANDARD", DisableRollback: false }))) problems.push("DeploymentConfig is not the standard one");
  return problems;
}

export interface ChangeSetInputs {
  accountId: string;
  stacks: unknown;
  images: unknown;
  tree: string;
}

export function evaluateChangeSets(run: Run, input: ChangeSetInputs): ChangeSetResult {
  const out: RowVerdict[] = [];
  const list = asArray(input.stacks, "stacks");
  const seenStacks = new Set<string>();
  const parsed: { name: string; stack: StackCtx; rows: Row[] }[] = [];
  let iam = 0;
  const stackData: { name: string; cs: Record<string, unknown>; raw: Record<string, unknown>; stack: StackCtx }[] = [];
  for (const [i, item] of list.entries()) {
    const where = `stacks[${i}]`;
    try {
      const raw = asRecord(item, where);
      onlyKeys(raw, ["stackName", "changeSet", "liveTemplate", "newTemplate", "liveParameters"], where);
      const name = asNonEmptyString(field(raw, "stackName", where), `${where}.stackName`);
      if (seenStacks.has(name)) throw new InputError("stack-duplicate", `stack ${name} has two change sets`);
      seenStacks.add(name);
      const config = run.pipeline.stacks.get(name);
      if (config === undefined) throw new InputError("stack-unknown", `stack ${name} is not in the policy`);
      const live = templateOf(field(raw, "liveTemplate", where), `${name} live template`);
      const next = templateOf(field(raw, "newTemplate", where), `${name} new template`);
      const stack: StackCtx = { config, liveTemplate: live.template, newTemplate: next.template, liveResources: live.resources, newResources: next.resources, params: new Map() };
      const cs = asRecord(field(raw, "changeSet", where), `${name} change set`);
      stackData.push({ name, cs, raw, stack });
    } catch (error) {
      run.fail("F", error instanceof InputError ? error.code : "evaluator-error", error instanceof Error ? error.message : "unreadable stack input");
    }
  }
  for (const name of run.pipeline.stacks.keys()) {
    if (!seenStacks.has(name)) run.fail("F", "stack-missing", `no change set for stack ${name}`);
  }
  for (const { name, cs, raw, stack } of stackData) {
    try {
      envelopeProblems(cs).forEach((p) => run.fail("F", "changeset-envelope", `${name}: ${p}`));
      const status = asString(field(cs, "Status", `${name} change set`), `${name} change set Status`);
      const reason = optString(cs, "StatusReason", `${name} change set`) ?? "";
      const changesRaw = field(cs, "Changes", `${name} change set`);
      const noChanges = status === "FAILED" && /didn't contain changes|did not contain changes/i.test(reason) && Array.isArray(changesRaw) && changesRaw.length === 0;
      if (status !== "CREATE_COMPLETE" && !noChanges) run.fail("F", "changeset-status", `${name}: change set status is "${status}"`);
      if (opt(cs, "NextToken") !== undefined && cs.NextToken !== null) run.fail("F", "changeset-truncated", `${name}: the change set is paginated or truncated (NextToken present)`);
      if (opt(cs, "IncludeNestedStacks") === true || (opt(cs, "ParentChangeSetId") ?? null) !== null || (opt(cs, "RootChangeSetId") ?? null) !== null) run.fail("F", "nested", `${name}: nested stacks are never routine`);
      const caps = asArray(opt(cs, "Capabilities") ?? [], `${name} Capabilities`).map((c, k) => asString(c, `${name} Capabilities[${k}]`));
      for (const cap of caps) if (!run.policy.allowedCapabilities.includes(cap)) run.fail("F", "capability", `${name}: capability ${cap} is not allowed`);
      const changes = asArray(changesRaw, `${name} Changes`);
      const rows: Row[] = [];
      for (const [k, change] of changes.entries()) {
        try {
          rows.push(parseRow(name, change, `${name} Changes[${k}]`));
        } catch (error) {
          run.fail("F", error instanceof InputError ? error.code : "evaluator-error", error instanceof Error ? error.message : "unreadable row");
        }
      }
      if (rows.length !== changes.length) continue;
      parsed.push({ name, stack, rows });
      iam += rows.filter((r) => r.type.startsWith("AWS::IAM::")).length;
      checkParameters(run, name, stack, field(cs, "Parameters", `${name} change set`), field(raw, "liveParameters", name));
    } catch (error) {
      run.fail("F", error instanceof InputError ? error.code : "evaluator-error", error instanceof Error ? error.message : "unreadable change set");
    }
  }
  run.iamRowCount = iam;
  for (const { name, stack, rows } of parsed) {
    checkTemplates(run, name, stack, rows);
    evaluateStack(run, name, stack, rows, out);
  }
  return { rows: out, verifiedDigests: new Set(run.verified.map((v) => v.digest)), verified: run.verified };
}

export function newRun(policy: Policy, pipeline: PipelineConfig, accountId: string, verified: VerifiedImage[], fail: Fail): Run {
  return { policy, pipeline, accountId, verified, stacks: new Map(), iamRowCount: 0, fail };
}

export type { Run, RowOutcome };

export function parseImages(raw: unknown, tree: string, fail: Fail): VerifiedImage[] {
  const treeTag = `tree-${tree.slice(0, 12)}`;
  const out: VerifiedImage[] = [];
  for (const [i, item] of asArray(raw, "images").entries()) {
    const where = `images[${i}]`;
    const img = asRecord(item, where);
    onlyKeys(img, ["repo", "digest", "source", "tags", "inEcr"], where);
    const repo = asNonEmptyString(field(img, "repo", where), `${where}.repo`);
    const digest = asString(field(img, "digest", where), `${where}.digest`);
    const source = asString(field(img, "source", where), `${where}.source`);
    const tags = asArray(field(img, "tags", where), `${where}.tags`).map((t, k) => asString(t, `${where}.tags[${k}]`));
    const inEcr = asBoolean(field(img, "inEcr", where), `${where}.inEcr`);
    const problems: string[] = [];
    if (!DIGEST.test(digest)) problems.push("digest is not sha256:<64 hex>");
    if (source !== "built" && source !== "reused") problems.push(`source "${source}" is neither built nor reused`);
    if (!inEcr) problems.push("not present in ECR");
    if (!tags.includes(treeTag)) problems.push(`its tags do not include ${treeTag}`);
    if (problems.length > 0) fail("I", "image-unverified", `${repo}@${digest}: ${problems.join("; ")}`);
    else out.push({ repo, digest });
  }
  return out;
}
