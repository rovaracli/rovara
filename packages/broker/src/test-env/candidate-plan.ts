// Test services, slice 1 (Prove): the dependencies a proposal's CANDIDATE check starts, pinned by digest from the signed catalog, for the preparation's payload (`testServices`). A leaf module, so the setup check's route
// (aws/developer-routes/project-archive-setup.ts) and the candidate state can share it. Undefined for a proposal without dependencies (the preparation then goes out exactly as it always did, with no extra read).
// A dependency that cannot be pinned, `tx` off, or a project with a dev container REFUSES the check, in fixed words: a check that ran without the dependencies would prove nothing.
import { EDITION_ENV_VAR, type CompanyImageMirrorJob, type TaskDependencyPlan } from "@agentx/cloud-contracts";
import { agentXError, type OrgId, type TestEnvironmentBody } from "@rovara-code/contracts";
import { DEPENDENCY_PLAN_REFUSAL_WORDS, taskDependencyPlansOf, type SeedFileHashes, type ServiceCatalogSource } from "./dependency-plan.js";
import { refuseDependenciesWithDevcontainer } from "./devcontainer-check.js";
import { projectImagesEnabled, testServicesEnabled } from "./test-services-switch.js";
import { readCompanyImagePlanInputs } from "../org/company-test-image-store.js";
import { approvedFixturesOf, recordsOf, type FixtureStoreFactory } from "./fixture-lookup.js";

export async function candidateDependencyPlan(
  deps: { serviceCatalog?: ServiceCatalogSource | undefined; fixtureStore?: FixtureStoreFactory | undefined; companyImageMirrorStart?: ((job: CompanyImageMirrorJob) => Promise<void>) | undefined; documentClient: { send(command: unknown): Promise<unknown> }; tableName: string },
  proposal: Pick<TestEnvironmentBody, "dependencies" | "prodDeny">,
  scope: { orgId: OrgId; project: string },
  env: NodeJS.ProcessEnv = process.env,
  /** Review I3: the environment is an APPROVED one (the project's own check), so its file seeds carry the content the approval bound. */
  approvedSeedFiles?: SeedFileHashes,
): Promise<TaskDependencyPlan[] | undefined> {
  if ((proposal.dependencies?.length ?? 0) === 0) return undefined;
  if (!testServicesEnabled(env)) throw agentXError("CONFIG_INVALID", DEPENDENCY_PLAN_REFUSAL_WORDS.not_available_yet);
  await refuseDependenciesWithDevcontainer(deps, scope.orgId, scope.project, proposal);
  const catalog = await Promise.resolve(deps.serviceCatalog?.()).catch(() => undefined);
  const fixtures = await approvedFixturesOf(recordsOf(deps.fixtureStore), scope.orgId, scope.project, proposal);
  // Switch `pj`: the company's approved extra images, read only for a proposal that names one.
  const company = projectImagesEnabled(env) && (proposal.dependencies ?? []).some((dependency) => dependency.backing.kind === "project_image") ? await readCompanyImagePlanInputs(deps, scope.orgId, { env, ...(deps.companyImageMirrorStart === undefined ? {} : { start: deps.companyImageMirrorStart }) }) : undefined;
  const planned = taskDependencyPlansOf({ body: proposal as TestEnvironmentBody, catalog, edition: env[EDITION_ENV_VAR] === "enterprise" ? "enterprise" : "public", projectId: scope.project, fixtures, ...(company === undefined ? {} : company), ...(approvedSeedFiles === undefined ? {} : { approvedSeedFiles }) });
  if (!planned.ok) throw agentXError("CONFIG_INVALID", DEPENDENCY_PLAN_REFUSAL_WORDS[planned.reason]);
  return planned.dependencies;
}
