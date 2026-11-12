// The customer test account's per-action scoping table (lane TA1): for every AWS action that changes something, whether IAM can confine it to the run's own resources by tag, by name, or not at all.
// The data is generated (`generated/test-access-scoping.ts`, made by `scripts/test-access/gen-action-scoping.ts` from AWS's Service Authorization Reference); this file holds the row shape, the compact codes the data is stored under, and the lookups.
//
//   tag      create: aws:RequestTag/rovara-run must equal the session's tag. write, delete: aws:ResourceTag/rovara-run must equal the session's tag (an untagged resource counts as not ours).
//   name     the resource ARN carries a name the caller picks, so the name must start with the run's prefix `rv-<run>-`.
//   signer   IAM cannot confine the action to one run: only the account signer's creation record (TA4) guards it. IAM still limits it to the service and the Region.
//
// Reads and lists are not in the table: any resource of the account may be read inside the connection's Region. Browser-safe: no import but the generated data.
import { TEST_ACCESS_SCOPING, TEST_ACCESS_SCOPING_NAME_ARNS, TEST_ACCESS_SCOPING_SERVICE_KEYS } from "./generated/test-access-scoping.js";

export const SCOPING_KINDS = ["create", "write", "delete", "tagging", "permissions"] as const;
export type ScopingKind = (typeof SCOPING_KINDS)[number];
export const SCOPING_GUARDS = ["tag", "name", "signer"] as const;
export type ScopingGuard = (typeof SCOPING_GUARDS)[number];
/** all: every resource type the action lists supports it; some: only a part; none: no resource type does, or the action lists none. */
export type ScopingCoverage = "all" | "some" | "none";

export interface ScopingRow {
  readonly kind: ScopingKind;
  readonly guard: ScopingGuard;
  /** aws:RequestTag/<key> can be required when the call creates the resource. */
  readonly requestTag: boolean;
  /** aws:ResourceTag/<key> can be tested on the resource the call acts on. */
  readonly resourceTag: ScopingCoverage;
  /** The resource's ARN carries a caller-chosen name that a prefix condition can test. */
  readonly name: ScopingCoverage;
}

/** A name placeholder is one the caller picks: `${QueueName}`, `${BucketName}`; not `${Id}`, `${Uuid}`, `${Token}`, `${Alias}`, nor the ARN's own partition, Region and account. */
function isNamePlaceholder(placeholder: string): boolean {
  return /Name$/u.test(placeholder) && !/^(Partition|Region|Account)/u.test(placeholder);
}

/** The resource part of an ARN format (after `arn:${Partition}:svc:${Region}:${Account}:`), or undefined when the format has no such shape. */
export function arnResourcePart(format: string): string | undefined {
  const parts = format.split(":");
  if (parts.length < 6) return undefined;
  return parts.slice(5).join(":");
}

/** The first placeholder of the resource part, when it is a name. Only that one is replaced by the run's prefix; the rest become `*`. */
export function leadingNamePlaceholder(format: string): string | undefined {
  const resource = arnResourcePart(format);
  if (resource === undefined) return undefined;
  const first = /\$\{([A-Za-z0-9]+)\}/u.exec(resource);
  return first !== null && isNamePlaceholder(first[1] ?? "") ? first[1] : undefined;
}

const KIND_CODE: Record<ScopingKind, string> = { create: "c", write: "w", delete: "d", tagging: "t", permissions: "p" };
const GUARD_CODE: Record<ScopingGuard, string> = { tag: "t", name: "n", signer: "s" };
const COVERAGE_CODE: Record<ScopingCoverage, string> = { all: "a", some: "p", none: "-" };
const invert = <T extends string>(table: Record<T, string>): Record<string, T> => Object.fromEntries(Object.entries(table).map(([key, code]) => [code, key])) as Record<string, T>;
const KIND_OF_CODE = invert(KIND_CODE);
const GUARD_OF_CODE = invert(GUARD_CODE);
const COVERAGE_OF_CODE = invert(COVERAGE_CODE);

/** One row as a 5-character code: kind, guard, request tag (q or -), resource tag coverage, name coverage. The generated table groups action names under these codes. */
export function encodeScopingRow(row: ScopingRow): string {
  return `${KIND_CODE[row.kind]}${GUARD_CODE[row.guard]}${row.requestTag ? "q" : "-"}${COVERAGE_CODE[row.resourceTag]}${COVERAGE_CODE[row.name]}`;
}

export function decodeScopingRow(code: string): ScopingRow | undefined {
  const kind = KIND_OF_CODE[code[0] ?? ""];
  const guard = GUARD_OF_CODE[code[1] ?? ""];
  const resourceTag = COVERAGE_OF_CODE[code[3] ?? ""];
  const name = COVERAGE_OF_CODE[code[4] ?? ""];
  if (code.length !== 5 || kind === undefined || guard === undefined || resourceTag === undefined || name === undefined || (code[2] !== "q" && code[2] !== "-")) return undefined;
  return { kind, guard, requestTag: code[2] === "q", resourceTag, name };
}

export interface ScopedAction extends ScopingRow {
  readonly service: string;
  readonly action: string;
}

/** The IAM service prefix (`sqs`, `cognito-idp`) of a Rovara local AWS service key, or undefined for a key the table could not map to a reference (listed in TEST_ACCESS_SCOPING_UNMAPPED). */
export function iamPrefixOfServiceKey(key: string): string | undefined {
  return Object.hasOwn(TEST_ACCESS_SCOPING_SERVICE_KEYS, key) ? TEST_ACCESS_SCOPING_SERVICE_KEYS[key] : undefined;
}

/** Every changing action of an IAM service prefix, in action-name order; empty for a prefix the table does not hold. */
export function scopedActionsOf(prefix: string): readonly ScopedAction[] {
  if (!Object.hasOwn(TEST_ACCESS_SCOPING, prefix)) return [];
  const grouped = TEST_ACCESS_SCOPING[prefix] ?? {};
  const rows: ScopedAction[] = [];
  for (const [code, actions] of Object.entries(grouped)) {
    const row = decodeScopingRow(code);
    if (row === undefined) continue;
    for (const action of actions) rows.push({ ...row, service: prefix, action });
  }
  return rows.sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));
}

/** The row of one action, `sqs:CreateQueue` style (`service` is the IAM prefix). Undefined for an action that only reads or lists, or one the table does not know: a caller must treat an unknown action as signer-only. */
export function scopingOfAction(service: string, action: string): ScopingRow | undefined {
  if (!Object.hasOwn(TEST_ACCESS_SCOPING, service)) return undefined;
  for (const [code, actions] of Object.entries(TEST_ACCESS_SCOPING[service] ?? {})) {
    if (actions.includes(action)) return decodeScopingRow(code);
  }
  return undefined;
}

export const TEST_ACCESS_SCOPING_SERVICES: readonly string[] = Object.keys(TEST_ACCESS_SCOPING).sort();

/** The ARN patterns of the resource types the service's name-guarded actions act on: `{{Name}}` where the run's name goes, `{{Partition}}`, `{{Region}}` and `{{AccountId}}` tokens. Empty for a service with no name-guarded action. */
export function nameArnPatternsOf(prefix: string): readonly string[] {
  return Object.hasOwn(TEST_ACCESS_SCOPING_NAME_ARNS, prefix) ? (TEST_ACCESS_SCOPING_NAME_ARNS[prefix] ?? []) : [];
}
