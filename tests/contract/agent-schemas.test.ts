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
import { AgentXErrorCodeSchema, errorStatus } from "../../packages/contracts/src/errors.js";
import { PROJECT_PERMISSIONS, projectAllows } from "../../packages/contracts/src/app-projects.js";
import { canonicalModelName, modelCompany } from "../../packages/contracts/src/models-node.js";
import { ModelListSchema } from "../../packages/contracts/src/agent.js";
import { PlanCritiqueSchema } from "../../packages/contracts/src/rovara-code.js";
import { StageModelCandidateSchema } from "../../packages/contracts/src/stage-models.js";
import * as spend from "../../packages/contracts/src/spend.js";
const DEVELOPER = "a".repeat(64);

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

  it("accepts the outside-account link codes Code sends, with their statuses", () => {
    const expected: Record<string, number> = {
      LINK_START_AGAIN: 403,
      EXTERNAL_ACCOUNT_TAKEN: 409,
      EXTERNAL_ACCOUNT_OTHER_WORKSPACE: 409,
      EXTERNAL_ACCOUNT_LINK_EXISTS: 409,
    };
    for (const [code, status] of Object.entries(expected)) {
      expect(AgentXErrorCodeSchema.safeParse(code).success, code).toBe(true);
      expect(errorStatus(AgentXErrorCodeSchema.parse(code)), code).toBe(status);
    }
  });
});

describe("task action refusal codes", () => {
  it("accepts the four task action codes Code f484578d8 sends, with Code's statuses (a refusal that reaches Cloud must parse)", () => {
    const expected: Record<string, number> = {
      TASK_ACTION_NOT_OFFERED: 409,
      TASK_ACTION_STALE: 409,
      TASK_ACTION_NEEDS_INPUT: 400,
      TASK_ACTION_NEEDS_WEB: 403,
    };
    for (const [code, status] of Object.entries(expected)) {
      expect(AgentXErrorCodeSchema.safeParse(code).success, code).toBe(true);
      expect(errorStatus(AgentXErrorCodeSchema.parse(code)), code).toBe(status);
    }
  });
});

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
