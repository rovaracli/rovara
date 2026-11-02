// N9 (INTG2): the broker's wiring of a project's registry credentials: the route's handler, and the registries a prepare invocation carries. The rules are in
// ../../project-registries/ (exchange.ts, prepare.ts); this file only reads the stored records they ask for.
import { agentXError, type PrepareRegistries } from "@agentx/contracts";
import { requireOperation } from "../cancellation.js";
import { requireWorkspace } from "./records.js";
import { exchangeRegistryCredentialCore } from "../../project-registries/exchange.js";
import { registriesPrepareFor } from "../../project-registries/prepare.js";
import { projectRegistriesEnabled } from "../../project-registries/switch.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { object, parseBody } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies, RegisteredProjectRecord } from "./definitions.js";
import type { AdaptedHttpRequest } from "../lambda.js";

/** `{ registries }` for a prepare payload, or nothing: see registriesPrepareFor. `readOnly` runs run none of the project's code. */
export function registriesPrepareOf(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, options: { readOnly?: boolean } = {}): { registries?: PrepareRegistries } {
  return registriesPrepareFor({
    project: project.definition,
    edition: dependencies.editionPolicy?.edition,
    enabled: projectRegistriesEnabled(),
    readOnly: options.readOnly,
  });
}

export async function exchangeRegistryCredential(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, workspaceId: string, operationId: string) {
  const registryTokens = dependencies.registryTokens;
  return exchangeRegistryCredentialCore({
    enabled: projectRegistriesEnabled() && registryTokens !== undefined,
    edition: dependencies.editionPolicy?.edition,
    source: registryTokens ?? {},
    inspectGrant: (grant) => dependencies.repositoryGrants.inspect(grant),
    readOperation: async (workspace, operation) => {
      const record = await requireOperation(dependencies, workspace, operation);
      const instance = await requireWorkspace(dependencies, workspace);
      return { kind: record.kind, status: record.status, workspace: { status: instance.status, activeOperationId: instance.activeOperationId } };
    },
    readProject: async (workspace) => {
      const instance = await requireWorkspace(dependencies, workspace);
      const stored = await requireRecordProject(dependencies, instance, instance.projectName, instance.projectRevision);
      const definition = stored.definition;
      return { registries: definition.registries ?? [], allowedDomains: definition.network?.allowedDomains ?? [] };
    },
  }, { grant: request.headers["x-agentx-repository-grant"], workspaceId, operationId, body: parseBodyObject(request.body) });
}

function parseBodyObject(body: string | undefined): unknown {
  const parsed = parseBody(body);
  if (parsed === undefined || parsed === null) throw agentXError("CONFIG_INVALID", "registry credential request is invalid");
  return object(parsed, "registry credential request");
}
