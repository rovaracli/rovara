// Setup and test health SH19: the ask's words (Slack card, follow-up post and task page) say the Fix setup case in fixed words, only while vx is on.
import { describe, expect, it } from "vitest";
import { autoFixCardLines, fixSetupWording, type AutoFixAsk } from "../../packages/broker/src/developer/autofix-messages.js";

const NOW = "2026-11-02T12:00:00.000Z";
const ON = { VERIFY_RESULTS_ENABLED: "1" };

describe("the ask's words with vx on", () => {
  const ask = { workflowRevision: 7, reason: "retry-limit", codes: ["check-runner-failed"], at: NOW } as AutoFixAsk;
  const flow = { decisions: [], revision: 7 };

  it("say the test setup, not the code, is the problem and point at the Fix setup card; a limit's ask keeps its words", () => {
    const plain = autoFixCardLines(flow, ask).join("\n");
    expect(plain).toContain("Why I'm asking you");
    expect(plain).not.toContain("Fix setup");
    const fixed = autoFixCardLines(flow, ask, { plain: true, fixSetup: { stage: "VERIFY" } }).join("\n");
    expect(fixed).toContain("Why I'm asking you: The test setup, not the code, kept the checks from giving a result (Blocked by environment).");
    expect(fixed).toContain("What to do: Open the Fix setup card for this project");
    const limit = autoFixCardLines(flow, { ...ask, reason: "spend-cap", capUsd: 15 }, { fixSetup: { stage: "VERIFY" } }).join("\n");
    expect(limit).not.toContain("Fix setup");
    expect(limit).toContain("per-task cap");
  });

  it("is chosen only while vx is on and the step is VERIFY or REVIEW", () => {
    expect(fixSetupWording({ stage: "VERIFY" }, ON)).toEqual({ fixSetup: { stage: "VERIFY" } });
    expect(fixSetupWording({ stage: "REVIEW" }, ON)).toEqual({ fixSetup: { stage: "REVIEW" } });
    expect(fixSetupWording({ stage: "PLAN" }, ON)).toEqual({});
    expect(fixSetupWording({ stage: "VERIFY" }, {})).toEqual({});
    expect(fixSetupWording({ stage: "VERIFY" }, { VERIFY_RESULTS_ENABLED: "true" })).toEqual({});
  });
});
