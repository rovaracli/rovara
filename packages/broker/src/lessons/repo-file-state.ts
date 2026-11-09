// Lessons in the repo, lane R2 (design LESSONS-REPO-FILE-DESIGN.md rev 2 sections 4, 5, 9): what Rovara remembers about ONE repository's `.rovara/lessons.md`, and the store that keeps it.
//
// One small item per project and repository. It holds ids, fingerprints, counts, branch names and times: never a lesson's text, a person or a host's words.
//   - `rendered`: for each lesson id Rovara proposed and a person merged, the fingerprint of the text and section Rovara put in the file. It is how a hand edit is told from Rovara's own text (a block that no longer matches is
//     the team's: Rovara leaves it as written and holds that lesson's edits, until read-back (R3) takes the team's text in).
//   - `declined`: ids the team removed from the file. Never proposed back.
//   - `open`: the one open Rovara pull request (its branch, number, head, what it proposes), `pending`: a branch Rovara decided on and may have made but has not recorded a pull request for, `closing`: pull requests
//     and branches Rovara still has to close and delete.
//   - `unmerged`: weekly pull requests in a row nobody merged (3 pauses additions and edits).
//   - `lease`: the per-repository lease, so two passes never run at once.
// Every write is conditional on the revision that was read (`put`), so a lost race is a plain "someone else wrote" and never an overwrite.
import { z } from "zod";
import { LESSON_FILE_PROBLEMS, LESSON_FILE_UNMERGED_LIMIT, type LessonFileProblem } from "@agentx/contracts";
import type { ScopeKey } from "./store.js";

export const MAX_RENDERED = 400;
export const MAX_DECLINED = 400;
/** Pull requests handed over, and closings waiting. These are bookkeeping, not erasure: an erasure close is its own durable row. Over the cap the state FAILS LOUDLY (`StateFull`), it never drops an entry. */
export const MAX_THEIRS = 20;
const Id = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u);
const Branch = z.string().regex(/^rovara\/lessons-[0-9a-f]{12}$/u);

export const OpenPrSchema = z.object({
  branch: Branch, number: z.string().min(1).max(40), url: z.string().max(2_048),
  /** The branch head Rovara left it at: a different head later means a person pushed to it, and it is theirs. */
  headRevision: z.string().min(7).max(64),
  baseRevision: z.string().min(7).max(64),
  digest: z.string().max(64), openedAt: z.number(),
  removals: z.number().int().min(0), edits: z.number().int().min(0), adds: z.number().int().min(0),
  /** What a merge of this pull request puts in the file: id to fingerprint for adds and edits, and the ids removed. */
  added: z.record(Id, z.string().max(40)), edited: z.record(Id, z.string().max(40)), removed: z.array(Id).max(MAX_RENDERED),
  pointer: z.boolean(),
}).strict();
export type OpenPr = z.infer<typeof OpenPrSchema>;

/**
 * A pull request or branch Rovara still has to close or delete (NOT for an erasure: those are `EraseClose` rows, one per pull request, never in this list). `headRevision` is the head Rovara left the branch at: the pull request is
 * closed and the branch deleted only while the branch is STILL there, read again right before the delete; a head that moved is a person's, and the pull request is then tracked in `theirs`; a head that cannot be read is not known to
 * be Rovara's, so nothing is touched (retried `attempts` times, then handed over, never dropped).
 */
export const ClosingSchema = z.object({
  branch: Branch, number: z.string().min(1).max(40).optional(), cause: z.enum(["replaced", "nothing_left", "switched_off", "merged", "closed_by_team", "lessons_off"]),
  headRevision: z.string().min(7).max(64).optional(), attempts: z.number().int().min(0).max(10).optional(),
  /** The lessons the pull request carried (adds and edits): kept when the entry cannot be finished because a person pushed, so a later erasure still finds the pull request. */
  ids: z.array(Id).max(MAX_RENDERED).optional(),
  /** The pull request is already closed; only the branch is left. */
  closed: z.boolean().optional(),
}).strict();
export type Closing = z.infer<typeof ClosingSchema>;

