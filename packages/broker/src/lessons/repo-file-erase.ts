// Lessons in the repo, lane R2 (design rev 2 section 10; review rounds 1-4): the ERASURE SWEEP. When a lesson is erased or withdrawn in Rovara, text of it may be in the customer's repository: in a Rovara pull request still open, or in
// the lessons file on the default branch (a block Rovara merged, or one a person copied). The sweep takes it out, and it is built so that nothing else can stop it:
//   - It reads ONLY the repository's default-branch lessons file, `LessonStore.goneOf` (the durable per-lesson tombstone the deletion itself writes first, one row each, never evicted), the pull request rows (`PrRowStore`: one row
//     per Rovara-made pull request, apart from the publish state) and the code host. It is handed no publish state and never calls it, so a missing, unparseable, full or leased state, a failing `list`, a lost lease or a failing publish
//     pass cannot reach it. One repository's failure never touches another's.
//   - A Rovara pull request that ADDS a gone lesson is CLOSED (closing touches no commit), whatever its branch head is; it stays tracked (its row is kept for 90 days) so one a person reopens is closed again. Its branch is deleted only
//     while it is still at the head Rovara left it at (a delete can lose a person's commit; a close cannot).
//   - A block in the default branch's file that carries a gone lesson's marker is removed by a REMOVAL-ONLY pull request on its own random branch: nothing is adopted, the ref moves without force, the commit's parent is the head the file
//     was read at, the file only shrinks (so no cap applies), and it has its own row. An open one that already covers the blocks is left alone.
//   - Every host write is audited first; a ledger that is down skips the write (it is tried again at the next sweep).
// No model call. Provider-neutral: everything outside lessons code is the `CodeHost` port.
import { randomBytes } from "node:crypto";
import { LESSON_FILE_MAX_BYTES, LESSON_FILE_PATH } from "@agentx/contracts";
import { applyFileChanges, parseLessonsFile } from "./repo-file-format.js";
import { freshBranchName, headOf, type RepoFileTarget } from "./repo-file-host.js";
import { requireAudit } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import type { PrRow, PrRowStore } from "./repo-file-state.js";
import type { LessonStore, ScopeKey } from "./store.js";

/** What the sweep is handed. Note what is NOT here: no publish state. */
export interface EraseSweepDeps {
  store: Pick<LessonStore, "goneOf">;
  rows: PrRowStore;
  audit: LessonAuditSink;
  now(): number;
  randomHex?(): string;
  log?(event: string, fields: Record<string, string | number>): void;
}
/** The sweep's dependencies out of the pass's: only the lesson store's tombstone lookup, the pull request rows, the ledger and the clock. The publish state is left behind on purpose. */
export function sweepDepsOf(deps: { store: Pick<LessonStore, "goneOf">; state: PrRowStore; rows?: PrRowStore; audit: LessonAuditSink; now(): number; randomHex?(): string; log?(event: string, fields: Record<string, string | number>): void }): EraseSweepDeps {
  return { store: deps.store, rows: deps.rows ?? deps.state, audit: deps.audit, now: () => deps.now(), randomHex: () => deps.randomHex?.() ?? randomBytes(6).toString("hex"), log: (event, fields) => deps.log?.(event, fields) };
}
export interface EraseSweepResult { closed: number; removalOpened: boolean; failures: number }

/** A closed pull request's row is kept this long, so one a person reopens is found and closed again. */
export const CLOSED_ROW_KEEP_MS = 90 * 86_400_000;
/** A row of a pull request never seen closed is dropped after this long (a Rovara pull request open for over a year is stale). */
export const OPEN_ROW_KEEP_MS = 400 * 86_400_000;

const audited = (deps: EraseSweepDeps, key: ScopeKey, action: "lesson.repo_file_pr_opened" | "lesson.repo_file_pr_closed", facts: Record<string, string | number | boolean>): Promise<boolean> =>
  requireAudit(deps.audit, { action, workspaceId: key.workspaceId, project: key.project, facts });

