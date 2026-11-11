// The Lessons tab's view (GET /v1/app/projects/{p}/lessons) and a cell that answers it and its writes. Every body is parsed by the contract's own strict schema.
import { LessonHistorySchema, LessonSourcesSchema, LessonViewSchema, LessonsDigestSchema, LessonsViewSchema, LoadedLessonsSchema } from "@agentx/cloud-contracts/web";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { howWeWorkHost, type Handler } from "./how-we-work-fixture.js";

export const LESSONS_PATH = "/v1/app/projects/payments/lessons";
export const NOW = Date.now();
const HOUR = 3_600_000, DAY = 24 * HOUR;
type Raw = Record<string, unknown>;
export const person = (name: string, you = false) => ({ name, ...(you ? { you: true } : {}) });
export const codeCite = (over: Raw = {}) => ({ kind: "code", repo: "api", path: "src/retry/index.ts", startLine: 12, endLine: 30, check: "valid", checkedAt: NOW - 2 * HOUR, ...over });
export const lesson = (over: Raw = {}) => LessonViewSchema.parse({
 id: "les_aaaa1111", version: 1, type: "convention", stages: ["IMPLEMENT"], title: "Use the shared retry helper", description: "", body: "Call withRetry for HTTP calls in api.", scope: { repos: ["api"], paths: [], languages: [] },
 tier: 1, tierReasons: ["not_a_fact"], status: "active", counters: { loaded: 4, helpful: 3, harmful: 1 }, createdAt: NOW - 20 * DAY, updatedAt: NOW - 3 * DAY, expiresAt: NOW + 62 * DAY,
 citations: [codeCite()], from: [person("Carl Cole")], measured: false, supportTasks: 2, approvals: [], canApprove: false, canReject: false, canRetire: true, ...over,
});
export const waiting = (over: Raw = {}) => lesson({ id: "les_pend0001", status: "pending", title: "Retry only idempotent calls", body: "Only wrap idempotent HTTP calls in withRetry.", needs: { required: 1, have: 0, groups: [] }, approvals: [], canApprove: true, canReject: true, canRetire: true, ...over });
export const view = (over: Raw = {}) => LessonsViewSchema.parse({
 project: "payments", mode: "Suggest", lockedByCompany: false, preset: "standard", presetLockedByCompany: false, approval: { tier0: "one", tier1: "one", requiredGroups: [] }, canDecide: true,
 waiting: [waiting()], active: [lesson()], removed: [], queued: 0, hidden: 0, truncated: [], setVersion: 4, snapshots: [], ...over,
});
export const digest = (over: Raw = {}) => LessonsDigestSchema.parse({ since: NOW - 7 * DAY, top: [], needsReview: [], autoApplied: [], waiting: [], retired: [], staleOrRetireProposed: [], queued: 0, pausedSources: [], pausedSourcesHidden: 0, hidden: 0, ...over });
export const sources = (over: Raw = {}) => LessonSourcesSchema.parse({ sources: [], otherPaused: 0, ...over });
export const source = (over: Raw = {}) => ({ kind: "github", scope: "github:acme/payments", enabled: true, retention: "D", health: "ok", audience: "project", updatedAt: "2026-10-30T10:00:00.000Z", paused: false, ...over });
export const history = (over: Raw = {}) => LessonHistorySchema.parse({ versions: [{ version: 2, at: NOW - DAY, status: "active", title: "Use the shared retry helper", body: "Call withRetry.", approvedBy: [person("Ann Archer")] }, { version: 1, at: NOW - 3 * DAY, status: "pending", title: "Use retry", body: "Call retry.", approvedBy: [] }], ...over });
export const loaded = (rows: Raw[]) => LoadedLessonsSchema.parse({ lessons: rows });
export const loadedRow = (over: Raw = {}) => ({ stage: "IMPLEMENT", round: 1, lessonId: "les_aaaa1111", version: 1, why: "scope", citation: "valid", visible: true, title: "Use the shared retry helper", type: "convention", helpful: 3, harmful: 1, canMark: true, ...over });

export const refusal = (code: string, message: string, status = 403): ApiResponse => ({ status, body: { error: { code, message } } });
export const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });

type Answer = ApiResponse | undefined | Promise<ApiResponse | undefined>;
/** A cell with the project routes and the lessons routes. `lessons` answers a lessons request first (undefined falls through to the defaults below). */
export function lessonsHost(options: { state?: { view?: unknown; digest?: unknown; sources?: unknown; history?: unknown }; lessons?: (request: ApiRequest, url: URL) => Answer; handle?: Handler; canEdit?: boolean } = {}) {
 const state = { view: options.state?.view ?? view(), digest: options.state?.digest ?? digest(), sources: options.state?.sources ?? sources(), history: options.state?.history ?? history() };
 const cell = howWeWorkHost({ ...(options.canEdit === undefined ? {} : { canEdit: options.canEdit }), handle: async (request, url) => {
  const custom = await options.handle?.(request, url);
  if (custom !== undefined) return custom;
  if (!url.pathname.startsWith(LESSONS_PATH) && !url.pathname.startsWith("/v1/app/tasks/")) return undefined;
  const answered = await options.lessons?.(request, url);
  if (answered !== undefined) return answered;
  if (request.method === "GET") {
   if (url.pathname === LESSONS_PATH) return ok(state.view);
   if (url.pathname === LESSONS_PATH + "/digest") return ok(state.digest);
   if (url.pathname === LESSONS_PATH + "/sources") return ok(state.sources);
   if (url.pathname.endsWith("/history")) return ok(state.history);
  }
  return refusal("NOT_FOUND", "Not found.", 404);
 } });
 const lessonCalls = () => cell.request.mock.calls.map(([request]) => request).filter(request => request.path.split("?")[0]!.startsWith(LESSONS_PATH));
 return { ...cell, state, lessonCalls, lessonReads: () => lessonCalls().filter(request => request.method === "GET"), lessonWrites: () => lessonCalls().filter(request => request.method !== "GET") };
}
