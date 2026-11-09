// Lessons in the repo, lane R2 (owner decisions 50, 50a, 50b, 56; design LESSONS-REPO-FILE-DESIGN.md rev 2 section 5): the weekly pass that proposes Rovara's `.rovara/lessons.md` for ONE repository through ONE batched pull request.
// This WRITES TO A CUSTOMER'S REPOSITORY, so every rule below is also a test:
//   - It makes NO model call (decision 47): rendering, comparing and the reasons come from counters and rules. It runs only while lessons are switched on and the project's mode allows loading; while they are off, nothing is
//     opened, closed or changed (the reads and the state are untouched).
//   - Only lessons eligible for THIS repository go in (`planRepoFile`); the file is changed only by this pull request, which a person merges.
//   - One pass per repository at a time (a lease), at most one pass a week. An unchanged proposal opens nothing; the same proposals as the open pull request leave it alone.
//   - A new proposal goes on a NEW branch `rovara/lessons-<12 random hex>`: nothing is adopted, a branch that exists is never written to, the commit's parent is the default branch head the file was read at, and the ref is
//     moved without force. The previous Rovara pull request is closed and its branch deleted afterwards, so at most one Rovara lessons pull request is open per repository.
//   - A pull request a person pushed to (its head is not where Rovara left it) is theirs: never closed, never deleted, nothing new is opened beside it. A person's own pull request or branch is never looked at at all.
//   - Every host write is audited BEFORE it is made, and a failed audit skips the write (nothing is urgent by construction).
//   - After 3 weekly pull requests in a row that nobody merged, additions and edits stop; removals still go out, in a smaller pull request.
//   - A file the team deleted pauses the repository; a file that is a link, a folder, over 64 KB or unreadable is left alone, and the status says why. Nothing is retired on a failed read.
import { randomBytes } from "node:crypto";
import {
  COMMIT_CONFLICT_MESSAGE, COMMIT_SYMLINK_MESSAGE, LESSON_FILE_BRANCH_PREFIX, LESSON_FILE_MAX_BYTES, LESSON_FILE_PATH, LESSON_FILE_POINTER_PATHS,
  type CodeHost, type HostScope, type LessonFileProblem, type RepositoryRef,
} from "@agentx/contracts";
import { modeAllows, requireAudit, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { mentionsLessonsFile, pointerTargets, withPointer, type PointerPath } from "./repo-file-pointer.js";
import { planRepoFile, type RepoFilePlan } from "./repo-file-plan.js";
import { prBody, prTitle } from "./repo-file-pr.js";
import { MAX_DECLINED, MAX_RENDERED, additionsPaused, boundedAppend, type OpenPr, type RepoFileState, type RepoFileStore } from "./repo-file-state.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

/** One repository of a project, with the code host that serves it and the scope to call it in. Provider-neutral: the host is the `CodeHost` port. */
export interface RepoFileTarget { name: string; place: string; repository: RepositoryRef; scope: HostScope; host: CodeHost }

export interface RepoFileDeps {
  store: LessonStore;
  state: RepoFileStore;
  settings: LearningSettingsReader;
  audit: LessonAuditSink;
  /** The display names of the people the lessons could name: the project's people and the lessons' own. Throws when it cannot be read (the pass then waits). */
  names(key: ScopeKey, lessons: readonly Lesson[]): Promise<readonly string[]>;
  now(): number;
  /** Who holds the lease (one value per running pass). */
  holder: string;
  /** 12 random lower-case hex digits for a branch name; the default is the platform's random bytes. */
  randomHex?(): string;
  log?(event: string, fields: Record<string, string | number>): void;
}

/** One pass a week: a run 6 days after the last is due (the nightly job asks daily, so it is the seventh night at the latest). */
export const PASS_EVERY_MS = 6 * 86_400_000;
export const LEASE_MS = 20 * 60_000;

export type PassResult =
  | { status: "skipped"; reason: "lessons_off" | "not_enabled" | "not_due" | "busy" | "file_deleted" }
  | { status: "problem"; problem: LessonFileProblem }
  | { status: "no_changes" | "left" | "waiting_on_team" }
  | { status: "opened"; number: string; removals: number; edits: number; adds: number };

class Abort extends Error { constructor(readonly problem: LessonFileProblem) { super(problem); } }
const codeOf = (error: unknown): string | undefined => (typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : undefined);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");

/** Commits a changed state under the revision that was read; a lost race ends the pass. */
async function commit(deps: RepoFileDeps, key: ScopeKey, state: RepoFileState, next: Partial<RepoFileState> | ((state: RepoFileState) => RepoFileState)): Promise<RepoFileState> {
  const value = typeof next === "function" ? next(state) : { ...state, ...next };
  const saved = await deps.state.put(key, value, state.revision);
  if (saved === undefined) throw new Abort("conflict");
  return saved;
}
const without = <T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> => { const copy = { ...value }; for (const key of keys) delete copy[key]; return copy; };

/** Writes one audit event before a host write; false (skip the write) when the ledger cannot take it. */
async function audited(deps: RepoFileDeps, key: ScopeKey, action: "lesson.repo_file_pr_opened" | "lesson.repo_file_pr_closed", facts: Record<string, string | number | boolean>): Promise<boolean> {
  return requireAudit(deps.audit, { action, workspaceId: key.workspaceId, project: key.project, facts });
}

/**
 * Closes Rovara's own pull requests and deletes its own branches that are waiting in `closing`, and the branch of a pending write that was never recorded. Each one is audited first; one that fails stays for the next pass.
 * Only Rovara's own: the state holds a number and a branch Rovara made, never a person's.
 */
export async function finishClosings(deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, state: RepoFileState): Promise<RepoFileState> {
  let current = state;
  const { host, repository, scope } = target;
  if (current.pending !== undefined) {
    const branch = current.pending.branch;
    // A branch Rovara decided on before it wrote (it may exist, with a pull request): deleting it closes any pull request made from it. Nothing else is touched.
    if (host.deleteBranch !== undefined && await audited(deps, key, "lesson.repo_file_pr_closed", { cause: "replaced", pullRequest: 0 })) {
      try { await host.deleteBranch(repository, branch, scope); current = await commit(deps, key, current, (s) => without(s, "pending") as RepoFileState); } catch (error) { if (error instanceof Abort) throw error; deps.log?.("lessons_repo_file.pending_cleanup_failed", {}); }
    }
  }
  for (const entry of current.closing) {
    if (!await audited(deps, key, "lesson.repo_file_pr_closed", { cause: entry.cause, pullRequest: Number(entry.number ?? 0) || 0 })) continue;
    try {
      if (entry.number !== undefined) await host.updateChangeRequest({ repository, id: entry.number, url: "" }, { state: "closed" }, scope);
      if (entry.keepBranch !== true && host.deleteBranch !== undefined) await host.deleteBranch(repository, entry.branch, scope);
      current = await commit(deps, key, current, (s) => { const at = s.closing.findIndex((c) => c.branch === entry.branch && c.number === entry.number); return { ...s, closing: s.closing.filter((_, index) => index !== at) }; });
    } catch (error) {
      if (error instanceof Abort) throw error;
      deps.log?.("lessons_repo_file.close_failed", {});
    }
  }
  return current;
}

/** Switching a repository off: closes the open pull request and deletes its branch (when it is still Rovara's), proposes nothing more, leaves the merged file. Returns the saved state. */
export async function switchRepoFileOff(deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, state: RepoFileState): Promise<RepoFileState> {
  let current = await commit(deps, key, state, { enabled: false });
  if (current.open !== undefined) {
    const open = current.open;
    let moved = false;
    try { moved = (await target.host.getChangeRequest({ repository: target.repository, id: open.number, url: open.url }, target.scope)).headRevision !== open.headRevision; } catch { moved = false; }
    // A pull request a person pushed to is theirs: Rovara forgets it and closes nothing.
    current = await commit(deps, key, current, (s) => ({ ...without(s, "open") as RepoFileState, ...(moved ? {} : { closing: [...s.closing, { branch: open.branch, number: open.number, cause: "switched_off" as const }] }) }));
  }
  return finishClosings(deps, key, target, current);
}

/**
 * A branch name nobody has: 12 random hex digits, and asked of the host first. A name that already exists is never used (nothing is adopted, and Rovara must never later delete a branch it did not make); the adapter
 * refuses it as well, so this is the second lock.
 */
async function freshBranch(deps: RepoFileDeps, target: RepoFileTarget): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const branch = `${LESSON_FILE_BRANCH_PREFIX}${deps.randomHex?.() ?? randomBytes(6).toString("hex")}`;
    let exists = false;
    try { await target.host.baseBranchHead(target.repository, branch, target.scope); exists = true; } catch { exists = false; }
    if (!exists) return branch;
  }
  throw new Abort("conflict");
}

