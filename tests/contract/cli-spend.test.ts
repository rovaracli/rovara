// Plan 3 Task 35a: `agentx agents budget` and `agentx project ai set` against a fake control plane: the amounts each sends (a number, or null
// for "none"), what a request waiting on someone else prints, and the refusals made before anything is sent.
import { afterEach, describe, expect, it } from "vitest";
import { UUID, agentsCli, cleanHarnessDirs } from "../support/agents-cli-harness.js";

afterEach(cleanHarnessDirs);

const AGT = "agt_aaaaaaaaaaaaaaaaaaaa";
const agent = { agentId: AGT, name: "Triage helper", builtin: false, status: "active", monthlyBudgetUsd: 50, access: "manage" };

describe("agentx agents budget", () => {
  it("sends a monthly amount and clears the per-run limit with none", async () => {
    const h = await agentsCli({ [`PUT /v1/app/agents/${AGT}/budget`]: Response.json({ agent }) });
    expect(await h.run(["agents", "budget", AGT, "--monthly", "50", "--max-per-run", "none"])).toBe(0);
    expect(h.calls).toEqual([{ method: "PUT", path: `/v1/app/agents/${AGT}/budget`, query: "", body: { requestId: expect.stringMatching(UUID) as string, monthlyUsd: 50, maxPerRunUsd: null } }]);
    expect(h.stdout()).toContain("$50");
  });

  it("answered 202, prints the broker's message and the request id, and exits 0", async () => {
    const message = "That takes Maya's agent budgets past the company's cap of $200. An org admin was asked to raise it.";
    const h = await agentsCli({ [`PUT /v1/app/agents/${AGT}/budget`]: Response.json({ status: "REQUESTED", message, requestId: "spr_cccccccccccccccccccc" }, { status: 202 }) });
    expect(await h.run(["agents", "budget", AGT, "--monthly", "500"])).toBe(0);
    expect(h.stdout()).toContain(message);
    expect(h.stdout()).toContain("spr_cccccccccccccccccccc");
    expect(await h.run(["--json", "agents", "budget", AGT, "--monthly", "500"])).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: true, data: { status: "REQUESTED", message, requestId: "spr_cccccccccccccccccccc" } });
  });

  it("prints a refusal as the broker wrote it", async () => {
    const message = "CONFIG_INVALID: monthlyUsd: your company's guardrails allow at most $100 a month for one agent";
    const h = await agentsCli({ [`PUT /v1/app/agents/${AGT}/budget`]: Response.json({ error: { code: "CONFIG_INVALID", message } }, { status: 400 }) });
    expect(await h.run(["agents", "budget", AGT, "--monthly", "500"])).not.toBe(0);
    expect(h.stderr()).toBe(`${message}\n`);
  });

  it("refuses no amount, a negative one or a word other than none, before sending anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["agents", "budget", AGT])).not.toBe(0);
    expect(await h.run(["agents", "budget", AGT, "--monthly", "-5"])).not.toBe(0);
    expect(await h.run(["agents", "budget", AGT, "--max-per-run", "lots"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("agentx project ai set", () => {
  it("sends the budget, who pays and the planning limits", async () => {
    const answer = { settings: { monthlyBudgetUsd: 300, projectPays: true, planningLimitUsd: { QUICK: 2, FULL: 5 } }, revision: 3, effective: { sourceOrder: ["rovara"], planningLimitUsd: { QUICK: 2, FULL: 5 } } };
    const h = await agentsCli({ "PUT /v1/app/projects/payments/ai": Response.json(answer) });
    expect(await h.run(["project", "ai", "set", "payments", "--budget", "300", "--project-pays", "on", "--planning-quick", "2", "--planning-full", "5"])).toBe(0);
    expect(h.calls).toEqual([{
      method: "PUT", path: "/v1/app/projects/payments/ai", query: "",
      body: { requestId: expect.stringMatching(UUID) as string, monthlyBudgetUsd: 300, projectPays: true, planningLimitUsd: { QUICK: 2, FULL: 5 } },
    }]);
    expect(h.stdout()).toContain("revision 3");
  });

  it("clears the budget with none and turns project pays off", async () => {
    const h = await agentsCli({ "PUT /v1/app/projects/payments/ai": Response.json({ settings: {}, revision: 4, effective: { sourceOrder: [], planningLimitUsd: { QUICK: 1, FULL: 3 } } }) });
    expect(await h.run(["project", "ai", "set", "payments", "--budget", "none", "--project-pays", "off"])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, monthlyBudgetUsd: null, projectPays: false });
  });

  it("refuses no setting, or --project-pays other than on or off, before sending", async () => {
    const h = await agentsCli({});
    expect(await h.run(["project", "ai", "set", "payments"])).not.toBe(0);
    expect(await h.run(["project", "ai", "set", "payments", "--project-pays", "yes"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});
