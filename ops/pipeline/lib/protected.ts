// The protected-resource check (L3; BETA-CLOUD-PLAN section 4 and C9), pure: the list, a set of change-set records, and what the run is, in; findings out.
// Ported in shape from the staging pack's G1/G5 (ops/staging-release/gates/lib/cs_gates.py), with the Cloud list in ops/pipeline/protected.json.
// A Replacement of True OR Conditional is a replacement: a same-name change to a custom-named resource previews as Conditional and then FAILS at execution
// after the old resource is already part of the update (scratch proof 1, 2026-11-24), so the preview must refuse it, not wave it through.
import type { ChangeRow, ChangeSetRecord } from "../types.ts";

export type ProtectedPart = "web" | "app" | "gateway" | "gatewayImages";

export interface ImageRowRule { resourceType: string; logicalIdPattern: string }

export interface ProtectedList {
  schema: 1;
  parts: Record<string, Record<string, string>>;
  statefulTypes: string[];
  dataRewrites: Record<string, string[]>;
  imageRows: ImageRowRule[];
  /** The pipeline tree's paths (Cloud commits) whose change since the live deploy makes the gateway change more than an image change. */
  imageOnlyPaths: string[];
  /** The Code paths (Code commits, judged in the Code clone) holding the gateway's infra: a change in any makes the gateway change more than an image change. */
  imageOnlyCodePaths: string[];
}

const METADATA_TYPE = "AWS::CDK::Metadata";

export function parseProtected(raw: string): ProtectedList {
  let file: Partial<ProtectedList> & Record<string, unknown>;
  try { file = JSON.parse(raw) as typeof file; } catch (error) { throw new Error(`protected.json is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  if (file.schema !== 1) throw new Error("protected.json: schema must be 1");
  const parts = file.parts;
  if (typeof parts !== "object" || parts === null || Array.isArray(parts)) throw new Error("protected.json: parts must be an object");
  for (const key of ["web", "app", "gateway"]) {
    const part = (parts as Record<string, unknown>)[key];
    if (typeof part !== "object" || part === null || Object.keys(part).length === 0) throw new Error(`protected.json: parts.${key} must list its protected resources`);
  }
  for (const [part, ids] of Object.entries(parts)) {
    for (const [id, type] of Object.entries(ids as Record<string, unknown>)) if (typeof type !== "string" || !/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/u.test(type)) throw new Error(`protected.json: parts.${part}.${id} must name a resource type`);
  }
  const text = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "");
  if (!text(file.statefulTypes)) throw new Error("protected.json: statefulTypes must be a non-empty list");
  if (!text(file.imageOnlyPaths)) throw new Error("protected.json: imageOnlyPaths must be a non-empty list");
  if (!text(file.imageOnlyCodePaths)) throw new Error("protected.json: imageOnlyCodePaths must be a non-empty list");
  const rewrites = file.dataRewrites;
  if (typeof rewrites !== "object" || rewrites === null || Array.isArray(rewrites)) throw new Error("protected.json: dataRewrites must be an object of resource type -> property names");
  for (const [type, names] of Object.entries(rewrites)) if (!text(names)) throw new Error(`protected.json: dataRewrites.${type} must be a non-empty list of property names`);
  if (!Array.isArray(file.imageRows) || file.imageRows.length === 0) throw new Error("protected.json: imageRows must be a non-empty list");
  for (const rule of file.imageRows) {
    if (typeof rule.resourceType !== "string" || typeof rule.logicalIdPattern !== "string") throw new Error("protected.json: each image row needs resourceType and logicalIdPattern");
    new RegExp(rule.logicalIdPattern, "u");
  }
  return file as unknown as ProtectedList;
}

/** A replacement for the check: True, and also Conditional (it may replace, and a named resource then fails half way). */
export function isReplacement(row: ChangeRow): boolean {
  return row.replacement === "True" || row.replacement === "Conditional";
}

export interface ProtectedOptions {
  /** The gateway infra is the same as the deployed one: only the image rows (and the CDK metadata line) may change. */
  imageOnly: boolean;
}

export interface ProtectedResult { failures: string[]; notes: string[]; checkedRows: number }

function isImageRow(list: ProtectedList, row: ChangeRow): boolean {
  return row.action === "Modify" && list.imageRows.some((rule) => rule.resourceType === row.resourceType && new RegExp(rule.logicalIdPattern, "u").test(row.logicalId));
}

export function checkProtected(list: ProtectedList, records: readonly ChangeSetRecord[], options: ProtectedOptions): ProtectedResult {
  const failures: string[] = [];
  const notes: string[] = [];
  let checkedRows = 0;
  const stateful = new Set(list.statefulTypes);
  for (const record of records) {
    const listed = list.parts[record.part] ?? {};
    for (const row of record.rows) {
      checkedRows += 1;
      if (row.resourceType === METADATA_TYPE) continue;
      const where = `${record.part}/${row.logicalId} (${row.resourceType})`;
      const isListed = Object.hasOwn(listed, row.logicalId);
      const isStateful = stateful.has(row.resourceType);
      if (isListed || isStateful) {
        const why = isListed ? "on the protected list" : `a ${row.resourceType} (stateful type)`;
        if (row.action === "Remove") failures.push(`${where} would be removed; it is ${why}`);
        else if (row.action === "Dynamic") failures.push(`${where} has a Dynamic change (CloudFormation cannot say whether it is replaced); it is ${why}`);
        else if (isReplacement(row)) failures.push(`${where} would be replaced (Replacement=${row.replacement}); it is ${why}`);
        const rewrites = list.dataRewrites[row.resourceType];
        if (rewrites !== undefined && row.action === "Modify" && !isReplacement(row)) {
          if (row.changedProperties === undefined) failures.push(`${where}: the change set gave no property details, so an in-place data rewrite cannot be ruled out (failing closed); it is ${why}`);
          else for (const name of row.changedProperties) if (name.startsWith("Properties:") && rewrites.includes(name.slice("Properties:".length))) failures.push(`${where} changes ${name.slice("Properties:".length)} in place, which rewrites or drops its data; it is ${why}`);
        }
        if (isListed && listed[row.logicalId] !== row.resourceType) failures.push(`${where} is listed with the type ${listed[row.logicalId]}: the list and the template disagree, fix protected.json`);
      }
      if (options.imageOnly && record.part === "gateway" && !isImageRow(list, row)) failures.push(`${where}: ${row.action} is not one of the image rows, but the gateway infra is unchanged from the deployed one (image-only change)`);
    }
    if (options.imageOnly && record.part === "gateway") notes.push("gateway: image-only change, rows limited to the known image rows");
  }
  return { failures, notes, checkedRows };
}
