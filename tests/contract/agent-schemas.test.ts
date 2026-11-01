// Plan 3 Task 3a: agent ids, owners and access levels, the recipe and overlay schemas, model helpers,
// the new error codes, the org-scoped agent keys and the spend placeholder constants.
import { describe, expect, it } from "vitest";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  AgentIdSchema,
  AgentOwnerSchema,
  AgentPrincipalSchema,
  AutonomySchema,
  BUILTIN_AGENT_IDS,
  BaseRefSchema,
  ROVARA_CODE_AGENT_ID,
  atLeast,
  newPrefixedId,
} from "../../packages/contracts/src/agent-node.js";
import {
  AGENT_STEP_KINDS,
  ApprovalRulesSchema,
  CODING_STEP_KINDS,
  PiToolNameSchema,
  READ_ONLY_TOOLS,
  RecipeOverlaySchema,
  ResolvedRecipeSchema,
  STEP_TOOLS,
  StepIdSchema,
  StepSettingsSchema,
  StepSpecSchema,
  TRIGGER_KINDS_AT_LAUNCH,
  ToolGrantSchema,
  TriggerSpecSchema,
} from "../../packages/contracts/src/agent-recipe-node.js";
import { AgentXErrorCodeSchema, errorStatus } from "../../packages/contracts/src/errors.js";
import { PROJECT_PERMISSIONS, projectAllows } from "../../packages/contracts/src/app-projects.js";
import { canonicalModelName, modelCompany } from "../../packages/contracts/src/models-node.js";
import { ModelListSchema } from "../../packages/contracts/src/agent.js";
import { PlanCritiqueSchema } from "../../packages/contracts/src/rovara-code.js";
import { StageModelCandidateSchema } from "../../packages/contracts/src/stage-models.js";
import { OrgIdSchema, orgScoped } from "../../packages/contracts/src/org-node.js";
import {
  agentDirectoryKey,
  agentKey,
  agentNameKey,
  agentTasksKey,
  agentVersionSk,
  builtinSettingsKey,
  principalKey,
  principalSharesKey,
  projectAgentKey,
  skillDirectoryKey,
  skillKey,
  skillNameKey,
} from "../../packages/contracts/src/org-scoped-keys.js";
import * as spend from "../../packages/contracts/src/spend.js";
import * as contracts from "../../packages/contracts/src/index.js";

const ORG = OrgIdSchema.parse("org_0123456789abcdefghij");
const DEVELOPER = "a".repeat(64);

function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; code: string }> } }): string[] {
  return (result.error?.issues ?? []).map((issue) => issue.path.join("."));
}

