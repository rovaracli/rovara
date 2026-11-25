/**
 * IAM Access Analyzer validation of every IAM policy a Cloud app synthesizes (the opt-in `--aws` step of the Cloud IAM gate, PH-S3-IAM-FIX).
 *
 * The local boundary check (cloud-boundary-check.ts) knows what a role may do; it does not know whether each condition is written the way IAM documents it. The analyzer does
 * (`aws accessanalyzer validate-policy`: read-only, no resource is created): the first read-only pass over RovaraCloudReleaseActions found StringLike on the ARN key ecs:cluster
 * (SECURITY_WARNING STRING_LIKE_OPERATOR_WITH_ARN_CONDITION_KEYS) and Bool on the String key ecs:enable-execute-command (WARNING TYPE_MISMATCH), which no template test, cfn-lint or
 * change set shows. This file only reads templates and judges findings; the AWS call is injected (infra/bin/cloud-iam-validate.ts makes it), so tests need no AWS.
 *
 * Covered: managed and inline policies of AWS::IAM::Policy / ManagedPolicy, a role's inline Policies, and role trust policies. NOT covered yet: bucket, key and queue (resource)
 * policies, and AWS::IAM::RolePolicy; a stack that grants through those is not validated by this step.
 *
 * A template's intrinsics are replaced by well-formed sample values (the analyzer needs a valid ARN, not the real one): findings about a sample (REDUNDANT_RESOURCE between two
 * parameters that both got the same sample) are suggestions and never block.
 */
import type { CfnTemplate } from "./cloud-boundary-check.js";

export interface PolicyScope { readonly partition: string; readonly region: string; readonly account: string }

/** `identity`: a managed or inline policy (IDENTITY_POLICY, which also covers a permissions boundary). `trust`: a role's trust policy (AWS::IAM::AssumeRolePolicyDocument). */
export interface PolicyFile { readonly name: string; readonly kind: "identity" | "trust"; readonly document: unknown }

export interface Finding { readonly findingType: string; readonly issueCode: string; readonly findingDetails: string; readonly line?: number }

/** Finding types that fail the gate, and the one WARNING issue code that is a wrong condition operator (an operator the key's documented type does not take). */
export const DEFAULT_BLOCKING: readonly string[] = ["ERROR", "SECURITY_WARNING", "TYPE_MISMATCH"];

/** A finding blocks when its type or its issue code is in the list. */
export function blockingFindings(findings: readonly Finding[], blocking: readonly string[] = DEFAULT_BLOCKING): Finding[] {
  return findings.filter((f) => blocking.includes(f.findingType) || blocking.includes(f.issueCode));
}

type Json = unknown;

function sample(template: CfnTemplate, scope: PolicyScope, name: string): string {
  const parameter = (template.Parameters as Record<string, { Default?: unknown; Description?: string } | undefined> | undefined)?.[name];
  if (typeof parameter?.Default === "string" && parameter.Default !== "") return parameter.Default;
  if (/bucket/iu.test(name)) return "sample-bucket-name";
  if (/account/iu.test(name)) return "210987654321";
  if (/connection/iu.test(name)) return `arn:${scope.partition}:codeconnections:${scope.region}:${scope.account}:connection/00000000-0000-0000-0000-000000000000`;
  if (/role|arn/iu.test(name)) return `arn:${scope.partition}:iam::${scope.account}:role/sample-${name}`;
  return `sample-${name}`;
}

/** Replaces Ref, Fn::Join, Fn::GetAtt, Fn::Sub and Fn::ImportValue with well-formed values; any other intrinsic stays (and is reported by unresolvedIntrinsics). */
export function resolveForValidation(template: CfnTemplate, scope: PolicyScope, value: Json): Json {
  const go = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(go);
    if (typeof v !== "object" || v === null) return v;
    const entries = Object.entries(v as Record<string, Json>);
    if (entries.length === 1) {
      const [key, arg] = entries[0]!;
      if (key === "Ref") {
        const pseudo: Record<string, string> = { "AWS::Partition": scope.partition, "AWS::Region": scope.region, "AWS::AccountId": scope.account };
        return pseudo[arg as string] ?? (template.Parameters !== undefined && (template.Parameters)[arg as string] !== undefined ? sample(template, scope, arg as string) : `arn:${scope.partition}:iam::${scope.account}:role/sample-${String(arg)}`);
      }
      if (key === "Fn::Join") return (go((arg as [string, Json[]])[1]) as string[]).join((arg as [string, Json[]])[0]);
      if (key === "Fn::GetAtt") return `arn:${scope.partition}:iam::${scope.account}:role/sample-${String((arg as Json[])[0])}`;
      if (key === "Fn::ImportValue") return `sample-import`;
      if (key === "Fn::Sub") return String(Array.isArray(arg) ? arg[0] : arg).replace(/\$\{([^}]+)\}/gu, (_m, name: string) => String(go({ Ref: name })));
    }
    return Object.fromEntries(entries.map(([k, x]) => [k, go(x)]));
  };
  return go(value);
}

