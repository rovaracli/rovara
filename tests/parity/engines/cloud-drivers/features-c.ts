// Cloud drivers: Saved environments, test services, setup agent, devcontainers, playbook, diagnosis, connections, MCP tools (areas 27-34).
// Each surface feature is a route probe (features-c-support/probes.ts) asked as Maya with her developer token; MCP tools start a task through Cloud's
// real MCP server (the harness's signed-in MCP client).
import { randomUUID } from "node:crypto";
import { bearerFor } from "../../../support/developer-task-broker.js";
import { SLACK_MAYA } from "../../../support/workflow-e2e.js";
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import { FEATURE_PROBES, note, outcomeWord, parse } from "../features-c-support/probes.js";

type Driver = StepDriver<CloudContext, CloudOptions>;

/**
 * Cloud's switches for these surfaces are off by default (stack parameters, "0"); the core's are on by default on a laptop. The comparison is of the
 * features, so each is switched on for its own scenario, as an install that offers it would be, and put back after.
 */
const SWITCHES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "saved-env": { TEST_ENVIRONMENT_ENABLED: "1", SAVED_ENV_ENABLED: "1" },
  "test-services": { TEST_ENVIRONMENT_ENABLED: "1" },
  "setup-agent": { SETUP_AGENT_ENABLED: "1" },
  diagnosis: { LIVE_FIX_ENABLED: "1" },
};

const probe = (feature: string): Driver => ({
  options() {
    const saved: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(SWITCHES[feature] ?? {})) { saved[name] = process.env[name]; process.env[name] = value; }
    restore.set(feature, saved);
    return {};
  },
  async run(ctx) {
    try {
      await asAll(ctx, feature);
    } finally {
      for (const [name, value] of Object.entries(restore.get(feature) ?? {})) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      restore.delete(feature);
    }
  },
});

const restore = new Map<string, Record<string, string | undefined>>();

async function asAll(ctx: CloudContext, feature: string): Promise<void> {
  for (const asked of FEATURE_PROBES[feature] ?? []) {
      const answer = await ctx.e2e.handler({
        version: "2.0", rawPath: asked.path, rawQueryString: "", headers: { authorization: await bearerFor(SLACK_MAYA), "content-type": "application/json" },
        requestContext: { requestId: randomUUID(), http: { method: asked.method } }, ...(asked.body === undefined ? {} : { body: JSON.stringify(asked.body) }), isBase64Encoded: false,
      });
    note(ctx.extra, "cloud", outcomeWord(feature, asked, answer.statusCode, parse(answer.body)));
    if (process.env.PARITY_DEBUG === "1" && answer.statusCode >= 400) console.log(JSON.stringify({ parity: "features-c.body", engine: "cloud", path: asked.path, body: answer.body.slice(0, 300) }));
  }
}

export const FEATURES_C_DRIVERS: Record<string, Driver> = {
  "feature:saved-env": probe("saved-env"),
  "feature:test-services": probe("test-services"),
  "feature:setup-agent": probe("setup-agent"),
  "feature:playbook": probe("playbook"),
  "feature:diagnosis": {
    supports: () => ({ unsupported: "the journey harness builds the broker without diagnosis dependencies: with LIVE_FIX_ENABLED=1 every /v1/app/diagnoses path still answers 404 \"route not found\" (developer-routes.ts routeDiagnosisRequest gets undefined deps), so a 404 on both sides would compare the same for the wrong reason. Needs the harness to take diagnosis dependencies (tests/support/diagnosis-world.ts has them)" }),
    run: () => Promise.resolve(),
  },
  "feature:connections": probe("connections"),
  "feature:devcontainer": {
    supports: () => ({ unsupported: "devcontainers are found and built by the worker (env-detect), not the broker; compared at the worker level, not by this broker suite" }),
    run: () => Promise.resolve(),
  },
  "feature:mcp-tools": {
    async run(ctx) {
      const started = await ctx.e2e.mcp("agentx_start_workflow", { project: "payments", instructions: "Add a greet(name) function", workflow_path: "quick" });
      note(ctx.extra, "cloud", `mcp-tools start -> ${started.isError ? "refused" : "started"}`);
      if (started.isError) throw new Error(`Cloud refused the MCP start: ${JSON.stringify(started.error).slice(0, 200)}`);
      await ctx.e2e.settle();
    },
  },
};
