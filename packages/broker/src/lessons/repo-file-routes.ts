// Lessons in the repo, lane R2 (design rev 2 section 9): the status of a project's lessons files and the maintainer's switches, as plain functions the route layer (`routes.ts`) and the CLI's API calls use. Fixed words only.
//   status:  every repository of the project with its row (switched on or not, the open pull request, unmerged count, removals waiting, held lessons, pointer, problem, notices) and the repositories not yet switched on.
//   actions: on / off (the open pull request is closed and its branch deleted; the merged file stays), resume (after the team deleted the file), pointer_add ("add it back"), pointer_decline ("don't ask again").
// Switching on or off is audited BEFORE it changes. Nothing here calls a host except `off` (closing Rovara's own pull request); the first pull request is opened by the next nightly pass, within a day.
import { resolveLearning, modeAllows, requireAudit } from "./policy.js";
import type { LessonsRepoFileBody, LessonsRepoFileRow, LessonsRepoFileStatus } from "@agentx/contracts";
import type { RepoFileRuntime } from "./repo-file-job.js";
import { finishClosings, switchRepoFileOff, type RepoFileTarget } from "./repo-file-pass.js";
import { rowOf } from "./repo-file-pr.js";
import { newRepoFileState, type Closing, type RepoFileState } from "./repo-file-state.js";
import type { ScopeKey } from "./store.js";

export type RepoFileActionResult = { ok: true; row: LessonsRepoFileRow } | { ok: false; code: "not_found" | "host_cannot_write" | "audit_unavailable" | "conflict" | "unreadable" };

const canWrite = (target: RepoFileTarget): boolean => target.host.commitFiles !== undefined && target.host.deleteBranch !== undefined && target.host.pathKind !== undefined;

export async function repoFileStatus(runtime: RepoFileRuntime, key: ScopeKey): Promise<LessonsRepoFileStatus> {
  const resolved = await resolveLearning(runtime.deps.settings, key.workspaceId, key.project);
  const states = await runtime.deps.state.list(key);
  const targets = await runtime.targets(key.workspaceId, key.project);
  const rows = states.filter((state) => state.enabled || state.open !== undefined || state.fileDeleted).map((state) => {
    const row = rowOf(state);
    const target = targets.find((candidate) => candidate.place === state.place);
    return target === undefined ? { ...row, problem: "repository_gone" as const, notices: [...row.notices, "This repository is no longer part of the project"] } : row;
  });
  const shown = new Set(states.filter((state) => state.enabled || state.open !== undefined || state.fileDeleted).map((state) => state.place));
  return {
    lessonsOff: !modeAllows(resolved.mode, "load"),
    canEnable: targets.some(canWrite),
    repos: rows,
    available: targets.filter((target) => !shown.has(target.place) && canWrite(target)).map((target) => target.name),
  };
}

