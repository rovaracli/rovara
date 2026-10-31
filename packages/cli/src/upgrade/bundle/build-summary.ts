// What the approver is shown before anything is written: the settings the build used (a secret as its hash), the hash of the result, and per stack what changes
// against the stack as it is deployed now. Every line is made from fixed words, counts and names from the templates' own logical ids; nothing from a file is printed raw.
import { BUILT_PARTS, accessTemplatesAgree, canonicalJson, redactedSynthSettings, type BuiltPart, type SynthSettings } from "@agentx/contracts";
import type { BuiltBundle } from "./build-at-approval.js";

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
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const names = (value: unknown): string[] => (isObject(value) ? Object.keys(value) : []);
/** A logical id is shown only if it looks like one; the text of a template never reaches the terminal as it is. */
const shownId = (id: string): string => (/^[A-Za-z0-9]{1,255}$/.test(id) ? id : "?");

export function diffStack(part: BuiltPart, built: string, deployed: string | undefined): StackDiff {
  const none = { added: 0, removed: 0, changed: 0, iamChanged: false, parametersAdded: 0, parametersRemoved: 0 };
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
  const added = Object.keys(will).filter((id) => !(id in was));
  const removed = Object.keys(was).filter((id) => !(id in will));
  const changed = Object.keys(will).filter((id) => id in was && canonicalJson(was[id]) !== canonicalJson(will[id]));
  const touched = [...added, ...removed, ...changed];
  const iamChanged = touched.some((id) => {
    const type = (isObject(will[id]) ? will[id].Type : undefined) ?? (isObject(was[id]) ? was[id].Type : undefined);
    return typeof type === "string" && type.startsWith("AWS::IAM::");
  });
  const parametersAdded = names(after.Parameters).filter((name) => !names(before.Parameters).includes(name)).length;
  const parametersRemoved = names(before.Parameters).filter((name) => !names(after.Parameters).includes(name)).length;
  const same = touched.length === 0 && parametersAdded === 0 && parametersRemoved === 0 && canonicalJson({ ...before, Resources: undefined, Parameters: undefined }) === canonicalJson({ ...after, Resources: undefined, Parameters: undefined });
  return { part, status: same ? "unchanged" : "changed", added: added.length, removed: removed.length, changed: changed.length, iamChanged, parametersAdded, parametersRemoved };
}

export interface BuildSummary {
  diffs: StackDiff[];
  /** The access stack, compared the way the deployer compares it. A build whose access stack is not the deployed one cannot be deployed by the deployer. */
  accessAgrees: boolean;
  lines: string[];
}

export function summariseBuild(input: { built: BuiltBundle; settings: SynthSettings; deployed: ReadonlyMap<BuiltPart, string | undefined>; confined: boolean }): BuildSummary {
  const { built, settings, deployed } = input;
  const diffs: StackDiff[] = [];
  const lines: string[] = [
    `Built the templates for ${settings.env} (${settings.region}) from release ${built.manifest.version}, with the build settings recorded for this install:`,
  ];
  const shown = redactedSynthSettings(settings);
  const contextKeys = Object.keys(shown.context).sort();
  if (contextKeys.length === 0) lines.push("  (no settings beyond the install's edition, environment, region and identity mode)");
  for (const key of contextKeys) lines.push(`  ${key} = ${shown.context[key] as string}`);
  lines.push(`  settings hash ${built.settingsSha256}`, `  kit hash      ${built.kitSha256}`, `  result hash   ${built.resultSha256}`);
  for (const part of BUILT_PARTS) {
    const entry = built.manifest.templates.find((template) => template.part === part);
    if (entry === undefined) continue;
    const text = built.files.find((file) => file.file === entry.file)?.body.toString("utf8") ?? "";
    const diff = diffStack(part, text, deployed.get(part));
    diffs.push(diff);
    const detail = diff.status === "changed" ? ` (${String(diff.added)} added, ${String(diff.removed)} removed, ${String(diff.changed)} changed${diff.iamChanged ? "; IAM changes" : ""}; ${String(diff.parametersAdded)} parameters added, ${String(diff.parametersRemoved)} removed)` : "";
    lines.push(`  ${part}: ${diff.status}${detail}`);
  }
  for (const pkg of built.manifest.packages) lines.push(`  package ${shownId(pkg.assetId)}: ${String(pkg.bytes)} bytes, sha256 ${pkg.sha256}`);
  const builtAccess = built.files.find((file) => file.file === "built/templates/access.template.json")?.body.toString("utf8");
  const deployedAccess = deployed.get("access");
  const accessAgrees = builtAccess !== undefined && deployedAccess !== undefined && accessTemplatesAgree(builtAccess, deployedAccess);
  if (!accessAgrees) lines.push("  The access stack differs from the deployed one (or could not be read). The deployer never changes the access stack, so it would refuse this build: your administrators deploy the access stack first.");
  if (!input.confined) lines.push("  Note: this Node cannot confine the kit to its own files; it ran with the bundle's signature as its only protection.");
  return { diffs, accessAgrees, lines };
}