describe("RecipeOverlaySchema", () => {
  it("refuses fields that would touch the safety layer, naming the field", () => {
    const system = RecipeOverlaySchema.safeParse({ systemPrompt: "x" });
    expect(system.success).toBe(false);
    expect(system.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["systemPrompt"] });

    const env = RecipeOverlaySchema.safeParse({ steps: { plan: { env: {} } } });
    expect(env.success).toBe(false);
    expect(env.error?.issues[0]?.path).toEqual(["steps", "plan"]);
    expect(env.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["env"] });

    const domains = RecipeOverlaySchema.safeParse({ allowedDomains: [] });
    expect(domains.success).toBe(false);
    expect(domains.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["allowedDomains"] });
  });

  it("accepts an empty overlay and a full one", () => {
    expect(RecipeOverlaySchema.parse({})).toEqual({});
    const full = {
      instructions: "Be brief.",
      sequence: [{ id: "build", kind: "build", name: "Build" }],
      steps: { build: { thinkingLevel: "high", tools: ["read", "edit"] } },
      tools: [{ connector: { type: "github" }, access: "read" }],
      approvals: { alwaysAsk: ["delete_*"] },
      triggers: [{ kind: "person" }],
      skills: { add: [{ skillId: `skl_${"a".repeat(20)}`, digest: "b".repeat(64) }], remove: [`skl_${"c".repeat(20)}`] },
      autonomy: "run",
      allowMentions: true,
    };
    expect(RecipeOverlaySchema.parse(full)).toEqual(full);
  });

  it("refuses a schedule trigger and an event trigger that have no spec (Plan 4 launches the three kinds, each with its own fields)", () => {
    expect(RecipeOverlaySchema.safeParse({ triggers: [{ kind: "schedule" }] }).success).toBe(false);
    expect(TriggerSpecSchema.safeParse({ kind: "schedule" }).success).toBe(false);
    expect(TriggerSpecSchema.safeParse({ kind: "event" }).success).toBe(false);
    expect(TriggerSpecSchema.parse({ kind: "person" })).toEqual({ kind: "person" });
    expect(TriggerSpecSchema.safeParse({ kind: "person", project: "web" }).success).toBe(false);
    expect([...TRIGGER_KINDS_AT_LAUNCH]).toEqual(["person", "event", "schedule"]);
  });

  it("refuses a non-boolean allowMentions", () => {
    const result = RecipeOverlaySchema.safeParse({ allowMentions: "yes" });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(["allowMentions"]);
  });

  it("bounds its lists", () => {
    const step = { id: "build", kind: "build", name: "Build" };
    expect(RecipeOverlaySchema.safeParse({ sequence: [] }).success).toBe(false);
    expect(RecipeOverlaySchema.safeParse({ sequence: Array.from({ length: 13 }, (_, index) => ({ ...step, id: `s${index}` })) }).success).toBe(false);
    expect(RecipeOverlaySchema.safeParse({ sequence: Array.from({ length: 12 }, (_, index) => ({ ...step, id: `s${index}` })) }).success).toBe(true);
    expect(RecipeOverlaySchema.safeParse({ triggers: [] }).success).toBe(false);
    expect(RecipeOverlaySchema.safeParse({ tools: Array.from({ length: 17 }, () => ({ connector: { type: "github" }, access: "read" })) }).success).toBe(false);
    expect(RecipeOverlaySchema.safeParse({ approvals: { alwaysAsk: Array.from({ length: 33 }, (_, index) => `t${index}`) } }).success).toBe(false);
    expect(RecipeOverlaySchema.safeParse({ steps: { "Not-An-Id": {} } }).success).toBe(false);
    expect(RecipeOverlaySchema.safeParse({ autonomy: "free" }).success).toBe(false);
  });

  it("accepts null to clear instructions", () => {
    expect(RecipeOverlaySchema.parse({ instructions: null })).toEqual({ instructions: null });
  });
});

