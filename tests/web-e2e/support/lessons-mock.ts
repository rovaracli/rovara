// The project's lessons routes for the Lessons tab journey: the view, approve, reject, remove and the sources. State lives for one scenario. Bodies are parsed by the contract's strict schemas,
// as the real routes do, and the one-tap / two-person rules are applied here the way the broker applies them (a second person is a different one; a stale version is refused).
import { LessonApproveBodySchema, LessonRejectBodySchema, LessonRetireBodySchema, LessonSourcesSchema, LessonViewSchema, LessonsDigestSchema, LessonsViewSchema, SourceWriteBodySchema, SourcesAdminViewSchema } from "@agentx/contracts";
import type { MockExchange } from "./how-we-work-mock.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
interface Mock { id: string; version: number; title: string; body: string; tier: 1 | 2; status: "pending" | "active" | "retired" | "rejected"; first?: string; reason?: string }
let state = fresh();
function fresh() { return { lessons: [
 { id: "les_one00001", version: 1, title: "Use the shared retry helper", body: "Call withRetry for HTTP calls in the api repository.", tier: 1, status: "pending" },
 { id: "les_two00001", version: 1, title: "Reviewers check auth on new routes", body: "Review every new route for an authorization check.", tier: 2, status: "pending", first: "Ann Archer" },
 { id: "les_thr00001", version: 1, title: "Skip flaky integration tests on branches", body: "Branch builds may skip the flaky integration suite.", tier: 2, status: "pending" },
 { id: "les_act00001", version: 3, title: "Prefer small pull requests", body: "Keep pull requests under 400 lines.", tier: 1, status: "active" },
] as Mock[] }; }
/** Lanes 1b: why learning is paused for the project (a fixed code), or nothing. */
let paused: string | undefined;
export function setLessonsPaused(code: string | undefined): void { paused = code; }
export function resetLessons(): void { state = fresh();sources = freshSources();paused = undefined; }

// The Team record's source rows (source-row lane T5): the editors' view and the writes of `/record/sources`. Off until a test switches editing on; until then the route is absent (404) and the Sources tab is the read-only list.
interface SourceMock { kind: string; scope: string; retention: string; audience: string; enabled: boolean; revision: number; exclude: string[] }
const SOURCE_REPOS = [{ name: "payments-api", scope: "github:repo/9" }, { name: "web-app", scope: "github:repo/12" }];
function freshSources() { return { editing: false, rows: [{ kind: "github", scope: "github:repo/9", retention: "C", audience: "project", enabled: true, revision: 1, exclude: [] }] as SourceMock[] }; }
let sources = freshSources();
export function setSourceEditing(on: boolean): void { sources.editing = on; }
const sourcesView = () => SourcesAdminViewSchema.parse({
 sources: sources.rows.map(row => ({ kind: row.kind, scope: row.scope, enabled: row.enabled, retention: row.retention, health: "ok", audience: row.audience, excluded: row.exclude.length, updatedAt: "2026-10-30T10:00:00.000Z", paused: false, revision: row.revision, addedBy: "a".repeat(64), exclude: row.exclude })),
 otherPaused: 0, canEdit: true, offered: { github: ["A", "B", "C", "D"], rovara: ["A", "B", "C", "D"], slack: ["A", "B"], linear: ["A", "B", "C"], jira: ["A", "B", "C"] }, repositories: SOURCE_REPOS,
});
async function sourcesRoute({ method, body, json, record }: MockExchange): Promise<void> {
 if (!sources.editing) { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return; }
 if (method === "GET") { json(200, sourcesView());return; }
 const input = await body();record(input);
 const parsed = SourceWriteBodySchema.parse(input);
 if (parsed.action === "add") { sources.rows.push({ kind: parsed.source, scope: parsed.scope, retention: parsed.retention, audience: parsed.audienceDefault, enabled: parsed.enabled, revision: 1, exclude: parsed.exclude ?? [] });json(200, { status: "saved", revision: 1 });return; }
 const found = sources.rows.find(row => row.kind === parsed.source && row.scope === parsed.scope);
 if (found === undefined) { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return; }
 if (found.revision !== parsed.expectedRevision) { json(409, { error: { code: "CHANGE_STALE", message: "Someone changed this source." } });return; }
 if (parsed.action === "remove") { sources.rows = sources.rows.filter(row => row !== found);json(200, { status: "removed" });return; }
 if (parsed.retention !== undefined) found.retention = parsed.retention;
 if (parsed.audienceDefault !== undefined) found.audience = parsed.audienceDefault;
 if (parsed.enabled !== undefined) found.enabled = parsed.enabled;
 if (parsed.exclude !== undefined) found.exclude = parsed.exclude;
 found.revision += 1;json(200, { status: "saved", revision: found.revision });
}
const person = (name: string) => ({ name, ...(name === "You" ? { you: true as const } : {}) });
const lesson = (item: Mock) => LessonViewSchema.parse({
 id: item.id, version: item.version, type: item.tier === 2 ? "review_check" : "convention", stages: item.tier === 2 ? ["REVIEW"] : ["IMPLEMENT"], title: item.title, description: "", body: item.body,
 scope: { repos: ["api"], paths: [], languages: [] }, tier: item.tier, tierReasons: item.tier === 2 ? ["reviewer_stage", "escalation_words"] : ["scope_not_one_repo"], status: item.status,
 counters: { loaded: 5, helpful: item.status === "active" ? 4 : 0, harmful: item.status === "active" ? 1 : 0 }, createdAt: NOW - 9 * 86_400_000, updatedAt: NOW - 86_400_000, expiresAt: NOW + 60 * 86_400_000,
 citations: [{ kind: "code", repo: "api", path: "src/retry/index.ts", startLine: 12, endLine: 30, check: "valid", checkedAt: NOW - 7_200_000 }, { kind: "pr", url: "https://github.com/acme/api/pull/42" }],
 from: [person("Carl Cole")], measured: item.tier === 2, supportTasks: 2,
 ...(item.status === "pending" ? { needs: { required: item.tier === 2 ? 2 : 1, have: item.first === undefined ? 0 : 1, ...(item.first === undefined ? {} : { first: person(item.first), firstAt: NOW - 7_200_000 }), groups: [] } } : {}),
 approvals: item.first === undefined ? [] : [{ by: person(item.first), at: NOW - 7_200_000, mode: "one" }],
 canApprove: item.status === "pending" && item.first !== "You", canReject: item.status === "pending", canRetire: item.status !== "retired" && item.status !== "rejected",
});
const view = () => LessonsViewSchema.parse({
 project: "payments", mode: "Suggest", lockedByCompany: false, approval: { tier0: "one", tier1: "one", requiredGroups: [] }, canDecide: true,
 waiting: state.lessons.filter(item => item.status === "pending").map(lesson), active: state.lessons.filter(item => item.status === "active").map(lesson),
 removed: state.lessons.filter(item => item.status === "retired" || item.status === "rejected").map(lesson), queued: 2, hidden: 0, truncated: [], setVersion: 4, snapshots: [],
 ...(paused === undefined ? {} : { paused: { code: paused, at: NOW, scope: paused === "monthly_limit" ? "company" : "project" } }),
});
const stale = { error: { code: "CHANGE_STALE", message: "This lesson changed while you were looking at it. Reload and check it again." } };

