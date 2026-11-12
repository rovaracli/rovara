/**
 * The names and variables a Lambda function builds at run time instead of being given them (ENV-ROOM, owner decision 2026-10-24).
 *
 * Lambda holds all of a function's environment variables, keys and values together, to 4 KB, and the broker's reached the ceiling again and again. A value the function can
 * compute is not passed: a resource with a fixed name under the `agentx-<env>-...` naming, or a value the environment's name decides, is built from the environment's name
 * (AGENTX_ENV), the region (AWS_REGION) and the account (AGENTX_ACCOUNT_ID). This module is the ONE place such a derivation is written:
 *  - CDK names the resource with these functions (`auditIntakeQueueName` for the queue, `connectorSecretsRoleName` for the role, and so on), so a resource cannot be named
 *    one way and looked for another;
 *  - the broker (`hydrateBrokerEnvironment`, packages/broker/src/aws/broker-environment.ts) builds each variable of DERIVED_BROKER_VARIABLES from the same functions;
 *  - tests/contract/derived-names.test.ts synthesizes the named templates and checks that each role and queue in the table is the resource CDK created.
 *
 * Adding a Lambda setting: if the function can derive it, add an entry here (and name the resource with the function); do not add an environment variable. Only a true input
 * (a feature flag, a parameter, a generated name or id) is passed: see AGENTX_NAMES and AGENTX_SETTINGS in broker-names.ts. tests/contract/lambda-environment-size.test.ts
 * holds the broker to 400 bytes of room under its ceiling, so a variable that is added anyway fails there.
 */
import { environmentAlarmPrefix, environmentConnectorSecretPrefix, environmentE2eFeatureRuntimeCatalogId, environmentMetricsNamespace, environmentProjectSetupRuntimeCatalogId, environmentSettingsPrefix } from "@rovara-code/contracts";
import { brokerRoleName, chainScheduleQueueName, chainScheduleRoleName, connectorSecretsRoleName, testAccountSecretsRoleName } from "./access-policies.js";

/** The audit ledger's intake queue (FIFO, one appender per org). The queue is created with this name, and the broker builds its URL from it. */
export function auditIntakeQueueName(env: string): string {
  return `agentx-${env}-audit-intake.fifo`;
}

/**
 * Team record (wire-team-record): the names of the record's storage under the `agentx-<env>-...` naming. CDK names the resources with these (infra/lib/team-record-wiring.ts) and the broker
 * builds the variables from the same functions, so nothing is passed. `TeamRecordStorage` appends `-record-vectors`, `-record-lake` and `-record` to the prefix.
 */
export const teamRecordNamePrefix = (env: string): string => `agentx-${env}`;
export const teamRecordTableName = (env: string): string => `agentx-${env}-team-record`;
export const teamRecordOpsQueueName = (env: string): string => `agentx-${env}-team-record-ops`;
/** The durable queue's redrive limit (CDK sets it; the consumer drops a text-carrying put at this delivery instead of letting it be dead-lettered with its text). */
export const TEAM_RECORD_OPS_MAX_RECEIVES = 5;
/** A queued put (it holds text) is dropped unapplied once it is older than this, so its text does not wait for a consumer past a day. */
export const TEAM_RECORD_QUEUED_PUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const teamRecordOpsDeadLetterName = (env: string): string => `agentx-${env}-team-record-ops-dead`;
/**
 * Lessons in production (lane 2, WB-4): the queue a finished task's reflection waits in (ids only: org, task, outcome, request), its dead-letter queue, and the worker that runs it. CDK names the queue and
 * the worker with these (infra/lib/team-record-wiring.ts) and the broker builds the queue's URL from the same function, so no environment variable is passed.
 */
