import { describe, expect, it } from "vitest";
import { planDocumentInstructions } from "../../packages/broker/src/aws/broker-shared.js";
import { createDeveloperApiConfiguration, workflowDependenciesConfigurationFromEnvironment } from "../../packages/broker/src/aws/workflow-dependencies-configuration.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { TEST_ORG } from "../support/orgs.js";

describe("workflow dependency runtime configuration", () => {
  it("is disabled unless the exact runtime value is true", () => {
    for (const value of [undefined, "", "false", "FALSE", "1"]) {
      expect(workflowDependenciesConfigurationFromEnvironment({ AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: value }))
        .toEqual({ workflowDependenciesEnabled: false });
    }
    expect(workflowDependenciesConfigurationFromEnvironment({ AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" }))
      .toEqual({ workflowDependenciesEnabled: true });
  });

  it("composes the real developer route feature settings without changing People or invitations", () => {
    const build = (flag: string | undefined) => createDeveloperApiConfiguration({
      DEVELOPER_TOKEN_ISSUER: "https://issuer.example/v1/auth",
      DEVELOPER_IDENTITY_FUNCTION_NAME: "developer-identity",
      DEVELOPER_SIGNIN_TABLE_NAME: "sign-ins",
      AGENTX_ENV: "agentxlivetest123",
      DEVELOPER_SIGNIN_SLACK: "enabled",
      AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: flag,
      AGENTX_TASK_PEOPLE_CHANGES_ENABLED: "true",
      AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED: "false",
      AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED: "false",
    }, () => ({
      channelMembers: async () => ({ ok: true as const, memberOf: [] as string[] }),
      verifyAccessToken: async () => ({}),
    }));
    const routesFor = (developer: NonNullable<ReturnType<typeof build>>) => developerTaskRouteDependencies({
      documentClient: { send: async () => ({}) }, tableName: "state", developer, now: Date.now,
    }, { orgId: TEST_ORG, orgRole: "member" as const, developerId: "dev", sessionId: "session", amr: "slack", name: "Dev" });

    const enabled = build("true");
    expect(enabled).toBeDefined();
    const enabledRoutes = routesFor(enabled!);
    expect(enabledRoutes.workflowDependenciesEnabled).toBe(true);
    expect(enabledRoutes.taskPeopleConfiguration).toEqual({ peopleChangesEnabled: true });
    expect(typeof enabledRoutes.inviteTaskPerson).toBe("undefined");

    const disabled = build("false");
    expect(disabled).toBeDefined();
    const disabledRoutes = routesFor(disabled!);
    expect(disabledRoutes.workflowDependenciesEnabled).toBe(false);
    expect(disabledRoutes.taskPeopleConfiguration).toEqual({ peopleChangesEnabled: true });
    expect(typeof disabledRoutes.inviteTaskPerson).toBe("undefined");
  });

  it("reaches the sign-in function by name (an ARN still works), and refuses to start without one", () => {
    const base = { DEVELOPER_TOKEN_ISSUER: "https://issuer.example/v1/auth", DEVELOPER_SIGNIN_TABLE_NAME: "sign-ins", AGENTX_ENV: "staging" };
    const seen: string[] = [];
    const integrations = (_issuer: string, identityFunctionName: string) => {
      seen.push(identityFunctionName);
      return { channelMembers: async () => ({ ok: true as const, memberOf: [] as string[] }), verifyAccessToken: async () => ({}) };
    };
    createDeveloperApiConfiguration({ ...base, DEVELOPER_IDENTITY_FUNCTION_NAME: "agentx-staging-control-plane-DeveloperSignInFunction10B62B05-1A2B3C4D5E6F7" }, integrations);
    createDeveloperApiConfiguration({ ...base, DEVELOPER_IDENTITY_FUNCTION_ARN: "arn:aws:lambda:us-west-2:123456789012:function:identity" }, integrations);
    expect(seen).toEqual(["agentx-staging-control-plane-DeveloperSignInFunction10B62B05-1A2B3C4D5E6F7", "arn:aws:lambda:us-west-2:123456789012:function:identity"]);
    expect(() => createDeveloperApiConfiguration(base, integrations)).toThrow("DEVELOPER_IDENTITY_FUNCTION_NAME is required");
  });

  it("adds canonical work-breakdown guidance only when the pinned task context is supplied", () => {
    const ordinary = planDocumentInstructions({ kind: "plan", path: "QUICK" });
    const eligible = planDocumentInstructions({ kind: "plan", path: "QUICK", workBreakdownContext: {
      taskId: "61dcaa71-b1d4-4b22-8174-817a62636e52",
      repositoryId: "payments-service",
    } });

    expect(ordinary).not.toContain("workBreakdown");
    for (const required of [
      "workBreakdown",
      '"schemaVersion":1',
      '"taskId":"61dcaa71-b1d4-4b22-8174-817a62636e52"',
      '"repository":"payments-service"',
      "8 items",
      "12 dependency edges",
      "16,384 canonical bytes",
      "one final pull request",
      "deterministic serial dependency order",
      "approves the whole graph",
      "Do not claim checks or review as executor self-attestation",
    ]) expect(eligible).toContain(required);
  });

  it("does not add work-breakdown guidance to requirements or design documents", () => {
    for (const kind of ["requirements", "design"] as const) {
      expect(planDocumentInstructions({ kind, path: "FULL", workBreakdownContext: {
        taskId: "61dcaa71-b1d4-4b22-8174-817a62636e52",
        repositoryId: "payments-service",
      } })).not.toContain("workBreakdown");
    }
  });
});
