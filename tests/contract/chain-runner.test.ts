import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 6: the chain runner's core. A person (or an event, or a schedule) starts a run of a published chain; each agent step is a run of its own pinned
// agent through Plan 3's `startAgentRun`; a step's report goes to the next step as data in its context; every state change and its event commit together. The
// binding hand-offs are tested here too: a budget pause is a pause (never a failure, never a second task, nothing released), each end is handled once whatever
// replays, and report text is neutralised before anyone is shown it.
import { randomUUID } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasTaskEndHandlers, registerTaskEndHandler, registerTaskPauseHandler, onTaskEnded, onTaskPaused, type TaskEndHost } from "../../packages/broker/src/agents/task-end.js";
import { unregisterAgentSessionTaskHandlers } from "../../packages/broker/src/agent-sessions/task-handlers.js";
import { setChainShares } from "../../packages/broker/src/chains/access.js";
import { STARTER_CHAIN_DEFINITION, type ChainRouteDependencies } from "../../packages/broker/src/chains/routes.js";
import { taskKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { BUILTIN_AGENTS, builtinDefaultPin, currentBuiltinVersion } from "../../packages/contracts/src/agent-templates.js";
import { CHAIN_MAX_STEP_RUNS, CONTEXT_TITLE_MAX, HANDOFF_ITEM_MAX_BYTES, HANDOFF_MAX_BYTES, HANDOFF_MAX_ITEMS, type ChainDefinitionInput, type StepResult } from "../../packages/contracts/src/chains.js";
// The package the broker imports, not its source: an error must be an instance of the class the broker tests for.
import { agentXError } from "@agentx/contracts";
import { chainKey, chainRunKey, openChainRunKey, projectAiKey, projectMetaKey, runEventSk, stepSk } from "../../packages/contracts/src/org-scoped-keys.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { ARJUN, CARL, DANA, MAX, ORG_A, ORG_B, PRIYA, START, STRANGER, VIV, callerOf, decisionBy, setupWorld, type ChainWorld } from "../support/chain-run-world.js";
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

  it.each([
    ["xoxb- with 10 characters", "xoxb-1234567890"], ["sntrys_ with 20 characters", `sntrys_${"a".repeat(20)}`], ["glsa_ with 20 characters", `glsa_${"a".repeat(20)}`],
    ["lin_api_ with 20 characters", `lin_api_${"a".repeat(20)}`], ["Bearer with 20 characters", `Bearer ${"a".repeat(20)}`], ["xapp- with 10 characters", "xapp-1234567890"],
    ["glc_ with 20 characters", `glc_${"a".repeat(20)}`], ["ATATT with 20 characters", `ATATT${"a".repeat(20)}`], ["github_pat_ with 20 characters", `github_pat_${"a".repeat(20)}`],
  ])("replaces the shortest %s", async (_label, token) => {
    const { redactSecrets } = await handoff();
    expect(redactSecrets(`k ${token} z`)).toBe("k [redacted] z");
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

  it("leaves out the vendor's summary when it is empty, with no blank lines after the subject", async () => {
    const { triggerSummary } = await handoff();
    expect(triggerSummary(SENTRY({ summary: "" }) as never)).toBe("Event: sentry issue.created\nalert: Refund errors\nLink: https://sentry.example.com/issues/1");
  });

  it("keeps a whole character that ends exactly at the cut, and a title that is empty has no title", async () => {
    const { buildHandoff } = await handoff();
    const title = `${"a".repeat(197)}😀${"b".repeat(20)}`;
    const cut = buildHandoff(input({ trigger: SENTRY({ subject: { kind: "alert", title } }) }))[0]!.title!;
    expect(cut).toBe(`${"a".repeat(197)}😀…`);
    const [bare] = buildHandoff(input({ trigger: SENTRY({ subject: { kind: "alert", title: "" } }) }));
    expect(bare).not.toHaveProperty("title");
  });

  it("has no start item for an empty start input, and a report with only links has no blank line before them", async () => {
    const { buildHandoff } = await handoff();
    expect(buildHandoff(input({ startInput: "" }) as never)).toEqual([]);
    const [item] = buildHandoff(input({ earlier: [report(1, "", { result: { report: "", links: [{ label: "PR", url: "https://github.com/a/b/pull/1" }] } })] }));
    expect(item!.body).toBe("Links:\n- PR: https://github.com/a/b/pull/1");
  });

  it("stops at the first report that does not fit, so a smaller, older report is not let in past it", async () => {
    const { buildHandoff } = await handoff();
    const earlier = [...Array.from({ length: 5 }, (_unused, at) => report(at + 2, `${String(at + 2)}`.repeat(16_000))), report(1, "tiny")];
    const items = buildHandoff(input({ mode: "all", earlier }));
    expect(items.map((item) => item.ref)).toEqual([6, 5, 4, 3].map((seq) => `chain:crn_aaaaaaaaaaaaaaaaaaaa:${String(seq)}`));
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

  it("neutralises the line and paragraph separators too, and leaves a text of exactly the limit whole", async () => {
    const { neutralText, runEventItem } = await runEvents();
    expect(neutralText("a\u2028b\u2029c")).toBe("a[U+2028]b[U+2029]c");
    expect(neutralText("x".repeat(500), 500)).toBe("x".repeat(500));
    const item = runEventItem("T", { orgId: ORG_A, runId: "crn_aaaaaaaaaaaaaaaaaaaa", eventSeq: 0 }, { type: "started", text: "a\u0007b" }, "2026-10-22T09:00:00.000Z") as unknown as { Put: { Item: { text: string } } };
    expect(item.Put.Item.text).toBe("a[U+0007]b");
  });

  it("does not let an appended event overwrite a change that landed after it read the run", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { appendRunEvent } = await runEvents();
    const real = w.db.send;
    let fired = false;
    (w.deps.documentClient as { send: unknown }).send = async (command: { constructor: { name: string } }) => {
      if (!fired && command.constructor.name === "TransactWriteCommand") {
        fired = true;
        const meta = w.db.get(chainRunKey(ORG_A, run.runId, "META"))!;
        w.db.set({ ...meta, version: (meta["version"] as number) + 1 });
      }
      return real(command as never);
    };
    const before = w.run(run.runId)!;
    await appendRunEvent(w.deps, ORG_A, run.runId, { type: "resumed", text: "A note." });
    (w.deps.documentClient as { send: unknown }).send = real;
    expect(fired).toBe(true);
    // The first try lost to the change; the second read it and moved the version once more.
    expect(w.run(run.runId)!.version).toBe(before.version + 2);
    expect(w.run(run.runId)!.eventSeq).toBe(before.eventSeq + 1);
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
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
    expect(w.starts).toHaveLength(2);
    expect(w.starts[1]).toMatchObject({
      agent: { agentId: "rovara-code", version: builtinDefaultPin("rovara-code") }, chain: { chainRunId: run.runId, stepId: "fix" }, runLimitUsd: 29.25,
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
    await w.chains.archive(ORG_A, chain.chainId, PRIYA, undefined, { actor: fixtureActor(w.chains, ORG_A, PRIYA) });
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
    await w.agents.archive(ORG_A, reviewer.agentId, PRIYA, undefined, { actor: fixtureActor(w.agents, ORG_A, PRIYA) });
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
    await w.agents.archive(ORG_A, reviewer.agentId, DANA, undefined, { actor: fixtureActor(w.agents, ORG_A, DANA) });
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
    await w.chains.setBudget(ORG_A, chain.chainId, 20, fixtureActor(w.chains, ORG_A, DANA).developerId, undefined, { ...({}), actor: fixtureActor(w.chains, ORG_A, DANA) });
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
    await w.chains.archive(ORG_A, chain.chainId, PRIYA, undefined, { actor: fixtureActor(w.chains, ORG_A, PRIYA) });
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

  it("ends a chain run failed, never succeeded, when its agent step's report was unverified, and says so with a reason of its own (staging 0.4.6)", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get({ pk: "DEVTASK#task-1", sk: "AGENT_RUN" })!, endReason: "Unverified, needs a person: The report cites pull request #5, which no tool returned and the request did not contain." });
    await endTask(w, "task-1", { outcome: "failed", finalReport: "Found it: PR #5. healthy" });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "failed", failure: { reason: "step_unverified" } });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { reason: "step_unverified" } });
    expect(w.run(run.runId)!.failure!.message).toContain("Unverified, needs a person: The report cites pull request #5");
    expect(w.starts).toHaveLength(1);
  });

  it("says why a coding task failed in its own words when the task has none", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "r", branch: "fix" });
    const { recordGateDecision } = await runner();
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
    await endTask(w, "task-2", { outcome: "failed" });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { reason: "step_failed", message: 'Step "Fix it" failed: it did not finish.' } });
  });

  it("takes a merged coding task as a success with its pull requests as links, and drops a pull request link that is not https", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "r", branch: "fix" });
    const { recordGateDecision } = await runner();
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
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
    w.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "socket hang up"));
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

  it("fails the attempt and the run with a fixed message when the start throws anything but a refusal that may pass, and does not echo the error (review M-4)", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.refuse.push(new TypeError("Cannot read properties of undefined (reading 'secret-token-sk-live-abcdef0123456789')"));
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(run.status).toBe("failed");
    const failed = w.run(run.runId)!;
    expect(failed).toMatchObject({ status: "failed", failure: { seq: 1, reason: "start_failed" } });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "failed", failure: { reason: "start_failed" } });
    expect(JSON.stringify([failed.failure, w.attempts(run.runId)[0]!.failure, w.events(run.runId)])).not.toMatch(/secret-token|undefined|TypeError|properties/u);
    expect(failed.failure!.message).toBe('Step "Look into it" could not start because of an unexpected error. Nothing was started.');
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
    expect(w.openItems()).toEqual([]);
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.starts).toHaveLength(1);
  });

  it("fails a later step the same way when its start throws a plain error, and starts nothing more (review M-4)", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.hooks.refuse.push(new Error("db exploded"));
    await endTask(w, "task-1", { finalReport: "one" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ seq: 2, status: "failed", failure: { reason: "start_failed" } });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { seq: 2, reason: "start_failed" } });
    expect(JSON.stringify(w.run(run.runId))).not.toContain("exploded");
    expect(w.starts).toHaveLength(2);
  });

  it("re-drives a start that crashed after the attempt was written and the task started, and the attempt gets the one task", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.crashAfterStart.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
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

// Plan 4 Task 6 review I-1, M-2: the task of a step exists from Plan 3's start commit, but the attempt learns its id only when `startAgentRun` returns. An end or a pause told
// in between (a crash after the task started, then a short run) must not be lost.
describe("a step's task that ends or pauses while its attempt is still starting (review I-1, M-2)", () => {
  it("takes the end of the one task the attempt was started with: the step ends once, the next step starts once, and the re-drive finds nothing left to do", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    w.hooks.crashAfterStart.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "starting" });
    expect(w.attempts(run.runId)[0]).not.toHaveProperty("taskId");
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 1 });
    expect(w.attempts(run.runId)[0]).toMatchObject({ seq: 1, status: "succeeded", taskId: "task-1", result: { report: "one" } });
    expect(w.attempts(run.runId)[1]).toMatchObject({ seq: 2, status: "running", taskId: "task-2" });
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 2, spentUsd: 1 });
    expect(w.starts).toHaveLength(2);
    // The sweep's re-drive and a repeated end change nothing: no hang, no second next step.
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    await endTask(w, "task-1", { finalReport: "one", spentUsd: 1 });
    expect(w.starts).toHaveLength(2);
    expect(w.tasks.size).toBe(2);
    expect(w.attempts(run.runId)).toHaveLength(2);
    expect(w.events(run.runId).filter((event) => event.type === "step_ended")).toHaveLength(1);
    await endTask(w, "task-2", { finalReport: "two" });
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
  });

  it("ends the run of a one-step chain whose task ended before the re-drive", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.crashAfterStart.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "done" });
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded" });
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "succeeded", taskId: "task-1" });
    expect(w.openItems()).toEqual([]);
    expect(w.starts).toHaveLength(1);
  });

  it("does not take the end of another task for the attempt: another step id, another run, or an attempt that has a task already", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    w.hooks.crashAfterStart.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
    const run = await startAs(w, PRIYA, chain.chainId);
    const before = JSON.stringify([...w.db.items.entries()]);
    const { onStepTaskEnded } = await runner();
    await onStepTaskEnded(w.deps, { ...w.endEvent("task-1", { finalReport: "x" }), chain: { chainRunId: run.runId, stepId: "review" } });
    expect(JSON.stringify([...w.db.items.entries()])).toBe(before);
    // After the re-drive the attempt has its task: an end of another task of the step still finds nothing.
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "running", taskId: "task-1" });
    const after = JSON.stringify([...w.db.items.entries()]);
    await onStepTaskEnded(w.deps, { ...w.endEvent("task-1", { finalReport: "x" }), taskId: "task-other" });
    expect(JSON.stringify([...w.db.items.entries()])).toBe(after);
  });

  it("makes the attempt and the run paused, with the task named, for a pause told before the attempt had it; the end afterwards continues the run once", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    w.hooks.crashAfterStart.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskPaused, advanceChainRun } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1", { spendRequestId: "spr_abc" }));
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "paused", taskId: "task-1" });
    expect(w.run(run.runId)).toMatchObject({ status: "paused", currentSeq: 1 });
    expect(w.events(run.runId).at(-1)).toMatchObject({ type: "paused", stepSeq: 1 });
    // The re-drive has nothing to start any more.
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.starts).toHaveLength(1);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "paused", taskId: "task-1" });
    await endTask(w, "task-1", { finalReport: "one" });
    expect(w.run(run.runId)).toMatchObject({ status: "running", currentSeq: 2 });
    expect(w.starts).toHaveLength(2);
  });
});

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
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
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
    w.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "socket hang up"));
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

  it("asks for dependencies only for a task that has a chain, and takes both handlers off again", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { registerChainRunner } = await index();
    let asked = 0;
    const off = registerChainRunner(() => { asked += 1; return w.deps; });
    const host: TaskEndHost = { releaseWorkspace: async () => undefined, blockKeys: async () => undefined, spentUsd: async () => 0 };
    const deps = { documentClient: w.db, tableName: "T", now: () => w.clock.now, agentRuns: host };
    const record = w.db.get(taskKey("task-1")) as unknown as DeveloperTaskRecord;
    w.db.set({ ...record, ...taskKey("plain-9"), taskId: "plain-9", chain: undefined });
    const plain = w.db.get(taskKey("plain-9")) as unknown as DeveloperTaskRecord;
    delete (plain as { chain?: unknown }).chain;
    await onTaskPaused(deps, plain, { kind: "task", taskId: "plain-9" });
    await onTaskEnded(deps, plain, "succeeded", {}, { record: true });
    expect(asked).toBe(0);
    off();
    await onTaskPaused(deps, record, { kind: "task", taskId: "task-1" });
    expect(w.run(run.runId)!.status).toBe("running");
    expect(asked).toBe(0);
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

// ---- guards, races and the states a run can be found in

const snapshot = (w: ChainWorld) => JSON.stringify([...w.db.items.entries()]);
const GATE_DESIGN = INVESTIGATE_THEN_FIX;

/** A run of INVESTIGATE_THEN_FIX waiting at its gate (attempt 2). */
async function atGate(w: ChainWorld) {
  const chain = await w.publish(GATE_DESIGN);
  const run = await startAs(w, PRIYA, chain.chainId);
  await endTask(w, "task-1", { finalReport: "r", branch: "fix" });
  return { chain, run };
}

describe("a run that has ended is never moved again", () => {
  it.each(["succeeded", "failed", "cancelled", "timed_out"])("does nothing for a %s run: not an advance, an end, a pause, a resume or a decision", async (status) => {
    const w = setupWorld();
    const { chain, run } = await atGate(w);
    void chain;
    const { advanceChainRun, onStepTaskEnded, onStepTaskPaused, markStepResumed, recordGateDecision } = await runner();
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, status });
    // The first step's attempt is made to look as if it still ran, so that only the run's own state stops each call.
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, status: "paused" });
    const before = snapshot(w);
    await advanceChainRun(w.deps, ORG_A, run.runId);
    await onStepTaskEnded(w.deps, w.endEvent("task-1", { finalReport: "again" }));
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    await markStepResumed(w.deps, ORG_A, run.runId, "task-1");
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
    expect(snapshot(w)).toBe(before);
    expect(w.starts).toHaveLength(1);
  });

  it("does not read a run whose stored org is not the one it was asked under", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, orgId: ORG_B });
    const before = snapshot(w);
    await endTask(w, "task-1", { finalReport: "one" });
    expect(snapshot(w)).toBe(before);
  });

  it("leaves a run alone while its step is running, paused or waiting for a gate", async () => {
    const w = setupWorld();
    const { advanceChainRun } = await runner();
    const chain = await w.publish(GATE_DESIGN);
    const run = await startAs(w, PRIYA, chain.chainId);
    for (const status of ["running", "paused"]) {
      w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, status });
      const before = snapshot(w);
      await advanceChainRun(w.deps, ORG_A, run.runId);
      expect(snapshot(w), status).toBe(before);
    }
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, status: "waiting" });
    const before = snapshot(w);
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(snapshot(w)).toBe(before);
    expect(w.starts).toHaveLength(1);
  });
});

