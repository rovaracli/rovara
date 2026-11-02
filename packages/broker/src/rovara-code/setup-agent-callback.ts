// The setup run's callback (sh-setup-wire, SH14): ONE worker-to-broker action, `POST /v1/internal/workspaces/{w}/operations/{o}/setup-agent`, for everything a running setup run reports or asks. It is granted
// (capability `setup-agent`) only to a SETUP_AGENT operation while the `su` switch is on, and the route accepts it only for that operation while it RUNS.
//
// The run is never named by the body. The org, the project and the task come from the authenticated operation (its workspace's task pointer and the task's own record: a setup-run task of this company),
// and a person is never named at all: a host ask is credited to the starter the broker recorded on the task (`requestHostAsk` reads it itself; SH14 precondition, tested). The body is a strict union:
//   journal       the commands the run ran, in order (at most 20 a call; the broker reads each again and keeps the first for a position);
//   host          a website the run could not reach: the name only (and where it came from): the broker decides whether it is refused, already allowed, joined or a new ask. Nothing is granted;
//   poll          "anything for me?": the next command a maintainer typed (handed over once), and where each host this run asked for stands (open, approved, refused);
//   command_done  a person's command finished, with the journal position of its result.
// Nothing in a reply is repository or command text except the person's own command (which only a maintainer could type and the broker already checked).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, type OrgId, type TestEnvProdDeny } from "@agentx/contracts";
import { readApprovedTestEnvironment } from "../org/test-environment.js";
import { latestRevision } from "../org/project-settings.js";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { AuditRuntime } from "../audit/outbox.js";
import { appendSetupJournal, SETUP_JOURNAL_BATCH_MAX } from "./setup-journal.js";
import { finishSetupCommand, takeSetupCommand } from "./setup-command.js";
import { listHostAsks, requestHostAsk } from "./setup-host-ask.js";
import { setupAgentEnabled } from "./setup-agent-switch.js";
import { SETUP_AGENT_WORKFLOW_MODE } from "./setup-agent.js";

type Client = { send(command: unknown): Promise<unknown> };
export interface SetupAgentCallbackDependencies { documentClient: Client; tableName: string; now: () => number; audit?: AuditRuntime }
/** The authenticated operation, as the callback route read it. */
export interface SetupAgentOperation { kind: string; workflowMode?: string | undefined; status: string; workspaceId: string; orgId?: string | undefined }

const HostSchema = z.object({
  kind: z.literal("host"),
  host: z.string().min(1).max(300),
  journalN: z.number().int().min(1).max(400).optional(),
  from: z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).max(10_000_000) }).strict().optional(),
}).strict();
export const SetupAgentCallbackBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("journal"), entries: z.array(z.unknown()).min(1).max(SETUP_JOURNAL_BATCH_MAX) }).strict(),
  HostSchema,
  z.object({ kind: z.literal("poll") }).strict(),
  z.object({ kind: z.literal("command_done"), seq: z.number().int().min(1).max(20), journalN: z.number().int().min(1).max(400).optional() }).strict(),
]);
export type SetupAgentCallbackBody = z.infer<typeof SetupAgentCallbackBodySchema>;

const getItem = async <T>(deps: SetupAgentCallbackDependencies, key: { pk: string; sk: string }): Promise<T | undefined> => {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
};

/** The run an operation belongs to: its task, which must be a setup-run task of the operation's company. Undefined for anything else. */
export async function setupRunOfOperation(deps: SetupAgentCallbackDependencies, operation: SetupAgentOperation): Promise<{ orgId: OrgId; project: string; taskId: string } | undefined> {
  if (operation.kind !== "task" || operation.workflowMode !== SETUP_AGENT_WORKFLOW_MODE || operation.status !== "RUNNING") return undefined;
  const pointer = await getItem<DeveloperTaskPointerRecord>(deps, taskPointerKey(operation.workspaceId));
  if (pointer === undefined) return undefined;
  const task = await getItem<DeveloperTaskRecord>(deps, taskKey(pointer.taskId));
  if (task === undefined || task.purpose !== "setup_agent" || task.orgId === undefined || task.workspaceId !== operation.workspaceId || task.closedAt !== undefined) return undefined;
  if (operation.orgId !== undefined && operation.orgId !== task.orgId) return undefined;
  return { orgId: task.orgId, project: task.project, taskId: task.taskId };
}

/** Handles one setup callback. Throws CALLBACK_FORBIDDEN for an operation that is not a running setup run (or while `su` is off), CONFIG_INVALID for a body that is not one of the four shapes. */
export async function handleSetupAgentCallback(deps: SetupAgentCallbackDependencies, operation: SetupAgentOperation, rawBody: unknown, env: NodeJS.ProcessEnv = process.env): Promise<object> {
  if (!setupAgentEnabled(env)) throw agentXError("CALLBACK_FORBIDDEN", "setup runs are not on");
  const run = await setupRunOfOperation(deps, operation);
  if (run === undefined) throw agentXError("CALLBACK_FORBIDDEN", "the setup callback is limited to a running setup run");
  const parsed = SetupAgentCallbackBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the setup callback body is not one of its shapes");
  const body = parsed.data;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  switch (body.kind) {
    case "journal":
      return appendSetupJournal(table, run, body.entries);
    case "host": {
      const latest = await latestRevision({ documentClient: deps.documentClient, tableName: deps.tableName }, run.orgId, run.project);
      const projectDomains = latest?.definition.network?.allowedDomains ?? [];
      const prodDeny = await prodDenyOf(deps, run.orgId, run.project);
      const outcome = await requestHostAsk(table, { ...run, host: body.host, projectDomains, prodDeny, ...(body.journalN === undefined ? {} : { journalN: body.journalN }), ...(body.from === undefined ? {} : { from: body.from }) });
      // A fixed word and nothing else: the worker learns whether it may wait for an answer, never why in words of its own.
      return { outcome: outcome.outcome, ...(outcome.outcome === "refused" ? { reason: outcome.reason } : {}) };
    }
    case "poll": {
      const command = await takeSetupCommand(table, run);
      const asks = (await listHostAsks(table, run.orgId, run.project, ["open", "approved", "refused"])).filter((ask) => ask.taskId === run.taskId).slice(0, 20);
      return { ...(command === undefined ? {} : { command }), hosts: asks.map((ask) => ({ host: ask.host, state: ask.state })) };
    }
    case "command_done":
      return { finished: await finishSetupCommand(table, run, { seq: body.seq, journalN: body.journalN }) };
  }
}

/** The company's production deny list, for the refusal check at ASK time. A list that cannot be read here does not stop the ask: the approval reads it again and fails closed. */
async function prodDenyOf(deps: SetupAgentCallbackDependencies, orgId: OrgId, project: string): Promise<TestEnvProdDeny | undefined> {
  try { return (await readApprovedTestEnvironment({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) }, orgId, project))?.environment.prodDeny; }
  catch { return undefined; }
}
