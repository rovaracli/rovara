// "Run a command" in a setup run (design setup-test-health 3.4, owner decision 12, task SH13): a person who may edit the project's settings types ONE command; it runs in the run's setup sandbox, is
// journaled with `source: person`, and is shown to the agent as a RESULT, never as an instruction. There is no interactive terminal in v1.
//
// What the broker decides here:
//   - WHO: a project maintainer (`edit_settings`), with the `su` switch on, for a run that is going now (`setupAgentState` says `running`). Anyone else is refused before anything is read about the run.
//   - WHAT: one line of at most 1,000 characters with no control or format characters, and no secret. A command that the redactor would change is REFUSED, not run in a changed form: a person is never
//     allowed to paste a credential into the setup sandbox, and what runs is exactly what they typed.
//   - HOW MANY: one at a time (the run's sandbox is single), at most `SETUP_PERSON_COMMANDS_MAX` per run, and a repeat of a request id is the same command (it returns the first answer and queues nothing).
//   - DELIVERY: the worker asks for it (`takeSetupCommand`, over the worker's setup callback, SH14). The org, project and task come from the authenticated operation, never from the worker's body. A command
//     taken and not finished within the longest a command may run is treated as finished, so a worker that died does not block the box for good.
// Nothing here executes anything. The command's text sits in the table for the length of the run's retention and nowhere else (no log line, no event).
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { z } from "zod";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, projectAllows, redactText, setupDraftKey, type OrgId } from "@agentx/contracts";
import { StatusReply } from "../aws/status-reply.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { readState, type SetupAgentDependencies } from "./setup-agent.js";

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;

/** A command's longest text, and how many a person may run in one setup run. */
export const SETUP_COMMAND_TEXT_MAX = 1_000;
export const SETUP_PERSON_COMMANDS_MAX = 20;
/** The longest a taken command may be out before it is read as finished: the worker's own longest command (an hour) and a little over. */
export const SETUP_COMMAND_TAKEN_STALE_MS = 65 * 60_000;
const KEEP_SECONDS = 31 * 86_400;

export const SetupCommandBodySchema = z.object({ requestId: z.string().uuid(), command: z.string().min(1).max(SETUP_COMMAND_TEXT_MAX * 2) }).strict();

export const SETUP_COMMAND_WORDS = {
  busy: "A command from a person is still running. Wait for it to finish.",
  limit: "This setup run has reached its limit of commands typed by a person.",
  notRunning: "The setup run is not going now, so a command cannot be run.",
  oneLine: "A command is one line of plain text, up to 1,000 characters.",
  secret: "That looks like it holds a secret. Rovara does not run commands with secrets in them.",
  who: "only a project maintainer can run a command in a setup run",
  browserOnly: "Run a command from Rovara's web app: a command needs a signed-in browser, not a token.",
  signInAgain: "Sign in again to run a command.",
} as const;

/** The command a person may run: one plain line, not empty, not too long, and exactly what the redactor would leave. Returns the text, or the fixed sentence for why not. */
export function checkPersonCommand(raw: string): { ok: true; command: string } | { ok: false; reason: "oneLine" | "secret" } {
  const command = raw.trim();
  if (command === "" || command.length > SETUP_COMMAND_TEXT_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command)) return { ok: false, reason: "oneLine" };
  if (redactText(command) !== command) return { ok: false, reason: "secret" };
  return { ok: true, command };
}

interface Scope { orgId: OrgId; project: string; taskId: string }
const partition = (scope: Scope) => setupDraftKey(scope.orgId, scope.project).pk;
const counterKey = (scope: Scope) => ({ pk: partition(scope), sk: `CMDCOUNT#${scope.taskId}` });
const commandKey = (scope: Scope, seq: number) => ({ pk: partition(scope), sk: `CMD#${scope.taskId}#${String(seq).padStart(3, "0")}` });
const commandHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const requestKey = (scope: Scope, requestId: string) => ({ pk: partition(scope), sk: `CMDREQ#${scope.taskId}#${requestId}` });

