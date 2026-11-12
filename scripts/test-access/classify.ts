// Turns one service's entry in AWS's machine-readable Service Authorization Reference (https://servicereference.us-east-1.amazonaws.com/v1/<prefix>/<prefix>.json)
// into the customer test account's per-action scoping rows: for every action that changes something, which of the three IAM scoping tools can confine it to a run's own resources.
//
//   tag      aws:RequestTag/rovara-run on create, aws:ResourceTag/rovara-run on write and delete (the run tag is a session tag; see test-access-policy.ts)
//   name     the resource ARN carries a name the caller chooses, so an ARN condition on the run's name prefix confines the action
//   signer   IAM cannot confine it to a run: only the account signer's creation record (lane TA4) guards it
//
// Pure functions, no I/O: tests/unit/test-access-classify.test.ts runs them on fixtures shaped like the reference, and gen-action-scoping.ts runs them on the real files.
// The kind (create, write, delete) is a VERB heuristic: the reference only says "write". The signer classifies for itself in TA4; this table is for the policy text and the account page.

import { leadingNamePlaceholder, type ScopingCoverage, type ScopingGuard, type ScopingKind, type ScopingRow } from "../../packages/cloud-contracts/src/test-access-scoping.js";

/** The shape of the reference this file reads (only the fields it uses). */
export interface ReferenceAction {
  readonly Name: string;
  readonly ActionConditionKeys?: readonly string[];
  readonly Annotations?: { readonly Properties?: { readonly IsList?: boolean; readonly IsPermissionManagement?: boolean; readonly IsTaggingOnly?: boolean; readonly IsWrite?: boolean } };
  readonly Resources?: readonly { readonly Name: string; readonly ConditionKeys?: readonly string[] }[];
}
export interface ReferenceResource {
  readonly Name: string;
  readonly ARNFormats?: readonly string[];
  readonly ConditionKeys?: readonly string[];
}
export interface ReferenceService {
  readonly Name: string;
  readonly Actions: readonly ReferenceAction[];
  readonly Resources?: readonly ReferenceResource[];
}

/**
 * Resource types where the reference lists aws:ResourceTag but the tag cannot confine a run, with the reason. S3: tag conditions on a bucket apply only to a bucket whose ABAC setting is enabled
 * (a per-bucket opt-in, off by default: https://docs.aws.amazon.com/AmazonS3/latest/userguide/buckets-tagging-enable-abac.html), and an object's tags are not the run's tag. The bucket name carries the scope instead.
 */
export const TAG_UNUSABLE: Readonly<Record<string, ReadonlySet<string>>> = {
  s3: new Set(["bucket", "object", "accesspointobject", "accesspoint"]),
};

const DELETE_VERB = /^(Delete|Remove|Terminate|Deregister|Destroy|Purge|Unregister|Uninstall)/u;
const CREATE_VERB = /^(Create|Register|Allocate|Provision|Import|Launch|Run[A-Z]|Clone|Copy|Subscribe|Purchase|Request[A-Z])/u;

function coverage(flags: readonly boolean[]): ScopingCoverage {
  if (flags.length === 0 || flags.every((flag) => !flag)) return "none";
  return flags.every(Boolean) ? "all" : "some";
}

export function kindOf(action: ReferenceAction): ScopingKind | undefined {
  const properties = action.Annotations?.Properties ?? {};
  if (properties.IsPermissionManagement === true) return "permissions";
  if (properties.IsTaggingOnly === true) return "tagging";
  if (properties.IsList === true) return undefined;
  if (properties.IsWrite !== true) return undefined;
  if (DELETE_VERB.test(action.Name)) return "delete";
  const requestTagged = (action.ActionConditionKeys ?? []).some((key) => key.startsWith("aws:RequestTag/"));
  return CREATE_VERB.test(action.Name) || requestTagged ? "create" : "write";
}

/** The row for an action, or undefined when it only reads or lists (reads are not scoped: any resource in the account may be read, within the Region). */
export function scopingRow(service: string, action: ReferenceAction, resources: ReadonlyMap<string, ReferenceResource>): ScopingRow | undefined {
  const kind = kindOf(action);
  if (kind === undefined) return undefined;
  const unusable = TAG_UNUSABLE[service] ?? new Set<string>();
  const entries = action.Resources ?? [];
  const keysOf = (entry: { readonly Name: string; readonly ConditionKeys?: readonly string[] }): readonly string[] => entry.ConditionKeys ?? resources.get(entry.Name)?.ConditionKeys ?? [];
  const requestTag = (action.ActionConditionKeys ?? []).some((key) => key.startsWith("aws:RequestTag/")) || entries.some((entry) => keysOf(entry).some((key) => key.startsWith("aws:RequestTag/")));
  const resourceTag = coverage(entries.map((entry) => !unusable.has(entry.Name) && keysOf(entry).some((key) => key.startsWith("aws:ResourceTag/") || key.startsWith(`${service}:ResourceTag/`))));
  const name = coverage(entries.map((entry) => (resources.get(entry.Name)?.ARNFormats ?? []).some((format) => leadingNamePlaceholder(format) !== undefined)));
  let guard: ScopingGuard = "signer";
  if (kind === "create") {
    if (requestTag) guard = "tag";
    else if (name === "all") guard = "name";
  } else if (kind === "tagging") {
    // Tagging an existing resource of another run is refusable, but an untagged shared resource looks the same as a resource that is being created: IAM cannot tell them apart.
    guard = name === "all" ? "name" : "signer";
  } else if (resourceTag === "all") guard = "tag";
  else if (name === "all") guard = "name";
  return { kind, guard, requestTag, resourceTag, name };
}

/** An ARN format as a pattern for the run's names: `{{Partition}}`, `{{Region}}` and `{{AccountId}}` stay tokens for the policy builder, the first (name) placeholder becomes `{{Name}}`, every other placeholder `*`. */
export function nameArnPattern(format: string): string | undefined {
  const leading = leadingNamePlaceholder(format);
  if (leading === undefined) return undefined;
  const withTokens = format.replace("${Partition}", "{{Partition}}").replace("${Region}", "{{Region}}").replace("${Account}", "{{AccountId}}");
  const named = withTokens.replace(`\${${leading}}`, "{{Name}}");
  return named.replace(/\$\{[A-Za-z0-9]+\}/gu, "*");
}

export interface ServiceScoping {
  readonly rows: Readonly<Record<string, ScopingRow>>;
  /** The ARN patterns of every resource type of the service whose ARN starts with a caller-chosen name: where the run's name goes, an IAM Resource pattern confines an action to the run's own resources. */
  readonly nameArns: readonly string[];
}

export function scopingRows(service: ReferenceService, prefix: string): ServiceScoping {
  const resources = new Map((service.Resources ?? []).map((resource) => [resource.Name, resource]));
  const rows: Record<string, ScopingRow> = {};
  for (const action of service.Actions) {
    const row = scopingRow(prefix, action, resources);
    if (row !== undefined) rows[action.Name] = row;
  }
  const patterns = new Set<string>();
  for (const resource of service.Resources ?? []) {
    for (const format of resource.ARNFormats ?? []) {
      const pattern = nameArnPattern(format);
      // A reference lists the resources a service's actions also touch (SSM lists IAM roles and S3 buckets): only the service's own ARNs belong to it.
      if (pattern !== undefined && pattern.split(":")[2] === prefix) patterns.add(pattern);
    }
  }
  return { rows, nameArns: [...patterns].sort() };
}
