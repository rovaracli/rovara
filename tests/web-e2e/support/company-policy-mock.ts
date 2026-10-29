// The company model-selection policy for the company "How we work" journey: GET, the paged preview and the PUT (200, 202 and the sole-owner 202). State lives for one scenario.
import { applied, companyPolicyRaw, needsConfirmation, previewPage } from "../../web/support/company-policy-raw.js";
import { mockCellOrigin } from "./port.js";
type Overrides = Record<string, { locked?: boolean }>;
let state = fresh();
function fresh() { return { revision: 4, overrides: companyPolicyRaw().stepOverrides as Overrides, soleOwner: false }; }
export function resetCompanyPolicy(): void { state = fresh(); }
export interface CompanyExchange { url: URL; method: string; body: () => Promise<unknown>; json: (status: number, body: unknown) => void; record: (body: unknown) => void }
/** Answers the company policy routes; false when the request is not one of them. A PUT that removes a lock is a loosening change: 202 (the sole-owner answer when the journey asked for it); anything else is applied. */
export async function companyPolicyMock({ url, method, body, json, record }: CompanyExchange): Promise<boolean> {
 const path = "/v1/web/org/model-selection-policy";
 if (url.pathname === "/__mock/company-policy" && method === "POST") { const input = await body() as { soleOwner?: boolean; moveOn?: boolean };if (input.soleOwner !== undefined) state.soleOwner = input.soleOwner;if (input.moveOn === true) state.revision += 1;json(200, { ok: true });return true; }
 if (url.pathname === path && method === "GET") { json(200, { ...companyPolicyRaw({}, state.revision), stepOverrides: state.overrides });return true; }
 if (url.pathname === path + "/preview" && method === "POST") { const input = await body() as { expectedRevision: number; cursor?: string };record(input);if (input.expectedRevision !== state.revision) { json(409, { error: { code: "POLICY_STALE", message: "Stale." } });return true; }json(200, previewPage(input.cursor));return true; }
 if (url.pathname === path && method === "PUT") {
  const input = await body() as { expectedRevision: number; requestId: string; stepOverrides: Overrides };record(input);
  if (input.expectedRevision !== state.revision) { json(409, { error: { code: "POLICY_STALE", message: "Stale." } });return true; }
  const loosens = Object.entries(state.overrides).some(([stage, entry]) => entry.locked === true && input.stepOverrides[stage]?.locked !== true);
  if (loosens) { json(202, needsConfirmation(mockCellOrigin(), input.requestId, state.soleOwner ? "2026-10-30T12:00:00.000Z" : undefined));return true; }
  state = { ...state, revision: state.revision + 1, overrides: input.stepOverrides };json(200, applied(state.revision, input.requestId));return true;
 }
 return false;
}
