// TR-E1 (probe20): the put-versus-erase race, closed for EVERY interleaving. A put reads the erased markers (to strip erased ids from the row's list), writes the access record,
// then writes the row. An erase can run completely between any two of those storage calls. The test injects a full erase after the Nth storage call of the put, for every N the put
// makes (found by counting a clean run), and after the delayed second pass the store must not name the erased person, whatever N was.
import { describe, expect, it } from "vitest";
import { ERASE_SWEEP_DELAY_MS, erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { ORG_A, addSource, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const SC = "slack:T1/C20";
const acl = (principals: string[], capturedAt: string) => ({ kind: "restricted" as const, acl: { source: "slack", scope: SC, principals, capturedAt, liveCheck: "none" as const } });
const slackRow = (id: string, principals: string[], actor: string, at: string) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, occurredAt: at, sourceRef: { system: "T1", id, version: "1" }, audience: acl(principals, at), actor: { sourceId: actor, trust: "member" }, text: "launch plan", links: [] });
const everything = (w: World): string => JSON.stringify(w.db.find(() => true));

/** A world with one earlier row naming UX (so the place has an access record and an index item for UX). */
async function seeded(): Promise<World> {
  const w = world();
  await addSource(w, { source: "slack", scope: SC });
  await w.sink.put(slackRow("m1", ["U1", "UX"], "U1", T1));
  return w;
}

type Send = (command: unknown) => Promise<unknown>;

/** Runs the put of a second row naming UX; after storage call number `at` (1-based; 0 = never) a complete erase of UX runs. Returns how many calls the put made and the world. */
async function putWithEraseAfter(at: number): Promise<{ calls: number; w: World; erased: boolean }> {
  const w = await seeded();
  const d = deleteDeps(w);
  const real = w.db.send as Send;
  let calls = 0;
  let injecting = false;
  let erased = false;
  (w.db as unknown as { send: Send }).send = async (command: unknown) => {
    const result = await real(command);
    if (injecting) return result;
    calls += 1;
    if (calls === at) {
      injecting = true;
      try {
        expect((await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "UX" }], projects: ["web"] }, `race-${at}`)).complete).toBe(true);
        erased = true;
      } finally { injecting = false; }
    }
    return result;
  };
  await w.sink.put(slackRow("m2", ["U1", "UX"], "U1", T2));
  (w.db as unknown as { send: Send }).send = real;
  // Only the erase's own second pass is left to run; nothing else is allowed to repair a store the put left dirty.
  w.clock.ms += ERASE_SWEEP_DELAY_MS + 1;
  if (at > 0) await runDeleteWorker(d.deps, ORG_A);
  return { calls, w, erased };
}

describe("TR-E1 put versus erase", () => {
  it("whatever storage call of the put the erase lands after, no row names the erased person once the second pass has run", async () => {
    const clean = await putWithEraseAfter(0);
    expect(clean.calls).toBeGreaterThan(3);
    const dirty: number[] = [];
    for (let at = 1; at <= clean.calls; at += 1) {
      const run = await putWithEraseAfter(at);
      expect(run.erased).toBe(true);
      if (everything(run.w).includes("UX")) dirty.push(at);
    }
    expect(dirty).toEqual([]);
  });

  it("the stale-read case on its own: the row is rewritten without the id even before the second pass", async () => {
    // Call 1 of the put is its first marker read. The erase lands right after it, so the row is built from a stale list.
    const { w } = await (async () => {
      const w = await seeded();
      const d = deleteDeps(w);
      const real = w.db.send as Send;
      let armed = true;
      (w.db as unknown as { send: Send }).send = async (command: unknown) => {
        const result = await real(command);
        if (armed && (command as { constructor: { name: string } }).constructor.name === "BatchGetCommand") {
          armed = false;
          await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "UX" }], projects: ["web"] }, "stale");
        }
        return result;
      };
      await w.sink.put(slackRow("m2", ["U1", "UX"], "U1", T2));
      (w.db as unknown as { send: Send }).send = real;
      return { w };
    })();
    const events = rows(w, "TEAM_RECORD_EVENT");
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("UX");
  });

  it("a repair that fails is retried by the queue: the redelivered draft finds the row already stored and still cleans it", async () => {
    const w = await seeded();
    const d = deleteDeps(w);
    const real = w.db.send as Send;
    let armed = true;
    let failRepair = true;
    let erasing = false;
    (w.db as unknown as { send: Send }).send = async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "UpdateCommand" && !armed && !erasing && failRepair && JSON.stringify((command as { input: unknown }).input).includes("audience")) { failRepair = false; throw new Error("throttled"); }
      const result = await real(command);
      if (armed && name === "BatchGetCommand") {
        armed = false;
        erasing = true;
        await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "UX" }], projects: ["web"] }, "retry");
        erasing = false;
      }
      return result;
    };
    await expect(w.sink.put(slackRow("m2", ["U1", "UX"], "U1", T2))).rejects.toBeDefined();
    expect(JSON.stringify(rows(w, "TEAM_RECORD_EVENT"))).toContain("UX"); // the row is there and dirty until the retry
    await w.sink.put(slackRow("m2", ["U1", "UX"], "U1", T2)); // the queue redelivers the same draft
    (w.db as unknown as { send: Send }).send = real;
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(2);
    expect(JSON.stringify(rows(w, "TEAM_RECORD_EVENT"))).not.toContain("UX");
  });

  it("a person who is not erased keeps their place in the list, and a clean put makes no extra write", async () => {
    const w = await seeded();
    const before = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT").length;
    await w.sink.put(slackRow("m2", ["U1", "UX"], "U1", T2));
    const events = rows(w, "TEAM_RECORD_EVENT") as Array<{ audience: { acl: { principals: string[] } } }>;
    expect(events).toHaveLength(before + 1);
    expect(events.map((event) => event.audience.acl.principals)).toEqual([["U1", "UX"], ["U1", "UX"]]);
  });
});
