// The Slack words for a run that needed no code change: every line of the findings is untrusted (a command's output, a model's words), so it is made inert and redacted, and the longest
// message the limits allow is still a valid Slack post.
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { NO_CHANGE_FINDINGS_TOTAL_MAX, NO_CODE_CHANGED_REASON, buildNoChangeFindings } from "../../packages/contracts/src/no-change-findings.js";
import { noCodeChangedText } from "../../packages/broker/src/developer/no-change-findings-text.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-26T12:00:00.000Z";
const secret = (): string => ["ghp_", "Ab12".repeat(9)].join("");

const blocked = (findings: unknown) => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), revision: 7, stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON,
  artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now }],
  ...(findings === undefined ? {} : { noChangeFindings: findings }),
});

describe("the findings as Slack words", () => {
  it("makes every untrusted line inert: no mention, no link, no tag, no quote, no cross-reference", () => {
    const hostile = buildNoChangeFindings({
      commands: [{ command: "echo '<!channel> <@U0123456789> <https://evil.example|click> @here #123 fixes ENG-9`'", output: "<!everyone>\n> quoted\n[x](https://evil.example)\n```\nbreak out\n```" }],
      conclusion: "Ping <!here> and @channel, see <https://evil.example|here> & GH-12.\n> not a quote",
    });
    const text = noCodeChangedText(hostile);
    expect(text).not.toContain("<!");
    expect(text).not.toContain("<@");
    expect(text).not.toMatch(/<https?:/u);
    expect(text).not.toContain("@here");
    expect(text).not.toContain("@channel");
    expect(text).not.toContain("```");
    // The only quote lines are the broker's own (two spaces after the mark), one for each line of output.
    expect(text).not.toMatch(/^>(?! {2})/mu);
    expect(text).toContain("&gt; not a quote");
    expect(text).toContain("&gt; quoted");
    // Positive control: the text is there, only inert.
    expect(text).toContain("channel");
    expect(text).toContain("break out");
  });

  it("redacts again at display: a block that was stored with a secret in it still shows none", () => {
    const token = secret();
    const stale = { commands: [{ command: `echo ${token}`, output: token }], conclusion: `key ${token}` };
    expect(JSON.stringify(stale)).toContain(token);
    expect(noCodeChangedText(stale)).not.toContain(token);
    expect(noCodeChangedText(stale)).toContain("[REDACTED]");
  });

  it("is a valid Slack post at the largest size the limits allow, and every section is within Slack's limit", () => {
    const biggest = buildNoChangeFindings({ commands: Array.from({ length: 20 }, (_, index) => ({ command: `command-${String(index)} ${"a".repeat(500)}`, output: Array.from({ length: 40 }, (__, line) => `line ${String(line)} ${"b".repeat(80)}`).join("\n") })), conclusion: Array.from({ length: 30 }, (_, line) => `paragraph ${String(line)} ${"w".repeat(100)}`).join("\n") });
    const message = workflowMessage({ taskId, workflow: blocked(biggest) })!;
    expect(message.text.length).toBeLessThan(NO_CHANGE_FINDINGS_TOTAL_MAX * 3);
    const slack = new StrictSlackWeb();
    expect(() => slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message })).not.toThrow();
    expect(message.blocks.filter((block) => block.type === "actions")).toHaveLength(1);
  });

  it("without findings says only that no change was needed, then the choices", () => {
    expect(noCodeChangedText(undefined).split("\n")).toEqual(["No code changes were needed.", "", expect.stringContaining("Retry coding")]);
  });
});
