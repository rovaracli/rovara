// Plan 4 Task 6: the chain runner's core. A person (or an event, or a schedule) starts a run of a published chain; each agent step is a run of its own pinned
// agent through Plan 3's `startAgentRun`; a step's report goes to the next step as data in its context; every state change and its event commit together. The
// binding hand-offs are tested here too: a budget pause is a pause (never a failure, never a second task, nothing released), each end is handled once whatever
// replays, and report text is neutralised before anyone is shown it.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasTaskEndHandlers, registerTaskEndHandler, registerTaskPauseHandler, onTaskEnded, onTaskPaused, type TaskEndHost } from "../../packages/broker/src/agents/task-end.js";
import { setChainShares } from "../../packages/broker/src/chains/access.js";
import { STARTER_CHAIN_DEFINITION, type ChainRouteDependencies } from "../../packages/broker/src/chains/routes.js";
import { taskKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { BUILTIN_AGENTS, currentBuiltinVersion } from "../../packages/contracts/src/agent-templates.js";
import {
  CHAIN_MAX_STEP_RUNS, CONTEXT_TITLE_MAX, HANDOFF_ITEM_MAX_BYTES, HANDOFF_MAX_BYTES, HANDOFF_MAX_ITEMS, type ChainDefinitionInput, type StepResult,
} from "../../packages/contracts/src/chains.js";
// The package the broker imports, not its source: an error must be an instance of the class the broker tests for.
import { agentXError } from "@agentx/contracts";
import { chainKey, chainRunKey, openChainRunKey, projectAiKey, projectMetaKey, runEventSk, stepSk } from "../../packages/contracts/src/org-scoped-keys.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { ARJUN, CARL, DANA, MAX, ORG_A, ORG_B, PRIYA, START, STRANGER, VIV, callerOf, setupWorld, type ChainWorld } from "../support/chain-run-world.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

// What this task adds is loaded by the tests that need it, so each of them fails on its own until it exists.
const runner = () => import("../../packages/broker/src/chains/runner.js");
const handoff = () => import("../../packages/broker/src/chains/handoff.js");
const runEvents = () => import("../../packages/broker/src/chains/run-events.js");
const branches = () => import("../../packages/broker/src/chains/branches.js");
const index = () => import("../../packages/broker/src/chains/index.js");

beforeAll(async () => { await loadSlackBroker(); });
afterAll(async () => { (await loadSlackBroker() as unknown as { uninstallChainRunner(): void }).uninstallChainRunner(); });

const unregister: Array<() => void> = [];
afterEach(() => { for (const off of unregister.splice(0)) off(); });

const fail = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const TRIGGER_ID = "ctr_aaaaaaaaaaaaaaaaaaaa";

type Step = ChainDefinitionInput["steps"][number];
const agentStep = (id: string, name: string, agentId: string, next: unknown, extra: Record<string, unknown> = {}): Step =>
  ({ kind: "agent", id, name, agent: { agentId, version: "current" }, next, ...extra }) as Step;
/** Two built-in steps: Root-cause analyst, then Code reviewer. */
const TWO_STEPS: ChainDefinitionInput = {
  start: "look", limits: { maxRunUsd: 30 },
  steps: [agentStep("look", "Look into it", "root-cause-analyst", { kind: "go", to: "review" }), agentStep("review", "Review it", "code-reviewer", { kind: "end" })],
};
/** Three built-in steps, the last of which wants every earlier report. */
const THREE_STEPS_ALL: ChainDefinitionInput = {
  start: "a", limits: { maxRunUsd: 30 },
  steps: [
    agentStep("a", "First", "root-cause-analyst", { kind: "go", to: "b" }),
    agentStep("b", "Second", "ticket-triage", { kind: "go", to: "c" }),
    agentStep("c", "Third", "code-reviewer", { kind: "end" }, { handoff: "all" }),
  ],
};
const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [agentStep("look", "Look into it", "root-cause-analyst", { kind: "end" })], limits: { maxRunUsd: 30 } };
const name = (agentId: string) => BUILTIN_AGENTS[agentId as "rovara-code"].name;

const startAs = async (w: ChainWorld, who: string, chainId: string, extra: Record<string, unknown> = {}) => {
  const { startChainRun } = await runner();
  return startChainRun(w.deps, callerOf(who), {
    orgId: ORG_A, chainId, project: "web", origin: "app", startedBy: { kind: "member", developerId: who }, requestId: randomUUID(), ...extra,
  } as never);
};
const SENTRY = (extra: Record<string, unknown> = {}) => ({
  eventKey: "sentry:evt-1", source: "sentry", type: "issue.created",
  subject: { kind: "alert", title: "Refund errors", url: "https://sentry.example.com/issues/1" }, ...extra,
});
const EVENT_STARTED = (extra: Record<string, unknown> = {}) => ({ kind: "event", triggerId: TRIGGER_ID, eventKey: "sentry:evt-1", source: "sentry", type: "issue.created", title: "Refund errors", ...extra });
const startAsEvent = async (w: ChainWorld, chainId: string, owner: string, extra: Record<string, unknown> = {}) => {
  const { startChainRun } = await runner();
  return startChainRun(w.deps, { system: "event", owner: { developerId: owner } }, {
    orgId: ORG_A, chainId, project: "web", origin: "event", startedBy: EVENT_STARTED(), trigger: SENTRY(), requestId: randomUUID(), ...extra,
  } as never);
};
const endTask = async (w: ChainWorld, taskId: string, extra: Record<string, unknown> = {}) => {
  const { onStepTaskEnded } = await runner();
  await onStepTaskEnded(w.deps, w.endEvent(taskId, extra));
};

// ---- redactSecrets

describe("redactSecrets", () => {
  const TOKENS: Record<string, string> = {
    "GitHub token (ghp_)": `ghp_${"a1".repeat(18)}`,
    "GitHub token (ghs_)": `ghs_${"B2".repeat(18)}`,
    "GitHub token (gho_, 20 characters)": `gho_${"c".repeat(20)}`,
    "GitHub token (ghu_)": `ghu_${"d".repeat(30)}`,
    "GitHub token (ghr_)": `ghr_${"e".repeat(30)}`,
    "GitHub fine-grained token": `github_pat_${"A_b9".repeat(10)}`,
    "Slack bot token": "xoxb-1234567890-abcdefABCDEF",
    "Slack user token": "xoxp-1234567890-abcdefABCDEF",
    "Slack app token (xoxa)": "xoxa-1234567890-abcdefABCDEF",
    "Slack refresh token (xoxr)": "xoxr-1234567890-abcdefABCDEF",
    "Slack config token (xoxe)": "xoxe-1234567890-abcdefABCDEF",
    "Slack app-level token (xapp)": "xapp-1-A0123456789-1234567890-abcdef0123456789",
    "AWS access key": "AKIAABCDEFGHIJKLMNOP",
    "AWS session key": "ASIAABCDEFGHIJKLMNOP",
    "an sk- key": `sk-${"Ab1_-".repeat(6)}`,
    "an Anthropic key": `sk-ant-api03-${"Zy9_".repeat(10)}`,
    "a private key": "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabc123\n-----END RSA PRIVATE KEY-----",
    "a bearer token": `Bearer ${"abcDEF012345-._~+/".repeat(2)}==`,
    "a Sentry user token": `sntryu_${"0123456789abcdef".repeat(3)}`,
    "a Sentry org token (40 characters)": `sntrys_${"a".repeat(40)}`,
    "a Grafana service account token (32 characters)": `glsa_${"A1b2".repeat(8)}`,
    "a Grafana cloud token": `glc_${"A1b2+/=_-".repeat(4)}`,
    "a Linear key (40 characters)": `lin_api_${"a1B2".repeat(10)}`,
    "an Atlassian token": `ATATT${"3xFfGF0abc_=-".repeat(3)}`,
    "a JWT": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  };

  it.each(Object.entries(TOKENS))("replaces %s with [redacted], leaving the text around it", async (_label, token) => {
    const { redactSecrets } = await handoff();
    expect(redactSecrets(`key: ${token} and more`)).toBe("key: [redacted] and more");
  });

  it("replaces every token in a text, and leaves a text with none unchanged", async () => {
    const { redactSecrets } = await handoff();
    expect(redactSecrets(`one ${TOKENS["GitHub token (ghs_)"]!} two ${TOKENS["AWS access key"]!}`)).toBe("one [redacted] two [redacted]");
    expect(redactSecrets("Bug in refund retry: see sk and ghp and AKIA-short")).toBe("Bug in refund retry: see sk and ghp and AKIA-short");
  });

  it("does not touch tokens that are too short to be one", async () => {
    const { redactSecrets } = await handoff();
    for (const text of [`ghp_${"a".repeat(19)}`, `sk-${"a".repeat(19)}`, "AKIAABCDEFGHIJKLMNO", "xoxb-123456789", `sntrys_${"a".repeat(19)}`, `glsa_${"a".repeat(19)}`, `lin_api_${"a".repeat(19)}`]) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });
});

// ---- buildHandoff

