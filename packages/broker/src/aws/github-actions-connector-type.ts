// Plan 4 Task 17: the GitHub Actions connector type. It is not a `nativeConnectorType`: there is no org connection and no registry credential to pin to a host.
// The credential is the project's GitHub App, which mints Plan 3's agent installation token for each call (`mintActionsToken`, through `credentialFor` in the
// native runtime) with exactly the permissions of the tool, for one repository, after the org's installation binding is checked. The engine's own credential
// step only checks the connector can be served and gives the connection a placeholder it never sends anywhere; the tools never see it.
import { randomUUID } from "node:crypto";
import { GitHubActionsConnectorSchema } from "@rovara-code/contracts";
import { CredentialUnavailable, type Binder, type ConnectorDefinition, type CredentialProvider, type connectMcp } from "@agentx/gateway";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorType } from "./connector-types.js";
import {
  GITHUB_ACTIONS_ROUTING_PROPERTIES,
  GITHUB_ACTIONS_TOOLS,
  GITHUB_API_ORIGIN,
  actionsRepositoryOf,
  githubActionsRoutingValues,
  logDownloader,
  mintActionsToken,
  type GitHubActionsEngineScope,
  type GitHubActionsRunScope,
} from "../connectors/native/github-actions.js";
import { nativeConnection } from "../connectors/native/runtime.js";
import { safeVendorFetch, vendorFetcher } from "../connectors/native/vendor-fetch.js";

const NOT_CONFIGURED = "GitHub is not configured in this deployment";
const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ component: "broker", ...entry }));
const NO_ORG = "GitHub Actions connectors need an organization";

/** Plan 4 Task 17: GitHub Actions workflow runs, job logs and deployments, read natively in the broker with the project's GitHub App; one scope per repository. */
export const githubActionsConnectorType: ConnectorType = {
  type: "github-actions",
  resolve(config, project, context) {
    const parsed = GitHubActionsConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      const rules = parsed.error.issues.filter((issue) => issue.code === "custom" && issue.path.length === 0).map((issue) => issue.message);
      return { unusable: [`invalid github-actions connector configuration: ${fields.join(", ")}`, ...rules].join("; ").slice(0, 300) };
    }
    const stored = parsed.data;
    const routingNames = Object.keys(GITHUB_ACTIONS_ROUTING_PROPERTIES);
    // The repositories the connector reaches: all the project's, or the ones it names. A repository with no pinned GitHub id (or no GitHub address) is not offered.
    const repositories = stored.scopes === "all-repositories" ? project.repositories : project.repositories.filter((repository) => (stored.scopes as readonly string[]).includes(repository.name));
    const load = (): { problem: string } | { tokens: NonNullable<typeof context.githubAgentTokens>; orgId: NonNullable<typeof context.orgId> } => {
      if (context.githubAgentTokens === undefined) return { problem: NOT_CONFIGURED };
      if (context.orgId === undefined) return { problem: NO_ORG };
      return { tokens: context.githubAgentTokens, orgId: context.orgId };
    };
    const connect: typeof connectMcp = async (target) => {
      const loaded = load();
      if ("problem" in loaded) throw new CredentialUnavailable(loaded.problem);
      if (target.endpoint.protocol !== "https:" || target.endpoint.hostname !== new URL(GITHUB_API_ORIGIN).hostname) throw new Error("a GitHub Actions connector reaches api.github.com only");
      // A redirect is handed back (never followed) so `get_job_log` can read where GitHub sends the log; every other request that is redirected is refused by `vendorFetch`.
      const base = context.nativeFetch ?? safeVendorFetch({ returnRedirects: true });
      const download = logDownloader(base);
      return nativeConnection<GitHubActionsRunScope>(GITHUB_ACTIONS_TOOLS, target.tools, {
        credential: { token: target.token, bindings: {} },
        fetch: vendorFetcher({ base: new URL(GITHUB_API_ORIGIN), fetch: base }),
        routing: {
          properties: GITHUB_ACTIONS_ROUTING_PROPERTIES,
          scopeOf: (values) => ({
            alias: values["scopeAlias"]!, owner: values["owner"]!, repo: values["repo"]!, repositoryId: Number(values["repositoryId"]),
            installationId: values["installationId"] === "" ? undefined : Number(values["installationId"]), download, log,
          }),
        },
        credentialFor: async (tool, scope) => ({ token: await mintActionsToken({ tokens: loaded.tokens, orgId: loaded.orgId, tool, scope }), bindings: {} }),
      });
    };
    return {
      name: stored.name,
      type: "github-actions",
      label: "GitHub Actions",
      vendor: "GitHub",
      scopeNoun: "repository",
      scopes: repositories.filter((repository) => actionsRepositoryOf(repository) !== undefined).map((repository) => ({ alias: repository.name, scope: { alias: repository.name, repository } satisfies GitHubActionsEngineScope })),
      policy: { tools: stored.tools },
      approvals: stored.tools,
      // Nothing is written, so there is no requester footer to sign.
      attribution: false,
      ledger: connectorLedgerKeys(stored.name),
      // No `credential`: there is no registry token to check or pin; the App's token is minted for each call.
      configured: async () => !("problem" in load()),
      async definition() {
        const loaded = load();
        if ("problem" in loaded) return { notConnected: loaded.problem };
        const credentials: CredentialProvider<GitHubActionsEngineScope> = {
          issue: async (scope, access) => {
            if (access !== "read") throw new CredentialUnavailable("GitHub Actions connections are read-only");
            if (actionsRepositoryOf(scope.repository) === undefined) throw new CredentialUnavailable(`${scope.alias} has no pinned GitHub repository id; register the project again`);
            // The real token is minted per call, for the tool being run. This only stands in for it as the connection's credential, and is never sent.
            return { token: `rovara-github-actions-${randomUUID()}`, bindings: {} };
          },
        };
        const binder: Binder<GitHubActionsEngineScope> = { properties: routingNames, bind: (scope) => githubActionsRoutingValues(scope) };
        const definition: ConnectorDefinition<GitHubActionsEngineScope> = {
          label: "GitHub",
          endpoint: new URL(GITHUB_API_ORIGIN),
          permissionsHint: "the GitHub App's Actions and Deployments read permissions on this repository",
          credentials,
          binder,
          guards: [],
          itemArguments: [],
        };
        return definition;
      },
      connect,
    };
  },
};
