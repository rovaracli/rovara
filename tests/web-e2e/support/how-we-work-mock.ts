// The project's process layer for the "How we work" journey: the effective view, the ensure call and the layer's draft, diff, publish and versions. State lives for one scenario.
import { AgentDraftPutBodySchema, AgentPublishBodySchema } from "@agentx/contracts/web";
import { agentProfile } from "../../web/support/agent-fixture.js";
import { LAYER, diffBody, draftBody, howWeWorkView } from "../../web/support/how-we-work-view.js";
import { effective, mid, stageEntry, stageModelsRaw } from "../../web/support/stage-models-raw.js";
let layer = fresh();
function fresh() { return { overlay: { instructions: "Keep changes small." } as Record<string, unknown>, revision: 3, version: 2 }; }
export function resetHowWeWork(): void { layer = fresh(); }
export interface MockExchange { url: URL; method: string; body: () => Promise<unknown>; json: (status: number, body: unknown) => void; record: (body: unknown) => void }
/** Answers the How we work routes of the `project` scenario; false when the request is not one of them. */
export async function howWeWorkMock({ url, method, body, json, record }: MockExchange): Promise<boolean> {
 const agent = `/v1/web/agents/${LAYER}`, project = "/v1/web/projects/payments";
 if (url.pathname === `${project}/how-we-work` && method === "GET") { json(200, howWeWorkView({ process: { kind: "project_process", agentId: LAYER, version: layer.version, draftRevision: layer.revision } }));return true; }
 if (url.pathname === `${project}/stage-models` && method === "GET") {
  const draft = url.searchParams.get("draft");
  if (draft !== null && Number(draft) !== layer.revision) { json(409, { error: { code: "DRAFT_STALE", message: "Stale." } });return true; }
  const steps = (layer.overlay.steps ?? {}) as Record<string, { model?: { provider: string; modelId: string }; thinkingLevel?: string | null; differentCompanyFrom?: string | null }>;
  /** The mock plays the resolver for the step settings the journey writes: a saved choice is the project's choice and what runs. */
  const answer = (stage: string, step: string, fallback: string) => {
   const settings = steps[step], model = settings?.model === undefined ? undefined : settings.model.provider + "/" + settings.model.modelId;
   const choice = settings === undefined ? null : { ...(model === undefined ? {} : { model: mid(model) }), ...(settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel }), ...(typeof settings.differentCompanyFrom === "string" ? { differentFrom: { stage: "build", level: "vendor" } } : {}) };
   return stageEntry(stage, { projectChoice: choice === null || Object.keys(choice).length === 0 ? null : choice, effective: model === undefined ? effective(fallback) : effective(model, { decidedBy: "project", reason: "PROJECT_CHOICE", thinkingLevel: settings?.thinkingLevel ?? null }) });
  };
  json(200, stageModelsRaw({ build: answer("build", "build", "anthropic/claude-sonnet-4-6"), code_review: answer("code_review", "review", "anthropic/claude-opus-5-5"), security_review: answer("security_review", "review", "anthropic/claude-opus-5-5") }, { process: { agentId: LAYER, version: layer.version, draftRevision: layer.revision, digest: "a".repeat(64) } }));return true;
 }
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
