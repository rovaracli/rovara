// Core drivers: Spend limits, approvals, erasure, multi-project companies (areas 22, 23, 25, 39).
//
// Spend: the core's start is admitted by lane A5's real CloudAdmission (registered by the fake world, recording each decision into the spend facet). Its limit
// is Cloud's own: `prepare` reads Cloud's `effectiveLimits` over the same seeded BUDGET row and refuses to run if it is not the scenario's limit, and the
// ledger counter it holds against is seeded at the same spend Cloud's ledger row holds.
import { randomUUID } from "node:crypto";
import { IMPLICIT_COMPANY_ID } from "@rovara-code/contracts";
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { coreCounterItem, effectiveLimitOf, monthNow, spendStepOf } from "../people-money-support/spend.js";

type Driver = StepDriver<CoreContext, FakeWorldOptions>;

/** A start on `path` through the core's own route, its outcome recorded; an admitted start runs its preparation as the start driver does. */
const spendStart = (path: "QUICK" | "FULL"): Driver => ({
  async run(ctx) {
    await ctx.api("/v1/admin/projects", { method: "POST", body: ctx.project });
    const started = await ctx.api("/v1/dev/tasks", { method: "POST", body: { requestId: "11111111-1111-4111-8111-111111111111", project: "payments", instructions: "Add a greet(name) function", workflow: true, workflowPath: path } });
    if (started.status !== 201) {
      const refusal = started.body.error as { code?: string; message?: string } | undefined;
      ctx.extra.spend.push(`start_refused:${String(refusal?.code)}`, `refusal_message:${String(refusal?.message)}`);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.spend", words: [...ctx.world.spend, ...ctx.extra.spend], body: started.body }));
      return;
    }
    ctx.task.taskId = (started.body.task as { taskId: string }).taskId;
    const record = await ctx.readTask();
    ctx.task.workspaceId = typeof record?.workspaceId === "string" ? record.workspaceId : "";
    const prepare = await ctx.take();
    if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.spend", words: [...ctx.world.spend, ...ctx.extra.spend] }));
    await ctx.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: ctx.task.base }] } });
  },
});

/** A start in `project` through the core's own route; a refusal is recorded (spend facet, as the start driver records one), an admitted start runs its preparation. */
const startApi = (project: string): Driver => ({
  async run(ctx) {
    const started = await ctx.api("/v1/dev/tasks", { method: "POST", body: { requestId: randomUUID(), project, instructions: "Add a greet(name) function", workflow: true, workflowPath: "QUICK" } });
    if (started.status !== 201) {
      ctx.extra.spend.push(`start_refused:${String((started.body.error as { code?: string } | undefined)?.code)}`);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.startApi", project, refused: ctx.extra.spend.at(-1) }));
      return;
    }
    ctx.task.taskId = (started.body.task as { taskId: string }).taskId;
    const record = await ctx.readTask();
    ctx.task.workspaceId = typeof record?.workspaceId === "string" ? record.workspaceId : "";
    const prepare = await ctx.take();
    await ctx.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: ctx.task.base }] } });
  },
});

export const PEOPLE_MONEY_DRIVERS: Record<string, Driver> = {
  "spend.limit": {
    options: (scenario) => {
      const seeded = spendStepOf(scenario);
      return seeded === undefined ? {} : { companyLimitUsd: seeded.usd };
    },
    async prepare(ctx, scenario) {
      const seeded = spendStepOf(scenario);
      if (seeded === undefined) return;
      const month = monthNow(ctx.clock.now());
      const cloudLimit = await effectiveLimitOf(IMPLICIT_COMPANY_ID, month, seeded.usd);
      if (cloudLimit !== seeded.usd) throw new Error(`Cloud's effectiveLimits gives ${String(cloudLimit)} for the seeded limit ${String(seeded.usd)}; the core would be given another number`);
      await ctx.store.put({ item: coreCounterItem(IMPLICIT_COMPANY_ID, month, seeded.spentUsd ?? 0) });
    },
    run: async () => undefined,
  },
  "feature:spend.start-quick": spendStart("QUICK"),
  "feature:spend.start-full": spendStart("FULL"),
  "project.second": {
    // Cloud's per-person workspace limit (1 here, as the Cloud engine sets it) mapped onto the core flow's own limit, as the composition root maps Cloud's settings (S0-Q2).
    async prepare(ctx) {
      ctx.runtime.app.flow.deps.limits = { member: 1, organization: 20 };
      // The rest of the settings mapping the start driver applies (no Understand, no plan check on a Quick task, as on Cloud's journey install).
      ctx.runtime.app.flow.deps.understandFirst = false;
      ctx.runtime.app.flow.deps.planCheck = false;
    },
    async run(ctx) {
      await ctx.api("/v1/admin/projects", { method: "POST", body: ctx.project });
      const registered = await ctx.api("/v1/admin/projects", { method: "POST", body: { ...ctx.project, name: "billing" } });
      if (registered.status !== 201) throw new Error(`the core refused the second project: ${JSON.stringify(registered.body).slice(0, 200)}`);
    },
  },
  "feature:start-api:payments": startApi("payments"),
  "feature:start-api:billing": startApi("billing"),
  "approval.needed": {
    supports: () => ({ unsupported: [
      "the core engine runs Code's local composition, whose only person is its local owner (one approver, who may approve their own request: decision 45.3), so a second person cannot exist there.",
      "Cloud's people adapters (A6 createCloudIdentityProvider/createCloudApprovers) need a Cloud people world in the SAME company as the core's tasks (the local owner's company is IMPLICIT_COMPANY_ID, the people world's is TEST_ORG) and a decide surface that presents A6 credentials (the local pages present only local-session proofs).",
      "Shared change: core-context registers A6 identity and approvers from tests/support/cloud-people-world.ts when a driver asks, runs the core's tasks as that company, and decides through the core's DecisionGate with A6 credentials.",
    ].join(" ") }),
    run: () => Promise.reject(new Error("unsupported")),
  },
  "person.erase": {
    supports: () => ({ unsupported: [
      "Code's core has no person erasure: the walks by person, project and company are left in Cloud on purpose (vendor core/proof/evidence-erase.ts:6-7, decision 41). Its counterpart is per workspace and per task",
      "(eraseWorkspaceEvidence, eraseTaskEvidence), which the composition root must call for each workspace of the erased person; that adapter is not written (S0 gap).",
      "The part both sides share is a duplicated pure function: evidencePrefixesOf is identical in vendor core/proof/evidence-erase.ts:13 and packages/broker/src/rovara-code/evidence-erase.ts:22 (a copy for the deletion lane).",
    ].join(" ") }),
    run: () => Promise.reject(new Error("unsupported")),
  },
};
