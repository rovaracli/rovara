// @vitest-environment jsdom
// DEC 254zzz84 (1): the "AI models for each step" card (setup's AI and spending step and Company settings). An owner or admin picks a model for each step from the
// company's offered list, or puts it back on the company's model; each change is sent at once with the revision the card read. A member sees it read only. A step's
// price shows when Code knows it. Refusals are the server's fixed sentences.
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { priceText, readAgentModels } from "../../packages/ui/src/api/agent-models.js";
import { STEP_MODELS_WORDS, StepModelsCard } from "../../packages/ui/src/screens/setup/StepModelsCard.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const OFFERED = ["claude-sonnet-5-5", "zai.glm-5", "qwen.qwen3-coder-480b-a35b-v1:0"];
const STAGES = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"];
type Respond = (r: ApiRequest) => ApiResponse | Promise<ApiResponse>;

function mount(role: "owner" | "admin" | "member", respond: Respond) {
 const f = fakeHost(async r => respond(r));
 const query = createQueryClient();
 const router = createMemoryRouter([{ path: "/app/setup", element: h(StepModelsCard, { developerId: me, role }) }], { initialEntries: ["/app/setup"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...f, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
function cloud(canChange: boolean, refuse?: ApiResponse) {
 const state = { revision: 0, steps: {} as Record<string, string> };
 const writes: ApiRequest[] = [];
 const respond: Respond = (r) => {
  if (r.path !== "/v1/app/org/agent-models") return { status: 404, body: {} };
  if (r.method === "POST") {
   writes.push(r);
   if (refuse !== undefined) return refuse;
   const body = r.body as { action: string; stage: string; model?: string };
   const group = body.stage === "plan" ? ["understand", "plan"] : body.stage === "code_review" ? ["code_review", "security_review"] : [body.stage];
   for (const stage of group) { if (body.action === "clear") delete state.steps[stage]; else state.steps[stage] = body.model!; }
   state.revision += 1;
   return { status: 200, body: { ok: true, revision: state.revision } };
  }
  return { status: 200, body: { revision: state.revision, offered: OFFERED, canChange, steps: STAGES.map(stage => ({ stage, setting: state.steps[stage] ?? null, refused: false,
   effective: { model: state.steps[stage] ?? "claude-sonnet-5-5", companyDefault: state.steps[stage] === undefined, ...(stage === "build" ? { priceUsdPerMillion: { input: 3, output: 15 } } : {}) } })) } };
 };
 return { state, writes, respond };
}

describe("the step models card", () => {
 it("an owner picks a step's model from the offered list; the change names the revision it read", async () => {
  const c = cloud(true);
  const m = mount("owner", c.respond);
  const coding = await screen.findByLabelText("Coding");
  expect([...(coding as HTMLSelectElement).options].map(o => o.value).filter(v => v !== "")).toEqual(["@company", ...OFFERED]);
  expect(screen.getByTestId("step-model-price-build").textContent).toBe("$3 in / $15 out per million tokens");
  expect(screen.queryByTestId("second-review-model-row")).toBeNull();
  await expectNoAxeViolations(document.body);
  expect(screen.getByTestId("step-model-price-plan").textContent).toBe(STEP_MODELS_WORDS.noPrice);
  fireEvent.change(coding, { target: { value: "zai.glm-5" } });
  await screen.findByTestId("step-models-saved");
  expect(c.writes.map(w => w.body)).toEqual([{ action: "set", stage: "build", model: "zai.glm-5", expectedRevision: 0 }]);
  await waitFor(() => expect((screen.getByLabelText<HTMLSelectElement>("Coding")).value).toBe("zai.glm-5"));
  // Back to the company's model: a clear, with the new revision.
  fireEvent.change(screen.getByLabelText("Coding"), { target: { value: "@company" } });
  await waitFor(() => expect(c.writes).toHaveLength(2));
  expect(c.writes[1]!.body).toEqual({ action: "clear", stage: "build", expectedRevision: 1 });
  m.close();
 });

 it("a member sees the steps read only and can change nothing", async () => {
  const c = cloud(false);
  const m = mount("member", c.respond);
  await screen.findByTestId("step-models-read-only");
  expect(screen.queryByLabelText("Coding")).toBeNull();
  expect(screen.getByTestId("step-model-build").textContent).toContain("Rovara's default (currently claude-sonnet-5-5)");
  expect(c.writes).toEqual([]);
  m.close();
 });

 it("shows the server's refusal words", async () => {
  const c = cloud(true, { status: 400, body: { error: { code: "MODEL_NOT_OFFERED", message: "That model isn't offered to this company now, or this change isn't allowed. Reload and pick from the list." } } });
  const m = mount("admin", c.respond);
  fireEvent.change(await screen.findByLabelText("Plan check"), { target: { value: "zai.glm-5" } });
  expect((await screen.findByTestId("step-models-error")).textContent).toBe("That model isn't offered to this company now, or this change isn't allowed. Reload and pick from the list.");
  m.close();
 });

 it("says 'not available yet' when this Rovara doesn't serve step models", async () => {
  const m = mount("owner", () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "x" } } }));
  expect((await screen.findByTestId("step-models-read-error")).textContent).toBe(STEP_MODELS_WORDS.notYet);
  m.close();
 });
});

describe("prices", () => {
 it("where Code knows no step's price, the rate stays explicitly unavailable", async () => {
  const steps = STAGES.map(stage => ({ stage, setting: null, refused: false, effective: { model: "claude-sonnet-5-5", companyDefault: true } }));
  const m = mount("owner", () => ({ status: 200, body: { revision: 0, offered: OFFERED, canChange: true, steps } }));
  expect((await screen.findByTestId("step-model-build")).textContent).toContain("Runs on claude-sonnet-5-5 (company model).");
  expect(screen.getByTestId("step-model-price-build").textContent).toBe("Price unavailable.");
  m.close();
 });
});

describe("the reader", () => {
 it("refuses a body that is not the shape, never half drawn", () => {
  const good = { revision: 1, offered: ["zai.glm-5"], canChange: true, steps: [{ stage: "build", setting: null, refused: false, effective: { model: "zai.glm-5", companyDefault: true } }] };
  expect(readAgentModels(good).steps).toHaveLength(1);
  for (const bad of [null, {}, { ...good, offered: [] }, { ...good, steps: [{ ...good.steps[0], stage: "deploy" }] }, { ...good, steps: [{ ...good.steps[0], setting: "<b>" }] }, { ...good, steps: [{ ...good.steps[0], effective: { model: "zai.glm-5", companyDefault: true, priceUsdPerMillion: { input: -1, output: 1 } } }] }]) {
   expect(() => readAgentModels(bad)).toThrow();
  }
  expect(priceText(undefined)).toBeUndefined();
  expect(priceText({ input: 0.25, output: 1.25 })).toBe("$0.25 in / $1.25 out per million tokens");
  expect(priceText({ input: 0.075, output: 3.3 })).toBe("$0.075 in / $3.30 out per million tokens");
  expect(priceText({ input: 0.0004, output: 15 })).toBe("$0.0004 in / $15 out per million tokens");
 });
});
