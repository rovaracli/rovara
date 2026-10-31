// Meta repo lane F (F1): the routes of intake. A project's people who can start tasks see the tickets that wait for a member and say "Start"; a maintainer sets the places work is asked for.
//   GET  /v1/app/projects/{project}/intake                   the waiting tickets and the sources           (a role that starts tasks)
//   POST /v1/app/projects/{project}/intake/{itemId}/start     a member says "Start" for a waiting ticket   (a role that starts tasks; the work is theirs)
//   PUT  /v1/app/projects/{project}/intake/sources            replace the project's sources                (a maintainer: edit_settings)
// Another org's project, and one the caller has no role in, answer the same 404 as a missing one (`projectFor`). The ticket's words are shown as text only; the page never builds a link from them.
import { IntakeStartBodySchema, IntakeChannelRefSchema, agentXError, projectAllows, type IntakeWaitingItem, type ProjectRole } from "@agentx/contracts";
import { z } from "zod";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { StatusReply } from "../aws/status-reply.js";
import { startWaitingIntake, type IntakePorts } from "./engine.js";
import { INTAKE_MAX_SOURCES_PER_PROJECT, intakeSourceIdOf, listIntakeSources, replaceIntakeSources } from "./sources.js";
import { listWaitingIntakeItems, type IntakeItemRecord } from "./store.js";

/** The paths this module owns under `/v1/app/projects/`. */
export const INTAKE_PATH = /^\/v1\/app\/projects\/([^/]+)\/intake(?:\/(sources)|\/([a-f0-9]{32})\/(start))?$/;

export interface IntakeRouteDependencies {
  ports: IntakePorts;
  /** The caller's role on a project they can see, or the same `PROJECT_NOT_FOUND` for no access, no such project and another org's project. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
}

const PutSourcesBodySchema = z.object({ sources: z.array(IntakeChannelRefSchema).max(INTAKE_MAX_SOURCES_PER_PROJECT) }).strict();

function parsed<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  // Field names only: the values are the person's text.
  throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
}

const WAITING_ITEM_CHANNELS: ReadonlySet<string> = new Set(["jira", "github_issue", "tracker"]);

function viewOf(record: IntakeItemRecord): IntakeWaitingItem {
  return {
    itemId: record.itemId, channel: record.channel, system: record.system, id: record.id, url: record.url, title: record.title,
    requester: { display: record.requester.display, standing: record.requester.standing },
    reason: record.reason ?? "outsider", ...(record.lastRefusal === undefined ? {} : { lastRefusal: record.lastRefusal }), waitingSince: record.since,
  };
}

export async function routeIntakeRequest(deps: IntakeRouteDependencies, caller: DeveloperCaller, method: string, match: RegExpExecArray, body: unknown): Promise<StatusReply> {
  const { name, role } = await deps.projectFor(caller, match[1]!);
  const table = deps.ports.table;
  if (match[2] === "sources") {
    if (method !== "PUT") throw agentXError("NOT_FOUND", "no such route");
    if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", `Only a maintainer of ${name} can change where its work is asked for.`);
    const { sources } = parsed(PutSourcesBodySchema, body);
    if (new Set(sources.map(intakeSourceIdOf)).size !== sources.length) throw agentXError("CONFIG_INVALID", "sources: the same place is named twice");
    const saved = await replaceIntakeSources(table, { orgId: caller.orgId, project: name, refs: sources, setBy: caller.developerId });
    return new StatusReply(200, { sources: saved.map((record) => ({ sourceId: record.sourceId, ref: record.ref, failing: record.failures > 0 })) });
  }
  if (!projectAllows(role, "start_tasks")) throw agentXError("FORBIDDEN", `You can view ${name} but not start tasks in it.`);
  if (match[3] !== undefined) {
    if (method !== "POST") throw agentXError("NOT_FOUND", "no such route");
    parsed(IntakeStartBodySchema, body);
    const outcome = await startWaitingIntake(deps.ports, { orgId: caller.orgId, project: name, itemId: match[3], approver: caller.developerId });
    if (outcome.outcome === "not_found") throw agentXError("NOT_FOUND", "no such waiting ticket");
    if (outcome.outcome === "forbidden") throw agentXError("FORBIDDEN", `You can't start work on ${name}.`);
    if (outcome.outcome === "started") return new StatusReply(202, { started: true, taskId: outcome.taskId, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) });
    if (outcome.outcome === "waiting") return new StatusReply(200, { started: false, reason: outcome.reason });
    return new StatusReply(200, { started: false, state: outcome.outcome === "duplicate" ? outcome.state : "waiting" });
  }
  if (method !== "GET") throw agentXError("NOT_FOUND", "no such route");
  const waiting = (await listWaitingIntakeItems(table, caller.orgId, name)).filter((record) => WAITING_ITEM_CHANNELS.has(record.channel));
  const sources = await listIntakeSources(table, caller.orgId, name);
  return new StatusReply(200, { items: waiting.map(viewOf), sources: sources.map((record) => ({ sourceId: record.sourceId, ref: record.ref, failing: record.failures > 0 })) });
}
