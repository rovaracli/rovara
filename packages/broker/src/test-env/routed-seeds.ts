// TS-UX-1: which seed commands the test environment's draft of a setup draft task actually gave to a database dependency. The draft is read exactly as the wizard reads it (the same sanitizer, the same signed catalog),
// so what the setup proposal leaves out is what the proposed environment holds as the dependency's seed, never more. Empty when test services are off, the draft is gone, or no database could be proposed.
import { EDITION_ENV_VAR } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { readTestEnvDraft } from "./draft.js";
import type { ServiceCatalogSource } from "./dependency-plan.js";
import type { RoutedSeed } from "./seed-routing.js";
import { testEnvironmentEnabled } from "./switch.js";
import { testServicesEnabled } from "./test-services-switch.js";

type Send = { send(command: unknown): Promise<unknown> };

export async function routedSeedsOf(
  deps: { documentClient: Send; tableName: string; now: () => number; serviceCatalog?: ServiceCatalogSource | undefined; env?: NodeJS.ProcessEnv | undefined },
  orgId: OrgId, project: string, taskId: string,
): Promise<RoutedSeed[]> {
  if (!testEnvironmentEnabled(deps.env) || !testServicesEnabled(deps.env)) return [];
  const catalog = await Promise.resolve(deps.serviceCatalog?.()).catch(() => undefined);
  const stored = await readTestEnvDraft(deps.documentClient, deps.tableName, orgId, project, taskId, deps.now(), { propose: { catalog, edition: process.env[EDITION_ENV_VAR] === "enterprise" ? "enterprise" : "public", projectId: project } });
  return stored?.routedSeeds ?? [];
}
