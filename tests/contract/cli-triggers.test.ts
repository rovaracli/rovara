// Plan 4 Task 18: `agentx chains triggers …` and `agentx agents triggers …` against a fake control plane: the requests each command sends, what it prints, and that
// turning a trigger on is only ever a link to the confirmation page (R66).
import { afterEach, describe, expect, it } from "vitest";
import { UUID, agentsCli, cleanHarnessDirs } from "../support/agents-cli-harness.js";

afterEach(cleanHarnessDirs);

const CHN = "chn_aaaaaaaaaaaaaaaaaaaa";
const AGT = "agt_bbbbbbbbbbbbbbbbbbbb";
const TRG = "ctr_cccccccccccccccccccc";
const DEV = "d".repeat(64);
const CELL_URL = "https://abc123.execute-api.us-west-2.amazonaws.com";
const CONFIRM = `${CELL_URL}/v1/app/approve/apr_dddddddddddddddddddd`;
const PR = { kind: "event", source: "github", type: "pull_request.opened", filter: { label: ["bug", "p1"] } };
const trigger = (extra: Record<string, unknown> = {}) => ({
  triggerId: TRG, target: { kind: "chain", chainId: CHN }, project: "web", spec: PR, enabled: true, maxRunsPerHour: 30, createdBy: { developerId: DEV, name: "Maya" },
  createdAt: "2026-10-22T09:00:00.000Z", updatedAt: "2026-10-22T09:00:00.000Z", ...extra,
});

describe.each([["chains", "chain", CHN], ["agents", "agent", AGT]] as const)("agentx %s triggers", (kind, noun, id) => {
  const base = `/v1/app/${kind}/${id}/triggers`;

  it("lists a target's triggers with what starts them, whether they are on and why one is off", async () => {
    const h = await agentsCli({
      [`GET ${base}`]: Response.json({ triggers: [trigger(), trigger({ triggerId: "ctr_eeeeeeeeeeeeeeeeeeee", enabled: false, disabledReason: "set a run limit", spec: { kind: "schedule", schedule: { kind: "daily", at: "09:00", days: ["MON"] }, timezone: "UTC", missed: "skip" } })] }),
    });
    expect(await h.run([kind, "triggers", "list", id])).toBe(0);
    expect(h.stdout()).toContain(TRG);
    expect(h.stdout()).toContain("github pull_request.opened where label is bug or p1");
    expect(h.stdout()).toContain("off (set a run limit)");
    expect(h.stdout()).toContain("daily at 09:00 on MON (UTC)");
  });

  it("says a target with no triggers has none and how to add one", async () => {
    const h = await agentsCli({ [`GET ${base}`]: Response.json({ triggers: [] }) });
    expect(await h.run([kind, "triggers", "list", id])).toBe(0);
    expect(h.stdout()).toContain(`has no triggers`);
    expect(h.stdout()).toContain(`agentx ${kind} triggers set`);
    expect(noun).toBeDefined();
  });

  it("sets a trigger from a file, and prints the confirmation link when it waits for a person, with nothing decided here", async () => {
    const h = await agentsCli({ [`PUT ${base}/${TRG}`]: new Response(JSON.stringify({ status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM, changes: ["turn on github pull request opened for web"] }), { status: 202, headers: { "content-type": "application/json" } }) });
    const file = await h.file("spec.json", PR);
    expect(await h.run([kind, "triggers", "set", id, "--trigger-id", TRG, "--project", "web", "--file", file, "--max-runs-per-hour", "10"])).toBe(0);
    expect(h.calls).toEqual([{ method: "PUT", path: `${base}/${TRG}`, query: "", body: { requestId: expect.stringMatching(UUID) as string, project: "web", spec: PR, maxRunsPerHour: 10 } }]);
    expect(h.stdout()).toContain("turned off until a person confirms it");
    expect(h.stdout()).toContain(CONFIRM);
    expect(h.stdout()).toContain("turn on github pull request opened for web");
  });

  it("adds a new trigger with an ID of its own, stores it off with --off, and sends a hook when one is named", async () => {
    const h = await agentsCli({ [`PUT ${base}/${TRG}`]: Response.json({ trigger: trigger({ enabled: false }) }, { status: 201 }) });
    const file = await h.file("spec.json", PR);
    h.calls.length = 0;
    const answered = await h.run([kind, "triggers", "set", id, "--trigger-id", TRG, "--project", "web", "--file", file, "--hook", `hk_${"a".repeat(26)}`, "--off"]);
    expect(answered).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, project: "web", spec: PR, hookId: `hk_${"a".repeat(26)}`, enabled: false });
    expect(h.stdout()).toContain("off");
    const fresh = await agentsCli({});
    const spec = await fresh.file("spec.json", PR);
    expect(await fresh.run([kind, "triggers", "set", id, "--project", "web", "--file", spec])).not.toBe(0);
    expect(fresh.calls[0]!.path).toMatch(new RegExp(`^${base}/ctr_[0-9a-z]{20}$`));
  });

  it("refuses without a project or a readable spec, and sends nothing", async () => {
    const h = await agentsCli({});
    const file = await h.file("spec.json", PR);
    expect(await h.run([kind, "triggers", "set", id, "--file", file])).not.toBe(0);
    expect(await h.run([kind, "triggers", "set", id, "--project", "web", "--file", `${h.home}/missing.json`])).not.toBe(0);
    expect(await h.run([kind, "triggers", "set", id, "--project", "web"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("prints a refusal as the broker wrote it", async () => {
    const h = await agentsCli({ [`PUT ${base}/${TRG}`]: Response.json({ error: { code: "CHAIN_BUDGET_REQUIRED", message: "CHAIN_BUDGET_REQUIRED: Triage has no monthly budget and run limit, so events and schedules can't start it. Ask its owner to set both." } }, { status: 409 }) });
    const file = await h.file("spec.json", PR);
    expect(await h.run([kind, "triggers", "set", id, "--trigger-id", TRG, "--project", "web", "--file", file])).not.toBe(0);
    expect(h.stderr()).toContain("has no monthly budget and run limit");
  });

  it("removes a trigger and prints its activity, newest first, neutralised for a terminal", async () => {
    const h = await agentsCli({
      [`DELETE ${base}/${TRG}`]: Response.json({ deleted: true }),
      [`GET ${base}/${TRG}/activity`]: Response.json({ activity: [
        { at: "2026-10-22T09:05:00.000Z", eventKey: "github:2", outcome: "disabled", reason: "Triage's trigger was turned off\u001b[31m now" },
        { at: "2026-10-22T09:00:00.000Z", eventKey: "github:1", outcome: "started", runId: "crn_aaaaaaaaaaaaaaaaaaaa" },
      ] }),
    });
    expect(await h.run([kind, "triggers", "remove", id, TRG])).toBe(0);
    expect(h.calls[0]).toEqual({ method: "DELETE", path: `${base}/${TRG}`, query: "", body: { requestId: expect.stringMatching(UUID) as string } });
    expect(h.stdout()).toContain(`Removed trigger ${TRG}`);
    expect(await h.run([kind, "triggers", "activity", id, TRG])).toBe(0);
    const text = h.stdout();
    expect(text.indexOf("disabled")).toBeLessThan(text.indexOf("started"));
    expect(text).toContain("run crn_aaaaaaaaaaaaaaaaaaaa");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("[U+001B]");
  });
});
