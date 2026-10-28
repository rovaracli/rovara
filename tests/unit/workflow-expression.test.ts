import { describe, expect, it } from "vitest";
import { CLOUD_REPOSITORY, PUBLIC_REPOSITORY, conditionFor, forRepository, timeoutFor } from "../support/workflow-expression.js";

describe("reading a workflow expression as one repository sees it", () => {
  it("returns text with no repository comparison exactly as written", () => {
    expect(forRepository("needs.scope.outputs.docs_only != 'true'", CLOUD_REPOSITORY)).toBe("needs.scope.outputs.docs_only != 'true'");
    expect(forRepository(15, PUBLIC_REPOSITORY)).toBe("15");
    expect(forRepository(undefined, PUBLIC_REPOSITORY)).toBeUndefined();
  });

  it("evaluates the time-limit idiom for each repository", () => {
    const limit = "${{ github.repository == 'PrepLabsAI/Rovara-cloud' && 60 || 25 }}";
    expect(timeoutFor(limit, CLOUD_REPOSITORY)).toBe(60);
    expect(timeoutFor(limit, PUBLIC_REPOSITORY)).toBe(25);
  });

  it("drops a guard that holds and turns a guard that fails into false", () => {
    const guarded = "github.repository == 'PrepLabsAI/Rovara' && (vars.AGENTX_PUBLISH_ENABLED == 'true')";
    expect(conditionFor(guarded, PUBLIC_REPOSITORY)).toBe("vars.AGENTX_PUBLISH_ENABLED == 'true'");
    expect(conditionFor(guarded, CLOUD_REPOSITORY)).toBe("false");
    expect(conditionFor("github.repository == 'PrepLabsAI/Rovara'", PUBLIC_REPOSITORY)).toBeUndefined();
    expect(conditionFor("github.repository == 'PrepLabsAI/Rovara' && (always())", PUBLIC_REPOSITORY)).toBe("always()");
  });

  it("keeps the other terms and the parentheses precedence needs", () => {
    const gate =
      "always() && github.event.pull_request.draft != true && ((github.repository != 'PrepLabsAI/Rovara-cloud' && github.event_name != 'push') || (github.repository == 'PrepLabsAI/Rovara-cloud' && (github.event_name != 'pull_request' || startsWith(github.base_ref, 'release/'))))";
    expect(conditionFor(gate, PUBLIC_REPOSITORY)).toBe("always() && github.event.pull_request.draft != true && github.event_name != 'push'");
    expect(conditionFor(gate, CLOUD_REPOSITORY)).toBe(
      "always() && github.event.pull_request.draft != true && (github.event_name != 'pull_request' || startsWith(github.base_ref, 'release/'))",
    );
  });

  it("refuses an expression it cannot read instead of guessing", () => {
    expect(() => forRepository("github.repository == 'a' &&", PUBLIC_REPOSITORY)).toThrow();
  });
});