describe("buildHandoff", () => {
  const report = (seq: number, body: string, extra: Record<string, unknown> = {}) => ({
    seq, stepName: `Step ${String(seq)}`, agentName: "Root-cause analyst", version: 1, result: { report: body } as StepResult, ...extra,
  });
  const input = (extra: Record<string, unknown> = {}) => ({ runId: "crn_aaaaaaaaaaaaaaaaaaaa", earlier: [] as ReturnType<typeof report>[], mode: "previous" as const, ...extra });

  it("starts with the person's own words as a text item, and has no start item when they gave none", async () => {
    const { buildHandoff } = await handoff();
    expect(buildHandoff(input({ startInput: "Refunds fail twice" }) as never)).toEqual([{ kind: "text", ref: "start", body: "Refunds fail twice" }]);
    expect(buildHandoff(input() as never)).toEqual([]);
  });

  it.each([
    ["pull_request", "pull_request"], ["issue", "ticket"], ["incident", "alert"], ["alert", "alert"], ["deployment", "deploy"], ["workflow_run", "deploy"],
  ])("makes a %s event's start item a %s item, with the event key as its ref and the title as its title", async (subject, kind) => {
    const { buildHandoff, contextKindOf } = await handoff();
    expect(contextKindOf(subject as never)).toBe(kind);
    const [start] = buildHandoff(input({ trigger: SENTRY({ subject: { kind: subject, title: "Refund errors" } }) }));
    expect(start).toMatchObject({ kind, ref: "sentry:evt-1", title: "Refund errors" });
    expect(start!.body).toContain("sentry issue.created");
  });

  it("summarises an event as its source and type, its subject and link, and the vendor's own summary", async () => {
    const { triggerSummary } = await handoff();
    expect(triggerSummary(SENTRY({ summary: "42 events in the last hour" }) as never)).toBe(
      "Event: sentry issue.created\nalert: Refund errors\nLink: https://sentry.example.com/issues/1\n\n42 events in the last hour",
    );
    expect(triggerSummary(SENTRY({ subject: { kind: "issue", title: "T" } }) as never)).toBe("Event: sentry issue.created\nissue: T");
  });

  it("cuts a title to 200 characters ending in an ellipsis, the start item's and a report's", async () => {
    const { buildHandoff } = await handoff();
    const long = "x".repeat(300);
    const [start, second] = buildHandoff(input({ trigger: SENTRY({ subject: { kind: "alert", title: long } }), earlier: [report(1, "r", { agentName: long })] }));
    expect(start!.title).toBe(`${"x".repeat(CONTEXT_TITLE_MAX - 1)}…`);
    expect(start!.title).toHaveLength(CONTEXT_TITLE_MAX);
    expect(second!.title).toHaveLength(CONTEXT_TITLE_MAX);
    expect(second!.title!.endsWith("…")).toBe(true);
    const exactly = "y".repeat(CONTEXT_TITLE_MAX);
    expect(buildHandoff(input({ trigger: SENTRY({ subject: { kind: "alert", title: exactly } }) }) as never)[0]!.title).toBe(exactly);
  });

  it("does not cut a character in two when it cuts a title", async () => {
    const { buildHandoff } = await handoff();
    const title = `${"a".repeat(198)}${"😀".repeat(5)}`;
    const cut = buildHandoff(input({ trigger: SENTRY({ subject: { kind: "alert", title } }) }))[0]!.title!;
    expect(cut.length).toBeLessThanOrEqual(CONTEXT_TITLE_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]…$/u);
  });

  it("gives each earlier report as a report item, newest first, after the start item", async () => {
    const { buildHandoff } = await handoff();
    const items = buildHandoff(input({ startInput: "go", mode: "all", earlier: [report(1, "first"), report(3, "third", { stepName: "Check" }), report(4, "fourth", { agentName: "Code reviewer", version: 2 })] }));
    expect(items.map((item) => item.kind)).toEqual(["text", "report", "report", "report"]);
    expect(items.slice(1)).toEqual([
      { kind: "report", ref: "chain:crn_aaaaaaaaaaaaaaaaaaaa:4", title: 'Step "Step 4" (Code reviewer version 2)', body: "fourth" },
      { kind: "report", ref: "chain:crn_aaaaaaaaaaaaaaaaaaaa:3", title: 'Step "Check" (Root-cause analyst version 1)', body: "third" },
      { kind: "report", ref: "chain:crn_aaaaaaaaaaaaaaaaaaaa:1", title: 'Step "Step 1" (Root-cause analyst version 1)', body: "first" },
    ]);
  });

  it("gives only the last report for previous, whatever order they came in", async () => {
    const { buildHandoff } = await handoff();
    const items = buildHandoff(input({ mode: "previous", earlier: [report(1, "first"), report(2, "second")] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ref: "chain:crn_aaaaaaaaaaaaaaaaaaaa:2", body: "second" });
  });

  it("appends the links of a report to its body", async () => {
    const { buildHandoff } = await handoff();
    const [item] = buildHandoff(input({ earlier: [report(1, "Opened a fix", { result: { report: "Opened a fix", links: [{ label: "Pull request web#12", url: "https://github.com/acme/web/pull/12" }] } })] }));
    expect(item!.body).toBe("Opened a fix\n\nLinks:\n- Pull request web#12: https://github.com/acme/web/pull/12");
  });

  it("gives ten items from eleven earlier reports: the start item and the nine newest", async () => {
    const { buildHandoff } = await handoff();
    const earlier = Array.from({ length: 11 }, (_unused, at) => report(at + 1, `report ${String(at + 1)}`));
    const items = buildHandoff(input({ startInput: "go", mode: "all", earlier }));
    expect(items).toHaveLength(HANDOFF_MAX_ITEMS);
    expect(items[0]).toMatchObject({ kind: "text", ref: "start" });
    expect(items.slice(1).map((item) => item.body)).toEqual(Array.from({ length: 9 }, (_unused, at) => `report ${String(11 - at)}`));
  });

  it("redacts secrets in every body, the start item's too", async () => {
    const { buildHandoff } = await handoff();
    const items = buildHandoff(input({ startInput: `use ghp_${"a".repeat(36)}`, earlier: [report(1, `token ghs_${"b".repeat(36)} and AKIAABCDEFGHIJKLMNOP`)] }));
    expect(items.map((item) => item.body)).toEqual(["use [redacted]", "token [redacted] and [redacted]"]);
  });

  it("cuts a body to the item limit, ending in … (shortened)", async () => {
    const { buildHandoff } = await handoff();
    const [item] = buildHandoff(input({ earlier: [report(1, "é".repeat(20_000))] }));
    expect(Buffer.byteLength(item!.body!, "utf8")).toBeLessThanOrEqual(HANDOFF_ITEM_MAX_BYTES);
    expect(item!.body!.endsWith("… (shortened)")).toBe(true);
    const [fits] = buildHandoff(input({ earlier: [report(1, "a".repeat(HANDOFF_ITEM_MAX_BYTES))] }));
    expect(fits!.body).toBe("a".repeat(HANDOFF_ITEM_MAX_BYTES));
  });

  it("drops the oldest reports first when the items together pass the total limit, and never the start item", async () => {
    const { buildHandoff } = await handoff();
    const earlier = Array.from({ length: 6 }, (_unused, at) => report(at + 1, `${String(at + 1)}`.repeat(16_000)));
    const items = buildHandoff(input({ startInput: "go", mode: "all", earlier }));
    expect(items[0]).toMatchObject({ kind: "text", ref: "start" });
    const total = items.reduce((sum, item) => sum + Buffer.byteLength(item.body ?? "", "utf8"), 0);
    expect(total).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
    // Four of 16,000 bytes fit under 65,536; they are the four newest.
    expect(items.slice(1).map((item) => item.ref)).toEqual([6, 5, 4, 3].map((seq) => `chain:crn_aaaaaaaaaaaaaaaaaaaa:${String(seq)}`));
  });

  it("leaves a report with no text without a body, which Plan 3's context item does not accept empty", async () => {
    const { buildHandoff } = await handoff();
    const [item] = buildHandoff(input({ earlier: [report(1, "")] }));
    expect(item).toEqual({ kind: "report", ref: "chain:crn_aaaaaaaaaaaaaaaaaaaa:1", title: 'Step "Step 1" (Root-cause analyst version 1)' });
  });
});

// ---- events

describe("run events", () => {
  it("numbers an event after the run's last one, in the run's own partition", async () => {
    const { runEventItem } = await runEvents();
    const item = runEventItem("T", { orgId: ORG_A, runId: "crn_aaaaaaaaaaaaaaaaaaaa", eventSeq: 6 }, { type: "step_started", stepSeq: 2, text: "Step started." }, "2026-10-22T09:00:00.000Z") as { Put: { Item: Record<string, unknown>; ConditionExpression: string } };
    expect(item.Put.Item).toMatchObject({ ...chainRunKey(ORG_A, "crn_aaaaaaaaaaaaaaaaaaaa", runEventSk(7)), orgId: ORG_A, seq: 7, type: "step_started", stepSeq: 2, text: "Step started.", at: "2026-10-22T09:00:00.000Z" });
    expect(item.Put.ConditionExpression).toBe("attribute_not_exists(pk)");
  });

  it("neutralises control, invisible and direction characters and cuts to 500 characters", async () => {
    const { neutralText } = await runEvents();
    expect(neutralText("a\u0007b‮c​d\ne\tf")).toBe("a[U+0007]b[U+202E]c[U+200B]d[U+000A]e[U+0009]f");
    expect(neutralText("x".repeat(600), 500)).toBe(`${"x".repeat(499)}…`);
    expect(neutralText("plain text, ünïcode and 😀")).toBe("plain text, ünïcode and 😀");
  });

  it("appends an event alone: the next number, the run's event count and version moved in one transaction", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { appendRunEvent } = await runEvents();
    const before = w.run(run.runId)!;
    await appendRunEvent(w.deps, ORG_A, run.runId, { type: "resumed", text: "A note." });
    const after = w.run(run.runId)!;
    expect(after.eventSeq).toBe(before.eventSeq + 1);
    expect(after.version).toBe(before.version + 1);
    expect(w.events(run.runId).at(-1)).toMatchObject({ seq: after.eventSeq, type: "resumed", text: "A note." });
  });
});

// ---- the worked example

