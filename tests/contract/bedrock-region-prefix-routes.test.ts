// The model picker and the company model policy read a forbidden model through every Bedrock geography, and fail closed on a prefix nobody listed.
import { expect, it } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, developerOrgKey, orgMemberKey, orgMetaKey, type ModelIdentifier } from "@agentx/contracts";
import type { AwsBrokerInput } from "../../packages/broker/src/aws/broker.js";
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
