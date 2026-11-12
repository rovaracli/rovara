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
import { runCloudIntake } from "../features-b-support/intake.js";
import { streamRecordOf } from "../features-b-support/stream.js";
import { projectSessions } from "../../../../packages/broker/src/agent-sessions/projector.js";
import { registerSessionNoticeSink } from "../../../../packages/broker/src/agent-sessions/notice-sink.js";
import { installRealtimeSink } from "../../../../packages/broker/src/realtime/sink.js";

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
    ctx.extra.features.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const auditLedger: Driver = {
  async run(ctx) {
    // Cloud's audit outbox as the broker wrote it, in order: what was handed to the ledger, then what is still pending.
    const words = ledgerWords([...ctx.audit.flushed(), ...ctx.audit.pending()].map((event) => event.action));
    ctx.extra.features.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const modelSelection: Driver = {
  async run(ctx) {
    const words = modelWords(ctx.e2e.invocations);
    ctx.extra.features.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const realtime: Driver = {
  // Cloud tells an open page from its agent sessions: the projector (the DynamoDB stream's reader) refreshes a session's summary when its task, workspace or
  // operations change, and the summary change runs the notice sink (realtime/sink.ts), which writes each person's CHANGE_NOTICE feed rows and then publishes.
  // The journey harness runs neither, so this driver puts them on its stream: every table write is kept as a stream record (prepare), and the projector
  // runs over them with Cloud's real sink installed (no events API: the feed rows are exactly what would be published).
  async prepare(ctx) {
    const records: Array<Record<string, unknown>> = [];
    ctx.memo.realtimeRecords = records;
    ctx.e2e.db.onWrite((change) => { records.push(streamRecordOf(change)); });
  },
  async run(ctx) {
    const records = (ctx.memo.realtimeRecords ?? []) as Array<Record<string, unknown>>;
    installRealtimeSink({});
    let result: Awaited<ReturnType<typeof projectSessions>>;
    try {
      result = await projectSessions(records, { documentClient: ctx.e2e.db, tableName: "state", now: () => Date.now(), log: () => undefined }, { deadline: Date.now() + 60_000 });
    } finally {
      registerSessionNoticeSink(undefined);
    }
    const notices = ctx.e2e.db.find((item) => item.entityType === "CHANGE_NOTICE").map((item) => String((item.notice as { type?: unknown } | undefined)?.type));
    const sessions = ctx.e2e.db.find((item) => String(item.pk).includes("#AGENT_SESSION#") && item.sk === "META").length;
    if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.realtime", records: records.length, result }));
    const words = [...realtimeWords(notices), outcome("realtime", `sessions:${String(sessions)}`)];
    ctx.extra.features.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const outboundEvents: Driver = {
  async run(ctx) {
    // Cloud has no outbound events feature (convergence plan section 1, row 43: Slack and milestone hooks are inline); nothing is ever sent.
    const words = [outcome("outbound", "events:0")];
    ctx.extra.features.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const slackStart: Driver = {
  // Cloud's own path IS the Slack channel: a signed mention through slack-ingress starts the task in the bound channel's project.
  async run(ctx) {
    const answered = await ctx.e2e.mention("quick: Add a greet(name) function");
    await ctx.e2e.settle();
    const started = ctx.e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META").length;
    const words = [outcome("slack", `start:${answered === 200 && started === 1 ? "task_started" : `refused_${String(answered)}`}`)];
    ctx.extra.features.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const slackApprove: Driver = {
  // The plan card in the Slack thread carries Approve; pressing it decides the plan (decision 99: Slack may decide inside the sign-in window).
  async run(ctx) {
    const card = ctx.e2e.slack.posts.some((post) => JSON.stringify(post.blocks ?? []).includes("agentx_workflow_approve"));
    if (!card) { ctx.extra.features.push(outcome("slack", "approve:no_card")); return; }
    await ctx.e2e.click("agentx_workflow_approve");
    await ctx.e2e.settle();
    const decided = (ctx.e2e.workflow().decisions ?? []).some((decision) => decision.decision === "APPROVE");
    const words = [outcome("slack", "approve:card_offered"), outcome("slack", `approve:${decided ? "decided" : "not_decided"}`)];
    ctx.extra.features.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

const trackerIntake: Driver = {
  // Cloud's intake engine and poll (intake/engine.ts, triggers/poll-intake.ts), the same decisions the core makes, over Cloud's own store rows. The journey
  // harness builds no intake wiring (intake/wiring.ts needs the broker's start and ticket-update services), so the ports are the poll test's: a member is
  // found through the org's linked accounts (none here, as on the core engine, whose install has no linked tracker account), `start` and `started` record.
  async run(ctx) {
    const words = await runCloudIntake();
    ctx.extra.features.push(...words);
    await logWords("cloud", ctx.scenario.id, words);
  },
};

export const FEATURES_B_DRIVERS: Record<string, Driver> = {
  "feature:outbound-events": outboundEvents,
  "feature:slack-start": slackStart,
  "feature:slack-approve": slackApprove,
  "feature:tracker-intake": trackerIntake,
  "feature:realtime": realtime,
  "feature:model-selection": modelSelection,
  "feature:script-tokens": scriptTokens,
  "feature:audit-ledger": auditLedger,
};
