// Company rules (G-04, switch `si`): the broker's wiring. Two things, kept in one module so the handler needs two lines:
//   - `installCompanyRules`: while the switch is on, the Cloud adapter of the `CompanyInstructionsSource` port (the company's newest approved version, read at every step) is installed as `companyInstructions`, unless the caller
//     gave its own. With the switch off nothing is installed: no company rules reach a step and no company rules row is read.
//   - `companyRulesRouteDependencies`: how the file sync reaches a repository: the company's own GitHub connection (`requireRepositoryConnected`, which also pins the repository's id) and the code host the repository's record names
//     (GitHub today; `hostOfRepository`). Nothing is added where the install has no repository gate (no GitHub connection to ask), and the routes then answer that connecting a repository is not set up.
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { cloudCompanyInstructionsSource } from "../../company-rules/source.js";
import { dynamoCompanyRulesStore } from "../../company-rules/store.js";
import { runSyncPass, type CompanyRulesRepositories } from "../../company-rules/sync.js";
import { standingInstructionsEnabled } from "../../instructions/switch.js";
import { requireRepositoryConnected } from "../../org/github-connection.js";
import type { DeveloperRouteDependencies } from "../developer-routes/types.js";
import { repositoryGateOf } from "./dependency-wiring.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";

export function installCompanyRules(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): void {
  if (!standingInstructionsEnabled(env) || dependencies.companyInstructions !== undefined) return;
  dependencies.companyInstructions = cloudCompanyInstructionsSource({ documentClient: dependencies.documentClient, tableName: dependencies.tableName });
}

export function companyRulesRouteDependencies(dependencies: AwsBrokerDependencies): Pick<DeveloperRouteDependencies, "companyRulesRepositories"> {
  if (dependencies.companyRulesRepositories !== undefined) return { companyRulesRepositories: dependencies.companyRulesRepositories };
  const gate = repositoryGateOf(dependencies);
  if (gate === undefined) return {};
  const repositories: CompanyRulesRepositories = {
    async connect(orgId, owner, name) {
      const pinned = await requireRepositoryConnected(gate, orgId, owner, name);
      return { repositoryId: pinned.githubRepositoryId, url: `https://github.com/${owner}/${name}.git` };
    },
    target(orgId, repository) {
      // A host this install has not registered is refused by the router with its fixed sentence; it is never answered with GitHub.
      if (!Number.isSafeInteger(repository.repositoryId) || repository.repositoryId < 1) throw agentXError("CONFIG_INVALID", "The connected repository is not valid.");
      return { name: repository.name, place: `github:repo/${String(repository.repositoryId)}`, repository: { url: repository.url }, scope: githubScope(dependencies, orgId), host: hostOfRepository(dependencies, { githubRepositoryId: repository.repositoryId }) };
    },
  };
  return { companyRulesRepositories: repositories };
}

/**
 * The file link's look (`runSyncPass`) rides the Team record's HOURLY job where the record has a job runner, only while the `si` switch is on: a company with no connected file costs one read. Where the record has no runner
 * (the record's own switch off, a partial harness) nothing is added, and the admin's "sync now" and every approval still run the pass. A failed company never stops the others (the job runner isolates a thrown error).
 */
export function installCompanyRulesJob(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): void {
  const jobs = (dependencies.teamRecord as { jobs?: { extend?: (job: "hourly", work: (orgId: OrgId, projects: string[], budgetMs: number) => Promise<Record<string, number>>) => unknown } } | undefined)?.jobs;
  if (!standingInstructionsEnabled(env) || jobs?.extend === undefined) return;
  const repos = companyRulesRouteDependencies(dependencies).companyRulesRepositories;
  if (repos === undefined) return;
  const store = dynamoCompanyRulesStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, audit: dependencies.audit });
  const refuse = (): Promise<void> => Promise.reject(agentXError("FORBIDDEN", "Not available to a scheduled pass."));
  jobs.extend("hourly", async (orgId) => {
    await runSyncPass({ store, repos, now: Date.now, requireAdmin: refuse, requireFreshSignIn: refuse, log: (event, fields) => console.log(JSON.stringify({ component: "company_rules", event, ...fields })) }, orgId);
    return { companyRulesSyncPasses: 1 };
  });
}