/**
 * A pull request that adds erased text and must be CLOSED: one durable row per (repository, pull request), written the moment it is known and removed only when the host confirms the pull request is closed (or no longer open).
 * Never part of a capped list. `headRevision` is the head Rovara left its own branch at: the branch is deleted after the close only while it is still there (closing a pull request touches no commit; deleting a branch can).
 * `keepBranch` is for a pull request a person pushed to. Ids and numbers only: no lesson text, no person.
 */
export const EraseCloseSchema = z.object({
  place: z.string().min(3).max(300), number: z.string().min(1).max(40), branch: Branch, headRevision: z.string().min(7).max(64).optional(), keepBranch: z.boolean(), at: z.number(),
}).strict();
export type EraseClose = z.infer<typeof EraseCloseSchema>;

export const RepoFileStateSchema = z.object({
  place: z.string().min(3).max(300),
  /** The project's name for the repository. */
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  /** The agent files the person ticked for the pointer; absent: the ones Rovara finds. */
  pointers: z.array(z.enum(["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"])).max(3).optional(),
  pointerProposed: z.boolean(), pointerDeclined: z.boolean(),
  /** The file has been seen on the default branch (or one of Rovara's pull requests merged): a missing file after that is a deletion by the team. */
  fileSeen: z.boolean(),
  /** The team deleted the file: nothing is proposed until someone resumes. */
  fileDeleted: z.boolean(),
  rendered: z.record(Id, z.string().max(40)),
  declined: z.array(Id).max(MAX_DECLINED),
  held: z.array(Id).max(MAX_RENDERED),
  unmerged: z.number().int().min(0),
  lastPassAt: z.number().optional(),
  open: OpenPrSchema.optional(),
  /** A branch Rovara decided on before it wrote, with the heads Rovara put on it (the base it was made at, and its own commit once written): it is deleted only while it is at one of them. */
  pending: z.object({ branch: Branch, at: z.number(), baseRevision: z.string().min(7).max(64).optional(), headRevision: z.string().min(7).max(64).optional(), attempts: z.number().int().min(0).max(10).optional() }).strict().optional(),
  /** Rovara pull requests a person pushed to (GitHub's "Update branch" counts): they are the team's now and are never touched again, except to be closed by an erasure. While one is open only removals are proposed. */
  theirs: z.array(z.object({ branch: Branch, number: z.string().min(1).max(40), url: z.string().max(2_048), ids: z.array(Id).max(MAX_RENDERED) }).strict()).max(MAX_THEIRS).default([]),
  closing: z.array(ClosingSchema).max(MAX_THEIRS),
  problem: z.enum(LESSON_FILE_PROBLEMS).optional(),
  /** A pointer was proposed and a later pass found no agent file that names the lessons file. */
  pointerMissing: z.boolean(),
  lease: z.object({ holder: z.string().min(1).max(100), until: z.number() }).strict().optional(),
  revision: z.number().int().min(0),
}).strict();
export type RepoFileState = z.infer<typeof RepoFileStateSchema>;

export const newRepoFileState = (place: string, name: string): RepoFileState => ({
  place, name, enabled: false, pointerProposed: false, pointerDeclined: false, fileSeen: false, fileDeleted: false, rendered: {}, declined: [], held: [], unmerged: 0, closing: [], theirs: [], pointerMissing: false, revision: 0,
});

export interface RepoFileStore {
  /** Every repository of the project that has a state. */
  list(key: ScopeKey): Promise<RepoFileState[]>;
  get(key: ScopeKey, place: string): Promise<RepoFileState | undefined>;
  /** Writes the state if the stored revision is `expected` (0: nothing stored yet). Returns the saved copy (revision + 1), or undefined when somebody else wrote first. Throws when the store cannot be reached. */
  put(key: ScopeKey, state: RepoFileState, expected: number): Promise<RepoFileState | undefined>;
  /** The erasure closes still waiting, one row each, for the whole project. Throws when it cannot read. */
  listErase(key: ScopeKey): Promise<EraseClose[]>;
  /** Records (or re-records) one erasure close. Idempotent. Throws when it cannot write: the caller does not call the erasure done. */
  putErase(key: ScopeKey, row: EraseClose): Promise<void>;
  /** Removes a row once the host confirmed the pull request is closed (or was never open). */
  delErase(key: ScopeKey, place: string, number: string): Promise<void>;
}