describe("a change that lands between a read and the write is never overwritten", () => {
  it("stops a pause whose run moved, and applies it when told again", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskPaused } = await runner();
    w.beforeTransaction("is paused until", () => w.touchRun(run.runId));
    const before = w.run(run.runId)!.eventSeq;
    await expect(onStepTaskPaused(w.deps, w.pauseEvent("task-1"))).rejects.toThrow();
    expect(w.attempts(run.runId)[0]!.status).toBe("running");
    expect(w.run(run.runId)!.status).toBe("running");
    expect(w.run(run.runId)!.eventSeq).toBe(before);
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    expect(w.run(run.runId)!.status).toBe("paused");
  });

  it("stops an end whose run moved, to be told again, and does not move the run on", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.beforeTransaction('"succeeded"', () => w.touchRun(run.runId));
    await expect(endTask(w, "task-1", { finalReport: "one" })).rejects.toThrow();
    expect(w.attempts(run.runId)[0]!.status).toBe("running");
    expect(w.starts).toHaveLength(1);
    await endTask(w, "task-1", { finalReport: "one" });
    expect(w.starts).toHaveLength(2);
  });

  it("stops a resume whose run moved", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskPaused, markStepResumed } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    w.beforeTransaction("is running again", () => w.touchRun(run.runId));
    await expect(markStepResumed(w.deps, ORG_A, run.runId, "task-1")).rejects.toThrow();
    expect(w.attempts(run.runId)[0]!.status).toBe("paused");
    await markStepResumed(w.deps, ORG_A, run.runId, "task-1");
    expect(w.attempts(run.runId)[0]!.status).toBe("running");
  });

  it("stops a gate decision whose run moved", async () => {
    const w = setupWorld();
    const { run } = await atGate(w);
    const { recordGateDecision } = await runner();
    w.beforeTransaction("gate_decided", () => w.touchRun(run.runId));
    await expect(recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2))).rejects.toThrow();
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "waiting" });
    expect(w.starts).toHaveLength(1);
  });

  it("re-reads once after losing a race to start a step, and goes on", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.beforeTransaction("STEP#0002", () => w.touchRun(run.runId));
    await endTask(w, "task-1", { finalReport: "one" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "running", taskId: "task-2" });
    expect(w.starts).toHaveLength(2);
  });

  it("re-reads once after losing a race to end the run, and ends it", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.beforeTransaction("Chain 1 finished.", () => w.touchRun(run.runId));
    await endTask(w, "task-1", { finalReport: "done" });
    expect(w.run(run.runId)!.status).toBe("succeeded");
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
  });

  it("does not hide a failure that is not a lost race", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskEnded, advanceChainRun } = await runner();
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("STEP#0002"), error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "None" }] } });
    await expect(onStepTaskEnded(w.deps, w.endEvent("task-1", { finalReport: "one" }))).rejects.toThrow();
    expect(w.starts).toHaveLength(1);
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.starts).toHaveLength(2);
  });

  it("lets the one start that wins a given run id stand, and answers the other with it, counting the run once", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    const runId = "crn_yyyyyyyyyyyyyyyyyyyy";
    const runs = await Promise.all([startAsEvent(w, chain.chainId, CARL, { runId }), startAsEvent(w, chain.chainId, CARL, { runId })]);
    expect(runs.map((run) => run.runId)).toEqual([runId, runId]);
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(1);
    expect(w.db.find((item) => item.entityType === "CHAIN_RUN")).toHaveLength(1);
    expect(w.starts).toHaveLength(1);
  });

  it("answers a start of a given run id for another chain, or by another event, as a different request", async () => {
    const w = setupWorld();
    const one = await w.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    const two = await w.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    const runId = "crn_xxxxxxxxxxxxxxxxxxxx";
    await startAsEvent(w, one.chainId, CARL, { runId });
    expect(await fail(startAsEvent(w, two.chainId, CARL, { runId }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAsEvent(w, one.chainId, CARL, { runId, startedBy: EVENT_STARTED({ eventKey: "sentry:other" }) }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("starts the version that is current when it re-reads, when a publish landed during the start", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage" });
    const second: ChainDefinitionInput = { ...ONE_STEP, steps: [agentStep("look", "Look again", "root-cause-analyst", { kind: "end" })] };
    w.beforeTransaction("CHAIN_RUN", () => w.publishAgain(chain.chainId, second));
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(run.chainVersion).toBe(2);
    expect(w.attempts(run.runId)[0]).toMatchObject({ stepName: "Look again" });
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(1);
  });

  it("gives up after one re-read when the chain keeps changing", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage" });
    let version = 1;
    w.beforeTransaction("CHAIN_RUN", async () => { version += 1; await w.publishAgain(chain.chainId, { ...ONE_STEP, steps: [agentStep("look", `Look ${String(version)}`, "root-cause-analyst", { kind: "end" })] }); }, 5);
    await expect(startAs(w, PRIYA, chain.chainId)).rejects.toThrow();
    expect(version).toBe(3);
    expect(w.db.find((item) => item.entityType === "CHAIN_RUN")).toEqual([]);
  });

  it("says the chain is archived when it was archived between the checks and the write", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage" });
    w.beforeTransaction("CHAIN_RUN", async () => { await w.chains.archive(ORG_A, chain.chainId, PRIYA, undefined, { actor: fixtureActor(w.chains, ORG_A, PRIYA) }); });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toEqual({ code: "CHAIN_UNAVAILABLE", message: "Triage is archived, so it can't start new runs." });
    expect(w.db.find((item) => item.entityType === "CHAIN_RUN")).toEqual([]);
  });
});

describe("recording where a step started", () => {
  it("leaves a step that was started while its run was cancelled as it was, not running on a run that has ended", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.onStarted = () => { w.db.set({ ...w.db.get(chainRunKey(ORG_A, "crn_zzzzzzzzzzzzzzzzzzzz", "META") ?? { pk: "x", sk: "x" }) ?? { pk: "x", sk: "x" } }); };
    w.hooks.onStarted = (task) => {
      const runId = task.request.chain!.chainRunId as never;
      w.db.set({ ...w.db.get(chainRunKey(ORG_A, runId, "META"))!, status: "cancelled", endedAt: "2026-10-22T09:00:00.000Z" });
    };
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "starting" });
    expect(w.attempts(run.runId)[0]).not.toHaveProperty("taskId");
  });

  it("lets two drivers of one start finish it once, with the one task", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.crashAfterStart.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
    const run = await startAs(w, PRIYA, chain.chainId);
    const { advanceChainRun } = await runner();
    await Promise.all([advanceChainRun(w.deps, ORG_A, run.runId), advanceChainRun(w.deps, ORG_A, run.runId)]);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "running", taskId: "task-1" });
    expect(w.tasks.size).toBe(1);
  });

  it("does not put another task on an attempt that was given one meanwhile", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.beforeTransaction("grantedRunLimitUsd", () => {
      const key = chainRunKey(ORG_A, w.db.find((item) => item.entityType === "CHAIN_RUN")[0]!["runId"] as never, stepSk(1));
      w.db.set({ ...w.db.get(key)!, status: "running", taskId: "task-other" });
    });
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "running", taskId: "task-other" });
  });

  it("tries again when the run moved while a paused start was recorded, and says so when a failure is not a lost race", async () => {
    const w = setupWorld();
    const chain = await w.publish({ ...ONE_STEP, limits: { maxRunUsd: 0.5 } });
    // A run with no limit left starts its step paused; record it after a first transaction that fails for a moved run.
    const first = await startAs(w, PRIYA, chain.chainId);
    expect(first.status).toBe("running");
    const second = await w.publish({ ...TWO_STEPS, limits: { maxRunUsd: 0.5 } });
    const run = await startAs(w, PRIYA, second.chainId);
    w.beforeTransaction("is paused until", () => w.touchRun(run.runId));
    await endTask(w, "task-2", { finalReport: "one", spentUsd: 0.5 });
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "paused", taskId: "task-3" });
    expect(w.run(run.runId)!.status).toBe("paused");
  });

  it("answers a failure of the write that is not a race as itself, not as a busy run", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("grantedRunLimitUsd"), error: { name: "InternalServerError", message: "boom" } });
    const run = await startAs(w, PRIYA, chain.chainId);
    const { advanceChainRun } = await runner();
    expect(w.attempts(run.runId)[0]!.status).toBe("starting");
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.attempts(run.runId)[0]!.status).toBe("running");
  });

  it("re-drives a start with the limit it was first started with, not what the run has left now", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.crashAfterStart.push(agentXError("RUNTIME_UNAVAILABLE", "connection lost"));
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, spentUsd: 5 });
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.starts[1]!.runLimitUsd).toBe(30);
    expect(w.starts[1]!.runLimitUsd).toBe(w.starts[0]!.runLimitUsd);
  });
});

