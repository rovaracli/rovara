// Rules A (mode), B (gates), C (CI), D (paths) and the order checks (P-ORDER, P-RB). Each function throws InputError for missing or malformed input.
import type { PipelineConfig, Policy, RollbackFloor } from "./policy.ts";
import {
  HEX40,
  InputError,
  asArray,
  asBoolean,
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  asString,
  field,
  hasOwn,
  isRecord,
  matchesAnyGlob,
  onlyKeys,
} from "./util.ts";

export type Fail = (rule: string, code: string, message: string) => void;

export const REGION = "us-west-2";

export function checkSha(value: unknown, where: string): string {
  const text = asString(value, where);
  if (!HEX40.test(text)) throw new InputError("input-invalid", `${where} must be a lowercase 40-hex sha`);
  return text;
}

function timeOf(value: unknown, where: string): number {
  const ms = Date.parse(asString(value, where));
  if (Number.isNaN(ms)) throw new InputError("input-invalid", `${where} is not a timestamp`);
  return ms;
}

export interface TriggerInput {
  kind: "push" | "rollback";
  rollback: RollbackInput | null;
}

export interface RollbackInput {
  lastGoodSha: string;
  /** Per floor sha of this pipeline: is the rollback target equal to it or a descendant of it (git, in Check)? */
  floorAncestry: Record<string, boolean>;
  targetIsAncestorOfInstalled: boolean;
  priorAutoRollbacksThisHold: number;
}

/** Rule A (mode) + P-ORDER + P-RB (rollback target rules). Returns the parsed trigger. */
export function checkModeAndOrder(root: Record<string, unknown>, policy: Policy, floors: readonly RollbackFloor[], pipeline: PipelineConfig, sha: string, previousSha: string, fail: Fail, alert: Fail): TriggerInput {
  const trigger = asRecord(field(root, "trigger", "input"), "trigger");
  onlyKeys(trigger, ["kind", "variables", "rollback"], "trigger");
  const kind = asString(field(trigger, "kind", "trigger"), "trigger.kind");
  const variables = asRecord(field(trigger, "variables", "trigger"), "trigger.variables");
  if (kind !== "push" && kind !== "rollback") {
    fail("A", "trigger-kind", `the run was started by "${kind}", not by the push trigger or the pipeline's own rollback`);
    return { kind: "push", rollback: null };
  }
  const names = Object.keys(variables);
  if (names.length > 0) fail("A", "variables-set", `non-default variables are set: ${names.join(", ")}`);
  const checkMode = asString(field(root, "checkMode", "input"), "checkMode");
  if (checkMode !== "auto-eligible") fail("A", "check-mode", `Check set the mode to "${checkMode}"`);
  const holds = asArray(field(root, "holdParameters", "input"), "holdParameters").map((item, i) => asNonEmptyString(item, `holdParameters[${i}]`));
  const unaudited = asFiniteNumber(field(root, "unauditedAutoRuns", "input"), "unauditedAutoRuns");
  if (!Number.isInteger(unaudited) || unaudited < 0) throw new InputError("input-invalid", "unauditedAutoRuns must be a non-negative integer");
  // The audit backlog stops new automatic deploys, never an automatic rollback (safety first): on a rollback it is an alert, not a reason.
  if (unaudited > policy.maxUnauditedAutoRuns) {
    const message = `${unaudited} auto runs are not yet audited (limit ${policy.maxUnauditedAutoRuns})`;
    if (kind === "rollback") alert("A", "audit-backlog-rollback-allowed", `${message}; the rollback is allowed anyway`);
    else fail("A", "audit-backlog", message);
  }

  if (kind === "push") {
    if (hasOwn(trigger, "rollback") && trigger.rollback !== null) fail("A", "trigger-kind", "a push run carries rollback data");
    if (holds.length > 0) fail("A", "hold", `a HOLD is set (${holds.length} hold parameter(s))`);
    const ancestry = asRecord(field(root, "ancestry", "input"), "ancestry");
    onlyKeys(ancestry, ["installedIsAncestorOfSha"], "ancestry");
    if (sha === previousSha) fail("P-ORDER", "same-sha", "the sha equals the installed sha: nothing to deploy");
    else if (!asBoolean(field(ancestry, "installedIsAncestorOfSha", "ancestry"), "ancestry.installedIsAncestorOfSha")) {
      fail("P-ORDER", "not-forward", "the installed sha is not an ancestor of the sha: an older or unrelated sha never goes over the installed one");
    }
    return { kind, rollback: null };
  }

  // Rollback: it must name last-good, run with a HOLD set, stay above every floor, and be the only automatic rollback of this HOLD.
  const rb = asRecord(field(trigger, "rollback", "trigger"), "trigger.rollback");
  onlyKeys(rb, ["lastGoodSha", "floorAncestry", "targetIsAncestorOfInstalled", "priorAutoRollbacksThisHold"], "trigger.rollback");
  const rollback: RollbackInput = {
    lastGoodSha: checkSha(field(rb, "lastGoodSha", "trigger.rollback"), "trigger.rollback.lastGoodSha"),
    floorAncestry: Object.fromEntries(Object.entries(asRecord(field(rb, "floorAncestry", "trigger.rollback"), "trigger.rollback.floorAncestry")).map(([k, v]) => [k, asBoolean(v, `trigger.rollback.floorAncestry.${k}`)])),
    targetIsAncestorOfInstalled: asBoolean(field(rb, "targetIsAncestorOfInstalled", "trigger.rollback"), "trigger.rollback.targetIsAncestorOfInstalled"),
    priorAutoRollbacksThisHold: asFiniteNumber(field(rb, "priorAutoRollbacksThisHold", "trigger.rollback"), "trigger.rollback.priorAutoRollbacksThisHold"),
  };
  if (rollback.lastGoodSha !== sha) fail("P-RB", "not-last-good", "a rollback must deploy exactly the last-good sha");
  if (sha === previousSha || !rollback.targetIsAncestorOfInstalled) fail("P-RB", "not-backwards", "the rollback target is not an ancestor of the installed sha");
  if (holds.length === 0) fail("P-RB", "no-hold", "a rollback must run with a HOLD already set");
  if (rollback.priorAutoRollbacksThisHold > 0) fail("P-RB", "second-rollback", "one automatic rollback per HOLD: this HOLD already had one");
  for (const floor of floors.filter((f) => f.pipeline === pipeline.name)) {
    if (!hasOwn(rollback.floorAncestry, floor.sha)) fail("P-RB", "floor-unknown", `no ancestry answer for rollback floor ${floor.sha}`);
    else if (rollback.floorAncestry[floor.sha] !== true) fail("P-RB", "below-floor", `the rollback target is below the floor ${floor.sha}`);
  }
  return { kind, rollback };
}

