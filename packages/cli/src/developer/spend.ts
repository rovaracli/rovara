// Plan 3 Task 35a and 35b: an agent's budget and a project's AI settings from the command line (`agentx agents budget`, `agentx project ai set`).
// An amount is US dollars, or `none` to clear it. A change that goes past a cap someone else must raise answers (from Task 32) 202
// { status: "NEEDS_ADMIN_APPROVAL", spendRequestId, message }; the broker's words and the request's id are printed and it is not a failure.
import { randomUUID } from "node:crypto";
import { agentXError } from "@rovara-code/contracts";
import { appRequest, clean, list, result, seg, str, taskStatusLine, waitingText, type AppResult } from "./agents.js";
import { jsonSafe } from "./audit.js";
import type { DeveloperSessionDeps } from "./session.js";

type Body = Record<string, unknown>;

/** `--flag <usd|none>`: a dollar amount of at least 0, or none (null, which clears it). Undefined when the flag was not given. */
export function parseUsdOrNone(raw: string | undefined, flag: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim().toLowerCase() === "none") return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw.trim())) throw agentXError("CONFIG_INVALID", `${flag} takes a dollar amount such as 50 or 12.50, or none`);
  return Number(raw.trim());
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
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/budget`, {
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
  input: { budget?: string; projectPays?: string; planningQuick?: string; planningFull?: string; memberAcceptRunLimit?: string },
): Promise<AppResult> {
  const monthlyBudgetUsd = parseUsdOrNone(input.budget, "--budget");
  if (input.projectPays !== undefined && !(input.projectPays in ON_OFF)) throw agentXError("CONFIG_INVALID", "--project-pays takes on or off");
  const projectPays = input.projectPays === undefined ? undefined : ON_OFF[input.projectPays as keyof typeof ON_OFF];
  // none resets a planning limit to the default (review M11).
  const quick = parseUsdOrNone(input.planningQuick, "--planning-quick");
  const full = parseUsdOrNone(input.planningFull, "--planning-full");
  const planningLimitUsd = quick === undefined && full === undefined ? undefined : { ...(quick === undefined ? {} : { QUICK: quick }), ...(full === undefined ? {} : { FULL: full }) };
  // What a member may accept as a run limit when the project pays (none puts the default back).
  const memberAcceptRunLimitUpToUsd = parseUsdOrNone(input.memberAcceptRunLimit, "--member-accept-run-limit");
  if (monthlyBudgetUsd === undefined && projectPays === undefined && planningLimitUsd === undefined && memberAcceptRunLimitUpToUsd === undefined) {
    throw agentXError("CONFIG_INVALID", "give at least one of --budget, --project-pays, --planning-quick, --planning-full and --member-accept-run-limit");
  }
  const answer = await appRequest(deps, env, `/v1/app/projects/${seg(project)}/ai`, {
    method: "PUT",
    body: {
      requestId: randomUUID(),
      ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd }),
      ...(projectPays === undefined ? {} : { projectPays }),
      ...(planningLimitUsd === undefined ? {} : { planningLimitUsd }),
      ...(memberAcceptRunLimitUpToUsd === undefined ? {} : { memberAcceptRunLimitUpToUsd }),
    },
  });
  const settings = (answer.body.settings ?? {}) as Body;
  const effective = ((answer.body.effective as Body | undefined)?.planningLimitUsd ?? {}) as Body;
  const text = [
    `Saved the AI settings of ${clean(project)} (revision ${typeof answer.body.revision === "number" ? String(answer.body.revision) : "?"}):`,
    `  monthly budget: ${money(settings.monthlyBudgetUsd, "none")}`,
    `  the project pays for its runs: ${settings.projectPays === true ? "yes" : "no"}`,
    `  planning limits: quick ${money(effective.QUICK, "default")}, full ${money(effective.FULL, "default")}`,
    `  a member accepts a run limit up to ${money(((answer.body.effective as Body | undefined)?.memberAcceptRunLimitUpToUsd), "$10")} when the project pays`,
    "",
  ].join("\n");
  return { env: answer.env, url: answer.url, data: jsonSafe(answer.body) as Body, text };
}

// ---- what has been spent (Task 35b)

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `--month YYYY-MM`, checked before anything is sent; undefined when not given. */
function parseMonth(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!MONTH.test(raw)) throw agentXError("CONFIG_INVALID", "--month takes a month as YYYY-MM, such as 2026-10");
  return raw;
}

const dollars = (value: unknown): string => (typeof value === "number" ? `$${String(value)}` : "$0");
const named = (rows: Body[], key: string, indent = "  "): string[] => rows.map((row) => `${indent}${str(row[key])}  ${dollars(row.spentUsd)}${typeof row.committedUsd === "number" && row.committedUsd > 0 ? `  (committed ${dollars(row.committedUsd)})` : ""}`);

export async function agentsSpend(deps: DeveloperSessionDeps, env: string | undefined, agentId: string, input: { month?: string }): Promise<AppResult> {
  const month = parseMonth(input.month);
  const answer = await appRequest(deps, env, `/v1/app/agents/${seg(agentId)}/spend${month === undefined ? "" : `?month=${month}`}`);
  const body = answer.body;
  const origins = Object.entries((body.byOrigin ?? {}) as Body).map(([origin, usd]) => `    ${str(origin)}  ${dollars(usd)}`);
  const budget = body.budget as Body | undefined;
  const runs = list(body.recentRuns).map((run) => `    ${str(run.taskId, "(no task)")}  ${str(run.project)}  ${str(run.origin)}  ${dollars(run.usd)}  ${str(run.lastAt)}`);
  const lines = [
    `Spend of ${clean(agentId)} in ${str(body.month)}: ${dollars(body.totalUsd)}`,
    ...(budget === undefined ? ["  monthly budget: none"] : [`  monthly budget: ${dollars(budget.spentUsd)} of ${dollars(budget.limitUsd)}`]),
    ...(typeof body.maxPerRunUsd === "number" ? [`  most per run: ${dollars(body.maxPerRunUsd)}`] : []),
    ...(origins.length === 0 ? [] : ["  where its runs came from:", ...origins]),
    ...(runs.length === 0 ? ["  no runs this month"] : ["  recent runs:", ...runs]),
  ];
  return result(answer, body, `${lines.join("\n")}\n`);
}

export async function orgSpend(deps: DeveloperSessionDeps, env: string | undefined, input: { month?: string; ledger?: boolean; cursor?: string }): Promise<AppResult> {
  const month = parseMonth(input.month);
  if (input.cursor !== undefined && input.ledger !== true) throw agentXError("CONFIG_INVALID", "--cursor goes with --ledger");
  // A cursor belongs to the month it was printed for: applied to another month it would skip or repeat lines.
  if (input.cursor !== undefined && month === undefined) throw agentXError("CONFIG_INVALID", "--cursor needs --month, the month the cursor was printed for");
  const query = [...(month === undefined ? [] : [`month=${month}`]), ...(input.cursor === undefined ? [] : [`cursor=${encodeURIComponent(input.cursor)}`])].join("&");
  const answer = await appRequest(deps, env, `/v1/app/org/spend${input.ledger === true ? "/ledger" : ""}${query === "" ? "" : `?${query}`}`);
  const body = answer.body;
  if (input.ledger === true) {
    const lines = list(body.lines).map((line) =>
      `  ${str(line.at)}  ${dollars(line.settledUsd ?? line.usd)}${line.finalized === true ? "" : " (not final)"}  ${str(line.model)}  ${str(line.project)}  ${str(line.origin)}  ${str(line.taskId ?? line.operationId, "-")}`);
    // The cursor is printed only as the broker sent it: URL-safe base64 characters, which no cleaning changes.
    const next = typeof body.next !== "string" ? []
      : /^[A-Za-z0-9_-]+$/.test(body.next) ? [`More lines follow: agentx org spend --ledger --month ${str(body.month)} --cursor ${body.next}`]
        : ["More lines follow, but the cursor AgentX sent is not one this command can use, so the ledger can't be paged from here."];
    return result(answer, body, `${[`Settled spend lines of ${str(body.month)}, newest first:`, ...(lines.length === 0 ? ["  none"] : lines), ...next].join("\n")}\n`);
  }
  const section = (title: string, rows: Body[], key: string): string[] => (rows.length === 0 ? [] : [`${title}:`, ...named(rows, key)]);
  const lines = [
    `The organization's spend in ${str(body.month)}: ${dollars(body.totalUsd)}${typeof body.committedUsd === "number" && body.committedUsd > 0 ? ` (committed ${dollars(body.committedUsd)})` : ""}${typeof body.limitUsd === "number" ? ` of a ${dollars(body.limitUsd)} limit` : ""}`,
    ...section("By project", list(body.byProject), "project"), ...section("By member", list(body.byMember), "developerId"), ...section("By agent", list(body.byAgent), "agentId"),
    ...section("By AI source", list(body.bySource), "source"), ...section("By model", list(body.byModel), "model"),
  ];
  return result(answer, body, `${lines.join("\n")}\n`);
}

