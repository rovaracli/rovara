// Shared fixtures for the context-source tests (lane E).
import type { ContextSource, OrgId } from "@agentx/contracts";
import { toolSchemaHash, type DiscoveredTool, type SourceEnvironment } from "../../../packages/broker/src/context-sources/settings.js";

export const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
export const CONNECTION = "con_aaaaaaaaaaaaaaaaaaaa";
export const NOW = Date.UTC(2026, 10, 1, 10, 0, 0);

export const SEARCH_TOOL: DiscoveredTool = {
  name: "search_tickets", description: "Search tickets", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
};
export const GET_TOOL: DiscoveredTool = {
  name: "get_ticket", description: "Read one ticket", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const PLAIN_TOOL: DiscoveredTool = { name: "lookup_page", description: "Look up a page", inputSchema: { type: "object", properties: { title: { type: "string" } } } };
export const WRITE_TOOL: DiscoveredTool = { name: "close_ticket", description: "Close", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: false } };

export function source(over: Partial<ContextSource> = {}, tools: DiscoveredTool[] = [SEARCH_TOOL, GET_TOOL]): ContextSource {
  return {
    sourceId: "sim", label: "SIM", server: { kind: "connection", connectionId: CONNECTION },
    tools: tools.map((tool, index) => ({ upstreamName: tool.name, role: index === 0 ? "search" as const : "read" as const, schemaHash: toolSchemaHash(tool) })),
    stages: ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"], quotes: "citations_only", retention: "team_record",
    limits: { callsPerStage: 25, bytesPerResult: 16_384, bytesPerStage: 196_608 }, liveFacts: ["status"], sendCodeSnippets: false, ...over,
  };
}

export function environment(over: Partial<SourceEnvironment> & { tools?: DiscoveredTool[] } = {}): SourceEnvironment {
  const tools = over.tools ?? [SEARCH_TOOL, GET_TOOL];
  return {
    edition: "enterprise",
    connection: async () => ({ type: "mcp", access: "read" }),
    registeredServer: async () => ({ status: "approved" }),
    discoverTools: async () => tools,
    perUserCheckAvailable: () => false,
    ...over,
  };
}