describe("the worked example: investigate, then fix", () => {
  it("runs every step with its own agent, hands each report forward as context, and ends with the run's slot given back", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX, { name: "Investigate" });
    const { onStepTaskEnded, recordGateDecision } = await runner();

    const run = await startAs(w, PRIYA, chain.chainId, { input: "Refunds fail twice" });
    expect(run).toMatchObject({
      orgId: ORG_A, chainId: chain.chainId, chainName: "Investigate", chainVersion: 1, project: "web", chainOwner: { kind: "member", developerId: PRIYA },
      owner: { developerId: PRIYA }, startedBy: { kind: "member", developerId: PRIYA }, payer: { kind: "member", developerId: PRIYA }, origin: "app",
      status: "running", currentSeq: 1, stepRuns: 1, traversals: {}, runLimitUsd: 30, spentUsd: 0, input: "Refunds fail twice",
    });
    expect(run.runId).toMatch(/^crn_[0-9a-z]{20}$/);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(1);

    // Step 1: the Root-cause analyst, at its pinned version, with the person's words as the only context.
    expect(w.starts).toHaveLength(1);
    expect(w.starts[0]).toMatchObject({
      orgId: ORG_A, project: "web", agent: { agentId: "root-cause-analyst", version: currentBuiltinVersion("root-cause-analyst") }, origin: "chain",
      owner: { developerId: PRIYA }, startedBy: { developerId: PRIYA }, payer: { kind: "member", developerId: PRIYA },
      chain: { chainRunId: run.runId, stepId: "investigate" }, runLimitUsd: 30,
      input: { text: "Do your job for this chain run.", context: [{ kind: "text", ref: "start", body: "Refunds fail twice" }] },
      resultContract: { branches: [{ id: "fix", description: "The cause is in our code and a code change fixes it" }, { id: "no_fix", description: "Not a code problem, or not enough evidence" }] },
    });
    expect(w.starts[0]!.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(w.attempts(run.runId)).toHaveLength(1);
    expect(w.attempts(run.runId)[0]).toMatchObject({
      seq: 1, stepId: "investigate", kind: "agent", attempt: 1, status: "running", taskId: "task-1", grantedRunLimitUsd: 2, stopAtUsd: 2, remainingAtStartUsd: 30,
      stepName: "Find the cause", agent: { agentId: "root-cause-analyst", name: name("root-cause-analyst"), version: currentBuiltinVersion("root-cause-analyst") },
    });
    expect(w.attempts(run.runId)[0]!.inputDigest).toMatch(/^[a-f0-9]{64}$/);

    // It reports and picks "fix": the gate opens, and nothing starts until a person decides.
    await onStepTaskEnded(w.deps, w.endEvent("task-1", { finalReport: "Bug in refund retry", branch: "fix", spentUsd: 0.75 }));
    expect(w.starts).toHaveLength(1);
    expect(w.run(run.runId)).toMatchObject({ status: "waiting", currentSeq: 2, spentUsd: 0.75, traversals: { "investigate>approve_fix": 1 } });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "succeeded", result: { report: "Bug in refund retry", branch: "fix" }, branch: { id: "fix", fellBack: false } });
    expect(w.attempts(run.runId)[1]).toMatchObject({ seq: 2, stepId: "approve_fix", kind: "gate", status: "waiting" });

    // Task 8 fakes the decision: the gate is approved and Rovara Code starts with the report as context.
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved");
    expect(w.starts).toHaveLength(2);
    expect(w.starts[1]).toMatchObject({
      agent: { agentId: "rovara-code", version: currentBuiltinVersion("rovara-code") }, chain: { chainRunId: run.runId, stepId: "fix" }, runLimitUsd: 29.25,
      input: {
        text: "Fix the cause the investigation found. Keep the change small.",
        context: [
          { kind: "text", ref: "start", body: "Refunds fail twice" },
          { kind: "report", ref: `chain:${run.runId}:1`, title: `Step "Find the cause" (${name("root-cause-analyst")} version ${String(currentBuiltinVersion("root-cause-analyst"))})`, body: "Bug in refund retry" },
        ],
      },
    });
    expect(w.starts[1]).not.toHaveProperty("resultContract");
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 3, stepRuns: 2 });

    // Rovara Code's end carries a pull request: its result is data the runner built, and the reviewer reads the link in it.
    await onStepTaskEnded(w.deps, w.endEvent("task-2", { finalReport: "ignored for a coding task", pullRequests: [{ repository: "web", number: 12, url: "https://github.com/acme/web/pull/12" }], spentUsd: 1.25 }));
    expect(w.attempts(run.runId)[2]).toMatchObject({
      status: "succeeded", result: { report: "Rovara Code finished: succeeded.", links: [{ label: "Pull request web#12", url: "https://github.com/acme/web/pull/12" }] },
    });
    expect(w.starts).toHaveLength(3);
    expect(w.starts[2]).toMatchObject({ agent: { agentId: "code-reviewer" }, chain: { stepId: "review" }, runLimitUsd: 28 });
    const reviewerContext = (w.starts[2]!.input.context ?? []) as Array<{ kind: string; ref: string; body?: string }>;
    // The reviewer's step receives the previous step's report and the start, not the investigation.
    expect(reviewerContext.map((item) => item.ref)).toEqual(["start", `chain:${run.runId}:3`]);
    expect(reviewerContext[1]!.body).toContain("https://github.com/acme/web/pull/12");

    await endTask(w, "task-3", { finalReport: "Looks good", spentUsd: 0.5 });
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded", spentUsd: 2.5, currentSeq: 4 });
    expect(w.run(run.runId)!.endedAt).toBe(new Date(START).toISOString());
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
    expect(w.openItems()).toEqual([]);
    expect(w.events(run.runId).map((event) => event.seq)).toEqual(Array.from({ length: w.events(run.runId).length }, (_unused, at) => at + 1));
    expect(w.events(run.runId).map((event) => event.type)).toEqual([
      "started", "step_started", "step_ended", "branch", "gate_waiting", "gate_decided", "step_started", "step_ended", "step_started", "step_ended", "ended",
    ]);
    expect(w.run(run.runId)!.eventSeq).toBe(w.events(run.runId).length);
  });

  it("indexes the run by chain and by project and keeps its open item due", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    const created = w.run(run.runId)!.createdAt;
    expect(w.db.find((item) => String(item.pk).includes(`CHAIN_RUNS#${chain.chainId}`))).toHaveLength(1);
    expect(w.db.find((item) => String(item.pk).includes("CHAIN_RUNS_P#web"))).toHaveLength(1);
    expect(created).toBe(new Date(START).toISOString());
    expect(Date.parse(run.dueAt)).toBeGreaterThan(START);
    expect(w.openItems()).toEqual([expect.objectContaining({ ...openChainRunKey(run.dueAt, ORG_A, run.runId), orgId: ORG_A, runId: run.runId })]);
  });

  it("takes the no_fix branch to the end with no gate, and the default when the agent picks none", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const first = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "Not our code", branch: "no_fix" });
    expect(w.run(first.runId)).toMatchObject({ status: "succeeded", currentSeq: 1 });
    expect(w.events(first.runId).find((event) => event.type === "branch")!.text).toBe(`${name("root-cause-analyst")} chose "no_fix": Not a code problem, or not enough evidence`);

    const second = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-2", { finalReport: "No idea" });
    expect(w.run(second.runId)).toMatchObject({ status: "succeeded" });
    expect(w.attempts(second.runId)[0]).toMatchObject({ branch: { id: "no_fix", fellBack: true } });
    expect(w.events(second.runId).find((event) => event.type === "branch")!.text).toBe(`${name("root-cause-analyst")} chose no designed branch, so the chain took "no_fix".`);
  });

  it("fails the run when the agent picks a branch the design does not have and there is no default", async () => {
    const w = setupWorld();
    const design: ChainDefinitionInput = { ...INVESTIGATE_THEN_FIX, steps: INVESTIGATE_THEN_FIX.steps.map((step) => (step.kind === "agent" && step.id === "investigate" && step.next.kind === "branch" ? { ...step, next: { ...step.next, default: undefined } } : step)) };
    const chain = await w.publish(design);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "Deploy it", branch: "deploy" });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { seq: 1, reason: "branch_invalid", message: `${name("root-cause-analyst")} chose no branch this chain has.` } });
    expect(w.starts).toHaveLength(1);
  });

  it("stops a loop at its bound with the exact text", async () => {
    const w = setupWorld();
    const design: ChainDefinitionInput = {
      start: "check", limits: { maxRunUsd: 30 },
      steps: [
        agentStep("check", "Check", "root-cause-analyst", { kind: "branch", default: "done", choices: [{ id: "retry", description: "Try again", to: "check", maxTraversals: 1 }, { id: "done", description: "Done", to: "$end" }] }),
      ],
    };
    const chain = await w.publish(design);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "again", branch: "retry" });
    expect(w.starts).toHaveLength(2);
    await endTask(w, "task-2", { finalReport: "again", branch: "retry" });
    expect(w.starts).toHaveLength(2);
    expect(w.run(run.runId)).toMatchObject({ status: "failed", traversals: { "check>check": 1 }, failure: { seq: 2, reason: "loop_limit", message: 'Step "check" was reached 2 times from "check", the most this chain allows.' } });
  });
});

describe("chooseEdge and takeEdge", () => {
  it("follows go, end and a branch's own id, then the default, else says it found none", async () => {
    const { chooseEdge } = await branches();
    const choices = [{ id: "a", description: "A", to: "x" }, { id: "b", description: "B", to: "$end", maxTraversals: 2 }];
    const result = (branch?: string): StepResult => ({ report: "r", ...(branch === undefined ? {} : { branch }) });
    expect(chooseEdge({ kind: "go", to: "x", maxTraversals: 3 }, result())).toEqual({ edge: { to: "x", maxTraversals: 3 }, fellBack: false });
    expect(chooseEdge({ kind: "end" }, result())).toEqual({ edge: { to: "$end" }, fellBack: false });
    expect(chooseEdge({ kind: "branch", choices }, result("b"))).toEqual({ edge: { to: "$end", maxTraversals: 2 }, branch: "b", fellBack: false });
    expect(chooseEdge({ kind: "branch", choices, default: "a" }, result("zzz"))).toEqual({ edge: { to: "x" }, branch: "a", fellBack: true });
    expect(chooseEdge({ kind: "branch", choices, default: "a" }, result())).toEqual({ edge: { to: "x" }, branch: "a", fellBack: true });
    expect(chooseEdge({ kind: "branch", choices }, result("zzz"))).toEqual({ error: "branch_invalid" });
    expect(chooseEdge({ kind: "branch", choices }, result())).toEqual({ error: "branch_invalid" });
  });

  it("counts an edge's traversals and refuses the one past its bound", async () => {
    const { takeEdge } = await branches();
    expect(takeEdge({ traversals: {} }, "a", { to: "b" })).toEqual({ ok: true, traversals: { "a>b": 1 } });
    expect(takeEdge({ traversals: { "a>b": 2, "c>d": 1 } }, "a", { to: "b", maxTraversals: 3 })).toEqual({ ok: true, traversals: { "a>b": 3, "c>d": 1 } });
    expect(takeEdge({ traversals: { "a>b": 3 } }, "a", { to: "b", maxTraversals: 3 })).toEqual({ ok: false, message: 'Step "b" was reached 4 times from "a", the most this chain allows.' });
    // Without a bound an edge may be taken as often as the run's step limit allows.
    expect(takeEdge({ traversals: { "a>b": 50 } }, "a", { to: "b" })).toEqual({ ok: true, traversals: { "a>b": 51 } });
  });
});

// ---- permissions and secrets

