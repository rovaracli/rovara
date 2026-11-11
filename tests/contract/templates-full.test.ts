// Plan 4 Task 27: the full versions of the five templates. Version 2 of each is built on the connectors, gates and triggers of Tasks 1 to 26 and on nothing else: every grant names a
// connector type agents can use and tools that exist in that connector's catalog, the only write grants are the ones the plan names, no template can roll back, merge or close anything,
// every suggested trigger is a record in waiting that parses with the schemas a person's trigger does, and the Deploy reviewer's comments go through Plan 3's real write gate. Version 1 of each
// template is untouched (agent-templates.test.ts holds its digest), and an organisation that pinned it keeps it.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENT_IDS, type BuiltinAgentId } from "@rovara-code/contracts";
import { AgentConnectorTypeSchema, ResolvedRecipeSchema, TriggerSpecSchema } from "@rovara-code/contracts";
import { formatRecipeProblem, recipeDigest, recipeProblems, recipeRunner, type ResolvedRecipe, type ToolGrant } from "@rovara-code/contracts";
import { BUILTIN_AGENTS, builtinRecipe, currentBuiltinVersion } from "@rovara-code/contracts";
import { BUILTIN_TRIGGER_SUGGESTIONS } from "@rovara-code/contracts";
import type { ConnectorCatalog, PresentedTool } from "@rovara-code/contracts";
import { builtinSettingsKey } from "@rovara-code/contracts";
import { EVENT_TYPES, EventTriggerSpecSchema, ScheduleTriggerSpecSchema, eventFilterKeys } from "@rovara-code/contracts";
import { toolPatternMatches } from "@rovara-code/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { GITHUB_AGENT_TOOL_PERMISSIONS } from "../../packages/broker/src/agents/github-agent-tools.js";
import { resolveToolGrants, type GrantConnector } from "../../packages/broker/src/agents/tool-grants.js";
import { classifyWrite, prepareAgentWrite } from "../../packages/broker/src/agents/write-class.js";
import { CLOUDWATCH_TOOL_NAMES } from "../../packages/broker/src/connectors/native/cloudwatch.js";
import { DATADOG_TOOL_NAMES } from "../../packages/broker/src/connectors/native/datadog.js";
import { GITHUB_ACTIONS_TOOL_NAMES } from "../../packages/broker/src/connectors/native/github-actions.js";
import { GRAFANA_TOOL_NAMES } from "../../packages/broker/src/connectors/native/grafana.js";
import { PAGERDUTY_TOOL_NAMES } from "../../packages/broker/src/connectors/native/pagerduty.js";
import { SENTRY_TOOL_NAMES } from "../../packages/broker/src/connectors/native/sentry.js";
import { VERCEL_TOOL_NAMES } from "../../packages/broker/src/connectors/native/vercel.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { MAX, ORG_A, disposeGateWorlds, setupTriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const FIVE = ["ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"] as const satisfies readonly BuiltinAgentId[];
const fixtureNames = (file: string): string[] => (JSON.parse(readFileSync(new URL(`../fixtures/vendors/${file}`, import.meta.url), "utf8")) as Array<{ name: string }>).map((tool) => tool.name);

/** The tools each connector type offers an agent, as the code of Tasks 12 to 17 and Plan 3 define them (the vendors' own catalogs where a fixture holds one). */
const CATALOGS: Record<string, readonly string[]> = {
  github: Object.keys(GITHUB_AGENT_TOOL_PERMISSIONS),
  linear: fixtureNames("linear-tools.json"),
  jira: fixtureNames("jira-tools.json"),
  asana: fixtureNames("asana-tools.json"),
  sentry: SENTRY_TOOL_NAMES,
  datadog: DATADOG_TOOL_NAMES,
  cloudwatch: CLOUDWATCH_TOOL_NAMES,
  "github-actions": GITHUB_ACTIONS_TOOL_NAMES,
  grafana: GRAFANA_TOOL_NAMES,
  vercel: VERCEL_TOOL_NAMES,
  pagerduty: PAGERDUTY_TOOL_NAMES,
};
const NATIVE = ["sentry", "datadog", "cloudwatch", "github-actions", "grafana", "vercel", "pagerduty"] as const;

