// The broker's environment is held to Lambda's 4 KB (final review C1), so the control plane does not give it what the code can build or
// derive: the names CloudFormation generated come as one JSON variable of names under two-letter codes, the dead-letter queues as names,
// and what an environment's name decides is derived. hydrateBrokerEnvironment puts each back under the variable the broker's code reads.
import { describe, expect, it } from "vitest";
import {
  BROKER_NAMES,
  BROKER_NAMES_VARIABLE,
  connectorSecretsRoleName,
  testAccountSecretsRoleName,
  environmentAlarmPrefix,
  environmentConnectorSecretPrefix,
  environmentE2eFeatureRuntimeCatalogId,
  environmentMetricsNamespace,
  environmentProjectSetupRuntimeCatalogId,
  environmentSettingsPrefix,
} from "@agentx/contracts";
import { environmentNaming } from "../../infra/lib/naming.js";
import { awsPartitionOf, brokerNamesFromEnvironment, hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";

const SCOPE = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging" };
const KEY_ID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const NAMES = {
  stateTable: "agentx-staging-control-plane-State1C20CC9A-1A2B3C4D5E6F7",
  artifactBucket: "agentx-staging-control-plane-artifacts82dd59a1-1a2b3c4d5e6f",
  launchTemplate: "lt-0123456789abcdef0",
  projectAllowList: "rslvr-fdl-0123456789abcdef",
  modelProxy: "internal-agentx-staging-proxy-1234567890",
  auditLedgerTable: "agentx-staging-control-plane-AuditLedgerAuditLedgerTableC60B8D3B-1A2B3C4D5E6F7",
  auditSealsTable: "agentx-staging-control-plane-AuditLedgerAuditSealsTableF2EABAF8-1A2B3C4D5E6F7",
  auditKeysTable: "agentx-staging-control-plane-AuditLedgerAuditKeysTableF5520AEA-1A2B3C4D5E6F7",
  auditExportsBucket: "agentx-staging-control-plane-auditledgerauditexportsbucketde99c-1a2b3c4d5e6f",
  auditExportFunction: "agentx-staging-control-plane-AuditLedgerAuditExportED90D71C-1A2B3C4D5E6F7",
  auditVaultKey: KEY_ID,
  signInTable: "agentx-staging-control-plane-DeveloperSignInTable26CE739E-1A2B3C4D5E6F7",
  identityFunction: "agentx-staging-control-plane-DeveloperSignInFunction10B62B05-1A2B3C4D5E6F7",
  slackThreadsTable: "agentx-staging-control-plane-SlackThreads36E14C1E-1A2B3C4D5E6F7",
  turnRecordsTable: "agentx-staging-control-plane-TurnRecords69ECFCD9-1A2B3C4D5E6F7",
  planEvidenceFunction: "agentx-staging-control-plane-PlanEvidence3615C4CB-1A2B3C4D5E6F7",
  modelAccessFunction: "agentx-staging-control-plane-ModelAccessFunction1B50ECC9-1A2B3C4D5E6F7",
  dispatcherFunction: "agentx-staging-control-plane-Dispatcher6C5A7D1F-1A2B3C4D5E6F7",
  slackRequestQueue: "agentx-staging-control-plane-SlackRequestQueueCC82C864-1A2B3C4D5E6F7",
  slackOrchestratorRole: "agentx-staging-control-plane-SlackOrchestratorTaskRole2372FE40-1A2B3C4D5E6F7",
  // wire-team-record: present only in an install synthesised with the Team record switched on.
  teamRecordVectorsRole: "agentx-staging-control-plane-TeamRecordVectorsDataRole8A1B2C3D-1A2B3C4D5E6F7",
  teamRecordKmsKey: "1a2b3c4d-4e5f-6789-abcd-ef0123456789",
  savedEnvKey: "1a2b3c4d-4e5f-6789-abcd-ef0123456789",
  fixtureKey: "1a2b3c4d-4e5f-6789-abcd-ef0123456789",
  chatGptConnectionKey: "1a2b3c4d-4e5f-6789-abcd-ef0123456789",
  provisionerStateMachine: "agentx-staging-control-plane-SessionsProvisioner9C44055B-1A2B3C4D5E6F7",
  deleterStateMachine: "agentx-staging-control-plane-SessionsDeleterB48741EA-1A2B3C4D5E6F7",
  cloudUserPool: "us-west-2_AbCdEfGhI",
  signInApi: "abcdefghij",
  realtimeApi: "klmnopqrst",
  dispatchDeadLetters: "agentx-staging-control-plane-DispatchDeadLetterQueue3E30F4B8-1A2B3C4D5E6F7",
  slackRequestDeadLetters: "agentx-staging-control-plane-SlackDeadLetterQueue8D1F2C3B-1A2B3C4D5E6F7",
  developerNoticeDeadLetters: "agentx-staging-control-plane-DeveloperTaskNotifierDeadLetters5A6B7C8D-1A2B3C4D5E6F7",
  developerNoticeStreamFailures: "agentx-staging-control-plane-DeveloperTaskNotifierStreamFailures9E8D7C6B-1A2B3C4D5E6F7",
} as const satisfies Record<keyof typeof BROKER_NAMES, string>;

const bag = (names: Partial<Record<keyof typeof BROKER_NAMES, string>> = NAMES) =>
  JSON.stringify(Object.fromEntries(Object.entries(names).map(([key, value]) => [BROKER_NAMES[key as keyof typeof BROKER_NAMES].code, value])));
const hydrated = (env: MutableEnvironment): MutableEnvironment => { const copy = { ...env }; hydrateBrokerEnvironment(copy); return copy; };

describe("the table of names", () => {
  it("has a distinct two-letter code and a distinct variable for each name", () => {
    const specs = Object.values(BROKER_NAMES);
    expect(new Set(specs.map((spec) => spec.code)).size).toBe(specs.length);
    // One variable apiece, except the dead-letter queues, which are listed together for the health route.
    const variables = specs.filter((spec) => spec.kind !== "deadLetterQueue").map((spec) => spec.variable);
    expect(new Set(variables).size).toBe(variables.length);
    expect(new Set(specs.filter((spec) => spec.kind === "deadLetterQueue").map((spec) => spec.variable))).toEqual(new Set(["HEALTH_DEAD_LETTER_QUEUES"]));
    expect(new Set(specs.filter((spec) => spec.kind === "deadLetterQueue").map((spec) => spec.label)).size).toBe(4);
    for (const spec of specs) expect(spec.code).toMatch(/^[a-z]{2}$/);
  });
});

describe("awsPartitionOf", () => {
  it("names the partition a region belongs to", () => {
    expect(awsPartitionOf("us-west-2")).toBe("aws");
    expect(awsPartitionOf("eu-central-1")).toBe("aws");
    expect(awsPartitionOf("cn-north-1")).toBe("aws-cn");
    expect(awsPartitionOf("us-gov-west-1")).toBe("aws-us-gov");
    expect(awsPartitionOf("us-iso-east-1")).toBe("aws-iso");
    expect(awsPartitionOf("us-isob-east-1")).toBe("aws-iso-b");
  });
});

describe("hydrateBrokerEnvironment: the broker's own role", () => {
  it("builds the ARN of the broker's role from the environment's name on the hosted cloud, in the environment's role path, and on no other install", () => {
    const cloud = hydrated({ ...SCOPE, AGENTX_CLOUD: "true", [BROKER_NAMES_VARIABLE]: bag() });
    expect(cloud.BROKER_ROLE_ARN).toBe("arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-broker-role");
    expect(hydrated({ ...SCOPE, AGENTX_CLOUD: "true", [BROKER_NAMES_VARIABLE]: bag({ signInTable: "t" }) }).BROKER_ROLE_ARN).toBe("arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-broker-role");
    expect(hydrated({ ...SCOPE, AGENTX_CLOUD: "true", [BROKER_NAMES_VARIABLE]: bag(), BROKER_ROLE_ARN: "given" }).BROKER_ROLE_ARN).toBe("given");
  });

  it("is tied to the cloud flag the control plane sets with the broker's IAM grant (props.cloud and a named environment), not to the sign-in pool being present", () => {
    // The pool's presence does not decide it: no flag, no ARN, so no function builds a principal for a grant that does not exist.
    expect(hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: bag() }).BROKER_ROLE_ARN).toBeUndefined();
    expect(hydrated({ ...SCOPE, AGENTX_CLOUD: "false", [BROKER_NAMES_VARIABLE]: bag() }).BROKER_ROLE_ARN).toBeUndefined();
    expect(hydrated({ ...SCOPE, AGENTX_CLOUD: "true" }).BROKER_ROLE_ARN).toBeUndefined(); // an unnamed install hydrates nothing
  });
});