async function get(client: Client, tableName: string, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

export type CommandState = "queued" | "taken" | "done";
export interface StoredCommand { seq: number; requestId: string; command: string; by: string; state: CommandState; createdAt: string; takenAt?: string; doneAt?: string; journalN?: number }

function commandOf(item: Item | undefined, scope: Scope): StoredCommand | undefined {
  if (item === undefined || item["entityType"] !== "SETUP_COMMAND" || item["taskId"] !== scope.taskId || item["orgId"] !== scope.orgId || item["project"] !== scope.project) return undefined;
  const state = item["state"];
  if ((state !== "queued" && state !== "taken" && state !== "done") || typeof item["seq"] !== "number" || typeof item["command"] !== "string" || typeof item["requestId"] !== "string" || typeof item["by"] !== "string" || typeof item["createdAt"] !== "string") return undefined;
  return {
    seq: item["seq"], requestId: item["requestId"], command: item["command"], by: item["by"], state, createdAt: item["createdAt"],
    ...(typeof item["takenAt"] === "string" ? { takenAt: item["takenAt"] } : {}), ...(typeof item["doneAt"] === "string" ? { doneAt: item["doneAt"] } : {}), ...(typeof item["journalN"] === "number" ? { journalN: item["journalN"] } : {}),
  };
}

/** Whether a command still holds the box: queued, or taken and not yet stale. */
function holdsBox(command: StoredCommand, nowMs: number): boolean {
  if (command.state === "done") return false;
  if (command.state === "queued") return true;
  return nowMs - Date.parse(command.takenAt ?? command.createdAt) < SETUP_COMMAND_TAKEN_STALE_MS;
}

export type QueueOutcome = { status: 202 | 200; seq: number; state: CommandState };

/**
 * Queues one command for the run `scope` names. The caller's authority and the run's state are checked by `runSetupCommand`; this is the store. A repeat of `requestId` answers the first command and writes
 * nothing; a second command while one holds the box, or past the run's limit, is refused with a fixed sentence.
 */
export async function queueSetupCommand(table: { documentClient: Client; tableName: string; now: () => number }, scope: Scope, input: { requestId: string; command: string; by: string }): Promise<QueueOutcome> {
  const repeat = await get(table.documentClient, table.tableName, requestKey(scope, input.requestId));
  if (repeat !== undefined) {
    // The same request id means the same command from the same person: other text (or another person) is a conflict, never answered with the first command.
    if (repeat["by"] !== input.by || typeof repeat["seq"] !== "number" || repeat["commandHash"] !== commandHash(input.command)) throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different command.");
    const first = commandOf(await get(table.documentClient, table.tableName, commandKey(scope, repeat["seq"])), scope);
    return { status: 200, seq: repeat["seq"], state: first?.state ?? "done" };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const counter = await get(table.documentClient, table.tableName, counterKey(scope));
    const count = typeof counter?.["count"] === "number" ? counter["count"] : 0;
    if (count >= SETUP_PERSON_COMMANDS_MAX) throw agentXError("TOO_MANY_REQUESTS", SETUP_COMMAND_WORDS.limit);
    if (count > 0) {
      const latest = commandOf(await get(table.documentClient, table.tableName, commandKey(scope, count)), scope);
      if (latest === undefined || holdsBox(latest, table.now())) throw agentXError("WORKSPACE_BUSY", SETUP_COMMAND_WORDS.busy);
    }
    const seq = count + 1;
    const at = new Date(table.now()).toISOString();
    const expiry = Math.floor(table.now() / 1000) + KEEP_SECONDS;
    try {
      await table.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: table.tableName, Key: counterKey(scope), UpdateExpression: "SET #count = :next, entityType = :type, #expires = :expires",
          ConditionExpression: count === 0 ? "attribute_not_exists(#count)" : "#count = :seen",
          ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
          ExpressionAttributeValues: { ":next": seq, ":type": "SETUP_COMMAND_COUNT", ":expires": expiry, ...(count === 0 ? {} : { ":seen": count }) },
        } },
        { Put: {
          TableName: table.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
            ...commandKey(scope, seq), entityType: "SETUP_COMMAND", orgId: scope.orgId, project: scope.project, taskId: scope.taskId, seq, requestId: input.requestId, command: input.command, by: input.by,
            state: "queued", createdAt: at, [INDEX_EXPIRY_ATTRIBUTE]: expiry,
          },
        } },
        { Put: { TableName: table.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: { ...requestKey(scope, input.requestId), entityType: "SETUP_COMMAND_REQUEST", seq, by: input.by, commandHash: commandHash(input.command), [INDEX_EXPIRY_ATTRIBUTE]: expiry } } },
      ] }));
      return { status: 202, seq, state: "queued" };
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
      // Another request took the place, or this very request committed first: read again.
      const again = await get(table.documentClient, table.tableName, requestKey(scope, input.requestId));
      if (again !== undefined && again["by"] === input.by && typeof again["seq"] === "number" && again["commandHash"] === commandHash(input.command)) return { status: 200, seq: again["seq"], state: "queued" };
      if (again !== undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different command.");
    }
  }
  throw agentXError("WORKSPACE_BUSY", SETUP_COMMAND_WORDS.busy);
}

/**
 * The worker asks for the next command of its run. Returns it once and marks it taken; a second ask while it is out returns nothing. The scope comes from the authenticated operation.
 * The text returned is the person's, exactly as accepted: the worker runs it and shows the result to the agent as data.
 */
