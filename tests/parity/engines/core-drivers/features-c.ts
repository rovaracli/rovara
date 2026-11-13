// Core drivers: Saved environments, test services, setup agent, devcontainers, playbook, diagnosis, connections, MCP tools (areas 27-34).
// Each surface feature is a route probe (features-c-support/probes.ts) asked as the install's owner; MCP tools start a task the way Code's MCP tool does.
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { applyJourneySettings } from "../core-settings.js";
import { devcontainerWords } from "../features-c-support/devcontainer.js";
import { codeDiagnosisWords } from "../features-c-support/diagnosis.js";
import { FEATURE_PROBES, note, outcomeWord } from "../features-c-support/probes.js";

type Driver = StepDriver<CoreContext, FakeWorldOptions>;

const probe = (feature: string): Driver => ({
  async run(ctx) {
    for (const asked of FEATURE_PROBES[feature] ?? []) {
      const answer = await ctx.api(asked.path, { method: asked.method, ...(asked.body === undefined ? {} : { body: asked.body }) });
      note(ctx.extra, "core", outcomeWord(feature, asked, answer.status, answer.body));
      if (process.env.PARITY_DEBUG === "1" && answer.status >= 400) console.log(JSON.stringify({ parity: "features-c.body", engine: "core", path: asked.path, body: JSON.stringify(answer.body).slice(0, 300) }));
    }
  },
});

/** The task Code's MCP tool `agentx_start_workflow` starts: it posts exactly this to the core's task route (vendored Code has no MCP package; ~Code packages/mcp/src/tools.ts). */
const MCP_START = { requestId: "33333333-3333-4333-8333-333333333333", project: "payments", instructions: "Add a greet(name) function", workflow: true, workflowPath: "QUICK", client: "parity-mcp" };

export const FEATURES_C_DRIVERS: Record<string, Driver> = {
  "feature:saved-env": probe("saved-env"),
  "feature:test-services": probe("test-services"),
  "feature:setup-agent": probe("setup-agent"),
  "feature:playbook": probe("playbook"),
  // Area 32 at the service level (features-c-support/diagnosis.ts): the core's diagnosis service on the shared failed task.
  "feature:diagnosis": { async run(ctx) { for (const word of await codeDiagnosisWords()) note(ctx.extra, "core", word); } },
  "feature:connections": probe("connections"),
  // Area 30 at the worker level (features-c-support/devcontainer.ts): this engine's side of the worker on the shared fixtures.
  "feature:devcontainer": {
    run(ctx) { for (const word of devcontainerWords("code")) note(ctx.extra, "core", word); return Promise.resolve(); },
  },
  "feature:mcp-tools": {
    async run(ctx) {
      // The project is registered first, as the core's start driver does (an MCP tool starts work on a registered project).
      await ctx.api("/v1/admin/projects", { method: "POST", body: ctx.project });
      const started = await ctx.api("/v1/dev/tasks", { method: "POST", body: MCP_START });
      note(ctx.extra, "core", `mcp-tools start -> ${started.status === 201 ? "started" : `refused ${String(started.status)}`}`);
      if (started.status !== 201) throw new Error(`the core refused the MCP start: ${JSON.stringify(started.body).slice(0, 200)}`);
      ctx.task.taskId = (started.body.task as { taskId: string }).taskId;
      const record = await ctx.readTask();
      ctx.task.workspaceId = typeof record?.workspaceId === "string" ? record.workspaceId : "";
      const prepare = await ctx.take();
      await ctx.callback(prepare, "result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: ctx.task.base }] } });
    },
    async prepare(ctx, scenario) {
      // The same settings mapping the start driver applies (S0-Q2): the MCP start replaces `start` in its scenario.
      applyJourneySettings(ctx.runtime.app.flow.deps, scenario, {}, ctx.companyId);
    },
  },
};