describe("each step keeps its own agent's permissions (Review Focus 5)", () => {
  it("starts every step naming only its own agent and pinned version, with no tool grants, approvals or other step's agent", async () => {
    const w = setupWorld();
    const chain = await w.publish(THREE_STEPS_ALL);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 0 });
    await endTask(w, "task-2", { finalReport: "two", spentUsd: 0 });
    expect(w.starts.map((start) => start.agent.agentId)).toEqual(["root-cause-analyst", "ticket-triage", "code-reviewer"]);
    const ALLOWED = ["agent", "chain", "input", "orgId", "origin", "owner", "payer", "project", "requestId", "resultContract", "runLimitUsd", "startedBy"];
    for (const start of w.starts) {
      expect(Object.keys(start).filter((key) => !ALLOWED.includes(key)), start.agent.agentId).toEqual([]);
      expect(Object.keys(start.agent).sort()).toEqual(["agentId", "version"]);
      expect(Object.keys(start.input).sort()).toEqual(["context", "text"]);
      const text = JSON.stringify(start);
      for (const other of ["root-cause-analyst", "ticket-triage", "code-reviewer"].filter((id) => id !== start.agent.agentId)) expect(text, `${start.agent.agentId} names ${other}`).not.toContain(`"agentId":"${other}"`);
      expect(text).not.toMatch(/approval|grant|tool/iu);
    }
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 3 });
  });

  it("gives the third step both earlier reports when it asks for all of them, newest first", async () => {
    const w = setupWorld();
    const chain = await w.publish(THREE_STEPS_ALL);
    const run = await startAs(w, PRIYA, chain.chainId, { input: "go" });
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 0 });
    expect(((w.starts[1]!.input.context ?? []) as Array<{ ref: string }>).map((item) => item.ref)).toEqual(["start", `chain:${run.runId}:1`]);
    await endTask(w, "task-2", { finalReport: "two", spentUsd: 0 });
    expect(((w.starts[2]!.input.context ?? []) as Array<{ ref: string; body?: string }>).map((item) => [item.ref, item.body])).toEqual([
      ["start", "go"], [`chain:${run.runId}:2`, "two"], [`chain:${run.runId}:1`, "one"],
    ]);
  });

  it("never carries a token in one step's report to the next step", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: `Found ghs_${"a".repeat(36)} and AKIAABCDEFGHIJKLMNOP in the logs` });
    const context = (w.starts[1]!.input.context ?? []) as Array<{ body?: string }>;
    expect(context[0]!.body).toBe("Found [redacted] and [redacted] in the logs");
    expect(JSON.stringify(w.starts[1])).not.toContain("ghs_");
    expect(JSON.stringify(w.starts[1])).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });
});

// ---- starting a run: the checks, in order, with nothing written before the transaction

describe("startChainRun refusals", () => {
  const nothingWritten = (w: ChainWorld) => {
    expect(w.db.find((item) => String(item.pk).includes("CHAIN_RUN"))).toEqual([]);
    expect(w.openItems()).toEqual([]);
    expect(w.starts).toEqual([]);
  };

  it("refuses a person who can't use a step's agent, naming the chain and the agent, and writes nothing (Review Focus 5)", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", DANA);
    const chain = await w.publish({ ...TWO_STEPS, steps: [TWO_STEPS.steps[0]!, agentStep("review", "Review it", reviewer.agentId, { kind: "end" })] }, { name: "Triage", owner: { kind: "member", developerId: DANA }, by: DANA });
    await setChainShares({ ...w.deps, store: w.chains }, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: PRIYA }, level: "use" }], by: DANA });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toEqual({ code: "FORBIDDEN", message: "Triage uses Reviewer, which you can't use. Ask Reviewer's owner to share it with you." });
    nothingWritten(w);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
  });

  it("answers a chain the person can't see as not found, and another org's chain the same", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "member", developerId: DANA }, by: DANA });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toMatchObject({ code: "NOT_FOUND" });
    const { startChainRun } = await runner();
    expect(await fail(startChainRun(w.deps, callerOf(STRANGER, ORG_B), { orgId: ORG_B, chainId: chain.chainId, project: "web", origin: "app", startedBy: { kind: "member", developerId: STRANGER }, requestId: randomUUID() } as never))).toMatchObject({ code: "NOT_FOUND" });
    nothingWritten(w);
  });

  it("refuses a person who may only view the chain", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "member", developerId: DANA }, by: DANA });
    await setChainShares({ ...w.deps, store: w.chains }, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: PRIYA }, level: "view" }], by: DANA });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toMatchObject({ code: "FORBIDDEN" });
    nothingWritten(w);
  });

  it("refuses a viewer of the project, a person with no role on it, and an archived project", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "member", developerId: DANA }, by: DANA });
    await setChainShares({ ...w.deps, store: w.chains }, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "org" }, level: "use" }], by: DANA });
    expect(await fail(startAs(w, VIV, chain.chainId))).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(await fail(startAs(w, ARJUN, chain.chainId))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    nothingWritten(w);
    w.db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", status: "archived" });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toMatchObject({ code: "PROJECT_ARCHIVED" });
    nothingWritten(w);
  });

  it("says an archived chain can't start runs, and a chain with no published version the same way", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage" });
    await w.chains.archive(ORG_A, chain.chainId, PRIYA);
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toEqual({ code: "CHAIN_UNAVAILABLE", message: "Triage is archived, so it can't start new runs." });
    const draft = await w.chains.create({ orgId: ORG_A, name: "Draft only", owner: { kind: "member", developerId: PRIYA }, definition: ONE_STEP, createdBy: PRIYA });
    expect(await fail(startAs(w, PRIYA, draft.chainId))).toEqual({ code: "CHAIN_UNAVAILABLE", message: "Draft only has no published version yet, so it can't start new runs." });
    nothingWritten(w);
  });

  it("refuses an input over 8,000 characters, a start that does not match its caller or origin, and an org other than the caller's", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    expect(await fail(startAs(w, PRIYA, chain.chainId, { input: "x".repeat(8001) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("input") as string });
    await expect(startAs(w, PRIYA, chain.chainId, { input: "é".repeat(8000) })).resolves.toMatchObject({ status: "running" });
    expect(await fail(startAs(w, PRIYA, chain.chainId, { startedBy: { kind: "member", developerId: CARL } }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAs(w, PRIYA, chain.chainId, { startedBy: EVENT_STARTED() }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAs(w, PRIYA, chain.chainId, { origin: "event" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAs(w, PRIYA, chain.chainId, { origin: "chain" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAs(w, PRIYA, chain.chainId, { orgId: ORG_B }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("says a step's agent that was archived since the chain was published can't run, with the step message", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", PRIYA);
    const chain = await w.publish({ ...TWO_STEPS, steps: [TWO_STEPS.steps[0]!, agentStep("review", "Review it", reviewer.agentId, { kind: "end" })] }, { name: "Triage" });
    await w.agents.archive(ORG_A, reviewer.agentId, PRIYA);
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toEqual({
      code: "CHAIN_UNAVAILABLE",
      message: "Triage's step \"Review it\" uses Reviewer version 1, which can't run now: Reviewer is archived, so it can't start new work. Ask Triage's owner to publish a new version.",
    });
    nothingWritten(w);
  });

  it("says the same of an archived agent the person only has view of, not that they may not use it", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", DANA);
    const chain = await w.publish({ ...TWO_STEPS, steps: [TWO_STEPS.steps[0]!, agentStep("review", "Review it", reviewer.agentId, { kind: "end" })] }, { name: "Triage", owner: { kind: "member", developerId: DANA }, by: DANA });
    await setChainShares({ ...w.deps, store: w.chains }, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: PRIYA }, level: "use" }], by: DANA });
    await w.agents.archive(ORG_A, reviewer.agentId, DANA);
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toMatchObject({ code: "CHAIN_UNAVAILABLE", message: expect.stringContaining("Reviewer is archived") as string });
  });

  it("gives a custom step agent that is not on the project's roster AGENT_NOT_ON_PROJECT's reason", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", PRIYA, []);
    const chain = await w.publish({ ...TWO_STEPS, steps: [TWO_STEPS.steps[0]!, agentStep("review", "Review it", reviewer.agentId, { kind: "end" })] }, { name: "Triage" });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toEqual({
      code: "CHAIN_UNAVAILABLE",
      message: "Triage's step \"Review it\" uses Reviewer version 1, which can't run now: Reviewer isn't working on web yet. Ask a project maintainer to add it. Ask Triage's owner to publish a new version.",
    });
    nothingWritten(w);
  });

  it("refuses a sixth concurrent run with the exact text, writes nothing for it, and takes a new one when one has ended", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage" });
    const runs = [];
    for (let at = 0; at < 5; at += 1) runs.push(await startAs(w, PRIYA, chain.chainId));
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toEqual({ code: "FORBIDDEN", message: "Triage already has 5 runs going. Wait for one to finish." });
    expect(w.db.find((item) => item.entityType === "CHAIN_RUN")).toHaveLength(5);
    expect(w.openItems()).toHaveLength(5);
    expect(w.starts).toHaveLength(5);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(5);
    await endTask(w, "task-1", { finalReport: "done" });
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(4);
    await expect(startAs(w, PRIYA, chain.chainId)).resolves.toMatchObject({ status: "running" });
    expect(runs).toHaveLength(5);
  });

  it("refuses a start of a chain whose published version moved while it was starting, rather than start the old one", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage" });
    // A publish lands between the start's reads and its transaction.
    const real = w.db.send;
    let fired = false;
    (w.deps.documentClient as { send: unknown }).send = async (command: { constructor: { name: string } }) => {
      if (!fired && command.constructor.name === "TransactWriteCommand") {
        fired = true;
        w.db.set({ ...chainKey(ORG_A, chain.chainId, "META"), ...(w.db.get(chainKey(ORG_A, chain.chainId, "META")) ?? {}), currentVersion: 7 });
      }
      return real(command as never);
    };
    // The start reads again and takes the version that runs now (it has no such version to read, so it is unavailable), but it never runs the one it read.
    const outcome = await fail(startAs(w, PRIYA, chain.chainId));
    (w.deps.documentClient as { send: unknown }).send = real;
    expect(outcome).toBeDefined();
    expect(w.starts).toEqual([]);
    expect(w.db.find((item) => item.entityType === "CHAIN_RUN")).toEqual([]);
  });

  it("is admitted against the chain's budget: an event run of a chain with no monthly budget is refused with the exact text", async () => {
    const w = setupWorld({ admission: true });
    const chain = await w.publish(ONE_STEP, { name: "Triage", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    expect(await fail(startAsEvent(w, chain.chainId, CARL))).toEqual({ code: "CHAIN_BUDGET_REQUIRED", message: "Triage has no monthly budget and run limit, so events and schedules can't start it. Ask its owner to set both." });
    nothingWritten(w);
    await w.chains.setBudget(ORG_A, chain.chainId, 20, DANA);
    await expect(startAsEvent(w, chain.chainId, CARL)).resolves.toMatchObject({ status: "running", payer: { kind: "chain", chainId: chain.chainId } });
  });
});

describe("startChainRun payers and owners", () => {
  it("charges the project when it pays for its tasks, and the person otherwise", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    expect((await startAs(w, PRIYA, chain.chainId)).payer).toEqual({ kind: "member", developerId: PRIYA });
    w.db.set({ ...projectAiKey(ORG_A, "web"), entityType: "PROJECT_AI", projectPays: true, revision: 1 });
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(run.payer).toEqual({ kind: "project", project: "web" });
    expect(w.starts.at(-1)).toMatchObject({ payer: { kind: "project", project: "web" }, startedBy: { developerId: PRIYA }, owner: { developerId: PRIYA } });
  });

  it("starts an event run of a project-owned chain as the trigger's creator, with no starter, paid by the chain", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    const run = await startAsEvent(w, chain.chainId, CARL);
    expect(run).toMatchObject({
      owner: { developerId: CARL }, chainOwner: { kind: "project", project: "web" }, startedBy: EVENT_STARTED(), origin: "event", payer: { kind: "chain", chainId: chain.chainId }, runLimitUsd: 30,
    });
    expect(run).not.toHaveProperty("input");
    expect(w.starts).toHaveLength(1);
    expect(w.starts[0]).toMatchObject({ owner: { developerId: CARL }, payer: { kind: "chain", chainId: chain.chainId }, origin: "chain", chain: { chainRunId: run.runId, stepId: "investigate" } });
    expect(w.starts[0]).not.toHaveProperty("startedBy");
    expect(w.starts[0]!.input.context).toEqual([expect.objectContaining({ kind: "alert", ref: "sentry:evt-1", title: "Refund errors" })]);
  });

  it("gives a schedule run the same footing: the chain's member owner, no starter", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const { startChainRun } = await runner();
    const run = await startChainRun(w.deps, { system: "schedule", owner: { developerId: PRIYA } }, {
      orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "schedule", startedBy: { kind: "schedule", triggerId: TRIGGER_ID, scheduledAt: "2026-10-22T08:00:00.000Z" }, requestId: randomUUID(),
    } as never);
    expect(run).toMatchObject({ owner: { developerId: PRIYA }, startedBy: { kind: "schedule", triggerId: TRIGGER_ID }, payer: { kind: "chain", chainId: chain.chainId } });
    expect(w.starts[0]).not.toHaveProperty("startedBy");
  });

  it("refuses an event run whose owner can no longer use a step's agent, with the step message", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", DANA);
    const chain = await w.publish({ ...TWO_STEPS, steps: [TWO_STEPS.steps[0]!, agentStep("review", "Review it", reviewer.agentId, { kind: "end" })] }, { name: "Triage", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    expect(await fail(startAsEvent(w, chain.chainId, CARL))).toEqual({
      code: "CHAIN_UNAVAILABLE",
      message: "Triage's step \"Review it\" uses Reviewer version 1, which can't run now: its owner can no longer use it. Ask Triage's owner to publish a new version.",
    });
    expect(w.starts).toEqual([]);
  });

  it("refuses an event run whose owner can't start tasks on the project, or is not a member", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    for (const owner of [VIV, ARJUN, "9".repeat(64)]) {
      expect(await fail(startAsEvent(w, chain.chainId, owner)), owner).toMatchObject({ code: "CHAIN_UNAVAILABLE", message: expect.stringContaining("its owner can no longer use it") as string });
    }
    expect(w.starts).toEqual([]);
  });

  it("refuses an autonomous start whose agent is not on the roster, as the roster check of the autonomous path does", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", DANA, []);
    const chain = await w.publish({ ...ONE_STEP, start: "r", steps: [agentStep("r", "Review", reviewer.agentId, { kind: "end" })] }, { name: "Triage", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    // Carl can't use the agent, so the owner check refuses first; a roster-only failure is covered above for a person.
    expect(await fail(startAsEvent(w, chain.chainId, CARL))).toMatchObject({ code: "CHAIN_UNAVAILABLE" });
  });
});

describe("startChainRun and the event that started it", () => {
  it("starts the first step with a 200-character title ending in an ellipsis from a Sentry event whose title is 300 characters", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    const title = `${"E".repeat(299)}!`;
    const run = await startAsEvent(w, chain.chainId, CARL, { startedBy: EVENT_STARTED({ title }), trigger: SENTRY({ subject: { kind: "alert", title } }) });
    expect(run.startedBy).toMatchObject({ title });
    const [start] = (w.starts[0]!.input.context ?? []) as Array<{ title?: string; kind: string }>;
    expect(start!.title).toHaveLength(200);
    expect(start!.title).toBe(`${"E".repeat(199)}…`);
  });

  it.each([
    ["pull_request", "pull_request"], ["issue", "ticket"], ["incident", "alert"], ["alert", "alert"], ["deployment", "deploy"], ["workflow_run", "deploy"],
  ])("makes the start item of a %s event a %s item, in every later step too", async (subject, kind) => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    const run = await startAsEvent(w, chain.chainId, CARL, { trigger: SENTRY({ subject: { kind: subject, title: "Something happened" } }) });
    expect(((w.starts[0]!.input.context ?? []) as Array<{ kind: string; ref: string }>).map((item) => [item.kind, item.ref])).toEqual([[kind, "sentry:evt-1"]]);
    await endTask(w, "task-1", { finalReport: "one" });
    expect(((w.starts[1]!.input.context ?? []) as Array<{ kind: string; ref: string }>).map((item) => [item.kind, item.ref])).toEqual([[kind, "sentry:evt-1"], ["report", `chain:${run.runId}:1`]]);
  });

  it("refuses an event whose shape is not an event's, and an event that is not the run's own kind of start", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    expect(await fail(startAsEvent(w, chain.chainId, CARL, { trigger: SENTRY({ subject: { kind: "robot", title: "x" } }) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAsEvent(w, chain.chainId, CARL, { trigger: SENTRY({ eventKey: "" }) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAsEvent(w, chain.chainId, CARL, { startedBy: { kind: "schedule", triggerId: TRIGGER_ID, scheduledAt: "2026-10-22T08:00:00.000Z" } }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.starts).toEqual([]);
  });

  it("writes nothing when the start's transaction fails: no run, no index, no open item, no count", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "None" }] } });
    await expect(startAs(w, PRIYA, chain.chainId)).rejects.toThrow();
    expect(w.db.find((item) => String(item.pk).includes("CHAIN_RUN"))).toEqual([]);
    expect(w.openItems()).toEqual([]);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
    expect(w.starts).toEqual([]);
  });
});

