import { describe, expect, it } from "vitest";
import { issueCapability } from "../../../packages/broker/src/aws/cancellation.js";
import { stageHasContextSources } from "../../../packages/broker/src/context-sources/enabled.js";
import { dynamoContextSourceStore } from "../../../packages/broker/src/context-sources/store.js";
import { confirmSourceChange, proposeSourceChange } from "../../../packages/broker/src/context-sources/settings.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { NOW, ORG, environment, source } from "./fixtures.js";

const actionsOf = (token: string): string[] => (JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] }).actions;

describe("the context-tools capability", () => {
  it("is in the token only when asked for", () => {
    expect(actionsOf(issueCapability({ callbackSigningKey: "k" }, "ws", "op", 1, { contextTools: true }))).toContain("context-tools");
    expect(actionsOf(issueCapability({ callbackSigningKey: "k" }, "ws", "op", 1, {}))).not.toContain("context-tools");
    expect(actionsOf(issueCapability({ callbackSigningKey: "k" }, "ws", "op", 1, { agentTools: true }))).not.toContain("context-tools");
  });
});

describe("which operations are given it", () => {
  async function projectWithSource(stages: Array<"UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "REVIEW">) {
    const table = new FakeDynamoDb();
    const store = dynamoContextSourceStore({ documentClient: table, tableName: "state", now: () => NOW });
    const deps = { store, env: environment(), now: () => NOW };
    const actor = { orgId: ORG, developerId: "dev1", orgRole: "admin" };
    const change = await proposeSourceChange(deps, actor, "proj", { kind: "set", source: source({ stages }) });
    await confirmSourceChange(deps, actor, "proj", change.changeId);
    return { documentClient: table, tableName: "state", now: () => NOW, contextSourcesConfigured: true };
  }
  it.each(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"] as const)("%s: given when the project has a source for it", async (mode) => {
    expect(await stageHasContextSources(await projectWithSource([mode]), ORG, "proj", mode)).toBe(true);
  });
  it.each(["IMPLEMENT", "CHECKS", "FEEDBACK_REVIEW", "SETUP_DRAFT", undefined])("%s: never given, even in a project with sources", async (mode) => {
    expect(await stageHasContextSources(await projectWithSource(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"]), ORG, "proj", mode)).toBe(false);
  });
  it("is not given for a stage the source is not ticked for, or for another project, or when the install has no sources set up", async () => {
    const deps = await projectWithSource(["PLAN"]);
    expect(await stageHasContextSources(deps, ORG, "proj", "REVIEW")).toBe(false);
    expect(await stageHasContextSources(deps, ORG, "other", "PLAN")).toBe(false);
    expect(await stageHasContextSources({ ...deps, contextSourcesConfigured: false }, ORG, "proj", "PLAN")).toBe(false);
  });
});
