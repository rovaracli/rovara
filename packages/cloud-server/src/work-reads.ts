// The Work page's reads (the split inbox, DEC 223): the person's tasks and, for the one task they select, its plan, proof index, events and plan comments.
// Each is one call to Rovara Code as the signed-in person (contract v0: tasks.list, tasks.plan, tasks.evidence.list, tasks.events, tasks.comments.list),
// kept to the fields the page draws. Code decides who may read a task; its refusal, a 404 included, reaches the app as Code worded it. Nothing here
// writes, and nothing is invented: a field Code did not send is left out.
import { CodeError, SignInEnded } from "./code-client.js";
import type { Route, RouteAnswer } from "./routes.js";

/** Code's task view, version 2. */
const TASK_VIEW = { "x-agentx-task-view": "2" };
/** How many tasks the list answers, and how many events or comments one task answers. A bound on every read. */
export const WORK_TASKS_MAX = 100;
/** Code's own most events per read (DEVELOPER_EVENTS_MAX in packages/contracts/src/developer-tasks.ts; Code answers 400 to a larger limit). Code's events
 * read has no cursor, so this is the newest page Code gives; tests pin it to the contract's value (cloud-server takes no dependency on contracts). */
export const EVENTS_MAX = 50;
const COMMENTS_MAX = 100;
const TEXT_MAX = 2000;
/** How many failing tests the proof index passes on (Code's own limit, TE-A6). The rest are counted, never dropped silently. */
export const PROOF_FAILURES_MAX = 10;
/** How many of the person's newest sessions the list matches to tasks (a bound on the store read, like Home's). */
const SESSIONS_LOOKED_AT = 200;
/** How many involved tasks one read asks Code for (Code's own page bound is 50). The first page only: the list says nothing about more. */
const INVOLVED_PAGE = 50;
/** Code's answers for "not deployed yet" (an older Code has no involved list, or does not know the query): the page shows nothing extra and no error. */
const INVOLVED_NOT_YET: ReadonlySet<number> = new Set([400, 404, 501]);
const TASK_ID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";

/** Code's list page (DEVELOPER_TASK_LIST_MAX) and how many pages one list read follows: WORK_TASKS_MAX tasks at most. */
const LIST_PAGE = 50;
const LIST_PAGES_MAX = 2;
/** How many of the newest open tasks one list read asks Code for one by one (their stage, pull requests, cost and limit), and how many of those reads run at once. */
export const WORK_DETAILS_MAX = 30;
const DETAIL_READS_AT_ONCE = 5;
/** A closed or cancelled task needs no stage: the list says what it is from its status alone. */
const NO_DETAIL: ReadonlySet<string> = new Set(["CLOSED", "CANCELLED"]);

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
    taskId: raw["taskId"], title: raw["title"].slice(0, 300), project: raw["project"].slice(0, 200), status: text(raw["status"], 40), shared: raw["shared"] === true ? true : undefined,
    workflow: workflow === undefined ? undefined : some({
      stage: text(workflow["stage"], 40), state: text(workflow["state"], 40), revision: num(workflow["revision"]), path: text(workflow["path"], 40), outcome: text(workflow["outcome"], 40), blockReason: text(workflow["blockReason"], 500),
      // K0b: the round of Understand's questions (Code's workflow.intent.rounds), so an answer names the round it answers.
      round: isRecord(workflow["intent"]) ? num(workflow["intent"]["rounds"]) : undefined,
    }),
    pullRequests: list(raw["pullRequests"], 10).filter(isRecord).map((pull) => some({ repository: text(pull["repository"], 200), number: num(pull["number"]), url: text(pull["url"], 500), state: text(pull["state"], 40) })),
    spent: spent === undefined ? undefined : some({ usd: num(spent["usd"]) }),
    runLimit: limit === undefined ? undefined : some({ limitUsd: num(limit["limitUsd"]) }),
    createdAt: text(raw["createdAt"], 40), updatedAt: text(raw["updatedAt"], 40),
  });
}

/** Code's claim ids ("1", "1.1", "2.3.1") and decision/option ids, as its plan contract has them (workflow-plan-document.ts); anything else is left out. */
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/u;
const planId = (value: unknown): string | undefined => (typeof value === "string" && PLAN_ID.test(value) ? value : undefined);
const PLAN_CLAIMS_SHOWN = 50;

