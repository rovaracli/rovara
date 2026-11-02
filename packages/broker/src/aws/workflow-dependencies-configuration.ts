import type { DeveloperApiConfiguration } from "./developer-routes.js";
import { developerSinceFromEnvironment } from "./developer-routes.js";
import { webOriginFromEnvironment } from "../org/invite-url.js";

export function workflowDependenciesConfigurationFromEnvironment(environment: Record<string, string | undefined>): {
  workflowDependenciesEnabled: boolean;
} {
  return { workflowDependenciesEnabled: environment.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED === "true" };
}

type DeveloperApiIntegrations = Omit<DeveloperApiConfiguration,
  "issuer" | "env" | "methods" | "slackTeamId" | "since" | "signInTableName" |
  "taskPeopleConfiguration" | "workflowDependenciesEnabled" | "inviteTaskPerson" | "webOrigin">;

/** The deployed developer configuration factory; transports remain injected and this seam is directly contract-tested. */
export function createDeveloperApiConfiguration(
  environment: Record<string, string | undefined>,
  integrations: (issuer: string, identityFunctionName: string) => DeveloperApiIntegrations,
  inviteTaskPerson?: DeveloperApiConfiguration["inviteTaskPerson"],
): DeveloperApiConfiguration | undefined {
  const issuer = environment.DEVELOPER_TOKEN_ISSUER;
  if (!issuer) return undefined;
  // The sign-in function by name (Lambda's Invoke takes a name as it takes an ARN): the variable is held to Lambda's 4 KB with the rest
  // of the broker's. An ARN still works, for an environment that gives one.
  const identityFunctionName = environment.DEVELOPER_IDENTITY_FUNCTION_NAME || environment.DEVELOPER_IDENTITY_FUNCTION_ARN;
  if (!identityFunctionName) throw new Error("DEVELOPER_IDENTITY_FUNCTION_NAME is required");
  const signInTableName = environment.DEVELOPER_SIGNIN_TABLE_NAME;
  if (!signInTableName) throw new Error("DEVELOPER_SIGNIN_TABLE_NAME is required");
  const env = environment.AGENTX_ENV;
  if (!env) throw new Error("AGENTX_ENV is required");
  const slackTeamId = environment.SLACK_TEAM_ID ?? "";
  return {
    ...integrations(issuer, identityFunctionName),
    issuer,
    env,
    methods: { slack: environment.DEVELOPER_SIGNIN_SLACK === "enabled", oidc: (environment.DEVELOPER_OIDC_ISSUER ?? "") !== "", cloud: (environment.DEVELOPER_CLOUD_ISSUER ?? "") !== "",
      // GitHub sign-in needs a cloud install and a configured GitHub OAuth app (the client id is not a secret; the sign-in function holds the secret).
      github: (environment.DEVELOPER_CLOUD_ISSUER ?? "") !== "" && (environment.DEVELOPER_GITHUB_CLIENT_ID ?? "") !== "",
      // SAML (Enterprise foundations I4) is on or off by the administrator's saved settings and by the edition, not by the environment: a SAML session is refused at every request where the edition has no `sso`.
      saml: true },
    ...(slackTeamId === "" ? {} : { slackTeamId }),
    since: developerSinceFromEnvironment(environment),
    signInTableName,
    webOrigin: webOriginFromEnvironment(environment),
    ...workflowDependenciesConfigurationFromEnvironment(environment),
    taskPeopleConfiguration: { peopleChangesEnabled: environment.AGENTX_TASK_PEOPLE_CHANGES_ENABLED === "true" },
    ...(inviteTaskPerson === undefined ? {} : { inviteTaskPerson }),
  };
}
