// SRL-4 (owner decision 24b): a Rovara event takes its audience from the task's Plan 5 visibility when it is WRITTEN, and the task's shares or People list can be narrowed later. So a row about a task is
// also checked against the task's LIVE visibility every time it is read. The reader must pass BOTH the audience the row was recorded with and the live one (an intersection: a task shared more widely
// later never widens an old row). Everything here fails closed: a task whose visibility cannot be read (gone, another company's, an error, a timeout, past the per-request bound) shows NOTHING from its rows.
//
// This file is pure (no AWS); the State-table port is `live-audience-port.ts`. The one place that applies it is `acl.ts#filterVisible`, which every read of the record ends in.
import type { Audience, OrgId } from "@agentx/contracts";
import type { TaskVisibility } from "./sources/rovara.js";
import type { ReadAudience } from "./types.js";

/** The most distinct tasks one request looks up. A task past it reads as unreadable (its rows are hidden), never as visible. */
export const LIVE_TASKS_PER_REQUEST_MAX = 100;
/** How long one batched lookup may take before every task in it reads as unreadable. */
export const LIVE_TASK_READ_TIMEOUT_MS = 5_000;

/** The live Plan 5 visibility of tasks. A task missing from the answer, or mapped to `undefined`, is unreadable. May throw: that reads as unreadable for every task asked about. */
export interface TaskVisibilityPort {
  read(orgId: OrgId, taskIds: readonly string[]): Promise<ReadonlyMap<string, TaskVisibility | undefined>>;
}

/** The parts of a row (an event, a fact, a lesson) that name a Rovara task. */
export interface LiveRow {
  audience: Audience;
  source?: string | undefined;
  scope?: string | undefined;
  scopes?: readonly string[] | undefined;
  restrictedScopes?: readonly string[] | undefined;
  sourceRef?: { system: string; id: string } | undefined;
  derivedFrom?: readonly string[] | undefined;
  structured?: Readonly<Record<string, string | number | boolean>> | undefined;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const TASK_SOURCE_ID = /^task:([^:]*)/;
const TASK_DERIVED = /^rovara:task:([^:]*)/;
const TASK_PLACE = /^rovara:task\/([^/]*)/;

export interface TaskRefs {
  taskIds: string[];
  /** The row says it is about a Rovara task but no task can be read from it, or one of its task ids is malformed: it is hidden. */
  unreadable: boolean;
}

/**
 * The tasks a row is about, or undefined when it is not about a Rovara task. A row is about a task when it is a Rovara event (`source` or `sourceRef.system` is `rovara`: the task is in its source id
 * `task:<id>...` or its structured `taskId`), a fact distilled from one (`derivedFrom` `rovara:task:<id>...`), or something learned at a task place (`rovara:task/<id>` among the places or the snapshot's scope).
 */
export function rovaraTaskRefsOf(row: LiveRow): TaskRefs | undefined {
  const ids = new Set<string>();
  let touched = false;
  let unreadable = false;
  const take = (id: string | undefined): boolean => {
    if (id !== undefined && TASK_ID.test(id)) { ids.add(id); return true; }
    return false;
  };
  if (row.source === "rovara" || row.sourceRef?.system === "rovara") {
    touched = true;
    const fromId = TASK_SOURCE_ID.exec(row.sourceRef?.id ?? "")?.[1];
    const fromField = row.structured?.taskId;
    const gotId = take(fromId);
    const gotField = typeof fromField === "string" ? take(fromField) : false;
    if (!gotId && !gotField) unreadable = true;
  }
  for (const entry of row.derivedFrom ?? []) {
    const match = TASK_DERIVED.exec(entry);
    if (match === null) continue;
    touched = true;
    if (!take(match[1])) unreadable = true;
  }
  const places = [row.scope, ...(row.scopes ?? []), ...(row.restrictedScopes ?? []), ...(row.audience.kind === "restricted" ? [row.audience.acl.scope] : [])];
  for (const place of places) {
    const match = place === undefined ? null : TASK_PLACE.exec(place);
    if (match === null) continue;
    touched = true;
    if (!take(match[1])) unreadable = true;
  }
  return touched ? { taskIds: [...ids], unreadable } : undefined;
}

/** Whether a reader may read the rows of a task whose live visibility is `visibility`. The project reads a shared task's rows; a list reads its own; the owner reads a private task's. */
export function mayReadTask(audience: ReadAudience, visibility: TaskVisibility): boolean {
  if (visibility.kind === "shared") return true;
  if (audience.kind === "shared") return false;
  const developerId = audience.caller.developerId;
  return visibility.kind === "private" ? visibility.ownerDeveloperId === developerId : visibility.developerIds.includes(developerId);
}

export type LiveVerdict = "allow" | "deny" | "unreadable";

/** One reader per request: it asks the port once for each distinct task (in batches as rows are filtered) and remembers the answers for the rest of the request. */
export interface LiveAudienceReader {
  load(taskIds: Iterable<string>): Promise<void>;
  /** `unreadable` when any named task has no answer (gone, error, timeout, past the bound); else `deny` when any denies this reader; else `allow`. Call `load` first. */
  verdictOf(audience: ReadAudience, taskIds: readonly string[]): LiveVerdict;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("team-record: the task visibility lookup timed out")); }, ms); });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createLiveAudienceReader(orgId: OrgId, port: TaskVisibilityPort | undefined, options: { timeoutMs?: number | undefined; maxTasks?: number | undefined } = {}): LiveAudienceReader {
  const maxTasks = options.maxTasks ?? LIVE_TASKS_PER_REQUEST_MAX;
  const answers = new Map<string, TaskVisibility | undefined>();
  return {
    async load(taskIds) {
      const fresh: string[] = [];
      for (const id of taskIds) {
        if (answers.has(id) || fresh.includes(id)) continue;
        // Past the bound a task is asked about no more: it stays unanswered, which reads as unreadable.
        if (answers.size + fresh.length >= maxTasks) break;
        fresh.push(id);
      }
      if (fresh.length === 0) return;
      for (const id of fresh) answers.set(id, undefined);
      if (port === undefined) return;
      let found: ReadonlyMap<string, TaskVisibility | undefined>;
      try {
        found = await withTimeout(port.read(orgId, fresh), options.timeoutMs ?? LIVE_TASK_READ_TIMEOUT_MS);
      } catch {
        return;
      }
      for (const id of fresh) answers.set(id, found.get(id));
    },
    verdictOf(audience, taskIds) {
      let verdict: LiveVerdict = "allow";
      for (const id of taskIds) {
        const visibility = answers.get(id);
        if (visibility === undefined) return "unreadable";
        if (!mayReadTask(audience, visibility)) verdict = "deny";
      }
      return verdict;
    },
  };
}