const v2 = (id: BuiltinAgentId): ResolvedRecipe => builtinRecipe(id, 2);
const typeOf = (grant: ToolGrant): string => ("type" in grant.connector ? grant.connector.type : grant.connector.name);
const shown = (grants: readonly ToolGrant[]): string[] => grants.map((grant) => `${typeOf(grant)}:${grant.access}${grant.tools === undefined ? "" : `:${grant.tools.join(",")}`}`);
const texts = (recipe: ResolvedRecipe): string[] => [...recipe.instructions.map((layer) => layer.text), ...recipe.steps.flatMap((step) => step.settings.instructions.map((layer) => layer.text))];
const stepText = (recipe: ResolvedRecipe, id: string): string => recipe.steps.find((step) => step.id === id)!.settings.instructions.map((layer) => layer.text).join("\n");

describe("the five templates have a version 2, and version 1 is as it was", () => {
  it.each(FIVE)("%s has versions 1 and 2, with 2 the current one and no later-connector note", (id) => {
    expect(BUILTIN_AGENTS[id].versions.map((entry) => entry.version)).toEqual([1, 2]);
    expect(currentBuiltinVersion(id)).toBe(2);
    expect(BUILTIN_AGENTS[id].needsLaterConnectors, id).toBeUndefined();
    for (const entry of BUILTIN_AGENTS[id].versions) {
      expect((entry as { needsLaterConnectors?: unknown }).needsLaterConnectors, `${id} v${String(entry.version)}`).toBeUndefined();
      expect(entry.releasedIn.length).toBeGreaterThan(0);
      expect(entry.notes.length).toBeGreaterThan(0);
    }
    expect(BUILTIN_AGENTS[id].versions[1]!.digest).toBe(recipeDigest(v2(id)));
    expect(BUILTIN_AGENTS[id].versions[1]!.digest).not.toBe(BUILTIN_AGENTS[id].versions[0]!.digest);
  });

  it("gives Rovara Code a version 2 of its own (Plan 6 Task 2), which an org with no settings does not run until it adopts it", () => {
    expect(currentBuiltinVersion("rovara-code")).toBe(2);
    expect(BUILTIN_AGENTS["rovara-code"].versions[0]!.digest).toBe("1f3d988f8f6c4ae406aca2a61c7afbc378a08f14d3ce47e8037228d9195c989b");
  });

  it.each(FIVE)("%s version 2 validates against the same schemas a person's agent does, runs as agent steps and lists only the person trigger", (id) => {
    const recipe = v2(id);
    expect(recipeProblems(recipe).map(formatRecipeProblem), id).toEqual([]);
    expect(ResolvedRecipeSchema.safeParse(structuredClone(recipe)).success, id).toBe(true);
    expect(ResolvedRecipeSchema.safeParse({ ...structuredClone(recipe), extra: 1 }).success, id).toBe(false);
    expect(recipeRunner(recipe), id).toBe("agent_steps");
    expect(recipe.triggers, id).toEqual([{ kind: "person" }]);
    expect(recipe.allowMentions, id).toBe(false);
    expect(recipe.approvals, id).toEqual({ alwaysAsk: [] });
    expect(recipe.chain, id).toEqual([{ agentId: id, name: BUILTIN_AGENTS[id].name, version: 2, builtin: true }]);
    expect(Object.isFrozen(BUILTIN_AGENTS[id].versions[1]!.recipe.tools), `${id} released recipe is frozen`).toBe(true);
  });

  it("keeps the step ids of version 1, so overlays built on the templates keep working", () => {
    for (const id of FIVE) expect(v2(id).steps.map((step) => `${step.id}:${step.kind}`), id).toEqual(builtinRecipe(id, 1).steps.map((step) => `${step.id}:${step.kind}`));
    expect(v2("deploy-reviewer").steps.map((step) => step.id)).toEqual(["inspect", "report"]);
    expect(v2("service-reviewer").steps.map((step) => step.id)).toEqual(["gather", "report"]);
    expect(v2("root-cause-analyst").steps.map((step) => step.id)).toEqual(["investigate", "report"]);
  });

  it("each template's final step reports to Slack and no earlier step does", () => {
    for (const id of FIVE) {
      v2(id).steps.forEach((step, index, steps) => {
        expect(step.kind === "agent" && step.report?.slack === true, `${id} ${step.id}`).toBe(index === steps.length - 1);
      });
    }
  });

  it("Ticket triage and Code reviewer do what they did: only their suggested triggers are new", () => {
    for (const id of ["ticket-triage", "code-reviewer"] as const) {
      const before = builtinRecipe(id, 1);
      const after = v2(id);
      expect(after.tools, id).toEqual(before.tools);
      expect(after.steps, id).toEqual(before.steps);
      expect(after.instructions, id).toEqual(before.instructions);
    }
  });
});

