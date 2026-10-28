// A coding run that ends with no code change keeps what it found: the commands the agent ran, their output and its own conclusion. This is the shape, its bounds and its redaction
// (the worker builds it before it leaves; the broker rebuilds whatever arrives before it is stored or shown).
import { describe, expect, it } from "vitest";
import {
  NO_CHANGE_FINDINGS_COMMANDS_MAX, NO_CHANGE_FINDINGS_COMMAND_MAX, NO_CHANGE_FINDINGS_CONCLUSION_MAX, NO_CHANGE_FINDINGS_OUTPUT_MAX, NO_CHANGE_FINDINGS_TOTAL_MAX,
  NO_CODE_CHANGED_LEGACY_REASONS, NO_CODE_CHANGED_REASON, NoChangeFindingsSchema, buildNoChangeFindings, isNoCodeChangedReason, noChangeFindingsFrom, noChangeFindingsSize,
} from "../../packages/contracts/src/no-change-findings.js";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
import { WorkflowSnapshotSchema, blockWorkflow, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";

// Built at run time: no key-shaped literal is in this file.
const secret = (): string => ["ghp_", "Ab12".repeat(9)].join("");
const awsKey = (): string => ["AKIA", "QWERTYUIOPASDFGH"].join("");

describe("buildNoChangeFindings", () => {
  it("keeps the commands, their output and the conclusion as the agent left them", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "grep -rn retry src", output: "src/a.ts:4: retry\n" }, { command: "npm test", output: "3 passed", failed: false }], conclusion: "We do use retry, in src/a.ts." });
    expect(findings).toEqual({ commands: [{ command: "grep -rn retry src", output: "src/a.ts:4: retry" }, { command: "npm test", output: "3 passed" }], conclusion: "We do use retry, in src/a.ts." });
    expect(NoChangeFindingsSchema.safeParse(findings).success).toBe(true);
  });

  it("caps everything: many commands, huge outputs and a huge conclusion stay under the fixed limits, and the last commands are the ones kept", () => {
    const commands = Array.from({ length: 40 }, (_, index) => ({ command: `run-${String(index)} ${"x".repeat(1000)}`, output: `out-${String(index)} ${"y".repeat(50_000)}` }));
    const findings = buildNoChangeFindings({ commands, conclusion: "z".repeat(30_000) });
    expect(findings.commands).toHaveLength(NO_CHANGE_FINDINGS_COMMANDS_MAX);
    expect(findings.omitted).toBe(30);
    expect(findings.commands[0]!.command.startsWith("run-30 ")).toBe(true);
    expect(findings.commands.at(-1)!.command.startsWith("run-39 ")).toBe(true);
    for (const item of findings.commands) {
      expect(item.command.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_COMMAND_MAX);
      expect((item.output ?? "").length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_OUTPUT_MAX);
    }
    expect(findings.conclusion!.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_CONCLUSION_MAX);
    expect(noChangeFindingsSize(findings)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    expect(NoChangeFindingsSchema.safeParse(findings).success).toBe(true);
  });

  it("keeps the beginning and the end of a long output, so a test run's summary line survives", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "npm test", output: `START ${"m".repeat(5000)} 12 passed, 0 failed` }] });
    const output = findings.commands[0]!.output!;
    expect(output.startsWith("START")).toBe(true);
    expect(output.endsWith("12 passed, 0 failed")).toBe(true);
    expect(output.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_OUTPUT_MAX);
  });

  it("the total limit wins over the per-command limit: the conclusion keeps its room and the earliest outputs shrink first", () => {
    const findings = buildNoChangeFindings({ commands: Array.from({ length: 10 }, (_, index) => ({ command: `c${String(index)}`, output: "o".repeat(NO_CHANGE_FINDINGS_OUTPUT_MAX) })), conclusion: "k".repeat(NO_CHANGE_FINDINGS_CONCLUSION_MAX) });
    expect(noChangeFindingsSize(findings)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    expect(findings.conclusion).toHaveLength(NO_CHANGE_FINDINGS_CONCLUSION_MAX);
    expect(findings.commands.at(-1)!.output!.length).toBeGreaterThan(0);
  });

  it("redacts a secret in a command, its output and the conclusion (positive control: the plain text did hold it)", () => {
    const token = secret(), key = awsKey();
    const raw = { commands: [{ command: `curl -H "Authorization: Bearer ${token}" https://example.test`, output: `found ${token} and ${key}` }], conclusion: `The key ${key} is in the environment.` };
    expect(JSON.stringify(raw)).toContain(token);
    const text = JSON.stringify(buildNoChangeFindings(raw));
    expect(text).not.toContain(token);
    expect(text).not.toContain(key);
    expect(text).toContain("[REDACTED]");
  });

  it("makes a command one line, drops control characters, and leaves out anything that is not text", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "echo a\n\techo b\u0007" }, { command: 42 }, { output: "no command" }, null as never, { command: "   " }], conclusion: 7 });
    expect(findings).toEqual({ commands: [{ command: "echo a echo b" }] });
  });

  it("says nothing about a conclusion when the agent wrote none", () => {
    expect(buildNoChangeFindings({ commands: [{ command: "ls" }], conclusion: undefined }).conclusion).toBeUndefined();
    expect(buildNoChangeFindings({ commands: [{ command: "ls" }], conclusion: "  \n " }).conclusion).toBeUndefined();
  });
});

