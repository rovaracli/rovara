// Review items 4, 5 and 8: an actor erased while their row is being written (even after the erase's delayed second pass), and a repair that cannot finish.
import { describe, expect, it } from "vitest";
import { markAccessErased } from "../../../packages/broker/src/team-record/access.js";
import { ORG_A, addSource, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { dirtyInterleavings, runWithEraseAfter } from "../../support/erase-interleave.js";

const T1 = "2026-10-30T09:00:00.000Z";
const SC = "slack:T1/C50";
const acl = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: SC, principals, capturedAt: T1, liveCheck: "none" as const } });
const rowBy = (actor: string, id: string, principals: string[]) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, occurredAt: T1, sourceRef: { system: "T1", id, version: "1" }, audience: acl(principals), actor: { sourceId: actor, trust: "member" }, text: "launch plan", links: [] });
const seeded = async (): Promise<World> => { const w = world(); await addSource(w, { source: "slack", scope: SC }); return w; };

describe("an actor erased while their row is being written", () => {
  it("the row is hidden and removed by the put itself, with no second pass at all", async () => {
    const result = await dirtyInterleavings({ person: "UX", seed: seeded, op: (w) => w.sink.put(rowBy("UX", "a1", ["U1"])), retryOnThrow: true, noPassTwo: true });
    expect(result.dirty).toEqual([]);
  });
  it("the same when the erase's second pass has already run before the write lands", async () => {
    const result = await dirtyInterleavings({ person: "UX", seed: seeded, op: (w) => w.sink.put(rowBy("UX", "a2", ["U1"])), retryOnThrow: true, passTwoInside: true });
    expect(result.dirty).toEqual([]);
  });
  it("the draft is refused as actor_erased when the erase lands after the first check", async () => {
    let outcome: unknown;
    const run = await runWithEraseAfter({ person: "UX", seed: seeded, op: async (w) => { outcome = await w.sink.put(rowBy("UX", "a3", ["U1"])); }, noPassTwo: true }, 5);
    expect(run.erased).toBe(true);
    expect(outcome).toMatchObject({ status: "refused", reason: "actor_erased" });
    expect(rows(run.w, "TEAM_RECORD_EVENT")).toHaveLength(0);
  });
});

describe("a repair that cannot finish fails closed", () => {
  it("a row whose audience cannot be parsed is hidden before the error is reported", async () => {
    const w = await seeded();
    const real = (w.db as unknown as { send: (c: unknown) => Promise<unknown> }).send;
    (w.db as unknown as { send: (c: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      const result = await real(command);
      // a row older than the keyword index's late margin is stored in a transaction with its late marker: the row is the first Put of it
      const input = (command as { input?: { Item?: { entityType?: string; pk?: string; sk?: string }; TransactItems?: Array<{ Put?: { Item?: { entityType?: string; pk?: string; sk?: string } } }> } }).input;
      const item = input?.Item ?? input?.TransactItems?.[0]?.Put?.Item;
      if (item?.entityType === "TEAM_RECORD_EVENT" && item.pk !== undefined && item.sk !== undefined) {
        // right after the row is stored: its audience is damaged and its list's person is erased
        const stored = w.db.get({ pk: item.pk, sk: item.sk }) as Record<string, unknown>;
        w.db.set({ ...stored, audience: "damaged" });
        await markAccessErased(w.table, ORG_A, ["UX"], T1);
      }
      return result;
    };
    await expect(w.sink.put(rowBy("U1", "r5", ["U1", "UX"]))).rejects.toBeDefined();
    (w.db as unknown as { send: (c: unknown) => Promise<unknown> }).send = real;
    const [row] = rows(w, "TEAM_RECORD_EVENT");
    expect(row).toMatchObject({ tombstone: { cause: "person_erased" } });
    expect(row?.text).toBeUndefined();
  });
});
