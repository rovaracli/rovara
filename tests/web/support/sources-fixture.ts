// The Sources tab for a person who may edit sources: the editors' view (GET /v1/app/projects/{p}/record/sources) and a cell that answers it and its writes. The view and every body the screen sends are
// parsed by the contract's own strict schemas, as the route does.
import { SourceWriteBodySchema, SourcesAdminViewSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { lessonsHost, ok, refusal } from "./lessons-fixture.js";

export const RECORD_SOURCES_PATH = "/v1/app/projects/payments/record/sources";
type Raw = Record<string, unknown>;
export const adminRow = (over: Raw = {}) => ({
 kind: "github", scope: "github:repo/9", enabled: true, retention: "C", health: "ok", audience: "project", excluded: 0, updatedAt: "2026-10-30T10:00:00.000Z", paused: false, revision: 3, addedBy: "a".repeat(64), exclude: [], ...over,
});
export const adminView = (over: Raw = {}) => SourcesAdminViewSchema.parse({
 sources: [adminRow()], otherPaused: 0, canEdit: true,
 offered: { github: ["A", "B", "C", "D"], rovara: ["A", "B", "C", "D"], slack: ["A", "B"], linear: ["A", "B", "C"], jira: ["A", "B", "C"], codehost: ["A", "B", "C", "D"], mcp: ["A"] },
 repositories: [{ name: "payments-api", scope: "github:repo/9" }, { name: "web-app", scope: "github:repo/12" }], ...over,
});
/** A reply of the route, as the broker sends it: a thrown fixed error is wrapped (`{error:{code,message}}`); the route's own refusals are flat (`{code,message}`). */
export const wrapped = (code: string, message: string, status: number): ApiResponse => refusal(code, message, status);
export const flat = (code: string, message: string, status: number): ApiResponse => ({ status, body: { code, message } });

export function sourcesWorld(options: { view?: unknown; adminRead?: ApiResponse; canEdit?: boolean; readable?: unknown; lessonsSources?: ApiResponse; write?: (body: Raw, request: ApiRequest) => ApiResponse | undefined } = {}) {
 const state = { view: options.view ?? adminView() }, posts: Raw[] = [];
 const cell = lessonsHost({
  ...(options.canEdit === undefined ? {} : { canEdit: options.canEdit }),
  ...(options.readable === undefined ? {} : { state: { sources: options.readable } }),
  ...(options.lessonsSources === undefined ? {} : { lessons: (_request: ApiRequest, url: URL) => url.pathname.endsWith("/lessons/sources") ? options.lessonsSources : undefined }),
  handle: (request, url) => {
   if (url.pathname !== RECORD_SOURCES_PATH) return undefined;
   if (request.method === "GET") return options.adminRead ?? ok(state.view);
   const body = request.body as Raw;
   SourceWriteBodySchema.parse(body);
   posts.push(body);
   return options.write?.(body, request) ?? ok({ status: "saved", revision: 4 });
  },
 });
 const recordCalls = () => cell.request.mock.calls.map(([request]) => request).filter(request => request.path.split("?")[0] === RECORD_SOURCES_PATH);
 return { ...cell, state, posts, recordCalls, recordReads: () => recordCalls().filter(request => request.method === "GET") };
}
