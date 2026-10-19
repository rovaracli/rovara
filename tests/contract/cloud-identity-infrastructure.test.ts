import { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
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
      AttributeMapping: { email: "email" },
    });
    const secret = JSON.stringify(resourcesOf(template, "AWS::Cognito::UserPoolIdentityProvider")[0]![1].Properties.ProviderDetails.client_secret);
    expect(secret).toContain("{{resolve:secretsmanager:");
    expect(secret).toContain("GoogleClientSecretArn");
    expect(secret).toContain("clientSecret");
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
      SupportedIdentityProviders: ["COGNITO", "Google"],
      PreventUserExistenceErrors: "ENABLED",
    });
    // The broker's cloud provider sends `${DEVELOPER_TOKEN_ISSUER}/callback/cloud` as redirect_uri (developer/server.ts).
    const callback = JSON.stringify(resourcesOf(template, "AWS::Cognito::UserPoolClient")[0]![1].Properties.CallbackURLs);
    expect(callback).toContain("/v1/auth/callback/cloud");
    expect(callback).toContain("Fn::GetAtt");
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
    expect(broker.DEVELOPER_CLOUD_ISSUER).toEqual(identity.DEVELOPER_CLOUD_ISSUER);
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
    expect(text).not.toContain("—");
  });
});
