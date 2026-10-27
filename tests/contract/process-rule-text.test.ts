// "How we work" (H7): the rules a maintainer writes for a project's process layer are made inert on the server when the draft is saved: hidden characters are removed, the text is
// trimmed, and one text is at most 4,000 characters. Ordinary agents keep what they write.
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, type AgentId } from "../../packages/contracts/src/index.js";
import { RULE_TEXT_MAX, inertRuleText } from "../../packages/broker/src/playbook/inert-rule-text.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { MAX, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode, message: error.message }));

function deps(w: MergeWorld): ProjectPlaybookDependencies {
  return { documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, projectFor: async (_caller, rawName) => ({ name: rawName, role: "maintainer" }) };
}
async function processLayer(w: MergeWorld): Promise<AgentId> {
  return (await postProjectProcess(deps(w), w.caller(MAX), "web")).agentId;
}
async function save(w: MergeWorld, agentId: AgentId, overlay: Record<string, unknown>) {
  const agent = (await w.store.get(ORG_A, agentId))!;
  await w.store.saveDraft({ orgId: ORG_A, agentId, overlay, expectedRevision: agent.draftRevision, by: MAX });
  return (await w.store.getDraft(ORG_A, agentId))!.overlay;
}

describe("inertRuleText", () => {
  it("removes zero-width, bidi, other format characters, controls (not newline or tab), and variation selectors, then trims", () => {
    const dirty = "\u200B  Use\u200D tests\u202E.\u2066\nSecond\tline\u0007\u0000\uFE0F\u{E0100}\u{E0041}\uFEFF\u0085\r\nthird  ";
    expect(inertRuleText(dirty)).toBe("Use tests.\nSecond\tline\nthird");
  });
  it("removes the default-ignorable characters A4 removes from rule files (Hangul fillers, the combining grapheme joiner, invisible operators)", () => {
    expect(inertRuleText("Use\u3164 tests\u115F\u1160\uFFA0\u034F.\u2064")).toBe("Use tests.");
  });
  it("leaves ordinary text, including accents and emoji, as it is", () => {
    expect(inertRuleText("Écrire des tests. 👍")).toBe("Écrire des tests. 👍");
  });
});

describe("rule text saved to a process layer's draft", () => {
  it("removes hidden characters from the project-wide rules and from a stage's instructions", async () => {
    const w = mergeWorld();
    const layer = await processLayer(w);
    const overlay = await save(w, layer, { instructions: "\u200B Keep changes small.\u202E ", steps: { build: { instructions: "Run\u200D the linter.\u0007" } } });
    expect(overlay.instructions).toBe("Keep changes small.");
    expect(overlay.steps?.build?.instructions).toBe("Run the linter.");
  });

  it("accepts exactly 4,000 characters and refuses 4,001, counting after hidden characters are removed", async () => {
    const w = mergeWorld();
    const layer = await processLayer(w);
    expect((await save(w, layer, { instructions: "a".repeat(RULE_TEXT_MAX) })).instructions).toHaveLength(RULE_TEXT_MAX);
    const tooLong = await failure(save(w, layer, { instructions: "a".repeat(RULE_TEXT_MAX + 1) }));
    expect(tooLong).toMatchObject({ code: "CONFIG_INVALID", status: 400 });
    expect(tooLong?.message).toContain("4,000");
    expect(await failure(save(w, layer, { steps: { review: { instructions: "b".repeat(RULE_TEXT_MAX + 1) } } }))).toMatchObject({ code: "CONFIG_INVALID" });
    // 4,000 visible characters hidden among 200 invisible ones, and spaces around: fits.
    const padded = "  " + "a".repeat(RULE_TEXT_MAX / 2) + "\u200B".repeat(200) + "a".repeat(RULE_TEXT_MAX / 2) + "  ";
    expect((await save(w, layer, { instructions: padded })).instructions).toHaveLength(RULE_TEXT_MAX);
  });

  it("counts characters, not UTF-16 units or bytes", async () => {
    const w = mergeWorld();
    const layer = await processLayer(w);
    // 2,001 characters are 4,002 UTF-16 units (over 4,000) and 8,004 bytes (inside the layer's own byte limit).
    expect((await save(w, layer, { instructions: "👍".repeat(2001) })).instructions).toHaveLength(4002);
  });

  it("makes the rule text of a process layer inert when it is created with one, too", async () => {
    const w = mergeWorld();
    const created = await w.store.create({
      orgId: ORG_A, name: "web process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, purpose: "process", createdBy: MAX,
      overlay: { instructions: "\u200B Keep changes small.\u202E ", steps: { build: { instructions: "Run\u200D the linter.\u0007" } } },
    });
    const overlay = (await w.store.getDraft(ORG_A, created.agentId))!.overlay;
    expect(overlay.instructions).toBe("Keep changes small.");
    expect(overlay.steps?.build?.instructions).toBe("Run the linter.");
  });

  it("does not change what an ordinary agent's draft saves", async () => {
    const w = mergeWorld();
    const created = await w.store.create({ orgId: ORG_A, name: "helper", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    const text = "\u200B " + "a".repeat(RULE_TEXT_MAX + 10);
    expect((await save(w, created.agentId, { instructions: text })).instructions).toBe(text);
  });
});