describe("what a run is made of that is not in the worked example", () => {
  it("sends a step with empty instructions the default text", async () => {
    const w = setupWorld();
    const chain = await w.publish({ ...ONE_STEP, steps: [agentStep("look", "Look into it", "root-cause-analyst", { kind: "end" }, { instructions: "" })] });
    await startAs(w, PRIYA, chain.chainId);
    expect(w.starts[0]!.input.text).toBe("Do your job for this chain run.");
  });

  it("takes a declined gate down its onReject edge: the run ends, with nothing more started", async () => {
    const w = setupWorld();
    const { run } = await atGate(w);
    const { recordGateDecision } = await runner();
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "declined", decisionBy(w, run.runId, 2));
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "declined" });
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded", traversals: { "investigate>approve_fix": 1, "approve_fix>$end": 1 } });
    expect(w.starts).toHaveLength(1);
    expect(w.events(run.runId).find((event) => event.type === "gate_decided")!.text).toBe('Someone sent "Approve the fix" back');
  });

  it("takes an approved gate down its onApprove edge, once, however often it is told, and by one at a time", async () => {
    const w = setupWorld();
    const { run } = await atGate(w);
    const { recordGateDecision } = await runner();
    await Promise.all([recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2)), recordGateDecision(w.deps, ORG_A, run.runId, 2, "declined", decisionBy(w, run.runId, 2))]);
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
    expect(w.events(run.runId).filter((event) => event.type === "gate_decided")).toHaveLength(1);
    expect(w.attempts(run.runId)[1]!.decision).toBeDefined();
    expect(w.starts.length).toBeLessThanOrEqual(2);
  });

  it("takes a decision only for the run's current gate, and only for a gate", async () => {
    const w = setupWorld();
    const { run } = await atGate(w);
    const { recordGateDecision } = await runner();
    const before = snapshot(w);
    await recordGateDecision(w.deps, ORG_A, run.runId, 1, "approved", decisionBy(w, run.runId, 1));
    await recordGateDecision(w.deps, ORG_A, run.runId, 7, "approved", decisionBy(w, run.runId, 7));
    expect(snapshot(w)).toBe(before);
    // An attempt of the gate that is no longer the current one is left alone, and so is a step that is not a gate.
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, currentSeq: 3 });
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, currentSeq: 1 });
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, status: "waiting" });
    await recordGateDecision(w.deps, ORG_A, run.runId, 1, "approved", decisionBy(w, run.runId, 1));
    expect(w.attempts(run.runId)[0]!.status).toBe("waiting");
    expect(w.attempts(run.runId)[1]!.status).toBe("waiting");
  });

  it("leaves the run running, with the gate passed, when the next step could not be started right away", async () => {
    const w = setupWorld();
    const { run } = await atGate(w);
    const { recordGateDecision, advanceChainRun } = await runner();
    w.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "socket hang up"));
    await expect(recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2))).rejects.toThrow("socket hang up");
    expect(w.run(run.runId)!.status).toBe("running");
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "approved" });
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.attempts(run.runId)[2]).toMatchObject({ status: "running", stepId: "fix" });
  });

  it("opens a gate even when the run has used every step it may start", async () => {
    const w = setupWorld();
    const chain = await w.publish(GATE_DESIGN);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, stepRuns: CHAIN_MAX_STEP_RUNS });
    await endTask(w, "task-1", { finalReport: "r", branch: "fix" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ kind: "gate", status: "waiting" });
    expect(w.run(run.runId)).toMatchObject({ status: "waiting", stepRuns: CHAIN_MAX_STEP_RUNS });
  });

  it("names the attempt of a step that runs again, and counts the edge into $end", async () => {
    const w = setupWorld();
    const design: ChainDefinitionInput = {
      start: "check", limits: { maxRunUsd: 30 },
      steps: [agentStep("check", "Check", "root-cause-analyst", { kind: "branch", default: "done", choices: [{ id: "retry", description: "Try again", to: "check", maxTraversals: 2 }, { id: "done", description: "Done", to: "$end" }] })],
    };
    const chain = await w.publish(design);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "again", branch: "retry" });
    expect(w.attempts(run.runId)[1]).toMatchObject({ attempt: 2 });
    expect(w.events(run.runId).filter((event) => event.type === "step_started").map((event) => event.text)).toEqual([
      `Step "Check" started with ${name("root-cause-analyst")} version ${String(currentBuiltinVersion("root-cause-analyst"))}.`, `Step "Check" started with ${name("root-cause-analyst")} version ${String(currentBuiltinVersion("root-cause-analyst"))} (attempt 2).`,
    ]);
    await endTask(w, "task-2", { finalReport: "done", branch: "done" });
    expect(w.run(run.runId)).toMatchObject({ status: "succeeded", traversals: { "check>check": 1, "check>$end": 1 } });
    expect(w.events(run.runId).at(-1)).toMatchObject({ type: "ended", text: `${w.run(run.runId)!.chainName} finished.` });
  });

  it("fails a run whose attempt names a step the design does not have, whether it is starting or has ended", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const first = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, first.runId, stepSk(1)))!, stepId: "ghost", status: "succeeded", result: { report: "x" } });
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, first.runId);
    expect(w.run(first.runId)).toMatchObject({ status: "failed", failure: { seq: 1, reason: "design_invalid" } });
    const second = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, second.runId, stepSk(1)))!, stepId: "ghost", status: "starting", taskId: undefined });
    const stored = w.db.get(chainRunKey(ORG_A, second.runId, stepSk(1)))!;
    delete stored["taskId"];
    await advanceChainRun(w.deps, ORG_A, second.runId);
    expect(w.run(second.runId)).toMatchObject({ status: "failed", failure: { seq: 1, reason: "design_invalid" } });
  });

  it.each([
    // A step that timed out and has no retries left fails the run (Task 9); the run's own time is the one that ends it `timed_out`.
    ["timed_out", "failed", "step_failed", 'Step "Look into it" failed: it did not finish.'],
    ["failed", "failed", "step_failed", 'Step "Look into it" failed: it did not finish.'],
    ["cancelled", "cancelled", "step_cancelled", 'Step "Look into it" was cancelled.'],
  ])("ends a run whose attempt ended %s with no reason of its own as %s, with reason %s", async (attemptStatus, runStatus, reason, message) => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, status: attemptStatus });
    const { advanceChainRun } = await runner();
    await advanceChainRun(w.deps, ORG_A, run.runId);
    expect(w.run(run.runId)).toMatchObject({ status: runStatus, failure: { seq: 1, reason, message } });
  });

  it("names the reason and the words of each way a task can end without success", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const cases: Array<[string, string, string]> = [["cancelled", "step_cancelled", 'Step "Look into it" was cancelled.'], ["creator_removed", "creator_removed", 'Step "Look into it" was cancelled.'], ["closed", "closed", 'Step "Look into it" was cancelled.']];
    for (const [outcome, reason, message] of cases) {
      const run = await startAs(w, PRIYA, chain.chainId);
      const taskId = `task-${String(w.tasks.size)}`;
      await endTask(w, taskId, { outcome });
      expect(w.attempts(run.runId)[0]!.failure!.reason, outcome).toBe(reason);
      expect(w.run(run.runId)!.failure, outcome).toMatchObject({ reason, message });
      expect(w.events(run.runId).find((event) => event.type === "step_ended")!.text, outcome).toBe('Step "Look into it" was cancelled.');
      expect(w.attempts(run.runId)[0]!.endedAt, outcome).toBe(new Date(START).toISOString());
    }
  });

  it("uses the reason a task ended with: its run's, else its own, else a plain one, and none that is empty", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const one = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get({ pk: "DEVTASK#task-1", sk: "META" })!, outcomeReason: "Carl is no longer a member of Acme, so Rovara stopped this task." });
    await endTask(w, "task-1", { outcome: "creator_removed" });
    expect(w.attempts(one.runId)[0]!.failure!.message).toBe("Carl is no longer a member of Acme, so Rovara stopped this task.");
    const two = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get({ pk: "DEVTASK#task-2", sk: "META" })!, outcomeReason: "the task's own" });
    w.db.set({ ...w.db.get({ pk: "DEVTASK#task-2", sk: "AGENT_RUN" })!, endReason: "" });
    await endTask(w, "task-2", { outcome: "failed" });
    expect(w.attempts(two.runId)[0]!.failure!.message).toBe("the task's own");
    const three = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get({ pk: "DEVTASK#task-3", sk: "AGENT_RUN" })!, endReason: "" });
    await endTask(w, "task-3", { outcome: "failed" });
    expect(w.attempts(three.runId)[0]!.failure!.message).toBe("it did not finish");
  });

  it("does not read the state of a task of another org as this task's", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get({ pk: "DEVTASK#task-1", sk: "AGENT_RUN" })!, orgId: ORG_B });
    await endTask(w, "task-1", { finalReport: "ignored" });
    expect(w.attempts(run.runId)[0]!.result).toEqual({ report: "Rovara Code finished: succeeded." });
  });

  it("cuts a report to the report limit, refuses one with only spaces, and drops a branch that is not a branch id", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const long = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "é".repeat(20_000), branch: "Not A Branch!" });
    const result = w.attempts(long.runId)[0]!.result!;
    expect(Buffer.byteLength(result.report, "utf8")).toBeLessThanOrEqual(32_768);
    expect(result.report.endsWith("… (shortened)")).toBe(true);
    expect(result).not.toHaveProperty("branch");
    const blank = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-3", { finalReport: "  \n " });
    expect(w.attempts(blank.runId)[0]).toMatchObject({ status: "failed", failure: { reason: "result_invalid" } });
  });

  it("keeps at most 20 links of a coding task's pull requests", async () => {
    const w = setupWorld();
    const chain = await w.publish(INVESTIGATE_THEN_FIX);
    const run = await startAs(w, PRIYA, chain.chainId);
    await endTask(w, "task-1", { finalReport: "r", branch: "fix" });
    const { recordGateDecision } = await runner();
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2));
    const pullRequests = Array.from({ length: 25 }, (_unused, at) => ({ repository: "web", number: at + 1, url: `https://github.com/acme/web/pull/${String(at + 1)}` }));
    await endTask(w, "task-2", { pullRequests });
    expect(w.attempts(run.runId)[2]!.result!.links).toHaveLength(20);
    expect(w.attempts(run.runId)[2]!.result!.links![0]).toEqual({ label: "Pull request web#1", url: "https://github.com/acme/web/pull/1" });
  });

  it("ignores an end told for the right task under the wrong step, and a resume for a step that is running", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskEnded, markStepResumed } = await runner();
    const before = snapshot(w);
    await onStepTaskEnded(w.deps, { ...w.endEvent("task-1", { finalReport: "x" }), chain: { chainRunId: run.runId, stepId: "review" } });
    await markStepResumed(w.deps, ORG_A, run.runId, "task-1");
    expect(snapshot(w)).toBe(before);
  });

  it("goes on running after a paused step ends, even when the next step can't be started yet; a failure ends without a resumed event", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskPaused } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    w.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "socket hang up"));
    await expect(endTask(w, "task-1", { finalReport: "one" })).rejects.toThrow("socket hang up");
    expect(w.run(run.runId)!.status).toBe("running");
    const other = await startAs(w, PRIYA, chain.chainId);
    await onStepTaskPaused(w.deps, w.pauseEvent("task-2"));
    await endTask(w, "task-2", { outcome: "failed" });
    expect(w.events(other.runId).map((event) => event.type)).toEqual(["started", "step_started", "paused", "step_ended", "ended"]);
    expect(w.events(other.runId).find((event) => event.type === "step_ended")!.text).toBe('Step "Look into it" failed.');
  });

  it("ends a run whatever its slot bookkeeping says (Task 9, Task 6's M-3), and gives back a slot only when there is one to give", async () => {
    const w = setupWorld();
    const logged: string[] = [];
    w.deps.log = (event) => { logged.push(event); };
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    // The chain's count drifted to 0: the end goes through, the count stays 0, and the drift is said.
    w.db.set({ ...w.db.get(chainKey(ORG_A, chain.chainId, "META"))!, openRuns: 0 });
    await endTask(w, "task-1", { finalReport: "done" });
    expect(w.run(run.runId)!.status).toBe("succeeded");
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
    expect(logged).toEqual(["chain_run.open_runs_drifted"]);
    // The open item is not where the run says: the end goes through and the slot is given back.
    const other = await startAs(w, PRIYA, chain.chainId);
    w.db.delete(openChainRunKey(other.dueAt, ORG_A, other.runId));
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(1);
    await endTask(w, "task-2", { finalReport: "done" });
    expect(w.run(other.runId)!.status).toBe("succeeded");
    expect((await w.chainOf(chain.chainId)).openRuns).toBe(0);
  });
});

