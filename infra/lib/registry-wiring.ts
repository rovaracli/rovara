// N9 (INTG2): attaches the registry access to the broker and turns its switch on. Called only when the install names a CodeArtifact domain (registry-access.ts).
import { aws_iam as iam, type Stack, type aws_lambda as lambda } from "aws-cdk-lib";
import { BrokerSettings } from "./broker-names.js";
import { BOUND_REGISTRY_DOMAINS_VARIABLE, formatBoundRegistryDomains } from "@rovara-code/contracts";
import { registryTokenStatements, type RegistryDomain } from "./registry-access.js";

export function attachProjectRegistries(stack: Stack, props: { broker: lambda.Function; domains: readonly RegistryDomain[] }): void {
  for (const statement of registryTokenStatements(props.domains, stack.partition)) props.broker.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
  BrokerSettings.of(props.broker).add("projectRegistries", "1");
  // Which org may use which domain and repositories: the exchange and the start check it, so one org cannot name another's.
  props.broker.addEnvironment(BOUND_REGISTRY_DOMAINS_VARIABLE, formatBoundRegistryDomains(props.domains));
}
