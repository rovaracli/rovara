// Meta repo lane D: the task owner's choices on a held spec. POST /v1/app/tasks/{id}/spec/{retry|continue|keep|replan}. The task's owner or a co-owner only (the same authority as publishing); the choice is applied to
// the spec's state only when the state is where the choice expects (a late or repeated press is refused as out of date).
import { z } from "zod";
import { agentXError } from "@rovara-code/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../developer-routes.js";
import { specOwnerChoice } from "../developer-tasks/spec-wiring.js";
import { developerTaskRouteDependencies } from "./dependencies.js";

export const SPEC_CHOICE_ROUTE = /^\/v1\/app\/tasks\/([^/]+)\/spec\/(retry|continue|keep|replan)$/u;

const ACTIONS = { retry: "retry", continue: "continue_without_spec", keep: "keep", replan: "replan" } as const;
/** The same choices by the names the task page uses. */
export const SPEC_PAGE_CHOICES = ACTIONS;

/** The body a choice takes: nothing (review M2). The choice is the path's; staleness is the spec state machine's (a late or repeated press is refused as out of date). */
const SpecChoiceBodySchema = z.object({}).strict();

export async function routeSpecChoice(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawTaskId: string, rawAction: string, body: unknown = {}): Promise<{ status: string }> {
  if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  if (!SpecChoiceBodySchema.safeParse(body).success) throw agentXError("CONFIG_INVALID", "a spec choice takes no body fields");
  const action = ACTIONS[rawAction as keyof typeof ACTIONS];
  if (action === undefined) throw agentXError("NOT_FOUND", "route not found");
  let taskId: string;
  try { taskId = decodeURIComponent(rawTaskId); } catch { throw agentXError("NOT_FOUND", "route not found"); }
  return specOwnerChoice(developerTaskRouteDependencies(deps, caller), caller, taskId, action);
}