describe("the grants are exactly the plan's", () => {
  it("Deploy reviewer", () => {
    expect(shown(v2("deploy-reviewer").tools)).toEqual([
      "github-actions:read", "vercel:read", "sentry:read", "datadog:read:search_monitors,query_metrics,search_logs", "cloudwatch:read",
      // Task 27 review (controller ruling): the read-only GitHub tools it needs to find the pull request from a deployment event, and its one write.
      "github:read:pull_request_read,get_pull_request*,list_pull_requests,search_pull_requests,list_commits,get_commit", "github:read_write:add_*comment*",
    ]);
  });

  it("Service reviewer", () => {
    expect(shown(v2("service-reviewer").tools)).toEqual([
      "sentry:read", "datadog:read", "cloudwatch:read", "grafana:read", "pagerduty:read", "linear:read_write:save_issue", "jira:read_write:createJiraIssue", "github:read",
    ]);
  });

  it("Root-cause analyst keeps Plan 3's grants and adds the three read grants", () => {
    expect(shown(v2("root-cause-analyst").tools)).toEqual([
      "linear:read", "jira:read", "asana:read", "github:read", "mcp:read",
      "sentry:read:list_issues,get_issue,get_latest_event", "datadog:read:search_logs,query_metrics", "cloudwatch:read:query_logs,get_metric_data",
    ]);
  });

  it("the only read_write grants of the five are the ones the plan names, and a native connector is only ever read", () => {
    const writes = FIVE.flatMap((id) => v2(id).tools.filter((grant) => grant.access === "read_write").map((grant) => `${id}:${typeOf(grant)}`));
    expect(writes.sort()).toEqual([
      "code-reviewer:github", "deploy-reviewer:github", "service-reviewer:jira", "service-reviewer:linear",
      "ticket-triage:asana", "ticket-triage:github", "ticket-triage:jira", "ticket-triage:linear",
    ]);
    for (const id of FIVE) {
      for (const grant of v2(id).tools) {
        if ((NATIVE as readonly string[]).includes(typeOf(grant))) expect(grant.access, `${id} ${typeOf(grant)}`).toBe("read");
      }
    }
  });

  it("every grant names a connector type agents can use, by type (never by a project's name), and a native connector's grant is one of Tasks 12 to 17", () => {
    for (const id of FIVE) {
      for (const grant of v2(id).tools) {
        expect("type" in grant.connector, `${id} names a type`).toBe(true);
        expect(AgentConnectorTypeSchema.safeParse(typeOf(grant)).success, `${id} ${typeOf(grant)}`).toBe(true);
      }
    }
  });

  it("every tool pattern a grant names matches at least one tool in that connector's catalog", () => {
    for (const id of FIVE) {
      for (const grant of v2(id).tools) {
        for (const pattern of grant.tools ?? []) {
          const catalog = CATALOGS[typeOf(grant)];
          expect(catalog, `${id} ${typeOf(grant)} has a catalog`).toBeDefined();
          expect(catalog!.some((name) => toolPatternMatches(pattern, name)), `${id}: ${typeOf(grant)} ${pattern}`).toBe(true);
        }
      }
    }
  });

  it("a grant with a tool list names no more than the plan's tools: Datadog's three, Sentry's three, CloudWatch's two", () => {
    const datadog = v2("deploy-reviewer").tools.find((grant) => typeOf(grant) === "datadog")!;
    expect(datadog.tools!.flatMap((pattern) => DATADOG_TOOL_NAMES.filter((name) => toolPatternMatches(pattern, name))).sort()).toEqual(["query_metrics", "search_logs", "search_monitors"]);
    const sentry = v2("root-cause-analyst").tools.find((grant) => typeOf(grant) === "sentry")!;
    expect(sentry.tools!.flatMap((pattern) => SENTRY_TOOL_NAMES.filter((name) => toolPatternMatches(pattern, name))).sort()).toEqual(["get_issue", "get_latest_event", "list_issues"]);
    const cloudwatch = v2("root-cause-analyst").tools.find((grant) => typeOf(grant) === "cloudwatch")!;
    expect(cloudwatch.tools!.flatMap((pattern) => CLOUDWATCH_TOOL_NAMES.filter((name) => toolPatternMatches(pattern, name))).sort()).toEqual(["get_metric_data", "query_logs"]);
  });
});

