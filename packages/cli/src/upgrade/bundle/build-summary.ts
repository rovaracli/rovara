// What the approver is shown before anything is written: the settings the build used (a secret as its hash), the hash of the result, and per stack WHICH resources change against the
// stack as it is deployed now, with the properties that differ. Network, IAM, KMS and resource-policy changes are listed first and marked. Every line is made from fixed words, counts and
// names from the templates' own logical ids and types that look like ids; nothing from a file is printed raw.
import { BUILT_PARTS, accessTemplatesAgree, canonicalJson, redactedSynthSettings, type BuiltPart, type SynthSettings } from "@agentx/contracts";
import type { BuiltBundle } from "./build-at-approval.js";

export type ChangeCategory = "NETWORK" | "IAM" | "KMS" | "RESOURCE POLICY";
export interface ResourceChange {
  id: string;
  type: string;
  change: "added" | "removed" | "changed";
  /** For a changed resource: the top-level keys that differ (Properties.<name>, DependsOn, ...). */
  properties: string[];
  categories: ChangeCategory[];
}
export interface StackDiff {
  part: BuiltPart;
  /** "new": no stack is deployed (this path only updates stacks, so the deployer will refuse it). */
  status: "unchanged" | "changed" | "new" | "unreadable";
  added: number;
  removed: number;
  changed: number;
  iamChanged: boolean;
  parametersAdded: number;
  parametersRemoved: number;
  items: ResourceChange[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const names = (value: unknown): string[] => (isObject(value) ? Object.keys(value) : []);
/** A name from a template is shown only if it looks like one. */
const shown = (id: string): string => (/^[A-Za-z0-9:.]{1,128}$/.test(id) ? id : "?");

const CATEGORY_PATTERNS: ReadonlyArray<[ChangeCategory, RegExp]> = [
  ["IAM", /^AWS::IAM::/],
  ["NETWORK", /^AWS::(?:EC2::(?:SecurityGroup|SecurityGroupIngress|SecurityGroupEgress|NetworkAcl|NetworkAclEntry|SubnetNetworkAclAssociation|Route|RouteTable|SubnetRouteTableAssociation|VPC|VPCCidrBlock|VPCEndpoint|VPCEndpointService|VPCGatewayAttachment|VPCPeeringConnection|Subnet|InternetGateway|NatGateway|EIP|TransitGateway\w*|PrefixList)|Route53Resolver::|NetworkFirewall::|ElasticLoadBalancingV2::|WAFv2::|ApiGatewayV2::VpcLink|PrivateLink)/],
  ["KMS", /^AWS::KMS::/],
  ["RESOURCE POLICY", /^AWS::(?:S3::BucketPolicy|SQS::QueuePolicy|SNS::TopicPolicy|Lambda::Permission|Lambda::Url|SecretsManager::ResourcePolicy|ECR::\w*Policy|ECR::RegistryPolicy|S3::AccessPoint|Events::EventBusPolicy)$/],
];
const categoriesOf = (type: string): ChangeCategory[] => CATEGORY_PATTERNS.filter(([, pattern]) => pattern.test(type)).map(([category]) => category);

/** The top-level keys of a resource that differ: `Properties.<name>` for properties, the key itself for the rest. */
function differingKeys(before: Json, after: Json): string[] {
  const keys = new Set<string>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "Properties") {
      const b = isObject(before.Properties) ? before.Properties : {};
      const a = isObject(after.Properties) ? after.Properties : {};
      for (const property of new Set([...Object.keys(b), ...Object.keys(a)])) if (canonicalJson(b[property]) !== canonicalJson(a[property])) keys.add(`Properties.${shown(property)}`);
    } else if (canonicalJson(before[key]) !== canonicalJson(after[key])) keys.add(shown(key));
  }
  return [...keys].sort();
}

export function diffStack(part: BuiltPart, built: string, deployed: string | undefined): StackDiff {
  const none = { added: 0, removed: 0, changed: 0, iamChanged: false, parametersAdded: 0, parametersRemoved: 0, items: [] as ResourceChange[] };
  if (deployed === undefined) return { part, status: "new", ...none };
  let before: Json;
  let after: Json;
  try {
    before = JSON.parse(deployed) as Json;
    after = JSON.parse(built) as Json;
    if (!isObject(before) || !isObject(after)) throw new Error("not a template");
  } catch {
    return { part, status: "unreadable", ...none };
  }
  const was = isObject(before.Resources) ? before.Resources : {};
  const will = isObject(after.Resources) ? after.Resources : {};
  const typeOf = (id: string): string => {
    const type = (isObject(will[id]) ? will[id].Type : undefined) ?? (isObject(was[id]) ? was[id].Type : undefined);
    return typeof type === "string" ? shown(type) : "?";
  };
  const items: ResourceChange[] = [];
  for (const id of Object.keys(will).sort()) {
    if (!(id in was)) items.push({ id: shown(id), type: typeOf(id), change: "added", properties: [], categories: categoriesOf(typeOf(id)) });
    else if (canonicalJson(was[id]) !== canonicalJson(will[id])) items.push({ id: shown(id), type: typeOf(id), change: "changed", properties: isObject(was[id]) && isObject(will[id]) ? differingKeys(was[id], will[id]) : [], categories: categoriesOf(typeOf(id)) });
  }
  for (const id of Object.keys(was).sort()) if (!(id in will)) items.push({ id: shown(id), type: typeOf(id), change: "removed", properties: [], categories: categoriesOf(typeOf(id)) });
  const parametersAdded = names(after.Parameters).filter((name) => !names(before.Parameters).includes(name)).length;
  const parametersRemoved = names(before.Parameters).filter((name) => !names(after.Parameters).includes(name)).length;
  const same = items.length === 0 && parametersAdded === 0 && parametersRemoved === 0 && canonicalJson({ ...before, Resources: undefined, Parameters: undefined }) === canonicalJson({ ...after, Resources: undefined, Parameters: undefined });
  return {
    part, status: same ? "unchanged" : "changed",
    added: items.filter((item) => item.change === "added").length, removed: items.filter((item) => item.change === "removed").length, changed: items.filter((item) => item.change === "changed").length,
    iamChanged: items.some((item) => item.categories.includes("IAM")), parametersAdded, parametersRemoved, items,
  };
}

