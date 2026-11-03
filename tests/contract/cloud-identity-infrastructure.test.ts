import { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { brokerNamesIn, brokerSettingsIn } from "../support/broker-names-template.js";
import { evaluate } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Action: string | string[]; Resource: unknown };
type Resource = {
  Type: string;
  Properties: {
    Name?: string;
    Environment: { Variables: Record<string, unknown> };
    ProviderDetails: { client_secret: unknown };
    PolicyDocument: { Statement: Statement[] };
    [key: string]: unknown;
  };
};

function controlPlane(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  return Template.fromStack(stack!);
}

const cloud = () => controlPlane({ agentxEnv: "staging", agentxCloud: true });
const resourcesOf = (template: Template, type: string): Array<[string, Resource]> =>
  Object.entries(template.toJSON().Resources as Record<string, Resource>).filter(([, resource]) => resource.Type === type);
const functionNamed = (template: Template, prefix: string): Resource => {
  const found = resourcesOf(template, "AWS::Lambda::Function").find(([id]) => id.startsWith(prefix));
  expect(found, prefix).toBeDefined();
  return found![1];
};
const googleProviderId = (template: Template): string => resourcesOf(template, "AWS::Cognito::UserPoolIdentityProvider")[0]![0];
const brokerEnvironment = (template: Template) => functionNamed(template, "Broker").Properties.Environment.Variables;
const identityEnvironment = (template: Template) => functionNamed(template, "DeveloperSignInFunction").Properties.Environment.Variables;

