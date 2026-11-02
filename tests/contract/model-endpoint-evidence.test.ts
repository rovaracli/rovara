// N8: a company's own model endpoint in governed stage selection. It counts as a source-level candidate (`qualified_endpoint`) only while it is usable NOW, and it
// is never a spending-stop exemption: the task-stop funding proof is not captured for it, so the usual stop rules apply.
import { describe, expect, it } from "vitest";
import { ModelSourceSchema, editionPolicy, egressDomainsKey, orgSettingsKey, type Edition, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { readStageModelEvidence, type StageEvidenceDependencies } from "../../packages/broker/src/model-selection/evidence.js";
import { stageCandidateVerified } from "../../packages/broker/src/model-selection/resolver.js";
import { endpointQualificationDigest } from "../../packages/broker/src/model-sources/endpoint-digest.js";
import type { StoredModelSources } from "../../packages/broker/src/model-sources/store.js";
import { actualCompanyFunding, captureTaskFundingProof, TaskFundingProofSchema } from "../../packages/broker/src/org/task-stop-funding.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const org = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const SRC_ENDPOINT = "src_eeeeeeeeeeeeeeeeeeee";
const SRC_KEYED = "src_abcdefghijklmnopqrst";
const sonnet: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };

function endpointSource(qualified: boolean, extra: Record<string, unknown> = {}) {
  const base = { kind: "endpoint", sourceId: SRC_ENDPOINT, label: "Gateway", baseUrl: "https://llm.example.com/v1", api: "openai-completions", models: [{ name: "our-model", catalog: sonnet }], ...extra };
  const unqualified = ModelSourceSchema.parse(base);
  return qualified && unqualified.kind === "endpoint" ? ModelSourceSchema.parse({ ...base, qualifiedDigest: endpointQualificationDigest(unqualified) }) : unqualified;
}

function fixture(options: { edition?: Edition | "none"; qualified?: boolean; host?: "approved" | "pending" | "none"; forbidden?: ModelIdentifier[] } = {}) {
  const db = new FakeDynamoDb();
  const stored: StoredModelSources = { sources: [endpointSource(options.qualified ?? true)], order: [SRC_ENDPOINT], credentials: [SRC_ENDPOINT], removing: [], revision: 2 };
  if ((options.host ?? "approved") !== "none") {
    db.set({
      ...egressDomainsKey(org, { kind: "model-source", sourceId: SRC_ENDPOINT }), orgId: org, owner: { kind: "model-source", sourceId: SRC_ENDPOINT }, active: true,
      domains: [{ domain: "llm.example.com", status: options.host ?? "approved", requestedAt: "2026-10-21T00:00:00.000Z", requestedBy: "dev-owner" }], updatedAt: "2026-10-21T00:00:00.000Z",
    });
  }
  const deps: StageEvidenceDependencies & { documentClient: FakeDynamoDb; tableName: string } = {
    routing: {
      sources: { read: async () => stored }, egress: { documentClient: db, tableName: "state" }, launch: { kinds: ["endpoint", "anthropic"] },
      ...(options.edition === "none" ? {} : { edition: editionPolicy(options.edition ?? "enterprise") }), forbiddenModels: async () => options.forbidden ?? [],
    },
    now: () => 0, documentClient: db, tableName: "state",
  };
  return { db, deps, stored };
}

const candidatesOf = async (f: ReturnType<typeof fixture>) => (await readStageModelEvidence(f.deps, { orgId: org, project: "web", models: [sonnet] })).candidates;

