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
import { textHash } from "./repo-file-format.js";
import { prBody, prTitle } from "./repo-file-pr.js";
import { MAX_DECLINED, MAX_RENDERED, additionsPaused, boundedAppend, boundedClosings, boundedTheirs, type Closing, type OpenPr, type RepoFileState, type RepoFileStore } from "./repo-file-state.js";
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
  | { status: "no_changes" | "left" }
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

/** The head of a branch, or undefined when the host cannot say (a branch that is gone and a host that is down look the same, and neither is "Rovara's own"). */
const headOf = (target: RepoFileTarget, branch: string): Promise<string | undefined> => target.host.baseBranchHead(target.repository, branch, target.scope).then((head) => head, () => undefined);
/** A closing is given up after this many passes in which the branch could not be read. */
const CLOSING_ATTEMPTS = 3;

/** The lessons an open pull request carries (adds and edits), kept on a closing so a later erasure can still find a pull request that could not be finished. */
const carriedBy = (open: OpenPr): string[] => [...Object.keys(open.added), ...Object.keys(open.edited)];

/**
 * Closes Rovara's own pull requests and deletes its own branches that are waiting in `closing`, and the branch of a pending write that was never recorded. Each close or delete is audited first; one that fails stays for the next pass.
 *   - CLOSING a pull request touches no commit, so it is always safe for an erasure (`erased`: closed whatever the branch head is, retried until the host confirms, never dropped). For the other causes it is done only while the head
 *     is still the one Rovara left; a pull request a person pushed to is theirs and moves to `theirs` (with the lessons it carried), never dropped from tracking.
 *   - DELETING a branch needs proof it is Rovara's own (review M1): the head is read again right before the delete and the branch goes only while it is still the head Rovara left (for a write that was never recorded, a head Rovara
 *     itself wrote). A head that moved is a person's and is kept; one that cannot be read is not known to be Rovara's, so nothing is deleted and the entry is tried again a few times.
 */
export async function finishClosings(deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, state: RepoFileState): Promise<RepoFileState> {
  let current = state;
  const { host, repository, scope } = target;
  if (current.pending !== undefined) {
    const pending = current.pending;
    const head = await headOf(target, pending.branch);
    // A branch Rovara decided on before it wrote: it may exist (made and never recorded), at the base it was made at or at its own commit; deleting it also closes any pull request made from it. A branch at any other head is not touched;
    // one that cannot be read (gone and down look alike) is tried again a few times, not dropped at once.
    const ours = head !== undefined && (head === pending.baseRevision || head === pending.headRevision);
    try {
      if (head === undefined) {
        const attempts = (pending.attempts ?? 0) + 1;
        current = await commit(deps, key, current, (s) => (attempts >= CLOSING_ATTEMPTS ? without(s, "pending") : { ...s, pending: { ...pending, attempts } }));
      } else if (!ours) {
        current = await commit(deps, key, current, (s) => without(s, "pending"));
      } else if (host.deleteBranch !== undefined && await audited(deps, key, "lesson.repo_file_pr_closed", { cause: "replaced", pullRequest: 0 })) {
        if (await headOf(target, pending.branch) === head) await host.deleteBranch(repository, pending.branch, scope);
        current = await commit(deps, key, current, (s) => without(s, "pending"));
      }
    } catch (error) { if (error instanceof Abort) throw error; deps.log?.("lessons_repo_file.pending_cleanup_failed", {}); }
  }
  for (const entry of [...current.closing]) {
    const same = (c: { branch: string; number?: string | undefined }): boolean => c.branch === entry.branch && c.number === entry.number;
    const replace = async (next: Closing | undefined): Promise<void> => { current = await commit(deps, key, current, (s) => ({ ...s, closing: next === undefined ? s.closing.filter((c) => !same(c)) : s.closing.map((c) => (same(c) ? next : c)) })); };
    /** The pull request is the team's now (or cannot be proved Rovara's): tracked in `theirs`, with the lessons it carried. */
    const handOver = async (): Promise<void> => {
      current = await commit(deps, key, current, (s) => ({ ...s, closing: s.closing.filter((c) => !same(c)), theirs: entry.number === undefined ? s.theirs : boundedTheirs([...s.theirs, { branch: entry.branch, number: entry.number, url: "", ids: entry.ids ?? [] }]) }));
    };
    try {
      let working = entry;
      // 1. The pull request.
      if (entry.number !== undefined && entry.closed !== true) {
        if (entry.cause !== "erased" && entry.keepBranch !== true) {
          const head = await headOf(target, entry.branch);
          if (head === undefined) {
            const attempts = (entry.attempts ?? 0) + 1;
            if (attempts >= CLOSING_ATTEMPTS) await handOver(); else await replace({ ...entry, attempts });
            continue;
          }
          if (entry.headRevision === undefined || head !== entry.headRevision) { await handOver(); continue; }
        }
        if (!await audited(deps, key, "lesson.repo_file_pr_closed", { cause: entry.cause, pullRequest: Number(entry.number) || 0 })) continue;
        await host.updateChangeRequest({ repository, id: entry.number, url: "" }, { state: "closed" }, scope);
        working = { ...entry, closed: true };
        await replace(working);
      }
      // 2. The branch.
      if (working.keepBranch === true || working.headRevision === undefined || host.deleteBranch === undefined) { await replace(undefined); continue; }
      const head = await headOf(target, working.branch);
      if (head === undefined) {
        const attempts = (working.attempts ?? 0) + 1;
        if (attempts >= CLOSING_ATTEMPTS) await replace(undefined); else await replace({ ...working, attempts });
        continue;
      }
      if (head === working.headRevision) {
        if (working.closed !== true && !await audited(deps, key, "lesson.repo_file_pr_closed", { cause: working.cause, pullRequest: 0 })) continue;
        // Read again right before the delete: a push since the read above leaves the branch alone.
        if (await headOf(target, working.branch) === working.headRevision) await host.deleteBranch(repository, working.branch, scope);
      }
      await replace(undefined);
    } catch (error) {
      if (error instanceof Abort) throw error;
      deps.log?.("lessons_repo_file.close_failed", {});
    }
  }
  return current;
}