/**
 * One top-level claim of Code's plan as a requirement: its sub-claims are its criteria (a claim with none is its own one criterion). A claim's text is the criterion's "then"; Code
 * has no "when". `under` maps every claim id in it (the deeper ones Code allows too) to the criterion the screen shows it beside: itself, the sub-claim it is under, or, for the
 * top-level claim, its first criterion.
 */
function requirementOf(claim: Record<string, unknown>): { requirement: Record<string, unknown>; under: Array<[string, string]> } | undefined {
  const id = planId(claim["id"]), title = text(claim["text"], 300);
  if (id === undefined || title === undefined) return undefined;
  const under: Array<[string, string]> = [];
  const descendants = (node: Record<string, unknown>, criterion: string, depth: number): void => {
    if (depth > 3) return;
    for (const child of list(node["children"], PLAN_CLAIMS_SHOWN).filter(isRecord)) {
      const childId = planId(child["id"]);
      if (childId !== undefined) under.push([childId, criterion]);
      descendants(child, criterion, depth + 1);
    }
  };
  const children = list(claim["children"], PLAN_CLAIMS_SHOWN).filter(isRecord).flatMap((child) => {
    const childId = planId(child["id"]), then = text(child["text"], 300);
    if (childId === undefined || then === undefined) return [];
    under.push([childId, childId]);
    descendants(child, childId, 3);
    return [{ id: childId, when: "", then, taskIds: [] }];
  });
  const criteria = children.length > 0 ? children : [{ id, when: "", then: title, taskIds: [] }];
  under.push([id, criteria[0]!.id]);
  return { requirement: { id, title, criteria }, under };
}

/**
 * The plan as the spec screen draws it, from Code's answer to `GET /v1/dev/tasks/{t}/plan` (PLANFULLDOC, `aws/task-plan-document.ts`): `{ plan: { taskId, document, version, sha256, approved,
 * current, versions, content, summary } }`. The headline is the plan's title; the checks are the summary's check labels; the requirements are the plan's claims (sub-claims as criteria); the
 * questions are the plan's decisions with their options and Code's recommended one. Code's plan names no estimate, run limit or task status, so none is shown. A field Code did not send is left out.
 */
export function workPlan(raw: unknown): Record<string, unknown> {
  const plan = isRecord(raw) && isRecord(raw["plan"]) ? raw["plan"] : {};
  const content = isRecord(plan["content"]) ? plan["content"] : undefined;
  const read = content === undefined ? undefined : list(content["claims"], PLAN_CLAIMS_SHOWN).filter(isRecord).flatMap((claim) => { const one = requirementOf(claim); return one === undefined ? [] : [one]; });
  const requirements = read?.map((one) => one.requirement);
  // A decision may name any claim (a parent, or one deeper than a criterion); the screen asks it beside the criterion that claim is shown under.
  const criterionOf = new Map<string, string>();
  for (const one of read ?? []) for (const [claim, criterion] of one.under) if (!criterionOf.has(claim)) criterionOf.set(claim, criterion);
  const summary = isRecord(plan["summary"]) ? plan["summary"] : undefined;
  const checks = summary === undefined ? undefined : list(summary["checks"], 20).filter(isRecord).flatMap((check) => { const label = text(check["label"], 300); return label === undefined ? [] : [label]; });
  return some({
    taskId: text(plan["taskId"], 80), document: text(plan["document"], 40), version: num(plan["version"]), approved: bool(plan["approved"]), current: bool(plan["current"]),
    summary: content === undefined && summary === undefined ? undefined : some({ headline: content === undefined ? undefined : text(content["title"], 300), checks: checks ?? [] }),
    requirements,
    questions: content === undefined ? undefined : list(content["decisions"], 20).filter(isRecord).flatMap((decision) => {
      const questionId = planId(decision["id"]), question = text(decision["question"], 300);
      if (questionId === undefined || question === undefined) return [];
      const options = list(decision["options"], 4).filter(isRecord).flatMap((option) => { const optionId = planId(option["id"]), label = text(option["label"], 80); return optionId === undefined || label === undefined ? [] : [{ optionId, label }]; });
      const recommended = planId(decision["recommended"]);
      return [some({ questionId, text: question, options, criterionId: ((claim) => (claim === undefined ? undefined : criterionOf.get(claim)))(planId(decision["claimId"])), defaultOptionId: options.some((option) => option.optionId === recommended) ? recommended : undefined })];
    }),
  });
}