describe("startChainRun replays (R18)", () => {
  it("answers a repeat of the same request with the stored run and writes nothing", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const requestId = randomUUID();
    const first = await startAs(w, PRIYA, chain.chainId, { requestId, input: "go" });
    const before = JSON.stringify([...w.db.items.entries()]);
    const again = await startAs(w, PRIYA, chain.chainId, { requestId, input: "go" });
    expect(again).toEqual(first);
    expect(JSON.stringify([...w.db.items.entries()])).toBe(before);
    expect(w.starts).toHaveLength(1);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(1);
  });

  it("answers the stored run of a repeat even after the chain was archived and the run ended", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const requestId = randomUUID();
    const first = await startAs(w, PRIYA, chain.chainId, { requestId });
    await endTask(w, "task-1", { finalReport: "done" });
    await w.chains.archive(ORG_A, chain.chainId, PRIYA);
    const again = await startAs(w, PRIYA, chain.chainId, { requestId });
    expect(again.runId).toBe(first.runId);
    expect(again.status).toBe("succeeded");
  });

  it("refuses the same request id with another body", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const requestId = randomUUID();
    await startAs(w, PRIYA, chain.chainId, { requestId, input: "go" });
    expect(await fail(startAs(w, PRIYA, chain.chainId, { requestId, input: "something else" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAs(w, PRIYA, chain.chainId, { requestId, input: "go", project: "api" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.starts).toHaveLength(1);
  });

  it("gives two people the same request id two runs", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "member", developerId: DANA }, by: DANA });
    await setChainShares({ ...w.deps, store: w.chains }, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "org" }, level: "use" }], by: DANA });
    const requestId = randomUUID();
    const one = await startAs(w, PRIYA, chain.chainId, { requestId });
    const two = await startAs(w, CARL, chain.chainId, { requestId });
    expect(one.runId).not.toBe(two.runId);
  });

  it("takes the run a given runId names, and answers its stored run to a lost race", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    const runId = "crn_zzzzzzzzzzzzzzzzzzzz";
    const first = await startAsEvent(w, chain.chainId, CARL, { runId });
    expect(first.runId).toBe(runId);
    const second = await startAsEvent(w, chain.chainId, CARL, { runId, requestId: randomUUID() });
    expect(second.runId).toBe(runId);
    expect(w.db.find((item) => item.entityType === "CHAIN_RUN")).toHaveLength(1);
    expect(w.starts).toHaveLength(1);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(1);
  });

  it("finishes a run whose first step was never started when the same request comes again", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const requestId = randomUUID();
    // The process died right after the run's transaction: the run exists with no step at all.
    const real = w.db.send;
    (w.deps.documentClient as { send: unknown }).send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("STEP#0001")) throw new Error("the process died");
      return real(command);
    };
    await fail(startAs(w, PRIYA, chain.chainId, { requestId }));
    (w.deps.documentClient as { send: unknown }).send = real;
    expect(w.attempts((w.db.find((item) => item.entityType === "CHAIN_RUN")[0] as { runId: string }).runId)).toEqual([]);
    const again = await startAs(w, PRIYA, chain.chainId, { requestId });
    expect(w.attempts(again.runId)).toHaveLength(1);
    expect(w.starts).toHaveLength(1);
  });
});

// ---- step completion