/** The state after Rovara's open pull request was seen merged: what it put in the file is now Rovara's rendered record. */
function mergedState(state: RepoFileState, open: OpenPr): RepoFileState {
  const rendered = { ...state.rendered, ...open.added, ...open.edited };
  for (const id of open.removed) delete rendered[id];
  return { ...without(state, "open") as RepoFileState, rendered, unmerged: 0, fileSeen: true, fileDeleted: false };
}

/**
 * One weekly pass for one repository. Never throws: a fault is a `problem` code on the state (shown in the status) and the pass tries again at the next night. `force` skips only the "one a week" gate.
 */
export async function runRepoFilePass(deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, options: { force?: boolean } = {}): Promise<PassResult> {
  const { host, repository, scope } = target;
  // Decision 47: while lessons are off (the install's switch, the project's mode) nothing is delivered: no pull request, no close, no read.
  const learning = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(learning.mode, "load")) return { status: "skipped", reason: "lessons_off" };
  let state = await deps.state.get(key, target.place);
  if (state === undefined || !state.enabled) return { status: "skipped", reason: "not_enabled" };
  if (state.fileDeleted) return { status: "skipped", reason: "file_deleted" };
  const started = deps.now();
  if (options.force !== true && state.lastPassAt !== undefined && started - state.lastPassAt < PASS_EVERY_MS) return { status: "skipped", reason: "not_due" };
  if (state.lease !== undefined && state.lease.until > started && state.lease.holder !== deps.holder) return { status: "skipped", reason: "busy" };
  if (host.commitFiles === undefined || host.deleteBranch === undefined || host.pathKind === undefined) {
    await deps.state.put(key, { ...state, problem: "host_cannot_write" }, state.revision).catch(() => undefined);
    return { status: "problem", problem: "host_cannot_write" };
  }
  try {
    state = await commit(deps, key, state, { lease: { holder: deps.holder, until: started + LEASE_MS } });
  } catch { return { status: "skipped", reason: "busy" }; }

  let result: PassResult;
  try {
    result = await pass(deps, key, target, state, learning.preset === "standard" ? "standard" : "regulated");
  } catch (error) {
    const problem: LessonFileProblem = error instanceof Abort ? error.problem : "repository_unreadable";
    if (!(error instanceof Abort)) deps.log?.("lessons_repo_file.pass_failed", {});
    result = { status: "problem", problem };
    const latest = await deps.state.get(key, target.place).catch(() => undefined);
    if (latest !== undefined) await deps.state.put(key, { ...latest, problem }, latest.revision).catch(() => undefined);
  }
  // The lease goes back whatever happened; a lost race on this write is harmless (the lease expires).
  const latest = await deps.state.get(key, target.place).catch(() => undefined);
  if (latest?.lease?.holder === deps.holder) await deps.state.put(key, without(latest, "lease") as RepoFileState, latest.revision).catch(() => undefined);
  return result;
}

