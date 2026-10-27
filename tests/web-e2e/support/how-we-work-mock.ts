// The project's process layer for the "How we work" journey: the effective view, the ensure call and the layer's draft, diff, publish and versions. State lives for one scenario.
import { AgentDraftPutBodySchema, AgentPublishBodySchema } from "@agentx/contracts/web";
import { agentProfile } from "../../web/support/agent-fixture.js";
import { LAYER, diffBody, draftBody, howWeWorkView } from "../../web/support/how-we-work-view.js";
let layer = fresh();
function fresh() { return { overlay: { instructions: "Keep changes small." } as Record<string, unknown>, revision: 3, version: 2 }; }
export function resetHowWeWork(): void { layer = fresh(); }
export interface MockExchange { url: URL; method: string; body: () => Promise<unknown>; json: (status: number, body: unknown) => void; record: (body: unknown) => void }
/** Answers the How we work routes of the `project` scenario; false when the request is not one of them. */
export async function howWeWorkMock({ url, method, body, json, record }: MockExchange): Promise<boolean> {
 const agent = `/v1/web/agents/${LAYER}`, project = "/v1/web/projects/payments";
 if (url.pathname === `${project}/how-we-work` && method === "GET") { json(200, howWeWorkView({ process: { kind: "project_process", agentId: LAYER, version: layer.version, draftRevision: layer.revision } }));return true; }
 if (url.pathname === `${project}/playbook/process` && method === "POST") { json(200, { agentId: LAYER, draftRevision: layer.revision, currentVersion: layer.version });return true; }
 if (url.pathname === `${agent}/draft` && method === "GET") { json(200, draftBody(layer.overlay, layer.revision));return true; }
 if (url.pathname === `${agent}/draft` && method === "PUT") {
  const input = AgentDraftPutBodySchema.parse(await body());record(input);
  if (input.expectedRevision !== layer.revision) { json(409, { error: { code: "AGENT_REVISION_CONFLICT", message: "Someone else changed this draft. Reload and try again." } });return true; }
  layer = { ...layer, overlay: input.overlay, revision: layer.revision + 1 };json(200, draftBody(layer.overlay, layer.revision));return true;
 }
 if (url.pathname === `${agent}/diff` && method === "GET") { json(200, diffBody(Number(url.searchParams.get("from")), ["Changes the project rules"], [], url.searchParams.get("to") === "draft" ? "draft" : Number(url.searchParams.get("to"))));return true; }
 if (url.pathname === `${agent}/publish` && method === "POST") {
  const input = AgentPublishBodySchema.parse(await body());record(input);
  if (input.expectedRevision !== layer.revision) { json(409, { error: { code: "AGENT_REVISION_CONFLICT", message: "Someone else changed this draft. Reload and try again." } });return true; }
  layer = { ...layer, version: layer.version + 1 };json(200, { agent: { ...agentProfile().agent, agentId: LAYER, currentVersion: layer.version }, version: { version: layer.version } });return true;
 }
 if (url.pathname === `${agent}/versions` && method === "GET") { json(200, { versions: [{ version: layer.version, current: true, publishedAt: "2026-10-26T12:00:00.000Z", note: "Current rules" }, { version: 1, publishedAt: "2026-10-25T12:00:00.000Z", note: "First rules" }] });return true; }
 return false;
}
