// Setup wizard (E4): the test-environment routes of a project. Readers project the existing routes; the broker owns who may do what (a maintainer proposes, edits, proves, applies and approves; a less-safe change
// needs a fresh sign-in and a second person), and this client only asks. The gateway puts its own `requestId` in every answer and the contracts are strict, so it is set aside and the rest is read exactly.
import { useMemo } from "react";
import {
  ProjectOverviewProjectSchema, TestEnvApplyAnswerSchema, TestEnvApplyBodySchema, TestEnvApproveAnswerSchema, TestEnvApproveBodySchema, TestEnvCheckBodySchema, TestEnvEditBodySchema, TestEnvProveBodySchema, TestEnvSeedBodySchema,
  TestEnvRequestApprovalAnswerSchema, TestEnvRequestApprovalBodySchema, TestEnvironmentStateSchema,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

function exactAnswer<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
  return { parse(value: unknown): T { if (typeof value !== "object" || value === null || Array.isArray(value)) return schema.parse(value); const own = { ...value } as Record<string, unknown>; delete own["requestId"]; return schema.parse(own); } };
}

export function createTestEnvironmentApi(host: AppHost) {
  const api = createApiClient(host);
  const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/test-environment";
  const state = exactAnswer(TestEnvironmentStateSchema);
  return {
    read: (name: string) => api.get(base(name), state),
    propose: (name: string) => api.sendAnswer("POST", base(name) + "/propose", {}, state),
    edit: (name: string, environment: unknown) => api.sendAnswer("POST", base(name) + "/edit", TestEnvEditBodySchema.parse({ environment }), state),
    /** The command that fills one dependency with test data (an empty line clears it). The server reads the line; the answer is the new state. */
    setSeed: (name: string, digest: string, dependencyId: string, command: string) => api.sendAnswer("POST", base(name) + "/seed", TestEnvSeedBodySchema.parse({ digest, dependencyId, command }), state),
    prove: (name: string, digest: string) => api.sendAnswer("POST", base(name) + "/prove", TestEnvProveBodySchema.parse({ digest }), state),
    startCheck: (name: string, digest: string, requestId: string) => api.sendAnswer("POST", base(name) + "/check", TestEnvCheckBodySchema.parse({ digest, requestId }), state),
    applyCommands: (name: string, body: ReturnType<typeof TestEnvApplyBodySchema.parse>) => api.sendAnswer("POST", base(name) + "/apply-commands", TestEnvApplyBodySchema.parse(body), exactAnswer(TestEnvApplyAnswerSchema)),
    requestApproval: (name: string, digest: string, expectedRevision: number) => api.sendAnswer("POST", base(name) + "/request-approval", TestEnvRequestApprovalBodySchema.parse({ digest, expectedRevision }), exactAnswer(TestEnvRequestApprovalAnswerSchema)),
    approve: (name: string, digest: string, expectedRevision: number, requestId: string) => api.sendAnswer("POST", base(name) + "/approve", TestEnvApproveBodySchema.parse({ digest, expectedRevision, requestId }), exactAnswer(TestEnvApproveAnswerSchema)),
  };
}

export function useTestEnvironmentApi() {
  const host = useAppHost();
  return useMemo(() => createTestEnvironmentApi(host), [host]);
}