async function pass(deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, leased: RepoFileState, preset: "standard" | "regulated"): Promise<PassResult> {
  const { host, repository, scope } = target;
  const pathKind = host.pathKind!.bind(host);
  let state = leased;

  // 1. What the last pass left behind: closings and an unrecorded write.
  state = await finishClosings(deps, key, target, state);

  // 2. The open pull request: merged, closed, or still open (and whose).
  let stillOpen = false;
  let personModified = false;
  if (state.open !== undefined) {
    const open = state.open;
    let details;
    try { details = await host.getChangeRequest({ repository, id: open.number, url: open.url }, scope); } catch { throw new Abort("repository_unreadable"); }
    if (details.state === "merged") {
      state = await commit(deps, key, state, (s) => mergedState(s, open));
      // Its branch is Rovara's own unless a person pushed to it.
      if (details.headRevision === open.headRevision) state = await commit(deps, key, state, (s) => ({ ...s, closing: [...s.closing, { branch: open.branch, cause: "merged" as const }] }));
    } else if (details.state === "closed") {
      state = await commit(deps, key, state, (s) => ({
        ...without(s, "open") as RepoFileState, unmerged: s.unmerged + 1,
        closing: details.headRevision === open.headRevision ? [...s.closing, { branch: open.branch, cause: "closed_by_team" as const }] : s.closing,
      }));
    } else {
      stillOpen = true;
      personModified = details.headRevision !== open.headRevision;
    }
    state = await finishClosings(deps, key, target, state);
  }
  // This pass found the open pull request unmerged: it counts once, when the pass finishes.
  const unmerged = state.unmerged + (stillOpen ? 1 : 0);
  const finish = async (extra: Partial<RepoFileState>): Promise<RepoFileState> => commit(deps, key, state, (s) => ({ ...without(s, "problem") as RepoFileState, ...extra, unmerged, lastPassAt: deps.now() }));

  // 3. The repository and its file on the default branch.
  let defaultBranch: string;
  let head: string;
  let fileText: string | undefined;
  try {
    const identity = await host.repositoryIdentity(repository, scope);
    if (identity === undefined) throw new Abort("repository_gone");
    if (identity.defaultBranch === undefined) throw new Abort("repository_unreadable");
    defaultBranch = identity.defaultBranch;
    head = await host.baseBranchHead(repository, defaultBranch, scope);
  } catch (error) { throw error instanceof Abort ? error : new Abort("repository_unreadable"); }
  let kind;
  try { kind = await pathKind(repository, LESSON_FILE_PATH, head, scope); } catch { throw new Abort("file_unreadable"); }
  if (kind === "symlink" || kind === "dir") throw new Abort("file_is_link");
  if (kind === "file") {
    try { fileText = await host.fileAtRevision(repository, LESSON_FILE_PATH, head, scope, { maxBytes: LESSON_FILE_MAX_BYTES }); } catch (error) { throw new Abort(codeOf(error) === "CONFIG_INVALID" ? "file_too_big" : "file_unreadable"); }
    if (fileText === undefined) throw new Abort("file_unreadable");
  }
  if (fileText === undefined && state.fileSeen) {
    // The team deleted it: nothing is retired, nothing re-adds it, the repository waits until someone resumes it.
    await commit(deps, key, state, (s) => ({ ...without(s, "problem") as RepoFileState, fileDeleted: true, lastPassAt: deps.now(), unmerged }));
    return { status: "skipped", reason: "file_deleted" };
  }
  if (fileText !== undefined && !state.fileSeen) state = await commit(deps, key, state, { fileSeen: true });

  // 4. The proposal.
  const lessons = await deps.store.listAllHeads(key);
  let names: readonly string[];
  try { names = await deps.names(key, lessons); } catch { throw new Abort("names_unreadable"); }
  const plan = planRepoFile({ place: target.place, repoName: target.name, lessons, names, fileText, rendered: state.rendered, declined: state.declined, addsPaused: additionsPaused({ unmerged }), preset });
  // What the plan learned about the file is recorded whatever comes next.
  const rendered = { ...state.rendered, ...plan.adopted };
  for (const id of plan.newlyDeclined) delete rendered[id];
  const bounded = Object.fromEntries(Object.entries(rendered).slice(-MAX_RENDERED));
  state = await commit(deps, key, state, { rendered: bounded, declined: boundedAppend(state.declined, plan.newlyDeclined, MAX_DECLINED), held: plan.held.slice(0, MAX_RENDERED) });

  // 5. The pointer: carried by the pull request that proposes it until that one is merged; proposed once.
  const wantsPointer = !state.pointerDeclined && (!state.pointerProposed || state.open?.pointer === true);
  const pointerFiles: Array<{ path: PointerPath; text: string }> = [];
  const found: PointerPath[] = [];
  const links: PointerPath[] = [];
  const currentOf = new Map<PointerPath, string | undefined>();
  for (const path of LESSON_FILE_POINTER_PATHS) {
    try {
      const pathKindOf = await pathKind(repository, path, head, scope);
      if (pathKindOf === "symlink") links.push(path);
      else if (pathKindOf === "file") {
        const text = await host.fileAtRevision(repository, path, head, scope, { maxBytes: 1_000_000 });
        if (text !== undefined) { found.push(path); currentOf.set(path, text); }
      }
    } catch { /* an agent file Rovara cannot read is left out: the pointer goes to the others */ }
  }
  // A pointer proposed earlier and merged but named nowhere now: shown in the status, never edited again.
  const pointerMissing = state.pointerProposed && state.open?.pointer !== true && !state.pointerDeclined && [...currentOf.values()].every((text) => text === undefined || !mentionsLessonsFile(text));
  if (wantsPointer && plan.nextText !== undefined) {
    for (const path of pointerTargets(found, state.pointers, links)) {
      const next = withPointer(path, currentOf.get(path));
      if (next !== undefined) pointerFiles.push({ path, text: next });
    }
  }
  const digest = `${plan.digest}${pointerFiles.length === 0 ? "" : `+${pointerFiles.map((f) => f.path).join(",")}`}`;

  // 6. Decide.
  const nothing = plan.nextText === undefined;
  if (nothing) {
    if (stillOpen && !personModified) {
      const open = state.open!;
      // A pointer that rode in this pull request was never merged: the next pull request proposes it.
      state = await commit(deps, key, state, (s) => ({ ...without(s, "open") as RepoFileState, pointerProposed: open.pointer ? false : s.pointerProposed, closing: [...s.closing, { branch: open.branch, number: open.number, cause: "nothing_left" as const }] }));
      state = await finishClosings(deps, key, target, state);
    }
    await finish({ pointerMissing });
    return { status: stillOpen && personModified ? "waiting_on_team" : "no_changes" };
  }
  if (stillOpen && personModified) { await finish({ pointerMissing }); return { status: "waiting_on_team" }; }
  if (stillOpen && state.open!.digest === digest) { await finish({ pointerMissing }); return { status: "left" }; }

  return openPullRequest(deps, key, target, state, { plan, pointerFiles, digest, head, defaultBranch, fileText, unmerged, pointerMissing, replacing: stillOpen });
}