// ---- spend requests (R66: read and link only; a person decides one on its confirmation page)

export async function spendRequestsList(deps: DeveloperSessionDeps, env: string | undefined): Promise<AppResult> {
  const answer = await appRequest(deps, env, "/v1/app/spend-requests");
  const requests = list(answer.body.spendRequests);
  if (requests.length === 0) return result(answer, { spendRequests: requests }, "No spend requests wait for you.\n");
  const lines = requests.map((request) =>
    `  ${str(request.spendRequestId)}  ${str(request.kind)}  ${str(request.status)}  ${dollars(request.amountUsd)}${typeof request.newLimitUsd === "number" ? ` (new limit ${dollars(request.newLimitUsd)})` : ""}  until ${str(request.expiresAt)}\n      ${str(request.reason)}`);
  return result(answer, { spendRequests: requests }, `${["Spend requests (decide each on its page: agentx spend-requests open <id>):", ...lines].join("\n")}\n`);
}

// ---- a task's way past its limit (Task 32 and the re-ask)

export async function taskContinueAsTask(deps: DeveloperSessionDeps, env: string | undefined, taskId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/tasks/${seg(taskId)}/continue-as-task`, { method: "POST", body: { requestId: randomUUID() } });
  const task = (answer.body.task ?? {}) as Body;
  return result(answer, answer.body, `Task ${str(task.taskId, clean(taskId))} now continues as a normal task (${taskStatusLine(task)}). It counts against your monthly limit and its project's budget.\n`);
}

/** Asks again for a blocked plan's run limit once the last request was denied or ran out. It asks; a person decides the new request on its page (R66). */
export async function taskAskRunLimit(deps: DeveloperSessionDeps, env: string | undefined, taskId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/tasks/${seg(taskId)}/run-limit-request`, { method: "POST", body: { requestId: randomUUID() } });
  const id = str(answer.body.spendRequestId);
  const text = answer.body.created === true ? `The run limit was asked for again. Request: ${id}\nA person who may approve it does so on its page: agentx spend-requests open ${id}\n`
    : `A request for this run limit is already open, so none was made. Request: ${id}\nA person who may approve it does so on its page: agentx spend-requests open ${id}\n`;
  return result(answer, answer.body, text);
}