/** Closes one row's pull request (and takes its branch down only while it is still Rovara's). True when the pull request is closed or was not open. */
async function closeRow(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget, row: PrRow, cause: string): Promise<boolean> {
  const { host, repository, scope } = target;
  if (row.branch === undefined) return true;
  const details = await host.getChangeRequest({ repository, id: row.number, url: "" }, scope).then((d) => d, () => undefined);
  if (details !== undefined && details.state !== "open") {
    // Merged or closed by someone else: nothing to close. Remembered as closed (kept 90 days, so a reopened one is still found); a merged one's text is the file's, taken out by half two.
    if (row.closedAt === undefined) await deps.rows.putPr(key, { ...row, closedAt: deps.now() });
    return true;
  }
  if (!await audited(deps, key, "lesson.repo_file_pr_closed", { cause, pullRequest: Number(row.number) || 0 })) return false;
  await host.updateChangeRequest({ repository, id: row.number, url: "" }, { state: "closed" }, scope);
  await deps.rows.putPr(key, { ...row, closedAt: deps.now() });
  // The branch, after the close, and only while it is still the head Rovara left: closing touches no commit, deleting a branch can.
  if (row.headRevision !== undefined && host.deleteBranch !== undefined && await headOf(target, row.branch) === row.headRevision && await headOf(target, row.branch) === row.headRevision) await host.deleteBranch(repository, row.branch, scope).catch(() => undefined);
  return true;
}

/** Half one: Rovara pull requests that add a gone lesson are closed. */
async function closeErasedAdds(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget, rows: readonly PrRow[], result: EraseSweepResult): Promise<void> {
  const adds = rows.filter((row) => row.kind === "adds" && row.ids.length > 0);
  if (adds.length === 0) return;
  const gone = await deps.store.goneOf(key, [...new Set(adds.flatMap((row) => row.ids))]);
  for (const row of adds) {
    if (!row.ids.some((id) => gone.has(id))) continue;
    try { if (await closeRow(deps, key, target, row, "erased") && row.closedAt === undefined) result.closed += 1; } catch { result.failures += 1; deps.log?.("lessons_repo_file.erase_close_failed", {}); }
  }
}

/** Half two: blocks of gone lessons on the default branch come out through a removal-only pull request. */
async function removeErasedBlocks(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget, rows: readonly PrRow[], result: EraseSweepResult): Promise<void> {
  const { host, repository, scope } = target;
  if (host.commitFiles === undefined || host.pathKind === undefined) return;
  const identity = await host.repositoryIdentity(repository, scope);
  if (identity?.defaultBranch === undefined) return;
  const head = await host.baseBranchHead(repository, identity.defaultBranch, scope);
  if (await host.pathKind(repository, LESSON_FILE_PATH, head, scope) !== "file") return;
  const text = await host.fileAtRevision(repository, LESSON_FILE_PATH, head, scope, { maxBytes: LESSON_FILE_MAX_BYTES });
  if (text === undefined) return;
  const parsed = parseLessonsFile(text);
  const ids = [...new Set(parsed.blocks.map((block) => block.id))].filter((id) => !parsed.duplicates.includes(id));
  if (ids.length === 0) return;
  const gone = await deps.store.goneOf(key, ids);
  const inFile = ids.filter((id) => gone.has(id));
  if (inFile.length === 0) return;
  // An open removal pull request that already covers every one of them is enough.
  for (const row of rows.filter((r) => r.kind === "removal" && r.closedAt === undefined && inFile.every((id) => r.ids.includes(id)))) {
    const details = await host.getChangeRequest({ repository, id: row.number, url: "" }, scope).then((d) => d, () => undefined);
    if (details === undefined || details.state === "open") return;
  }
  const next = applyFileChanges(text, { remove: inFile, replace: [], add: [] });
  if (next === text || host.deleteBranch === undefined) return;
  if (!await audited(deps, key, "lesson.repo_file_pr_opened", { removals: inFile.length, edits: 0, adds: 0 })) return;
  const branch = await freshBranchName(deps, target);
  if (branch === undefined) { result.failures += 1; return; }
  const written = await host.commitFiles({ repository, branch, baseBranch: identity.defaultBranch, message: "Rovara: remove erased lessons", fromBase: true, baseRevision: head, files: [{ path: LESSON_FILE_PATH, content: next }], previous: [{ path: LESSON_FILE_PATH, content: text }] }, scope);
  const created = await host.reconcileChangeRequest({
    repository, sourceBranch: branch, targetBranch: identity.defaultBranch, title: `Rovara: remove ${String(inFile.length)} erased ${inFile.length === 1 ? "lesson" : "lessons"}`,
    body: `Rovara removes ${String(inFile.length)} ${inFile.length === 1 ? "lesson" : "lessons"} from \`.rovara/lessons.md\` that ${inFile.length === 1 ? "was" : "were"} deleted in Rovara. Nothing else changes. Nothing changes until a person merges this pull request; the lessons stay in git history.`,
  }, scope);
  const at = deps.now();
  await deps.rows.putPr(key, { place: target.place, kind: "removal", number: created.ref.id, branch, headRevision: written.revision, ids: inFile, at });
  await deps.rows.putPr(key, { place: target.place, kind: "watch", number: "0", ids: [], at });
  result.removalOpened = true;
  // Older removal pull requests this one covers come down (closing is safe; their branches only while still Rovara's).
  for (const old of rows.filter((r) => r.kind === "removal" && r.closedAt === undefined && r.ids.every((id) => inFile.includes(id)))) { try { await closeRow(deps, key, target, old, "replaced"); } catch { /* tried again next sweep */ } }
}

