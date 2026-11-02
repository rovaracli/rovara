// N9 (INTG2): the registries a prepare invocation carries. Built where the invocation is built, so an install that cannot serve them refuses the START with a fixed sentence rather than
// letting setup run without the registry and fail on a 401 (and never falling back to a public mirror). A run that only reads (`readOnly`) runs none of the project's code, so it carries none.
import { REGISTRY_PROBLEM_MESSAGES, agentXError, prepareRegistriesOf, registryProblems, type BoundRegistryDomain, type Edition, type PrepareRegistries, type ProjectRegistry } from "@agentx/contracts";
import { REGISTRIES_OFF_MESSAGE } from "./exchange.js";

/** The feature message: a worker that does not list `prepare.registries.v1` is refused at delivery with this, the same sentence as an old worker meeting any new field. */
export const REGISTRY_FEATURE_MISSING = "This project's package registries need a newer worker. Ask an admin to upgrade Rovara.";

export function registriesPrepareFor(input: {
  project: { registries?: readonly ProjectRegistry[] | undefined; network?: { allowedDomains: readonly string[] } | undefined };
  edition: Edition | undefined;
  enabled: boolean;
  readOnly?: boolean | undefined;
  /** The org the preparation is for, and the domains the install bound to orgs: a registry naming another org's CodeArtifact domain refuses the start. */
  orgId: string | undefined;
  boundDomains: readonly BoundRegistryDomain[];
}): { registries?: PrepareRegistries } {
  const registries = input.project.registries ?? [];
  if (registries.length === 0 || input.readOnly === true) return {};
  if (!input.enabled) throw agentXError("RUNTIME_UNAVAILABLE", REGISTRIES_OFF_MESSAGE);
  const problem = registryProblems({ edition: input.edition, registries, allowedDomains: input.project.network?.allowedDomains ?? [], orgId: input.orgId, boundDomains: input.boundDomains })[0];
  if (problem !== undefined) throw agentXError("RUNTIME_UNAVAILABLE", `${REGISTRY_PROBLEM_MESSAGES[problem.code]} (registry: ${problem.registry})`);
  return { registries: prepareRegistriesOf(registries) };
}
