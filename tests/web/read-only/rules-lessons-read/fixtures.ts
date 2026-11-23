import { AppMeResponseReaderSchema, HowWeWorkViewReaderSchema, AgentVersionsResponseReaderSchema, StageModelsResponseReaderSchema, WeeklyLessonsReaderSchema, LessonRepeatsReaderSchema, ProjectPlaybookResponseReaderSchema } from "@agentx/contracts/web";
import { howWeWorkView, LAYER } from "../../support/how-we-work-view.js";
import { stageModelsRaw } from "../../support/stage-models-raw.js";
import { meFixture } from "../../support/fixtures.js";
import type { ApiRequest, ApiResponse } from "../../../../packages/ui/src/host.js";
import { recipeReader } from "../../../../packages/ui/src/screens/rules-lessons-read/read-model.js";
export { LAYER };
export const ROOT = "/v1/app/projects/payments";
export const lesson = { id: "les_retry", title: "Retry only idempotent calls", body: "Use the shared retry helper for idempotent requests.", description: "Bound retries to three attempts.", status: "active", version: 2, counters: { loaded: 4, helpful: 2, harmful: 1 }, supportTasks: 2, type: "instruction", stages: ["build"], scope: { repos: ["acme/payments"], paths: [], languages: [] }, tier: 1, createdAt: 1794744000000, updatedAt: 1794744000000, expiresAt: 1797336000000, citations: [], from: [], measured: false, canApprove: false, canReject: false, canRetire: true };
export const bodies = () => ({
 identity: AppMeResponseReaderSchema.parse(meFixture({ developer: { ...meFixture().developer, orgRole: "admin" } })),
 how: HowWeWorkViewReaderSchema.parse(howWeWorkView()),
 playbook: ProjectPlaybookResponseReaderSchema.parse({ playbook: { revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode: "always", tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } } }, designReviewAllowed: true }),
 history: AgentVersionsResponseReaderSchema.parse({ versions: [{ version: 2, current: true, publishedBy: "Priya", publishedAt: "2026-11-15T12:00:00Z", note: "Keep changes small" }] }),
 models: StageModelsResponseReaderSchema.parse(stageModelsRaw()),
 page: { project: "payments", list: "approved" as const, lessons: [lesson], partial: false },
 weekly: WeeklyLessonsReaderSchema.parse({ project: "payments", weekly: { needLook: [{ lessonId: lesson.id, title: lesson.title, cause: "asked_to_keep" }], picks: [] } }),
 repeats: LessonRepeatsReaderSchema.parse({ project: "payments", month: "2026-11", repeated: 2, corrections: 12, enoughData: true, split: {}, truncated: false }),
 inbox: { state: "on" as const, batches: [{ project: "payments", lessons: [{ ...lesson, status: "pending" }], partial: true }], unavailable: [] as string[] },
 recipes: recipeReader.parse({ recipes: [{ recipeId: "node", revision: 1, digest: "fixture", status: "approved", label: "Node service", buildSystems: ["npm"], toolchains: [], setup: [{ line: "npm ci", timeoutSeconds: 300 }], update: [], checks: [], approvedHosts: ["registry.npmjs.org"], match: { markerFiles: ["package.json"], registryHosts: [] }, scope: { kind: "company" }, fromProject: false, proposedBy: "Priya", createdByYou: false, replaces: [], updatedAt: "2026-11-15T12:00:00Z" }], unreadable: [], projects: ["payments"], markerFiles: ["package.json"] }),
});
export function responder(data = bodies()) {
 return async (request: ApiRequest): Promise<ApiResponse> => {
  if (request.method !== "GET") throw new Error("Mutation attempted");
  const url = new URL(request.path, "https://fixture.invalid");
  const path = url.pathname;
  const table: Record<string, unknown> = { "/v1/app/me": data.identity, [ROOT + "/how-we-work"]: data.how, [ROOT + "/playbook"]: data.playbook, [ROOT + "/stage-models"]: data.models, [ROOT + "/lessons"]: { ...data.page, list: url.searchParams.get("list") ?? "approved" }, [ROOT + "/lessons/weekly"]: data.weekly, [ROOT + "/lessons/repeats"]: data.repeats, ["/v1/app/agents/" + LAYER + "/versions"]: data.history, "/v1/app/lessons/inbox": data.inbox, "/v1/app/org/setup-recipes": data.recipes };
  return path in table ? { status: 200, body: table[path] } : { status: 404, body: { error: { code: "NOT_FOUND", message: "No fixture read" } } };
 };
}