describe("a company endpoint as stage-selection evidence (N8)", () => {
  it("is a candidate of kind qualified_endpoint when it is usable, and verifies like the other company sources", async () => {
    const f = fixture();
    const [candidate] = await candidatesOf(f);
    expect(candidate).toMatchObject({ model: sonnet, sourceId: SRC_ENDPOINT, enabled: true, inEffectiveOrder: true, evidence: { orgId: org, sourcesRevision: 2, kind: "qualified_endpoint" } });
    expect(stageCandidateVerified({ orgId: org, stage: "build", sourcesRevision: 2, candidates: [candidate!], forbidden: [] }, candidate!)).toBe(true);
    // The evidence belongs to the org, the revision and a company source id: it proves nothing for Rovara's own source or a ChatGPT plan.
    expect(stageCandidateVerified({ orgId: org, stage: "build", sourcesRevision: 2, candidates: [], forbidden: [] }, { ...candidate!, sourceId: "rovara" })).toBe(false);
    expect(stageCandidateVerified({ orgId: org, stage: "build", sourcesRevision: 2, candidates: [], forbidden: [] }, { ...candidate!, sourceId: "personal-chatgpt" })).toBe(false);
    expect(stageCandidateVerified({ orgId: org, stage: "build", sourcesRevision: 3, candidates: [], forbidden: [] }, candidate!)).toBe(false);
  });

  it.each([
    ["Public", { edition: "public" as const }], ["no edition", { edition: "none" as const }], ["not qualified", { qualified: false }], ["host pending", { host: "pending" as const }],
    ["no host item", { host: "none" as const }], ["its catalog model forbidden", { forbidden: [sonnet] }],
  ])("is no candidate when %s", async (_name, options) => {
    expect(await candidatesOf(fixture(options))).toEqual([]);
  });

  it("counts as endpoint evidence only for an endpoint source (N3)", async () => {
    const [candidate] = await candidatesOf(fixture());
    expect(candidate!.sourceKind).toBe("endpoint");
    const input = { orgId: org, stage: "build" as const, sourcesRevision: 2, candidates: [], forbidden: [] };
    for (const sourceKind of [undefined, "anthropic", "bedrock", "openai"]) {
      expect(stageCandidateVerified(input, { ...candidate!, sourceKind }), String(sourceKind)).toBe(false);
    }
    // And an endpoint source's candidate is never verified by another kind's proof.
    for (const kind of ["stored_key", "tested_bedrock_role"] as const) {
      expect(stageCandidateVerified(input, { ...candidate!, evidence: { ...candidate!.evidence!, kind } })).toBe(false);
    }
    // A stored-key candidate that carries no source kind still verifies, as before.
    expect(stageCandidateVerified(input, { ...candidate!, sourceKind: undefined, evidence: { ...candidate!.evidence!, kind: "stored_key" } })).toBe(true);
    expect(stageCandidateVerified(input, { ...candidate!, sourceKind: "anthropic", evidence: { ...candidate!.evidence!, kind: "stored_key" } })).toBe(true);
  });

  it("is no candidate when the kind is not at launch", async () => {
    const f = fixture();
    f.deps.routing.launch = { kinds: ["anthropic"] };
    expect(await candidatesOf(f)).toEqual([]);
  });
});

describe("a company endpoint never exempts a task from the spending stop (N8)", () => {
  const enrolled = (db: FakeDynamoDb) => db.set({ ...orgSettingsKey(org, "TASK_STOP_POLICY"), entityType: "ORG_TASK_STOP_POLICY", revision: 1, enrollment: { version: 1, state: "enabled" } });

  it("captures no funding proof for an order whose only source is a usable endpoint", async () => {
    const f = fixture();
    enrolled(f.db);
    expect(await captureTaskFundingProof(f.deps, { orgId: org, project: "web", models: [sonnet] })).toBeUndefined();
  });

  it("still captures a proof for a stored-key source in the same install (positive control for the fixture)", async () => {
    const f = fixture();
    enrolled(f.db);
    f.stored.sources = [ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC_KEYED, label: "Company Anthropic", models: [{ catalog: sonnet }] })];
    f.stored.order = [SRC_KEYED];
    f.stored.credentials = [SRC_KEYED];
    const proof = await captureTaskFundingProof(f.deps, { orgId: org, project: "web", models: [sonnet] });
    expect(proof?.sources).toEqual([{ sourceId: SRC_KEYED, kind: "stored_key" }]);
  });

  it("gives no funding for a task that actually ran through the endpoint", async () => {
    const f = fixture();
    const proof = TaskFundingProofSchema.parse({ version: 1, orgId: org, project: "web", sourcesRevision: 2, sources: [{ sourceId: SRC_KEYED, kind: "stored_key" }] });
    expect(await actualCompanyFunding(f.deps, proof, { sourceId: SRC_ENDPOINT, model: sonnet })).toBeUndefined();
  });
});
