// Part of the broker (lane E, task E2): the internal context-tool routes (`GET /v1/internal/context-tools`, `POST /v1/internal/context-tools/call`).
// The capability is checked like a callback's (signature, expiry, scope, fence); a refused one is 401. The operation must be the workspace's active one and
// not finished or being cancelled, and its task must belong to the same org: any disagreement serves nothing. What a stage may use, and every check before
// a source is asked, is `context-sources/routes.ts`.
import { agentXError, type OrgId } from "@agentx/contracts";
import { TERMINAL, requireOperation, type CallbackClaims } from "../cancellation.js";
import { droppingSink, emptySearch } from "../../context-sources/team-record.js";
import { callContextTool, listContextTools, type ContextToolsDependencies, type ContextToolsRun } from "../../context-sources/routes.js";
import { dynamoContextSourceStore } from "../../context-sources/store.js";
import { dynamoUsageStore } from "../../context-sources/usage.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { parseBody, verifyCapability } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { requireProjectAuthority, requireWorkspace } from "./records.js";
import { creatorCheckOf } from "./scope-helpers.js";
import { requireCreatorStillMember } from "../../developer/creator-member.js";
import { workspaceTask } from "./task-operations.js";

/** The dependencies of the context-tool routes, built from the broker's own table and what the install supplied (`dependencies.contextSources`). */
export function contextToolsDependencies(dependencies: AwsBrokerDependencies): ContextToolsDependencies | undefined {
  const runtime = dependencies.contextSources;
  if (runtime === undefined) return undefined;
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
  const store = dynamoContextSourceStore(table);
  return {
    now: Date.now,
    requireCreatorStillMember: (task) => requireCreatorStillMember(creatorCheckOf(dependencies), task),
    requireProjectAuthority: (orgId, ownerKey, project, options) => requireProjectAuthority(dependencies, orgId, ownerKey, project, options),
    sources: (orgId, project) => store.readDocument(orgId, project),
    servers: runtime.servers,
    usage: dynamoUsageStore(table),
    teamSink: runtime.teamSink ?? droppingSink,
    teamSearch: runtime.teamSearch ?? emptySearch,
    teamRecordAvailable: runtime.teamRecordAvailable === true,
    citations: runtime.citations,
    results: runtime.results,
    standingOf: runtime.standingOf,
    callTimeoutMs: runtime.callTimeoutMs,
    log: (event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })),
  };
}

/** The empty answer of a deployment with no sources set up. */
const NO_SOURCES = { sources: [], tools: [], searchTeamKnowledge: false, unavailable: [], disabled: [] } as const;

export async function handleContextTools(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, kind: "list" | "call") {
  const token = request.headers["x-agentx-callback-capability"];
  if (!token) throw agentXError("AUTH_REQUIRED", "callback capability is required");
  let claims: CallbackClaims;
  try { claims = verifyCapability(dependencies, token, "context-tools"); }
  catch { throw agentXError("AUTH_REQUIRED", "invalid callback capability"); }
  const operation = await requireOperation(dependencies, claims.workspaceId, claims.operationId);
  if (operation.fence !== claims.fence) throw agentXError("STALE_FENCE", "callback fence is stale");
  if (TERMINAL.has(operation.status) || operation.status === "CANCEL_REQUESTED") throw agentXError("STALE_FENCE", "a finished or stopped step cannot use context tools");
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  if (workspace.activeOperationId !== operation.id) throw agentXError("STALE_FENCE", "operation no longer owns the workspace");
  const task = await workspaceTask(dependencies, workspace.id);
  const orgId: OrgId | undefined = operation.orgId;
  if (orgId === undefined || task === undefined || task.orgId !== orgId || task.workspaceId !== workspace.id || (workspace.orgId !== undefined && workspace.orgId !== orgId)) {
    throw agentXError("NOT_FOUND", "no task belongs to this operation");
  }
  const run: ContextToolsRun = { orgId, task, operation: { id: operation.id, workflowMode: operation.workflowMode } };
  const deps = contextToolsDependencies(dependencies);
  if (deps === undefined) {
    return kind === "list" ? NO_SOURCES : { status: "REFUSED" as const, text: "Sources are not set up in this deployment." };
  }
  return kind === "list" ? listContextTools(deps, run) : callContextTool(deps, run, parseBody(request.body));
}