describe("noChangeFindingsFrom: a result's block is rebuilt on this side", () => {
  it("is undefined when there is no block at all (an older worker), and for anything that is not an object", () => {
    for (const raw of [undefined, null, "text", 4, [], [{ commands: [] }]]) expect(noChangeFindingsFrom(raw)).toBeUndefined();
  });

  it("keeps an empty block (a newer worker that saw no commands and no conclusion)", () => {
    expect(noChangeFindingsFrom({ commands: [] })).toEqual({ commands: [] });
  });

  it("redacts and bounds what a worker sent, whatever it sent (a hostile or a newer one)", () => {
    const token = secret();
    const hostile = { commands: Array.from({ length: 200 }, (_, index) => ({ command: `c${String(index)} ${token}`, output: `${token} ${"q".repeat(10_000)}` })), omitted: 7, conclusion: `${token} ${"w".repeat(50_000)}`, extra: "ignored" };
    const findings = noChangeFindingsFrom(hostile)!;
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(findings.commands).toHaveLength(NO_CHANGE_FINDINGS_COMMANDS_MAX);
    expect(findings.omitted).toBe(7 + 190);
    expect(noChangeFindingsSize(findings)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    expect(NoChangeFindingsSchema.safeParse(findings).success).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("ignored");
  });

  it("survives a malformed block without throwing", () => {
    expect(noChangeFindingsFrom({ commands: "nope", conclusion: { a: 1 }, omitted: "many" })).toEqual({ commands: [] });
    expect(noChangeFindingsFrom({ commands: [1, "two", { command: { deep: true } }] })).toEqual({ commands: [] });
  });
});

describe("the block reason", () => {
  it("is the new wording, and the wording stored before still reads as this stop", () => {
    expect(WORKFLOW_BLOCK_REASONS.noCodeChanged).toBe(NO_CODE_CHANGED_REASON);
    expect(isNoCodeChangedReason(NO_CODE_CHANGED_REASON)).toBe(true);
    for (const legacy of NO_CODE_CHANGED_LEGACY_REASONS) expect(isNoCodeChangedReason(legacy)).toBe(true);
    expect(isNoCodeChangedReason("Coding stopped before it finished.")).toBe(false);
    expect(isNoCodeChangedReason(undefined)).toBe(false);
    expect(NO_CODE_CHANGED_LEGACY_REASONS[0]).toContain("no code changed");
    expect(NO_CODE_CHANGED_REASON).not.toMatch(/verified|checks passed/iu);
  });
});

describe("blocking a coding step keeps findings only for the no-code-change stop", () => {
  const now = "2026-10-26T12:00:00.000Z";
  const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };
  const coding = () => WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now }), revision: 5, stage: "IMPLEMENT", state: "RUNNING", artifacts: [plan] });
  const found = { commands: [{ command: "ls" }], conclusion: "Nothing to change." };

  it("keeps them with the no-code-change reason, and drops an earlier run's when the step is blocked again for another reason", () => {
    const stopped = blockWorkflow(coding(), NO_CODE_CHANGED_REASON, now, { noChangeFindings: found });
    expect(stopped.noChangeFindings).toEqual(found);
    expect(stopped).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON });
    const again = blockWorkflow({ ...stopped, state: "RUNNING" }, "implementation operation ended failed", now, { noChangeFindings: found });
    expect(again.noChangeFindings).toBeUndefined();
    expect(blockWorkflow({ ...stopped, state: "RUNNING" }, "implementation operation ended failed", now).noChangeFindings).toBeUndefined();
  });

  it("never attaches them to another reason, whatever the caller passed", () => {
    expect(blockWorkflow(coding(), "implementation operation ended failed", now, { noChangeFindings: found }).noChangeFindings).toBeUndefined();
  });
});
