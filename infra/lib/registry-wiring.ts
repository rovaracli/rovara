// N9 (INTG2): attaches the registry access to the broker and turns its switch on. Called only when the install names a CodeArtifact domain (registry-access.ts).
import { aws_iam as iam, type Stack, type aws_lambda as lambda } from "aws-cdk-lib";
import { BrokerSettings } from "./broker-names.js";
import { registryTokenStatements, type RegistryDomain } from "./registry-access.js";

export function attachProjectRegistries(stack: Stack, props: { broker: lambda.Function; domains: readonly RegistryDomain[] }): void {
  for (const statement of registryTokenStatements(props.domains, stack.partition)) props.broker.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
  BrokerSettings.of(props.broker).add("projectRegistries", "1");
}
