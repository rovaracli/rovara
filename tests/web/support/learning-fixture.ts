// The learning view of a project (GET /v1/app/projects/{p}/learning) and a cell that answers it, for the Suggested rules tests. Every body is parsed by the contract's own strict schema.
import { LearningViewAnswerSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { howWeWorkHost, type Handler } from "./how-we-work-fixture.js";
export const LEARNING_PATH = "/v1/app/projects/payments/learning";
export const CONFIRM_URL = "https://cell.example/v1/app/approve/abc123";
type Raw = Record<string, unknown>;
export const source = (overrides: Raw = {}) => ({ kind: "comment", taskId: "tsk_1", label: "Please add a test.", at: "2026-10-28T10:00:00.000Z", standing: "member", href: "/review/tsk_1/task", ...overrides });
export const suggestion = (overrides: Raw = {}) => ({ id: "sug_1", stage: "build", status: "open", proposedText: "Add a test for every bug fix.", allFromOnePerson: false, lessSafe: false, lessSafeWords: [], overlaps: [], sources: [source(), source({ kind: "send_back", taskId: "tsk_2", label: "Tests are missing again.", at: "2026-10-29T10:00:00.000Z" })], revision: 4, sourceCount: 2, canDecide: true, ...overrides });
export const rule = (overrides: Raw = {}) => ({ id: "rul_1", stage: "build", text: "Run the linter first.", status: "active", processVersion: 5, ...overrides });
export const dismissed = (overrides: Raw = {}) => ({ id: "sug_9", stage: "plan", dismissedAt: "2026-10-27T10:00:00.000Z", dismissKind: "one_off", ...overrides });
export function learningView(overrides: Raw = {}) {
 return LearningViewAnswerSchema.parse({ settings: { prComments: "off", locked: false }, suggestions: [suggestion()], dismissed: [], rules: [], skippedUnlinked: 0, canDecide: true, ...overrides });
}
/** A cell with the How we work routes and the learning routes. `learn` answers a learning request first (undefined falls through to the view); the view is `state.view`. */
export function learningHost(options: { view?: unknown; canEdit?: boolean; learn?: (request: ApiRequest, url: URL) => ApiResponse | undefined | Promise<ApiResponse | undefined>; handle?: Handler } = {}) {
 const learning = { view: options.view ?? learningView() };
 const cell = howWeWorkHost({ ...(options.canEdit === undefined ? {} : { canEdit: options.canEdit }), handle: async (request, url) => {
  const custom = await options.handle?.(request, url);
  if (custom !== undefined) return custom;
  if (url.pathname === LEARNING_PATH || url.pathname.startsWith(LEARNING_PATH + "/")) {
   const answered = await options.learn?.(request, url);
   if (answered !== undefined) return answered;
   if (url.pathname === LEARNING_PATH && request.method === "GET") return { status: 200, body: learning.view };
   return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  }
  return undefined;
 } });
 const learningCalls = () => cell.request.mock.calls.map(([request]) => request).filter(request => request.path.split("?")[0]!.startsWith(LEARNING_PATH));
 return { ...cell, learning, learningCalls, learningReads: () => learningCalls().filter(request => request.method === "GET").length, learningWrites: () => learningCalls().filter(request => request.method !== "GET") };
}
