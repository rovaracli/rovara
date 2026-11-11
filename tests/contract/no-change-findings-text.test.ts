// The Slack words for a run that needed no code change: every line of the findings is untrusted (a command's output, a model's words), so it is made inert and redacted, and the longest
// message the limits allow is still a valid Slack post.
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { NO_CHANGE_FINDINGS_TOTAL_MAX, NO_CODE_CHANGED_REASON, buildNoChangeFindings } from "@rovara-code/contracts";
import { noCodeChangedText } from "../../packages/broker/src/developer/no-change-findings-text.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { RunFindings } from "../../packages/worker/src/no-change-findings.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-26T12:00:00.000Z";
const secret = (): string => ["ghp_", "Ab12".repeat(9)].join("");
// Values that no pattern redaction knows; built at run time.
const hex40 = (): string => ["a3f9".repeat(10)].join("");
const opaque = (): string => ["Zk9", "Qw3x", "Lm82", "Vb7n", "Pd41", "Rt6y", "Jh5c"].join("");
const pw = (): string => ["hunt", "er2-", "pw77"].join("");

const blocked = (findings: unknown) => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), revision: 7, stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON,
  artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now }],
  ...(findings === undefined ? {} : { noChangeFindings: findings }),
});

const page = "https://agentx.example.test/review/11111111-1111-4111-8111-111111111111/task";
const LAST = "No tests were run and no pull request was opened. To change something, reply here and choose Retry coding; otherwise close the task.";

describe("the findings of a run split into parts, as Slack words", () => {
  it("masks a `NAME: value` and a `NAME=value` that begin a part's text: the part's label never shares a line with it", () => {
    const dsn = `https://${["abc", "123"].join("")}@sentry.example/42`, token = ["tk", "91Xz", "Q7"].join("-"), pass = pw();
    const run = new RunFindings();
    run.setOrder(["a", "b"]);
    run.forPart("a").concludeWith(`SENTRY_DSN: ${dsn}\nAPI_TOKEN=${token}\nThe first part found the settings.`);
    run.forPart("b").concludeWith(`DB_PASSWORD=${pass}\nTHE_THING: ${pass}\nThe second part agrees.`);
    const found = run.build();
    expect(found.conclusion).toContain("Part 1:\nSENTRY_DSN");
    const text = noCodeChangedText(found, page);
    for (const value of [dsn, "abc123@sentry", token, pass]) expect(text, value).not.toContain(value);
    expect(text).toContain("Part 1:");
    expect(text).toContain("SENTRY_DSN: [hidden]");
    expect(text).toMatch(/API_TOKEN=\[(?:hidden|REDACTED)\]/u);
    expect(text).toContain("The first part found the settings.");
  });
});

