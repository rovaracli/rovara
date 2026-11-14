// FR-042: which release an upgrade moves to, that it never moves back (question 3), and the
// release's notes. Ruling F31 (amended by the controller): never a prerelease target, as init.
import { agentXError } from "@rovara-code/contracts";
import { RELEASE_REPOSITORY } from "../init/release-fetch.js";
import { isPrereleaseVersion } from "../version.js";

const MAX_NOTE_LINES = 40;

const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parts(version: string): { numbers: number[]; pre: string[] | undefined } {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (match === null) throw agentXError("CONFIG_INVALID", `"${version}" is not a release version (x.y.z); use a published release version such as 1.4.0`);
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? undefined : match[4].split(".") };
}

/** Semver order of two prerelease identifier lists: numeric identifiers numerically and below alphanumeric ones, a shorter list first. */
function comparePrerelease(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index] ?? "";
    const b = right[index] ?? "";
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === undefined && right.pre === undefined) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return comparePrerelease(left.pre, right.pre);
}

export function upgradeDirection(env: string, current: string, target: string): "same" | "newer" {
  if (!RELEASE_VERSION_PATTERN.test(current)) {
    throw agentXError("CONFIG_INVALID", `environment ${env}'s settings record version "${current}", not a release, so agentx upgrade cannot tell whether ${target} is older; agentx upgrade works only on environments agentx init installed`);
  }
  const order = compareVersions(current, target);
  if (order === 0) return "same";
  if (order < 0) return "newer";
  throw agentXError("CONFIG_INVALID", `release ${target} is older than ${current}, which environment ${env} runs; agentx upgrade never moves an environment back, because a newer release may have written data an older one cannot read. Upgrade to ${current} or later, or, to move back on purpose, run agentx upgrade --rollback-to ${target}`);
}

/**
 * Rollback floors (owner policy 2026-11-12: "undo = redeploy the previous release"; records are additive only and readers ship first).
 * A release that breaks that policy, by writing data an older release cannot read, declares here the oldest release that can still run
 * on its data. `agentx upgrade --rollback-to` refuses any target below the floor of every release it would roll back past.
 * A release that keeps the policy adds nothing. Entries are never removed: a later agentx must still know an earlier release's floor.
 */
export interface RollbackFloor { /** The release that wrote the data. */ release: string; /** The oldest release that can run on that data. */ floor: string; /** What the release wrote, for the refusal. */ reason: string }

export const ROLLBACK_FLOORS: readonly RollbackFloor[] = [
  // 0.5.15 dropped the control plane's CallbackSigningKey parameter (parameters.ts): this agentx no longer sends it, and 0.5.14's template
  // has no default for it, so this agentx cannot deploy 0.5.14 or older. (The 0.5.14 CLI itself still can: rollback-0515-to-0514.sh.)
  { release: "0.5.15", floor: "0.5.15", reason: "removed the control plane's CallbackSigningKey parameter, which every older template needs and this agentx no longer sends" },
];

/**
 * The newest release whose floor this agentx knows: this source's own release. Bump it in every release (docs/releases.md, "Rolling a
 * release back"; scripts/release/pack-cli.ts refuses to pack a release whose x.y.z is not this). A rollback from an environment that ever
 * ran a newer release is refused, because that release may have declared a floor this agentx has never seen; run the rollback with that
 * release's agentx (or a newer one) instead. Forgetting the bump only refuses, never allows.
 */
export const ROLLBACK_FLOORS_DECLARED_THROUGH = "0.5.18";

/** The release's own check (scripts/release/pack-cli.ts): a release whose x.y.z is not ROLLBACK_FLOORS_DECLARED_THROUGH forgot the bump, so its packed agentx would refuse to roll its own release back. */
export function assertRollbackFloorsDeclaredFor(version: string, declaredThrough: string = ROLLBACK_FLOORS_DECLARED_THROUGH): void {
  const base = /^(\d+\.\d+\.\d+)(?:-.*)?$/.exec(version)?.[1];
  if (base === undefined || base !== declaredThrough) {
    throw new Error(`release ${version}: ROLLBACK_FLOORS_DECLARED_THROUGH in packages/cli/src/upgrade/target.ts is ${declaredThrough}; set it to ${base ?? "this release's x.y.z"} (and add a ROLLBACK_FLOORS entry if this release writes data an older one cannot read), then tag again`);
  }
}

/**
 * `agentx upgrade --rollback-to` and `agentx bundle approve --rollback`: the only ways an environment moves back. The target must be
 * older than the recorded version. The floors and the releases this agentx knows are checked against the highest release the environment
 * ever ran (`highWater`, environments/release-high-water.ts; the recorded version when none is recorded), not just the current one, so two
 * rollbacks in a row never step under a floor the first one passed.
 */
