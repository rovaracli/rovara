// A deterministic interleaving harness for the erase races (TR-E1 and its siblings). An operation runs against a world whose storage client is wrapped: after the Nth storage call of the
// operation, a COMPLETE erase of a person runs (their markers, scrub, index deletion), then the operation carries on. Run for every N the operation makes, the
// store must not name the person once the erase's delayed second pass has run, whatever N was.
import { expect } from "vitest";
import { ERASE_SWEEP_DELAY_MS, erasePerson } from "../../packages/broker/src/team-record/erase.js";
import { runDeleteWorker } from "../../packages/broker/src/team-record/delete-worker.js";
import { ORG_A, type World } from "./team-record-core.js";
import { deleteDeps, type DeleteWorld } from "./team-record-delete.js";

type Send = (command: unknown) => Promise<unknown>;
const client = (w: World): { send: Send } => w.db as unknown as { send: Send };

export interface Interleave {
  /** Builds a fresh world with everything the operation needs (including the person to be erased). */
  seed: () => Promise<World>;
  /** The operation under test. */
  op: (w: World) => Promise<unknown>;
  /** The erased person's source id. */
  person: string;
  /** Operations that are allowed to throw (a fail-closed repair that asks the queue to redeliver): they are run a second time. */
  retryOnThrow?: boolean;
  /** Runs the delete worker too (a queued replay), after the operation and before the second pass. */
  worker?: boolean;
  /** The erase's delayed second pass has ALREADY run when the operation carries on (a stalled write landing after the pass). */
  passTwoInside?: boolean;
  /** Skip the second pass at the end: whatever the operation did must be clean without it. */
  noPassTwo?: boolean;
}

export async function runWithEraseAfter(spec: Interleave, at: number): Promise<{ calls: number; w: World; d: DeleteWorld; erased: boolean }> {
  const w = await spec.seed();
  const d = deleteDeps(w);
  const real = client(w).send;
  let calls = 0;
  let injecting = false;
  let erased = false;
  client(w).send = async (command: unknown) => {
    const result = await real(command);
    if (injecting) return result;
    calls += 1;
    if (calls === at) {
      injecting = true;
      try {
        expect((await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: spec.person }], projects: ["web"] }, `race-${at}`)).complete).toBe(true);
        erased = true;
        if (spec.passTwoInside === true) { w.clock.ms += ERASE_SWEEP_DELAY_MS + 1; await runDeleteWorker(d.deps, ORG_A); }
      } finally { injecting = false; }
    }
    return result;
  };
  try {
    try { await spec.op(w); } catch (error) { if (spec.retryOnThrow !== true) throw error; await spec.op(w); }
  } finally { client(w).send = real; }
  if (spec.worker === true) await runDeleteWorker(d.deps, ORG_A);
  // Only the erase's own second pass is left to run; nothing else is allowed to repair a store the operation left dirty.
  w.clock.ms += ERASE_SWEEP_DELAY_MS + 1;
  if (at > 0 && spec.noPassTwo !== true) await runDeleteWorker(d.deps, ORG_A);
  return { calls, w, d, erased };
}

/** Every interleaving: the erase lands after each storage call of the operation in turn. Returns the call numbers after which the store still named the person. */
export async function dirtyInterleavings(spec: Interleave): Promise<{ calls: number; dirty: number[] }> {
  const clean = await runWithEraseAfter(spec, 0);
  expect(clean.calls).toBeGreaterThan(2);
  const dirty: number[] = [];
  for (let at = 1; at <= clean.calls; at += 1) {
    const run = await runWithEraseAfter(spec, at);
    expect(run.erased).toBe(true);
    // (the schedule of the erase's own second pass names the person by design until that pass has run)
    const stored = run.w.db.find((item) => !String(item.sk).startsWith("ERASESWEEP#"));
    if (JSON.stringify(stored).includes(spec.person)) dirty.push(at);
  }
  return { calls: clean.calls, dirty };
}
