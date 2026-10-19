import { expect } from "vitest";

type Statement = { Action: unknown; Resource: unknown };
type Resource = {
  Type: string;
  Properties: { PolicyName?: string; Roles?: unknown[]; PolicyDocument?: { Statement: Statement[] }; Environment?: { Variables: Record<string, unknown> }; [key: string]: unknown };
};

/** Whether the template has the proxy, which a named control plane has and a legacy one does not. */
export const hasModelProxy = (template: unknown): boolean => Object.keys((template as { Resources?: object }).Resources ?? {}).some((id) => id.startsWith("ModelProxy"));

/**
 * The model proxy (Task 10) adds, to a named control plane: two parameters, one construct's resources
 * (ModelProxy*), two outputs, and it moves the provider-key reads from the Slack orchestrator and the
 * EC2 workers to its own task role (ruling R4). Each part is checked to be exactly this, then taken
 * out (the three reads put back on their old roles), so the rest of the template must still match the
 * recorded snapshot. model-proxy-infrastructure.test.ts checks the proxy itself.
 */
export function withoutModelProxy(template: unknown): unknown {
  const synthesized = template as { Parameters: Record<string, unknown>; Resources: Record<string, Resource>; Outputs: Record<string, unknown> };
  withoutModelAccess(synthesized);
  for (const name of ["VpcId", "Ec2WorkerSecurityGroupId"]) {
    expect(synthesized.Parameters[name]).toMatchObject({ Type: "String" });
    delete synthesized.Parameters[name];
  }
  for (const name of ["ModelProxyUrl", "ModelProxyMasterKeySecretArn"]) {
    expect(synthesized.Outputs[name]).toBeDefined();
    delete synthesized.Outputs[name];
  }
  const proxyIds = Object.keys(synthesized.Resources).filter((id) => id.startsWith("ModelProxy"));
  const taskRoleId = proxyIds.find((id) => id.startsWith("ModelProxyTaskRole") && synthesized.Resources[id]!.Type === "AWS::IAM::Role");
  expect(taskRoleId).toBeDefined();
  expect(proxyIds.filter((id) => synthesized.Resources[id]!.Type === "AWS::ECS::Service")).toHaveLength(1);
  for (const id of proxyIds) delete synthesized.Resources[id];
  const orchestratorRoleId = Object.keys(synthesized.Resources).find((id) => id.startsWith("SlackOrchestratorTaskRole") && synthesized.Resources[id]!.Type === "AWS::IAM::Role");
  expect(orchestratorRoleId).toBeDefined();
  const reads = Object.values(synthesized.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && /^(OpenRouter|Anthropic|OpenAI)SecretRead$/.test(resource.Properties.PolicyName ?? ""));
  expect(reads).toHaveLength(3);
  for (const read of reads) {
    expect(read.Properties.Roles).toStrictEqual([{ Ref: taskRoleId }]);
    read.Properties.Roles = [{ Ref: orchestratorRoleId }, { "Fn::Select": [3, { "Fn::Split": ["/", { Ref: "Ec2WorkerInstanceRoleArn" }] }] }];
  }
  return template;
}

/**
 * Ruling R28: the VPC-attached ModelAccessFunction (ModelAccess* resources) and what it adds to the broker, which
 * is the environment variable MODEL_ACCESS_FUNCTION_NAME and one lambda:InvokeFunction statement on that function.
 * model-access-infrastructure.test.ts checks them; here they are asserted present and taken out.
 */
function withoutModelAccess(synthesized: { Resources: Record<string, Resource> }): void {
  const resources = synthesized.Resources;
  const functionId = Object.keys(resources).find((id) => id.startsWith("ModelAccessFunction") && resources[id]!.Type === "AWS::Lambda::Function");
  expect(functionId).toBeDefined();
  const brokers = Object.entries(resources).filter(([id, resource]) => id.startsWith("Broker") && resource.Type === "AWS::Lambda::Function");
  expect(brokers).toHaveLength(1);
  const variables = brokers[0]![1].Properties.Environment!.Variables;
  expect(variables.MODEL_ACCESS_FUNCTION_NAME).toStrictEqual({ Ref: functionId });
  delete variables.MODEL_ACCESS_FUNCTION_NAME;
  const grants = Object.values(resources).flatMap((resource) => (resource.Type === "AWS::IAM::Policy" ? [resource.Properties.PolicyDocument!] : []))
    .filter((document) => document.Statement.some((statement) => JSON.stringify(statement.Resource).includes(`"${functionId!}"`)
      && JSON.stringify(statement.Action).includes("lambda:InvokeFunction")));
  expect(grants).toHaveLength(1);
  grants[0]!.Statement = grants[0]!.Statement.filter((statement) => !JSON.stringify(statement.Resource).includes(`"${functionId!}"`));
  for (const id of Object.keys(resources).filter((name) => name.startsWith("ModelAccess"))) delete resources[id];
}