describe("the findings as Slack words", () => {
  it("pins the message: the findings first, the commands with the link to the full output, then what was not done and the two ways on", () => {
    const found = buildNoChangeFindings({ commands: [{ command: "grep -rn retry src", output: "src/a.ts:4: retry" }, { command: "npm test", failed: true }], omitted: 2, conclusion: "We use retry in one file.\nIt is on by default." } as never);
    expect(noCodeChangedText(found, page)).toBe([
      "No code changes were needed. Here's what I found: We use retry in one file.",
      "It is on by default.",
      `Commands I ran: \`grep -rn retry src\`, \`npm test\` (it failed) · Full output on the task page: <${page}|task page>`,
      LAST,
    ].join("\n"));
    expect(noCodeChangedText(found, undefined)).toContain("Commands I ran: `grep -rn retry src`, `npm test` (it failed)\n");
    expect(noCodeChangedText(found, undefined)).not.toContain("Full output");
  });

  it("pins the message with no conclusion, and with no findings at all", () => {
    expect(noCodeChangedText({ commands: [{ command: "ls src" }] }, page)).toBe(`No code changes were needed. The agent didn't write a conclusion; see what it ran on the task page: <${page}|task page>\n${LAST}`);
    expect(noCodeChangedText({ commands: [] }, undefined)).toBe(`No code changes were needed. The agent didn't write a conclusion; see what it ran on the task page.\n${LAST}`);
    expect(noCodeChangedText(undefined, page)).toBe(`No code changes were needed.\n${LAST}`);
  });

  it("posts no command output at all, only the commands and the conclusion", () => {
    const text = noCodeChangedText({ commands: [{ command: "npm test", output: "OUTPUT-LINE-ONE\nOUTPUT-LINE-TWO" }], conclusion: "Done." }, page);
    expect(text).toContain("`npm test`");
    expect(text).not.toContain("OUTPUT-LINE");
  });

  it("hides what no pattern knows, in the conclusion and in the commands: a bare hex token, an opaque token, `password is X`, `export X=…`, `MY_PW=… ./run`, and the lines of a quoted .env", () => {
    const found = { commands: [{ command: `export DEPLOY_X=${opaque()}` }, { command: `MY_PW=${pw()} ./run` }, { command: "ls src" }], conclusion: [
      `The token ${hex40()} is in the config, and ${opaque()} too.`, `The password is ${pw()} and the key is "${opaque()}".`, `export SOME_X=${opaque()}`, `MY_PW=${pw()} ./run`,
      `The .env holds:`, `> "STRIPE_SK=${opaque()}"`, `WEBHOOK=https://hooks.example.test/${opaque()}`, "Summary: nothing to change.",
    ].join("\n") };
    const text = noCodeChangedText(found, page);
    for (const value of [hex40(), opaque(), pw()]) expect(text).not.toContain(value);
    // Positive controls: the sentences, the names and the ordinary prose are there.
    expect(text).toContain("The token [hidden] is in the config");
    expect(text).toContain("The password is [hidden] and the key is \"[hidden]\".");
    expect(text).toContain("export SOME_X=[hidden]");
    expect(text).toContain("MY_PW=[hidden] ./run");
    expect(text).toContain("STRIPE_SK=[hidden]");
    expect(text).toContain("WEBHOOK=[hidden]");
    expect(text).toContain("Summary: nothing to change.");
    expect(text).toContain("`export DEPLOY_X=[hidden]`, `MY_PW=[hidden] ./run`, `ls src`");
    // The page's own view of the same block is not masked this far (it checks who may read it): the values are still in the stored block.
    expect(JSON.stringify(found)).toContain(hex40());
  });

  it("leaves ordinary text alone: a short identifier, a path, a flag and a sentence", () => {
    const text = noCodeChangedText({ commands: [{ command: "grep -rn --include=*.ts retry src/payments/retry.ts" }], conclusion: "We use retryPolicy in src/payments/retry.ts: see line 12." }, page);
    expect(text).toContain("We use retryPolicy in src/payments/retry.ts: see line 12.");
    expect(text).toContain("`grep -rn --include=*.ts retry src/payments/retry.ts`");
  });

  it("gives the task page link even when there are no commands to list", () => {
    expect(noCodeChangedText({ commands: [], conclusion: "All good." }, page)).toBe(`No code changes were needed. Here's what I found: All good.\nDetails on the task page: <${page}|task page>\n${LAST}`);
    expect(noCodeChangedText({ commands: [], conclusion: "All good." }, undefined)).toBe(`No code changes were needed. Here's what I found: All good.\n${LAST}`);
  });

  it("makes every untrusted line inert: no mention, no link, no tag, no quote, no cross-reference", () => {
    const hostile = buildNoChangeFindings({
      commands: [{ command: "echo '<!channel> <@U0123456789> <https://evil.example|click> @here #123 fixes ENG-9`'", output: "<!everyone>" }],
      conclusion: "Ping <!here> and @channel, see <https://evil.example|here> & GH-12.\n> not a quote\n```\nbreak out\n```",
    });
    const text = noCodeChangedText(hostile, page);
    // The one link in the message is the task page link the broker made.
    expect(text.replace(`<${page}|task page>`, "")).not.toMatch(/<[^>]*>/u);
    expect(text).not.toContain("<!");
    expect(text).not.toContain("<@");
    expect(text).not.toContain("@here");
    expect(text).not.toContain("@channel");
    expect(text).not.toContain("```");
    expect(text).not.toMatch(/^>/mu);
    expect(text).toContain("&gt; not a quote");
    // Positive control: the text is there, only inert.
    expect(text).toContain("break out");
    expect(text).toContain("channel");
  });

  it("redacts again at display: a block that was stored with a secret in it still shows none", () => {
    const token = secret();
    const stale = { commands: [{ command: `echo ${token}`, output: token }], conclusion: `key ${token}` };
    expect(JSON.stringify(stale)).toContain(token);
    expect(noCodeChangedText(stale, page)).not.toContain(token);
    expect(noCodeChangedText(stale, page)).toContain("[REDACTED]");
  });

  it("is a valid Slack post at the largest size the limits allow", () => {
    const biggest = buildNoChangeFindings({ commands: Array.from({ length: 20 }, (_, index) => ({ command: `command-${String(index)} ${"a".repeat(500)}`, output: "b".repeat(5000) })), conclusion: Array.from({ length: 30 }, (_, line) => `paragraph ${String(line)} ${"w".repeat(100)}`).join("\n") });
    const message = workflowMessage({ taskId, workflow: blocked(biggest), taskPageUrl: page })!;
    expect(message.text.length).toBeLessThan(NO_CHANGE_FINDINGS_TOTAL_MAX * 3);
    const slack = new StrictSlackWeb();
    expect(() => slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message })).not.toThrow();
    expect(message.blocks.filter((block) => block.type === "actions")).toHaveLength(1);
  });
});