describe("onStepTaskEnded", () => {
  it("is handled once: the same end twice, one after the other and at the same time, starts the next step once", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskEnded } = await runner();
    const event = w.endEvent("task-1", { finalReport: "one", spentUsd: 0.5 });
    await onStepTaskEnded(w.deps, event);
    await onStepTaskEnded(w.deps, event);
    await Promise.all([onStepTaskEnded(w.deps, event), onStepTaskEnded(w.deps, event)]);
    expect(w.starts).toHaveLength(2);
    expect(w.tasks.size).toBe(2);
    expect(w.attempts(run.runId)).toHaveLength(2);
    expect(w.run(run.runId)!.spentUsd).toBe(0.5);
    expect(w.events(run.runId).filter((item) => item.type === "step_ended")).toHaveLength(1);
  });

  it("does nothing for an event with no chain, for a task of another run, for an unknown run and for another org's", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const one = await startAs(w, PRIYA, chain.chainId);
    const two = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskEnded } = await runner();
    const before = JSON.stringify([...w.db.items.entries()]);
    const real = w.endEvent("task-1", { finalReport: "x" });
    const { chain: _chain, ...unchained } = real; // eslint-disable-line @typescript-eslint/no-unused-vars -- the point is that there is none
    await onStepTaskEnded(w.deps, unchained);
    // Task 1 belongs to run one; named under run two it matches no attempt of run two.
    await onStepTaskEnded(w.deps, { ...real, chain: { chainRunId: two.runId, stepId: "look" } });
    await onStepTaskEnded(w.deps, { ...real, chain: { chainRunId: "crn_nnnnnnnnnnnnnnnnnnnn", stepId: "look" } });
    await onStepTaskEnded(w.deps, { ...real, chain: { chainRunId: "not a run id", stepId: "look" } });
    await onStepTaskEnded(w.deps, { ...real, orgId: ORG_B });
    expect(JSON.stringify([...w.db.items.entries()])).toBe(before);
    expect(w.starts).toHaveLength(2);
    expect(one.runId).not.toBe(two.runId);
  });

  it("settles a step's spend into the run and writes what a person approved beyond the run's limit as an event", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    // The step started with 30 left and spent 4.2; $10 more than the run had left was approved for it.
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 4.2, runLimitUsd: 40 });
    expect(w.run(run.runId)).toMatchObject({ spentUsd: 4.2, runLimitUsd: 40 });
    expect(w.starts[1]!.runLimitUsd).toBe(35.8);
    expect(w.events(run.runId).filter((item) => item.type === "step_ended").map((item) => item.text)).toEqual(['Step "Look into it" finished.', "Someone approved $10 more for this run."]);
  });

  it("adds nothing to the run's limit for a raise inside what the run had left", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 5, runLimitUsd: 30 });
    expect(w.run(run.runId)).toMatchObject({ spentUsd: 5, runLimitUsd: 30 });
    expect(w.events(run.runId).filter((item) => item.type === "step_ended")).toHaveLength(1);
  });

  it("fails an agent step that ended with no report, and the run with it", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "" });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "failed", failure: { reason: "result_invalid", message: `${name("root-cause-analyst")} finished without a report.` } });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { seq: 1, reason: "result_invalid", message: `Step "Look into it" failed: ${name("root-cause-analyst")} finished without a report.` } });
    const missing = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-2", {});
    expect(w.run(missing.runId)).toMatchObject({ status: "failed", failure: { reason: "result_invalid" } });
    expect(w.starts).toHaveLength(2);
  });

  it.each([
    ["failed", "failed", "failed"], ["cancelled", "cancelled", "cancelled"], ["creator_removed", "cancelled", "cancelled"], ["closed", "cancelled", "cancelled"],
  ])("takes an end of %s as the attempt's %s and the run's %s, and starts nothing", async (outcome, attemptStatus, runStatus) => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { outcome, spentUsd: 1 });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: attemptStatus });
    expect(w.run(run.runId)).toMatchObject({ status: runStatus, spentUsd: 1 });
    expect(w.starts).toHaveLength(1);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
    expect(w.openItems()).toEqual([]);
  });

  it("gives a failed run the task's own reason, neutralised and cut", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get({ pk: "DEVTASK#task-1", sk: "AGENT_RUN" })!, endReason: `The tool said ‮evil\u0007 with ghp_${"a".repeat(36)} ${"y".repeat(400)}` });
    await endTask(w, "task-1", { outcome: "failed" });
    const message = w.run(run.runId)!.failure!.message;
    expect(message.startsWith('Step "Look into it" failed: The tool said [U+202E]evil[U+0007] with [redacted] ')).toBe(true);
    expect(message.includes("\u202e") || message.includes("\u0007")).toBe(false);
    expect(message.endsWith("….")).toBe(true);
    expect(message.length).toBeLessThan(400);
    const lastText = w.events(run.runId).at(-1)!.text;
    expect(lastText.includes("\u202e") || lastText.includes("\u0007")).toBe(false);
  });

  it("says why a coding task failed in its own words when the task has none", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "r", branch: "fix" });
    const { recordGateDecision } = await runner();
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved");
    await endTask(w, "task-2", { outcome: "failed" });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { reason: "step_failed", message: 'Step "Fix it" failed: it did not finish.' } });
  });

  it("takes a merged coding task as a success with its pull requests as links, and drops a pull request link that is not https", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "r", branch: "fix" });
    const { recordGateDecision } = await runner();
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved");
    await endTask(w, "task-2", { outcome: "merged", pullRequests: [{ repository: "web", number: 1, url: "https://github.com/acme/web/pull/1" }, { repository: "web", number: 2, url: "http://github.com/acme/web/pull/2" }] });
    expect(w.attempts(run.runId)[2]).toMatchObject({ status: "succeeded", result: { report: "Rovara Code finished: merged.", links: [{ label: "Pull request web#1", url: "https://github.com/acme/web/pull/1" }] } });
  });

  it("does nothing for a task whose attempt already ended another way, and leaves a cancelled run cancelled", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, status: "cancelled", endedAt: "2026-10-22T09:00:00.000Z" });
    await endTask(w, "task-1", { finalReport: "late" });
    expect(w.run(run.runId)!.status).toBe("cancelled");
    expect(w.starts).toHaveLength(1);
    expect(w.attempts(run.runId)[0]!.status).toBe("running");
  });

  it("fails the run, at the start of the step, when it would be the one past the step limit", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, stepRuns: CHAIN_MAX_STEP_RUNS });
    await endTask(w, "task-1", { finalReport: "one" });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { seq: 1, reason: "step_limit", message: "This run reached 30 steps, the most a chain run may take." } });
    expect(w.starts).toHaveLength(1);
    expect(w.attempts(run.runId)).toHaveLength(1);
    // One below the limit still starts.
    const other = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, other.runId, "META"))!, stepRuns: CHAIN_MAX_STEP_RUNS - 1 });
    await endTask(w, "task-2", { finalReport: "one" });
    expect(w.run(other.runId)).toMatchObject({ status: "running", stepRuns: CHAIN_MAX_STEP_RUNS });
  });
});

// ---- starting a step

describe("starting a step", () => {
  it("starts a step that has no limit left paused, and the run with it", async () => {
    const w = setupWorld();
    const chain = await w.publish({ ...TWO_STEPS, limits: { maxRunUsd: 0.5 } });
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 0.5 });
    expect(w.starts[1]!.runLimitUsd).toBe(0);
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "paused", taskId: "task-2", remainingAtStartUsd: 0 });
    expect(w.run(run.runId)).toMatchObject({ status: "paused", currentSeq: 2 });
    expect(w.events(run.runId).at(-1)).toMatchObject({ type: "paused", stepSeq: 2 });
  });

  it("starts a step with the limit the run has left, and records that figure on the attempt", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 12.34 });
    expect(w.starts[1]!.runLimitUsd).toBe(17.66);
    expect(w.attempts(run.runId)[1]).toMatchObject({ remainingAtStartUsd: 17.66, grantedRunLimitUsd: 2, stopAtUsd: 2 });
  });

  it("derives a step's request id from the run and the attempt, so a retried advance starts one run", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { stepRequestId, advanceChainRun } = await runner();
    expect(stepRequestId(run.runId, 1)).toBe(w.starts[0]!.requestId);
    expect(stepRequestId(run.runId, 2)).not.toBe(stepRequestId(run.runId, 1));
    expect(stepRequestId("crn_bbbbbbbbbbbbbbbbbbbb", 1)).not.toBe(stepRequestId(run.runId, 1));
    expect(stepRequestId(run.runId, 1)).toBe(stepRequestId(run.runId, 1));
    await advanceChainRun(w.deps, ORG_A, run.runId);
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.starts).toHaveLength(1);
  });

  it("fails the attempt with the refusal's code and the run with the exact text when a later step is refused, and never retries it (retries: 2)", async () => {
    const w = setupWorld();
    const design: ChainDefinitionInput = { ...TWO_STEPS, steps: [TWO_STEPS.steps[0]!, agentStep("review", "Review it", "code-reviewer", { kind: "end" }, { retries: 2 })] };
    const chain = await w.publish(design);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.hooks.refuse.push(agentXError("FORBIDDEN", "You can view Reviewer; use needs its owner."));
    await endTask(w, "task-1", { finalReport: "one" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ seq: 2, status: "failed", failure: { reason: "FORBIDDEN", message: "You can view Reviewer; use needs its owner." } });
    expect(w.attempts(run.runId)[1]).not.toHaveProperty("taskId");
    expect(w.run(run.runId)).toMatchObject({
      status: "failed", failure: { seq: 2, reason: "FORBIDDEN", message: 'Step "Review it" could not start: You can view Reviewer; use needs its owner.' },
    });
    expect(w.starts).toHaveLength(2);
    expect(w.attempts(run.runId)).toHaveLength(2);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
    expect(w.openItems()).toEqual([]);
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.starts).toHaveLength(2);
  });

  it("fails the run when the first step is refused at the start, with the same words", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.refuse.push(agentXError("AGENT_BUDGET_EXCEEDED", "Root-cause analyst's monthly AI budget is used up."));
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(run.status).toBe("failed");
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { seq: 1, reason: "AGENT_BUDGET_EXCEEDED", message: 'Step "Look into it" could not start: Root-cause analyst\'s monthly AI budget is used up.' } });
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
  });

  it("leaves a start that failed for a reason that may pass as it is, to be driven again with the same request id", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskEnded, advanceChainRun } = await runner();
    w.hooks.refuse.push(new Error("socket hang up"));
    await expect(onStepTaskEnded(w.deps, w.endEvent("task-1", { finalReport: "one" }))).rejects.toThrow("socket hang up");
    expect(w.attempts(run.runId)[1]).toMatchObject({ seq: 2, status: "starting" });
    expect(w.attempts(run.runId)[1]).not.toHaveProperty("taskId");
    expect(w.run(run.runId)!.status).toBe("running");
    for (const error of [agentXError("RUNTIME_UNAVAILABLE", "try later"), agentXError("WORKSPACE_BUSY", "busy"), agentXError("TOO_MANY_REQUESTS", "slow down"), agentXError("MODEL_PROXY_UNAVAILABLE", "down")]) {
      w.hooks.refuse.push(error);
      await expect(advanceChainRun(w.deps, ORG_A, run.runId), error.code).rejects.toThrow(error.message);
      expect(w.attempts(run.runId)[1]!.status).toBe("starting");
    }
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "running", taskId: "task-2" });
    expect(new Set(w.starts.slice(1).map((start) => start.requestId)).size).toBe(1);
  });

  it("re-drives a start that crashed after the attempt was written and the task started, and the attempt gets the one task", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.crashAfterStart.push(new Error("connection lost"));
    const run = await startAs(w, PRIYA, chain.chainId);
    // The start was left for the sweep: the run exists with its attempt written and no task named on it.
    expect(run.status).toBe("running");
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "starting" });
    expect(w.attempts(run.runId)[0]).not.toHaveProperty("taskId");
    expect(w.tasks.size).toBe(1);
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "running", taskId: "task-1", grantedRunLimitUsd: 2 });
    expect(w.tasks.size).toBe(1);
    expect(w.starts).toHaveLength(2);
    expect(w.starts[1]!.requestId).toBe(w.starts[0]!.requestId);
    expect(w.run(run.runId)!.status).toBe("running");
  });
});

