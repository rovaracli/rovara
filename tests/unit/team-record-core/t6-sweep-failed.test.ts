// Task 6 (source-row lane): TR-E2b a failing sweep step is reported, not swallowed.
import { describe, expect, it } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { ORG_A, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";


describe("TR-E2b a failing sweep step is reported, not swallowed", () => {
  it("the run summary counts it, a fixed-code log is written, the sweep items stay, and the rest of the run still works", async () => {
    const w = world();
    const d = deleteDeps(w);
    const real = w.table.documentClient;
    let fail = true;
    const broken = { ...d.deps, table: { ...w.table, documentClient: { send: async (command: unknown) => {
      if (fail && command instanceof QueryCommand && JSON.stringify((command as { input?: unknown }).input).includes("ERASESWEEP#")) throw new Error("secret detail from the table");
      return (real as unknown as { send(c: unknown): Promise<unknown> }).send(command);
    } } as never } };
    const run = await runDeleteWorker(broken, ORG_A);
    expect(run.sweepFailed).toBe(1);
    expect(run.erasureSweeps).toEqual({ ran: 0, final: 0 });
    expect(d.logs.filter((line) => line.includes("record.erase_sweep_failed"))).toHaveLength(1);
    expect(d.logs.join("\n")).not.toContain("secret detail");
    fail = false;
    expect((await runDeleteWorker(broken, ORG_A)).sweepFailed).toBe(0); // the next run tries again
  });
});

