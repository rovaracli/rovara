// exp/automations: the routes the Automations tab reads and writes, for the `project` scenario, once a journey asks (POST /__mock/automations { mode: "edit" | "readonly" }). Asking also turns the navigation answer's
// `features.chains` on for that scenario object (the gate); not asked, nothing here answers and the cell is exactly as before. A pause is at once; a resume is held for a person (202 with the cell's own approve link).
import { AutomationTriggerPutBodySchema } from "@agentx/cloud-contracts";
import { chainOf, projectAutomations, runList, triggerOf, CHAIN_ID, TRIGGER_ID, RUN_ID } from "../../web/support/automations-fixture.js";
import { mockCellOrigin } from "./port.js";
import type { MockExchange } from "./how-we-work-mock.js";

type Trigger = ReturnType<typeof triggerOf>;
let asked: { scenario: unknown; mode: "edit" | "readonly"; triggers: Trigger[] } | undefined;
const WAITING = "waiting for someone to confirm turning it on";
const fresh = (): Trigger[] => [
  triggerOf({ lastFiredAt: "2026-11-11T08:00:00.000Z", lastRunId: RUN_ID }),
  triggerOf({ triggerId: "ctr_" + "9".repeat(20), spec: { kind: "schedule", schedule: { kind: "daily", at: "09:30" }, timezone: "Europe/Berlin", missed: "run_once" }, enabled: false }),
];
/** The ask: POST /__mock/automations. Answered where the other `/__mock/` asks are, before any session check. */
export async function automationsAsk({ url, method, body, json, scenario }: Pick<MockExchange, "url" | "method" | "body" | "json"> & { scenario: { nav: { features: { chains: boolean } } } }): Promise<boolean> {
  if (url.pathname !== "/__mock/automations" || method !== "POST") return false;
  const input = await body() as { mode?: unknown };
  asked = { scenario, mode: input.mode === "readonly" ? "readonly" : "edit", triggers: fresh() };
  scenario.nav.features.chains = true;json(200, { ok: true });return true;
}
/** The routes, after the session check and the request log. False when nobody asked, or the request is not one of these. */
export async function automationsMock({ url, method, body, json, record, scenario }: MockExchange & { scenario: unknown }): Promise<boolean> {
  if (asked === undefined || asked.scenario !== scenario) return false;
  const state = asked;
  if (method === "GET" && url.pathname === "/v1/web/projects/payments/automations") {
    json(200, projectAutomations({ canEdit: state.mode === "edit", triggers: state.triggers.map(trigger => ({ ...trigger, targetName: "Refund triage" })) as never }));return true;
  }
  if (method === "GET" && url.pathname === "/v1/web/chain-runs") { json(200, runList());return true; }
  if (method === "GET" && url.pathname === `/v1/web/chains/${CHAIN_ID}`) { json(200, { chain: chainOf({ access: state.mode === "edit" ? "manage" : "view" }) });return true; }
  const put = /^\/v1\/web\/chains\/[^/]+\/triggers\/(ctr_[0-9a-z]{20})$/.exec(url.pathname);
  if (put !== null && method === "PUT") {
    const input = await body();record(input);
    const parsed = AutomationTriggerPutBodySchema.safeParse(input), index = state.triggers.findIndex(trigger => trigger.triggerId === put[1]);
    if (state.mode !== "edit") { json(403, { error: { code: "FORBIDDEN", message: "Only a maintainer of payments can change its automations." } });return true; }
    if (!parsed.success || index < 0) { json(400, { error: { code: "CONFIG_INVALID", message: "The trigger isn't valid." } });return true; }
    const current = state.triggers[index]!;
    if (parsed.data.enabled === false) { const { disabledReason: _gone, ...rest } = current;void _gone;state.triggers[index] = triggerOf({ ...rest, enabled: false });json(200, { trigger: state.triggers[index] });return true; }
    state.triggers[index] = triggerOf({ ...current, enabled: false, disabledReason: WAITING });
    json(202, { status: "NEEDS_CONFIRMATION", confirmUrl: mockCellOrigin() + "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["turn on a daily trigger for payments"] });return true;
  }
  return false;
}
export const AUTOMATIONS_TRIGGER = TRIGGER_ID;