describe("startChainRun: the rest of the checks", () => {
  it("answers 'not set up' when the runner has no way to start a step", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const { startChainRun } = await runner();
    const bare = { ...w.deps } as Record<string, unknown>;
    delete bare["chainRuns"];
    expect(await fail(startChainRun(bare as never, callerOf(PRIYA), { orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "app", startedBy: { kind: "member", developerId: PRIYA }, requestId: randomUUID() } as never))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("counts the input in characters, not in UTF-16 units", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    await expect(startAs(w, PRIYA, chain.chainId, { input: "😀".repeat(8000) })).resolves.toMatchObject({ status: "running" });
    expect(await fail(startAs(w, PRIYA, chain.chainId, { input: "😀".repeat(8001) }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a start whose startedBy is not one the contract allows, and an event start with another origin", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    expect(await fail(startAsEvent(w, chain.chainId, CARL, { startedBy: EVENT_STARTED({ title: "bad\u0007title" }) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fail(startAsEvent(w, chain.chainId, CARL, { origin: "schedule" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.starts).toEqual([]);
  });

  it("answers a person who can only view a chain that was then archived with the archived text, not a refusal to use it", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage", owner: { kind: "member", developerId: DANA }, by: DANA });
    await setChainShares({ ...w.deps, store: w.chains }, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: PRIYA }, level: "use" }], by: DANA });
    await w.chains.archive(ORG_A, chain.chainId, DANA, undefined, { actor: fixtureActor(w.chains, ORG_A, DANA) });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toEqual({ code: "CHAIN_UNAVAILABLE", message: "Triage is archived, so it can't start new runs." });
  });

  it("answers an event start of a chain that does not exist as not found", async () => {
    const w = setupWorld();
    expect(await fail(startAsEvent(w, "chn_nnnnnnnnnnnnnnnnnnnn", CARL))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a person who can only view a step's agent, as one who may not use it", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", DANA);
    const { setShares } = await import("../../packages/broker/src/agents/access.js");
    await setShares(w.agentDeps, callerOf(DANA), reviewer.agentId, [{ principal: { kind: "member", developerId: PRIYA }, level: "view" }]);
    const chain = await w.publish({ ...TWO_STEPS, steps: [TWO_STEPS.steps[0]!, agentStep("review", "Review it", reviewer.agentId, { kind: "end" })] }, { name: "Triage", owner: { kind: "member", developerId: DANA }, by: DANA });
    await setChainShares({ ...w.deps, store: w.chains }, { orgId: ORG_A, chainId: chain.chainId, shares: [{ principal: { kind: "member", developerId: PRIYA }, level: "use" }], by: DANA });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("which you can't use") as string });
  });

  it("resolves each step at the version the chain pinned, not the one the agent has now", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", PRIYA);
    const chain = await w.publish({ ...ONE_STEP, steps: [agentStep("look", "Look into it", reviewer.agentId, { kind: "end" })] }, { name: "Triage" });
    const draft = (await w.agents.getDraft(ORG_A, reviewer.agentId))!;
    await w.agents.saveDraft({ orgId: ORG_A, agentId: reviewer.agentId, overlay: { ...draft.overlay, instructions: "second" }, expectedRevision: draft.revision, by: PRIYA });
    const record = (await w.agents.get(ORG_A, reviewer.agentId))!;
    await w.agents.publish({ orgId: ORG_A, agentId: reviewer.agentId, expectedDraftRevision: record.draftRevision, digest: "e".repeat(64), by: PRIYA });
    expect((await w.agents.get(ORG_A, reviewer.agentId))!.currentVersion).toBe(2);
    const asked: unknown[] = [];
    const real = w.agents.getVersion.bind(w.agents);
    w.agents.getVersion = (async (orgId: never, agentId: never, version: never) => { asked.push(version); return real(orgId, agentId, version); });
    await startAs(w, PRIYA, chain.chainId);
    expect(asked).toContain(1);
    // Plan 3's older-version gate (D) also reads the version that runs now, to compare the pinned one against it; nothing else may be read, and what runs is the pin.
    expect(asked.every((version) => version === 1 || version === 2)).toBe(true);
    expect(w.starts[0]!.agent).toEqual({ agentId: reviewer.agentId, version: 1 });
  });

  it("checks an event run's agents against the roster too, which only the autonomous resolution does", async () => {
    const w = setupWorld();
    const reviewer = await w.customAgent("Reviewer", CARL, []);
    const chain = await w.publish({ ...ONE_STEP, steps: [agentStep("look", "Look into it", reviewer.agentId, { kind: "end" })] }, { name: "Triage", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    expect(await fail(startAsEvent(w, chain.chainId, CARL))).toMatchObject({
      code: "CHAIN_UNAVAILABLE", message: expect.stringContaining("Reviewer isn't working on web yet") as string,
    });
  });

  it("starts the chain's latest version, and says which in the run and in the first event", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { name: "Triage" });
    await w.publishAgain(chain.chainId, { ...ONE_STEP, steps: [agentStep("look", "Look again", "root-cause-analyst", { kind: "end" })] });
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(run.chainVersion).toBe(2);
    expect(w.attempts(run.runId)[0]!.stepName).toBe("Look again");
  });

  it("refuses to start a run of a chain through another run's request", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA });
    const requestId = randomUUID();
    const { startChainRun } = await runner();
    const system = { system: "event" as const, owner: { developerId: CARL } };
    const run = await startChainRun(w.deps, system, { orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "event", startedBy: EVENT_STARTED(), trigger: SENTRY(), requestId } as never);
    expect(await fail(startChainRun(w.deps, system, { orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "event", startedBy: EVENT_STARTED(), trigger: SENTRY(), requestId, runId: run.runId, input: "other" } as never))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("what an ended step's refusal looks like", () => {
  it("redacts and neutralises the words of a refusal, and says in the events that the step could not start", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.refuse.push(agentXError("FORBIDDEN", `no \u0007way with ghp_${"a".repeat(36)}`));
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(w.attempts(run.runId)[0]!.failure!.message).toBe("no [U+0007]way with [redacted]");
    expect(w.run(run.runId)!.failure!.message).toBe('Step "Look into it" could not start: no [U+0007]way with [redacted].');
    expect(w.events(run.runId).map((event) => [event.type, event.text])).toEqual([
      ["started", "Chain 1 started."], ["step_started", `Step "Look into it" started with ${name("root-cause-analyst")} version ${String(currentBuiltinVersion("root-cause-analyst"))}.`],
      ["step_ended", 'Step "Look into it" could not start.'], ["ended", 'Step "Look into it" could not start: no [U+0007]way with [redacted].'],
    ]);
  });

  it("keeps a refusal's whole message up to 300 characters", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.hooks.refuse.push(agentXError("FORBIDDEN", "w".repeat(500)));
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(w.attempts(run.runId)[0]!.failure!.message).toBe(`${"w".repeat(299)}…`);
  });
});