/** A state that cannot be written as it is (over a cap, or a field that no longer fits its schema): the pass skips the repository and records it, never storing a state it would later read as absent. */
export class StateFull extends Error { constructor(readonly detail = "") { super("the repository's record is full"); } }
/** An item that exists and does not parse is NOT an absent state: reading it throws. */
export class StateUnreadable extends Error { constructor() { super("the repository's record cannot be read"); } }
/** Size of one state item the store accepts (DynamoDB's item limit is 400 KB). */
export const MAX_STATE_BYTES = 300_000;

/** The state as it would be stored, or `StateFull` when it does not fit its schema or the item size. */
export function checkedState(state: RepoFileState): RepoFileState {
  const parsed = RepoFileStateSchema.safeParse(state);
  if (!parsed.success || JSON.stringify(state).length > MAX_STATE_BYTES) throw new StateFull(parsed.success ? "size" : JSON.stringify(parsed.error.issues).slice(0, 300));
  return parsed.data;
}

/** Parses a stored item; undefined when it is not a state this build knows (it is then left alone). */
export function parseRepoFileState(value: unknown): RepoFileState | undefined {
  const parsed = RepoFileStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class InMemoryRepoFileStore implements RepoFileStore {
  readonly items = new Map<string, RepoFileState>();
  readonly erase = new Map<string, EraseClose>();
  failEraseWrites = false;
  async listErase(key: ScopeKey): Promise<EraseClose[]> { return [...this.erase.entries()].filter(([k]) => k.startsWith(`${key.workspaceId}\u0000${key.project}\u0000`)).map(([, v]) => structuredClone(v)); }
  async putErase(key: ScopeKey, row: EraseClose): Promise<void> {
    if (this.failEraseWrites) throw new Error("store down");
    this.erase.set(`${key.workspaceId}\u0000${key.project}\u0000${row.place}\u0000${row.number}`, EraseCloseSchema.parse(row));
  }
  async delErase(key: ScopeKey, place: string, number: string): Promise<void> { this.erase.delete(`${key.workspaceId}\u0000${key.project}\u0000${place}\u0000${number}`); }
  /** Fail the next writes (a test of a store that is down). */
  failPuts = false;
  private keyOf(key: ScopeKey, place: string): string { return `${key.workspaceId}\u0000${key.project}\u0000${place}`; }
  async list(key: ScopeKey): Promise<RepoFileState[]> {
    return [...this.items.entries()].filter(([k]) => k.startsWith(`${key.workspaceId}\u0000${key.project}\u0000`)).map(([, v]) => structuredClone(v)).sort((a, b) => a.place.localeCompare(b.place));
  }
  async get(key: ScopeKey, place: string): Promise<RepoFileState | undefined> {
    const found = this.items.get(this.keyOf(key, place));
    return found === undefined ? undefined : structuredClone(found);
  }
  async put(key: ScopeKey, state: RepoFileState, expected: number): Promise<RepoFileState | undefined> {
    if (this.failPuts) throw new Error("store down");
    const current = this.items.get(this.keyOf(key, state.place));
    if ((current?.revision ?? 0) !== expected) return undefined;
    const saved = { ...structuredClone(checkedState(state)), revision: expected + 1 };
    this.items.set(this.keyOf(key, state.place), saved);
    return structuredClone(saved);
  }
}

/** Whether new lessons and edits are paused: this many weekly pull requests in a row went unmerged. */
export const additionsPaused = (state: Pick<RepoFileState, "unmerged">): boolean => state.unmerged >= LESSON_FILE_UNMERGED_LIMIT;

/** The ids a map or list holds, bounded (the oldest go first). */
export function boundedAppend(list: readonly string[], more: readonly string[], max: number): string[] {
  const out = [...new Set([...list, ...more])];
  return out.length > max ? out.slice(out.length - max) : out;
}

export type { LessonFileProblem };

/** Adds to a bookkeeping list that has a cap: over it the state FAILS LOUDLY (`StateFull`) instead of dropping an entry. */
export function appended<T>(list: readonly T[], entry: T, max = MAX_THEIRS): T[] {
  if (list.length >= max) throw new StateFull();
  return [...list, entry];
}