describe("cloud identity infrastructure", () => {
  it("creates one self-serve user pool with email sign-in and passwordless email codes", () => {
    const template = cloud();
    expect(resourcesOf(template, "AWS::Cognito::UserPool")).toHaveLength(1);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      Schema: Match.arrayWith([Match.objectLike({ Name: "email", Required: true })]),
      UserPoolTier: "ESSENTIALS",
      Policies: Match.objectLike({ SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"] } }),
      DeletionProtection: "ACTIVE",
    });
    template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("adds a Google identity provider whose secret is a dynamic reference to the GoogleClientSecretArn parameter", () => {
    const template = cloud();
    expect(resourcesOf(template, "AWS::Cognito::UserPoolIdentityProvider")).toHaveLength(1);
    template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "Google",
      ProviderType: "Google",
      ProviderDetails: Match.objectLike({ client_id: { Ref: "GoogleClientId" }, authorize_scopes: "openid email profile" }),
      AttributeMapping: { email: "email", email_verified: "email_verified" },
    });
    const secret = JSON.stringify(resourcesOf(template, "AWS::Cognito::UserPoolIdentityProvider")[0]![1].Properties.ProviderDetails.client_secret);
    expect(secret).toContain("{{resolve:secretsmanager:");
    expect(secret).toContain("GoogleClientSecretArn");
    expect(secret).toContain("clientSecret");
  });

  it("makes Google optional: every parameter has a default and the provider exists only for a non-empty GoogleClientId (R46)", () => {
    const template = cloud();
    const json = template.toJSON() as { Parameters: Record<string, { Default?: string }>; Conditions: Record<string, unknown>; Resources: Record<string, { Condition?: string; Type: string }> };
    expect(json.Parameters.GoogleClientId?.Default).toBe("");
    expect(json.Parameters.GoogleClientSecretArn?.Default).toBe("");
    expect(json.Parameters.CloudIdentityDomainPrefix?.Default).toBe("rovara-staging");
    expect(json.Conditions.GoogleSignInEnabled).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "GoogleClientId" }, ""] }] });
    const [, provider] = resourcesOf(template, "AWS::Cognito::UserPoolIdentityProvider")[0]!;
    expect((provider as unknown as { Condition?: string }).Condition).toBe("GoogleSignInEnabled");
    // The secret reference sits in the condition's own branch, so an empty ARN is never resolved.
    expect(JSON.stringify(provider.Properties.ProviderDetails.client_secret)).toMatch(/^\{"Fn::If":\["GoogleSignInEnabled",/);
    // The default prefix is what the Cognito domain uses, and the pool, client and domain do not depend on Google being set.
    for (const type of ["AWS::Cognito::UserPool", "AWS::Cognito::UserPoolDomain", "AWS::Cognito::UserPoolClient"]) {
      expect(resourcesOf(template, type)[0]![1]).not.toHaveProperty("Condition");
    }
  });

  it("lets the app client deploy without Google: no unconditional DependsOn on the provider, which a Ref makes conditional (email-only sign-in)", () => {
    const template = cloud();
    const providerId = googleProviderId(template);
    const [clientId, client] = resourcesOf(template, "AWS::Cognito::UserPoolClient")[0]!;
    // The client is always created, so it must not name the conditional provider in DependsOn.
    expect((client as unknown as { DependsOn?: string | string[] }).DependsOn ?? []).not.toContain(providerId);
    expect(JSON.stringify(client)).not.toContain(`"DependsOn":["${providerId}"`);
    // Without a GoogleClientId the condition is false, so the providers resolve to COGNITO alone.
    const providers = client.Properties.SupportedIdentityProviders as { "Fn::If": [string, unknown, unknown] };
    expect(providers["Fn::If"][0]).toBe("GoogleSignInEnabled");
    expect(providers["Fn::If"][2]).toEqual(["COGNITO"]);
    // With one, they include the provider's name through a Ref, which orders the client after it.
    expect(providers["Fn::If"][1]).toEqual(["COGNITO", { Ref: providerId }]);
    // Nothing else in the template points at the client's dependency on the provider unconditionally.
    const dependants = Object.entries(template.toJSON().Resources as Record<string, { DependsOn?: string | string[] }>)
      .filter(([id, resource]) => id !== clientId && [resource.DependsOn ?? []].flat().includes(providerId));
    expect(dependants).toEqual([]);
  });

  it("takes the Google client, its secret, the hosted-domain prefix and the web origin as parameters", () => {
    const parameters = cloud().toJSON().Parameters as Record<string, { Type: string; Default?: string }>;
    expect(parameters.GoogleClientId?.Type).toBe("String");
    expect(parameters.GoogleClientSecretArn?.Type).toBe("String");
    expect(parameters.CloudIdentityDomainPrefix?.Type).toBe("String");
    expect(parameters.RovaraWebOrigin?.Default).toBe("https://rovara.dev");
    cloud().hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: { Ref: "CloudIdentityDomainPrefix" }, ManagedLoginVersion: 2 });
    expect(resourcesOf(cloud(), "AWS::Cognito::ManagedLoginBranding")).toHaveLength(1);
  });

  it("has one confidential authorization-code app client calling back to the sign-in server's real cloud callback", () => {
    const template = cloud();
    expect(resourcesOf(template, "AWS::Cognito::UserPoolClient")).toHaveLength(1);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: Match.arrayEquals(["openid", "email", "profile"]),
      // Google is listed only when it exists (the GoogleSignInEnabled condition), by a Ref to the provider.
      SupportedIdentityProviders: { "Fn::If": ["GoogleSignInEnabled", ["COGNITO", { Ref: googleProviderId(template) }], ["COGNITO"]] },
      PreventUserExistenceErrors: "ENABLED",
    });
    // The broker's cloud provider sends `${DEVELOPER_TOKEN_ISSUER}/callback/cloud` as redirect_uri (developer/server.ts).
    const callback = JSON.stringify(resourcesOf(template, "AWS::Cognito::UserPoolClient")[0]![1].Properties.CallbackURLs);
    expect(callback).toContain("/v1/auth/callback/cloud");
    expect(callback).toContain("Fn::GetAtt");
  });

  it("leaves every IdP-mapped attribute writable: a write list that omits email_verified fails Google sign-in", () => {
    const [, client] = resourcesOf(cloud(), "AWS::Cognito::UserPoolClient")[0]!;
    const provider = resourcesOf(cloud(), "AWS::Cognito::UserPoolIdentityProvider")[0]![1];
    const mapped = Object.keys(provider.Properties.AttributeMapping as Record<string, unknown>);
    expect(mapped).toEqual(expect.arrayContaining(["email", "email_verified"]));
    // No explicit list means every attribute is writable (the default); an explicit one must name every mapped attribute.
    const writable = client.Properties.WriteAttributes as string[] | undefined;
    if (writable !== undefined) for (const attribute of mapped) expect(writable).toContain(attribute);
    // Email stays safe without it: the client has a secret, its scopes exclude aws.cognito.signin.user.admin, and the sign-in links only a verified email.
    expect(client.Properties.AllowedOAuthScopes).not.toContain("aws.cognito.signin.user.admin");
  });

  it("stores the client secret as {clientSecret} in Secrets Manager under the environment's name", () => {
    const template = cloud();
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "agentx/staging/developer-cloud",
      SecretString: Match.anyValue(),
    });
    const secret = resourcesOf(template, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/developer-cloud")![1];
    const text = JSON.stringify(secret.Properties.SecretString);
    expect(text).toContain("clientSecret");
    // Read from the client resource directly, not through a custom resource.
    const clientId = resourcesOf(template, "AWS::Cognito::UserPoolClient")[0]![0];
    expect(text).toContain(JSON.stringify({ "Fn::GetAtt": [clientId, "ClientSecret"] }));
    expect(resourcesOf(template, "Custom::AWS")).toHaveLength(0);
  });

  it("gives the sign-in function and the broker the cloud settings, and the broker only what it reads", () => {
    const template = cloud();
    const identity = identityEnvironment(template);
    for (const key of ["DEVELOPER_CLOUD_ISSUER", "DEVELOPER_CLOUD_CLIENT_ID", "DEVELOPER_CLOUD_SECRET_ID", "DEVELOPER_CLOUD_DISPLAY_NAME"]) {
      expect(identity[key], key).toBeDefined();
    }
    expect(identity.DEVELOPER_CLOUD_SECRET_ID).toBe("agentx/staging/developer-cloud");
    expect(JSON.stringify(identity.DEVELOPER_CLOUD_ISSUER)).toContain("https://cognito-idp.");
    const broker = brokerEnvironment(template);
    // The broker is given the pool's id in its one variable of names (its variables are held to Lambda's 4 KB) and builds the issuer from
    // it: to the text the sign-in function is given, which is the pool's issuer URL.
    expect(broker.DEVELOPER_CLOUD_ISSUER).toBeUndefined();
    const poolId = resourcesOf(template, "AWS::Cognito::UserPool").map(([id]) => id).find((id) => id.startsWith("DeveloperSignInCloudIdentity"))!;
    expect(brokerNamesIn(broker).cloudUserPool).toEqual({ Ref: poolId });
    expect(JSON.stringify(identity.DEVELOPER_CLOUD_ISSUER)).toContain(JSON.stringify({ Ref: poolId }));
    const built: MutableEnvironment = { AGENTX_ENV: "staging", AGENTX_NAMES: JSON.stringify({ ci: "us-west-2_AbCdEfGhI" }), AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012" };
    hydrateBrokerEnvironment(built);
    expect(built.DEVELOPER_CLOUD_ISSUER).toBe(evaluate(identity.DEVELOPER_CLOUD_ISSUER, { parameters: { [poolId]: "us-west-2_AbCdEfGhI" }, conditions: {}, pseudo: { "AWS::Region": "us-west-2" } }));
    expect(broker.ROVARA_WEB_ORIGIN).toEqual({ Ref: "RovaraWebOrigin" });
    expect(broker.DEVELOPER_CLOUD_SECRET_ID).toBeUndefined();
  });

  it("lets only the sign-in function read the cloud client secret", () => {
    const template = cloud();
    const secretId = resourcesOf(template, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/developer-cloud")![0];
    const readers = resourcesOf(template, "AWS::IAM::Policy").filter(([, policy]) =>
      policy.Properties.PolicyDocument.Statement.some(
        (statement) => JSON.stringify(statement.Resource) === JSON.stringify({ Ref: secretId }) && [statement.Action].flat().includes("secretsmanager:GetSecretValue"),
      ),
    );
    expect(readers).toHaveLength(1);
    expect(readers[0]![0]).toMatch(/^DeveloperSignInFunctionServiceRoleDefaultPolicy/);
  });

  describe("sign up and sign in with GitHub (Task 22)", () => {
    const json = () => cloud().toJSON() as { Parameters: Record<string, { Type: string; Default?: string }>; Conditions: Record<string, unknown>; Outputs: Record<string, { Value: unknown }> };
    const githubReaders = (template: Template) => resourcesOf(template, "AWS::IAM::Policy").filter(([, policy]) =>
      policy.Properties.PolicyDocument.Statement.some((statement) => JSON.stringify(statement.Resource) === JSON.stringify({ Ref: "GitHubClientSecretArn" }) && [statement.Action].flat().includes("secretsmanager:GetSecretValue")));

    it("takes the OAuth app's client id and secret ARN as optional parameters, behind the GitHubSignInEnabled condition", () => {
      const { Parameters, Conditions } = json();
      expect(Parameters.GitHubClientId).toMatchObject({ Type: "String", Default: "" });
      expect(Parameters.GitHubClientSecretArn).toMatchObject({ Type: "String", Default: "" });
      expect(Conditions.GitHubSignInEnabled).toEqual({ "Fn::And": [
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "GitHubClientId" }, ""] }] },
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "GitHubClientSecretArn" }, ""] }] },
      ] });
    });

    it("hands the sign-in function the client id and secret id, and the broker only the client id (it needs to know the method is on)", () => {
      const template = cloud();
      const identity = identityEnvironment(template);
      expect(identity.DEVELOPER_GITHUB_CLIENT_ID).toEqual({ Ref: "GitHubClientId" });
      expect(identity.DEVELOPER_GITHUB_SECRET_ID).toEqual({ Ref: "GitHubClientSecretArn" });
      const broker = brokerEnvironment(template);
      // The broker is given it in its packed settings (ENV-ROOM), not as a variable of its own; the parameter admits plain text only so it can be joined unescaped.
      expect(broker.DEVELOPER_GITHUB_CLIENT_ID).toBeUndefined();
      expect(brokerSettingsIn(broker).developerGithubClientId).toEqual({ Ref: "GitHubClientId" });
      expect(json().Parameters.GitHubClientId).toMatchObject({ AllowedPattern: "^[A-Za-z0-9._-]{0,64}$" });
      expect(broker.DEVELOPER_GITHUB_SECRET_ID).toBeUndefined();
    });

    it("lets exactly one function read the GitHub client secret: the sign-in function, under the condition", () => {
      const template = cloud();
      const readers = githubReaders(template);
      expect(readers).toHaveLength(1);
      const [id, policy] = readers[0]!;
      expect(id).toMatch(/^DeveloperSignInGitHubSecretRead/);
      expect((policy as unknown as { Condition?: string }).Condition).toBe("GitHubSignInEnabled");
      const roles = (policy.Properties as unknown as { Roles: Array<{ Ref: string }> }).Roles;
      expect(roles).toHaveLength(1);
      expect(roles[0]!.Ref).toBe((functionNamed(template, "DeveloperSignInFunction").Properties as unknown as { Role: { "Fn::GetAtt": string[] } }).Role["Fn::GetAtt"][0]);
    });

    it("lets the sign-in function reach the GitHub trial claim, and only it", () => {
      const template = cloud();
      const policies = resourcesOf(template, "AWS::IAM::Policy").filter(([, policy]) => JSON.stringify(policy.Properties.PolicyDocument).includes("TRIAL_GITHUB#*"));
      expect(policies).toHaveLength(1);
      expect(policies[0]![0]).toMatch(/^DeveloperSignInFunctionServiceRoleDefaultPolicy/);
    });

    it("prints the callback URL to register with the GitHub OAuth app", () => {
      expect(JSON.stringify(json().Outputs.CloudIdentityGitHubCallbackUrl?.Value)).toContain("/v1/auth/callback/github");
    });

    it("adds nothing without agentxCloud: no parameter, no environment variable, no policy", () => {
      for (const template of [controlPlane({ agentxEnv: "staging" }), controlPlane({ agentxEnv: "staging", agentxCloud: false })]) {
        const text = JSON.stringify(template.toJSON());
        expect(text).not.toContain("GitHubClientId");
        expect(text).not.toContain("GitHubClientSecretArn");
        expect(text).not.toContain("GitHubSignInEnabled");
        expect(text).not.toContain("DEVELOPER_GITHUB_");
        expect(text).not.toContain("TRIAL_GITHUB");
      }
    });
  });

  it("exposes what an operator needs to finish the Google setup", () => {
    const outputs = cloud().toJSON().Outputs as Record<string, unknown>;
    for (const name of ["CloudIdentityIssuer", "CloudIdentityClientId", "CloudIdentityGoogleRedirectUri"]) expect(outputs[name], name).toBeDefined();
  });

  it("does nothing without agentxCloud, or without a named environment", () => {
    for (const template of [controlPlane({ agentxEnv: "staging" }), controlPlane({ agentxEnv: "staging", agentxCloud: false }), controlPlane({ agentxEnv: "staging", agentxCloud: "false" })]) {
      for (const type of ["AWS::Cognito::UserPool", "AWS::Cognito::UserPoolClient", "AWS::Cognito::UserPoolIdentityProvider", "AWS::Cognito::UserPoolDomain"]) {
        expect(resourcesOf(template, type), type).toHaveLength(0);
      }
      const parameters = Object.keys(template.toJSON().Parameters as Record<string, unknown>);
      for (const name of ["GoogleClientId", "GoogleClientSecretArn", "CloudIdentityDomainPrefix", "RovaraWebOrigin"]) expect(parameters).not.toContain(name);
      expect(JSON.stringify(template.toJSON())).not.toContain("DEVELOPER_CLOUD_");
      expect(JSON.stringify(template.toJSON())).not.toContain("ROVARA_WEB_ORIGIN");
    }
    const legacy = Template.fromStack(buildAgentXApp({ agentxCloud: true }).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane")!);
    expect(resourcesOf(legacy, "AWS::Cognito::UserPool")).toHaveLength(0);
  });

  it("accepts the flag as the string the cdk command line passes", () => {
    expect(resourcesOf(controlPlane({ agentxEnv: "staging", agentxCloud: "true" }), "AWS::Cognito::UserPool")).toHaveLength(1);
  });

  it("puts no em dash in any resource description or name", () => {
    const text = JSON.stringify(cloud().toJSON());
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("cloud sign-in codes from a branded Amazon SES sender (Task 7)", () => {
  const POOL_LOGICAL_ID = "DeveloperSignInCloudIdentityUserPoolAEDBF8D7";
  const FROM = "Rovara <signin@rovara.dev>";
  const SOURCE_ARN = "arn:aws:ses:us-west-2:123456789012:identity/rovara.dev";
  const CODE_BODY = "<p>Your Rovara sign-in code is <strong>{####}</strong>.</p><p>It works once and expires in a few minutes. If you didn't try to sign in to Rovara, you can ignore this email.</p><p>Rovara</p>";
  const pool = (template: Template) => {
    const json = template.toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>; Conditions: Record<string, unknown>; Parameters: Record<string, { Default?: string; Type: string }> };
    return { json, properties: json.Resources[POOL_LOGICAL_ID]!.Properties };
  };
  const evaluated = (parameters: Record<string, string>) => {
    const { json, properties } = pool(cloud());
    return evaluate(properties, { parameters, conditions: json.Conditions }) as Record<string, unknown>;
  };

  it("keeps the user pool's logical id, so nothing is replaced", () => {
    const { json } = pool(cloud());
    const pools = Object.entries(json.Resources).filter(([, resource]) => resource.Type === "AWS::Cognito::UserPool");
    expect(pools.map(([id]) => id)).toEqual([POOL_LOGICAL_ID]);
  });

  it("declares CloudSignInEmailFrom and CloudSignInEmailSourceArn with empty defaults, and the condition needs both", () => {
    const { json } = pool(cloud());
    expect(json.Parameters.CloudSignInEmailFrom).toMatchObject({ Type: "String", Default: "" });
    expect(json.Parameters.CloudSignInEmailSourceArn).toMatchObject({ Type: "String", Default: "" });
    expect(json.Conditions.CloudSignInEmailFromSes).toEqual({
      "Fn::And": [
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "CloudSignInEmailFrom" }, ""] }] },
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "CloudSignInEmailSourceArn" }, ""] }] },
      ],
    });
  });

  it("sends from Amazon SES (DEVELOPER) with the Rovara sender and sign-in code template when both parameters are set", () => {
    const properties = evaluated({ CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: SOURCE_ARN, CloudIdentityDomainPrefix: "rovara-staging" });
    expect(properties.EmailConfiguration).toEqual({ EmailSendingAccount: "DEVELOPER", From: FROM, SourceArn: SOURCE_ARN });
    expect(properties.EmailAuthenticationSubject).toBe("Your Rovara sign-in code");
    expect(properties.EmailAuthenticationMessage).toBe(CODE_BODY);
    expect(String(properties.EmailAuthenticationMessage)).toContain("{####}");
    expect(properties).not.toHaveProperty("EmailMfaConfiguration");
  });

  it("uses Cognito's default sender and no sign-in code template when neither is set, or only one is", () => {
    for (const parameters of [{}, { CloudSignInEmailFrom: FROM }, { CloudSignInEmailSourceArn: SOURCE_ARN }]) {
      const properties = evaluated({ CloudSignInEmailFrom: "", CloudSignInEmailSourceArn: "", CloudIdentityDomainPrefix: "rovara-staging", ...parameters });
      expect(properties.EmailConfiguration).toEqual({ EmailSendingAccount: "COGNITO_DEFAULT" });
      expect(properties).not.toHaveProperty("EmailAuthenticationSubject");
      expect(properties).not.toHaveProperty("EmailAuthenticationMessage");
    }
  });

  it("sets the verification email in both cases, with the same body", () => {
    for (const parameters of [{ CloudSignInEmailFrom: "", CloudSignInEmailSourceArn: "" }, { CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: SOURCE_ARN }]) {
      const properties = evaluated({ CloudIdentityDomainPrefix: "rovara-staging", ...parameters });
      expect(properties.VerificationMessageTemplate).toMatchObject({ DefaultEmailOption: "CONFIRM_WITH_CODE", EmailSubject: "Confirm your email for Rovara", EmailMessage: CODE_BODY });
    }
  });

  it("does not touch multi-factor authentication: the pool still signs in with choice-based passwordless codes", () => {
    const properties = evaluated({ CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: SOURCE_ARN, CloudIdentityDomainPrefix: "rovara-staging" });
    expect(properties).not.toHaveProperty("MfaConfiguration");
    expect(properties).not.toHaveProperty("EnabledMfas");
    expect(properties.Policies).toMatchObject({ SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"] } });
  });

  it("has no em dash in any Description, parameter or resource", () => {
    expect(JSON.stringify(cloud().toJSON())).not.toContain("—");
  });
});