describe("hydrateBrokerEnvironment: the names (AGENTX_NAMES)", () => {
  it("puts every name back under the variable the broker reads, and builds a URL or an ARN from the name and the region, the account and the environment", () => {
    const env = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: bag() });
    expect(env).toMatchObject({
      AUDIT_LEDGER_TABLE_NAME: NAMES.auditLedgerTable,
      AUDIT_SEALS_TABLE_NAME: NAMES.auditSealsTable,
      AUDIT_KEYS_TABLE_NAME: NAMES.auditKeysTable,
      AUDIT_EXPORTS_BUCKET_NAME: NAMES.auditExportsBucket,
      AUDIT_EXPORT_FUNCTION_NAME: NAMES.auditExportFunction,
      // Derived from the environment's name alone (DERIVED_BROKER_VARIABLES): the queue's name is fixed.
      AUDIT_INTAKE_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-audit-intake.fifo",
      STATE_TABLE_NAME: NAMES.stateTable,
      ARTIFACT_BUCKET_NAME: NAMES.artifactBucket,
      EC2_WORKER_LAUNCH_TEMPLATE_ID: NAMES.launchTemplate,
      AGENT_PROJECT_ALLOW_LIST_ID: NAMES.projectAllowList,
      MODEL_PROXY_URL: `http://${NAMES.modelProxy}.us-west-2.elb.amazonaws.com:4000`,
      AUDIT_VAULT_KEY_ARN: `arn:aws:kms:us-west-2:123456789012:key/${KEY_ID}`,
      DEVELOPER_SIGNIN_TABLE_NAME: NAMES.signInTable,
      DEVELOPER_IDENTITY_FUNCTION_NAME: NAMES.identityFunction,
      SLACK_THREADS_TABLE_NAME: NAMES.slackThreadsTable,
      TURN_RECORDS_TABLE_NAME: NAMES.turnRecordsTable,
      PLAN_EVIDENCE_FUNCTION_NAME: NAMES.planEvidenceFunction,
      MODEL_ACCESS_FUNCTION_NAME: NAMES.modelAccessFunction,
      // LA-1 (peek): the dispatcher's name becomes its function ARN.
      DISPATCHER_FUNCTION_ARN: `arn:aws:lambda:us-west-2:123456789012:function:${NAMES.dispatcherFunction}`,
      SLACK_REQUEST_QUEUE_URL: `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.slackRequestQueue}`,
      SLACK_ORCHESTRATOR_ROLE_ARN: `arn:aws:iam::123456789012:role/agentx/staging/${NAMES.slackOrchestratorRole}`,
      TEAM_RECORD_VECTORS_ROLE_ARN: `arn:aws:iam::123456789012:role/agentx/staging/${NAMES.teamRecordVectorsRole}`,
      CHATGPT_CONNECTION_KEY_ARN: "arn:aws:kms:us-west-2:123456789012:key/1a2b3c4d-4e5f-6789-abcd-ef0123456789",
      FIXTURE_KEY_ARN: "arn:aws:kms:us-west-2:123456789012:key/1a2b3c4d-4e5f-6789-abcd-ef0123456789",
      PROVISIONER_ARN: `arn:aws:states:us-west-2:123456789012:stateMachine:${NAMES.provisionerStateMachine}`,
      DELETER_ARN: `arn:aws:states:us-west-2:123456789012:stateMachine:${NAMES.deleterStateMachine}`,
    });
    // The sign-in issuers are built from the pool's and the API's ids, to the text the control plane has always passed.
    expect(env.DEVELOPER_CLOUD_ISSUER).toBe("https://cognito-idp.us-west-2.amazonaws.com/us-west-2_AbCdEfGhI");
    expect(env.DEVELOPER_TOKEN_ISSUER).toBe("https://abcdefghij.execute-api.us-west-2.amazonaws.com/v1/auth");
    // Plan 5 Task 8: the events API's HTTP endpoint is built from its id.
    expect(env.REALTIME_HTTP_ENDPOINT).toBe("https://klmnopqrst.appsync-api.us-west-2.amazonaws.com/event");
    // The dead-letter queues are listed for the health route as `{ label: URL }`, by the labels the route has always shown.
    expect(JSON.parse(env.HEALTH_DEAD_LETTER_QUEUES!)).toStrictEqual({
      dispatch: `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.dispatchDeadLetters}`,
      "slack-requests": `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.slackRequestDeadLetters}`,
      "developer-notices": `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.developerNoticeDeadLetters}`,
      "developer-notice-stream": `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.developerNoticeStreamFailures}`,
    });
    // wire-team-record: the record's operations queue's dead letters have a fixed name, so they are listed last and only where the record is switched on, without being passed (ENV-ROOM).
    expect(JSON.parse(hydrated({ ...SCOPE, TEAM_RECORD_ENABLED: "1", [BROKER_NAMES_VARIABLE]: bag() }).HEALTH_DEAD_LETTER_QUEUES!)).toStrictEqual({
      dispatch: `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.dispatchDeadLetters}`,
      "slack-requests": `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.slackRequestDeadLetters}`,
      "developer-notices": `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.developerNoticeDeadLetters}`,
      "developer-notice-stream": `https://sqs.us-west-2.amazonaws.com/123456789012/${NAMES.developerNoticeStreamFailures}`,
      "team-record": "https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-team-record-ops-dead",
    });
    expect(Object.keys(JSON.parse(hydrated({ ...SCOPE, TEAM_RECORD_ENABLED: "1", [BROKER_NAMES_VARIABLE]: bag() }).HEALTH_DEAD_LETTER_QUEUES!) as object).at(-1)).toBe("team-record");
    // Every name in the table came back under its variable.
    for (const spec of Object.values(BROKER_NAMES)) expect(env[spec.variable], spec.variable).toBeTruthy();
  });

  it("gives the same text for a key's ARN as CloudFormation does, in another partition's form too (the install's ChatGPT host id derives from it)", () => {
    const env = hydrated({ AWS_REGION: "cn-north-1", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", [BROKER_NAMES_VARIABLE]: bag({ slackRequestQueue: "q", auditVaultKey: KEY_ID, provisionerStateMachine: "sm" }) });
    expect(env.SLACK_REQUEST_QUEUE_URL).toBe("https://sqs.cn-north-1.amazonaws.com.cn/123456789012/q");
    expect(env.AUDIT_INTAKE_QUEUE_URL).toBe("https://sqs.cn-north-1.amazonaws.com.cn/123456789012/agentx-staging-audit-intake.fifo");
    expect(env.AUDIT_VAULT_KEY_ARN).toBe(`arn:aws-cn:kms:cn-north-1:123456789012:key/${KEY_ID}`);
    expect(env.PROVISIONER_ARN).toBe("arn:aws-cn:states:cn-north-1:123456789012:stateMachine:sm");
  });

  it("gives the API's address in the partition's own form (CloudFormation's ApiEndpoint)", () => {
    const env = hydrated({ AWS_REGION: "cn-north-1", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", [BROKER_NAMES_VARIABLE]: bag({ signInApi: "abcdefghij", cloudUserPool: "cn-north-1_AbCdEfGhI" }) });
    expect(env.DEVELOPER_TOKEN_ISSUER).toBe("https://abcdefghij.execute-api.cn-north-1.amazonaws.com.cn/v1/auth");
    // The pool's issuer is `.amazonaws.com` in every partition, as cloud-identity.ts writes it.
    expect(env.DEVELOPER_CLOUD_ISSUER).toBe("https://cognito-idp.cn-north-1.amazonaws.com/cn-north-1_AbCdEfGhI");
  });

  it("does not replace a variable that is set", () => {
    const env = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: bag({ signInTable: "from-names", dispatchDeadLetters: "q" }), DEVELOPER_SIGNIN_TABLE_NAME: "given", AGENTX_ALARM_PREFIX: "given-", HEALTH_DEAD_LETTER_QUEUES: "given" });
    expect(env.DEVELOPER_SIGNIN_TABLE_NAME).toBe("given");
    expect(env.AGENTX_ALARM_PREFIX).toBe("given-");
    expect(env.HEALTH_DEAD_LETTER_QUEUES).toBe("given");
  });

  it("holds only the names that were sent: a name that is not there leaves its variable unset", () => {
    const env = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: bag({ signInTable: "t" }) });
    expect(env.DEVELOPER_SIGNIN_TABLE_NAME).toBe("t");
    expect(env.MODEL_ACCESS_FUNCTION_NAME).toBeUndefined();
    expect(env.AUDIT_LEDGER_TABLE_NAME).toBeUndefined();
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", JSON.stringify(["a"])],
    ["a name that is not text", JSON.stringify({ st: 7 })],
    ["a name that is empty", JSON.stringify({ st: "" })],
    ["a name with a slash", JSON.stringify({ st: "a/b" })],
    ["a name with an ARN's colons", JSON.stringify({ st: "arn:aws:dynamodb:x:y:table/z" })],
  ])("refuses a list that is %s, so a broker that cannot name what it needs does not start", (_label, value) => {
    expect(() => hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: value })).toThrow(/AGENTX_NAMES/);
    expect(() => brokerNamesFromEnvironment({ [BROKER_NAMES_VARIABLE]: value })).toThrow(/AGENTX_NAMES/);
  });

  it("refuses to build a URL or an ARN without the region, the account (12 digits) or, for a role, the environment", () => {
    const only = (names: Partial<Record<keyof typeof BROKER_NAMES, string>>) => ({ [BROKER_NAMES_VARIABLE]: bag(names) });
    expect(() => hydrated({ AGENTX_ACCOUNT_ID: "123456789012", ...only({ slackRequestQueue: "q" }) })).toThrow(/AWS_REGION/);
    expect(() => hydrated({ AWS_REGION: "us-west-2", ...only({ slackRequestQueue: "q" }) })).toThrow(/AGENTX_ACCOUNT_ID/);
    expect(() => hydrated({ AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "12", ...only({ auditVaultKey: KEY_ID }) })).toThrow(/AGENTX_ACCOUNT_ID/);
    expect(() => hydrated({ AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", ...only({ slackOrchestratorRole: "r" }) })).toThrow(/AGENTX_ENV/);
  });

  it("changes nothing where AGENTX_NAMES is absent or empty (the legacy install passes its variables whole, and a test sets its own)", () => {
    const before = { AGENTX_ENV: "staging", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", STATE_TABLE_NAME: "state" };
    expect(hydrated(before)).toEqual(before);
    expect(hydrated({ ...before, [BROKER_NAMES_VARIABLE]: "" })).toEqual({ ...before, [BROKER_NAMES_VARIABLE]: "" });
    const bare = { STATE_TABLE_NAME: "state" };
    expect(hydrated(bare)).toEqual(bare);
  });
});

describe("hydrateBrokerEnvironment: what an environment's name decides", () => {
  it("is derived from AGENTX_ENV, by the functions the infrastructure creates the resource with", () => {
    const env = hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: "{}" });
    expect(env).toMatchObject({
      CONNECTOR_SECRET_PREFIX: environmentConnectorSecretPrefix("staging"),
      SWEBENCH_SETTINGS_PREFIX: environmentSettingsPrefix("staging"),
      AGENTX_ALARM_PREFIX: environmentAlarmPrefix("staging"),
      AGENTX_METRICS_NAMESPACE: environmentMetricsNamespace("staging"),
      AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID: environmentProjectSetupRuntimeCatalogId("staging"),
      AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: environmentE2eFeatureRuntimeCatalogId("staging"),
      // M1.4 PREFIXGAP, derived here and not passed (ENV-ROOM): where the installation's worker settings are.
      AGENTX_E2E_AGENT_SETTINGS_PREFIX: environmentSettingsPrefix("staging"),
    });
    expect([env.CONNECTOR_SECRET_PREFIX, env.SWEBENCH_SETTINGS_PREFIX, env.AGENTX_ALARM_PREFIX, env.AGENTX_METRICS_NAMESPACE]).toEqual(["agentx/staging/connectors/", "/agentx/staging/", "agentx-staging-", "AgentX/staging"]);
    expect([env.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID, env.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID]).toEqual(["agentx-staging-project-setup-runtime-v1", "agentx-staging-e2e-mock-runtime-v1"]);
  });

  it("names the connector secrets role the control plane creates for the environment, under the environment's role path", () => {
    expect(hydrated({ ...SCOPE, [BROKER_NAMES_VARIABLE]: "{}" }).CONNECTOR_SECRETS_ROLE_ARN).toBe("arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-connector-secrets");
    expect(() => hydrated({ AGENTX_ENV: "staging", AWS_REGION: "us-west-2", [BROKER_NAMES_VARIABLE]: "{}" })).toThrow(/AGENTX_ACCOUNT_ID/);
  });

  it("derives nothing without an environment name", () => {
    const env = hydrated({ ...SCOPE, AGENTX_ENV: "", [BROKER_NAMES_VARIABLE]: bag({ signInTable: "t" }) });
    expect(env.CONNECTOR_SECRET_PREFIX).toBeUndefined();
    expect(env.AGENTX_METRICS_NAMESPACE).toBeUndefined();
    expect(env.CONNECTOR_SECRETS_ROLE_ARN).toBeUndefined();
    expect(env.TEST_ACCOUNT_SECRETS_ROLE_ARN).toBeUndefined();
  });
});

