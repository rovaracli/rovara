// Rollback floors (BETA-CLOUD-PLAN 5; L9): the oldest Cloud commits a release may still go to. Data in ops/pipeline/rollback-floors.json, read from the PIPELINE tree
// (never from the candidate: an old tag has fewer floors). A target below a floor is refused with the floor's own reason.
//
// The file is read tolerantly (rule 8): unknown keys are ignored, a floor is a bare sha string or an object, a missing `reason` gets a plain default.
// It is never read as "no floors" when it is missing, unreadable or the wrong schema (rule 9): that refuses, visibly.
import type { Ports } from "../types.ts";

export const FLOORS_PATH = "ops/pipeline/rollback-floors.json";
const SHA40 = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface Floor { group: string; sha: string | null; reason: string }
export interface DigestFloor { digest: string; reason: string }
export interface PendingFloor { group: string; tag: string | null; sha: string | null; when: string; reason: string }
export interface Floors { floors: Floor[]; belowFloorDigests: DigestFloor[]; pending: PendingFloor[]; ignored: string[] }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** Throws Error with a plain message when the file is not usable at all; entries that cannot be judged stay in the list (sha null) so the gate fails on them. */
export function parseFloors(raw: string): Floors {
  let file: unknown;
  try { file = JSON.parse(raw); } catch { throw new Error(`${FLOORS_PATH} is not JSON`); }
  if (!isObject(file) || file.schema !== 1) throw new Error(`${FLOORS_PATH} has no schema 1`);
  if (!isObject(file.floors)) throw new Error(`${FLOORS_PATH} has no floors object`);
  const floors: Floor[] = [];
  for (const [group, list] of Object.entries(file.floors)) {
    if (!Array.isArray(list)) throw new Error(`${FLOORS_PATH}: floors.${group} is not a list`);
    for (const entry of list) {
      const sha = typeof entry === "string" ? text(entry) : isObject(entry) ? text(entry.sha) : null;
      const reason = isObject(entry) ? text(entry.reason) : null;
      floors.push({ group, sha: sha !== null && SHA40.test(sha) ? sha : null, reason: reason ?? `the ${group} floor in ${FLOORS_PATH}` });
    }
  }
  const belowFloorDigests: DigestFloor[] = [];
  if (isObject(file.gatewayDigests) && Array.isArray(file.gatewayDigests.belowFloor)) {
    for (const entry of file.gatewayDigests.belowFloor) {
      const digest = isObject(entry) ? text(entry.digest) : typeof entry === "string" ? text(entry) : null;
      if (digest !== null && DIGEST.test(digest)) belowFloorDigests.push({ digest, reason: (isObject(entry) ? text(entry.reason) : null) ?? "below the gateway floor" });
    }
  }
  // Pending floors are written down but NOT enforced: they say which condition turns them into floors (a reviewed edit moves them).
  const pending: PendingFloor[] = [];
  if (Array.isArray(file.pending)) {
    for (const entry of file.pending) {
      if (!isObject(entry)) continue;
      const sha = text(entry.sha);
      pending.push({ group: text(entry.group) ?? "cloud", tag: text(entry.tag), sha: sha !== null && SHA40.test(sha) ? sha : null, when: text(entry.when) ?? "a condition the file does not state", reason: text(entry.reason) ?? "" });
    }
  }
  const known = new Set(["schema", "about", "floors", "gatewayDigests", "pending"]);
  return { floors, belowFloorDigests, pending, ignored: Object.keys(file).filter((key) => !known.has(key)) };
}

export function loadFloors(ports: Ports, pipelineDir: string): Floors {
  const path = `${pipelineDir}/${FLOORS_PATH}`;
  if (!ports.fs.exists(path)) throw new Error(`${FLOORS_PATH} is missing from the pipeline tree: a missing floors file is never read as "no floors"`);
  return parseFloors(ports.fs.readText(path));
}

export interface FloorVerdict { failures: string[]; notes: string[] }

/** The Cloud ref (its commit) must equal or descend from every floor. A floor git cannot find is a failure, never a pass. */
export async function judgeRef(ports: Ports, floors: Floors, target: { tag: string; sha: string }): Promise<FloorVerdict> {
  const failures: string[] = [];
  const notes: string[] = [];
  for (const floor of floors.floors) {
    if (floor.sha === null) { failures.push(`a ${floor.group} floor in ${FLOORS_PATH} is not a full 40-hex sha, so ${target.tag} cannot be judged against it (${floor.reason})`); continue; }
    let above: boolean;
    try { above = await ports.git.isAncestor(floor.sha, target.sha); } catch { failures.push(`the ${floor.group} floor ${floor.sha.slice(0, 12)} is not in this repository, so ${target.tag} cannot be judged against it (${floor.reason})`); continue; }
    if (!above) failures.push(`${target.tag} (${target.sha.slice(0, 12)}) is below the ${floor.group} floor ${floor.sha.slice(0, 12)}: ${floor.reason}`);
  }
  if (floors.floors.length === 0) notes.push("the floors file lists no floors");
  for (const pending of floors.pending) notes.push(`pending floor (not enforced): ${pending.group} ${pending.tag ?? pending.sha?.slice(0, 12) ?? "?"} once ${pending.when}`);
  for (const key of floors.ignored) notes.push(`ignored unknown key ${key} in ${FLOORS_PATH}`);
  return { failures, notes };
}

export function judgeDigest(floors: Floors, digest: string): string[] {
  const hit = floors.belowFloorDigests.find((entry) => entry.digest === digest);
  return hit === undefined ? [] : [`gateway digest ${digest.slice(0, 19)}... is below the gateway floor: ${hit.reason}`];
}
