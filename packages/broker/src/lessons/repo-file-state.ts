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

export const ClosingSchema = z.object({ branch: Branch, number: z.string().min(1).max(40).optional(), cause: z.enum(["replaced", "nothing_left", "switched_off", "erased", "merged", "closed_by_team"]), keepBranch: z.boolean().optional() }).strict();
export type Closing = z.infer<typeof ClosingSchema>;

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
  pending: z.object({ branch: Branch, at: z.number() }).strict().optional(),
  closing: z.array(ClosingSchema).max(10),
  problem: z.enum(LESSON_FILE_PROBLEMS).optional(),
  /** A pointer was proposed and a later pass found no agent file that names the lessons file. */
  pointerMissing: z.boolean(),
  lease: z.object({ holder: z.string().min(1).max(100), until: z.number() }).strict().optional(),
  revision: z.number().int().min(0),
}).strict();
export type RepoFileState = z.infer<typeof RepoFileStateSchema>;

export const newRepoFileState = (place: string, name: string): RepoFileState => ({
  place, name, enabled: false, pointerProposed: false, pointerDeclined: false, fileSeen: false, fileDeleted: false, rendered: {}, declined: [], held: [], unmerged: 0, closing: [], pointerMissing: false, revision: 0,
});

export interface RepoFileStore {
  /** Every repository of the project that has a state. */
  list(key: ScopeKey): Promise<RepoFileState[]>;
  get(key: ScopeKey, place: string): Promise<RepoFileState | undefined>;
  /** Writes the state if the stored revision is `expected` (0: nothing stored yet). Returns the saved copy (revision + 1), or undefined when somebody else wrote first. Throws when the store cannot be reached. */
  put(key: ScopeKey, state: RepoFileState, expected: number): Promise<RepoFileState | undefined>;
}

/** Parses a stored item; undefined when it is not a state this build knows (it is then left alone). */
export function parseRepoFileState(value: unknown): RepoFileState | undefined {
  const parsed = RepoFileStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class InMemoryRepoFileStore implements RepoFileStore {
  readonly items = new Map<string, RepoFileState>();
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
    const saved = { ...structuredClone(state), revision: expected + 1 };
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