/**
 * Fills each open task (the newest WORK_DETAILS_MAX) with what Code's own task view says of its workflow, pull requests, cost and run limit. A read Code refuses, or that
 * fails, leaves that row as the list had it, marked `detail: "unread"`; an ended sign-in is not swallowed. The rows are changed in place.
 */
async function withDetails(views: Array<Record<string, unknown>>, read: (taskId: string) => Promise<{ task?: unknown }>): Promise<void> {
  const open = views.filter((view) => !NO_DETAIL.has(String(view["status"])));
  const asked = open.slice(0, WORK_DETAILS_MAX);
  for (const view of open.slice(WORK_DETAILS_MAX)) view["detail"] = "unread";
  for (let at = 0; at < asked.length; at += DETAIL_READS_AT_ONCE) {
    await Promise.all(asked.slice(at, at + DETAIL_READS_AT_ONCE).map(async (view) => {
      let detail: Record<string, unknown> | undefined;
      try {
        const answer = await read(view["taskId"] as string);
        detail = isRecord(answer) ? workTask(answer.task) : undefined;
      } catch (error) {
        if (error instanceof SignInEnded) throw error;
      }
      // Only the same task's view counts; its list row keeps the title, project and status the list gave.
      if (detail === undefined || detail["taskId"] !== view["taskId"]) { view["detail"] = "unread"; return; }
      for (const key of ["workflow", "pullRequests", "spent", "runLimit"] as const) if (detail[key] !== undefined) view[key] = detail[key];
      if (typeof detail["status"] === "string") view["status"] = detail["status"];
      if (typeof detail["updatedAt"] === "string") view["updatedAt"] = detail["updatedAt"];
    }));
  }
}

