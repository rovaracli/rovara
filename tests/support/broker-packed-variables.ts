// The variables the control plane really gives the broker Lambda (the synthesized function's environment), for tests that load the broker the way the Lambda does.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { lambdaEnvironments, DEPLOY_PARAMETER_VALUES, type Template as ResolvableTemplate } from "./lambda-environment-size.js";

export function brokerVariables(): Record<string, string> {
  const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!;
  const found = lambdaEnvironments(Template.fromStack(stack).toJSON() as ResolvableTemplate, { env: "staging", stackName: stack.stackName, parameterValues: DEPLOY_PARAMETER_VALUES })
    .find((entry) => /^Broker[0-9A-F]{8}$/.test(entry.logicalId));
  return found!.variables;
}