describe("chainRunPortsFor", () => {
  it("hands a member's role and nothing else of their sign-in on, and nothing for a person who is not a member", async () => {
    const { chainRunPortsFor } = await runner();
    const ports = chainRunPortsFor({ callerFor: async (_orgId: string, developerId: string) => (developerId === PRIYA ? { orgId: ORG_A, developerId, orgRole: "member", sessionId: "s", name: "Priya", amr: "oidc" } : undefined) } as never);
    expect(await ports.callerFor(ORG_A, PRIYA)).toEqual({ orgId: ORG_A, developerId: PRIYA, orgRole: "member" });
    expect(await ports.callerFor(ORG_A, CARL)).toBeUndefined();
    expect(ports).not.toHaveProperty("admission");
  });
});

describe("POST /v1/app/chains/{id}/runs without the runner", () => {
  it("answers 404 when chain runs are not set up", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const { routeChainRequest } = await import("../../packages/broker/src/chains/routes.js");
    const bare = { ...w.deps } as Record<string, unknown>;
    delete bare["chainRuns"];
    const request = { method: "POST", body: JSON.stringify({ requestId: randomUUID(), project: "web" }), headers: {} };
    await expect(routeChainRequest(bare as never, callerOf(PRIYA), request as never, new URL(`https://x.example/v1/app/chains/${chain.chainId}/runs`))).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Not set up is the answer before the body is looked at.
    const empty = { method: "POST", body: JSON.stringify({}), headers: {} };
    await expect(routeChainRequest(bare as never, callerOf(PRIYA), empty as never, new URL(`https://x.example/v1/app/chains/${chain.chainId}/runs`))).rejects.toMatchObject({ code: "NOT_FOUND" });
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

  it("counts the input in characters, so 7,000 four-byte characters are within the 8,000 and 8,001 are not", async () => {
    const { h, world, publishStarter } = await routeSetup(false);
    const chain = await publishStarter();
    const accepted = await post(h, CAROLINE, chain.chainId, { requestId: randomUUID(), project: "web", input: "\u{1F600}".repeat(7000) });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    const refused = await post(h, CAROLINE, chain.chainId, { requestId: randomUUID(), project: "web", input: "\u{1F600}".repeat(8001) });
    expect(refused.status).toBe(400);
    expect(world.starts).toHaveLength(1);
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
    // Plan 5's session handlers are registered by any broker with agents set up; this test is about the chain runner's, so they are taken off before each look.
    unregisterAgentSessionTaskHandlers();
    expect(hasTaskEndHandlers()).toBe(false);
    await routeSetup(false);
    unregisterAgentSessionTaskHandlers();
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

// ---- what mutation testing found unpinned (the second pass)

/** A copy of a run's META and first attempt under an id that is not a run's, as a stray record would be. */
function plantUnderBadId(w: ChainWorld, runId: string, badId: string) {
  const meta = w.db.get(chainRunKey(ORG_A, runId, "META"))!;
  const attempt = w.db.get(chainRunKey(ORG_A, runId, stepSk(1)))!;
  w.db.set({ ...meta, ...chainRunKey(ORG_A, badId, "META"), runId: badId });
  w.db.set({ ...attempt, ...chainRunKey(ORG_A, badId, stepSk(1)), runId: badId });
}

describe("reads and ids the runner depends on", () => {
  it("refuses to append an event to a run whose stored org is not the one it was asked under", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { appendRunEvent } = await runEvents();
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, orgId: ORG_B });
    const before = snapshot(w);
    await expect(appendRunEvent(w.deps, ORG_A, run.runId, { type: "paused", text: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(snapshot(w)).toBe(before);
  });

  it("never reads a record under an id that is not a run's, for an end, a pause or the spend seam", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    plantUnderBadId(w, run.runId, "not-a-run");
    const { onStepTaskEnded, onStepTaskPaused, chainRunSpendReader } = await runner();
    const stray = { chain: { chainRunId: "not-a-run", stepId: "look" } };
    const before = snapshot(w);
    await onStepTaskEnded(w.deps, { ...w.endEvent("task-1", { finalReport: "done" }), ...stray });
    await onStepTaskPaused(w.deps, { ...w.pauseEvent("task-1"), ...stray });
    expect(snapshot(w)).toBe(before);
    expect(await chainRunSpendReader(w.deps).stepLimits(ORG_A, { chainRunId: "not-a-run", stepId: "look" })).toBeUndefined();
  });

  it("derives a person's run id from their org, themselves and the request id, the same one in every release", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId, { requestId: "00000000-0000-4000-8000-000000000001" });
    expect(run.runId).toBe("crn_ppjz3vw4br7em7in1xyn");
  });

  it("reads every attempt of a run however the table pages them, and reads them consistently", async () => {
    const w = setupWorld();
    const chain = await w.publish(THREE_STEPS_ALL);
    const real = w.deps.documentClient;
    const queries: Array<Record<string, unknown>> = [];
    const paged = {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name !== "QueryCommand") return real.send(command);
        queries.push(command.input);
        return real.send(new QueryCommand({ ...command.input, Limit: 1 } as never));
      },
    };
    const w2 = { ...w, deps: { ...w.deps, documentClient: paged } };
    const run = await startAs(w2, PRIYA, chain.chainId);
    await endTask(w2, "task-1", { finalReport: "one" });
    await endTask(w2, "task-2", { finalReport: "two" });
    expect(w.starts).toHaveLength(3);
    expect(w.attempts(run.runId).map((attempt) => attempt.status)).toEqual(["succeeded", "succeeded", "running"]);
    const context = JSON.stringify(w.starts[2]!.input.context);
    expect(context).toContain("one");
    expect(context).toContain("two");
    const stepReads = queries.filter((query) => (query["ExpressionAttributeValues"] as { ":prefix"?: string })[":prefix"] === "STEP#");
    expect(stepReads.length).toBeGreaterThan(0);
    expect(stepReads.every((query) => query["ConsistentRead"] === true)).toBe(true);
  });
});

