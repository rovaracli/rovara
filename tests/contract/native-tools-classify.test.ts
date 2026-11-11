// Plan 4 Task 17 (Review B): every tool of all seven native connectors, approved by a project as a `read`, is a read for Plan 3's real `classifyWrite`. The
// native tools only read, so a later tool whose name gains a word of Plan 3's `WRITE_VERBS` or `DESTRUCTIVE_WORDS` (a `run`, a `cancel`, a `delete`) would make a
// read-approved tool wait for a person, or worse be mistaken for a write; this test fails the day one is added. Arguments are filled from each tool's own schema.
import { describe, expect, it } from "vitest";
import type { AgentConnectorType, GrantedTool } from "@rovara-code/contracts";
import { classifyWrite } from "../../packages/broker/src/agents/write-class.js";
import { PROJECT_CONNECTOR_TOOLS } from "../../packages/broker/src/connections/project-connectors.js";
import { CLOUDWATCH_TOOLS } from "../../packages/broker/src/connectors/native/cloudwatch.js";
import { DATADOG_TOOLS } from "../../packages/broker/src/connectors/native/datadog.js";
import { GITHUB_ACTIONS_TOOLS } from "../../packages/broker/src/connectors/native/github-actions.js";
import { GRAFANA_TOOLS } from "../../packages/broker/src/connectors/native/grafana.js";
import { PAGERDUTY_TOOLS } from "../../packages/broker/src/connectors/native/pagerduty.js";
import type { NativeTool } from "../../packages/broker/src/connectors/native/runtime.js";
import { SENTRY_TOOLS } from "../../packages/broker/src/connectors/native/sentry.js";
import { VERCEL_TOOLS } from "../../packages/broker/src/connectors/native/vercel.js";

const NATIVE: Record<string, { type: AgentConnectorType; tools: readonly NativeTool<never>[] }> = {
  sentry: { type: "sentry", tools: SENTRY_TOOLS },
  datadog: { type: "datadog", tools: DATADOG_TOOLS },
  grafana: { type: "grafana", tools: GRAFANA_TOOLS },
  pagerduty: { type: "pagerduty", tools: PAGERDUTY_TOOLS },
  vercel: { type: "vercel", tools: VERCEL_TOOLS },
  cloudwatch: { type: "cloudwatch", tools: CLOUDWATCH_TOOLS },
  "github-actions": { type: "github-actions", tools: GITHUB_ACTIONS_TOOLS },
};

type Schema = Record<string, unknown>;
const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

/** A value that fits `schema`: its default, its first enum member, or the smallest value of its type. */
function filled(schema: Schema): unknown {
  if ("default" in schema) return schema["default"];
  if (Array.isArray(schema["enum"])) return schema["enum"][0];
  switch (schema["type"]) {
    case "integer":
    case "number": return typeof schema["minimum"] === "number" ? schema["minimum"] : 1;
    case "boolean": return false;
    case "array": return isSchema(schema["items"]) && typeof schema["minItems"] === "number" && schema["minItems"] > 0 ? [filled(schema["items"])] : [];
    case "object": return Object.fromEntries(Object.entries(isSchema(schema["properties"]) ? schema["properties"] : {}).filter(([, value]) => isSchema(value)).map(([key, value]) => [key, filled(value as Schema)]));
    default: return "x";
  }
}
const argumentsOf = (tool: NativeTool<never>): Record<string, unknown> => filled(tool.inputSchema) as Record<string, unknown>;

describe("every native connector's tools, approved by a project as reads", () => {
  it("covers all seven native connectors, and each type's tools are the ones a project may approve", () => {
    expect(Object.keys(NATIVE).sort()).toEqual(["cloudwatch", "datadog", "github-actions", "grafana", "pagerduty", "sentry", "vercel"]);
    for (const [name, { tools }] of Object.entries(NATIVE)) {
      expect(tools.length, name).toBeGreaterThan(0);
      expect(tools.map((tool) => tool.name), name).toEqual([...PROJECT_CONNECTOR_TOOLS[name as keyof typeof PROJECT_CONNECTOR_TOOLS]]);
    }
  });

  const cases = Object.entries(NATIVE).flatMap(([name, { type, tools }]) => tools.map((tool) => [name, type, tool] as const));
  it.each(cases)("%s: %s is a read for classifyWrite", (_connector, type, tool) => {
    const granted: GrantedTool = {
      connector: "native", type, upstreamName: tool.name, presentedName: `native__${tool.name}`, access: "read",
      facts: { connector: "native", upstreamName: tool.name, access: "read", hints: { readOnlyHint: true, destructiveHint: false } },
    };
    const result = classifyWrite({ tool: granted, args: argumentsOf(tool), rules: { alwaysAsk: [] }, autonomy: "run", allowMentions: false, ownItems: new Set<string>() });
    expect(result.class, `${tool.name}: ${result.reason}`).toBe("read");
  });

  it("would notice a tool whose name says it writes (the check is not vacuous)", () => {
    for (const name of ["cancel_workflow_run", "delete_alert", "resolve_issue", "run_query", "trigger_deployment"]) {
      const granted: GrantedTool = { connector: "native", type: "github-actions", upstreamName: name, presentedName: `native__${name}`, access: "read", facts: { connector: "native", upstreamName: name, access: "read" } };
      expect(classifyWrite({ tool: granted, args: {}, rules: { alwaysAsk: [] }, autonomy: "run", allowMentions: false, ownItems: new Set<string>() }).class, name).not.toBe("read");
    }
  });
});