/** What resolving each template's grants gives against every connector of the project fully approved: the tools an agent could ever call. */
function resolved(id: BuiltinAgentId) {
  const presented = (connector: string, name: string, access: "read" | "write"): PresentedTool => ({
    name: `${connector}__${name}`, upstreamName: name, description: name, inputSchema: { type: "object", properties: {} }, access, scopes: [{ alias: "team", schemaHash: "a".repeat(64) }],
  });
  const writeNamed = (type: string, name: string): boolean => {
    if (type === "github") return Object.values(GITHUB_AGENT_TOOL_PERMISSIONS[name] ?? {}).includes("write");
    if (type === "linear") return /^(save_|delete_)/u.test(name);
    if (type === "jira") return /^(create|edit|transition|addOrEdit|executeWrite)/u.test(name);
    if (type === "asana") return /^(create_|update_|delete_|add_comment|save_|log_)/u.test(name);
    return false;
  };
  const connectors: GrantConnector[] = [];
  const catalogs: ConnectorCatalog[] = [];
  for (const [type, names] of Object.entries(CATALOGS)) {
    const tools = names.map((name) => ({ name, access: writeNamed(type, name) ? "write" as const : "read" as const }));
    connectors.push({ name: type, type, approvals: tools });
    catalogs.push({ connector: type, tools: tools.map((tool) => presented(type, tool.name, tool.access)), skipped: [] });
  }
  connectors.push({ name: "mcp", type: "mcp", approvals: [{ name: "get_note", access: "read" }, { name: "delete_note", access: "write" }] });
  catalogs.push({ connector: "mcp", tools: [presented("mcp", "get_note", "read"), presented("mcp", "delete_note", "write")], skipped: [] });
  return resolveToolGrants({ grants: v2(id).tools, connectors, catalogs });
}