/** Rule B: the gate markers. */
export function checkGates(root: Record<string, unknown>, policy: Policy, pipeline: PipelineConfig, sha: string, now: number, fail: Fail): void {
  const gates = asArray(field(root, "gates", "input"), "gates").map((item, i) => {
    const g = asRecord(item, `gates[${i}]`);
    onlyKeys(g, ["name", "sha", "writtenAt", "result", "skippedReason", "failures"], `gates[${i}]`);
    return g;
  });
  const required = [...pipeline.requiredGates.map((g) => ({ ...g, dryRun: false })), ...(pipeline.dryRunGate === null ? [] : [{ name: pipeline.dryRunGate, mayBeSkipped: false, dryRun: true }])];
  const maxAgeMs = policy.gateMaxAgeMinutes * 60_000;
  const skewMs = policy.gateClockSkewMinutes * 60_000;
  for (const requirement of required) {
    const matches = gates.filter((g) => g.name === requirement.name);
    if (matches.length === 0) {
      fail("B", "gate-missing", `gate marker "${requirement.name}" is missing`);
      continue;
    }
    if (matches.length > 1) {
      fail("B", "gate-duplicate", `gate marker "${requirement.name}" appears ${matches.length} times`);
      continue;
    }
    const gate = matches[0] as Record<string, unknown>;
    const where = `gate "${requirement.name}"`;
    if (asString(field(gate, "sha", where), `${where}.sha`) !== sha) fail("B", "gate-sha", `${where} names another sha`);
    const age = now - timeOf(field(gate, "writtenAt", where), `${where}.writtenAt`);
    if (age > maxAgeMs) fail("B", "gate-stale", `${where} is older than ${policy.gateMaxAgeMinutes} minutes`);
    if (age < -skewMs) fail("B", "gate-future", `${where} is dated in the future`);
    const result = asString(field(gate, "result", where), `${where}.result`);
    if (requirement.dryRun) {
      const failures = asArray(field(gate, "failures", where), `${where}.failures`).map((f, i) => asNonEmptyString(f, `${where}.failures[${i}]`));
      const real = failures.filter((f) => !policy.dryRunIgnorableFailures.includes(f));
      if (real.length > 0) fail("B", "dry-run-failures", `${where} has FAIL lines: ${real.join(", ")}`);
      if (result !== "pass" && result !== "fail") fail("B", "gate-result", `${where} result "${result}" is not known`);
      continue;
    }
    if (result === "pass") continue;
    if (result === "skipped") {
      const reason = hasOwn(gate, "skippedReason") ? asString(gate.skippedReason, `${where}.skippedReason`) : "";
      if (!requirement.mayBeSkipped) fail("B", "gate-skipped", `${where} may not be skipped`);
      else if (!policy.skippedGateReasons.includes(reason)) fail("B", "gate-skip-reason", `${where} was skipped for "${reason}", which is not a standing skip`);
      continue;
    }
    fail("B", "gate-failed", `${where} result is "${result}"`);
  }
  const names = new Set(required.map((r) => r.name));
  for (const gate of gates) {
    if (!names.has(gate.name as string)) fail("B", "gate-unknown", `unknown gate marker "${String(gate.name)}"`);
  }
}