export interface BuildSummary {
  diffs: StackDiff[];
  /** The access stack, compared the way the deployer compares it. A build whose access stack is not the deployed one cannot be deployed by the deployer. */
  accessAgrees: boolean;
  /** Stacks that differ although the installed release is the one being approved: the recorded settings do not reproduce what is deployed. */
  drift: BuiltPart[];
  lines: string[];
}

const MAX_ITEMS_PER_STACK = 60;
const MARK: Record<ResourceChange["change"], string> = { added: "+", removed: "-", changed: "~" };

export function summariseBuild(input: { built: BuiltBundle; settings: SynthSettings; deployed: ReadonlyMap<BuiltPart, string | undefined>; confined: boolean; sandbox: string; installedVersion?: string }): BuildSummary {
  const { built, settings, deployed } = input;
  const diffs: StackDiff[] = [];
  for (const part of BUILT_PARTS) {
    const entry = built.manifest.templates.find((template) => template.part === part);
    if (entry === undefined) continue;
    const text = built.files.find((file) => file.file === entry.file)?.body.toString("utf8") ?? "";
    diffs.push(diffStack(part, text, deployed.get(part)));
  }
  const lines: string[] = [
    `Built the templates for ${settings.env} (${settings.region}) from release ${built.manifest.version}, with the build settings recorded for this install:`,
  ];
  const sensitive = diffs.flatMap((diff) => diff.items.filter((item) => item.categories.length > 0).map((item) => ({ diff, item })));
  if (sensitive.length > 0) {
    lines.push("", `  *** REVIEW FIRST: ${String(sensitive.length)} network, IAM, KMS or resource-policy change${sensitive.length === 1 ? "" : "s"} ***`);
    for (const { diff, item } of sensitive) lines.push(`  *** ${item.categories.join("+")} ${diff.part}: ${MARK[item.change]} ${item.id} (${item.type})${item.properties.length === 0 ? "" : ` ${item.properties.join(", ")}`}`);
    lines.push("");
  }
  const shownSettings = redactedSynthSettings(settings);
  const contextKeys = Object.keys(shownSettings.context).sort();
  if (contextKeys.length === 0) lines.push("  (no settings beyond the install's edition, environment, region and identity mode)");
  for (const key of contextKeys) lines.push(`  ${key} = ${shownSettings.context[key] as string}`);
  lines.push(`  settings hash ${built.settingsSha256}`, `  kit hash      ${built.kitSha256}`, `  result hash   ${built.resultSha256}`);
  for (const diff of diffs) {
    const detail = diff.status === "changed" ? ` (${String(diff.added)} added, ${String(diff.removed)} removed, ${String(diff.changed)} changed; ${String(diff.parametersAdded)} parameters added, ${String(diff.parametersRemoved)} removed)` : "";
    lines.push(`  ${diff.part}: ${diff.status}${detail}`);
    for (const item of diff.items.slice(0, MAX_ITEMS_PER_STACK)) lines.push(`    ${MARK[item.change]} ${item.id} (${item.type})${item.properties.length === 0 ? "" : `: ${item.properties.join(", ")}`}`);
    if (diff.items.length > MAX_ITEMS_PER_STACK) lines.push(`    ... and ${String(diff.items.length - MAX_ITEMS_PER_STACK)} more (write the whole build to a folder with --write-build to read them all)`);
  }
  for (const pkg of built.manifest.packages) lines.push(`  package ${shown(pkg.assetId)}: ${String(pkg.bytes)} bytes, sha256 ${pkg.sha256}`);
  const builtAccess = built.files.find((file) => file.file === "built/templates/access.template.json")?.body.toString("utf8");
  const deployedAccess = deployed.get("access");
  const accessAgrees = builtAccess !== undefined && deployedAccess !== undefined && accessTemplatesAgree(builtAccess, deployedAccess);
  if (!accessAgrees) lines.push("  The access stack differs from the deployed one (or could not be read). The deployer never changes the access stack, so it would refuse this build: your administrators deploy the access stack first.");
  // The installed release is the one being approved, so a stack that still differs is not an upgrade: the recorded settings do not reproduce what was deployed.
  const drift = input.installedVersion === built.manifest.version ? diffs.filter((diff) => diff.status === "changed").map((diff) => diff.part) : [];
  if (drift.length > 0) lines.push(`  DRIFT: this install already runs release ${built.manifest.version}, yet ${drift.join(", ")} differ${drift.length === 1 ? "s" : ""} from what is deployed. The build settings recorded for this install do not reproduce the deployed stacks (or they were changed by hand). Check them before approving: this build would change those stacks to match the settings.`);
  lines.push(`  The kit ran inside ${input.sandbox}.`);
  // SK-4 minor 2: the kit turns CDK's template validation off (its rule files are read from beside CDK's own source, which a bundled kit does not have). The release ran the validation on its own templates; a value only this install has is not validated here.
  lines.push("  CDK's own template validation was not run for this build (the release ran it on its own templates); a value only this install has is checked by the approval above, not by CDK.");
  if (!input.confined) lines.push("  Note: this Node cannot confine the kit's file access itself; the sandbox above still denied it the network and writes outside its own directories.");
  return { diffs, accessAgrees, drift, lines };
}