/**
 * One repository's erasure sweep. Each half runs on its own: a failure of one is counted and the other still runs. Never throws.
 */
export async function sweepErasures(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget): Promise<EraseSweepResult> {
  const result: EraseSweepResult = { closed: 0, removalOpened: false, failures: 0 };
  let rows: PrRow[];
  try { rows = (await deps.rows.listPrs(key)).rows.filter((row) => row.place === target.place); } catch { rows = []; result.failures += 1; deps.log?.("lessons_repo_file.erase_rows_unreadable", {}); }
  // A repository Rovara has never written to (no row of any kind) has nothing of its to take out: no host call.
  if (rows.length === 0) return result;
  try { await closeErasedAdds(deps, key, target, rows, result); } catch { result.failures += 1; deps.log?.("lessons_repo_file.erase_sweep_failed", {}); }
  try { await removeErasedBlocks(deps, key, target, rows, result); } catch { result.failures += 1; deps.log?.("lessons_repo_file.erase_removal_failed", {}); }
  // Rows of closed pull requests are kept for 90 days (a reopened one is closed again); older ones, and merged ones (their text is the file's, taken out by half two), go.
  try {
    for (const row of rows) {
      if (row.kind === "watch" || row.branch === undefined) continue;
      if (deps.now() - (row.closedAt ?? row.at) > (row.closedAt === undefined ? OPEN_ROW_KEEP_MS : CLOSED_ROW_KEEP_MS)) await deps.rows.delPr(key, row.place, row.number);
    }
  } catch { /* bookkeeping only */ }
  return result;
}

/** A project is archived: every open Rovara pull request of the repository is closed (nothing is left in the customer's repository that Rovara can still take down). Independent of the publish state, like the sweep. */
export async function closeAllRovaraPrs(deps: EraseSweepDeps, key: ScopeKey, target: RepoFileTarget): Promise<number> {
  let closed = 0;
  const rows = await deps.rows.listPrs(key).then((listed) => listed.rows.filter((row) => row.place === target.place && row.kind !== "watch" && row.closedAt === undefined), () => [] as PrRow[]);
  for (const row of rows) { try { if (await closeRow(deps, key, target, row, "switched_off")) closed += 1; } catch { /* the project is going away; nothing more to do */ } }
  return closed;
}
