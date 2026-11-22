// Shared by mounted jsdom proof and the controller's real-route capture fixture.
import { AppNavReaderSchema, DecisionCardsViewReaderSchema, InboxPageReaderSchema, ProjectNoticesReaderSchema, ProjectSetupChecklistSchema } from "@agentx/contracts/web";
import { readDecisions } from "../../../packages/ui/src/api/decisions.js";
import { InboxReader } from "../../../packages/ui/src/api/learned.js";
import { readComments, readEvents, readPlan, readProofIndex, readTaskList } from "../../../packages/ui/src/api/work.js";
import type { ApiResponse } from "../../../packages/ui/src/host.js";
import { navFixture } from "./fixtures.js";
import { CARDS, EVENTS, ID, PLAN, PROOF, TASKS, decisionsView, task } from "./work-fixture.js";

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const denied = { status: 403, body: { error: { code: "FORBIDDEN", message: "You no longer have access to this." } } };
const missing = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/sessions isn't connected to Rovara Code yet." } } };
const empty = { "/v1/app/sessions": ok({ tasks: [] }), "/v1/app/decisions": ok(decisionsView([])) };
export const setupScene = ProjectSetupChecklistSchema.parse({
 project: "web", viewer: { companyRole: "member", projectAdmin: false, canSkip: false },
 progress: { done: 2, total: 8, percent: 25, nextRequired: "setupRun" },
 repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] },
 setupRun: { state: "needs_you", status: "ready", approval: "none" }, evalConfirm: { state: "needs_you", report: "none", blockedBy: "setupRun" },
 aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null }, slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "needs_you", hasTask: false, canStart: false },
});
const lesson = { id: "les_pend0001", version: 1, title: "Retry only idempotent calls", type: "convention", status: "pending", canApprove: true, canReject: true, counters: { loaded: 0, helpful: 0, harmful: 0 }, createdAt: 1794744000000, updatedAt: 1794744000000, expiresAt: 1797336000000 };
const notification = { id: "ses_aaaaaaaaaaaaaaaaaaaa.needs_you.1763208000000", kind: "needs_you", title: "Review the current task", status: "Waiting for you.", at: "2026-11-15T11:00:00.000Z", read: false, open: "/s/ses_aaaaaaaaaaaaaaaaaaaa" };
const lessons = ok({ state: "on", batches: [{ project: "web", lessons: [lesson] }], unavailable: [] });
export interface UnitScene { id: string; route: string; board: string; selector: string; text: string; replies?: Record<string, ApiResponse>; later?: Record<string, ApiResponse>; invalidate?: readonly string[]; forbidden?: string[]; pending?: string[] }
export const unitScenes: readonly UnitScene[] = [
 { id: "inbox-needs", route: "/app/inbox", board: "2a", selector: "[data-testid=inbox-attention]", text: "Add a retry to the billing webhook" },
 { id: "inbox-preview", route: "/app/inbox?item=" + ID.plan, board: "2a/2e", selector: "[aria-label='Inbox preview']", text: CARDS[0]!.question },
 { id: "inbox-waiting", route: "/app/inbox?tab=waiting", board: "2a", selector: "[data-testid=inbox-attention]", text: "Document the router fallbacks" },
 { id: "inbox-setup", route: "/app/inbox?tab=setup", board: "6j/6n", selector: "[aria-label='Project setup']", text: "25% done", replies: { "/v1/app/nav": ok(navFixture({ projects: [{ name: "web", agents: [] }] })) } },
 { id: "inbox-no-project", route: "/app/inbox?tab=setup", board: "2b/6j", selector: "[aria-label='Project setup']", text: "You're not in a project yet", replies: { "/v1/app/nav": ok(navFixture({ projects: [] })) } },
 { id: "inbox-empty-unknown", route: "/app/inbox", board: "2b", selector: "[data-testid=inbox-attention]", text: "Nothing shown needs you", replies: empty, forbidden: ["You're all caught up.", "Nothing needs you"] },
 { id: "inbox-first-day", route: "/app/inbox", board: "2b first day", selector: "[data-testid=inbox-attention]", text: "You're not in a project yet", replies: { ...empty, "/v1/app/nav": ok(navFixture({ projects: [] })) }, forbidden: ["You're all caught up.", "Nothing needs you"] },
 { id: "inbox-notices-partial", route: "/app/inbox", board: "2b partly loaded", selector: "[data-testid=project-notices-error]", text: "The inbox may be incomplete", replies: { ...empty, "/v1/app/inbox/project-notices": denied }, forbidden: ["No updates shown"] },
 { id: "inbox-notices-partial-list", route: "/app/inbox", board: "2b/F699", selector: "[data-testid=project-notices-error]", text: "The inbox may be incomplete", replies: { "/v1/app/inbox/project-notices": denied }, forbidden: ["No updates shown"] },
 { id: "inbox-decision-refused", route: "/app/inbox", board: "2b/F834", selector: "[data-testid=inbox-attention]", text: "not a confirmed empty queue", replies: { "/v1/app/decisions": denied }, forbidden: ["Approve quick spec"] },
 { id: "inbox-access-lost", route: "/app/inbox", board: "4e access lost", selector: "[data-testid=inbox-attention]", text: "Nothing from before is shown", replies: { "/v1/app/sessions": denied }, forbidden: ["Add a retry to the billing webhook", "You're all caught up.", "Nothing needs you"] },
 { id: "inbox-cached-task-refused", route: "/app/inbox?item=" + ID.plan, board: "States/R1", selector: "[data-testid=inbox-attention]", text: "The task list could not be read", later: { "/v1/app/sessions": denied }, invalidate: ["work", "tasks"], forbidden: [CARDS[0]!.question] },
 { id: "inbox-setup-refused", route: "/app/inbox?tab=setup", board: "6j/States", selector: "[aria-label='Project setup']", text: "Some setup could not be read", replies: { "/v1/app/projects/web/setup-status": denied } },
 { id: "inbox-lesson", route: "/app/inbox?item=lessons%3Aweb", board: "2a/held lesson board", selector: "[aria-label='Inbox preview']", text: "Read the proposed lessons in Work", replies: { "/v1/app/lessons/inbox": lessons } },
 { id: "inbox-updates-refused", route: "/app/inbox", board: "F701", selector: "[data-testid=load-error]", text: "You no longer have access to this", replies: { "/v1/app/inbox": denied } },
 { id: "inbox-updates-unavailable", route: "/app/inbox", board: "States", selector: "[data-testid=inbox-unavailable]", text: "isn't available on this install yet", replies: { "/v1/app/inbox": missing } },
 { id: "work-question", route: "/app/live?task=" + ID.question, board: "2c/view-only", selector: "[data-testid=pane-title]", text: "Add a toxicity eval" },
 { id: "work-checks", route: "/app/live?task=" + ID.checks, board: "2c/view-only", selector: "[data-testid=pane-title]", text: "Rate-limit" },
 { id: "work-merge", route: "/app/live?task=" + ID.merge, board: "2c/view-only", selector: "[data-testid=pane-title]", text: "Fix the README" },
 { id: "work-inline-round", route: "/app/live?task=" + ID.question, board: "2c/view-only", selector: "[aria-label='Work list']", text: "Inline questions", replies: { "/v1/app/sessions": ok({ tasks: [task(ID.question, "Inline questions", { round: { round: 2, questions: [{ id: "q1", text: "Which behaviour?", answered: false, options: [{ id: "a", label: "Block" }, { id: "b", label: "Warn" }] }] }, workflow: { stage: "UNDERSTAND", state: "WAITING", revision: 2 } })] }) } },
 { id: "work-all", route: "/app/live", board: "2c", selector: "[data-testid=work]", text: "Search work" },
 { id: "work-running", route: "/app/live?filter=running&task=" + ID.running, board: "2c", selector: "[data-testid=pane-title]", text: "Speed up the search index" },
 { id: "work-needs-someone", route: "/app/live?filter=needs-someone", board: "2c", selector: "[aria-label='Work list']", text: "Document the router fallbacks" },
 { id: "work-finished", route: "/app/live?filter=finished", board: "2c", selector: "[aria-label='Work list']", text: "Add request IDs to eval logs" },
 { id: "work-search-empty", route: "/app/live?q=absent", board: "2c", selector: "[aria-label='Work list']", text: "No tasks match this filter" },
 { id: "work-unknown-selection", route: "/app/live?task=missing", board: "2c/States", selector: "[data-testid=work-selection-unavailable]", text: "can't tell yet which task", forbidden: ["Open the full page"] },
 { id: "work-empty", route: "/app/live", board: "2c", selector: "[data-testid=work-empty]", text: "No tasks are shown", replies: empty },
 { id: "work-queued", route: "/app/live?task=" + ID.running, board: "2c", selector: "[data-testid=decision-quiet]", text: "can't tell yet when it will start", replies: { ...empty, "/v1/app/sessions": ok({ tasks: [task(ID.running, "Queued task", { status: "STARTING", workflow: undefined })] }) } },
 { id: "work-task-refused", route: "/app/live", board: "F835", selector: "[data-testid=load-error]", text: "You no longer have access to this", replies: { "/v1/app/sessions": denied } },
 { id: "work-unavailable", route: "/app/live", board: "F836", selector: "[data-testid=load-error]", text: "The Work page is not available on this installation", replies: { "/v1/app/sessions": missing } },
 { id: "work-shared-refused", route: "/app/live", board: "F837", selector: "[data-testid=involved-unavailable]", text: "list is incomplete", replies: { "/v1/app/involved": denied } },
 { id: "work-lessons-refused", route: "/app/live", board: "F838", selector: "[data-testid=lessons-unavailable]", text: "This does not mean there are none", replies: { "/v1/app/lessons/inbox": denied } },
 { id: "work-cached-decision-refused", route: "/app/live?task=" + ID.plan, board: "R1/F834", selector: "[data-testid=decisions-unavailable]", text: "not a confirmed empty queue", later: { "/v1/app/decisions": denied }, invalidate: ["decisions"], forbidden: ["Approve plan v1"] },
 { id: "inbox-task-loading", route: "/app/inbox", board: "States", selector: "[data-testid=inbox-attention]", text: "Reading your attention items", pending: ["/v1/app/sessions"] },
 { id: "inbox-updates-loading", route: "/app/inbox", board: "States", selector: "[role=progressbar]", text: "Loading your inbox", pending: ["/v1/app/inbox"] },
 { id: "inbox-updates-populated", route: "/app/inbox", board: "2a/updates preserved", selector: "[data-testid=inbox-row]", text: "Review the current task", replies: { "/v1/app/inbox": ok({ items: [notification], unread: 1, nextCursor: "next" }) } },
 { id: "inbox-notices-populated", route: "/app/inbox?tab=setup", board: "2a/6j", selector: "[data-testid=project-notices]", text: "Setup needs repair", replies: { "/v1/app/inbox/project-notices": ok({ items: [{ id: "setup_broken.1763208000000.web", kind: "setup_broken", project: "web", status: "Setup needs repair. Open the setup checklist.", at: "2026-11-15T11:00:00.000Z" }] }) } },
 { id: "inbox-setup-loading", route: "/app/inbox?tab=setup", board: "6j/States", selector: "[aria-label='Project setup']", text: "Reading project setup", pending: ["/v1/app/projects/web/setup-status"] },
 { id: "inbox-setup-complete", route: "/app/inbox?tab=setup", board: "6j/2b", selector: "[aria-label='Project setup']", text: "No unfinished setup shown", replies: { "/v1/app/projects/web/setup-status": ok({ ...setupScene, progress: { done: 8, total: 8, percent: 100, nextRequired: null } }) } },
 { id: "inbox-lessons-refused", route: "/app/inbox", board: "F838", selector: "[data-testid=inbox-attention]", text: "This does not mean there are none", replies: { "/v1/app/lessons/inbox": denied } },
 { id: "inbox-lessons-partial", route: "/app/inbox", board: "2b", selector: "[data-testid=inbox-attention]", text: "Some projects' lessons could not be read", replies: { "/v1/app/lessons/inbox": ok({ state: "on", batches: [], unavailable: ["api"] }) } },
 { id: "work-loading", route: "/app/live", board: "States", selector: "[role=progressbar]", text: "Loading your work", pending: ["/v1/app/sessions"] },
 { id: "work-waiting-detail", route: "/app/live?task=" + ID.waiting, board: "2c/2e2", selector: "[data-testid=decision-quiet]", text: "can't tell yet who will make the next move" },
 { id: "work-stopped", route: "/app/live?task=" + ID.checks, board: "2c", selector: "[data-testid=decision-quiet]", text: "Stopped", replies: { ...empty, "/v1/app/sessions": ok({ tasks: [task(ID.checks, "Stopped task", { status: "FAILED" }, "IMPLEMENT", "BLOCKED")] }) } },
 { id: "work-detail-unread", route: "/app/live?task=" + ID.running, board: "2c/States", selector: "[data-testid=decision-quiet]", text: "can't tell yet which step", replies: { ...empty, "/v1/app/sessions": ok({ tasks: [task(ID.running, "Task detail unread", { status: "SUCCEEDED", workflow: undefined, detail: "unread" })] }) }, forbidden: ["work in progress"] },
 { id: "work-shared-populated", route: "/app/live", board: "2c", selector: "[aria-label='Work list']", text: "Shared task", replies: { "/v1/app/involved": ok({ tasks: [task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Shared task")] }) } },
 { id: "work-lessons-batch", route: "/app/live?task=lessons%3Aweb", board: "2c/legacy lesson detail", selector: "[data-testid=lesson-batch]", text: "Retry only idempotent calls", replies: { "/v1/app/lessons/inbox": lessons } },
 { id: "work-lessons-off", route: "/app/live", board: "2c", selector: "[aria-label='Work list']", text: "Add a retry to the billing webhook", replies: { "/v1/app/lessons/inbox": ok({ state: "off", batches: [], unavailable: [] }) }, forbidden: ["Lessons needing your review could not be loaded"] },
 { id: "work-lessons-partial", route: "/app/live", board: "2c/F838", selector: "[data-testid=lessons-unavailable]", text: "couldn't be loaded for api", replies: { "/v1/app/lessons/inbox": ok({ state: "on", batches: [], unavailable: ["api"] }) } },
 { id: "work-decisions-refused", route: "/app/live", board: "F834", selector: "[data-testid=decisions-unavailable]", text: "not a confirmed empty queue", replies: { "/v1/app/decisions": denied } },
 { id: "work-cached-task-refused", route: "/app/live?task=" + ID.plan, board: "R1/F835", selector: "[data-testid=load-error]", text: "You no longer have access to this", later: { "/v1/app/sessions": denied }, invalidate: ["work", "tasks"], forbidden: ["Approve plan v1", "Open the full page"] },

];
export function sceneReplies(scene: UnitScene): Record<string, ApiResponse> {
 return {
  "/v1/app/nav": ok(navFixture({ projects: [{ name: "web", agents: [] }] })),
  "/v1/app/sessions": ok({ tasks: TASKS }), "/v1/app/involved": ok({ tasks: [] }), "/v1/app/decisions": ok(decisionsView()),
  "/v1/app/inbox": ok({ items: [], unread: 0 }), "/v1/app/inbox/project-notices": ok({ items: [] }),
  "/v1/app/lessons/inbox": ok({ state: "on", batches: [], unavailable: [] }),
  "/v1/app/projects/web/setup-status": ok(setupScene),
  ...Object.fromEntries(TASKS.flatMap(t => [[`/v1/app/tasks/${t.taskId}/documents/plan`, ok(PLAN)], [`/v1/app/tasks/${t.taskId}/evidence`, ok(PROOF)], [`/v1/app/tasks/${t.taskId}/events`, ok(EVENTS)], [`/v1/app/tasks/${t.taskId}/comments`, ok({ comments: [] })]])),
  ...scene.replies,
 };
}
/** All successful capture payloads pass the same readers that the mounted application consumes. */
export function validateSceneReplies(replies: Record<string, ApiResponse>) {
 for (const [path, response] of Object.entries(replies)) {
  if (response.status !== 200) continue;
  const body = response.body;
  if (path === "/v1/app/nav") AppNavReaderSchema.parse(body);
  else if (path === "/v1/app/sessions" || path === "/v1/app/involved") readTaskList(body);
  else if (path === "/v1/app/decisions") readDecisions(DecisionCardsViewReaderSchema.parse(body));
  else if (path === "/v1/app/inbox") InboxPageReaderSchema.parse(body);
  else if (path === "/v1/app/inbox/project-notices") ProjectNoticesReaderSchema.parse(body);
  else if (path === "/v1/app/lessons/inbox") InboxReader.parse(body);
  else if (path.endsWith("/setup-status")) ProjectSetupChecklistSchema.parse(body);
  else if (path.endsWith("/documents/plan")) readPlan(body);
  else if (path.endsWith("/evidence")) readProofIndex(body);
  else if (path.endsWith("/events")) readEvents(body);
  else if (path.endsWith("/comments")) readComments(body);
  else throw new Error("No capture reader for " + path);
 }
}
