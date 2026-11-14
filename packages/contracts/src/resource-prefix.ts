/**
 * The one place the AWS-side name of Rovara Cloud is written. Every resource a named environment owns is named under it: stacks
 * (`rovara-cloud-<env>-<part>`), settings and secrets (`/rovara-cloud/<env>/...`, `rovara-cloud/<env>/...`), the IAM path
 * (`/rovara-cloud/<env>/`), roles, queues, alarms, budgets and tags (`rovara-cloud:env`).
 *
 * Rovara was called AgentX, and environments installed before 0.7.0 were named under `agentx`. This code does not read or upgrade
 * them (owner decision 2026-11-14: new names only). The legacy deployment, which has no environment name and `AgentX*` stacks,
 * keeps its own names. This module imports nothing, so any contracts module can use it without a cycle.
 */
export const RESOURCE_PREFIX = "rovara-cloud";

/** The tag key every resource of an environment carries, valued with the environment's name. */
export const ENVIRONMENT_TAG_KEY = `${RESOURCE_PREFIX}:env`;

/** The root of an environment's CloudWatch metric namespace (`RovaraCloud/<env>`). */
export const METRICS_NAMESPACE_ROOT = "RovaraCloud";

/** The value of the `Application` tag on resources Rovara Cloud creates outside CloudFormation. */
export const APPLICATION_TAG_VALUE = "RovaraCloud";

/** The prefix a CodeBuild project's name must start with for the broker to start it. */
export const CODEBUILD_PROJECT_PREFIX = `${RESOURCE_PREFIX}-`;