/** Every `Fn::`/`Ref` left in a document: the document would be validated with text the analyzer cannot read. */
export function unresolvedIntrinsics(document: Json): string[] {
  const found: string[] = [];
  const go = (v: Json): void => {
    if (Array.isArray(v)) v.forEach(go);
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v as Record<string, Json>)) { if (k === "Ref" || k.startsWith("Fn::")) found.push(k); go(x); }
  };
  go(document);
  return found;
}

/** The identity policies (managed and inline, which includes a permissions boundary) and role trust policies of one stack's template, intrinsics replaced. */
export function policyFiles(stackName: string, template: CfnTemplate, scope: PolicyScope): PolicyFile[] {
  const files: PolicyFile[] = [];
  for (const [id, resource] of Object.entries(template.Resources as Record<string, { Type: string; Properties?: Record<string, Json> }>)) {
    const properties = resource.Properties ?? {};
    const label = `${stackName}/${id}`;
    if (resource.Type === "AWS::IAM::ManagedPolicy" || resource.Type === "AWS::IAM::Policy") files.push({ name: label, kind: "identity", document: resolveForValidation(template, scope, properties.PolicyDocument) });
    if (resource.Type === "AWS::IAM::Role") {
      files.push({ name: `${label}/trust`, kind: "trust", document: resolveForValidation(template, scope, properties.AssumeRolePolicyDocument) });
      for (const inline of (properties.Policies ?? []) as Array<{ PolicyName?: string; PolicyDocument: Json }>) files.push({ name: `${label}/inline/${inline.PolicyName ?? "policy"}`, kind: "identity", document: resolveForValidation(template, scope, inline.PolicyDocument) });
    }
  }
  return files;
}

export type Validator = (file: PolicyFile) => Finding[];

export interface ValidationResult { readonly name: string; readonly findings: Finding[]; readonly blocking: Finding[] }

/** Validates every file; the run fails when any result has a blocking finding or any document still holds an intrinsic. */
export function validateAll(files: readonly PolicyFile[], validator: Validator, blocking: readonly string[] = DEFAULT_BLOCKING): ValidationResult[] {
  // Nothing to validate is a failed run, never a pass: an empty synth or a mistyped context would otherwise print PASS having checked nothing.
  if (files.length === 0) throw new Error("no IAM policy documents were found to validate (empty synth, or a mistyped --context / LIGHT_GATE_AWS_SHAPES): nothing was checked, so this is not a pass");
  return files.map((file) => {
    const left = unresolvedIntrinsics(file.document);
    if (left.length > 0) throw new Error(`${file.name}: not validated: the document still holds ${[...new Set(left)].join(", ")}`);
    const findings = validator(file);
    return { name: file.name, findings, blocking: blockingFindings(findings, blocking) };
  });
}

/** Reads `aws accessanalyzer validate-policy --output json` (stdout; a wrapper may print its own notes before the JSON). */
export function parseFindings(stdout: string): Finding[] {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`validate-policy printed no JSON: ${stdout.slice(0, 200)}`);
  const parsed = JSON.parse(stdout.slice(start)) as { findings?: Array<{ findingType: string; issueCode: string; findingDetails: string; locations?: Array<{ span?: { start?: { line?: number } } }> }> };
  if (!Array.isArray(parsed.findings)) throw new Error("validate-policy printed no findings list");
  return parsed.findings.map((f) => ({ findingType: f.findingType, issueCode: f.issueCode, findingDetails: f.findingDetails, ...(f.locations?.[0]?.span?.start?.line === undefined ? {} : { line: f.locations[0].span.start.line }) }));
}

/** The validate-policy arguments for one document (a file path stands in for it: the caller writes the document there). */
export function validatePolicyArguments(kind: PolicyFile["kind"], documentFile: string): string[] {
  return [
    "accessanalyzer", "validate-policy",
    ...(kind === "trust" ? ["--policy-type", "RESOURCE_POLICY", "--validate-policy-resource-type", "AWS::IAM::AssumeRolePolicyDocument"] : ["--policy-type", "IDENTITY_POLICY"]),
    "--policy-document", `file://${documentFile}`, "--output", "json",
  ];
}
