// Sign-in for the hosted Rovara cloud: a self-serve Cognito user pool where anyone may sign up with an
// emailed one-time code or Google. Named environments with the agentxCloud context only (ruling R12:
// legacy deployments are not part of the multi-tenant branch). The DeveloperIdentity function is the
// confidential client: it runs the authorization code flow against this pool (developer/server.ts) and
// then issues its own developer tokens, so nothing here replaces the admin pool in identity.ts.
import { CfnOutput, CfnParameter, Duration, RemovalPolicy, SecretValue, Stack, aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

/** Where the sign-in server finishes a cloud sign-in: `${DEVELOPER_TOKEN_ISSUER}/callback/cloud` (developer/server.ts). */
export const CLOUD_CALLBACK_PATH = "/callback/cloud";
/** The name shown on the sign-in button, and the broker's own default (developer-identity.ts). */
export const CLOUD_DISPLAY_NAME = "Rovara";

export interface CloudIdentityProps {
  env: string;
  /** The sign-in server's issuer (`<api>/v1/auth`), which the callback hangs off. */
  signInIssuer: string;
}

export class CloudIdentity extends Construct {
  /** The pool's OIDC issuer, which the broker and the sign-in function read as DEVELOPER_CLOUD_ISSUER. */
  readonly issuer: string;
  readonly clientId: string;
  /** The Secrets Manager secret holding {"clientSecret": ...}; only the sign-in function may read it. */
  readonly secret: secretsmanager.Secret;
  /** Its name, as DEVELOPER_CLOUD_SECRET_ID carries it. */
  readonly secretName: string;
  readonly displayName = CLOUD_DISPLAY_NAME;
  /** Where the hosted Rovara web app lives; invite links point at it (ROVARA_WEB_ORIGIN). */
  readonly webOrigin: CfnParameter;

  constructor(scope: Construct, id: string, props: CloudIdentityProps) {
    super(scope, id);
    const stack = Stack.of(this);

    // Declared on the stack itself, so the parameter names are exactly these.
    const googleClientId = new CfnParameter(stack, "GoogleClientId", {
      type: "String", minLength: 1, maxLength: 256,
      description: "Client ID of the Google OAuth app for Rovara cloud sign-in",
    });
    const googleClientSecretArn = new CfnParameter(stack, "GoogleClientSecretArn", {
      type: "String", allowedPattern: "^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:\\S+$",
      description: "ARN of the Secrets Manager secret holding the Google OAuth client secret as JSON, {\"clientSecret\": \"...\"}",
    });
    const domainPrefix = new CfnParameter(stack, "CloudIdentityDomainPrefix", {
      type: "String", allowedPattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
      description: "Prefix of the hosted sign-in domain (<prefix>.auth.<region>.amazoncognito.com); unique per region, and it must not contain aws, amazon or cognito",
    });
    this.webOrigin = new CfnParameter(stack, "RovaraWebOrigin", {
      type: "String", default: "https://rovara.dev", allowedPattern: "^https://[^/\\s]+$",
      description: "The hosted Rovara web app's origin, which invite links point at",
    });

    // Changing signInAliases/autoVerify or the required email attribute replaces the user pool (Cognito cannot
    // update them in place), so once deployed treat them as fixed, as with the admin pool (identity.ts).
    // Emails (sign-in codes) go out through Cognito's built-in sender; see the report for its daily cap.
    const pool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `rovara-${props.env}-cloud`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Passwordless sign-in is choice-based, and it needs the Essentials feature plan.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      // Cognito requires password to stay allowed; the sign-in page offers the emailed code and Google.
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      // Retained: the user pool holds every Rovara account and must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    (pool.node.defaultChild as cognito.CfnUserPool).adminCreateUserConfig = { allowAdminCreateUserOnly: false };

    const google = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
      userPool: pool,
      clientId: googleClientId.valueAsString,
      clientSecretValue: SecretValue.secretsManager(googleClientSecretArn.valueAsString, { jsonField: "clientSecret" }),
      scopes: ["openid", "email", "profile"],
      attributeMapping: { email: cognito.ProviderAttribute.GOOGLE_EMAIL },
    });

    const client = pool.addClient("SignIn", {
      generateSecret: true,
      // The managed login pages drive sign-in through the authorization code grant; choice-based passwordless
      // needs ALLOW_USER_AUTH on the client. No password flow is enabled for direct API use.
      authFlows: { user: true, adminUserPassword: false, custom: false, userPassword: false, userSrp: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${props.signInIssuer}${CLOUD_CALLBACK_PATH}`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO, cognito.UserPoolClientIdentityProvider.GOOGLE],
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
    // The client lists Google as a supported provider, which must exist first.
    client.node.addDependency(google);

    // Email codes are offered by managed login only, not the classic hosted UI.
    const domain = pool.addDomain("HostedUi", {
      cognitoDomain: { domainPrefix: domainPrefix.valueAsString },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const branding = new cognito.CfnManagedLoginBranding(this, "Branding", {
      userPoolId: pool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);

    // The sign-in function reads the secret as {"clientSecret": ...} (parseCloudClientSecret).
    this.secretName = `agentx/${props.env}/developer-cloud`;
    this.secret = new secretsmanager.Secret(this, "ClientSecret", {
      secretName: this.secretName,
      description: `The Rovara cloud sign-in app client secret for ${props.env}`,
      // The client resource's own ClientSecret attribute: the L2 userPoolClientSecret reads it through a custom resource instead.
      secretObjectValue: { clientSecret: SecretValue.resourceAttribute((client.node.defaultChild as cognito.CfnUserPoolClient).attrClientSecret) },
    });

    this.issuer = `https://cognito-idp.${stack.region}.amazonaws.com/${pool.userPoolId}`;
    this.clientId = client.userPoolClientId;

    new CfnOutput(stack, "CloudIdentityIssuer", { value: this.issuer });
    new CfnOutput(stack, "CloudIdentityClientId", { value: this.clientId });
    // Register this with the Google OAuth app as an authorized redirect URI.
    new CfnOutput(stack, "CloudIdentityGoogleRedirectUri", { value: `${domain.baseUrl()}/oauth2/idpresponse`, description: "Authorized redirect URI to register with the Google OAuth app" });
  }
}
