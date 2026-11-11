// Plan 4 Task 18: triggers from the command line. `agentx chains triggers list | set | remove | activity <chain>` and `agentx agents triggers list | set | remove | activity
// <agent>`, each one signed-in call to the control plane's `/v1/app/{chains,agents}/{id}/triggers` routes. The control plane decides who may do what. Turning a trigger on is
// a person's decision on the confirmation page (R66): a change that does so prints the page's link, and nothing here confirms anything.
import { randomUUID } from "node:crypto";
import { agentXError, newPrefixedId } from "@rovara-code/contracts";
import { appRequest, clean, list, positive, readJsonFile, result, seg, str, waitingText, type AppResult } from "./agents.js";
import type { DeveloperSessionDeps } from "./session.js";

type Body = Record<string, unknown>;
export type TriggerOwnerKind = "chains" | "agents";

const base = (kind: TriggerOwnerKind, id: string) => `/v1/app/${kind}/${seg(id)}/triggers`;

/** What a trigger does, in words: `github pull_request.opened` or `every 60 minutes`. */
function specLine(spec: Body): string {
  if (spec.kind === "event") {
    const filter = Object.entries((spec.filter ?? {}) as Body).map(([key, values]) => `${clean(key)} is ${Array.isArray(values) ? (values as unknown[]).map((value) => str(value)).join(" or ") : ""}`);
    return `${str(spec.source)} ${str(spec.type)}${filter.length === 0 ? "" : ` where ${filter.join(", ")}`}`;
  }
  const schedule = (spec.schedule ?? {}) as Body;
  const when = schedule.kind === "interval" ? `every ${str(schedule.minutes)} minutes`
    : schedule.kind === "daily" ? `daily at ${str(schedule.at)}${Array.isArray(schedule.days) ? ` on ${(schedule.days as unknown[]).map((day) => str(day)).join(", ")}` : ""}`
      : `weekly on ${str(schedule.day)} at ${str(schedule.at)}`;
  return `${when} (${str(spec.timezone)})`;
}

const triggerLine = (trigger: Body): string => {
  const state = trigger.enabled === true ? "on" : `off${trigger.disabledReason === undefined ? "" : ` (${str(trigger.disabledReason)})`}`;
  return `  ${str(trigger.triggerId)}  ${state}  ${str(trigger.project)}  ${specLine((trigger.spec ?? {}) as Body)}  up to ${str(trigger.maxRunsPerHour)} an hour`;
};

export async function triggersList(deps: DeveloperSessionDeps, env: string | undefined, kind: TriggerOwnerKind, id: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, base(kind, id));
  const triggers = list(answer.body.triggers);
  const text = triggers.length === 0 ? `${clean(id)} has no triggers. Add one with agentx ${kind} triggers set ${clean(id)} --project <project> --file <spec.json>.\n` : `${[`Triggers of ${clean(id)}:`, ...triggers.map(triggerLine)].join("\n")}\n`;
  return result(answer, { triggers }, text);
}

/** Sets a trigger from a spec file (`{ "kind": "event", "source": "github", "type": "pull_request.opened" }` or a schedule). With no `--trigger-id` it adds a new one. */
export async function triggersSet(
  deps: DeveloperSessionDeps, env: string | undefined, kind: TriggerOwnerKind, id: string,
  input: { triggerId?: string; project?: string; file?: string; hookId?: string; enabled?: boolean; maxRunsPerHour?: string },
): Promise<AppResult> {
  if (input.project === undefined || input.project.trim() === "") throw agentXError("CONFIG_INVALID", "name the project with --project");
  // Read before anything is sent: a spec that can't be read is not worth a request.
  const spec = await readJsonFile(input.file, "--file", "object");
  const triggerId = input.triggerId ?? newPrefixedId("ctr");
  const body = {
    requestId: randomUUID(), project: input.project, spec,
    ...(input.hookId === undefined ? {} : { hookId: input.hookId }), ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.maxRunsPerHour === undefined ? {} : { maxRunsPerHour: positive(input.maxRunsPerHour, "--max-runs-per-hour") }),
  };
  const answer = await appRequest(deps, env, `${base(kind, id)}/${seg(triggerId)}`, { method: "PUT", body });
  const waiting = waitingText(answer.body);
  if (waiting !== undefined) return result(answer, answer.body, `Saved trigger ${clean(triggerId)}, turned off until a person confirms it.\n${waiting}`);
  const trigger = (answer.body.trigger ?? {}) as Body;
  return result(answer, answer.body, `Saved trigger ${str(trigger.triggerId, clean(triggerId))}: ${trigger.enabled === true ? "on" : "off"}.\n`);
}

export async function triggersRemove(deps: DeveloperSessionDeps, env: string | undefined, kind: TriggerOwnerKind, id: string, triggerId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `${base(kind, id)}/${seg(triggerId)}`, { method: "DELETE", body: { requestId: randomUUID() } });
  return result(answer, answer.body, `Removed trigger ${clean(triggerId)}.\n`);
}

export async function triggersActivity(deps: DeveloperSessionDeps, env: string | undefined, kind: TriggerOwnerKind, id: string, triggerId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `${base(kind, id)}/${seg(triggerId)}/activity`);
  const activity = list(answer.body.activity);
  const lines = activity.map((entry) => `  ${str(entry.at)}  ${str(entry.outcome)}  ${str(entry.eventKey)}${entry.reason === undefined ? "" : `  ${str(entry.reason)}`}${entry.runId === undefined ? "" : `  run ${str(entry.runId)}`}${entry.taskId === undefined ? "" : `  task ${str(entry.taskId)}`}`);
  return result(answer, { activity }, `${activity.length === 0 ? `Nothing yet for ${clean(triggerId)}.` : [`Activity of ${clean(triggerId)}, newest first:`, ...lines].join("\n")}\n`);
}