describe("a failure that is not a lost race is not taken for one", () => {
  it("throws a failed write of a step's start even when the run has moved since, rather than re-reading", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.beforeTransaction('"step_started"', () => { w.touchRun(run.runId); throw new Error("db down"); });
    await expect(endTask(w, "task-1", { finalReport: "one" })).rejects.toThrow("db down");
    expect(w.starts).toHaveLength(1);
  });

  it("answers a failed start of a run as the failure it is, even if the chain was archived meanwhile", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.beforeTransaction('"started"', () => {
      w.db.set({ ...w.db.get(chainKey(ORG_A, chain.chainId, "META"))!, status: "archived" });
      throw new Error("db down");
    });
    await expect(startAs(w, PRIYA, chain.chainId)).rejects.toThrow("db down");
  });

  it("lets a refusal that will not pass on its own out of the first step's start, and a transient one not", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.beforeTransaction('"step_started"', () => { throw agentXError("CONFIG_INVALID", "the design is not valid"); });
    expect(await fail(startAs(w, PRIYA, chain.chainId))).toMatchObject({ code: "CONFIG_INVALID" });
    const requestId = randomUUID();
    w.beforeTransaction('"step_started"', () => { throw new Error("db down"); });
    const run = await startAs(w, PRIYA, chain.chainId, { requestId });
    expect(run).toMatchObject({ status: "running", currentSeq: 0 });
  });
});

