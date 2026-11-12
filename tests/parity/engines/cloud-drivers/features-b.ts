// Cloud drivers: Tracker intake, Slack channel, model selection, audit ledger, script tokens, realtime, outbound events (areas 18, 20, 24, 26, 36, 40, 43).
import { randomUUID } from "node:crypto";
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import { ledgerWords } from "../features-b-support/audit-order.js";
import { modelWords } from "../features-b-support/models.js";
import { realtimeWords } from "../features-b-support/realtime.js";
import { logWords, outcome } from "../features-b-support/outcomes.js";
import { runTokenScript } from "../features-b-support/tokens-script.js";

type Driver = StepDriver<CloudContext, CloudOptions>;


/** Runs `work` with Cloud's install switch `variable` at "1", and puts the environment back as it was. */
async function withSwitch<T>(variable: string, work: () => Promise<T>): Promise<T> {
  const before = process.env[variable];
  process.env[variable] = "1";
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env[variable];
    else process.env[variable] = before;
  }
}

const scriptTokens: Driver = {
  // Cloud refuses to make a script token without the audit ledger (AUDIT_UNAVAILABLE): the Cloud context gives the broker its ledger (ctx.audit).
  async run(ctx) {
    const waiting = ctx.e2e.taskId();
    // Cloud's switch `pt` (script tokens) is off by default; the comparison runs with it on, as the core's tokens are on by default.
    const words = await withSwitch(BROKER_SETTINGS.scriptTokens.variable, () => runTokenScript({
      async make(projects, permissions) {
        const made = await ctx.e2e.webPost("/v1/app/script-tokens", { requestId: randomUUID(), name: "CI deploy", projects, permissions });
        const secret = made.body.secret;
        if (typeof secret !== "string") throw new Error(`Cloud made no token (${String(made.status)}): ${JSON.stringify(made.body).slice(0, 200)}`);
        return secret;
      },
      async call(secret, method, path, body) {
        const answer = await ctx.e2e.handler({
          version: "2.0", rawPath: path, rawQueryString: "", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          requestContext: { requestId: randomUUID(), http: { method } }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), isBase64Encoded: false,
        });
        return { status: answer.statusCode, body: (answer.body === "" ? {} : JSON.parse(answer.body)) as Record<string, unknown> };
      },
      waitingTaskId: () => waiting,
      async decisionsOf(taskId) {
        const task = ctx.e2e.db.get(`DEVTASK#${taskId}`, "META");
        return ((task?.workflow as { decisions?: Array<{ decision: string }> } | undefined)?.decisions ?? []).map((decision) => decision.decision);
      },
    }, { start: "33333333-3333-4333-8333-333333333333", decide: "44444444-4444-4444-8444-444444444444", cancel: "55555555-5555-4555-8555-555555555555" }));
    ctx.extra.audit.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const auditLedger: Driver = {
  async run(ctx) {
    // Cloud's audit outbox as the broker wrote it, in order: what was handed to the ledger, then what is still pending.
    const words = ledgerWords([...ctx.audit.flushed(), ...ctx.audit.pending()].map((event) => event.action));
    ctx.extra.audit.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const modelSelection: Driver = {
  async run(ctx) {
    const words = modelWords(ctx.e2e.invocations);
    ctx.extra.audit.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const realtime: Driver = {
  // Cloud tells an open page from its agent sessions: a session summary change runs the notice sink (agent-sessions/summary.ts, realtime/sink.ts), which
  // writes each person's CHANGE_NOTICE feed rows and publishes. The journey harness runs no agent-session projector (no AGENT_SESSION rows are written),
  // so it would report "nothing told" for a reason that is the harness's, not Cloud's. Comparing it needs the projector on the harness's stream
  // (tests/support/agent-session-projector-world.ts) in cloud-context.ts (a shared file).
  supports: () => ({ unsupported: "the journey harness runs no agent-session projector, so Cloud's notice sink (realtime/sink.ts) never runs; needs the projector wired into cloud-context.ts" }),
  async run(ctx) {
    const notices = ctx.e2e.db.find((item) => item.entityType === "CHANGE_NOTICE").map((item) => String((item.notice as { type?: unknown } | undefined)?.type));
    const words = realtimeWords(notices);
    ctx.extra.audit.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const outboundEvents: Driver = {
  async run(ctx) {
    // Cloud has no outbound events feature (convergence plan section 1, row 43: Slack and milestone hooks are inline); there is nothing to send to.
    const words = [outcome("outbound", "adapters:0")];
    ctx.extra.audit.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const slackChannel: Driver = {
  // Cloud's own path IS the Slack channel: the start, the cards and the replies of every scenario go through it (slack-ingress, the interactivity handler,
  // the notifier). The scenario's start already drove it; this step reads nothing more.
  run: async () => undefined,
};

const trackerIntake: Driver = {
  supports: () => ({ unsupported: "Cloud's tracker intake runs in its own harness (tests/support/linear-broker.ts, tracker-connector.ts) with a Linear connector; the workflow journey harness the Cloud engine uses has none" }),
  run: () => Promise.reject(new Error("unsupported")),
};

export const FEATURES_B_DRIVERS: Record<string, Driver> = {
  "feature:outbound-events": outboundEvents,
  "feature:slack-channel": slackChannel,
  "feature:tracker-intake": trackerIntake,
  "feature:realtime": realtime,
  "feature:model-selection": modelSelection,
  "feature:script-tokens": scriptTokens,
  "feature:audit-ledger": auditLedger,
};