/** Rule C (P-CI): CI green on this sha's tree, read only from GitHub runs whose provenance this function checks. */
export function checkCi(root: Record<string, unknown>, pipeline: PipelineConfig, fail: Fail): void {
  const ci = asRecord(field(root, "ci", "input"), "ci");
  onlyKeys(ci, ["apiError", "runs"], "ci");
  const tree = asString(field(root, "tree", "input"), "tree");
  if (!HEX40.test(tree)) throw new InputError("input-invalid", "tree must be a 40-hex git tree id");
  if (ci.apiError !== null && ci.apiError !== undefined) {
    fail("C", "ci-api-error", `the GitHub API call failed: ${asString(ci.apiError, "ci.apiError")}`);
    return;
  }
  const runs = asArray(field(ci, "runs", "ci"), "ci.runs");
  if (runs.length === 0) {
    fail("C", "ci-missing", "no CI run was found for this sha");
    return;
  }
  const problems: string[] = [];
  let accepted = false;
  runs.forEach((item, i) => {
    const run = asRecord(item, `ci.runs[${i}]`);
    const id = String(run.id);
    const bad: string[] = [];
    if (run.path !== `.github/workflows/${pipeline.ci.workflowFile}`) bad.push("workflow path");
    const repo = isRecord(run.repository) ? run.repository.full_name : undefined;
    if (repo !== pipeline.ci.repo) bad.push("repository");
    const head = isRecord(run.head_repository) ? run.head_repository.full_name : undefined;
    if (head !== pipeline.ci.repo) bad.push("head repository (fork)");
    if (typeof run.event !== "string" || !["push", "pull_request", "workflow_dispatch"].includes(run.event)) bad.push("event");
    if (run.status !== "completed" || run.conclusion !== "success") bad.push("not completed with success");
    // The merge sha is not the CI sha (rebase-merge, merge queue): the run is matched by the git tree of its head commit.
    const headSha = run.head_sha;
    if (typeof headSha !== "string" || !HEX40.test(headSha)) bad.push("head sha");
    const treeId = isRecord(run.head_commit) ? run.head_commit.tree_id : undefined;
    if (typeof treeId !== "string" || !HEX40.test(treeId)) bad.push("head commit tree id");
    else if (treeId !== tree) bad.push("different git tree");
    const jobs: unknown[] = Array.isArray(run.jobs) ? run.jobs : [];
    const checkRuns: unknown[] = Array.isArray(run.checkRuns) ? run.checkRuns : [];
    for (const name of pipeline.ci.requiredJobs) {
      const job = jobs.find((j) => isRecord(j) && j.name === name);
      if (!isRecord(job) || job.conclusion !== "success" || job.status !== "completed" || (typeof headSha === "string" && job.head_sha !== undefined && job.head_sha !== headSha)) bad.push(`job ${name}`);
      const checks = checkRuns.filter((c) => isRecord(c) && c.name === name);
      if (checks.length === 0 || !checks.every((c) => isRecord(c) && c.conclusion === "success" && isRecord(c.app) && c.app.slug === "github-actions")) bad.push(`check run ${name} (app or result)`);
    }
    if (bad.length === 0) accepted = true;
    else problems.push(`run ${id}: ${bad.join(", ")}`);
  });
  if (!accepted) fail("C", "ci-not-green", `no acceptable CI run (${problems.join("; ")})`);
}