export async function takeSetupCommand(
  table: { documentClient: Client; tableName: string; now: () => number }, scope: Scope,
  /** Whether the person who typed it may still change this project (read live at hand-over). A command whose typist was demoted or removed is dropped, never run. Absent: nothing is handed over. */
  mayStillRun?: (by: string) => Promise<boolean>,
): Promise<{ seq: number; command: string; by: string } | undefined> {
  const counter = await get(table.documentClient, table.tableName, counterKey(scope));
  const count = typeof counter?.["count"] === "number" ? counter["count"] : 0;
  if (count === 0) return undefined;
  const latest = commandOf(await get(table.documentClient, table.tableName, commandKey(scope, count)), scope);
  if (latest === undefined || latest.state !== "queued") return undefined;
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: commandKey(scope, count), UpdateExpression: "SET #state = :taken, takenAt = :at",
      ConditionExpression: "#state = :queued", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":taken": "taken", ":queued": "queued", ":at": new Date(table.now()).toISOString() },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return undefined;
    throw error;
  }
  if (mayStillRun === undefined || !(await mayStillRun(latest.by).catch(() => false))) {
    // The typist can no longer act: the command is finished without running (it must not hold the box).
    await finishSetupCommand(table, scope, { seq: latest.seq, skipped: true }).catch(() => false);
    return undefined;
  }
  return { seq: latest.seq, command: latest.command, by: latest.by };
}

/** One stored command of the run (its typist and state), or undefined. Reads only this run's rows. */
export async function readSetupCommand(table: { documentClient: Client; tableName: string }, scope: Scope, seq: number): Promise<StoredCommand | undefined> {
  if (!Number.isInteger(seq) || seq < 1 || seq > SETUP_PERSON_COMMANDS_MAX) return undefined;
  return commandOf(await get(table.documentClient, table.tableName, commandKey(scope, seq)), scope);
}

/** The worker says the command finished and which journal position holds its result. Only a taken command can finish; a repeat changes nothing. */
export async function finishSetupCommand(table: { documentClient: Client; tableName: string; now: () => number }, scope: Scope, input: { seq: number; journalN?: number | undefined; skipped?: boolean }): Promise<boolean> {
  if (!Number.isInteger(input.seq) || input.seq < 1 || input.seq > SETUP_PERSON_COMMANDS_MAX) return false;
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: commandKey(scope, input.seq), UpdateExpression: "SET #state = :done, doneAt = :at" + (input.journalN === undefined ? "" : ", journalN = :n") + (input.skipped === true ? ", skipped = :yes" : ""),
      ConditionExpression: input.skipped === true ? "(#state = :taken OR #state = :queued) AND taskId = :task" : "#state = :taken AND taskId = :task", ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":done": "done", ":taken": "taken", ...(input.skipped === true ? { ":queued": "queued", ":yes": true } : {}), ":task": scope.taskId, ":at": new Date(table.now()).toISOString(), ...(input.journalN === undefined ? {} : { ":n": input.journalN }) },
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/**
 * `POST /v1/app/projects/{name}/setup-agent/command`: a maintainer types one command for the project's running setup run. Not found while `su` is off; refused for anyone who may not edit settings; refused
 * unless the run is going now. Answers 202 (queued) or 200 (a repeat) with the command's place and state; the result appears in the run's journal as an entry from a person.
 */
export async function runSetupCommand(deps: SetupAgentDependencies, caller: DeveloperCaller, rawName: string, rawBody: unknown): Promise<StatusReply> {
  if (!deps.enabled) throw agentXError("NOT_FOUND", "route not found");
  // A command runs code in the setup sandbox, so it is a person's own act at their keyboard: a signed-in browser session whose sign-in is fresh, never a token (a CLI token, an MCP client or a leaked one).
  // Both checks come before anything about the project or the run is read.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", SETUP_COMMAND_WORDS.browserOnly);
  if (deps.requireFreshSignIn === undefined) throw agentXError("FORBIDDEN", SETUP_COMMAND_WORDS.signInAgain);
  await deps.requireFreshSignIn(caller);
  const found = await deps.projectFor(caller, rawName);
  if (!projectAllows(found.role, "edit_settings")) throw agentXError("FORBIDDEN", SETUP_COMMAND_WORDS.who);
  const parsed = SetupCommandBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: invalid`);
  const checked = checkPersonCommand(parsed.data.command);
  if (!checked.ok) throw agentXError("CONFIG_INVALID", SETUP_COMMAND_WORDS[checked.reason]);
  const latest = await deps.latest(caller.orgId, found.name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const state = await readState(deps, caller.orgId, found.name, latest.revision);
  if (state.view.status !== "running" || state.pointer === undefined) throw agentXError("WORKSPACE_BUSY", SETUP_COMMAND_WORDS.notRunning);
  const outcome = await queueSetupCommand(deps, { orgId: caller.orgId, project: found.name, taskId: state.pointer.taskId }, { requestId: parsed.data.requestId, command: checked.command, by: caller.developerId });
  return new StatusReply(outcome.status, { seq: outcome.seq, state: outcome.state });
}