describe("a request that comes again", () => {
  /** A run that exists with no step at all: the process died right after the start's transaction. */
  async function startedWithoutStep(w: ChainWorld, chainId: string, requestId: string) {
    w.beforeTransaction("STEP#0001", () => { throw new Error("the process died"); });
    await fail(startAs(w, PRIYA, chainId, { requestId }));
  }

  it("answers the stored run when finishing its first step fails for a reason that may pass", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const requestId = randomUUID();
    await startedWithoutStep(w, chain.chainId, requestId);
    w.hooks.refuse.push(agentXError("RUNTIME_UNAVAILABLE", "socket hang up"));
    const again = await startAs(w, PRIYA, chain.chainId, { requestId });
    expect(again.currentSeq).toBe(1);
    expect(w.attempts(again.runId)).toMatchObject([{ status: "starting" }]);
  });

  it("does not move on a run that is going, however its steps stand, when the same request comes again", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const requestId = randomUUID();
    const first = await startAs(w, PRIYA, chain.chainId, { requestId });
    // The first step ended and nothing has moved the run on yet.
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, first.runId, stepSk(1)))!, status: "succeeded", result: { report: "one" } });
    const again = await startAs(w, PRIYA, chain.chainId, { requestId });
    expect(again.currentSeq).toBe(1);
    expect(w.attempts(first.runId)).toHaveLength(1);
    expect(w.starts).toHaveLength(1);
  });
});