describe("what the broker derives is what the infrastructure names", () => {
  for (const name of ["staging", "a", "live25d", "a1234567890123456789", "eu-prod"]) {
    it(`for the environment ${name}`, () => {
      const naming = environmentNaming(name);
      const env = hydrated({ AGENTX_ENV: name, AWS_REGION: "eu-west-1", AGENTX_ACCOUNT_ID: "123456789012", [BROKER_NAMES_VARIABLE]: "{}" });
      expect(env.CONNECTOR_SECRET_PREFIX).toBe(naming.connectorSecretPrefix);
      expect(env.SWEBENCH_SETTINGS_PREFIX).toBe(naming.ec2.workerSettingsPrefix);
      expect(env.AGENTX_ALARM_PREFIX).toBe(naming.alarmName(""));
      expect(env.AGENTX_METRICS_NAMESPACE).toBe(naming.metricsNamespace);
      expect(env.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe(`${naming.resourcePrefix}-project-setup-runtime-v1`);
      expect(env.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID).toBe(`${naming.resourcePrefix}-e2e-mock-runtime-v1`);
      expect(env.CONNECTOR_SECRETS_ROLE_ARN).toBe(`arn:aws:iam::123456789012:role/agentx/${name}/${connectorSecretsRoleName(name)}`);
      // Test services TS26: the test account secrets role is derived the same way.
      expect(env.TEST_ACCOUNT_SECRETS_ROLE_ARN).toBe(`arn:aws:iam::123456789012:role/agentx/${name}/${testAccountSecretsRoleName(name)}`);
    });
  }
});
