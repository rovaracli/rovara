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
import { PARITY_CORE_PEOPLE } from "../core-context.js";
import { applyJourneySettings } from "../core-settings.js";
import { coreMatrix } from "../people-money-support/approvals.js";
import { coreErase } from "../people-money-support/erasure.js";
import { readCoreEngineFlags, stampForNewTask, stampItem } from "../../../../packages/broker/src/cloud/app/index.js";
import type { Step } from "../../harness/types.js";
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
    // Cloud's per-person workspace limit (1 here, as the Cloud engine sets it) and the rest of the settings (no Understand, no plan check on a Quick task, as on
    // Cloud's journey install), mapped by the root's settings mapping (S0-Q2).
    async prepare(ctx, scenario) {
      applyJourneySettings(ctx.runtime.app.flow.deps, scenario, { workspaceLimits: { member: 1, organization: 20 } }, ctx.companyId);
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
    // The core decides with Cloud's people: A6's approvers on the approvers point, the people world's company (core-context PARITY_CORE_PEOPLE).
    options: () => ({ coreEnvironment: { [PARITY_CORE_PEOPLE]: "cloud" } }),
    async run(ctx, step) {
      const answer = (step as Extract<Step, { do: "approval.needed" }>).answer;
      const matrix = await coreMatrix(ctx, answer);
      ctx.extra.features.push(...matrix.words);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.approvals", words: matrix.words, reasons: matrix.reasons }));
    },
  },
  "person.erase": {
    async run(ctx) {
      const task = await ctx.readTask();
      if (task === undefined || typeof task.ownerKey !== "string" || typeof task.workspaceId !== "string" || typeof task.developerId !== "string") throw new Error("the core task has no owner key, workspace or person to erase");
      // The parity core runs Code's local runtime, which does not write the engine stamp (Cloud's composition root writes it in the start's own transaction: core-runtime.ts).
      // The product's walk leaves a task with no stamp to Cloud, so the stamp the root would have written is written here, from the product's own stamp function.
      await ctx.store.put({ item: stampItem(ctx.companyId, ctx.task.taskId, stampForNewTask(readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on" }), ctx.companyId, new Date())).item });
      const words = await coreErase({ registry: ctx.runtime.registry, companyId: ctx.companyId, developerId: task.developerId, own: { ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId: ctx.task.taskId } });
      ctx.extra.features.push(...words);
    },
  },
};