describe("step schemas", () => {
  it("validates step ids", () => {
    expect(StepIdSchema.safeParse("plan").success).toBe(true);
    expect(StepIdSchema.safeParse("a".repeat(24)).success).toBe(true);
    expect(StepIdSchema.safeParse("a".repeat(25)).success).toBe(false);
    expect(StepIdSchema.safeParse("1plan").success).toBe(false);
    expect(StepIdSchema.safeParse("Plan").success).toBe(false);
    expect(StepIdSchema.safeParse("a-b").success).toBe(false);
  });

  it("exports the step kinds and tool tables", () => {
    expect([...CODING_STEP_KINDS]).toEqual(["plan", "plan_critic", "build", "check", "review", "pull_request"]);
    expect([...AGENT_STEP_KINDS]).toEqual(["agent", "approval"]);
    expect([...READ_ONLY_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
    expect(PiToolNameSchema.options).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(STEP_TOOLS.build).toEqual(PiToolNameSchema.options);
    expect(STEP_TOOLS.plan).toEqual(READ_ONLY_TOOLS);
    expect(STEP_TOOLS.review).toEqual(READ_ONLY_TOOLS);
    expect(STEP_TOOLS.agent).toEqual(READ_ONLY_TOOLS);
  });

  it("bounds step settings", () => {
    expect(StepSettingsSchema.parse({})).toEqual({});
    expect(StepSettingsSchema.parse({ model: null, fallbackModel: null, thinkingLevel: null, stepBudgetUsd: null, timeoutMinutes: null, differentCompanyFrom: null }))
      .toEqual({ model: null, fallbackModel: null, thinkingLevel: null, stepBudgetUsd: null, timeoutMinutes: null, differentCompanyFrom: null });
    expect(StepSettingsSchema.parse({ model: { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "high" } }).model).toBeDefined();
    expect(StepSettingsSchema.safeParse({ thinkingLevel: "xhigh" }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ stepBudgetUsd: 0.09 }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ stepBudgetUsd: 0.1 }).success).toBe(true);
    expect(StepSettingsSchema.safeParse({ stepBudgetUsd: 100.01 }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ timeoutMinutes: 4 }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ timeoutMinutes: 240 }).success).toBe(true);
    expect(StepSettingsSchema.safeParse({ timeoutMinutes: 241 }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ timeoutMinutes: 10.5 }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ tools: [] }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ tools: ["read", "read"] }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ tools: Array.from({ length: 41 }, (_, index) => `tool_${index}`) }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ tools: Array.from({ length: 40 }, (_, index) => `tool_${index}`) }).success).toBe(true);
    expect(StepSettingsSchema.safeParse({ differentCompanyFrom: "Bad Id" }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ env: {} }).success).toBe(false);
  });

  it("caps instructions at 8,192 UTF-8 bytes", () => {
    expect(StepSettingsSchema.safeParse({ instructions: "a".repeat(8192) }).success).toBe(true);
    expect(StepSettingsSchema.safeParse({ instructions: "a".repeat(8193) }).success).toBe(false);
    // 4,097 two-byte characters are 4,097 UTF-16 units but 8,194 bytes.
    expect(StepSettingsSchema.safeParse({ instructions: "é".repeat(4097) }).success).toBe(false);
    expect(StepSettingsSchema.safeParse({ instructions: "é".repeat(4096) }).success).toBe(true);
  });

  it("parses each step kind and refuses the wrong shape", () => {
    expect(StepSpecSchema.parse({ id: "plan", kind: "plan", name: "Plan" })).toEqual({ id: "plan", kind: "plan", name: "Plan" });
    expect(StepSpecSchema.parse({ id: "build", kind: "build", name: "Build", settings: { thinkingLevel: "low" } }).kind).toBe("build");
    expect(StepSpecSchema.parse({ id: "check", kind: "check", name: "Check", settings: { timeoutMinutes: 30 } }).kind).toBe("check");
    expect(StepSpecSchema.safeParse({ id: "check", kind: "check", name: "Check", settings: { thinkingLevel: "low" } }).success).toBe(false);
    expect(StepSpecSchema.parse({ id: "pr", kind: "pull_request", name: "Pull request" }).kind).toBe("pull_request");
    expect(StepSpecSchema.parse({ id: "ask", kind: "approval", name: "Ask", prompt: "Ship it?" }).kind).toBe("approval");
    expect(StepSpecSchema.safeParse({ id: "ask", kind: "approval", name: "Ask", prompt: "" }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ id: "ask", kind: "approval", name: "Ask", prompt: "x".repeat(301) }).success).toBe(false);
    expect(StepSpecSchema.parse({ id: "look", kind: "agent", name: "Look", workspace: "read", report: { slack: true } }).kind).toBe("agent");
    expect(StepSpecSchema.safeParse({ id: "look", kind: "agent", name: "Look", workspace: "write" }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ id: "look", kind: "agent", name: "Look" }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ id: "x", kind: "deploy", name: "Deploy" }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ id: "x", kind: "plan", name: "" }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ id: "x", kind: "plan", name: "n".repeat(41) }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ id: "x", kind: "plan", name: "Plan", extra: 1 }).success).toBe(false);
  });

  it("bounds review reviewers and findings loops", () => {
    const review = { id: "review", kind: "review", name: "Review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } };
    expect(StepSpecSchema.parse(review)).toEqual(review);
    expect(StepSpecSchema.safeParse({ ...review, reviewers: [] }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ ...review, reviewers: ["code", "code"] }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ ...review, reviewers: ["code", "security", "code"] }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ ...review, reviewers: ["style"] }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ ...review, onFindings: { backTo: "build", maxRounds: 0 } }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ ...review, onFindings: { backTo: "build", maxRounds: 6 } }).success).toBe(false);
    expect(StepSpecSchema.safeParse({ ...review, onFindings: { backTo: "Build", maxRounds: 1 } }).success).toBe(false);
  });
});

