// Page comments: the text rules, the planner's answers block, and comparing answers and ID sets by content.
import { describe, expect, it } from "vitest";
import { sameAnswers } from "@agentx/contracts";

describe("comparing by content", () => {

  it("sameAnswers compares answers by decision, not by position", () => {
    expect(sameAnswers([{ decisionId: "d1", optionId: "above" }, { decisionId: "d2", optionId: "no" }], [{ optionId: "no", decisionId: "d2" }, { optionId: "above", decisionId: "d1" }])).toBe(true);
    expect(sameAnswers([{ decisionId: "d1", optionId: "above" }], [{ decisionId: "d1", optionId: "below" }])).toBe(false);
    expect(sameAnswers([{ decisionId: "d1", optionId: "above" }], [])).toBe(false);
  });
});