const WORK_READS: Route[] = [
  {
    // GET /v1/app/sessions (contract v0 `tasks.list`): the person's tasks, newest first, for the Work page's list.
    // Code's list rows hold only id, title, project, status, shared and times (DeveloperTaskListItemSchema), 20 by default and at most 50 a page with a `nextCursor`. So the
    // list asks for full pages (up to WORK_TASKS_MAX tasks), and the open tasks among the newest WORK_DETAILS_MAX are read one by one (Code's own task view, as the person)
    // for their workflow stage, pull requests, cost and run limit. A task whose view could not be read is marked `detail: "unread"` (the page never calls it finished).
    method: "GET", path: /^\/sessions$/u,
    answer: async ({ client, session, work }) => {
      const rows: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIST_PAGES_MAX && rows.length < WORK_TASKS_MAX; page += 1) {
        const query = new URLSearchParams({ limit: String(LIST_PAGE), ...(cursor === undefined ? {} : { cursor }) });
        const answer = await client.json<{ tasks?: unknown[]; nextCursor?: unknown }>(session, `/v1/dev/tasks?${query.toString()}`, { headers: TASK_VIEW });
        rows.push(...list(answer.tasks, WORK_TASKS_MAX - rows.length));
        cursor = typeof answer.nextCursor === "string" && answer.nextCursor !== "" && answer.nextCursor.length <= 2_000 ? answer.nextCursor : undefined;
        if (cursor === undefined) break;
      }
      const views = rows.flatMap((task) => { const view = workTask(task); return view === undefined ? [] : [view]; });
      await withDetails(views, (taskId) => client.json<{ task?: unknown }>(session, `/v1/dev/tasks/${encodeURIComponent(taskId)}?events=0`, { headers: TASK_VIEW }));
      // The tasks the person started in Cloud carry Cloud's session id: the task page's steer, stop and comment routes are the session's. A task started elsewhere has none.
      // A session store that cannot be read costs the page those links, never the list.
      const sessions = new Map<string, string>();
      try { for (const record of (await work.startedBy(session.access.developerId)).slice(0, SESSIONS_LOOKED_AT)) if (!sessions.has(record.taskId)) sessions.set(record.taskId, record.sessionId); } catch { /* the list still answers */ }
      return ok({ tasks: views.map((view) => ({ ...view, ...(sessions.has(view["taskId"] as string) ? { sessionId: sessions.get(view["taskId"] as string) } : {}) })) });
    },
  },
  {
    // GET /v1/app/involved: the tasks the person was ADDED to (a co-owner, commenter or viewer on someone else's task), for the Work list's "Involved" group and Home. One call to Code,
    // `GET /v1/dev/tasks?involved=1`, as the signed-in person: Code lists only the person's own rows and re-checks each task against its live access, so Cloud takes no id, company or
    // person from the browser and adds no reach of its own. Only an answer that says it is the involved list (`involved: true`) counts: an older Code answers the ordinary list to this
    // query, and those tasks (the person's own) must never show as involved. Code's 400, 404 and 501 (not deployed yet) show nothing and no error; any other refusal reaches the page as Code worded it.
    method: "GET", path: /^\/involved$/u,
    answer: async ({ client, session }) => {
      try {
        const answer = await client.json<{ involved?: unknown; tasks?: unknown[] }>(session, `/v1/dev/tasks?involved=1&limit=${String(INVOLVED_PAGE)}`, { headers: TASK_VIEW });
        if (!isRecord(answer) || answer["involved"] !== true) return ok({ tasks: [] });
        // Code's list rows carry no workflow: such a row is marked unread, so a task between steps is never shown as finished (its own page reads the stage).
        return ok({ tasks: list(answer["tasks"], WORK_TASKS_MAX).flatMap((task) => { const view = workTask(task); return view === undefined ? [] : [view["workflow"] === undefined ? { ...view, detail: "unread" } : view]; }) });
      } catch (error) {
        if (error instanceof CodeError && INVOLVED_NOT_YET.has(error.status)) return ok({ tasks: [] });
        throw error;
      }
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
    // GET /v1/app/tasks/{t}/evidence (contract v0 `tasks.evidence.list`): the proof index, one item per check and the criteria it speaks to, and (TE-A6) the failing tests with the change that
    // likely broke each, at most ten (plain text as Code worded it; the page draws it as text). Code's refusal, its 404 and 501 included, reaches the page as Code worded it.
    method: "GET", path: new RegExp(`^/tasks/${TASK_ID}/evidence$`, "iu"),
    answer: async ({ client, session, params }) => {
      const answer = await client.json<{ taskId?: unknown; items?: unknown[]; failures?: unknown[]; failuresNotListed?: unknown }>(session, `/v1/dev/tasks/${encodeURIComponent(params[0]!)}/evidence`);
      const failures = Array.isArray(answer.failures) ? answer.failures.filter(isRecord).flatMap((row) => {
        const check = text(row["check"], 200), test = text(row["test"], 300), cause = text(row["cause"], 500);
        return check === undefined || test === undefined || cause === undefined ? [] : [{ check, test, cause }];
      }) : [];
      const shown = failures.slice(0, PROOF_FAILURES_MAX);
      const sent = num(answer.failuresNotListed);
      const notListed = (sent !== undefined && Number.isInteger(sent) && sent > 0 ? Math.min(sent, 100_000) : 0) + (failures.length - shown.length);
      return ok({
        taskId: text(answer.taskId, 80) ?? params[0],
        items: list(answer.items, 200).filter(isRecord).map((item) => some({
          id: text(item["id"], 40), sha256: text(item["sha256"], 80), title: text(item["title"], 300), kind: text(item["kind"], 60), verdict: text(item["verdict"], 20),
          criterionIds: list(item["criterionIds"], 50).flatMap((id) => (typeof id === "string" ? [id.slice(0, 40)] : [])),
          commit: text(item["commit"], 80), stale: bool(item["stale"]), passed: num(item["passed"]), total: num(item["total"]), bar: num(item["bar"]),
        })),
        ...(shown.length === 0 ? {} : { failures: shown }),
        ...(notListed === 0 ? {} : { failuresNotListed: notListed }),
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
