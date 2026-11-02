// The app routes of the Team record (task R9): `/v1/app/projects/{project}/record/...`. This module is the whole handler; the one line that calls it from the
// developer routes is the controller's (that file is being split). It returns undefined for a path that is not a record route. The caller, with the project role
// the existing access check found, is built by `buildRecordCaller`; a person with no project role is refused before anything is read. Replies are checked against
// their strict schemas on the way out, and every failure is a fixed code: no text from an error, a row or a source reaches the reply.
import {
  PastWorkQuerySchema,
  RecordFactsQuerySchema,
  RecordProjectSchema,
  RecordSearchQuerySchema,
  agentXError,
  AgentXError,
  type OrgId,
  type ProjectRole,
} from "@agentx/contracts";
import { recordFacts, pastWork, recordSearch, recordStats, type RecordQueryDependencies } from "./query.js";
import { listSourceConfigs } from "./store.js";
import type { CallerIdentities, RecordCaller } from "./types.js";

/** Maps a person to their identity at each source (Slack user ids, GitHub numeric ids, tracker ids) from the linked identities. Undefined or empty means "unmapped": it matches nothing. */
export interface IdentityPort {
  identitiesOf(orgId: OrgId, developerId: string): Promise<CallerIdentities | undefined>;
}

export async function buildRecordCaller(identities: IdentityPort, input: { orgId: OrgId; developerId: string; projectRole: ProjectRole | undefined }): Promise<RecordCaller> {
  let found: CallerIdentities | undefined;
  try {
    found = await identities.identitiesOf(input.orgId, input.developerId);
  } catch {
    found = undefined;
  }
  return { orgId: input.orgId, developerId: input.developerId, projectRole: input.projectRole, identities: found ?? { ids: {}, groups: {} } };
}

export interface RecordRouteRequest {
  method: string;
  path: string;
  /** The query string as key and value pairs. */
  query: Readonly<Record<string, string | undefined>>;
  caller: RecordCaller;
}
export interface RecordRouteReply { status: number; body: unknown }

const ROUTE = /^\/v1\/app\/projects\/([^/]+)\/record\/(search|facts|past-work|sources|stats\/[a-z_]+)$/;

function numberOf(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function handleRecordRoute(deps: RecordQueryDependencies, request: RecordRouteRequest): Promise<RecordRouteReply | undefined> {
  const match = ROUTE.exec(request.path);
  if (match === null) return undefined;
  if (request.method !== "GET") return { status: 405, body: { code: "CONFIG_INVALID", message: "That method is not allowed here." } };
  const project = RecordProjectSchema.safeParse(decodeURIComponent(match[1] ?? ""));
  if (!project.success) return { status: 404, body: { code: "PROJECT_NOT_FOUND", message: "No such project." } };
  const audience = { kind: "caller" as const, caller: request.caller };
  const route = match[2] as string;
  try {
    if (route === "search") {
      const parsed = RecordSearchQuerySchema.safeParse({
        query: request.query.query, limit: numberOf(request.query.limit), ...(request.query.since === undefined ? {} : { since: request.query.since }), ...(request.query.until === undefined ? {} : { until: request.query.until }),
        ...(request.query.kinds === undefined ? {} : { kinds: request.query.kinds.split(",") }), ...(request.query.sources === undefined ? {} : { sources: request.query.sources.split(",") }),
      });
      if (!parsed.success) return { status: 400, body: { code: "CONFIG_INVALID", message: "The search is not valid." } };
      return { status: 200, body: await recordSearch(deps, audience, project.data, parsed.data) };
    }
    if (route === "facts") {
      const parsed = RecordFactsQuerySchema.safeParse({ limit: numberOf(request.query.limit), ...(request.query.since === undefined ? {} : { since: request.query.since }), ...(request.query.kinds === undefined ? {} : { kinds: request.query.kinds.split(",") }) });
      if (!parsed.success) return { status: 400, body: { code: "CONFIG_INVALID", message: "The request is not valid." } };
      return { status: 200, body: await recordFacts(deps, audience, project.data, parsed.data) };
    }
    if (route === "past-work") {
      const parsed = PastWorkQuerySchema.safeParse({ query: request.query.query, limit: numberOf(request.query.limit) });
      if (!parsed.success) return { status: 400, body: { code: "CONFIG_INVALID", message: "The search is not valid." } };
      return { status: 200, body: await pastWork(deps, audience, request.query.audience === "shared" ? "shared" : "private", project.data, parsed.data) };
    }
    if (route === "sources") {
      if (request.caller.projectRole === undefined) throw agentXError("PROJECT_ACCESS_DENIED", "You don't have access to this project.");
      const rows = await listSourceConfigs(deps.table, request.caller.orgId, project.data);
      // The approval and who added a source are the maintainers' business; a member reads what is kept and how.
      // What the record left out because the author is not a linked Rovara person, per source: for the project's maintainers (TRW-4). Counts only.
      const skippedUnlinked = request.caller.projectRole === "maintainer" && deps.skipped !== undefined ? await deps.skipped.read(request.caller.orgId, project.data) : undefined;
      return { status: 200, body: { sources: rows.map(({ approval: _approval, addedBy: _addedBy, ...row }) => row), ...(skippedUnlinked === undefined ? {} : { skippedUnlinked }) } }; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    }
    const template = route.slice("stats/".length);
    return { status: 200, body: await recordStats(deps, audience, project.data, { template, params: Object.fromEntries(Object.entries(request.query).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }) };
  } catch (error) {
    if (error instanceof AgentXError) return { status: error.statusCode, body: { code: error.code, message: error.message.slice(error.code.length + 2) } };
    return { status: 503, body: { code: "RUNTIME_UNAVAILABLE", message: "The team record can't be read right now." } };
  }
}