/** Switching a repository off: the open pull request and its branch come down (when they are still Rovara's own), nothing more is proposed, the merged file stays. Returns the saved state. */
export async function switchRepoFileOff(deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, state: RepoFileState): Promise<RepoFileState> {
  let current = await commit(deps, key, state, { enabled: false });
  if (current.open !== undefined) {
    const open = current.open;
    // The closing checks the head again before it touches anything: a pull request a person pushed to is theirs and is left alone.
    current = await commit(deps, key, current, (s) => ({ ...without(s, "open") as RepoFileState, closing: [...s.closing, { branch: open.branch, number: open.number, cause: "switched_off" as const, headRevision: open.headRevision, ids: carriedBy(open) }] }));
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
    // The host answers for a branch that exists and throws for one that does not.
    const exists = await target.host.baseBranchHead(target.repository, branch, target.scope).then(() => true, () => false);
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
  const { host } = target;
  // Decision 47: while lessons are off (the install's switch, the project's mode) nothing is delivered: no pull request, no close, no read.
  const learning = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(learning.mode, "load")) {
    // Nothing is delivered, but what Rovara already put up comes down: its open pull request is closed and leftover closings are finished (closing is not delivery).
    const left = await deps.state.get(key, target.place).catch(() => undefined);
    if (left !== undefined && (left.open !== undefined || left.closing.length > 0 || left.pending !== undefined)) {
      try {
        let current = left;
        if (current.open !== undefined) { const open = current.open; current = await commit(deps, key, current, (s) => ({ ...without(s, "open") as RepoFileState, closing: [...s.closing, { branch: open.branch, number: open.number, cause: "lessons_off" as const, headRevision: open.headRevision, ids: carriedBy(open) }] })); }
        await finishClosings(deps, key, target, current);
      } catch { deps.log?.("lessons_repo_file.lessons_off_close_failed", {}); }
    }
    return { status: "skipped", reason: "lessons_off" };
  }
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
  if (state.open !== undefined) {
    const open = state.open;
    let details;
    try { details = await host.getChangeRequest({ repository, id: open.number, url: open.url }, scope); } catch { throw new Abort("repository_unreadable"); }
    if (details.state === "merged") {
      state = await commit(deps, key, state, (s) => mergedState(s, open));
      // Its branch is Rovara's own unless a person pushed to it (the closing checks the head again before it deletes).
      state = await commit(deps, key, state, (s) => ({ ...s, closing: [...s.closing, { branch: open.branch, cause: "merged" as const, headRevision: open.headRevision }] }));
    } else if (details.state === "closed") {
      state = await commit(deps, key, state, (s) => ({
        ...without(s, "open") as RepoFileState, unmerged: s.unmerged + 1,
        closing: [...s.closing, { branch: open.branch, cause: "closed_by_team" as const, headRevision: open.headRevision }],
      }));
    } else if (details.headRevision !== open.headRevision) {
      // A person pushed to it (GitHub's "Update branch" counts): it is the team's now. It stays open, untouched, and Rovara stops treating it as its own; it counts as one more pull request nobody merged. Removals still go out in a new
      // pull request (and only removals while the team's one is open), because a removal must never wait on a branch Rovara may not write (review H2).
      state = await commit(deps, key, state, (s) => ({
        ...without(s, "open") as RepoFileState, unmerged: s.unmerged + 1,
        theirs: boundedTheirs([...s.theirs, { branch: open.branch, number: open.number, url: open.url, ids: carriedBy(open) }]),
      }));
    } else stillOpen = true;
    state = await finishClosings(deps, key, target, state);
  }
  // Pull requests handed over earlier: one still open keeps additions and edits waiting; one that was merged or closed is forgotten.
  let teamPr = false;
  if (state.theirs.length > 0) {
    const still: typeof state.theirs = [];
    const merged: string[] = [];
    for (const theirs of state.theirs) {
      let details;
      try { details = await host.getChangeRequest({ repository, id: theirs.number, url: theirs.url }, scope); } catch { throw new Abort("repository_unreadable"); }
      if (details.state === "open") still.push(theirs);
      // Merged by the team: what it put in the file is Rovara's lessons' text under the team's wording. The ids become known to Rovara (with a fingerprint nothing matches, so the wording is the team's and held), so an erasure that
      // comes later still reaches the block.
      else if (details.state === "merged") merged.push(...theirs.ids);
    }
    if (merged.length > 0) state = await commit(deps, key, state, (s) => ({ ...s, rendered: { ...Object.fromEntries(merged.map((id) => [id, "merged-by-team"])), ...s.rendered } }));
    teamPr = still.length > 0;
    if (still.length !== state.theirs.length) state = await commit(deps, key, state, { theirs: still });
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
  const plan = planRepoFile({ place: target.place, repoName: target.name, lessons, names, fileText, rendered: state.rendered, declined: state.declined, erased: state.erased, addsPaused: additionsPaused({ unmerged }), teamPr, preset });
  // What the plan learned about the file is recorded whatever comes next.
  const rendered = { ...state.rendered, ...plan.adopted };
  for (const id of plan.newlyDeclined) delete rendered[id];
  const bounded = Object.fromEntries(Object.entries(rendered).slice(-MAX_RENDERED));
  state = await commit(deps, key, state, { rendered: bounded, declined: boundedAppend(state.declined, plan.newlyDeclined, MAX_DECLINED), held: plan.held.slice(0, MAX_RENDERED) });

  // 5. The pointer: carried by the pull request that proposes it until that one is merged; proposed once. Every agent file is read, and a read that FAILS is never "absent" (review H1): a pass that could not read one of them
  // writes no pointer this time (the lessons are still proposed), and every file that is written is written under the text it was read as (`previous`), so a change made in between is a conflict, never an overwrite.
  const wantsPointer = !state.pointerDeclined && (!state.pointerProposed || state.open?.pointer === true);
  const pointerFiles: Array<{ path: PointerPath; text: string; previous: string | null }> = [];
  const found: PointerPath[] = [];
  const links: PointerPath[] = [];
  const currentOf = new Map<PointerPath, string>();
  // A failed read of AGENTS.md or CLAUDE.md stops the pointer for this pass (it could hide the very file the pointer belongs in). A Copilot file that cannot be read (say `.github` is a link) only leaves that file out, so one
  // unreadable path never blocks the pointer for ever.
  let pointerReadFailed = false;
  const unreadable: PointerPath[] = [];
  for (const path of LESSON_FILE_POINTER_PATHS) {
    try {
      const pathKindOf = await pathKind(repository, path, head, scope);
      if (pathKindOf === "symlink") links.push(path);
      else if (pathKindOf === "file") {
        const text = await host.fileAtRevision(repository, path, head, scope, { maxBytes: 1_000_000 });
        if (text === undefined) throw new Error("unreadable");
        found.push(path); currentOf.set(path, text);
      } else if (pathKindOf === "dir") throw new Error("unreadable");
    } catch { unreadable.push(path); if (path !== ".github/copilot-instructions.md") pointerReadFailed = true; }
  }
  // A pointer proposed earlier and merged but named nowhere now: shown in the status, never edited again. Said only when every file could be read.
  const pointerMissing = unreadable.length === 0 ? state.pointerProposed && state.open?.pointer !== true && !state.pointerDeclined && [...currentOf.values()].every((text) => !mentionsLessonsFile(text)) : state.pointerMissing;
  if (wantsPointer && plan.nextText !== undefined && !pointerReadFailed) {
    for (const path of pointerTargets(found, state.pointers, [...links, ...unreadable])) {
      const next = withPointer(path, currentOf.get(path));
      if (next !== undefined) pointerFiles.push({ path, text: next, previous: currentOf.get(path) ?? null });
    }
  }
  // The row says so when the pointer is waiting on a file that cannot be read.
  const pointerProblem = wantsPointer && pointerReadFailed ? { problem: "pointer_unreadable" as const } : {};
  // The digest covers the file on the default branch and each pointer file it would write: a change the team made there rebuilds a pull request computed on the old text (review M3).
  const digest = `${plan.digest}|f:${textHash(fileText ?? "")}${pointerFiles.map((f) => `|${f.path}:${textHash(f.previous ?? "")}`).join("")}`;

  // 6. Decide.
  if (plan.nextText === undefined) {
    if (stillOpen) {
      const open = state.open!;
      // A pointer that rode in this pull request was never merged: the next pull request proposes it.
      state = await commit(deps, key, state, (s) => ({ ...without(s, "open") as RepoFileState, pointerProposed: open.pointer ? false : s.pointerProposed, closing: [...s.closing, { branch: open.branch, number: open.number, cause: "nothing_left" as const, headRevision: open.headRevision, ids: carriedBy(open) }] }));
      state = await finishClosings(deps, key, target, state);
    }
    await finish({ pointerMissing, ...pointerProblem });
    return { status: "no_changes" };
  }
  if (stillOpen && state.open!.digest === digest) { await finish({ pointerMissing, ...pointerProblem }); return { status: "left" }; }

  return openPullRequest(deps, key, target, state, { plan, pointerFiles, digest, head, defaultBranch, fileText, unmerged, pointerMissing, pointerProblem });
}

async function openPullRequest(
  deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, state: RepoFileState,
  work: { plan: RepoFilePlan; pointerFiles: Array<{ path: PointerPath; text: string; previous: string | null }>; digest: string; head: string; defaultBranch: string; fileText: string | undefined; unmerged: number; pointerMissing: boolean; pointerProblem: { problem?: "pointer_unreadable" } },
): Promise<PassResult> {
  const { host, repository, scope } = target;
  const { plan } = work;
  // The ledger first: if it cannot take the event nothing is written (this week's pull request waits).
  if (!await audited(deps, key, "lesson.repo_file_pr_opened", { removals: plan.removals.length, edits: plan.edits.length, adds: plan.adds.length })) throw new Abort("audit_down");
  // A leftover pending write the cleanup could not settle yet is not lost: it becomes a closing, tried again like any other.
  if (state.pending !== undefined) {
    const stray = state.pending;
    state = await commit(deps, key, state, (s) => ({ ...without(s, "pending") as RepoFileState, closing: boundedClosings([...s.closing, { branch: stray.branch, cause: "replaced" as const, headRevision: stray.headRevision ?? stray.baseRevision, attempts: stray.attempts ?? 0 }]) }));
  }
  const branch = await freshBranch(deps, target);
  // The branch is recorded BEFORE it is made, so a crash between the write and the record leaves a name the next pass deletes, never a branch nobody knows.
  state = await commit(deps, key, state, { pending: { branch, at: deps.now(), baseRevision: work.head } });
  let revision: string;
  try {
    const written = await host.commitFiles!({
      repository, branch, baseBranch: work.defaultBranch, message: prTitle(plan), fromBase: true, baseRevision: work.head,
      files: [{ path: LESSON_FILE_PATH, content: plan.nextText! }, ...work.pointerFiles.map((f) => ({ path: f.path, content: f.text }))],
      previous: [{ path: LESSON_FILE_PATH, content: work.fileText ?? null }, ...work.pointerFiles.map((f) => ({ path: f.path, content: f.previous }))],
    }, scope);
    revision = written.revision;
    // The head Rovara itself wrote, so a cleanup of a pull request that was never recorded can tell its own branch from a person's.
    state = await commit(deps, key, state, (s) => ({ ...s, pending: { branch, at: deps.now(), baseRevision: work.head, headRevision: revision } }));
  } catch (error) {
    if (error instanceof Abort) throw error;
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
    branch, number: created.ref.id, url: created.ref.url, headRevision: revision, baseRevision: work.head, digest: work.digest, openedAt: deps.now(),
    removals: plan.removals.length, edits: plan.edits.length, adds: plan.adds.length,
    added: Object.fromEntries(plan.adds.map((a) => [a.id, a.fingerprint])), edited: Object.fromEntries(plan.edits.map((e) => [e.id, e.fingerprint])), removed: plan.removals.map((r) => r.id),
    pointer: work.pointerFiles.length > 0,
  };
  state = await commit(deps, key, state, (s) => ({
    ...without(s, "pending", "problem") as RepoFileState, ...work.pointerProblem, open,
    pointerProposed: s.pointerProposed || work.pointerFiles.length > 0,
    pointerMissing: work.pointerFiles.length > 0 ? false : work.pointerMissing,
    unmerged: work.unmerged, lastPassAt: deps.now(),
    closing: previous === undefined ? s.closing : [...s.closing, { branch: previous.branch, number: previous.number, cause: "replaced" as const, headRevision: previous.headRevision, ids: carriedBy(previous) }],
  }));
  // The previous Rovara pull request comes down after the new one is up: at most one is open when the pass ends.
  await finishClosings(deps, key, target, state);
  return { status: "opened", number: open.number, removals: open.removals, edits: open.edits, adds: open.adds };
}
