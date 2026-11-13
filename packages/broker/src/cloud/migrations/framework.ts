// Convergence D1 pattern (decision 129): ONE shape for every stored-data move Cloud makes on its way onto Rovara Code's core. Staging runs are pre-approved
// (129); production and customer runs still need the owner. Every move is built for customers all the same:
//
//   - a dry run first, which writes nothing and reports exactly what an apply would do (the default: `apply` must be asked for by name);
//   - an apply that is safe to run twice and to stop at any point: every write is one conditional transaction per item, fenced on what the plan read;
//   - a resume file after each page, so a stopped run carries on where it stopped (refused for another move or direction);
//   - a reverse that undoes an apply, found by the marker the apply left (never by guessing);
//   - a conflict report: an item the move cannot decide on, or that changed under it, is listed and left as it is. The run never forces a write.
//
// A move is a plug-in (`DataMove`): where its items come from in each direction, and what to do with one item. The runner owns everything else (paging,
// dry run, fences, resume, the report). A new move is one file in plugins/ and one line in registry.ts.
import type { DocumentKey, DocumentStore, StoredDocument, TransactItem } from "@rovara-code/contracts";

export type MoveDirection = "forward" | "reverse";

/** What to do with one item. */
export type MovePlan =
  | { kind: "write"; steps: readonly TransactItem[]; note?: string }
  /**
   * One write the port cannot say (a DynamoDB string-set DELETE or ADD: the port has no sets, owner decision 60 S2). `apply` makes the write through the
   * move's own client, in one conditional transaction, and answers whether its fence held (false: the item changed under it, as a failed `write` is
   * treated). It is never called in a dry run. A move that uses it also gives `reread`, because the port refuses to read a row that holds a set.
   */
  | { kind: "native"; apply: () => Promise<boolean>; note?: string }
  | { kind: "skip"; reason: string }
  | { kind: "conflict"; reason: string };

export interface MovePage {
  items: readonly StoredDocument[];
  cursor?: string;
}

export interface MoveContext {
  store: DocumentStore;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
}

export interface DataMove {
  /** Stable id, also the resume file's key (`d1-dispatch-partition`). */
  readonly id: string;
  readonly title: string;
  /** `held`: written but not to be run (the report names why); the runner refuses an apply. */
  readonly status: "ready" | "held" | "check-only";
  readonly heldBecause?: string;
  /** Reads an item again after its write was refused (the default is `store.get` of its key). A move whose items the port cannot read gives its own. */
  readonly reread?: (item: StoredDocument, direction: MoveDirection, context: MoveContext) => Promise<StoredDocument | undefined>;
  /** One page of the items to look at in a direction. A move without a reverse leaves `reverse` out (a check, or a move that writes nothing). */
  readonly source: Partial<Record<MoveDirection, (context: MoveContext, cursor: string | undefined) => Promise<MovePage>>>;
  plan(item: StoredDocument, direction: MoveDirection, context: MoveContext): Promise<MovePlan>;
}

export interface ResumeState {
  moveId: string;
  direction: MoveDirection;
  /** The source cursor to carry on from; absent once the run is done. */
  cursor?: string;
  pages: number;
  startedAt: string;
  updatedAt: string;
  done: boolean;
}

/** Where the resume state is kept between runs (a file for the CLI; memory in tests). */
export interface ResumeStore {
  read(): Promise<ResumeState | undefined>;
  write(state: ResumeState): Promise<void>;
}

export interface Conflict { key: DocumentKey; reason: string }

export interface MoveReport {
  moveId: string;
  direction: MoveDirection;
  mode: "dry-run" | "apply";
  scanned: number;
  /** Items an apply writes (dry run) or wrote (apply). */
  writes: number;
  skipped: Record<string, number>;
  conflicts: number;
  /** The first conflicts, with their reason (at most `conflictListMax`). */
  conflictList: Conflict[];
  pages: number;
  /** True when the source is exhausted; false when the run stopped at `maxPages` (run it again: the resume file carries on). */
  done: boolean;
  cursor?: string;
}

export interface RunOptions {
  direction: MoveDirection;
  /** Writes happen only when this is exactly true. */
  apply?: boolean;
  resume?: ResumeStore;
  /** Stop after this many pages (a run is cut into short pieces; the resume file carries on). Default: until done. */
  maxPages?: number;
  conflictListMax?: number;
}

export class DataMoveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataMoveRefused";
  }
}

const keyOf = (item: StoredDocument): DocumentKey => ({ pk: item.pk, sk: item.sk });

