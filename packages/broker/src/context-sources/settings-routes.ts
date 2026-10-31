// E1/E8: the routes behind the Sources settings page (owner or admin only):
//   GET  /v1/app/projects/{p}/context-sources                              the sources and the changes waiting
//   POST /v1/app/projects/{p}/context-sources/discover                     the tools a connection or an approved server offers, with what Rovara checks on each
//   POST /v1/app/projects/{p}/context-sources/changes                      propose adding, changing or removing a source (202, nothing is applied yet)
//   POST /v1/app/projects/{p}/context-sources/changes/{id}/confirm|reject
// A body is never echoed back in an error, and a request that carries an operation capability instead of a person's token never gets this far.
import { z } from "zod";
import { ContextSourceServerSchema, agentXError, projectArchivedMessage } from "@agentx/contracts";
import type { AgentCaller } from "../agents/access.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { annotationVerdict, confirmSourceChange, nameSuggestsWrite, proposeSourceChange, readContextSources, rejectSourceChange, toolSchemaHash, type SettingsDependencies } from "./settings.js";

export const CONTEXT_SOURCES_PATH = /^\/v1\/app\/projects\/([^/]+)\/context-sources(?:\/(discover|changes)(?:\/([0-9a-f-]{36})\/(confirm|reject))?)?$/;

export interface ContextSourceRouteDependencies extends SettingsDependencies {
  /** Throws PROJECT_NOT_FOUND unless the caller has a role on the project (the same answer for a missing project). */
  requireProjectRole(caller: AgentCaller, project: string): Promise<void>;
  /** Used to refuse changes to an archived project. */
  table: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string };
}

const notThere = () => agentXError("NOT_FOUND", "route not found");

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

const DiscoverBodySchema = z.object({ server: ContextSourceServerSchema }).strict();
const ChangeBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), source: z.unknown() }).strict(),
  z.object({ kind: z.literal("remove"), sourceId: z.string().min(1).max(32) }).strict(),
]);

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue?.code === "unrecognized_keys" ? "has a field this route does not take" : issue?.message ?? "is not valid"}`);
}

/** Whether a tool's input schema takes an address: such a tool is only used with an address on the source's own host (routes.ts). */
export function schemaTakesAddress(schema: Record<string, unknown>): boolean {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return false;
  return Object.entries(properties as Record<string, unknown>).some(([name, value]) => {
    const format = typeof value === "object" && value !== null ? (value as { format?: unknown }).format : undefined;
    return format === "uri" || format === "url" || /(^|_|-)(url|uri|href|link|endpoint|webhook)s?($|_|-)/iu.test(name);
  });
}

export async function routeContextSources(deps: ContextSourceRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const match = CONTEXT_SOURCES_PATH.exec(url.pathname);
  if (match === null) throw notThere();
  let project: string;
  try { project = decodeURIComponent(match[1]!); } catch { throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name"); }
  const actor = { orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole };
  if (actor.orgRole !== "owner" && actor.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only an org owner or admin can review or change a project's context sources.");
  await deps.requireProjectRole(caller, project);
  const [, , part, changeId, action] = match;
  if (part === undefined) {
    if (request.method !== "GET") throw notThere();
    return { project, ...await readContextSources(deps, actor, project) };
  }
  if (request.method !== "POST") throw notThere();
  if (part === "discover") {
    const body = parse(DiscoverBodySchema, jsonBody(request));
    let tools;
    try { tools = await deps.env.discoverTools(caller.orgId, body.server); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not list that server's tools right now; try again"); }
    return { tools: tools.slice(0, 200).map((tool) => ({
      name: tool.name, description: (tool.description ?? "").slice(0, 300), schemaHash: toolSchemaHash(tool), annotation: annotationVerdict(tool),
      nameSuggestsChange: nameSuggestsWrite(tool.name), takesAddress: schemaTakesAddress(tool.inputSchema),
    })) };
  }
  if ((await readProjectMeta(deps.table, caller.orgId, project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
  if (changeId === undefined) {
    const change = await proposeSourceChange(deps, actor, project, parse(ChangeBodySchema, jsonBody(request)));
    return new StatusReply(202, { status: "NEEDS_CONFIRMATION", changeId: change.changeId, needsSecondAdmin: change.secondAdminReasons });
  }
  if (action === "confirm") return { document: await confirmSourceChange(deps, actor, project, changeId) };
  await rejectSourceChange(deps, actor, project, changeId);
  return { status: "REJECTED" };
}
