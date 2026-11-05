// A copy of the 0.5.6 CLI's strict environment settings schema (packages/cli/src/environments/settings.ts @ v0.5.6), kept so a test can prove that a 0.5.6 binary still reads the settings
// 0.5.7 wrote (an emergency rollback). Do not "fix" it to follow the current schema: that is the point. Its answer schemas are imported because they are unchanged since 0.5.6.
import { z } from "zod";
import { CloudSignInAnswersSchema, ModelsAnswersSchema } from "../../packages/cli/src/deploy/answer-schemas.js";
import { EnvironmentNameSchema } from "@agentx/contracts";

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