/** Answers the lessons routes of the `project` scenario; false when the request is not one of them. */
export async function lessonsMock({ url, method, body, json, record }: MockExchange): Promise<boolean> {
 const base = "/v1/web/projects/payments/lessons";
 if (url.pathname === "/v1/web/projects/payments/record/sources") { await sourcesRoute({ url, method, body, json, record });return true; }
 if (url.pathname === base && method === "GET") { json(200, view());return true; }
 if (url.pathname === base + "/digest" && method === "GET") { json(200, LessonsDigestSchema.parse({ since: NOW - 7 * 86_400_000, top: [{ id: "les_act00001", title: "Prefer small pull requests", type: "convention", tier: 1, links: [] }], needsReview: [], autoApplied: [], waiting: [], retired: [], staleOrRetireProposed: [], queued: 2, pausedSources: [], pausedSourcesHidden: 0, hidden: 0 }));return true; }
 if (url.pathname === base + "/sources" && method === "GET") { json(200, LessonSourcesSchema.parse({ sources: [{ kind: "github", scope: "github:acme/api", enabled: true, retention: "D", health: "ok", audience: "project", updatedAt: "2026-10-30T10:00:00.000Z", paused: false }, { kind: "slack", enabled: true, retention: "B", health: "ok", audience: "maintainers", updatedAt: "2026-10-30T10:00:00.000Z", paused: true }], otherPaused: 0 }));return true; }
 const action = new RegExp(`^${base}/([A-Za-z0-9_-]+)/(approve|reject|retire)$`).exec(url.pathname);
 if (action === null || method !== "POST") return false;
 const item = state.lessons.find(candidate => candidate.id === action[1]);
 if (item === undefined) { json(404, { error: { code: "NOT_FOUND", message: "This lesson isn't available." } });return true; }
 const input = await body();record(input);
 if (action[2] === "approve") {
  const parsed = LessonApproveBodySchema.parse(input);
  if (parsed.expectedVersion !== item.version) { json(409, stale);return true; }
  if (item.tier === 2 && item.first === undefined) { item.first = "You";item.version += 1;json(200, { status: "pending", needs: "second_person" });return true; }
  item.status = "active";item.version += 1;json(200, { status: "active", needs: "nothing" });return true;
 }
 if (action[2] === "reject") { const parsed = LessonRejectBodySchema.parse(input);if (parsed.expectedVersion !== item.version) { json(409, stale);return true; }item.status = "rejected";item.reason = parsed.reason;json(200, { done: true });return true; }
 LessonRetireBodySchema.parse(input);item.status = "retired";json(200, { done: true });return true;
}
