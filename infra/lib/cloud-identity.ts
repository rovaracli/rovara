// Sign-in for the hosted Rovara cloud: a self-serve Cognito user pool where anyone may sign up with an
// emailed one-time code or Google. Named environments with the agentxCloud context only (ruling R12:
// legacy deployments are not part of the multi-tenant branch). The DeveloperIdentity function is the
// confidential client: it runs the authorization code flow against this pool (developer/server.ts) and
// then issues its own developer tokens, so nothing here replaces the admin pool in identity.ts.
import { Aws, CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, SecretValue, Stack, aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

/** Where the sign-in server finishes a cloud sign-in: `${DEVELOPER_TOKEN_ISSUER}/callback/cloud` (developer/server.ts). */
export const CLOUD_CALLBACK_PATH = "/callback/cloud";
/** Where the sign-in server finishes a GitHub sign-in: `${DEVELOPER_TOKEN_ISSUER}/callback/github` (developer/server.ts). */
export const GITHUB_CALLBACK_PATH = "/callback/github";
/** The name shown on the sign-in button, and the broker's own default (developer-identity.ts). */
export const CLOUD_DISPLAY_NAME = "Rovara";
/**
 * The sign-in code email (Task 7), pinned by tests/contract/cloud-identity-infrastructure.test.ts. The verification
 * email (sign-up confirmation) carries the same body under its own subject. {####} is where Cognito puts the code.
 */
export const SIGN_IN_CODE_SUBJECT = "Your Rovara sign-in code";
export const SIGN_IN_CODE_MESSAGE = "<p>Your Rovara sign-in code is <strong>{####}</strong>.</p><p>It works once and expires in a few minutes. If you didn't try to sign in to Rovara, you can ignore this email.</p><p>Rovara</p>";
export const VERIFICATION_SUBJECT = "Confirm your email for Rovara";

export interface CloudIdentityProps {
  env: string;
  /** The sign-in server's issuer (`<api>/v1/auth`), which the callback hangs off. */
  signInIssuer: string;
}

export class CloudIdentity extends Construct {
  /** The pool's OIDC issuer, which the broker and the sign-in function read as DEVELOPER_CLOUD_ISSUER. */
  readonly issuer: string;
  readonly clientId: string;
  /** The user pool's ID and ARN (Plan 3, Task 21a-presence): the sign-in function creates and reads email-code users in it, on this ARN only. */
  readonly userPoolId: string;
  readonly userPoolArn: string;
  /** The Secrets Manager secret holding {"clientSecret": ...}; only the sign-in function may read it. */
  readonly secret: secretsmanager.Secret;
  /** Its name, as DEVELOPER_CLOUD_SECRET_ID carries it. */
  readonly secretName: string;
  readonly displayName = CLOUD_DISPLAY_NAME;
  /** Where the hosted Rovara web app lives; invite links point at it (ROVARA_WEB_ORIGIN). */
  readonly webOrigin: CfnParameter;
  /** Sign up and sign in with GitHub (Task 22): the OAuth app's client id, and the secret holding its client secret as {"clientSecret": ...}. Both empty turns it off. */
  readonly githubClientId: CfnParameter;
  readonly githubClientSecretArn: CfnParameter;
  /** True only when both GitHub parameters are set. The sign-in function's grant on the secret exists only under it. */
  readonly githubEnabled: CfnCondition;
  /** The sign-in code email's SES sender (Task 7), and the notice of a new sign-in method (Task 8) sent from it: the sender, the identity's ARN, and the condition that both are set. */
  readonly emailFrom: CfnParameter;
  readonly emailSourceArn: CfnParameter;
  readonly emailFromSes: CfnCondition;

  constructor(scope: Construct, id: string, props: CloudIdentityProps) {
    super(scope, id);
    const stack = Stack.of(this);

    // Declared on the stack itself, so the parameter names are exactly these.
    // Google sign-in is optional (ruling R46): with an empty GoogleClientId there is no Google identity provider
    // and the email code is the only way in. The domain prefix defaults to rovara-<env>.
    const googleClientId = new CfnParameter(stack, "GoogleClientId", {
      type: "String", default: "", maxLength: 256,
      description: "Client ID of the Google OAuth app for Rovara cloud sign-in; leave empty to offer the emailed code only",
    });
    const googleClientSecretArn = new CfnParameter(stack, "GoogleClientSecretArn", {
      type: "String", default: "", allowedPattern: "^(arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:\\S+)?$",
      description: "ARN of the Secrets Manager secret holding the Google OAuth client secret as JSON, {\"clientSecret\": \"...\"}; needed with GoogleClientId",
    });
    const domainPrefix = new CfnParameter(stack, "CloudIdentityDomainPrefix", {
      type: "String", default: `rovara-${props.env}`, allowedPattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
      description: "Prefix of the hosted sign-in domain (<prefix>.auth.<region>.amazoncognito.com); unique per region, and it must not contain aws, amazon or cognito",
    });
    // GitHub is not federated through Cognito (GitHub is not OIDC): the sign-in function runs its OAuth flow itself, so these
    // parameters feed that function and nothing in the pool.
    this.githubClientId = new CfnParameter(stack, "GitHubClientId", {
      type: "String", default: "", maxLength: 256,
      // Plain text only: the broker is given it in its packed settings (BrokerSettings, ENV-ROOM), joined unescaped. GitHub's client ids are letters, digits and a dot.
      allowedPattern: "^[A-Za-z0-9._-]{0,64}$",
      description: "Client ID of the GitHub OAuth app for Rovara sign up and sign in with GitHub; leave empty to not offer it",
    });
    this.githubClientSecretArn = new CfnParameter(stack, "GitHubClientSecretArn", {
      type: "String", default: "", allowedPattern: "^(arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:\\S+)?$",
      description: "ARN of the Secrets Manager secret holding the GitHub OAuth client secret as JSON, {\"clientSecret\": \"...\"}; needed with GitHubClientId",
    });
    this.githubEnabled = new CfnCondition(stack, "GitHubSignInEnabled", {
      expression: Fn.conditionAnd(
        Fn.conditionNot(Fn.conditionEquals(this.githubClientId.valueAsString, "")),
        Fn.conditionNot(Fn.conditionEquals(this.githubClientSecretArn.valueAsString, "")),
      ),
    });
    const googleEnabled = new CfnCondition(stack, "GoogleSignInEnabled", {
      expression: Fn.conditionNot(Fn.conditionEquals(googleClientId.valueAsString, "")),
    });
    // Sign-in codes from a branded Amazon SES sender (Task 7). Both empty keeps Cognito's built-in sender.
    const emailFrom = this.emailFrom = new CfnParameter(stack, "CloudSignInEmailFrom", {
      type: "String", default: "", maxLength: 320,
      description: "Sender of the sign-in code email, for example Rovara <signin@rovara.dev>; needs CloudSignInEmailSourceArn. Leave empty to use Amazon Cognito's default sender",
    });
    const emailSourceArn = this.emailSourceArn = new CfnParameter(stack, "CloudSignInEmailSourceArn", {
      type: "String", default: "", allowedPattern: "^(arn:aws[a-z-]*:ses:[a-z0-9-]+:[0-9]{12}:identity/\\S+)?$",
      description: "ARN of the Amazon SES identity (the verified domain) that sends the sign-in code email, for example arn:aws:ses:us-west-2:123456789012:identity/rovara.dev; needs CloudSignInEmailFrom",
    });
    const emailFromSes = this.emailFromSes = new CfnCondition(stack, "CloudSignInEmailFromSes", {
      expression: Fn.conditionAnd(
        Fn.conditionNot(Fn.conditionEquals(emailFrom.valueAsString, "")),
        Fn.conditionNot(Fn.conditionEquals(emailSourceArn.valueAsString, "")),
      ),
    });
    this.webOrigin = new CfnParameter(stack, "RovaraWebOrigin", {
      type: "String", default: "https://rovara.dev", allowedPattern: "^https://[^/\\s]+$",
      description: "The hosted Rovara web app's origin, which invite links point at",
    });

    // Changing signInAliases/autoVerify or the required email attribute replaces the user pool (Cognito cannot
    // update them in place), so once deployed treat them as fixed, as with the admin pool (identity.ts).
    // Emails (sign-in codes) go out through Cognito's built-in sender, or through Amazon SES from a branded sender
    // when CloudSignInEmailFrom and CloudSignInEmailSourceArn are set (the overrides below). The built-in sender has a daily cap.
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
      // The sign-up confirmation email, in both senders' cases; the sign-in code email below has the same body.
      userVerification: { emailStyle: cognito.VerificationEmailStyle.CODE, emailSubject: VERIFICATION_SUBJECT, emailBody: SIGN_IN_CODE_MESSAGE },
      deletionProtection: true,
      // Retained: the user pool holds every Rovara account and must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const cfnPool = pool.node.defaultChild as cognito.CfnUserPool;
    cfnPool.adminCreateUserConfig = { allowAdminCreateUserOnly: false };
    // Both are in-place updates (no interruption, so the pool is never replaced). DEVELOPER makes Cognito call Amazon SES
    // and create its service-linked role AWSServiceRoleForAmazonCognitoIdpEmailService on first use. The one-time sign-in
    // code template is EmailAuthenticationSubject/Message; the API's EmailMfaConfiguration is not a CloudFormation property.
    cfnPool.addPropertyOverride("EmailConfiguration", Fn.conditionIf(emailFromSes.logicalId, {
      EmailSendingAccount: "DEVELOPER", From: emailFrom.valueAsString, SourceArn: emailSourceArn.valueAsString,
    }, { EmailSendingAccount: "COGNITO_DEFAULT" }));
    cfnPool.addPropertyOverride("EmailAuthenticationSubject", Fn.conditionIf(emailFromSes.logicalId, SIGN_IN_CODE_SUBJECT, Aws.NO_VALUE));
    cfnPool.addPropertyOverride("EmailAuthenticationMessage", Fn.conditionIf(emailFromSes.logicalId, SIGN_IN_CODE_MESSAGE, Aws.NO_VALUE));

    const googleClientSecretValue = SecretValue.secretsManager(googleClientSecretArn.valueAsString, { jsonField: "clientSecret" });
    const google = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
      userPool: pool,
      clientId: googleClientId.valueAsString,
      clientSecretValue: googleClientSecretValue,
      scopes: ["openid", "email", "profile"],
      // email_verified too: the broker keeps an email only when the ID token says it is verified (providers.ts verifiedEmail).
      attributeMapping: { email: cognito.ProviderAttribute.GOOGLE_EMAIL, emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED },
    });

    // Without a client id there is no Google provider, and the secret reference is never evaluated (an empty ARN would not resolve).
    const cfnGoogle = google.node.defaultChild as cognito.CfnUserPoolIdentityProvider;
    cfnGoogle.cfnOptions.condition = googleEnabled;
    cfnGoogle.addPropertyOverride("ProviderDetails.client_secret", Fn.conditionIf(googleEnabled.logicalId, googleClientSecretValue.unsafeUnwrap(), ""));

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
    // The client lists Google only when it exists. The Ref returns the provider's name and orders the client after it,
    // but a Ref inside the true branch is evaluated only then; an unconditional DependsOn on the conditional provider
    // would fail the email-only deploy, so there is none.
    (client.node.defaultChild as cognito.CfnUserPoolClient).addPropertyOverride("SupportedIdentityProviders", Fn.conditionIf(googleEnabled.logicalId, ["COGNITO", cfnGoogle.ref], ["COGNITO"]));

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
    this.userPoolId = pool.userPoolId;
    this.userPoolArn = pool.userPoolArn;

    new CfnOutput(stack, "CloudIdentityIssuer", { value: this.issuer });
    new CfnOutput(stack, "CloudIdentityClientId", { value: this.clientId });
    // Register this as the GitHub OAuth app's authorization callback URL (the sign-in server finishes the flow here).
    new CfnOutput(stack, "CloudIdentityGitHubCallbackUrl", { value: `${props.signInIssuer}${GITHUB_CALLBACK_PATH}`, description: "Authorization callback URL to register with the GitHub OAuth app" });
    // Register this with the Google OAuth app as an authorized redirect URI.
    new CfnOutput(stack, "CloudIdentityGoogleRedirectUri", { value: `${domain.baseUrl()}/oauth2/idpresponse`, description: "Authorized redirect URI to register with the Google OAuth app" });
  }
}