async function openPullRequest(
  deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, state: RepoFileState,
  work: { plan: RepoFilePlan; pointerFiles: Array<{ path: PointerPath; text: string }>; digest: string; head: string; defaultBranch: string; fileText: string | undefined; unmerged: number; pointerMissing: boolean; replacing: boolean },
): Promise<PassResult> {
  const { host, repository, scope } = target;
  const { plan } = work;
  // The ledger first: if it cannot take the event nothing is written (this week's pull request waits).
  if (!await audited(deps, key, "lesson.repo_file_pr_opened", { removals: plan.removals.length, edits: plan.edits.length, adds: plan.adds.length })) throw new Abort("audit_down");
  const branch = await freshBranch(deps, target);
  // The branch is recorded BEFORE it is made, so a crash between the write and the record leaves a name the next pass deletes, never a branch nobody knows.
  state = await commit(deps, key, state, { pending: { branch, at: deps.now() } });
  let revision: string;
  try {
    const written = await host.commitFiles!({
      repository, branch, baseBranch: work.defaultBranch, message: prTitle(plan), fromBase: true, baseRevision: work.head,
      files: [{ path: LESSON_FILE_PATH, content: plan.nextText! }, ...work.pointerFiles.map((f) => ({ path: f.path, content: f.text }))],
      previous: [{ path: LESSON_FILE_PATH, content: work.fileText ?? null }],
    }, scope);
    revision = written.revision;
  } catch (error) {
    // Nothing was written (or the branch is Rovara's own random name, which the next pass deletes).
    const message = messageOf(error);
    throw new Abort(message === COMMIT_CONFLICT_MESSAGE ? "conflict" : message === COMMIT_SYMLINK_MESSAGE ? "file_is_link" : "write_refused");
  }
  let created;
  try {
    created = await host.reconcileChangeRequest({ repository, sourceBranch: branch, targetBranch: work.defaultBranch, title: prTitle(plan), body: prBody(plan, { pointerFiles: work.pointerFiles.map((f) => f.path), unmerged: work.unmerged }) }, scope);
  } catch { throw new Abort("write_refused"); }
  const previous = state.open;
  const open: OpenPr = {
    branch: branch as OpenPr["branch"], number: created.ref.id, url: created.ref.url, headRevision: revision, baseRevision: work.head, digest: work.digest, openedAt: deps.now(),
    removals: plan.removals.length, edits: plan.edits.length, adds: plan.adds.length,
    added: Object.fromEntries(plan.adds.map((a) => [a.id, a.fingerprint])), edited: Object.fromEntries(plan.edits.map((e) => [e.id, e.fingerprint])), removed: plan.removals.map((r) => r.id),
    pointer: work.pointerFiles.length > 0,
  };
  state = await commit(deps, key, state, (s) => ({
    ...without(s, "pending", "problem") as RepoFileState, open,
    pointerProposed: s.pointerProposed || work.pointerFiles.length > 0,
    pointerMissing: work.pointerFiles.length > 0 ? false : work.pointerMissing,
    unmerged: work.unmerged, lastPassAt: deps.now(),
    closing: previous === undefined ? s.closing : [...s.closing, { branch: previous.branch, number: previous.number, cause: "replaced" as const }],
  }));
  // The previous Rovara pull request comes down after the new one is up: at most one is open when the pass ends.
  await finishClosings(deps, key, target, state);
  return { status: "opened", number: open.number, removals: open.removals, edits: open.edits, adds: open.adds };
}