export const lessonsReflectQueueName = (env: string): string => `agentx-${env}-lessons-reflect`;
export const lessonsReflectDeadLetterName = (env: string): string => `agentx-${env}-lessons-reflect-dead`;
export const LESSONS_WORKER_RESERVED_CONCURRENCY = 2;
export const teamRecordVectorBucketName = (env: string): string => `${teamRecordNamePrefix(env)}-record-vectors`;
export const teamRecordTableBucketName = (env: string): string => `${teamRecordNamePrefix(env)}-record-lake`;
export const teamRecordWorkGroupName = (env: string): string => `${teamRecordNamePrefix(env)}-record`;
/** The embedder Lambda (environments/embedder; a container image). CDK names the function with this, and the broker builds EMBEDDER_FUNCTION_NAME from it, so nothing is passed. */
export const embedderFunctionName = (env: string): string => `agentx-${env}-embedder`;
/**
 * The company image mirror Lambda (0.5.15, switch `pj`). CDK names the function with this (infra/lib/company-image-mirror.ts) and the broker builds COMPANY_IMAGE_MIRROR_FUNCTION_NAME from it, so
 * nothing is passed: the generated name that was passed in AGENTX_NAMES (code `cm`) cost 68 bytes of the broker's 4 KB environment and took the Team record's headroom under its 400.
 */
export const companyImageMirrorFunctionName = (env: string): string => `agentx-${env}-company-image-mirror`;

/**
 * Test services, slice 3: the alias of the key the answer sets (fakes) are encrypted with (SSE-KMS accepts an alias). CDK names the key's alias with this; the broker builds the alias ARN from it, so no variable is passed
 * (M4: 40 bytes of Lambda environment saved). The broker's grant is on the key itself, not on the alias: an alias repointed at another key gives the broker nothing there, and the broker's writes fail instead of going elsewhere.
 */
export const fixtureKeyAlias = (env: string): string => `alias/agentx/${env}/fixtures`;

/**
 * 0.5.15 signing-key lane: the two secrets a named environment's functions read their keys from (packages/broker/src/aws/signing-key-secrets.ts), so no key is a Lambda variable.
 *  - the callback signing key signs short-lived tokens (worker callbacks, repository grants, cancel and setup tokens); it can be rotated (docs/runbooks/rotate-callback-signing-key.md);
 *  - the erasure hash key hashes stored values (erased people's names and aliases, Ask question hashes); it is never rotated without a re-hash plan, because the stored hashes would no longer match.
 * The deploy (packages/cli/src/deploy/signing-key.ts) creates both, never CloudFormation, so a stack update or deletion never changes or deletes either value. CDK grants each function the one it needs.
 * The named control-plane template no longer declares the NoEcho CallbackSigningKey parameter and the CLI no longer passes it (both dropped in 0.5.15); only the legacy install's frozen template keeps it.
 */
export const callbackSigningKeySecretName = (env: string): string => `agentx/${env}/callback-signing-key`;
export const erasureHashKeySecretName = (env: string): string => `agentx/${env}/erasure-hash-key`;

/** The port the model proxy's inference listener serves on; the broker builds the proxy's URL from the load balancer's name and this. */
export const MODEL_PROXY_INFERENCE_PORT = 4000;

/**
 * A variable the broker builds, by what it is:
 *  - `text`: a string the environment's name decides;
 *  - `roleArn`: the ARN of a role with a fixed name, in the environment's role path (`/agentx/<env>/`);
 *  - `queueUrl`: the URL of a queue with a fixed name.
 * `cloudOnly`: built only on the hosted cloud (AGENTX_CLOUD is "true"), the one condition under which the control plane creates the resource.
 */
export type DerivedBrokerVariable =
  | { readonly variable: string; readonly kind: "text"; readonly value: (env: string) => string; readonly cloudOnly?: true }
  | { readonly variable: string; readonly kind: "roleArn"; readonly roleName: (env: string) => string; readonly cloudOnly?: true }
  | { readonly variable: string; readonly kind: "queueUrl"; readonly queueName: (env: string) => string; readonly cloudOnly?: true }
  /** The ARN (`arn:<partition>:kms:<region>:<account>:<alias>`) of a KMS alias with a fixed name. */
  | { readonly variable: string; readonly kind: "kmsAliasArn"; readonly alias: (env: string) => string; readonly cloudOnly?: true };

