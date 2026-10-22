// Plan 3 Task 35a: an agent's budget and a project's AI settings from the command line (`agentx agents budget`, `agentx project ai set`).
// An amount is US dollars, or `none` to clear it. A change that goes past a cap someone else must raise answers 202 with the broker's words
// and the request's id; that is printed and is not a failure.
import { randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import { sanitizeServerText } from "../auth.js";
import { appRequest, waitingText, type AppResult } from "./agents.js";
import { jsonSafe } from "./audit.js";
import type { DeveloperSessionDeps } from "./session.js";

const clean = sanitizeServerText;
type Body = Record<string, unknown>;

/** `--flag <usd|none>`: a dollar amount of at least 0, or none (null, which clears it). Undefined when the flag was not given. */
export function parseUsdOrNone(raw: string | undefined, flag: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim().toLowerCase() === "none") return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw.trim())) throw agentXError("CONFIG_INVALID", `${flag} takes a dollar amount such as 50 or 12.50, or none`);
  return Number(raw.trim());
}

/** `--flag <usd>`: a dollar amount; none is not taken where the setting has no "unlimited". */
function parseUsd(raw: string | undefined, flag: string): number | undefined {
  const value = parseUsdOrNone(raw, flag);
  if (value === null) throw agentXError("CONFIG_INVALID", `${flag} takes a dollar amount such as 2 or 0.50`);
  return value;
}

const money = (value: unknown, none: string) => (typeof value === "number" ? `$${String(value)}` : none);

/** A change that waits on someone else: the broker's message and the request's id. */
function requestedText(body: Body): string | undefined {
  if (typeof body.message !== "string") return undefined;
  const id = body.requestId ?? body.spendRequestId;
  return `${clean(body.message)}${typeof id === "string" ? `\nRequest: ${clean(id)}` : ""}\n`;
}

export async function agentsBudget(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, input: { monthly?: string; maxPerRun?: string }): Promise<AppResult> {
  const monthlyUsd = parseUsdOrNone(input.monthly, "--monthly");
  const maxPerRunUsd = parseUsdOrNone(input.maxPerRun, "--max-per-run");
  if (monthlyUsd === undefined && maxPerRunUsd === undefined) throw agentXError("CONFIG_INVALID", "give --monthly <usd|none>, --max-per-run <usd|none>, or both");
  const answer = await appRequest(deps, env, `/v1/app/agents/${encodeURIComponent(agentId)}/budget`, {
    method: "PUT",
    body: { requestId: randomUUID(), ...(monthlyUsd === undefined ? {} : { monthlyUsd }), ...(maxPerRunUsd === undefined ? {} : { maxPerRunUsd }) },
  });
  const agent = (answer.body.agent ?? {}) as Body;
  const text = answer.status === 202 ? requestedText(answer.body) ?? waitingText(answer.body) ?? "The change waits for someone else.\n"
    : `${clean(agentId)} now has a monthly budget of ${money(agent.monthlyBudgetUsd, "none")} and at most ${money(agent.maxPerRunUsd, "no limit")} per run.\n`;
  return { env: answer.env, url: answer.url, data: jsonSafe(answer.body) as Body, text };
}

const ON_OFF = { on: true, off: false } as const;

export async function projectAiSet(
  deps: DeveloperSessionDeps, env: string | undefined, project: string,
  input: { budget?: string; projectPays?: string; planningQuick?: string; planningFull?: string },
): Promise<AppResult> {
  const monthlyBudgetUsd = parseUsdOrNone(input.budget, "--budget");
  if (input.projectPays !== undefined && !(input.projectPays in ON_OFF)) throw agentXError("CONFIG_INVALID", "--project-pays takes on or off");
  const projectPays = input.projectPays === undefined ? undefined : ON_OFF[input.projectPays as keyof typeof ON_OFF];
  const quick = parseUsd(input.planningQuick, "--planning-quick");
  const full = parseUsd(input.planningFull, "--planning-full");
  const planningLimitUsd = quick === undefined && full === undefined ? undefined : { ...(quick === undefined ? {} : { QUICK: quick }), ...(full === undefined ? {} : { FULL: full }) };
  if (monthlyBudgetUsd === undefined && projectPays === undefined && planningLimitUsd === undefined) {
    throw agentXError("CONFIG_INVALID", "give at least one of --budget, --project-pays, --planning-quick and --planning-full");
  }
  const answer = await appRequest(deps, env, `/v1/app/projects/${encodeURIComponent(project)}/ai`, {
    method: "PUT",
    body: {
      requestId: randomUUID(),
      ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd }),
      ...(projectPays === undefined ? {} : { projectPays }),
      ...(planningLimitUsd === undefined ? {} : { planningLimitUsd }),
    },
  });
  const settings = (answer.body.settings ?? {}) as Body;
  const effective = ((answer.body.effective as Body | undefined)?.planningLimitUsd ?? {}) as Body;
  const text = [
    `Saved the AI settings of ${clean(project)} (revision ${typeof answer.body.revision === "number" ? String(answer.body.revision) : "?"}):`,
    `  monthly budget: ${money(settings.monthlyBudgetUsd, "none")}`,
    `  the project pays for its runs: ${settings.projectPays === true ? "yes" : "no"}`,
    `  planning limits: quick ${money(effective.QUICK, "default")}, full ${money(effective.FULL, "default")}`,
    "",
  ].join("\n");
  return { env: answer.env, url: answer.url, data: jsonSafe(answer.body) as Body, text };
}