describe("what the templates can actually call", () => {
  it("Deploy reviewer: reads the deploy's sources, and its one write is a pull request or issue comment", () => {
    const granted = resolved("deploy-reviewer");
    const writes = granted.filter((tool) => tool.access === "write").map((tool) => `${tool.type}.${tool.upstreamName}`);
    expect(writes).toEqual(["github.add_issue_comment"]);
    // It can find the pull request that went out (read and list tools only), so it can comment on it.
    expect(granted.filter((tool) => tool.type === "github" && tool.access === "read").map((tool) => tool.upstreamName).sort()).toEqual(
      ["get_commit", "get_pull_request", "get_pull_request_comments", "get_pull_request_diff", "get_pull_request_files", "get_pull_request_reviews", "get_pull_request_status", "list_commits", "list_pull_requests", "pull_request_read", "search_pull_requests"],
    );
    expect(granted.filter((tool) => tool.type === "datadog").map((tool) => tool.upstreamName).sort()).toEqual(["query_metrics", "search_logs", "search_monitors"]);
    for (const type of ["github-actions", "vercel", "sentry", "cloudwatch"]) expect(granted.some((tool) => tool.type === type), type).toBe(true);
    expect(granted.some((tool) => tool.type === "grafana" || tool.type === "pagerduty" || tool.type === "mcp"), "nothing the plan does not grant").toBe(false);
  });

  it("Service reviewer: reads the monitoring sources, creates tickets in Linear and Jira only, and cannot write GitHub", () => {
    const granted = resolved("service-reviewer");
    expect(granted.filter((tool) => tool.access === "write").map((tool) => `${tool.type}.${tool.upstreamName}`).sort()).toEqual(["jira.createJiraIssue", "linear.save_issue"]);
    expect(granted.some((tool) => tool.type === "github" && tool.access === "write")).toBe(false);
    for (const type of ["sentry", "datadog", "cloudwatch", "grafana", "pagerduty", "github"]) expect(granted.some((tool) => tool.type === type), type).toBe(true);
    expect(granted.some((tool) => tool.type === "asana")).toBe(false);
  });

  it("Root-cause analyst: only reads", () => {
    const granted = resolved("root-cause-analyst");
    expect(granted.filter((tool) => tool.access === "write")).toEqual([]);
    expect(granted.filter((tool) => tool.type === "sentry").map((tool) => tool.upstreamName).sort()).toEqual(["get_issue", "get_latest_event", "list_issues"]);
    expect(granted.filter((tool) => tool.type === "cloudwatch").map((tool) => tool.upstreamName).sort()).toEqual(["get_metric_data", "query_logs"]);
    expect(granted.filter((tool) => tool.type === "datadog").map((tool) => tool.upstreamName).sort()).toEqual(["query_metrics", "search_logs"]);
  });

  it("no template names or is granted a rollback, merge, close, push, revert, redeploy or restart tool", () => {
    const forbidden = /rollback|merge|close|push|revert|redeploy|restart/iu;
    for (const id of FIVE) {
      for (const grant of v2(id).tools) for (const pattern of grant.tools ?? []) expect(pattern, `${id} pattern`).not.toMatch(forbidden);
      for (const tool of resolved(id)) expect(`${tool.type}.${tool.upstreamName}`, id).not.toMatch(forbidden);
    }
  });

  it("the three templates that changed are granted no delete tool either (Ticket triage keeps version 1's whole-tracker grant, whose delete tools the write gate holds for a person)", () => {
    for (const id of ["deploy-reviewer", "service-reviewer", "root-cause-analyst"] as const) {
      for (const tool of resolved(id)) expect(`${tool.type}.${tool.upstreamName}`, id).not.toMatch(/delete/iu);
    }
  });
});

describe("the Deploy reviewer's instructions", () => {
  const recipeOf = () => v2("deploy-reviewer");

  it("`inspect` has the three sections, in order, and says a person must approve a rollback", () => {
    const inspect = stepText(recipeOf(), "inspect");
    const at = (heading: string) => inspect.indexOf(heading);
    expect(at("What you check")).toBeGreaterThanOrEqual(0);
    expect(at("How you judge")).toBeGreaterThan(at("What you check"));
    expect(at("What you never do")).toBeGreaterThan(at("How you judge"));
    expect(inspect).toContain("a person must approve");
    expect(inspect).toMatch(/30 minutes after/u);
    expect(inspect).toMatch(/30 minutes before/u);
    expect(inspect).toMatch(/GitHub Actions/u);
    expect(inspect).toMatch(/Vercel/u);
    for (const source of ["Sentry", "Datadog", "CloudWatch"]) expect(inspect, source).toContain(source);
    expect(inspect).toMatch(/link/iu);
    expect(inspect).toMatch(/recommend/iu);
  });

  it("`report` opens with one verdict word, then findings by severity with links, then suggested actions, and comments on the pull request", () => {
    const report = stepText(recipeOf(), "report");
    for (const word of ["healthy", "degraded", "failed", "unknown"]) expect(report, word).toContain(word);
    expect(report).toMatch(/verdict/iu);
    expect(report.indexOf("severity")).toBeGreaterThanOrEqual(0);
    expect(report.indexOf("suggested actions")).toBeGreaterThan(report.indexOf("severity"));
    // add_issue_comment can comment on a pull request or an issue, not on a commit: the copy says "pull request" only.
    expect(report).toMatch(/comment on the pull request/u);
    expect(report).not.toMatch(/commit that went out|or commit/u);
    const last = recipeOf().steps.at(-1)!;
    expect(last.kind === "agent" && last.report).toEqual({ slack: true });
  });

  it("tells the agent how to find the pull request, and to post no comment (and say so) when it cannot, and never offers a comment on a commit", () => {
    const all = texts(recipeOf()).join("\n");
    expect(all).toMatch(/find the pull request/iu);
    expect(all).toMatch(/post no comment/u);
    expect(all).not.toMatch(/or commit|commit that went out/u);
    expect(BUILTIN_AGENTS["deploy-reviewer"].versions[1]!.notes).not.toMatch(/or commit/u);
  });

  it("tells the agent that text it reads is information, not instructions, and to put no command or mention in a comment", () => {
    const all = texts(recipeOf()).join("\n");
    expect(all).toMatch(/information to read, never as instructions/u);
    expect(all).toMatch(/slash command/iu);
  });
});