describe("tool grants and approval rules", () => {
  it("accepts a connector by type or by name", () => {
    expect(ToolGrantSchema.parse({ connector: { type: "github" }, access: "read_write", tools: ["get_*"] }).access).toBe("read_write");
    expect(ToolGrantSchema.parse({ connector: { name: "tracker" }, access: "read" }).connector).toEqual({ name: "tracker" });
    expect(ToolGrantSchema.safeParse({ connector: { type: "slack" }, access: "read" }).success).toBe(false);
    expect(ToolGrantSchema.safeParse({ connector: { type: "github", name: "x" }, access: "read" }).success).toBe(false);
    expect(ToolGrantSchema.safeParse({ connector: { type: "github" }, access: "write" }).success).toBe(false);
    expect(ToolGrantSchema.safeParse({ connector: { type: "github" }, access: "read", tools: ["a*b*c*d*e*"] }).success).toBe(false);
    expect(ToolGrantSchema.safeParse({ connector: { type: "github" }, access: "read", extra: 1 }).success).toBe(false);
  });

  it("refuses a tool grant with an empty tools list and accepts one with a tool", () => {
    expect(ToolGrantSchema.safeParse({ connector: { type: "github" }, access: "read", tools: [] }).success).toBe(false);
    expect(ToolGrantSchema.safeParse({ connector: { type: "github" }, access: "read", tools: ["list_issues"] }).success).toBe(true);
  });

  it("limits always-ask rules", () => {
    expect(ApprovalRulesSchema.parse({ alwaysAsk: ["delete_*"] })).toEqual({ alwaysAsk: ["delete_*"] });
    expect(ApprovalRulesSchema.safeParse({ alwaysAsk: Array.from({ length: 33 }, (_, index) => `t${index}`) }).success).toBe(false);
  });
});

