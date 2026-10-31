// Lane E, task E8: the calls behind the Sources settings (a project's context sources) and "MCP servers" (an Enterprise org's own servers). Every answer is read
// through a schema; a refusal shows the broker's own sentence, which is fixed text that holds no server text and no secret.
import { z } from "zod";
import type { AppHost, ApiRequest, ApiResponse } from "../host.js";
import { ApiError } from "./errors.js";

const Stage = z.enum(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"]);
const Quotes = z.enum(["source_acl", "project_members", "citations_only"]);
const Server = z.discriminatedUnion("kind", [z.object({ kind: z.literal("connection"), connectionId: z.string().max(60) }), z.object({ kind: z.literal("registered_server"), serverId: z.string().max(60) })]);
const Tool = z.object({ upstreamName: z.string().max(64), role: z.enum(["search", "read", "status"]), schemaHash: z.string().length(64), attestedReadOnly: z.boolean().optional() });
export const SourceReader = z.object({
  sourceId: z.string().max(16), label: z.string().max(60), system: z.string().max(24).optional(), server: Server, tools: z.array(Tool).max(16), stages: z.array(Stage).max(4), quotes: Quotes,
  retention: z.enum(["live_only", "team_record"]), limits: z.object({ callsPerStage: z.number(), bytesPerResult: z.number(), bytesPerStage: z.number() }), liveFacts: z.array(z.string().max(40)).max(16), sendCodeSnippets: z.boolean(),
});
export type SourceView = z.infer<typeof SourceReader>;
const ChangeReader = z.object({ changeId: z.string().max(60), kind: z.enum(["set", "remove"]), sourceId: z.string().max(16), source: SourceReader.optional(), proposedBy: z.string().max(100), proposedAt: z.string().max(40), secondAdminReasons: z.array(z.string().max(300)).max(20) });
export type ChangeView = z.infer<typeof ChangeReader>;
const SourcesReader = z.object({ project: z.string().max(100), document: z.object({ revision: z.number(), sources: z.array(SourceReader).max(16) }), pending: z.array(ChangeReader).max(100) });
export const DiscoveredReader = z.object({ tools: z.array(z.object({ name: z.string().max(64), description: z.string().max(300), schemaHash: z.string().length(64), annotation: z.enum(["read_only", "unannotated", "unsafe"]), nameSuggestsChange: z.boolean(), takesAddress: z.boolean() })).max(200) });
export type DiscoveredView = z.infer<typeof DiscoveredReader>["tools"][number];
const ProbeTool = z.object({ name: z.string().max(64), description: z.string().max(300), annotation: z.enum(["read_only", "unannotated", "unsafe"]) });
const McpServerReader = z.object({
  serverId: z.string().max(40), label: z.string().max(60), status: z.enum(["awaiting_approval", "approved", "disabled"]),
  transport: z.discriminatedUnion("kind", [z.object({ kind: z.literal("http"), address: z.string().max(2048) }), z.object({ kind: z.literal("stdio"), spec: z.object({ name: z.string().max(100), version: z.string().max(50) }) })]),
  probe: z.object({ tools: z.array(ProbeTool).max(100) }), requestedAt: z.string().max(40),
});
export type McpServerView = z.infer<typeof McpServerReader>;

const TIMEOUT_MS = 120_000;

export function createContextSourcesApi(host: AppHost) {
  async function call<T>(request: ApiRequest, reader: { parse(value: unknown): T }, accept: readonly number[] = [200]): Promise<T> {
    let response: ApiResponse;
    try { response = await host.transport.request({ ...request, retry: "never" }); } catch { throw new ApiError(0, "NETWORK_ERROR", "Couldn't reach Rovara. Check your connection and try again."); }
    if (!accept.includes(response.status)) {
      const error = z.object({ error: z.object({ message: z.string().max(400) }) }).safeParse(response.body);
      throw new ApiError(response.status, response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "NOT_FOUND" : "REFUSED", error.success ? error.data.error.message : "Rovara couldn't do that. Try again.");
    }
    try { return reader.parse(response.body); } catch { throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page."); }
  }
  const sourcesPath = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/context-sources`;
  const serversPath = "/v1/app/org/mcp-servers";
  return {
    sources: (project: string) => call({ method: "GET", path: sourcesPath(project) }, SourcesReader),
    discover: (project: string, server: SourceView["server"]) => call({ method: "POST", path: `${sourcesPath(project)}/discover`, body: { server } }, DiscoveredReader),
    propose: (project: string, body: { kind: "set"; source: unknown } | { kind: "remove"; sourceId: string }) =>
      call({ method: "POST", path: `${sourcesPath(project)}/changes`, body }, z.object({ changeId: z.string().max(60), needsSecondAdmin: z.array(z.string().max(300)).max(20) }), [202]),
    confirm: (project: string, changeId: string) => call({ method: "POST", path: `${sourcesPath(project)}/changes/${changeId}/confirm` }, z.object({}).passthrough()),
    reject: (project: string, changeId: string) => call({ method: "POST", path: `${sourcesPath(project)}/changes/${changeId}/reject` }, z.object({}).passthrough()),
    servers: () => call({ method: "GET", path: serversPath }, z.object({ servers: z.array(McpServerReader).max(200) })),
    addServer: (body: { label: string; transport: unknown }) => call({ method: "POST", path: serversPath, body }, z.object({ server: McpServerReader }), [202]),
    approveServer: (serverId: string) => call({ method: "POST", path: `${serversPath}/${serverId}/approve` }, z.object({ server: McpServerReader })),
    disableServer: (serverId: string) => call({ method: "POST", path: `${serversPath}/${serverId}/disable` }, z.object({}).passthrough()),
    removeServer: (serverId: string) => call({ method: "DELETE", path: `${serversPath}/${serverId}` }, z.object({}).passthrough()),
    connections: () => call({ method: "GET", path: "/v1/app/connections" }, z.object({ connections: z.array(z.object({ connectionId: z.string().max(60), label: z.string().max(200), type: z.string().max(64) })).max(1000) })),
    timeoutMs: TIMEOUT_MS,
  };
}
export type ContextSourcesApi = ReturnType<typeof createContextSourcesApi>;