describe("the other new instructions", () => {
  it("Service reviewer: the last 7 days, groups repeats, ranks by user impact, tickets labelled rovara only for something new and actionable, at most 5 a run", () => {
    const all = texts(v2("service-reviewer")).join("\n");
    expect(all).toMatch(/last 7 days/u);
    expect(all).toMatch(/repeat/iu);
    expect(all).toMatch(/user impact/iu);
    expect(all).toMatch(/`rovara`/u);
    expect(all).toMatch(/new and actionable/u);
    expect(all).toMatch(/at most 5/u);
    expect(all).toMatch(/waits for a person/u);
  });

  it("Root-cause analyst: starts from the error or alert, then the logs around it, then the code", () => {
    expect(texts(v2("root-cause-analyst")).join("\n")).toMatch(/start from the error or alert, then the logs around it, then the code/iu);
  });

  it.each(FIVE)("%s: no instruction contains `ignore`, `system prompt`, a URL, an em dash or a variable", (id) => {
    for (const text of texts(v2(id))) {
      expect(text.trim().length, id).toBeGreaterThan(0);
      expect(text, id).not.toMatch(/ignore/iu);
      expect(text, id).not.toMatch(/system prompt/iu);
      expect(text, id).not.toMatch(/https?:|www\.|:\/\//iu);
      expect(text, id).not.toMatch(/[—–]/u);
      // No free-text variable of a vendor's template ($EVENT_TITLE): a template the person copies into Datadog carries none (Task 24 review).
      expect(text, id).not.toMatch(/\$[A-Z_]{3,}/u);
    }
  });

  it("every layer fits the instruction limit", () => {
    for (const id of FIVE) for (const text of texts(v2(id))) expect(Buffer.byteLength(text), id).toBeLessThan(8192);
  });
});

describe("the suggested triggers", () => {
  const MEMBERS = ["COLLABORATOR", "MEMBER", "OWNER"];
  const sorted = (values: unknown): unknown => (Array.isArray(values) ? [...(values as string[])].sort() : values);
  const normal = (spec: Record<string, unknown>): unknown => ({ ...spec, ...(spec["filter"] === undefined ? {} : { filter: Object.fromEntries(Object.entries(spec["filter"] as Record<string, unknown>).map(([key, values]) => [key, sorted(values)])) }) });

  it("are exactly the plan's, in the plan's order, and Code reviewer's first is the one that was there", () => {
    const view = (id: BuiltinAgentId) => BUILTIN_TRIGGER_SUGGESTIONS[id].map((spec) => normal(spec as unknown as Record<string, unknown>));
    expect(view("deploy-reviewer")).toEqual([
      { kind: "event", source: "github", type: "deployment_status.success", filter: { environment: ["production"] } },
      { kind: "event", source: "vercel", type: "deployment.succeeded", filter: { target: ["production"] } },
    ]);
    expect(view("service-reviewer")).toEqual([{ kind: "schedule", schedule: { kind: "weekly", at: "09:00", day: "MON" }, timezone: "UTC", missed: "run_once" }]);
    expect(view("root-cause-analyst")).toEqual([
      { kind: "event", source: "sentry", type: "issue.created" },
      { kind: "event", source: "pagerduty", type: "incident.triggered" },
      { kind: "event", source: "cloudwatch", type: "alarm.fired" },
    ]);
    expect(view("ticket-triage")).toEqual([
      { kind: "event", source: "linear", type: "issue.created" },
      { kind: "event", source: "jira", type: "issue.created" },
      { kind: "event", source: "github", type: "issues.opened", filter: { authorAssociation: MEMBERS } },
    ]);
    expect(view("code-reviewer")).toEqual([
      { kind: "event", source: "github", type: "pull_request.opened", filter: { authorAssociation: MEMBERS } },
      { kind: "event", source: "github", type: "pull_request.ready_for_review", filter: { authorAssociation: MEMBERS } },
    ]);
    // Meta repo lane F replaces "none": a label or an assignment on a Jira or GitHub issue asks Rovara Code for work (no filter in the suggestion: the trigger must name the label).
    expect(BUILTIN_TRIGGER_SUGGESTIONS["rovara-code"]).toEqual([
      { kind: "event", source: "github", type: "issues.labeled" },
      { kind: "event", source: "github", type: "issues.assigned" },
      { kind: "event", source: "jira", type: "issue.labeled" },
      { kind: "event", source: "jira", type: "issue.assigned" },
    ]);
  });

  it("every one parses with the schemas a person's trigger does, and passes its type and filter tables", () => {
    for (const id of BUILTIN_AGENT_IDS) {
      for (const spec of BUILTIN_TRIGGER_SUGGESTIONS[id]) {
        expect(TriggerSpecSchema.safeParse(structuredClone(spec)).success, `${id} ${JSON.stringify(spec)}`).toBe(true);
        if (spec.kind === "event") {
          expect(EventTriggerSpecSchema.safeParse(structuredClone(spec)).success).toBe(true);
          expect((EVENT_TYPES[spec.source] as readonly string[]).includes(spec.type), `${spec.source} ${spec.type}`).toBe(true);
          for (const key of Object.keys(spec.filter ?? {})) expect(eventFilterKeys(spec.source, spec.type), `${spec.source} ${spec.type} ${key}`).toContain(key);
        } else {
          expect(ScheduleTriggerSpecSchema.safeParse(structuredClone(spec)).success).toBe(true);
        }
      }
    }
  });

  it("every GitHub issues.opened and pull_request.* suggestion carries the authorAssociation filter, so strangers on a public repository start nothing", () => {
    const github = BUILTIN_AGENT_IDS.flatMap((id) => BUILTIN_TRIGGER_SUGGESTIONS[id]).filter((spec) => spec.kind === "event" && spec.source === "github" && (spec.type === "issues.opened" || spec.type.startsWith("pull_request.")));
    expect(github).toHaveLength(3);
    for (const spec of github) expect(spec.kind === "event" && sorted(spec.filter?.["authorAssociation"]), JSON.stringify(spec)).toEqual(MEMBERS);
  });

  it("none is in a recipe: a recipe lists the person trigger alone, so a new version or release turns nothing on", () => {
    for (const id of BUILTIN_AGENT_IDS) {
      for (const entry of BUILTIN_AGENTS[id].versions) expect(entry.recipe.triggers, `${id} v${String(entry.version)}`).toEqual([{ kind: "person" }]);
    }
  });

  it("a project sees every suggestion off: none is switched on until a maintainer does it", async () => {
    const v = setupTriggerWorld();
    const rows = (await v.agentCall(MAX, "GET", "/v1/app/projects/web/builtin-triggers")).body["triggers"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(BUILTIN_AGENT_IDS.reduce((total, id) => total + BUILTIN_TRIGGER_SUGGESTIONS[id].length, 0));
    expect(rows.every((row) => row["enabled"] === false)).toBe(true);
    expect(rows.every((row) => row["triggerId"] === undefined)).toBe(true);
    expect(rows.filter((row) => row["agentId"] === "code-reviewer").map((row) => row["index"])).toEqual([0, 1]);
    expect(rows.find((row) => row["agentId"] === "service-reviewer")).toMatchObject({ index: 0, needsHook: false });
    expect(rows.find((row) => row["agentId"] === "deploy-reviewer" && row["index"] === 1)).toMatchObject({ needsHook: true });
    expect(v.db.find((item) => String(item["pk"]).includes("TRIGGER#") && item["sk"] === "META")).toEqual([]);
  });
});

describe("the Deploy reviewer's comments go through Plan 3's write gate (M4)", () => {
  const catalogTool: PresentedTool = {
    name: "github__add_issue_comment", upstreamName: "add_issue_comment", description: "comment", inputSchema: { type: "object", properties: {} }, access: "write", scopes: [{ alias: "repo", schemaHash: "a".repeat(64) }],
  };
  const toolOf = () => resolveToolGrants({
    grants: v2("deploy-reviewer").tools,
    connectors: [{ name: "github", type: "github", approvals: [{ name: "add_issue_comment", access: "write" }] }],
    catalogs: [{ connector: "github", tools: [catalogTool], skipped: [] }],
  })[0]!;
  const classify = (body: string, repositoryRule: { consequential: boolean } = { consequential: false }) => {
    const recipe = v2("deploy-reviewer");
    const tool = toolOf();
    const prepared = prepareAgentWrite(tool, { owner: "o", repo: "r", issue_number: 7, body }, { allowMentions: recipe.allowMentions });
    return classifyWrite({ tool, args: prepared.args, rules: recipe.approvals, autonomy: recipe.autonomy, allowMentions: recipe.allowMentions, ownItems: new Set<string>(), labelNames: new Map(), repositoryRule });
  };

  it("is granted the comment tool", () => {
    expect(toolOf()).toMatchObject({ type: "github", upstreamName: "add_issue_comment", access: "write" });
  });

  it("a comment whose body contains /deploy is consequential and waits for approval", () => {
    expect(classify("/deploy production").class).toBe("consequential");
    expect(classify("Findings below.\n/deploy production").class).toBe("consequential");
  });

  it("a plain findings comment is safe", () => {
    expect(classify("Verdict: degraded. Error rate rose from 0.2% to 1.4% in the 30 minutes after the deploy.").class).toBe("safe");
  });

  it("a comment on a repository that listens for commands waits, whatever it says", () => {
    expect(classify("Verdict: healthy.", { consequential: true }).class).toBe("consequential");
  });
});

describe("an organisation that pinned version 1 keeps it until an admin chooses the update", () => {
  const settings = (id: BuiltinAgentId, pinnedVersion: number) => ({
    ...builtinSettingsKey(ORG_A, id), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion, updatedBy: "x", updatedAt: "2026-10-20T00:00:00.000Z",
  });

  it.each(["deploy-reviewer", "service-reviewer", "root-cause-analyst"] as const)("%s: a pin at 1 stays 1 while the latest is 2, and version 1 still resolves to the recipe it had", async (id) => {
    const db = new FakeDynamoDb();
    const store = new AgentStore({ documentClient: db, tableName: "T", now: () => Date.parse("2026-10-24T00:00:00.000Z"), newId: () => "agt_00000000000000000001" });
    db.set(settings(id, 1));
    expect(await store.pinnedBuiltinVersion(ORG_A, id)).toBe(1);
    expect(store.builtinLatestVersion(id)).toBe(2);
    expect(recipeDigest(store.builtinRecipe(id, 1))).toBe(BUILTIN_AGENTS[id].versions[0]!.digest);
    expect(recipeDigest(store.builtinRecipe(id, 2))).toBe(BUILTIN_AGENTS[id].versions[1]!.digest);
  });

  it("an organisation with no pin yet starts on the newest version", async () => {
    const db = new FakeDynamoDb();
    const store = new AgentStore({ documentClient: db, tableName: "T", now: () => Date.parse("2026-10-24T00:00:00.000Z"), newId: () => "agt_00000000000000000001" });
    expect(await store.pinnedBuiltinVersion(ORG_A, "deploy-reviewer")).toBe(2);
  });
});
