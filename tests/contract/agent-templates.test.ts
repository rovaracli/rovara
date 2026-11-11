// Plan 3 Task 5: the built-in agents are versioned code. A published version never changes; a change is a new version.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_IDS, type BuiltinAgentId } from "@rovara-code/contracts";
import { AgentConnectorTypeSchema, ResolvedRecipeSchema, formatRecipeProblem, recipeDigest, recipeProblems, recipeRunner, type ResolvedRecipe } from "@rovara-code/contracts";
import { BUILTIN_AGENTS, builtinRecipe, currentBuiltinVersion } from "@rovara-code/contracts";

const DIGESTS = JSON.parse(readFileSync(new URL("../fixtures/builtin-agent-digests.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;

const allVersions = BUILTIN_AGENT_IDS.flatMap((id) => BUILTIN_AGENTS[id].versions.map((entry) => ({ id, entry })));

function recipeOf(id: BuiltinAgentId, version = 1): ResolvedRecipe {
  return builtinRecipe(id, version);
}

function agentSteps(recipe: ResolvedRecipe) {
  return recipe.steps.map((step) => ({ id: step.id, kind: step.kind, ...(step.kind === "agent" ? { workspace: step.workspace, report: step.report } : {}) }));
}

function instructionTexts(recipe: ResolvedRecipe): string[] {
  return [...recipe.instructions.map((layer) => layer.text), ...recipe.steps.flatMap((step) => step.settings.instructions.map((layer) => layer.text))];
}

const TRACKERS = ["linear", "jira", "asana"] as const;

describe("built-in agents", () => {
  it("has an entry for every built-in id, with versions numbered from 1 and the latest as current", () => {
    expect(Object.keys(BUILTIN_AGENTS).sort()).toEqual([...BUILTIN_AGENT_IDS].sort());
    for (const id of BUILTIN_AGENT_IDS) {
      const agent = BUILTIN_AGENTS[id];
      expect(agent.name.length, id).toBeGreaterThan(0);
      expect(agent.description.length, id).toBeGreaterThan(0);
      expect(agent.versions.map((entry) => entry.version), id).toEqual(agent.versions.map((_, index) => index + 1));
      expect(currentBuiltinVersion(id), id).toBe(agent.versions.length);
      // Plan 4 Task 27 added version 2 of the five templates (templates-full.test.ts); Plan 6 Task 2 added Rovara Code's version 2 (rovara-code-v2.test.ts).
      expect(currentBuiltinVersion(id), id).toBe(2);
    }
  });

  it.each(allVersions)("$id version $entry.version is a valid recipe with only a person trigger", ({ id, entry }) => {
    const recipe = entry.recipe;
    expect(recipeProblems(recipe).map(formatRecipeProblem), `${id} v${entry.version}`).toEqual([]);
    expect(ResolvedRecipeSchema.safeParse(structuredClone(recipe)).success, `${id} v${entry.version} parses strictly`).toBe(true);
    expect(ResolvedRecipeSchema.safeParse({ ...structuredClone(recipe), extra: 1 }).success, `${id} v${entry.version} refuses extra fields`).toBe(false);
    for (const grant of recipe.tools) {
      const type = "type" in grant.connector ? grant.connector.type : undefined;
      expect(AgentConnectorTypeSchema.safeParse(type).success, `${id} grants ${JSON.stringify(grant.connector)}`).toBe(true);
    }
    expect(recipe.triggers, id).toEqual([{ kind: "person" }]);
    expect(recipe.allowMentions, id).toBe(false);
    expect(recipe.chain, id).toEqual([{ agentId: id, name: BUILTIN_AGENTS[id].name, version: entry.version, builtin: true }]);
    expect(builtinRecipe(id, entry.version), id).toEqual(recipe);
    expect(entry.digest, id).toBe(recipeDigest(builtinRecipe(id, entry.version)));
    expect(Object.isFrozen(recipe) && Object.isFrozen(recipe.steps) && Object.isFrozen(recipe.tools), `${id} recipe is frozen`).toBe(true);
    expect(() => { recipe.tools.push({ connector: { type: "mcp" }, access: "read" }); }, id).toThrow(TypeError);
    expect(entry.releasedIn.length, id).toBeGreaterThan(0);
    expect(entry.notes.length, id).toBeGreaterThan(0);
  });

  it("returns a copy, so a caller changing the recipe cannot change the built-in", () => {
    const first = builtinRecipe("ticket-triage", 1);
    first.tools.length = 0;
    first.steps.length = 0;
    expect(builtinRecipe("ticket-triage", 1).tools.length).toBeGreaterThan(0);
    expect(recipeDigest(builtinRecipe("ticket-triage", 1))).toBe(BUILTIN_AGENTS["ticket-triage"].versions[0]?.digest);
  });

  it("answers NOT_FOUND for a version that does not exist", () => {
    for (const version of [0, 3, -1, 1.5]) {
      expect(() => builtinRecipe("rovara-code", version), String(version)).toThrow(/^NOT_FOUND: /);
    }
    expect(() => builtinRecipe("nope" as BuiltinAgentId, 1)).toThrow(/^NOT_FOUND: /);
  });
});

describe("versions are immutable", () => {
  it("keeps one recorded digest per (id, version) and nothing else", () => {
    const recorded = Object.entries(DIGESTS).flatMap(([id, versions]) => Object.keys(versions).map((version) => `${id}@${version}`)).sort();
    const shipped = allVersions.map(({ id, entry }) => `${id}@${entry.version}`).sort();
    expect(recorded).toEqual(shipped);
  });

  it.each(allVersions)("$id version $entry.version still has the recorded digest", ({ id, entry }) => {
    const recorded = DIGESTS[id]?.[String(entry.version)];
    expect(
      recipeDigest(entry.recipe),
      `${id} version ${entry.version} changed after it was released; leave it as it was and add version ${entry.version + 1} with the change (recorded ${recorded ?? "none"})`,
    ).toBe(recorded);
  });
});

describe("Rovara Code", () => {
  it("version 1 is plan, build, check, review and pull request with no settings", () => {
    const recipe = recipeOf("rovara-code");
    expect(recipe.steps).toEqual([
      { id: "plan", name: "Plan", kind: "plan", settings: { instructions: [] } },
      { id: "build", name: "Build", kind: "build", settings: { instructions: [] } },
      { id: "check", name: "Check", kind: "check", settings: { instructions: [] } },
      { id: "review", name: "Review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 }, settings: { instructions: [] } },
      { id: "pull_request", name: "Pull request", kind: "pull_request", settings: { instructions: [] } },
    ]);
    expect(recipe.instructions).toEqual([]);
    expect(recipe.tools).toEqual([]);
    expect(recipe.approvals).toEqual({ alwaysAsk: [] });
    expect(recipe.skills).toEqual([]);
  });

  it("is the only built-in that runs as a coding recipe", () => {
    for (const { id, entry } of allVersions) {
      expect(recipeRunner(entry.recipe), id).toBe(id === "rovara-code" ? "coding" : "agent_steps");
    }
  });
});

describe("the five templates, version 1", () => {
  const tools = (id: BuiltinAgentId) => recipeOf(id).tools;
  const trackers = (access: "read" | "read_write") => TRACKERS.map((type) => ({ connector: { type }, access }));

  it("Ticket triage", () => {
    expect(BUILTIN_AGENTS["ticket-triage"].name).toBe("Ticket triage");
    expect(BUILTIN_AGENTS["ticket-triage"].needsLaterConnectors).toBeUndefined();
    expect(agentSteps(recipeOf("ticket-triage"))).toEqual([{ id: "triage", kind: "agent", workspace: "none", report: { slack: true } }]);
    expect(tools("ticket-triage")).toEqual([
      ...trackers("read_write"),
      { connector: { type: "github" }, access: "read_write", tools: ["get_issue", "list_issues", "search_issues", "add_issue_comment", "update_issue"] },
    ]);
  });

  it("Root-cause analyst", () => {
    expect(BUILTIN_AGENTS["root-cause-analyst"].name).toBe("Root-cause analyst");
    // Plan 4 Task 27: the connectors exist, so no template carries the later-connector note (version 1's grants are unchanged below).
    expect(BUILTIN_AGENTS["root-cause-analyst"].needsLaterConnectors).toBeUndefined();
    expect(agentSteps(recipeOf("root-cause-analyst"))).toEqual([
      { id: "investigate", kind: "agent", workspace: "read", report: undefined },
      { id: "report", kind: "agent", workspace: "none", report: { slack: true } },
    ]);
    expect(tools("root-cause-analyst")).toEqual([...trackers("read"), { connector: { type: "github" }, access: "read" }, { connector: { type: "mcp" }, access: "read" }]);
  });

  it("Code reviewer", () => {
    expect(BUILTIN_AGENTS["code-reviewer"].name).toBe("Code reviewer");
    expect(BUILTIN_AGENTS["code-reviewer"].needsLaterConnectors).toBeUndefined();
    expect(agentSteps(recipeOf("code-reviewer"))).toEqual([{ id: "review", kind: "agent", workspace: "read", report: { slack: true } }]);
    expect(tools("code-reviewer")).toEqual([
      { connector: { type: "github" }, access: "read_write", tools: ["pull_request_read", "get_pull_request*", "list_pull_requests", "add_issue_comment", "pull_request_review_write"] },
    ]);
  });

  it("Deploy reviewer", () => {
    expect(BUILTIN_AGENTS["deploy-reviewer"].name).toBe("Deploy reviewer");
    expect(BUILTIN_AGENTS["deploy-reviewer"].needsLaterConnectors).toBeUndefined();
    expect(agentSteps(recipeOf("deploy-reviewer"))).toEqual([
      { id: "inspect", kind: "agent", workspace: "read", report: undefined },
      { id: "report", kind: "agent", workspace: "none", report: { slack: true } },
    ]);
    expect(tools("deploy-reviewer")).toEqual([
      { connector: { type: "github" }, access: "read_write", tools: ["pull_request_read", "get_pull_request*", "list_commits", "get_commit", "add_issue_comment"] },
      { connector: { type: "mcp" }, access: "read" },
    ]);
  });

  it("Service reviewer", () => {
    expect(BUILTIN_AGENTS["service-reviewer"].name).toBe("Service reviewer");
    expect(BUILTIN_AGENTS["service-reviewer"].needsLaterConnectors).toBeUndefined();
    expect(agentSteps(recipeOf("service-reviewer"))).toEqual([
      { id: "gather", kind: "agent", workspace: "none", report: undefined },
      { id: "report", kind: "agent", workspace: "none", report: { slack: true } },
    ]);
    expect(tools("service-reviewer")).toEqual([...trackers("read_write"), { connector: { type: "github" }, access: "read" }, { connector: { type: "mcp" }, access: "read" }]);
  });

  it("no built-in carries a later-connector note any more, and Rovara Code never had one", () => {
    expect(BUILTIN_AGENT_IDS.filter((id) => BUILTIN_AGENTS[id].needsLaterConnectors !== undefined)).toEqual([]);
  });

  it("each template's final step reports to Slack and no earlier step does", () => {
    for (const id of ["ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"] as const) {
      const steps = recipeOf(id).steps;
      steps.forEach((step, index) => {
        const reports = step.kind === "agent" && step.report?.slack === true;
        expect(reports, `${id} ${step.id}`).toBe(index === steps.length - 1);
      });
    }
  });
});

describe("template instructions", () => {
  const templates = ["ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"] as const;

  it.each(templates)("%s has instructions that are plain text without override phrases or links", (id) => {
    const texts = instructionTexts(recipeOf(id));
    expect(texts.length, id).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.trim().length, id).toBeGreaterThan(0);
      expect(text, id).not.toMatch(/ignore/i);
      expect(text, id).not.toMatch(/system prompt/i);
      expect(text, id).not.toMatch(/https?:|www\.|:\/\//i);
      expect(text, id).not.toMatch(/—/);
    }
  });

  it("every template step carries instructions of its own", () => {
    for (const id of templates) {
      for (const step of recipeOf(id).steps) expect(step.settings.instructions.length, `${id} ${step.id}`).toBeGreaterThan(0);
    }
  });

  it("triage, reviewers and the service reviewer say which writes are expected and that anything else waits for a person", () => {
    for (const id of ["ticket-triage", "code-reviewer", "deploy-reviewer", "service-reviewer"] as const) {
      const text = instructionTexts(recipeOf(id)).join("\n");
      expect(text, id).toMatch(/comment/i);
      expect(text, id).toMatch(/waits? for a person/i);
    }
    const triage = instructionTexts(recipeOf("ticket-triage")).join("\n");
    expect(triage).toMatch(/label/i);
    expect(triage).toMatch(/`rovara`/);
    expect(instructionTexts(recipeOf("service-reviewer")).join("\n")).toMatch(/new tickets? labelled `rovara`/);
    const serviceText = instructionTexts(recipeOf("service-reviewer")).join("\n");
    expect(serviceText).toMatch(/comments on tickets in the tracker/);
    expect(serviceText).not.toMatch(/comments on tickets and issues/);
    expect(serviceText).toMatch(/never write to GitHub/);
    const reviewText = instructionTexts(recipeOf("code-reviewer")).join("\n");
    expect(reviewText).toMatch(/request for changes/);
    expect(reviewText).toMatch(/Never approve a pull request and never merge it\./);
  });
});