/** Runs one move. A dry run reads only. An apply writes each item in its own transaction, re-plans it once if its fence moved, and lists it if it moved again. */
export async function runDataMove(move: DataMove, context: MoveContext, options: RunOptions): Promise<MoveReport> {
  const apply = options.apply === true;
  if (apply && move.status === "held") throw new DataMoveRefused(`${move.id} is held: ${move.heldBecause ?? "no reason given"}`);
  if (apply && move.status === "check-only") throw new DataMoveRefused(`${move.id} is a check: it has nothing to apply`);
  const source = move.source[options.direction];
  if (source === undefined) throw new DataMoveRefused(`${move.id} has no ${options.direction} direction`);

  const now = (): string => context.now().toISOString();
  const previous = await options.resume?.read();
  if (previous !== undefined && (previous.moveId !== move.id || previous.direction !== options.direction)) {
    throw new DataMoveRefused(`the resume file is for ${previous.moveId} ${previous.direction}, not ${move.id} ${options.direction}`);
  }
  // A dry run always reads everything and never moves the resume file on (that would make the apply skip what the dry run only looked at).
  let state: ResumeState = apply && previous !== undefined && !previous.done ? previous : { moveId: move.id, direction: options.direction, pages: 0, startedAt: now(), updatedAt: now(), done: false };
  const report: MoveReport = { moveId: move.id, direction: options.direction, mode: apply ? "apply" : "dry-run", scanned: 0, writes: 0, skipped: {}, conflicts: 0, conflictList: [], pages: 0, done: false };
  const listMax = options.conflictListMax ?? 200;
  const conflict = (item: StoredDocument, reason: string): void => {
    report.conflicts += 1;
    if (report.conflictList.length < listMax) report.conflictList.push({ key: keyOf(item), reason });
  };

  let cursor = state.cursor;
  for (;;) {
    if (options.maxPages !== undefined && report.pages >= options.maxPages) break;
    const page = await source(context, cursor);
    report.pages += 1;
    for (const item of page.items) {
      report.scanned += 1;
      let plan = await move.plan(item, options.direction, context);
      if (plan.kind === "skip") { report.skipped[plan.reason] = (report.skipped[plan.reason] ?? 0) + 1; continue; }
      if (plan.kind === "conflict") { conflict(item, plan.reason); continue; }
      if (!apply) { report.writes += 1; continue; }
      const run = async (write: Exclude<MovePlan, { kind: "skip" | "conflict" }>): Promise<{ applied: boolean }> => (write.kind === "native" ? { applied: await write.apply() } : context.store.transact(write.steps));
      let result = await run(plan);
      if (!result.applied) {
        // The item changed between the read and the write: plan it again from what is there now, once.
        const fresh = await (move.reread === undefined ? context.store.get(keyOf(item)) : move.reread(item, options.direction, context));
        plan = fresh === undefined ? { kind: "skip", reason: "gone before the write" } : await move.plan(fresh, options.direction, context);
        if (plan.kind === "write" || plan.kind === "native") result = await run(plan);
        if (plan.kind === "skip") { report.skipped[plan.reason] = (report.skipped[plan.reason] ?? 0) + 1; continue; }
        if (plan.kind === "conflict") { conflict(item, plan.reason); continue; }
        if (!result.applied) { conflict(item, "changed under the move twice"); continue; }
      }
      report.writes += 1;
    }
    cursor = page.cursor;
    if (apply && options.resume !== undefined) {
      state = { ...state, ...(cursor === undefined ? {} : { cursor }), pages: state.pages + 1, updatedAt: now(), done: cursor === undefined };
      if (cursor === undefined) delete state.cursor;
      await options.resume.write(state);
    }
    if (cursor === undefined) { report.done = true; break; }
  }
  if (cursor !== undefined) report.cursor = cursor;
  context.log({ component: "data_move", event: "data_move.run", moveId: move.id, direction: options.direction, mode: report.mode, scanned: report.scanned, writes: report.writes, conflicts: report.conflicts, done: report.done });
  return report;
}

/** A resume store in memory (tests, and a caller that keeps its own). */
export function memoryResume(initial?: ResumeState): ResumeStore & { state: ResumeState | undefined } {
  const holder: ResumeStore & { state: ResumeState | undefined } = {
    state: initial,
    async read() { return holder.state; },
    async write(state) { holder.state = { ...state }; },
  };
  return holder;
}

/** Pages over one partition of the store (the common source). */
export function partitionSource(pk: string, pageSize = 100) {
  return async (context: MoveContext, cursor: string | undefined): Promise<MovePage> => {
    const page = await context.store.query({ pk, limit: pageSize, ...(cursor === undefined ? {} : { cursor }) });
    return { items: page.items, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
  };
}

/** Pages over several partitions in turn; the cursor names the partition and its own cursor. */
export function partitionsSource(pks: () => Promise<readonly string[]> | readonly string[], pageSize = 100) {
  return async (context: MoveContext, cursor: string | undefined): Promise<MovePage> => {
    const all = await pks();
    const at = cursor === undefined ? { index: 0, inner: undefined as string | undefined } : (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { index: number; inner?: string });
    if (at.index >= all.length) return { items: [] };
    const page = await context.store.query({ pk: all[at.index]!, limit: pageSize, ...(at.inner === undefined ? {} : { cursor: at.inner }) });
    const next = page.cursor !== undefined ? { index: at.index, inner: page.cursor } : at.index + 1 < all.length ? { index: at.index + 1 } : undefined;
    return { items: page.items, ...(next === undefined ? {} : { cursor: Buffer.from(JSON.stringify(next), "utf8").toString("base64url") }) };
  };
}