// ---- pause is not a failure

describe("onStepTaskPaused", () => {
  it("makes the attempt and the run paused, with an event, and starts nothing; the task's end afterwards continues the run", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskPaused } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1", { spendRequestId: "spr_abc" }));
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "paused", taskId: "task-1" });
    expect(w.run(run.runId)).toMatchObject({ status: "paused", currentSeq: 1 });
    expect(w.events(run.runId).at(-1)).toMatchObject({ type: "paused", stepSeq: 1, text: 'Step "Look into it" is paused until its spending limit is raised.' });
    expect(w.starts).toHaveLength(1);
    // A second pause for the same task changes nothing.
    const eventCount = w.events(run.runId).length;
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    expect(w.events(run.runId)).toHaveLength(eventCount);

    await endTask(w, "task-1", { finalReport: "one", spentUsd: 3 });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "succeeded" });
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 2 });
    expect(w.events(run.runId).map((event) => event.type)).toEqual(["started", "step_started", "paused", "resumed", "step_ended", "step_started"]);
    expect(w.starts).toHaveLength(2);
    expect(w.starts[1]!.agent.agentId).toBe("code-reviewer");
  });

  it("is not a failure even when its task is a coding task, and is ignored for an unknown task, another org and an event with no chain", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "r", branch: "fix" });
    const { recordGateDecision, onStepTaskPaused } = await runner();
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved");
    const before = JSON.stringify([...w.db.items.entries()]);
    await onStepTaskPaused(w.deps, { ...w.pauseEvent("task-2"), orgId: ORG_B });
    await onStepTaskPaused(w.deps, { ...w.pauseEvent("task-2"), chain: { chainRunId: "crn_nnnnnnnnnnnnnnnnnnnn", stepId: "fix" } });
    await onStepTaskPaused(w.deps, { ...w.pauseEvent("task-1") });
    const { chain: _chain, ...unchained } = w.pauseEvent("task-2"); // eslint-disable-line @typescript-eslint/no-unused-vars -- the point is that there is none
    await onStepTaskPaused(w.deps, unchained);
    expect(JSON.stringify([...w.db.items.entries()])).toBe(before);
    await onStepTaskPaused(w.deps, w.pauseEvent("task-2", { scope: { kind: "chain", chainId: chain.chainId } }));
    expect(w.attempts(run.runId)[2]).toMatchObject({ status: "paused" });
    expect(w.run(run.runId)).toMatchObject({ status: "paused" });
    expect(w.starts).toHaveLength(2);
  });

  it("leaves a run that has ended, and an attempt that is not running, alone", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "done" });
    const { onStepTaskPaused } = await runner();
    const before = JSON.stringify([...w.db.items.entries()]);
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    expect(JSON.stringify([...w.db.items.entries()])).toBe(before);
    expect(w.run(run.runId)!.status).toBe("succeeded");
  });

  it("changes nothing when its transaction fails, and the event numbers stay gapless once it is tried again", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskPaused } = await runner();
    const eventsBefore = w.events(run.runId).length;
    const before = w.run(run.runId)!;
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "None" }] } });
    await expect(onStepTaskPaused(w.deps, w.pauseEvent("task-1"))).rejects.toThrow();
    expect(w.run(run.runId)).toEqual(before);
    expect(w.attempts(run.runId)[0]!.status).toBe("running");
    expect(w.events(run.runId)).toHaveLength(eventsBefore);
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    expect(w.events(run.runId).map((event) => event.seq)).toEqual(Array.from({ length: eventsBefore + 1 }, (_unused, at) => at + 1));
    expect(w.run(run.runId)!.eventSeq).toBe(eventsBefore + 1);
  });

  it("marks a step running again with its event, once, when told it went on", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskPaused, markStepResumed } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    await markStepResumed(w.deps, ORG_A, run.runId, "task-1");
    await markStepResumed(w.deps, ORG_A, run.runId, "task-1");
    expect(w.attempts(run.runId)[0]!.status).toBe("running");
    expect(w.run(run.runId)!.status).toBe("running");
    expect(w.events(run.runId).filter((event) => event.type === "resumed")).toEqual([expect.objectContaining({ stepSeq: 1, text: 'Step "Look into it" is running again.' })]);
  });
});

describe("through Plan 3's end and pause layer (the binding hand-offs)", () => {
  const taskRecord = (w: ChainWorld, taskId: string): DeveloperTaskRecord => w.db.get(taskKey(taskId)) as unknown as DeveloperTaskRecord;
  const host = (spent = 0.7) => {
    const calls: string[] = [];
    const agentRuns: TaskEndHost = {
      releaseWorkspace: async (taskId) => { calls.push(`release ${taskId}`); },
      blockKeys: async (task) => { calls.push(`block ${task.taskId}`); },
      spentUsd: async () => spent,
    };
    return { calls, agentRuns };
  };
  const taskDeps = (w: ChainWorld, agentRuns: TaskEndHost) => ({ documentClient: w.db, tableName: "T", now: () => w.clock.now, agentRuns });

  it("treats a budget pause as a pause: the run is paused, nothing is released, no second task starts, and the end continues the run once", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskEnded, onStepTaskPaused } = await runner();
    unregister.push(registerTaskEndHandler((_deps, event) => onStepTaskEnded(w.deps, event)), registerTaskPauseHandler((_deps, event) => onStepTaskPaused(w.deps, event)));
    const { calls, agentRuns } = host();

    await onTaskPaused(taskDeps(w, agentRuns), taskRecord(w, "task-1"), { kind: "chain", chainId: chain.chainId });
    expect(w.run(run.runId)).toMatchObject({ status: "paused" });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "paused" });
    expect(calls).toEqual([]);
    expect(w.starts).toHaveLength(1);
    expect(w.tasks.size).toBe(1);

    expect(await onTaskEnded(taskDeps(w, agentRuns), taskRecord(w, "task-1"), "succeeded", { finalReport: "one" }, { record: true })).toBe("called");
    expect(calls).toEqual(["block task-1", "release task-1"]);
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 2, spentUsd: 0.7 });
    expect(await onTaskEnded(taskDeps(w, agentRuns), taskRecord(w, "task-1"), "succeeded", { finalReport: "one" }, { record: true })).toBe("already_ended");
    expect(w.starts).toHaveLength(2);
  });

  it("is told again by Plan 3 when the handler failed, and the run goes on from where it stopped", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskEnded } = await runner();
    unregister.push(registerTaskEndHandler((_deps, event) => onStepTaskEnded(w.deps, event)));
    const { agentRuns } = host(0.4);
    w.hooks.refuse.push(new Error("socket hang up"));
    await expect(onTaskEnded(taskDeps(w, agentRuns), taskRecord(w, "task-1"), "succeeded", { finalReport: "one" }, { record: true })).rejects.toThrow("socket hang up");
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "starting" });
    expect(await onTaskEnded(taskDeps(w, agentRuns), taskRecord(w, "task-1"), "succeeded", { finalReport: "one" }, { record: true })).toBe("called");
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "running", taskId: "task-2" });
    expect(w.run(run.runId)!.spentUsd).toBe(0.4);
    expect(w.tasks.size).toBe(2);
    expect(await onTaskEnded(taskDeps(w, agentRuns), taskRecord(w, "task-1"), "succeeded", { finalReport: "one" }, { record: true })).toBe("already_ended");
    expect(w.starts.slice(1).map((start) => start.requestId)).toEqual([w.starts[1]!.requestId, w.starts[1]!.requestId]);
  });
});

// ---- registration at broker start

describe("registerChainRunner", () => {
  it("registers the end and pause handlers, which ignore events without a chain and do nothing without dependencies", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { registerChainRunner } = await index();
    let available: typeof w.deps | undefined = w.deps;
    unregister.push(registerChainRunner(() => available));
    const host: TaskEndHost = { releaseWorkspace: async () => undefined, blockKeys: async () => undefined, spentUsd: async () => 0.1 };
    const deps = { documentClient: w.db, tableName: "T", now: () => w.clock.now, agentRuns: host };
    const record = w.db.get(taskKey("task-1")) as unknown as DeveloperTaskRecord;
    const plain = { ...record, taskId: "plain-1" } as DeveloperTaskRecord;
    delete (plain as { chain?: unknown }).chain;
    w.db.set({ ...plain, ...taskKey("plain-1") });
    await onTaskPaused(deps, w.db.get(taskKey("plain-1")) as unknown as DeveloperTaskRecord, { kind: "task", taskId: "plain-1" });
    await onTaskEnded(deps, w.db.get(taskKey("plain-1")) as unknown as DeveloperTaskRecord, "succeeded", {}, { record: true });
    expect(w.run(run.runId)!.status).toBe("running");
    expect(w.starts).toHaveLength(1);

    available = undefined;
    await onTaskPaused(deps, record, { kind: "task", taskId: "task-1" });
    expect(w.run(run.runId)!.status).toBe("running");
    available = w.deps;
    await onTaskPaused(deps, record, { kind: "task", taskId: "task-1" });
    expect(w.run(run.runId)!.status).toBe("paused");
  });

  it("is removed again by the function it returns, so the handlers it added are gone", async () => {
    const w = setupWorld();
    const { registerChainRunner } = await index();
    expect(hasTaskEndHandlers()).toBe(false);
    const off = registerChainRunner(() => w.deps);
    expect(hasTaskEndHandlers()).toBe(true);
    off();
    expect(hasTaskEndHandlers()).toBe(false);
  });
});

// ---- the spend seam (task-5-report: chainRunBudgets.stepLimits)