/** Cleans one changed path. Anything that is not a plain, ASCII, repository-relative path is rejected. */
export function checkPathText(value: unknown, index: number): string {
  const path = asNonEmptyString(value, `changedPaths[${index}]`);
  if (/[^\x20-\x7e]/.test(path) || path.includes("\\") || path.includes('"') || path.startsWith("/") || path.endsWith("/")) {
    throw new InputError("path-invalid", `changedPaths[${index}] "${path}" is not a plain repository-relative path`);
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new InputError("path-invalid", `changedPaths[${index}] "${path}" has a dot or empty segment`);
  return path;
}

/** Rule D: nothing on the manual list, and every path on the allow-list. For a rollback (`manualOnly`) the paths are the range being undone (target..installed): the manual list still applies, the allow-list does not. */
export function checkPaths(paths: readonly string[], policy: Policy, manualGlobs: readonly string[], fail: Fail, manualOnly = false): void {
  for (const path of paths) {
    if (matchesAnyGlob(path, manualGlobs)) fail("D", "manual-path", `"${path}" is on the manual-paths list${manualOnly ? " (inside the range a rollback would undo)" : ""}`);
    else if (!manualOnly && !matchesAnyGlob(path, policy.allowedPathGlobs, false)) fail("D", "unknown-path", `"${path}" is not on the allowed path list`);
  }
}

/** The release-notes marker (owner decision DEC 254zzz441): a cross-repo install order, a backfill, a migration or any out-of-repo step is declared in a release-notes file the release touches
 *  (a path matching policy.releaseNotesGlobs, by convention docs/release-notes/<version>.md) as ONE line, exactly:  requires: <what>
 *  Lower-case, a colon, one space, then at least one non-space character. Any such line forces MANUAL with that text as the reason.
 *  A line that tries to be a marker (a bullet or quote prefix, a capital letter, a space before the colon, a missing text, "requires -") but is not exactly that form is MANUAL too (fail closed).
 *  Prose that merely contains the word ("this requires a restart") is not a marker. Check supplies the text of every changed file that matches the globs (null for a deleted file); a missing or extra file is MANUAL. */
/** Invisible or blank-rendering code points: the Unicode default-ignorables (includes the Hangul fillers, the Mongolian vowel separator, zero-width and format characters, the BOM) plus the Braille blank. */
export const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/u;
const INVISIBLE_ALL = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/gu;
export const REQUIRES_MARKER = /^requires: \S/;
export const REQUIRES_ATTEMPT = /^[\s>*+\-#`_]*requires?\s*[:=-]/i;

export function checkRequires(root: Record<string, unknown>, changed: readonly string[], policy: Policy, fail: Fail): void {
  const notes = asArray(field(root, "releaseNotes", "input"), "releaseNotes").map((item, i) => {
    const n = asRecord(item, `releaseNotes[${i}]`);
    onlyKeys(n, ["path", "text"], `releaseNotes[${i}]`);
    const text = field(n, "text", `releaseNotes[${i}]`);
    if (text !== null && typeof text !== "string") throw new InputError("input-invalid", `releaseNotes[${i}].text must be a string or null`);
    return { path: asNonEmptyString(field(n, "path", `releaseNotes[${i}]`), `releaseNotes[${i}].path`), text };
  });
  const expected = changed.filter((p) => matchesAnyGlob(p, policy.releaseNotesGlobs));
  const given = notes.map((n) => n.path);
  for (const path of expected) if (!given.includes(path)) fail("K", "notes-missing", `the text of the changed release-notes file "${path}" was not supplied`);
  for (const path of given) if (!expected.includes(path)) fail("K", "notes-unexpected", `release-notes text was supplied for "${path}", which is not a changed release-notes file`);
  for (const note of notes) {
    if (note.text === null) continue;
    note.text.split(/\r?\n/).forEach((rawLine, index) => {
      // NFKC folds full-width forms (requires： with a full-width colon) and the format characters (zero-width spaces) are dropped before matching.
      // Fail closed on any invisible or blank-rendering character (Default_Ignorable_Code_Point covers U+3164, U+115F, U+1160, U+FFA0, U+180E and the zero-width forms; U+2800 Braille blank is added):
      // release notes are prose a human reads, and no such character has a place in them. Stripping alone could miss one a future Unicode version adds; refusing cannot.
      if (INVISIBLE.test(rawLine)) fail("K", "notes-invisible-char", `${note.path}:${index + 1} contains an invisible or blank-rendering character, which can hide a requires marker`);
      const line = rawLine.normalize("NFKC").replace(INVISIBLE_ALL, "");
      if (REQUIRES_MARKER.test(line)) fail("K", "requires-marker", `${note.path}:${index + 1} declares a manual step: ${line.slice("requires: ".length).slice(0, 200)}`);
      else if (REQUIRES_ATTEMPT.test(line)) fail("K", "requires-malformed", `${note.path}:${index + 1} looks like a requires marker but is not exactly "requires: <what>"`);
    });
  }
}
