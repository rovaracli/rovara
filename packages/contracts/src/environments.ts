import { RESOURCE_PREFIX, METRICS_NAMESPACE_ROOT } from "./resource-prefix.js";
import { z } from "zod";

/** Lowercase letters, digits and single hyphens; starts with a letter; at most 14 characters. */
export const ENVIRONMENT_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,12}[a-z0-9])?$/;

export const EnvironmentNameSchema = z
  .string()
  .regex(ENVIRONMENT_NAME_PATTERN, "environment name must be lowercase letters, digits and hyphens, start with a letter, and be at most 14 characters")
  .refine((name) => !name.includes("--"), "environment name must not contain a doubled hyphen")
  .refine(
    (name) => name !== "connectors",
    'environment name must not be "connectors" (reserved: it would read as the legacy deployment connector secrets, agentx/connectors/*)',
  )
  // The placeholder itself ("qqenv-phldrqq") must still parse, because
  // environmentNaming(ENVIRONMENT_PLACEHOLDER) has to work; every other name containing "qqenv" is
  // refused so no real environment can collide with the reserved placeholder. templates.ts is not
  // imported here (it would create a cycle); the literal is duplicated and pinned by tests instead.
  .refine(
    (name) => name === "qqenv-phldrqq" || !name.includes("qqenv"),
    'environment name must not contain "qqenv" (reserved for published templates)',
  );

export const DEFAULT_ENVIRONMENT = "production";

/** Cognito refuses hosted UI domain prefixes containing these words. */
const RESERVED_COGNITO_DOMAIN_WORDS = ["aws", "amazon", "cognito"];

/**
 * Throws if `env` cannot be used for a Cognito hosted UI domain prefix. Called both at synth time
 * (IdentityStack, so a bad name fails fast for a direct per-environment synth) and by
 * renderTemplate for any template containing a Cognito user pool domain (so a name that only the
 * once-synthesized placeholder template ever saw still gets checked before install, instead of
 * failing later at deploy).
 */
export function assertCognitoDomainSafe(env: string): void {
  const reserved = RESERVED_COGNITO_DOMAIN_WORDS.find((word) => env.includes(word));
  if (reserved !== undefined) {
    throw new Error(`environment name ${env} cannot be used for the Cognito domain (it contains "${reserved}"); choose another name or bring your own OIDC`);
  }
}

export type StackPart = "access" | "foundation" | "identity" | "runtime" | "control-plane" | "slack";

/** In deploy order. */
export const STACK_PARTS: readonly StackPart[] = ["access", "foundation", "identity", "runtime", "control-plane", "slack"];

function checked(env: string): string {
  const parsed = EnvironmentNameSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment name ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export function environmentStackName(env: string, part: StackPart): string {
  return `${RESOURCE_PREFIX}-${checked(env)}-${part}`;
}

export function environmentSettingsPrefix(env: string): string {
  return `/${RESOURCE_PREFIX}/${checked(env)}/`;
}

export function environmentConnectorSecretPrefix(env: string): string {
  return `${RESOURCE_PREFIX}/${checked(env)}/connectors/`;
}

/**
 * What a named environment's Lambda functions can derive from its name, so that no environment variable has to carry it (a function's
 * variables, keys and values together, are held to 4 KB, and the broker's were over it). The infrastructure and the broker both take
 * these from here, so the value a resource is created with and the one the code looks for cannot drift apart.
 */
/** The CloudWatch namespace the environment's metrics are published in. */
export function environmentMetricsNamespace(env: string): string {
  return `${METRICS_NAMESPACE_ROOT}/${checked(env)}`;
}

/** The prefix of the environment's alarm names (`rovara-cloud-<env>-` plus the suffix). */
export function environmentAlarmPrefix(env: string): string {
  return `${RESOURCE_PREFIX}-${checked(env)}-`;
}

/** The runtime catalog the environment's project setup records are admitted under. */
export function environmentProjectSetupRuntimeCatalogId(env: string): string {
  return `${RESOURCE_PREFIX}-${checked(env)}-project-setup-runtime-v1`;
}

/** The runtime catalog the environment's end-to-end feature rounds are admitted under. */
export function environmentE2eFeatureRuntimeCatalogId(env: string): string {
  return `${RESOURCE_PREFIX}-${checked(env)}-e2e-mock-runtime-v1`;
}

/** ECR pull-through cache rule prefix for `env`'s access stack. */
export function environmentPullThroughPrefix(env: string): string {
  return `${RESOURCE_PREFIX}-${checked(env)}`;
}

/** The role CloudFormation assumes to deploy `env`'s stacks. */
export function environmentCloudFormationRoleName(env: string): string {
  return `${RESOURCE_PREFIX}-${checked(env)}-cloudformation`;
}

/** The role an operator assumes to run `agentx` against `env`. */
export function environmentOperatorRoleName(env: string): string {
  return `${RESOURCE_PREFIX}-${checked(env)}-operator`;
}