describe("chainRunBudgets.stepLimits", () => {
  it("answers the chain and what the run had left when the step started, from the run's records", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 12 });
    const { chainRunSpendReader } = await runner();
    const reader = chainRunSpendReader(w.deps);
    expect(await reader.stepLimits(ORG_A, { chainRunId: run.runId, stepId: "review" })).toEqual({ chainId: chain.chainId, remainingAtStartUsd: 18 });
    expect(await reader.stepLimits(ORG_A, { chainRunId: run.runId, stepId: "look" })).toEqual({ chainId: chain.chainId, remainingAtStartUsd: 30 });
  });

  it("answers the latest attempt of a step that ran more than once", async () => {
    const w = setupWorld();
    const design: ChainDefinitionInput = {
      start: "check", limits: { maxRunUsd: 30 },
      steps: [agentStep("check", "Check", "root-cause-analyst", { kind: "branch", default: "done", choices: [{ id: "retry", description: "Try again", to: "check", maxTraversals: 2 }, { id: "done", description: "Done", to: "$end" }] })],
    };
    const chain = await w.publish(design);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "again", branch: "retry", spentUsd: 10 });
    const { chainRunSpendReader } = await runner();
    expect(await chainRunSpendReader(w.deps).stepLimits(ORG_A, { chainRunId: run.runId, stepId: "check" })).toEqual({ chainId: chain.chainId, remainingAtStartUsd: 20 });
  });

  it("answers nothing for a run or step it can't find, another org's run, and an id that is not a run's", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { chainRunSpendReader } = await runner();
    const reader = chainRunSpendReader(w.deps);
    expect(await reader.stepLimits(ORG_A, { chainRunId: run.runId, stepId: "nope" })).toBeUndefined();
    expect(await reader.stepLimits(ORG_A, { chainRunId: "crn_nnnnnnnnnnnnnnnnnnnn", stepId: "look" })).toBeUndefined();
    expect(await reader.stepLimits(ORG_B, { chainRunId: run.runId, stepId: "look" })).toBeUndefined();
    expect(await reader.stepLimits(ORG_A, { chainRunId: "x", stepId: "look" })).toBeUndefined();
  });

  it("is wired into the broker's agent route dependencies", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver: async () => TEST_ORG, register: false, brokerExtra: { agents: { projectMembers: new FakeProjectMembers() } } });
    const broker = await loadSlackBroker() as unknown as { createAgentRouteDependencies(input: never): ChainRouteDependencies | undefined };
    const deps = broker.createAgentRouteDependencies(h.brokerInput as never)!;
    expect(deps.chainRunBudgets).toBeDefined();
    const w = setupWorld();
    h.db.set({ ...chainRunKey(TEST_ORG, "crn_aaaaaaaaaaaaaaaaaaaa", "META"), entityType: "CHAIN_RUN", orgId: TEST_ORG, runId: "crn_aaaaaaaaaaaaaaaaaaaa", chainId: "chn_aaaaaaaaaaaaaaaaaaaa", currentSeq: 1 });
    h.db.set({ ...chainRunKey(TEST_ORG, "crn_aaaaaaaaaaaaaaaaaaaa", stepSk(1)), entityType: "CHAIN_STEP", seq: 1, stepId: "look", status: "running", remainingAtStartUsd: 7 });
    expect(await deps.chainRunBudgets!.stepLimits(TEST_ORG, { chainRunId: "crn_aaaaaaaaaaaaaaaaaaaa", stepId: "look" })).toEqual({ chainId: "chn_aaaaaaaaaaaaaaaaaaaa", remainingAtStartUsd: 7 });
    expect(w).toBeDefined();
  });
});

// ---- the route

describe("POST /v1/app/chains/{id}/runs", () => {
  const person = (digit: string, who: string): Developer => ({ developerId: digit.repeat(64), name: who, provider: "oidc", sessionId: `s-${who.toLowerCase()}` });
  const CAROLINE = person("3", "Caroline"); // contributor on web
  const VERA = person("5", "Vera"); // viewer on web
  const ERIN = person("4", "Erin"); // no role anywhere
  const ORG_OF = async (subject: { developerId: string }) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);

  async function routeSetup(register = true) {
    const world = setupWorld();
    const members = new FakeProjectMembers();
    const h = await createDeveloperTaskBroker({
      orgResolver: ORG_OF, register: false,
      brokerExtra: { agents: { projectMembers: members, ...(register ? { registerChainRunner: true } : {}), chainRuns: { startAgentRun: world.startAgentRun, callerFor: async (orgId: string, developerId: string) => ({ orgId, developerId, orgRole: "member" as const }) } } },
    } as never);
    const enroll = async (who: Developer) => {
      h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
      h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
      await h.orgOf(who);
      seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: "member" });
      members.setOrgRole(TEST_ORG, who.developerId, "member");
    };
    for (const who of [CAROLINE, VERA, ERIN]) await enroll(who);
    h.db.set({ pk: `ORG#${TEST_ORG}#PROJECT_CATALOG#web`, sk: "META", name: "web" });
    members.grant(TEST_ORG, "web", CAROLINE.developerId, "contributor");
    members.grant(TEST_ORG, "web", VERA.developerId, "viewer");
    const loaded = await loadSlackBroker() as unknown as { createAgentRouteDependencies(input: never): ChainRouteDependencies | undefined };
    const routeDeps = loaded.createAgentRouteDependencies(h.brokerInput as never)!;
    /** A published one-step chain owned by Caroline, in the broker's own table. */
    const publishStarter = async () => {
      const chain = await routeDeps.chains.create({ orgId: TEST_ORG, name: `Starter ${randomUUID().slice(0, 6)}`, owner: { kind: "member", developerId: CAROLINE.developerId }, definition: STARTER_CHAIN_DEFINITION, createdBy: CAROLINE.developerId });
      const checked = await (await import("../../packages/broker/src/chains/validate.js")).validateChainForPublish(routeDeps, { orgId: TEST_ORG, developerId: CAROLINE.developerId, orgRole: "member" }, TEST_ORG, (await routeDeps.chains.getDraft(TEST_ORG, chain.chainId))!.definition);
      expect(checked.problems).toEqual([]);
      await routeDeps.chains.publish({ orgId: TEST_ORG, chainId: chain.chainId, expectedDraftRevision: 1, pinned: checked.pinned, digest: (await import("../../packages/broker/src/chains/store.js")).chainDigest(checked.pinned), guardrailsRevision: checked.guardrailsRevision, by: CAROLINE.developerId });
      return chain;
    };
    return { h, world, members, routeDeps, publishStarter };
  }
  const post = (h: Awaited<ReturnType<typeof routeSetup>>["h"], who: Developer, chainId: string, body: Record<string, unknown>) =>
    h.dev(who, "POST", `/v1/app/chains/${chainId}/runs`, body);

  it("starts a run for a person who can use the chain and answers 202 with the run, and answers a repeat with the same run", async () => {
    const { h, world, publishStarter } = await routeSetup(false);
    const chain = await publishStarter();
    const requestId = randomUUID();
    const reply = await post(h, CAROLINE, chain.chainId, { requestId, project: "web", input: "Refunds fail" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const shown = (reply.body as { run: Record<string, unknown> }).run;
    expect(shown).toMatchObject({ chainId: chain.chainId, project: "web", status: "running", owner: { developerId: CAROLINE.developerId }, input: "Refunds fail", runLimitUsd: 20, spentUsd: 0, origin: "app" });
    expect(shown["chainName"]).toMatch(/^Starter /u);
    expect(shown["runId"]).toMatch(/^crn_[0-9a-z]{20}$/);
    expect(shown).not.toHaveProperty("payer");
    expect(world.starts).toHaveLength(1);
    const again = await post(h, CAROLINE, chain.chainId, { requestId, project: "web", input: "Refunds fail" });
    expect(again.status).toBe(202);
    expect((again.body as { run: { runId: string } }).run.runId).toBe(shown["runId"]);
    expect(world.starts).toHaveLength(1);
  });

  it("refuses a body that is not exactly {requestId, project, input?}", async () => {
    const { h, world, publishStarter } = await routeSetup(false);
    const chain = await publishStarter();
    for (const bad of [{ project: "web" }, { requestId: randomUUID(), project: "web", extra: 1 }, { requestId: "not-a-uuid", project: "web" }, { requestId: randomUUID(), project: "web", input: "x".repeat(8001) }, { requestId: randomUUID() }, { requestId: randomUUID(), project: "Not A Project" }]) {
      const refused = await post(h, CAROLINE, chain.chainId, bad);
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    expect(world.starts).toEqual([]);
  });

  it("answers 404 to a person who can't see the chain, has no role on the project or is in another org, and 403 to a project viewer who can use it", async () => {
    const { h, world, routeDeps, publishStarter } = await routeSetup(false);
    const chain = await publishStarter();
    for (const who of [VERA, ERIN, OMAR]) expect((await post(h, who, chain.chainId, { requestId: randomUUID(), project: "web" })).status, who.name).toBe(404);
    expect((await post(h, CAROLINE, "chn_nnnnnnnnnnnnnnnnnnnn", { requestId: randomUUID(), project: "web" })).status).toBe(404);
    expect((await post(h, CAROLINE, "not-a-chain", { requestId: randomUUID(), project: "web" })).status).toBe(404);
    await (await import("../../packages/broker/src/chains/access.js")).setChainShares({ ...routeDeps, store: routeDeps.chains }, { orgId: TEST_ORG, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: VERA.developerId }, level: "use" }], by: CAROLINE.developerId });
    expect((await post(h, VERA, chain.chainId, { requestId: randomUUID(), project: "web" })).status).toBe(403);
    expect(world.starts).toEqual([]);
  });

  it("is listening for a step's end only where the broker is asked to, and then finishes the run when Plan 3 tells it a step ended", async () => {
    expect(hasTaskEndHandlers()).toBe(false);
    await routeSetup(false);
    expect(hasTaskEndHandlers()).toBe(false);
    const { h, world, publishStarter } = await routeSetup(true);
    expect(hasTaskEndHandlers()).toBe(true);
    const chain = await publishStarter();
    const reply = await post(h, CAROLINE, chain.chainId, { requestId: randomUUID(), project: "web" });
    const runId = (reply.body as { run: { runId: string } }).run.runId;
    const task = { pk: "DEVTASK#task-1", sk: "META", taskId: "task-1", orgId: TEST_ORG, chain: { chainRunId: runId, stepId: "look_into_it" } } as unknown as DeveloperTaskRecord;
    expect(await onTaskEnded({ documentClient: h.db, tableName: "state", now: Date.now }, task, "succeeded", { finalReport: "Done" }, { record: true })).toBe("called");
    expect(h.db.get(chainRunKey(TEST_ORG, runId as never, "META"))).toMatchObject({ status: "succeeded" });
    expect(world.starts).toHaveLength(1);
  });
});
