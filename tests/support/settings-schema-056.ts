// A copy of the 0.5.6 CLI's strict environment settings schema (packages/cli/src/environments/settings.ts @ v0.5.6), kept so a test can prove that a 0.5.6 binary still reads the settings
// 0.5.7 wrote (an emergency rollback). Do not "fix" it to follow the current schema: that is the point.
import { z } from "zod";
import { EnvironmentNameSchema, MODEL_PROVIDERS, SECRET_ARN_MAX_LENGTH, SECRET_ARN_PATTERN } from "@agentx/contracts";

// FROZEN copies of the 0.5.6 answer schemas the settings schema embeds (packages/cli/src/deploy/answer-schemas.ts @ v0.5.6). They are not imported from the live file on purpose:
// a change there must not change what a 0.5.6 binary is shown to accept.
export const CloudSignInAnswersSchema = z.object({
  googleClientId: z.string().min(1).max(256).optional(),
  googleClientSecretArn: z.string().max(SECRET_ARN_MAX_LENGTH).regex(SECRET_ARN_PATTERN).optional(),
  domainPrefix: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
  /** Sign up and sign in with GitHub (Task 22): the GitHub OAuth app's client id and the secret holding its client secret. Optional, and together. */
  githubClientId: z.string().min(1).max(256).optional(),
  githubClientSecretArn: z.string().max(SECRET_ARN_MAX_LENGTH).regex(SECRET_ARN_PATTERN).optional(),
  /** Sign-in codes from a branded Amazon SES sender (Task 7): `Name <address>` or an address, and the ARN of the verified SES identity (the domain) that sends it. Optional, and together. */
  emailFrom: z.string().min(3).max(320).optional(),
  emailSourceArn: z.string().max(2048).regex(/^arn:aws[a-z-]*:ses:[a-z0-9-]+:\d{12}:identity\/\S+$/).optional(),
}).strict().refine((answers) => (answers.emailFrom === undefined) === (answers.emailSourceArn === undefined), { message: "emailFrom and emailSourceArn go together", path: ["emailFrom"] });

const ModelProviderSchema = z.enum(MODEL_PROVIDERS);
/** A direct provider's key: only the ARN of the secret holding it (spec 054). */
const DirectKeySchema = z.object({ secretArn: z.string().max(SECRET_ARN_MAX_LENGTH).regex(SECRET_ARN_PATTERN) }).strict();
const ModelsAnswersSchema = z.object({
  orchestrator: z.string().min(1), classifier: z.string().min(1), worker: z.string().min(1),
  providers: z.object({ orchestrator: ModelProviderSchema.optional(), classifier: ModelProviderSchema.optional(), worker: ModelProviderSchema.optional() }).strict().optional(),
  openRouter: z.object({
    secretArn: z.string().regex(SECRET_ARN_PATTERN),
    providers: z.array(z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,79}$/)).min(1).optional(),
  }).strict().optional(),
  anthropic: DirectKeySchema.optional(),
  openai: DirectKeySchema.optional(),
}).strict();


export const EnvironmentSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  engine: z.enum(["templates", "cdk"]),
  /** A release version such as 1.4.0, or "unversioned" for an adopted deployment. */
  version: z.string().regex(/^(?:\d+\.\d+\.\d+|unversioned)$/),
  /** Legacy for a deployment adopted with fixed stack names. */
  naming: z.enum(["environment", "legacy"]),
  stacks: z.object({ access: z.string().optional(), foundation: z.string(), identity: z.string().optional(), runtime: z.string(), "control-plane": z.string(), slack: z.string() }).strict(),
  controlPlaneUrl: z.string().url(),
  identity: z.object({
    mode: z.enum(["cognito", "oidc"]),
    issuer: z.string().url(),
    audience: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
  }).strict(),
  models: ModelsAnswersSchema,
  /** The environment is the hosted Rovara cloud (R45): every deploy and upgrade synthesizes with -c agentxCloud=true. */
  cloud: z.literal(true).optional(),
  /** The cloud sign-in settings the control-plane stack takes (R46). */
  cloudSignIn: CloudSignInAnswersSchema.optional(),
  alertAddress: z.string().min(1).optional(),
  access: z
    .object({
      artifactBucket: z.string().min(1),
      cloudFormationRoleArn: z.string().regex(/^arn:aws[a-z-]*:iam::[0-9]{12}:role\/.+$/),
      operatorRoleArn: z.string().regex(/^arn:aws[a-z-]*:iam::[0-9]{12}:role\/.+$/),
      pullThroughPrefix: z.string().min(1),
      permissionsBoundaryArn: z.string().regex(/^arn:aws[a-z-]*:iam::[0-9]{12}:policy\/.+$/).optional(),
    })
    .strict()
    .optional(),
  updatedAt: z.iso.datetime(),
}).strict();

export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>;
