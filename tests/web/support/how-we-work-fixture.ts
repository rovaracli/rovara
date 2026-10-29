import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { agentProfile } from "./agent-fixture.js";
import { meFixture } from "./fixtures.js";
import { fakeHost } from "./fake-host.js";
import { projectFixture } from "./project-fixture.js";
import { LAYER, diffBody, draftBody, howWeWorkView } from "./how-we-work-view.js";
export { LAYER, diffBody, draftBody, howWeWorkView };
export type Handler = (request: ApiRequest, url: URL) => Promise<ApiResponse | undefined> | ApiResponse | undefined;
/** A cell that answers every route the tab uses; `handle` can answer first (return undefined to fall through). */
export function howWeWorkHost(options: { view?: unknown; canEdit?: boolean; overlay?: Record<string, unknown>; handle?: Handler } = {}) {
 const state = { view: options.view ?? howWeWorkView(), overlay: options.overlay ?? { instructions: "Keep changes small.", steps: { build: { instructions: "Run the linter." } } }, revision: 3 };
 const fake = fakeHost(async request => {
  const url = new URL(request.path, "https://cell.example"), custom = await options.handle?.(request, url);
  if (custom !== undefined) return custom;
  if (url.pathname === "/v1/app/me") return { status: 200, body: meFixture() };
  if (url.pathname === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (url.pathname === "/v1/app/projects/payments/overview") return { status: 200, body: projectFixture({ you: { role: options.canEdit === false ? "viewer" : "maintainer", canStartWork: options.canEdit !== false, canEditSettings: options.canEdit !== false, canViewSpend: false } }) };
  if (url.pathname === "/v1/app/projects/payments/how-we-work") return { status: 200, body: state.view };
  if (url.pathname === "/v1/app/projects/payments/playbook/process") return { status: 200, body: { agentId: LAYER, draftRevision: state.revision, currentVersion: 2 } };
  if (url.pathname === `/v1/app/agents/${LAYER}/draft` && request.method === "GET") return { status: 200, body: draftBody(state.overlay, state.revision) };
  if (url.pathname === `/v1/app/agents/${LAYER}/draft` && request.method === "PUT") { const body = request.body as { overlay: Record<string, unknown> };state.overlay = body.overlay;state.revision += 1;return { status: 200, body: draftBody(state.overlay, state.revision) }; }
  if (url.pathname === `/v1/app/agents/${LAYER}/diff`) return { status: 200, body: diffBody(url.searchParams.get("from") === "base" ? "base" : Number(url.searchParams.get("from")), ["Changes the build instructions"], [], url.searchParams.get("to") === "draft" ? "draft" : Number(url.searchParams.get("to"))) };
  if (url.pathname === `/v1/app/agents/${LAYER}/versions`) return { status: 200, body: { versions: [{ version: 2, current: true, publishedAt: "2026-10-26T12:00:00.000Z", publishedBy: "a".repeat(64), note: "Added build rules" }, { version: 1, publishedAt: "2026-10-25T12:00:00.000Z", note: "First rules", safety: "less_safe", lessSafe: ["Changes the instructions of the review step \"Review\""] }] } };
  if (url.pathname === "/v1/app/org/members") return { status: 200, body: { members: [{ developerId: "a".repeat(64), name: "Priya", role: "admin" }] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 return { ...fake, state, sent: () => fake.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET"), calls: () => fake.request.mock.calls.map(([request]) => request.method + " " + request.path.split("?")[0]) };
}
export const publishedAgent = () => agentProfile().agent;