describe("ResolvedRecipeSchema", () => {
  const resolved = {
    schemaVersion: 1,
    chain: [{ agentId: "rovara-code", name: "Rovara Code", version: 1, builtin: true }, { agentId: `agt_${"a".repeat(20)}`, name: "Mine", version: "draft", builtin: false }],
    instructions: [{ agentName: "Mine", text: "Be brief." }],
    steps: [{ id: "build", kind: "build", name: "Build", settings: { instructions: [{ agentName: "Mine", text: "Careful." }], thinkingLevel: "low" } }],
    tools: [],
    approvals: { alwaysAsk: [] },
    triggers: [{ kind: "person" }],
    skills: [],
    autonomy: "prepare",
    allowMentions: false,
  };

  it("parses a resolved recipe with instruction layers on steps", () => {
    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("refuses a second schema version, a string step instruction and more than 20 skills", () => {
    expect(ResolvedRecipeSchema.safeParse({ ...resolved, schemaVersion: 2 }).success).toBe(false);
    expect(ResolvedRecipeSchema.safeParse({ ...resolved, steps: [{ id: "build", kind: "build", name: "Build", settings: { instructions: "plain" } }] }).success).toBe(false);
    const skill = { skillId: `skl_${"a".repeat(20)}`, name: "s", description: "d", digest: "b".repeat(64) };
    expect(ResolvedRecipeSchema.safeParse({ ...resolved, skills: Array.from({ length: 21 }, () => skill) }).success).toBe(false);
    expect(ResolvedRecipeSchema.safeParse({ ...resolved, skills: Array.from({ length: 20 }, () => skill) }).success).toBe(true);
    expect(ResolvedRecipeSchema.safeParse({ ...resolved, allowMentions: undefined }).success).toBe(false);
  });
});

describe("project permissions for agents (Task 3b)", () => {
  it("grants the agent permissions to maintainers only", () => {
    for (const action of ["manage_agents", "approve_spend", "approve_writes", "view_spend"] as const) {
      expect(projectAllows("maintainer", action), action).toBe(true);
      expect(projectAllows("contributor", action), action).toBe(false);
      expect(projectAllows("viewer", action), action).toBe(false);
    }
    expect(PROJECT_PERMISSIONS.contributor).not.toContain("approve_writes");
  });
});

describe("ids, owners and access", () => {
  it("makes prefixed ids of 20 base36 characters", () => {
    for (const prefix of ["agt", "skl", "spr", "apr", "src", "con"] as const) {
      expect(newPrefixedId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9a-z]{20}$`));
    }
    expect(newPrefixedId("agt", () => new Uint8Array(32))).toBe(`agt_${"0".repeat(20)}`);
    expect(newPrefixedId("agt")).not.toBe(newPrefixedId("agt"));
    expect(() => newPrefixedId("agt", () => new Uint8Array(15))).toThrow(/16 random bytes/);
  });

  it("accepts built-in ids and generated ids as agent ids", () => {
    expect([...BUILTIN_AGENT_IDS]).toEqual(["rovara-code", "ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"]);
    expect(ROVARA_CODE_AGENT_ID).toBe("rovara-code");
    for (const id of BUILTIN_AGENT_IDS) expect(AgentIdSchema.safeParse(id).success).toBe(true);
    expect(AgentIdSchema.safeParse(`agt_${"z".repeat(20)}`).success).toBe(true);
    expect(AgentIdSchema.safeParse("agt_short").success).toBe(false);
    expect(AgentIdSchema.safeParse("unknown-agent").success).toBe(false);
    expect(AgentIdSchema.safeParse(`skl_${"a".repeat(20)}`).success).toBe(false);
  });

  it("has owner and principal variants", () => {
    expect(AgentOwnerSchema.parse({ kind: "member", developerId: DEVELOPER })).toEqual({ kind: "member", developerId: DEVELOPER });
    expect(AgentOwnerSchema.parse({ kind: "project", project: "web" })).toEqual({ kind: "project", project: "web" });
    expect(AgentOwnerSchema.safeParse({ kind: "org" }).success).toBe(false);
    expect(AgentOwnerSchema.safeParse({ kind: "member", developerId: "short" }).success).toBe(false);
    expect(AgentPrincipalSchema.parse({ kind: "org" })).toEqual({ kind: "org" });
    expect(AgentPrincipalSchema.parse({ kind: "project", project: "web" })).toEqual({ kind: "project", project: "web" });
    expect(AgentPrincipalSchema.safeParse({ kind: "team" }).success).toBe(false);
  });

  it("orders access levels", () => {
    expect(atLeast("manage", "edit")).toBe(true);
    expect(atLeast("use", "use")).toBe(true);
    expect(atLeast("view", "use")).toBe(false);
    expect(atLeast("none", "view")).toBe(false);
    expect(atLeast("none", "none")).toBe(true);
    expect(atLeast("edit", "manage")).toBe(false);
  });

  it("defines autonomy, base refs and limits", () => {
    expect(AutonomySchema.options).toEqual(["suggest", "prepare", "run"]);
    expect(BaseRefSchema.parse({ agentId: "ticket-triage", version: 2 })).toEqual({ agentId: "ticket-triage", version: 2 });
    expect(BaseRefSchema.safeParse({ agentId: "ticket-triage", version: 0 }).success).toBe(false);
    expect(BaseRefSchema.safeParse({ agentId: "ticket-triage", version: 1.5 }).success).toBe(false);
    expect(AGENT_NAME_MAX).toBe(60);
    expect(AGENT_DESCRIPTION_MAX).toBe(500);
  });
});

describe("model helpers", () => {
  it("canonicalizes model names across routes", () => {
    expect(canonicalModelName({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" })).toBe("claude-haiku-4-5");
    expect(canonicalModelName({ provider: "anthropic", modelId: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
    expect(canonicalModelName({ provider: "openrouter", modelId: "anthropic/claude-haiku-4-5" })).toBe("claude-haiku-4-5");
    expect(canonicalModelName({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" })).toBe("claude-sonnet-4-6");
    expect(canonicalModelName({ provider: "amazon-bedrock", modelId: "global.anthropic.claude-sonnet-4-6" })).toBe("claude-sonnet-4-6");
    expect(canonicalModelName({ provider: "amazon-bedrock", modelId: "eu.anthropic.claude-opus-4-5-v1:0" })).toBe("claude-opus-4-5");
    expect(canonicalModelName({ provider: "anthropic", modelId: "Claude-Sonnet-4.6-20251001" })).toBe("claude-sonnet-4-6");
    expect(canonicalModelName({ provider: "openai", modelId: "gpt-5.4" })).toBe("gpt-5-4");
  });

  it("names the company behind a model", () => {
    expect(modelCompany({ provider: "anthropic", modelId: "claude-haiku-4-5" })).toBe("anthropic");
    expect(modelCompany({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" })).toBe("anthropic");
    expect(modelCompany({ provider: "amazon-bedrock", modelId: "anthropic.claude-3-haiku" })).toBe("anthropic");
    expect(modelCompany({ provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" })).toBe("amazon");
    expect(modelCompany({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" })).toBe("anthropic");
    expect(modelCompany({ provider: "openrouter", modelId: "openai/gpt-5.4" })).toBe("openai");
    expect(modelCompany({ provider: "openrouter", modelId: "google/gemini-3-pro" })).toBe("google");
    expect(modelCompany({ provider: "openrouter", modelId: "z-ai/glm-5.3" })).toBe("other");
    expect(modelCompany({ provider: "openai", modelId: "anything" })).toBe("openai");
    expect(modelCompany({ provider: "custom", modelId: "gpt-5" })).toBe("openai");
    expect(modelCompany({ provider: "custom", modelId: "gemini-3-flash" })).toBe("google");
    expect(modelCompany({ provider: "custom", modelId: "llama-4" })).toBe("other");
  });
});

describe("the company behind a Bedrock model (SH33)", () => {
  const bedrock = (modelId: string) => modelCompany({ provider: "amazon-bedrock", modelId });

  it("names each Bedrock family, bare and with every region prefix the catalog uses", () => {
    const families: Array<[string, string]> = [
      ["amazon.nova-pro-v1:0", "amazon"], ["amazon.nova-2-lite-v1:0", "amazon"], ["meta.llama3-3-70b-instruct-v1:0", "meta"], ["mistral.mistral-large-2407-v1:0", "mistral"],
      ["deepseek.r1-v1:0", "deepseek"], ["openai.gpt-oss-120b-1:0", "openai"], ["qwen.qwen3-32b-v1:0", "qwen"], ["cohere.command-r-plus-v1:0", "cohere"], ["anthropic.claude-3-haiku", "anthropic"],
    ];
    for (const [id, company] of families) {
      expect(bedrock(id)).toBe(company);
      for (const region of ["us", "eu", "apac", "global", "au", "jp", "in", "ca", "us-gov"]) expect(bedrock(`${region}.${id}`)).toBe(company);
      expect(bedrock(id.toUpperCase())).toBe(company);
    }
  });

  it("makes Nova a different company from Claude, and Nova from another family", () => {
    const nova = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" };
    const claude = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
    expect(modelCompany(nova)).not.toBe(modelCompany(claude));
    expect(modelCompany(nova)).not.toBe(bedrock("meta.llama3-3-70b-instruct-v1:0"));
    // The same family over two regions is one company.
    expect(bedrock("eu.amazon.nova-pro-v1:0")).toBe(modelCompany(nova));
  });

  it("keeps everything it does not recognise as other, and claims nothing from a lookalike", () => {
    for (const id of ["ai21.jamba-1-5-large-v1:0", "writer.palmyra-x4-v1:0", "stability.sd3-large-v1:0", "xx.amazon.nova-pro-v1:0", "us.us.amazon.nova-pro-v1:0", "amazonx.nova", "nova-pro", "meta", "meta.", "mistralai.large", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0", ""].filter((value) => value !== "")) {
      expect(bedrock(id)).toBe("other");
    }
    // Only the Bedrock route is read this way: other routes keep their rules.
    expect(modelCompany({ provider: "custom", modelId: "amazon.nova-pro-v1:0" })).toBe("other");
    expect(modelCompany({ provider: "openrouter", modelId: "meta-llama/llama-3.3-70b" })).toBe("other");
    expect(modelCompany({ provider: "mistral", modelId: "large" })).toBe("other");
  });

  it("carries the new companies through every schema that names one, and still reads a stored 'other'", () => {
    for (const company of ["amazon", "meta", "mistral", "deepseek", "qwen", "cohere", "other"]) {
      expect(ModelListSchema.safeParse({ models: [{ provider: "amazon-bedrock", modelId: "x", label: "X", company, sources: [] }] }).success).toBe(true);
    }
    expect(ModelListSchema.safeParse({ models: [{ provider: "amazon-bedrock", modelId: "x", label: "X", company: "unknown", sources: [] }] }).success).toBe(false);
    for (const company of ["amazon", "meta", "mistral", "deepseek", "qwen", "cohere", "other"]) {
      expect(StageModelCandidateSchema.safeParse({ model: { provider: "amazon-bedrock", modelId: "x" }, label: "X", provider: "amazon-bedrock", company, status: "verified" }).success).toBe(true);
      expect(PlanCritiqueSchema.safeParse({ verdict: "ok", points: [], model: { provider: "amazon-bedrock", modelId: "x", company } }).success).toBe(true);
    }
    // A stored critique with a company this build does not know reads as "other" (a rollback must not strand a task).
    expect(PlanCritiqueSchema.parse({ verdict: "ok", points: [], model: { provider: "amazon-bedrock", modelId: "x", company: "made-up" } }).model.company).toBe("other");
  });
});

describe("error codes", () => {
  it("adds the agent codes with their statuses", () => {
    const expected: Record<string, number> = {
      AGENT_REVISION_CONFLICT: 409,
      AGENT_UNAVAILABLE: 409,
      AGENT_NOT_ON_PROJECT: 403,
      AGENT_TOOL_NOT_GRANTED: 403,
      MODEL_NOT_ALLOWED: 403,
      PROJECT_BUDGET_EXCEEDED: 402,
      AGENT_BUDGET_EXCEEDED: 402,
      AGENT_BUDGET_REQUIRED: 409,
      TEST_ALLOWANCE_USED: 402,
      APPROVAL_CLOSED: 409,
    };
    for (const [code, status] of Object.entries(expected)) {
      expect(AgentXErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(errorStatus(AgentXErrorCodeSchema.parse(code))).toBe(status);
    }
    expect(errorStatus("TEST_ALLOWANCE_USED")).toBe(402);
  });
});

describe("agent keys", () => {
  it("scopes every key to the org", () => {
    const keys = [
      agentKey(ORG, "rovara-code", "META"),
      agentDirectoryKey(ORG, "rovara-code"),
      agentNameKey(ORG, "Mine"),
      principalSharesKey(ORG, { kind: "org" }, "rovara-code"),
      projectAgentKey(ORG, "web", "rovara-code"),
      skillKey(ORG, `skl_${"a".repeat(20)}`, "META"),
      skillDirectoryKey(ORG, `skl_${"a".repeat(20)}`),
      skillNameKey(ORG, "Triage-Notes"),
      agentTasksKey(ORG, "rovara-code", "2026-10-20T10:00:00.000Z", "task-1"),
      builtinSettingsKey(ORG, "ticket-triage"),
    ];
    for (const key of keys) expect(key.pk.startsWith(`ORG#${ORG}#`)).toBe(true);
    expect(new Set(keys.map((key) => `${key.pk}|${key.sk}`)).size).toBe(keys.length);
  });

  it("keys a skill's directory entry by id and its name item by the name, which is already lower case", () => {
    const id = `skl_${"a".repeat(20)}`;
    expect(skillDirectoryKey(ORG, id)).toEqual({ pk: orgScoped(ORG, "SKILL_DIRECTORY"), sk: id });
    expect(skillNameKey(ORG, "triage-notes")).toEqual({ pk: orgScoped(ORG, "SKILL_NAME"), sk: "triage-notes" });
  });

  it("builds agent items under one partition", () => {
    const id = `agt_${"a".repeat(20)}`;
    expect(agentKey(ORG, id, "META")).toEqual({ pk: orgScoped(ORG, `AGENT#${id}`), sk: "META" });
    expect(agentKey(ORG, id, "DRAFT").pk).toBe(agentKey(ORG, id, "META").pk);
    expect(agentKey(ORG, id, agentVersionSk(3))).toEqual({ pk: orgScoped(ORG, `AGENT#${id}`), sk: "VERSION#000003" });
    expect(agentKey(ORG, id, "SHARE#ORG").sk).toBe("SHARE#ORG");
    expect(agentKey(ORG, id, "EVENT#2026-10-20T10:00:00.000Z#1").sk).toBe("EVENT#2026-10-20T10:00:00.000Z#1");
    expect(agentKey(otherOrg(), id, "META").pk).not.toBe(agentKey(ORG, id, "META").pk);
  });

  it("pads version sort keys so they list in order", () => {
    expect(agentVersionSk(1)).toBe("VERSION#000001");
    expect(agentVersionSk(999999)).toBe("VERSION#999999");
    expect([agentVersionSk(10), agentVersionSk(9), agentVersionSk(100)].sort()).toEqual([agentVersionSk(9), agentVersionSk(10), agentVersionSk(100)]);
    expect(() => agentVersionSk(0)).toThrow();
    expect(() => agentVersionSk(1_000_000)).toThrow();
    expect(() => agentVersionSk(1.5)).toThrow();
  });

  it("makes agent names unique ignoring case and surrounding spaces", () => {
    expect(agentNameKey(ORG, "  Ticket Triage ")).toEqual(agentNameKey(ORG, "ticket triage"));
    expect(agentNameKey(ORG, "a")).not.toEqual(agentNameKey(otherOrg(), "a"));
  });

  it("names principals", () => {
    expect(principalKey({ kind: "member", developerId: DEVELOPER })).toBe(`MEMBER#${DEVELOPER}`);
    expect(principalKey({ kind: "project", project: "web" })).toBe("PROJECT#web");
    expect(principalKey({ kind: "org" })).toBe("ORG");
    expect(principalSharesKey(ORG, { kind: "project", project: "web" }, "x").pk).not.toBe(principalSharesKey(ORG, { kind: "org" }, "x").pk);
  });

  it("sorts an agent's tasks by creation time", () => {
    const early = agentTasksKey(ORG, "rovara-code", "2026-10-20T09:00:00.000Z", "b");
    const late = agentTasksKey(ORG, "rovara-code", "2026-10-20T10:00:00.000Z", "a");
    expect(early.pk).toBe(late.pk);
    expect(early.sk < late.sk).toBe(true);
  });

  it("is exported from the package index", () => {
    expect(contracts.agentKey).toBe(agentKey);
    expect(contracts.RecipeOverlaySchema).toBe(RecipeOverlaySchema);
    expect(contracts.canonicalModelName).toBe(canonicalModelName);
    expect(contracts.RUN_LIMIT_MULTIPLIER).toBe(spend.RUN_LIMIT_MULTIPLIER);
  });
});

function otherOrg() {
  return OrgIdSchema.parse("org_zyxwvutsrqponmlkjihg");
}

describe("spend placeholder constants", () => {
  it("has the exact names and values", () => {
    expect(spend.RUN_LIMIT_MULTIPLIER).toBe(2);
    expect(spend.LEAD_APPROVAL_THRESHOLD_USD).toBe(10);
    expect(spend.ADMIN_APPROVAL_THRESHOLD_USD).toBe(100);
    expect(spend.BUDGET_WARNING_RATIO).toBe(0.8);
    expect(spend.MAX_RUN_LIMIT_USD).toBe(1000);
    expect(spend.DEFAULT_RUN_ESTIMATE_USD).toEqual({
      QUICK: { lowUsd: 1, highUsd: 3 },
      FULL: { lowUsd: 4, highUsd: 10 },
      TASK: { lowUsd: 2, highUsd: 5 },
      AGENT: { lowUsd: 0.5, highUsd: 2 },
    });
    expect(spend.DEFAULT_PLANNING_LIMIT_USD).toEqual({ QUICK: 2, FULL: 6 });
    expect(spend.TESTING_ALLOWANCE_USD).toBe(10);
    expect(spend.PER_TEST_CAP_USD).toBe(2);
    expect(spend.DEFAULT_MAX_AGENT_MONTHLY_USD).toBe(50);
    expect(spend.DEFAULT_MAX_PER_RUN_CEILING_USD).toBe(100);
    expect(spend.DEFAULT_OWNER_AGENT_BUDGET_CAP_USD).toBe(100);
    expect(spend.ESTIMATE_HISTORY_SIZE).toBe(20);
    expect(spend.ESTIMATE_MIN_SAMPLES).toBe(5);
    expect(spend.SPEND_REQUEST_TTL_DAYS).toBe(7);
    expect(spend.WRITE_APPROVAL_TTL_DAYS).toBe(7);
    expect(spend.OWNER_ANSWER_HOURS).toBe(24);
    expect(spend.MAX_PENDING_APPROVALS_PER_STEP).toBe(10);
    expect(spend.DEFAULT_MAX_AUTONOMY).toBe("prepare");
    expect(spend.APPROVAL_EXECUTING_RETRY_MINUTES).toBe(5);
  });
});
