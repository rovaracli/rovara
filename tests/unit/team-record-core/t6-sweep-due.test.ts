// Task 6 (source-row lane): TR-E2a the erase second pass keeps its first due time and expires.
import { describe, expect, it } from "vitest";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { ERASE_SWEEP_DELAY_MS, erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { ORG_A, addSource, githubDraft, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const EXPIRY_MS = 7 * 86_400_000;
const sweepItems = (w: ReturnType<typeof world>) => w.db.find((item) => typeof item.sk === "string" && item.sk.startsWith("ERASESWEEP#")) as Array<{ sk: string; dueAt: number; indexExpiresAt?: number }>;

describe("TR-E2a the erase's second pass keeps its first due time, and the item expires", () => {
  it("re-running a completed erase does not push the due time out; the item carries an expiry a week after it is due", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C1" });
    await w.sink.put(githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id: "m1", version: "1" }, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T1/C1", principals: ["U1", "UX"], capturedAt: "2026-10-30T09:00:00.000Z", liveCheck: "none" } }, text: "hello" }));
    const d = deleteDeps(w);
    const who = { identities: [{ system: "slack:T1", sourceId: "UX" }], projects: ["web"] };
    const first = await erasePerson(d.deps, ORG_A, who, "occ-1");
    expect(first).toMatchObject({ complete: true, final: false });
    const [item] = sweepItems(w);
    expect(item!.dueAt).toBe(w.clock.ms + ERASE_SWEEP_DELAY_MS);
    expect(item!.indexExpiresAt).toBe(Math.floor((item!.dueAt + EXPIRY_MS) / 1000));
    // the same erase again, later (a retry, a resumed job)
    w.clock.ms += 10 * 60_000;
    const again = await erasePerson(d.deps, ORG_A, who, "occ-1");
    expect(again.sweepDueAt).toBe(first.sweepDueAt);
    expect(sweepItems(w)).toHaveLength(1);
    expect(sweepItems(w)[0]!.dueAt).toBe(item!.dueAt);
    // it is still due on the first time
    w.clock.ms = item!.dueAt + 1;
    const run = await runDeleteWorker(d.deps, ORG_A);
    expect(run.erasureSweeps).toEqual({ ran: 1, final: 1 });
  });
});