/** One switch or answer for one repository, by the project's name for it. */
export async function repoFileAction(runtime: RepoFileRuntime, key: ScopeKey, body: LessonsRepoFileBody): Promise<RepoFileActionResult> {
  let target: RepoFileTarget | undefined;
  try { target = (await runtime.targets(key.workspaceId, key.project)).find((candidate) => candidate.name === body.repo); } catch { return { ok: false, code: "unreadable" }; }
  if (target === undefined) return { ok: false, code: "not_found" };
  const deps = { ...runtime.deps, holder: runtime.newHolder?.() ?? "route" };
  const existing = await deps.state.get(key, target.place);
  const state = existing ?? newRepoFileState(target.place, target.name);
  const save = async (next: typeof state) => deps.state.put(key, next, existing?.revision ?? 0);
  try {
    if (body.action === "on") {
      if (!canWrite(target)) return { ok: false, code: "host_cannot_write" };
      if (state.enabled) return { ok: true, row: rowOf(state) };
      if (!await requireAudit(deps.audit, { action: "lesson.repo_file_switched", workspaceId: key.workspaceId, project: key.project, facts: { enabled: true } })) return { ok: false, code: "audit_unavailable" };
      const saved = await save({ ...state, name: target.name, enabled: true, ...(body.pointers === undefined ? {} : { pointers: body.pointers }) });
      return saved === undefined ? { ok: false, code: "conflict" } : { ok: true, row: rowOf(saved) };
    }
    if (existing === undefined) return { ok: false, code: "not_found" };
    if (body.action === "off") {
      if (!existing.enabled && existing.open === undefined && existing.closing.length === 0) return { ok: true, row: rowOf(existing) };
      if (!await requireAudit(deps.audit, { action: "lesson.repo_file_switched", workspaceId: key.workspaceId, project: key.project, facts: { enabled: false } })) return { ok: false, code: "audit_unavailable" };
      return { ok: true, row: rowOf(await switchRepoFileOff(deps, key, target, existing)) };
    }
    // Resume: the team deleted the file and wants Rovara to start again; the next pass proposes it afresh. Pointer answers.
    const next = body.action === "resume" ? { ...existing, fileDeleted: false, fileSeen: false, held: [] } : body.action === "pointer_add"
      ? { ...existing, pointerProposed: false, pointerDeclined: false, pointerMissing: false } : { ...existing, pointerDeclined: true, pointerMissing: false };
    const saved = await save(next);
    return saved === undefined ? { ok: false, code: "conflict" } : { ok: true, row: rowOf(saved) };
  } catch { return { ok: false, code: "conflict" }; }
}

/**
 * A lesson was deleted or erased (`repo-file-hook.ts`): if Rovara's open pull request for any repository of the project adds or edits it, that pull request is closed and its branch deleted at once (audited first), so the text never
 * reaches the default branch. A pull request a person pushed to is theirs and is left. The next weekly pass opens a fresh one. Closing is retried by the next pass when the host or the ledger is down.
 */
export async function closeOpenPullRequestFor(runtime: RepoFileRuntime, key: ScopeKey, lessonId: string): Promise<void> {
  const carries = (state: RepoFileState): boolean => (state.open !== undefined && (state.open.added[lessonId] !== undefined || state.open.edited[lessonId] !== undefined)) || state.theirs.some((t) => t.ids.includes(lessonId));
  const states = (await runtime.deps.state.list(key)).filter(carries);
  if (states.length === 0) return;
  const targets = await runtime.targets(key.workspaceId, key.project);
  const deps = { ...runtime.deps, holder: runtime.newHolder?.() ?? "erasure" };
  for (const state of states) {
    const target = targets.find((candidate) => candidate.place === state.place);
    if (target === undefined) continue;
    const closesOpen = state.open !== undefined && (state.open.added[lessonId] !== undefined || state.open.edited[lessonId] !== undefined);
    const entries: Closing[] = [];
    if (state.open !== undefined && closesOpen) {
      const open = state.open;
      // Rovara's own, as far as the host can say: close it and take its branch down. A head that moved or cannot be read: close the pull request only (the commits and the branch stay, so nothing is lost).
      const ours = await target.host.getChangeRequest({ repository: target.repository, id: open.number, url: open.url }, target.scope).then((details) => details.headRevision === open.headRevision, () => false);
      entries.push(ours ? { branch: open.branch, number: open.number, cause: "erased", headRevision: open.headRevision } : { branch: open.branch, number: open.number, cause: "erased", keepBranch: true });
    }
    for (const theirs of state.theirs.filter((t) => t.ids.includes(lessonId))) entries.push({ branch: theirs.branch, number: theirs.number, cause: "erased", keepBranch: true });
    // The weekly clock is reset so the next nightly pass opens a fresh pull request without the lesson.
    const { open: _open, lastPassAt: _last, ...rest } = state;
    void _open; void _last;
    const next: RepoFileState = { ...rest, ...(state.open === undefined || closesOpen ? {} : { open: state.open }), theirs: state.theirs.filter((t) => !t.ids.includes(lessonId)), closing: [...state.closing, ...entries] };
    const saved = await deps.state.put(key, next, state.revision);
    if (saved !== undefined) await finishClosings(deps, key, target, saved);
  }
}
