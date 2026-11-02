// The model picker and the company model policy read a forbidden model through every Bedrock geography, and fail closed on a prefix nobody listed.
import { describe, expect, it } from "vitest";
import { AgentGuardrailsSchema, AgentGuardrailsWriteSchema, DEFAULT_AGENT_GUARDRAILS, forbiddenModelMatcher, agentGuardrailsKey, developerOrgKey, orgMemberKey, orgMetaKey, type ModelIdentifier } from "@agentx/contracts";
import type { AwsBrokerInput } from "../../packages/broker/src/aws/broker.js";
import { readGuardrails } from "../../packages/broker/src/agents/guardrails.js";
import { getModels } from "../../packages/broker/src/agents/models-route.js";
import { getCompanyModelSelectionPolicy } from "../../packages/broker/src/model-selection/company-read.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";

const bedrock = (modelId: string): ModelIdentifier => ({ provider: "amazon-bedrock", modelId });
const OPUS_5: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-5" };
const JP_OPUS = bedrock("jp.anthropic.claude-opus-5");
const US_GOV_OPUS = bedrock("us-gov.anthropic.claude-opus-5");
const UPPER_OPUS = bedrock("US.anthropic.claude-opus-5");
const JP_SONNET = bedrock("jp.anthropic.claude-sonnet-5");
const UNKNOWN = bedrock("zz.anthropic.claude-sonnet-5");

it("leaves a forbidden model out of the picker through every geography, and an unknown-prefix id whenever anything is forbidden", async () => {
  const h = await createDeveloperTaskBroker({ register: false, brokerExtra: { agents: { projectMembers: new FakeProjectMembers() } } });
  await h.dev(MAYA, "GET", "/v1/app/models");
  const { orgId } = await h.orgOf(MAYA);
  const { createAgentRouteDependencies } = await import("../../packages/broker/src/aws/broker.js");
  const deps = createAgentRouteDependencies(h.brokerInput as unknown as AwsBrokerInput)!;
  deps.servableModels = async () => [JP_OPUS, US_GOV_OPUS, UPPER_OPUS, JP_SONNET, UNKNOWN];
  const caller = { orgId, developerId: MAYA.developerId, orgRole: "member" as const };
  const url = new URL("https://cell.example/v1/app/models");
  const ids = async () => (await getModels(deps, caller, url)).models.map((entry) => entry.modelId);

  expect(await ids()).toEqual([JP_OPUS, US_GOV_OPUS, UPPER_OPUS, JP_SONNET, UNKNOWN].map((model) => model.modelId));
  h.db.set({ ...agentGuardrailsKey(orgId), revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: [OPUS_5] } });
  expect(await ids()).toEqual([JP_SONNET.modelId]);
});

it("shows a forbidden model as denied in the company policy through a jp geography, and an unknown-prefix id too", async () => {
  const org = "org_aaaaaaaaaaaaaaaaaaaa", person = "a".repeat(64);
  const db = new FakeDynamoDb();
  db.set({ ...orgMemberKey(org, person), orgId: org, developerId: person, role: "owner" });
  db.set({ ...developerOrgKey(person), orgId: org, role: "owner" });
  db.set({ ...orgMetaKey(org), orgId: org });
  db.set({ ...agentGuardrailsKey(org), revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: [OPUS_5] } });
  const deps = { documentClient: db, tableName: "state", now: () => 0, routing: { rovaraGeography: "jp" } } as unknown as Parameters<typeof getCompanyModelSelectionPolicy>[0];
  const caller = { orgId: org, developerId: person, orgRole: "owner" as const, name: "A", amr: "cloud" as const, sessionId: "fixture" };
  const policy = await getCompanyModelSelectionPolicy(deps, caller);
  const rows = policy.candidates!.build!;
  const status = (modelId: string) => rows.find((row) => row.model.modelId === modelId)?.status;
  expect(status("jp.anthropic.claude-opus-5")).toBe("denied");
  expect(rows.filter((row) => row.status === "denied").map((row) => row.model.modelId)).toContain("jp.anthropic.claude-opus-5");
  expect(rows.some((row) => row.model.modelId === "jp.anthropic.claude-sonnet-5" && row.status !== "denied")).toBe(true);
});

describe("a forbidden-model list holding one model twice", () => {
  const PAIR = [OPUS_5, JP_OPUS];

  it("still reads from storage and from a pending approval's schema, and a new save of it is refused", async () => {
    const org = "org_aaaaaaaaaaaaaaaaaaaa";
    const db = new FakeDynamoDb();
    db.set({ ...agentGuardrailsKey(org), revision: 3, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: PAIR } });
    const read = await readGuardrails({ documentClient: db, tableName: "state" }, org);
    expect(read.forbiddenModels).toEqual(PAIR);
    // The approval record parses `next` with the reader's schema.
    expect(AgentGuardrailsSchema.safeParse({ ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: PAIR }).success).toBe(true);
    // A new save is refused, in the same words as for any duplicate.
    const refused = AgentGuardrailsWriteSchema.safeParse({ ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: PAIR });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]).toMatchObject({ path: ["forbiddenModels", 1], message: "claude-opus-5 is listed twice" });
    expect(AgentGuardrailsWriteSchema.safeParse({ ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: [OPUS_5, JP_SONNET] }).success).toBe(true);
    // Both entries forbid, so a duplicate is harmless for enforcement.
    const forbidden = forbiddenModelMatcher(read.forbiddenModels);
    expect([OPUS_5, JP_OPUS, US_GOV_OPUS, UPPER_OPUS, JP_SONNET].map(forbidden)).toEqual([true, true, true, true, false]);
  });
});