export function rollbackDirection(env: string, current: string, target: string, floors: readonly RollbackFloor[] = ROLLBACK_FLOORS, declaredThrough: string = ROLLBACK_FLOORS_DECLARED_THROUGH, highWater?: string): "older" {
  if (!RELEASE_VERSION_PATTERN.test(current)) {
    throw agentXError("CONFIG_INVALID", `environment ${env}'s settings record version "${current}", not a release, so agentx upgrade --rollback-to cannot tell whether ${target} is older; nothing was changed`);
  }
  const order = compareVersions(current, target);
  if (order === 0) throw agentXError("CONFIG_INVALID", `environment ${env} already runs ${target}; --rollback-to moves only to an older release. To finish an upgrade that stopped, run agentx upgrade without --rollback-to; nothing was changed`);
  if (order < 0) throw agentXError("CONFIG_INVALID", `release ${target} is newer than ${current}, which environment ${env} runs; --rollback-to moves only to an older release. Run agentx upgrade --to ${target} instead; nothing was changed`);
  // The highest release the environment ever ran: never below the recorded one.
  floorCheck(env, current, target, floors, declaredThrough, highWater, "rollback");
  return "older";
}

/**
 * The floors of every release the environment ever ran (the high-water mark; the recorded version without one), for a deploy of `target`:
 * this agentx must know them all (declared-through), and `target` must be at or above each floor of a release above it. `rollbackDirection`
 * runs it for every rollback; `agentx upgrade` runs it for a plain upgrade or a same-version re-run too whenever the mark is above the target
 * (an upgrade that stopped part way already raised the mark to its own target, so the floors it declared hold from then on).
 */
export function floorCheck(env: string, current: string, target: string, floors: readonly RollbackFloor[] = ROLLBACK_FLOORS, declaredThrough: string = ROLLBACK_FLOORS_DECLARED_THROUGH, highWater?: string, kind: "rollback" | "deploy" = "deploy"): void {
  const top = highWater !== undefined && RELEASE_VERSION_PATTERN.test(highWater) && compareVersions(highWater, current) > 0 ? highWater : current;
  if (compareVersions(top, target) <= 0) return;
  const ran = top === current ? `runs ${current}` : `has run ${top} (it runs ${current} now)`;
  const how = kind === "rollback" ? "Run the rollback" : "Run this";
  if (compareVersions(top, declaredThrough) > 0) {
    throw agentXError("CONFIG_INVALID", `environment ${env} ${ran}, newer than every release this agentx knows (through ${declaredThrough}), so it cannot tell whether ${top} wrote data ${target} cannot read. ${how} with release ${top}'s agentx or a newer one (with --source <checkout of v${target}> on a cdk install); nothing was changed`);
  }
  const blocking = floors
    .filter((entry) => compareVersions(entry.release, target) > 0 && compareVersions(entry.release, top) <= 0 && compareVersions(target, entry.floor) < 0)
    .sort((a, b) => compareVersions(b.floor, a.floor))[0];
  if (blocking !== undefined) {
    throw agentXError("CONFIG_INVALID", `release ${blocking.release} ${blocking.reason}, so environment ${env}, which ${ran}, ${kind === "rollback" ? "rolls back" : "deploys"} no lower than ${blocking.floor}; ${target} is below that floor. ${kind === "rollback" ? "Roll back to" : "Deploy"} ${blocking.floor} or later, or fix forward; nothing was changed`);
  }
}

/** Ruling F31, amended: like init, upgrade moves only to published releases, from --release <dir> too.
 * The settings' version takes only x.y.z, so a prerelease would deploy every stack and then fail to
 * write the settings. Call it right after the release loads, before anything deploys. */
export function refusePrereleaseTarget(version: string): void {
  if (!isPrereleaseVersion(version)) return;
  throw agentXError("CONFIG_INVALID", `release ${version} is a prerelease; agentx upgrade moves an environment only to published releases (x.y.z), because the environment settings record only x.y.z and a prerelease would fail after every stack deployed. Pass --release <dir> with a published release, or upgrade to a published version`);
}

export interface ReleaseNotes { text: string; url: string }

export async function releaseNotes(input: { fetch: typeof fetch; version: string }): Promise<ReleaseNotes | undefined> {
  try {
    const response = await input.fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/v${input.version}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agentx-cli" }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { body?: unknown; html_url?: unknown };
    if (typeof body.body !== "string" || typeof body.html_url !== "string") return undefined;
    return { text: body.body, url: body.html_url };
  } catch {
    return undefined;
  }
}

/** The notes as plain text: colour sequences and every control character but the newline removed
 * (a tab becomes a space), so a release body cannot move the cursor or restyle the terminal. */
function cleanNotes(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
}

export function notesText(notes: ReleaseNotes | undefined, version: string): string {
  if (notes === undefined) return `No release notes could be read for ${version}; see https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`;
  const text = cleanNotes(notes.text);
  if (text === "") return `Release ${version} has no release notes; see ${notes.url}`;
  const lines = text.split("\n");
  const shown = lines.slice(0, MAX_NOTE_LINES).map((line) => `  ${line}`);
  const rest = lines.length - shown.length;
  return [`Release notes for ${version}:`, ...shown, ...(rest > 0 ? [`  (${rest} more lines at ${notes.url})`] : [])].join("\n");
}
