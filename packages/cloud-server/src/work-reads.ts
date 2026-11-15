// The Work page's reads (the split inbox, DEC 223): the person's tasks and, for the one task they select, its plan, proof index, events and plan comments.
// Each is one call to Rovara Code as the signed-in person (contract v0: tasks.list, tasks.plan, tasks.evidence.list, tasks.events, tasks.comments.list),
// kept to the fields the page draws. Code decides who may read a task; its refusal, a 404 included, reaches the app as Code worded it. Nothing here
// writes, and nothing is invented: a field Code did not send is left out.
import type { Route, RouteAnswer } from "./routes.js";

/** Code's task view, version 2. */
const TASK_VIEW = { "x-agentx-task-view": "2" };
/** How many tasks the list answers, and how many events or comments one task answers. A bound on every read. */
export const WORK_TASKS_MAX = 100;
const EVENTS_MAX = 100;
const COMMENTS_MAX = 100;
const TEXT_MAX = 2000;
/** How many of the person's newest sessions the list matches to tasks (a bound on the store read, like Home's). */
const SESSIONS_LOOKED_AT = 200;
const TASK_ID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = TEXT_MAX): string | undefined => (typeof value === "string" ? value.slice(0, max) : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
/** An object holding only the entries whose value is defined. */
const some = (entries: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);

/** One task as the list draws it: the workflow's stage and state, the pull requests, what it has cost and its limit. */
export function workTask(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw) || typeof raw["taskId"] !== "string" || typeof raw["title"] !== "string" || typeof raw["project"] !== "string") return undefined;
  const workflow = isRecord(raw["workflow"]) ? raw["workflow"] : undefined;
  const spent = isRecord(raw["spent"]) ? raw["spent"] : undefined, limit = isRecord(raw["runLimit"]) ? raw["runLimit"] : undefined;
  return some({
    taskId: raw["taskId"], title: raw["title"].slice(0, 300), project: raw["project"].slice(0, 200), status: text(raw["status"], 40),
    workflow: workflow === undefined ? undefined : some({
      stage: text(workflow["stage"], 40), state: text(workflow["state"], 40), revision: num(workflow["revision"]), path: text(workflow["path"], 40), outcome: text(workflow["outcome"], 40), blockReason: text(workflow["blockReason"], 500),
    }),
    pullRequests: list(raw["pullRequests"], 10).filter(isRecord).map((pull) => some({ repository: text(pull["repository"], 200), number: num(pull["number"]), url: text(pull["url"], 500), state: text(pull["state"], 40) })),
    spent: spent === undefined ? undefined : some({ usd: num(spent["usd"]) }),
    runLimit: limit === undefined ? undefined : some({ limitUsd: num(limit["limitUsd"]) }),
    createdAt: text(raw["createdAt"], 40), updatedAt: text(raw["updatedAt"], 40),
  });
}

/** The plan as the spec screen draws it: the one-line summary, the estimate and limit, and the structured spec (requirements, tasks, questions) when Code sends it. */
export function workPlan(raw: unknown): Record<string, unknown> {
  const plan = isRecord(raw) ? raw : {};
  const summary = isRecord(plan["summary"]) ? plan["summary"] : undefined;
  return some({
    taskId: text(plan["taskId"], 80), document: text(plan["document"], 40), version: num(plan["version"]), approved: bool(plan["approved"]), current: bool(plan["current"]),
    summary: summary === undefined ? undefined : some({ headline: text(summary["headline"]), checks: list(summary["checks"], 20).flatMap((item) => (typeof item === "string" ? [item.slice(0, 300)] : [])) }),
    estimate: text(plan["estimate"], 300), runLimitUsd: num(plan["runLimitUsd"]),
    requirements: Array.isArray(plan["requirements"]) ? list(plan["requirements"], 50) : undefined,
    tasks: Array.isArray(plan["tasks"]) ? list(plan["tasks"], 100) : undefined,
    questions: Array.isArray(plan["questions"]) ? list(plan["questions"], 20) : undefined,
  });
}

