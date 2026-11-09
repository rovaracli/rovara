// Lessons in the repo, lane R2: the few host reads the publish pass and the erasure sweep share. A repository as the lessons code sees it is a `CodeHost` (the neutral port), a repository reference and a scope.
import { randomBytes } from "node:crypto";
import { LESSON_FILE_BRANCH_PREFIX, type ChangeRequestDetails, type CodeHost, type HostScope, type RepositoryIdentity, type RepositoryRef } from "@agentx/contracts";
import type { PrRow } from "./repo-file-state.js";

/** One repository of a project, with the code host that serves it and the scope to call it in. Provider-neutral: the host is the `CodeHost` port. */
export interface RepoFileTarget { name: string; place: string; repository: RepositoryRef; scope: HostScope; host: CodeHost }

/** The head of a branch, or undefined when the host cannot say (a branch that is gone and a host that is down look the same, and neither is "Rovara's own"). */
export const headOf = (target: RepoFileTarget, branch: string): Promise<string | undefined> => target.host.baseBranchHead(target.repository, branch, target.scope).then((head) => head, () => undefined);

/**
 * A branch name nobody has: 12 random hex digits, and asked of the host first. A name that already exists is never used (nothing is adopted, and Rovara must never later delete a branch it did not make); the adapter
 * refuses it as well, so this is the second lock. Undefined after five tries (the caller stops: a conflict).
 */
export async function freshBranchName(source: { randomHex?(): string }, target: RepoFileTarget): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const branch = `${LESSON_FILE_BRANCH_PREFIX}${source.randomHex?.() ?? randomBytes(6).toString("hex")}`;
    if (await headOf(target, branch) === undefined) return branch;
  }
  return undefined;
}

/** The host kind a place names (`github:repo/123` is on `github`). */
export const hostKindOfPlace = (place: string): string => place.slice(0, Math.max(0, place.indexOf(":")));

/**
 * The repository's WATCH row: written when the feature is switched on and before the first host write in the repository, and it says who the repository is (its address and the project's name for it), so the erasure sweep can reach
 * it later even when the project no longer lists it. Rows already there keep what a sweep recorded on them (a repository it could not reach, a branch it could not match).
 */
export function watchRowOf(target: Pick<RepoFileTarget, "place" | "name" | "repository">, at: number, previous?: PrRow): PrRow {
  const url = target.repository.url;
  return { ...(previous ?? {}), place: target.place, kind: "watch", number: "0", ids: [], at: previous?.at ?? at, ...(url.length > 0 && url.length <= 500 ? { repoUrl: url } : {}), repoName: target.name.slice(0, 200) };
}

/** The repository id a place pins (`github:repo/123` pins `123`), or undefined for a place of any other shape. */
export const repositoryIdOfPlace = (place: string): string | undefined => /^[a-z][a-z0-9-]*:repo\/([^/\s]+)$/u.exec(place)?.[1];

/**
 * THE FIRST CHECK before any host action on a repository (a read of its file, a branch, a pull request, a delete): the repository that answers at the target's address must BE the one the place pins. Every host call is addressed by
 * owner and name, and an address can come to hold another repository (the old one deleted or renamed, a new one given the name), so the id in the place is compared with the id the host reports. A mismatch, a repository the host
 * will not describe, or a place that pins no id is "not reachable": nothing is read from it and nothing is written to it.
 */
export async function verifyRepository(target: RepoFileTarget): Promise<{ ok: true; identity: RepositoryIdentity & { defaultBranch: string } } | { ok: false }> {
  let identity: RepositoryIdentity | undefined;
  try { identity = await target.host.repositoryIdentity(target.repository, target.scope); } catch { return { ok: false }; }
  const pinned = repositoryIdOfPlace(target.place);
  if (identity === undefined || identity.defaultBranch === undefined || pinned === undefined || String(identity.id) !== pinned) return { ok: false };
  return { ok: true, identity: { ...identity, defaultBranch: identity.defaultBranch } };
}

/** The host says there is no such pull request (GitHub: HTTP 404 on the lookup). A failure of any other kind is not "gone". */
export const isGone = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "NOT_FOUND" || /\bHTTP 404\b/u.test(error instanceof Error ? error.message : "");

/** A pull request that could not be read, or whose maker could not be confirmed: nothing is done to it, and it is tried again at the next sweep or pass. */
export class Unconfirmed extends Error {
  constructor() { super("the pull request could not be read or confirmed as Rovara's"); this.name = "Unconfirmed"; }
}

/**
 * READ AND CONFIRM BEFORE ANY DESTRUCTIVE CALL on a pull request. What the host says about change request `number`:
 *   - `gone`: a confirmed 404 (the only read failure that means anything);
 *   - `read` with `ours` true: Rovara made it (the host account is Rovara's own, its source branch is the row's branch, and it is against the repository the place pins);
 *   - `read` with `ours` false: it is someone else's (never touched);
 *   - `read` with `ours` undefined: the host did not say who made it or what it is against (never taken as a yes).
 * Any other failure to read THROWS `Unconfirmed`: no action, tried again next time. Callers close or delete only on `ours === true`, and only a pull request that is still open needs the answer.
 */
export async function readOwnPr(target: RepoFileTarget, number: string, branch: string): Promise<{ kind: "gone" } | { kind: "read"; details: ChangeRequestDetails; ours: boolean | undefined }> {
  let details: ChangeRequestDetails;
  try { details = await target.host.getChangeRequest({ repository: target.repository, id: number, url: "" }, target.scope); } catch (error) {
    if (isGone(error)) return { kind: "gone" };
    throw new Unconfirmed();
  }
  const pinned = repositoryIdOfPlace(target.place);
  if (details.sourceBranch !== branch || details.authoredByRovara === false || (pinned !== undefined && details.baseRepositoryId !== undefined && details.baseRepositoryId !== pinned)) return { kind: "read", details, ours: false };
  if (details.authoredByRovara !== true || details.baseRepositoryId === undefined || pinned === undefined) return { kind: "read", details, ours: undefined };
  return { kind: "read", details, ours: true };
}
