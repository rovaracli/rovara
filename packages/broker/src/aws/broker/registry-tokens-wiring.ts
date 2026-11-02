// N9 (INTG2): the broker's own AWS identity as a CodeArtifact token source. Built only where the install switch is on (the install was synthesised with `rovaraCodeArtifactDomains`,
// which also grants this role GetAuthorizationToken on the named domain and nothing wider: infra/lib/registry-access.ts). A generic registry's stored credential is not wired here yet.
import { STSClient } from "@aws-sdk/client-sts";
import { createCodeArtifactTokenClient } from "../../project-registries/codeartifact-client.js";
import type { RegistryTokenSource } from "../../project-registries/mint.js";
import { projectRegistriesEnabled } from "../../project-registries/switch.js";

export function registryTokenSource(awsClientConfiguration: NonNullable<ConstructorParameters<typeof STSClient>[0]>): RegistryTokenSource | undefined {
  if (!projectRegistriesEnabled()) return undefined;
  // The STS client's own credential provider is the Lambda role's: the same identity every other call of the broker is signed with.
  return { codeArtifact: createCodeArtifactTokenClient({ credentials: new STSClient(awsClientConfiguration).config.credentials }) };
}