const WORK_READS: Route[] = [
  {
    // GET /v1/app/sessions (contract v0 `tasks.list`): the person's tasks, newest first, for the Work page's list.
    method: "GET", path: /^\/sessions$/u,
    answer: async ({ client, session, work }) => {
      const answer = await client.json<{ tasks?: unknown[] }>(session, "/v1/dev/tasks", { headers: TASK_VIEW });
      // The tasks the person started in Cloud carry Cloud's session id: the task page's steer, stop and comment routes are the session's. A task started elsewhere has none.
      // A session store that cannot be read costs the page those links, never the list.
      const sessions = new Map<string, string>();
      try { for (const record of (await work.startedBy(session.access.developerId)).slice(0, SESSIONS_LOOKED_AT)) if (!sessions.has(record.taskId)) sessions.set(record.taskId, record.sessionId); } catch { /* the list still answers */ }
      return ok({ tasks: list(answer.tasks, WORK_TASKS_MAX).flatMap((task) => { const view = workTask(task); return view === undefined ? [] : [{ ...view, ...(sessions.has(view["taskId"] as string) ? { sessionId: sessions.get(view["taskId"] as string) } : {}) }]; }) });
    },
  },
  {
    // GET /v1/app/tasks/{t}/documents/{document} (contract v0 `tasks.plan`): one stored version of a plan document, with its structured spec.
    method: "GET", path: new RegExp(`^/tasks/${TASK_ID}/documents/(requirements|design|plan)$`, "iu"),
    answer: async ({ client, session, params, query }) => {
      const version = Number(query.get("version"));
      const forward = new URLSearchParams({ document: params[1]! });
      if (Number.isInteger(version) && version > 0) forward.set("version", String(version));
      return ok(workPlan(await client.json<unknown>(session, `/v1/dev/tasks/${encodeURIComponent(params[0]!)}/plan?${forward.toString()}`)));
    },
  },
  {
    // GET /v1/app/tasks/{t}/evidence (contract v0 `tasks.evidence.list`): the proof index, one item per check and the criteria it speaks to.
    method: "GET", path: new RegExp(`^/tasks/${TASK_ID}/evidence$`, "iu"),
    answer: async ({ client, session, params }) => {
      const answer = await client.json<{ taskId?: unknown; items?: unknown[] }>(session, `/v1/dev/tasks/${encodeURIComponent(params[0]!)}/evidence`);
      return ok({
        taskId: text(answer.taskId, 80) ?? params[0],
        items: list(answer.items, 200).filter(isRecord).map((item) => some({
          sha256: text(item["sha256"], 80), title: text(item["title"], 300), kind: text(item["kind"], 60), verdict: text(item["verdict"], 20),
          criterionIds: list(item["criterionIds"], 50).flatMap((id) => (typeof id === "string" ? [id.slice(0, 40)] : [])),
          commit: text(item["commit"], 80), stale: bool(item["stale"]), passed: num(item["passed"]), total: num(item["total"]), bar: num(item["bar"]),
        })),
      });
    },
  },
  {
    // GET /v1/app/tasks/{t}/events (contract v0 `tasks.events`): what the task did, newest the page can hold, for the build activity.
    method: "GET", path: new RegExp(`^/tasks/${TASK_ID}/events$`, "iu"),
    answer: async ({ client, session, params }) => {
      const answer = await client.json<{ events?: unknown[] }>(session, `/v1/dev/tasks/${encodeURIComponent(params[0]!)}/events?limit=${String(EVENTS_MAX)}`);
      return ok({
        events: list(answer.events, EVENTS_MAX).filter(isRecord).map((event) => some({
          seq: num(event["seq"]), at: text(event["at"], 40), kind: text(event["kind"], 40), text: text(event["text"]), taskItemId: text(event["taskItemId"], 40), attempt: num(event["attempt"]),
        })),
      });
    },
  },
  {
    // GET /v1/app/tasks/{t}/comments (contract v0 `tasks.comments.list`): comments on the plan, each anchored to a criterion when Code says so.
    method: "GET", path: new RegExp(`^/tasks/${TASK_ID}/comments$`, "iu"),
    answer: async ({ client, session, params }) => {
      const answer = await client.json<{ comments?: unknown[] }>(session, `/v1/dev/tasks/${encodeURIComponent(params[0]!)}/comments`);
      return ok({
        comments: list(answer.comments, COMMENTS_MAX).filter(isRecord).map((comment) => {
          const author = isRecord(comment["author"]) ? comment["author"] : {};
          return some({
            commentId: text(comment["commentId"], 80), document: text(comment["document"], 20), author: some({ developerId: text(author["developerId"], 80), name: text(author["name"], 200) }),
            text: text(comment["text"]), at: text(comment["at"], 40), rev: num(comment["rev"]), resolved: bool(comment["resolved"]), anchor: text(comment["anchor"], 80), replyTo: text(comment["replyTo"], 80),
          });
        }),
      });
    },
  },
];

export { WORK_READS };
