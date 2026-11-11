// Read-only start preview uses the same canonical calculation as admission.
import { expect, it } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, ROVARA_CODE_AGENT_ID, agentGuardrailsKey, builtinSettingsKey, orgScoped, modelSourcesKey, orgProjectCatalogKey } from "@rovara-code/contracts";
import { orgSettingsKey, projectAiKey } from "@agentx/cloud-contracts";
import { MAYA } from "../support/developer-task-broker.js";
import { setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
const path = "/v1/app/projects/payments/start-preview";
async function fixture(state = "enabled") {
 const t = await setup(), policy = orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY"), ai = projectAiKey(TEST_ORG, "payments"), agent = builtinSettingsKey(TEST_ORG, ROVARA_CODE_AGENT_ID);
 t.db.set({ ...policy, entityType: "ORG_TASK_STOP_POLICY", orgId: TEST_ORG, revision: 1, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 2_000_000 } }, enrollment: { version: 1, state } });
 t.db.set({ ...agentGuardrailsKey(TEST_ORG), orgId: TEST_ORG, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 1 } });
 t.db.set({ ...ai, orgId: TEST_ORG, entityType: "PROJECT_AI", project: "payments", revision: 1, projectPays: false, planningLimitUsd: { QUICK: 20, FULL: 20 }, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1_000_000 } });
 t.db.set({ ...t.db.get(agent), ...agent, orgId: TEST_ORG, entityType: "BUILTIN_AGENT_SETTINGS", agentId: ROVARA_CODE_AGENT_ID, revision: 1, stopKind: "limited", maxPerRunUsd: 0.75, pinnedVersion: t.deps().store.builtinDefaultPin(ROVARA_CODE_AGENT_ID) });
 t.db.set({ pk: orgScoped(TEST_ORG, "TASK_STOP_SEED"), sk: "V1#bootstrap", orgId: TEST_ORG, entityType: "TASK_STOP_SEED", version: 1, source: "bootstrap", outcome: "created", policyRevision: 1 });
 const catalog = orgProjectCatalogKey(TEST_ORG, "payments");t.db.set({ ...t.db.get(catalog), ...catalog, orgId: TEST_ORG, entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1 });
 return { t, policy, ai, preview: (body: Record<string, unknown> = {}) => t.api(MAYA, "POST", path, body) };
}
it("start preview returns only the member-visible canonical effective stop with no work effects", async () => {
 const f = await fixture(), result = await f.preview();expect(result.status, JSON.stringify(result.body)).toBe(200);
 expect(Object.keys(result.body).sort()).toEqual(["effectiveStopMicrousd", "kind", "orgId", "project"]);
 expect(result.body).toEqual({ orgId: TEST_ORG, project: "payments", kind: "captured", effectiveStopMicrousd: 750000 });
 expect(f.t.db.find(row => row.entityType === "WORKSPACE" || row.entityType === "DEVELOPER_TASK" || row.entityType === "SPENDING_ADMISSION")).toEqual([]);
 expect(f.t.access.mintKey).not.toHaveBeenCalled();
});
for (const state of ["disabled", "ready"]) it(`start preview shows no amount while ${state}`, async () => {
 const f = await fixture(state);f.t.db.delete(f.ai);
 expect(await f.preview()).toMatchObject({ status: 200, body: { orgId: TEST_ORG, project: "payments", kind: "disabled" } });
});
it("zero remains an informational preview, without admitting work", async () => {
 const f = await fixture();f.t.db.set({ ...f.t.db.get(f.policy)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0 } } });
 expect(await f.preview()).toMatchObject({ status: 200, body: { kind: "captured", effectiveStopMicrousd: 0 } });
});
it("a project viewer cannot read a start preview", async () => {
 const f = await fixture();f.t.grantRole(MAYA, "viewer");expect((await f.preview()).status).toBe(403);
});
it("missing and foreign-only project names cannot reveal policy", async () => {
 const f = await fixture();expect((await f.t.api(MAYA, "POST", "/v1/app/projects/unknown/start-preview", {})).status).toBe(404);
 f.t.db.set({ ...orgProjectCatalogKey("org_bbbbbbbbbbbbbbbbbbbb", "foreign"), orgId: "org_bbbbbbbbbbbbbbbbbbbb", entityType: "PROJECT_CATALOG", name: "foreign", latestRevision: 1 });
 expect((await f.t.api(MAYA, "POST", "/v1/app/projects/foreign/start-preview", {})).status).toBe(404);
});
it("the preview refuses malformed policy and client-supplied monetary inputs", async () => {
 const f = await fixture();expect((await f.preview({ requestedMicrousd: 1 })).status).toBe(400);
 f.t.db.set({ ...f.t.db.get(f.ai)!, taskStopPolicy: { invalid: true } });expect((await f.preview()).status).not.toBe(200);
});

it("exclusive own-source routing is unknown until the actual recipe can prove exemption", async () => {
 const f = await fixture();f.t.db.set({ ...modelSourcesKey(TEST_ORG), orgId: TEST_ORG, revision: 1, sources: [], order: ["personal-chatgpt"], credentials: [], removing: [] });
 expect(await f.preview()).toMatchObject({ status: 200, body: { kind: "unknown", project: "payments" } });
});

it("the selected planning path enters the same numeric identity helper", async () => {
 const f = await fixture();f.t.db.set({ ...f.t.db.get(f.ai)!, planningLimitUsd: { QUICK: 0.5, FULL: 20 } });
 expect(await f.preview()).toMatchObject({ status: 200, body: { effectiveStopMicrousd: 500000 } });
 expect(await f.preview({ path: "FULL" })).toMatchObject({ status: 200, body: { effectiveStopMicrousd: 750000 } });
});

it("the shared calculator preserves the explicit-agent ceiling rule", async () => {
 const f = await fixture();f.t.db.set({ ...agentGuardrailsKey(TEST_ORG), orgId: TEST_ORG, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 0.25 } });
 expect(await f.preview()).toMatchObject({ status: 200, body: { effectiveStopMicrousd: 250000 } });
});
