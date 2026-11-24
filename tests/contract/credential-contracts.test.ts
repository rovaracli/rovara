import { describe, expect, it } from "vitest";
import {
  IN_HOUSE_TOOL_COUNT, approvedToolCount, presentedNameProblems, toolBudget,
} from "../../packages/contracts/src/connectors-node.js";

describe("tool budget at registration", () => {
  it("counts in-house tools plus every approved connector tool", () => {
    const definition = { repositories: [], integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "a", access: "read" }, { name: "b", access: "write" }] }] } };
    expect(approvedToolCount(definition as never)).toBe(2);
    expect(approvedToolCount({ repositories: [], integrations: { githubMcp: { tools: [{ name: "a", access: "read" }] } } } as never)).toBe(1);
    expect(approvedToolCount({ repositories: [] } as never)).toBe(0);
  });

  it("warns above 20 visible tools and refuses above 40", () => {
    expect(toolBudget(20 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 20 });
    expect(toolBudget(21 - IN_HOUSE_TOOL_COUNT)).toEqual({ maximum: 21, warning: "the model could see 21 tools; above 20, tool choice gets less reliable. Approve fewer connector tools." });
    expect(toolBudget(41 - IN_HOUSE_TOOL_COUNT)).toMatchObject({ maximum: 41, refusal: "this project could expose 41 tools; at most 40 are allowed. Approve fewer connector tools." });
  });

  it("names every approval whose presented name exceeds 64 characters", () => {
    const long = "t".repeat(57);
    const definition = { repositories: [], integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: long, access: "read" }, { name: "short", access: "read" }] }] } };
    expect(presentedNameProblems(definition as never)).toEqual([`connector github tool ${long}: presented name github__${long} exceeds 64 characters`]);
  });

  it("names presented-name problems for the legacy githubMcp connector too", () => {
    const long = "t".repeat(57);
    const definition = { repositories: [], integrations: { githubMcp: { tools: [{ name: long, access: "read" }] } } };
    expect(presentedNameProblems(definition as never)).toEqual([`connector github tool ${long}: presented name github__${long} exceeds 64 characters`]);
  });
});