export const DERIVED_BROKER_VARIABLES: readonly DerivedBrokerVariable[] = [
  { variable: "CONNECTOR_SECRET_PREFIX", kind: "text", value: environmentConnectorSecretPrefix },
  { variable: "SWEBENCH_SETTINGS_PREFIX", kind: "text", value: environmentSettingsPrefix },
  // M1.4 Task 4.10 (PREFIXGAP): where the installation's worker settings are, so the AI navigation route can be derived. Mainline passed it as a variable; here the broker builds it from the environment's name (ENV-ROOM).
  { variable: "AGENTX_E2E_AGENT_SETTINGS_PREFIX", kind: "text", value: environmentSettingsPrefix },
  { variable: "AGENTX_ALARM_PREFIX", kind: "text", value: environmentAlarmPrefix },
  { variable: "AGENTX_METRICS_NAMESPACE", kind: "text", value: environmentMetricsNamespace },
  { variable: "AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID", kind: "text", value: environmentProjectSetupRuntimeCatalogId },
  { variable: "AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID", kind: "text", value: environmentE2eFeatureRuntimeCatalogId },
  // Plan 4 Task 26: the role the scheduler assumes and the queue its failed invocations go to.
  { variable: "CHAIN_SCHEDULE_ROLE_ARN", kind: "roleArn", roleName: chainScheduleRoleName },
  { variable: "CHAIN_SCHEDULE_QUEUE_URL", kind: "queueUrl", queueName: chainScheduleQueueName },
  // The Audit Ledger's intake queue (named environments only: the legacy install has no ledger).
  { variable: "AUDIT_INTAKE_QUEUE_URL", kind: "queueUrl", queueName: auditIntakeQueueName },
  // The broker's own role (the hosted cloud only): the principal a customer's trust policy names for the CloudWatch connector's cross-account assume (Plan 4 Task 16).
  { variable: "BROKER_ROLE_ARN", kind: "roleArn", roleName: brokerRoleName, cloudOnly: true },
  // The one role the broker assumes for an org's connection secrets.
  { variable: "CONNECTOR_SECRETS_ROLE_ARN", kind: "roleArn", roleName: connectorSecretsRoleName },
  // Test services TS26: the role the broker assumes for a customer test account's secret. Derived like the connector role; nothing reads it while `ta` is off.
  { variable: "TEST_ACCOUNT_SECRETS_ROLE_ARN", kind: "roleArn", roleName: testAccountSecretsRoleName },
  // Team record: set in the process (not in Lambda's configuration) for every named environment; the record does nothing unless TEAM_RECORD_ENABLED is "1".
  { variable: "TEAM_RECORD_TABLE_NAME", kind: "text", value: teamRecordTableName },
  { variable: "TEAM_RECORD_VECTOR_BUCKETS", kind: "text", value: teamRecordVectorBucketName },
  { variable: "TEAM_RECORD_TABLE_BUCKET", kind: "text", value: teamRecordTableBucketName },
  { variable: "TEAM_RECORD_ATHENA_WORKGROUP", kind: "text", value: teamRecordWorkGroupName },
  { variable: "EMBEDDER_FUNCTION_NAME", kind: "text", value: embedderFunctionName },
  { variable: "COMPANY_IMAGE_MIRROR_FUNCTION_NAME", kind: "text", value: companyImageMirrorFunctionName },
  // Test services, slice 3: the answer sets' key, by its alias (named environments only: the legacy install has no AGENTX_ENV and no key). Nothing reads it while `tx` is off.
  { variable: "FIXTURE_KEY_ARN", kind: "kmsAliasArn", alias: fixtureKeyAlias },
];