describe("what a step is handed is only what earlier steps reported", () => {
  it("leaves out the result of a step that did not succeed, and of an attempt that is not an agent's", async () => {
    for (const planted of [{ status: "failed" }, { kind: "gate", status: "succeeded" }]) {
      const w = setupWorld();
      const chain = await w.publish(THREE_STEPS_ALL);
      const run = await startAs(w, PRIYA, chain.chainId);
      await endTask(w, "task-1", { finalReport: "one" });
      w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, ...planted, result: { report: "poison" } });
      await endTask(w, "task-2", { finalReport: "two" });
      const context = JSON.stringify(w.starts[2]!.input.context);
      expect(context, JSON.stringify(planted)).toContain("two");
      expect(context, JSON.stringify(planted)).not.toContain("poison");
    }
  });
});

describe("an edge to a step the design does not have", () => {
  it("fails the run at the step it left, rather than breaking", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const stored = w.db.find((item) => item.pk === chainKey(ORG_A, chain.chainId, "META").pk && String(item.sk).startsWith("VERSION#"))[0]!;
    const definition = structuredClone(stored["definition"]) as { steps: Array<{ id: string; next: { to?: string } }> };
    definition.steps.find((step) => step.id === "look")!.next.to = "ghost";
    w.db.set({ ...stored, definition });
    await endTask(w, "task-1", { finalReport: "one" });
    expect(w.run(run.runId)).toMatchObject({ status: "failed", failure: { seq: 1, reason: "design_invalid", message: 'This chain has no step "ghost".' } });
    expect(w.starts).toHaveLength(1);
  });
});

describe("a run keeps the state a person can rely on when the next write fails", () => {
  it("leaves a run that was paused running when its step ends and the next step's write then fails", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    const { onStepTaskPaused } = await runner();
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    w.beforeTransaction('"step_started"', () => { throw new Error("db down"); });
    await expect(endTask(w, "task-1", { finalReport: "one" })).rejects.toThrow("db down");
    expect(w.run(run.runId)!.status).toBe("running");
    expect(w.attempts(run.runId)[0]!.status).toBe("succeeded");
  });

  it("leaves a run running with its gate passed when the next step's write fails, and does not move it again for the same decision", async () => {
    const w = setupWorld();
    const { run } = await atGate(w);
    const { recordGateDecision } = await runner();
    w.beforeTransaction('"step_started"', () => { throw new Error("db down"); });
    await expect(recordGateDecision(w.deps, ORG_A, run.runId, 2, "approved", decisionBy(w, run.runId, 2))).rejects.toThrow("db down");
    expect(w.run(run.runId)!.status).toBe("running");
    expect(w.attempts(run.runId)[1]).toMatchObject({ status: "succeeded", decision: "approved" });
    const before = snapshot(w);
    await recordGateDecision(w.deps, ORG_A, run.runId, 2, "declined", decisionBy(w, run.runId, 2));
    expect(snapshot(w)).toBe(before);
    expect(w.starts).toHaveLength(1);
  });

  it("goes on with the run when another telling of an end got its write in first and stopped there", async () => {
    const w = setupWorld();
    const chain = await w.publish(TWO_STEPS);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.beforeTransaction('"step_ended"', () => {
      w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, stepSk(1)))!, status: "succeeded", result: { report: "one" } });
      w.touchRun(run.runId);
    });
    await endTask(w, "task-1", { finalReport: "one" });
    expect(w.starts).toHaveLength(2);
    expect(w.attempts(run.runId)).toHaveLength(2);
  });

  it("leaves a step that was started while its run was cancelled cancelled, even when the cancel lands as the start is recorded", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    w.beforeTransaction("task-1", () => {
      const runId = (w.db.find((item) => item.entityType === "CHAIN_RUN")[0] as { runId: string }).runId;
      w.db.set({ ...w.db.get(chainRunKey(ORG_A, runId, stepSk(1)))!, status: "cancelled" });
      w.db.set({ ...w.db.get(chainRunKey(ORG_A, runId, "META"))!, status: "cancelled" });
    });
    const run = await startAs(w, PRIYA, chain.chainId);
    expect(w.attempts(run.runId)[0]).toMatchObject({ status: "cancelled" });
    expect(w.attempts(run.runId)[0]).not.toHaveProperty("taskId");
  });

  it("does not pause a run that has ended, even when its attempt still looks as if it ran", async () => {
    const w = setupWorld();
    const chain = await w.publish(ONE_STEP);
    const run = await startAs(w, PRIYA, chain.chainId);
    w.db.set({ ...w.db.get(chainRunKey(ORG_A, run.runId, "META"))!, status: "cancelled" });
    const { onStepTaskPaused } = await runner();
    const before = snapshot(w);
    await onStepTaskPaused(w.deps, w.pauseEvent("task-1"));
    expect(snapshot(w)).toBe(before);
  });
});
