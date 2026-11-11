import { WebApp } from "./web-app.js";
import { CustomDomain } from "./custom-domain.js";
import { connectorSecretsPolicyStatements, connectorSecretsTrustPolicy } from "./connector-secrets-policy.js";
import { testAccountSecretsPolicyStatements, testAccountSecretsTrustPolicy } from "./test-account-secrets-policy.js";
import { checkedBrokerEnvironment } from "./private-mcp.js";
import { grantProviderKeySecrets } from "./model-keys.js";
import { mergeRoleStatementsOnSynth } from "./merge-role-statements.js";
import { EgressAlarms } from "./egress-alarms.js";
import { attachLessonsWorker, attachTeamRecord } from "./team-record-wiring.js";
import { attachSavedEnvImages } from "./saved-env-images.js";
import { attachServiceCatalogImages } from "./service-catalog-images.js";
import { attachProjectRegistries } from "./registry-wiring.js";
import type { RegistryDomain } from "./registry-access.js";
import type { TeamRecordContext } from "./team-record-edition.js";
import { ModelAccess } from "./model-access.js";
import { ModelProxy } from "./model-proxy.js";
import { bedrockClaudeModelIds, proxyGeographyForRegion } from "@agentx/model-runtime/catalog";
import { resolve } from "node:path";
import {
  ArnFormat,
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  Token,
  aws_apigatewayv2 as apigwv2,
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_destinations as lambdaDestinations,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { BROKER_SETTINGS, fixtureKeyAlias, SERVICE_CATALOG_REPOSITORIES, E2E_ARTIFACT_RETENTION_DAYS, EVIDENCE_RETENTION_DAYS, evidenceRetentionDays, evidenceRetentionSetting, E2E_ARTIFACT_RETENTION_TAG_KEY, E2E_ARTIFACT_RETENTION_TAG_VALUE, HEALTH_ALARM_SUFFIXES, chainScheduleGroupName, chainScheduleQueueName, chainScheduleRoleName, brokerRoleName, brokerManagedPolicyPath, modelAccessProbeRoleName, brokerManagedPolicyPrefix, connectorSecretsRoleName, testAccountSecretsRoleName, environmentE2eFeatureRuntimeCatalogId, environmentProjectSetupRuntimeCatalogId, INDEX_EXPIRY_ATTRIBUTE, WORKER_SETTING_PARAMETERS, WORKFLOW_DISPATCH_DUE_INDEX, WORKSPACE_PROJECT_INDEX, WORKSPACE_SESSION_STATE_INDEX } from "@agentx/contracts";
import { type AgentXNaming, legacyNaming } from "./naming.js";
import { grantEditionRecordRead } from "./edition-env.js";
import { DeveloperSignIn, developerSignInParameters } from "./developer-signin.js";
import { RealtimeEvents } from "./realtime.js";
import { TaskPersonProof } from "./task-person-proof.js";
import { DeveloperTaskNotifier } from "./developer-task-notifier.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { AuditLedger } from "./audit-ledger.js";
import { BrokerNames, BrokerSettings } from "./broker-names.js";
import { REQUALIFY_CONTEXT_KEY, REQUALIFY_DEFAULT_HOUR_UTC, RuntimeRequalify } from "./runtime-requalify.js";
import { swebenchNames } from "./swebench-eval.js";
import { SWEBENCH_DEPLOYMENT_MODE } from "./swebench-eval-definition.js";

const MAX_DISPATCH_ATTEMPTS = 5;
// Matches MAX_RECEIVE_COUNT in packages/slack-service, which reports the final attempt in the thread.
export const SLACK_MAX_RECEIVE_COUNT = 5;
// What the ingress Lambda may read of a turn record for the Details view (spec 014 FR-024):
// TURN_DETAILS_ATTRIBUTES in packages/contracts/src/slack-details.ts plus the table keys pk and sk
// (required). The byTime index keys exportPk and exportSk are not needed by this policy and carry no
// new data; they stay listed so a later projection that names them is not refused.
// A contract test keeps the two lists equal.
export const TURN_DETAILS_READ_ATTRIBUTES = [
  "pk", "sk", "exportPk", "exportSk",
  "eventId", "subject", "receivedAt", "requestedBy", "disposition", "durationMs", "model", "offeredTools", "calls",
  "callsTruncated", "emptyResponse", "usage", "usageError", "recordingErrors", "argumentsOmitted", "error", "expiresAt",
];

export interface ControlPlaneStackProps extends StackProps {
  naming?: AgentXNaming;
  /** The hosted Rovara cloud (agentxCloud context): adds the self-serve Cognito sign-in. Named environments only. */
  cloud?: boolean;
  /**
   * The region this environment installs in (the agentxRegion context; us-east-1 when unset, as for the other stacks). This stack
   * itself is region-agnostic, so the model proxy's inference-profile geography is derived from this (ruling R52).
   */
  deploymentRegion?: string;
  /**
   * Whether the broker role's statements that differ only in resources or only in actions are merged (default true in a named
   * environment; a legacy install keeps its recorded template). Only a test turns it off, to compare the permissions before and after.
   */
  mergeBrokerStatements?: boolean;
  /**
   * Whether the audit ledger's functions reserve Lambda concurrency (default true; the agentxReservedConcurrency context).
   * Off only for an account whose concurrency limit is too low to reserve any.
   */
  reservedConcurrency?: boolean;
  /** Enterprise installs: the ranges the model proxy and the model access function may reach over HTTPS (never the whole internet). Absent: as before. */
  privateEgressCidrs?: readonly string[];
  /** Enterprise installs that turned company model endpoints on (N8): the model access function may read secrets named under `rovara/model-endpoints/`. Absent: it may not. */
  customModelEndpoints?: boolean;
  /** With `customModelEndpoints`: the environment the access function judges endpoint addresses with, and the private ranges the model proxy may reach over HTTPS besides `privateEgressCidrs`. */
  customModelEndpointEnvironment?: Readonly<Record<string, string>>;
  modelEndpointCidrs?: readonly string[];
  /** Enterprise installs: the model proxy runs LiteLLM from the install's own ECR (loaded from the signed release bundle). Absent: the public image, as before. */
  bundledImages?: boolean;
  /** Extra environment variables for the broker, from the install's own settings (the private MCP ranges, `privateMcpBrokerEnvironment`). Absent: none. */
  brokerEnvironment?: Readonly<Record<string, string>>;
  /** QA6-10: the release this deploy carries (`-c agentxReleaseVersion=0.5.8`), told to the broker as AGENTX_RELEASE_VERSION (the variable the health route already reads) so the app can show it. Absent: the broker has none, and the templates are unchanged. */
  releaseVersion?: string;
  /**
   * Team record (wire-team-record): the parameters of the record's storage, present ONLY when the install is synthesised with `agentxTeamRecord=enabled`. Absent (the default), nothing of
   * the record is created and the templates are unchanged. Named environments only (checked by `parseTeamRecordSwitch`).
   */
  teamRecord?: TeamRecordContext;
  /** Saved environment images (SH22): Enterprise may bring its own KMS key (`rovaraSavedEnvKmsKeyArn`); `registryScan: true` turns on the registry-wide basic scan-on-push setting (`agentxSavedEnvRegistryScan=on`; off by default: it replaces an existing registry setting). */
  savedEnv?: { kmsKeyArn?: string; registryScan?: boolean };
  /** N9 (INTG2): the CodeArtifact domains a project's registries may name. Present ONLY when the install is synthesised with `rovaraCodeArtifactDomains`; absent (the default), nothing is granted and the switch is off. */
  registryDomains?: readonly RegistryDomain[];
}

/**
 * Issue 206: the alarms in this app the health probe would not read: each must be named
 * `<prefix><suffix>` with a suffix from HEALTH_ALARM_SUFFIXES. Every stack of a named app is the
 * same environment, and alarm names are plain strings (naming.alarmName).
 */
function unlistedAlarms(scope: Construct, prefix: string): string[] {
  const listed = new Set<string>(HEALTH_ALARM_SUFFIXES.map((suffix) => `${prefix}${suffix}`));
  return scope.node.root.node.findAll().flatMap((construct) => {
    // CloudWatch returns a composite alarm only to a DescribeAlarms grant on *, which the broker has not.
    if (construct instanceof cloudwatch.CfnCompositeAlarm) return [`the health probe cannot read composite alarm ${construct.node.path}`];
    if (!(construct instanceof cloudwatch.CfnAlarm)) return [];
    // The egress alarms (foundation stack, cloud installs) are named agentx-<env>-nat-egress-spike-<az> and
    // blocked-dns-spike; the probe's single-word suffixes cannot list them. They notify the alerts topic
    // and are not on the admin health route.
    if (construct.node.scopes.some((scope) => scope instanceof EgressAlarms)) return [];
    const name = construct.alarmName;
    if (name !== undefined && !Token.isUnresolved(name) && listed.has(name)) return [];
    return [`the health probe does not read alarm ${construct.node.path} (${String(name)}): name it ${prefix}<suffix> and add the suffix to HEALTH_ALARM_SUFFIXES`];
  });
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props?: ControlPlaneStackProps) {
    super(scope, id, props);
    const naming = props?.naming ?? legacyNaming();
    // The names the broker derives from the environment's name itself (@agentx/contracts), so a named environment's broker is not given them
    // (its variables are held to Lambda's 4 KB); the legacy install's resourcePrefix is "agentx-production", which it is given.
    const projectSetupRuntimeCatalogId = naming.env === undefined ? `${naming.resourcePrefix}-project-setup-runtime-v1` : environmentProjectSetupRuntimeCatalogId(naming.env);
    const e2eFeatureRuntimeCatalogId = naming.env === undefined ? `${naming.resourcePrefix}-e2e-mock-runtime-v1` : environmentE2eFeatureRuntimeCatalogId(naming.env);

    const oidcIssuer = new CfnParameter(this, "OidcIssuer", { type: "String" });
    const oidcAudience = new CfnParameter(this, "OidcAudience", { type: "String" });
    const callbackSigningKey = new CfnParameter(this, "CallbackSigningKey", {
      type: "String",
      noEcho: true,
      minLength: 32,
      description: "Random secret used to scope and authenticate worker callbacks",
    });
    const adminClaim = new CfnParameter(this, "AdminClaim", {
      type: "String",
      default: "cognito:groups",
    });
    const adminValues = new CfnParameter(this, "AdminValues", {
      type: "String",
      default: '["agentx-admin"]',
      description: "JSON string array of claim values that grant AgentX administrator access",
    });
    // A named environment's broker is given these two in its settings (BrokerSettings, ENV-ROOM), which are joined unescaped, so the parameter admits plain text only. The legacy install keeps them whole.
    const plainText = naming.env === undefined ? {} : { allowedPattern: "^[A-Za-z0-9._:-]{0,64}$" };
    const githubAppCredentialRef = new CfnParameter(this, "GitHubAppCredentialRef", {
      type: "String",
      default: "github-agentx-sdlc",
      ...plainText,
    });
    // No account or installation: the broker looks up the App's installation per repository owner (#123).
    // Empty: the broker reads the id from the private-key secret's appId. agentx init deploys the
    // control plane before it creates the GitHub App, so it has no id to pass yet.
    const githubAppId = new CfnParameter(this, "GitHubAppId", {
      type: "String",
      default: "",
      description: "GitHub App id; empty reads it from the private-key secret's appId",
      ...plainText,
    });
    const githubAppPrivateKeySecretArn = new CfnParameter(this, "GitHubAppPrivateKeySecretArn", {
      type: "String",
      description: "Complete Secrets Manager ARN containing the GitHub App private key PEM",
    });
    // Spec 025 phase 25a: declared on the stack itself so the names are exact; named environments only (R3).
    const signInParameters = naming.env === undefined ? undefined : developerSignInParameters(this);
    const taskPersonProofEnabled = naming.env === "agentxlivetest123" ? new CfnParameter(this, "TaskPersonProofEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Install the dedicated task person proof workload in the approved named TEST environment",
    }) : undefined;

    const state = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Retained: workspace and operation records must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
      // Spec 025 A6 (Q5, owner answer 2026-09-30): failure and usage index items expire by TTL in
      // named environments. Adding a TTL to an existing table is an in-place update. 25c note 2: the
      // sharing items, NOTICE and CHANNEL_OPERATION, expire on it too; they exist only in named
      // environments (D14). No other State item carries indexExpiresAt (a test pins the files that
      // name it). The legacy table stays as it is.
      ...(naming.env === undefined ? {} : { timeToLiveAttribute: INDEX_EXPIRY_ATTRIBUTE }),
    });

    const artifacts = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // M1.3 Task 3.7b, owner decision D4: a browser or API round's screenshots expire 30 days after they are written. A lifecycle filter matches the start of a key, and a screenshot's
      // key starts like every other private object's, so the rule matches the tag the broker puts on a screenshot and on nothing else. The bucket is not versioned: expiry deletes.
      // Named environments only: the legacy production template stays as it is.
      ...(naming.env === undefined ? {} : { lifecycleRules: [
        { id: "ExpireE2EScreenshots", expiration: Duration.days(E2E_ARTIFACT_RETENTION_DAYS), tagFilters: { [E2E_ARTIFACT_RETENTION_TAG_KEY]: E2E_ARTIFACT_RETENTION_TAG_VALUE } },
        // Proof and evidence P6: stored evidence expires by class, on the same tag key. evidence-short is video and trace (14 days by default); evidence-std is screenshots, API samples and output tails (30 days).
        // An Enterprise install sets the days with the `evidenceRetentionDays` context value ({"evidence-short": n, "evidence-std": n}); a value outside the allowed range is clamped, never refused, so a bad
        // setting cannot keep evidence longer than the maximum or expire it sooner than the minimum. The pack is tagged evidence-std as well, so it expires with the tails; erasing a person, archiving a project or closing a company deletes both at once (rovara-code/evidence-erase.ts).
        ...(["evidence-short", "evidence-std"] as const).map((retentionClass) => ({ id: retentionClass === "evidence-short" ? "ExpireEvidenceShort" : "ExpireEvidenceStd",
          expiration: Duration.days(evidenceRetentionDays(retentionClass, evidenceRetentionSetting(this.node.tryGetContext("evidenceRetentionDays"))?.[retentionClass] as number | undefined) ?? EVIDENCE_RETENTION_DAYS[retentionClass].default),
          // Prefix AND tag (S3 reads that as an `And` filter): another writer's object that happens to carry the tag, outside the private evidence keys, never matches (Opus review M1).
          prefix: "private/", tagFilters: { [E2E_ARTIFACT_RETENTION_TAG_KEY]: retentionClass } })),
        // NH-1: the nightly run's coverage maps (`nightly-maps/<company>/<project>/<digest>.json`) expire after 30 days; selection reads a map no older than 7 days, so nothing live is lost. Archiving a project or closing
        // a company deletes the prefix sooner (evidence-erase.ts).
        { id: "ExpireNightlyMaps", prefix: "nightly-maps/", expiration: Duration.days(30) },
      ] }),
      // Retained: the broker's operation artifacts must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const deadLetterQueue = new sqs.Queue(this, "DispatchDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const dispatchQueue = new sqs.Queue(this, "DispatchQueue", {
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: MAX_DISPATCH_ATTEMPTS },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.minutes(2),
    });

    const broker = packagedFunction(this, "Broker", "packages/broker/src/aws/broker.ts", {
      // A named environment's broker is given the State table's and the bucket's names in AGENTX_NAMES (BrokerNames, below), not as variables of their own: its variables are held to Lambda's 4 KB.
      ...(naming.env === undefined ? { STATE_TABLE_NAME: state.tableName, ARTIFACT_BUCKET_NAME: artifacts.bucketName } : {}),
      ...(naming.env === undefined ? { AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID: projectSetupRuntimeCatalogId, AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: e2eFeatureRuntimeCatalogId } : {}),
      OIDC_ISSUER: oidcIssuer.valueAsString,
      ADMIN_CLAIM: adminClaim.valueAsString,
      ADMIN_VALUES: adminValues.valueAsString,
      CALLBACK_SIGNING_KEY: callbackSigningKey.valueAsString,
      ...(naming.env === undefined ? { GITHUB_APP_CREDENTIAL_REF: githubAppCredentialRef.valueAsString, GITHUB_APP_ID: githubAppId.valueAsString } : {}),
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: githubAppPrivateKeySecretArn.valueAsString,
    });
    if (naming.env !== undefined) {
      BrokerSettings.of(broker).add("githubAppCredentialRef", githubAppCredentialRef.valueAsString);
      BrokerSettings.of(broker).add("githubAppId", githubAppId.valueAsString);
    }
    // Only the install's private MCP settings may be added here; any other name (a reserved variable) stops synth instead of being overwritten.
    for (const [name, value] of Object.entries(checkedBrokerEnvironment(props?.brokerEnvironment))) broker.addEnvironment(name, value);
    if (props?.releaseVersion !== undefined) broker.addEnvironment("AGENTX_RELEASE_VERSION", props.releaseVersion);
    if (naming.env !== undefined) {
      BrokerNames.of(broker).add("stateTable", state.tableName);
      BrokerNames.of(broker).add("artifactBucket", artifacts.bucketName);
      // Test services, slice 3: the answer sets (fakes) are objects under private/<company>/fixtures/ in the artifacts bucket, written with this key (SSE-KMS) and read back with it. Only the broker may use it, to
      // generate a data key and decrypt, and the grant is on this key alone. Retained like the bucket: the objects outlive a stack deletion and are unreadable without it. Named environments only.
      const fixtureKey = new kms.Key(this, "FixtureKey", {
        // The broker builds the key's alias ARN from the environment's name (fixtureKeyAlias, contracts/derived-names.ts) and passes nothing: S3 accepts an alias for SSE-KMS.
        alias: fixtureKeyAlias(naming.env),
        description: "Rovara: encrypts the answer sets (fakes) kept under private/<company>/fixtures/ in the artifacts bucket",
        enableKeyRotation: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      // Only through S3 in this region (kms:ViaService): the broker's grant cannot be used for a direct KMS call. (A grant on the key resource alone, not on the alias.)
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["kms:GenerateDataKey", "kms:Decrypt"], resources: [fixtureKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `s3.${Stack.of(this).region}.amazonaws.com` } },
      }));
    }
    // The merged control plane's broker policy is past CDK's 10,000-character inline limit, and CDK would move the overflow into a
    // managed policy, which the deploy's CloudFormation role may not create (R53). Merge same-shaped statements instead.
    // Then they move into named managed policies (agentx-<env>-broker-<group>, ruling M2): a role's inline policies are capped at 10,240
    // characters in total, and the deploy's CloudFormation role may create managed policies named agentx-* only.
    if (naming.env !== undefined && props?.mergeBrokerStatements !== false) {
      mergeRoleStatementsOnSynth(broker.role!, { managedPolicyPrefix: brokerManagedPolicyPrefix(naming.env), managedPolicyPath: brokerManagedPolicyPath(naming.env) });
    }
    state.grantReadWriteData(broker);
    artifacts.grantReadWrite(broker);
    // Enterprise foundations I-2: the broker checks its edition stamp against the install's retained edition record before it serves.
    if (naming.env !== undefined) grantEditionRecordRead(broker, naming.env);
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [githubAppPrivateKeySecretArn.valueAsString],
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${naming.connectorSecretPrefix}*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));
    // A rotated OAuth refresh token is written back to its own secret. Only secrets that
    // `agentx admin credential authorize` tagged for it are writable, never other connector secrets.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:PutSecretValue"],
      resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${naming.connectorSecretPrefix}*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      conditions: { StringEquals: { "secretsmanager:ResourceTag/agentx-writable": "refresh-token" } },
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
      resources: [this.formatArn({ service: "codebuild", resource: "project", resourceName: "agentx-*" })],
    }));
    // Owner decision 2026-11-03: the broker learns which of Rovara's catalog models the account has enabled in Amazon Bedrock (an agreement per model) so no default choice offers one it cannot call. One read-only action: it names
    // no resource type in the Service Authorization Reference (the runner's E2eModelDiscovery policy grants it the same way), reveals only a model's agreement and authorization status, and reaches no model or data. Named environments only (the model proxy is).
    if (naming.env !== undefined) {
      broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock:GetFoundationModelAvailability"], resources: ["*"] }));
    }
    // A named environment's broker derives its connector secret prefix from AGENTX_ENV (broker-environment.ts), so it is not given it.
    // A fixed name, so the default boundary's AssumeOrgRoles statement can name this role as one of the three that may be granted a cross-account assume.
    if (naming.env !== undefined) (broker.role!.node.defaultChild as iam.CfnRole).roleName = brokerRoleName(naming.env);
    // Plan 3, ruling R62: an org's connection keys and event hook secrets (agentx/<env>/org-connectors/<org>/... and
    // agentx/<env>/org-hooks/<org>/...) are readable only through this role, in a session the broker tags with the org.
    // The broker role may assume it and holds no Secrets Manager permission on those paths. Named environments only.
    if (naming.env !== undefined) {
      const connectorSecretsRole = new iam.CfnRole(this, "ConnectorSecretsRole", {
        // Fixed, so the default permissions boundary can name it as the one role the broker's bounded role may assume. It is created
        // under the environment path (the EnvironmentRolePath aspect sets it). The access stack's deploy role and boundary also name its
        // path-less ARN, for lookups and cleanup only: CloudFormation's lookup of a fixed-name role that does not exist yet is
        // authorized against that ARN (see fixedNameRoleLookupStatement).
        roleName: connectorSecretsRoleName(naming.env),
        description: "AgentX org connector and hook secrets: assumed by the broker with a rovara:org session tag, reaches only that org's secrets",
        assumeRolePolicyDocument: connectorSecretsTrustPolicy(broker.role!.roleArn),
        policies: [{
          policyName: "OrgConnectorSecrets",
          policyDocument: {
            Version: "2012-10-17",
            Statement: connectorSecretsPolicyStatements({ secretArnPrefix: `arn:${Aws.PARTITION}:secretsmanager:${Aws.REGION}:${Aws.ACCOUNT_ID}:secret:`, env: naming.env }),
          },
        }],
      });
      broker.addToRolePolicy(new iam.PolicyStatement({
        sid: "AssumeConnectorSecretsRole",
        actions: ["sts:AssumeRole", "sts:TagSession"],
        resources: [connectorSecretsRole.attrArn],
      }));
      // Test services TS26 (design 6.2): a customer test account's secret (agentx/<env>/org-test-accounts/<org>/...) is kept and read only through THIS role, in a session the broker tags with the org and a
      // purpose. The broker's own session (`store`) can write and never read a value; the session it mints for a sealed round's worker (`resolve`) reads one secret and writes nothing. The broker role
      // may assume it and holds no Secrets Manager permission on the path. The role exists whether or not the `ta` switch is on; no code assumes it while `ta` is off.
      const testAccountSecretsRole = new iam.CfnRole(this, "TestAccountSecretsRole", {
        roleName: testAccountSecretsRoleName(naming.env),
        description: "AgentX customer test account secrets: assumed by the broker with rovara:org and rovara:purpose session tags, reaches only that org's test account secrets",
        assumeRolePolicyDocument: testAccountSecretsTrustPolicy(broker.role!.roleArn),
        policies: [{
          policyName: "OrgTestAccountSecrets",
          policyDocument: {
            Version: "2012-10-17",
            Statement: testAccountSecretsPolicyStatements({ secretArnPrefix: `arn:${Aws.PARTITION}:secretsmanager:${Aws.REGION}:${Aws.ACCOUNT_ID}:secret:`, env: naming.env }),
          },
        }],
      });
      broker.addToRolePolicy(new iam.PolicyStatement({
        sid: "AssumeTestAccountSecretsRole",
        actions: ["sts:AssumeRole", "sts:TagSession"],
        resources: [testAccountSecretsRole.attrArn],
      }));
      // The role's ARN is not passed: the broker builds it from the environment, the region and the account, as the role's fixed name and path
      // are derived from the environment too (connectorSecretsRoleName, environmentRolePath).
      broker.addEnvironment("AGENTX_ENV", naming.env);
      broker.addEnvironment("AGENTX_ACCOUNT_ID", this.account);
    }
    // Plan 2, Task 19 (cloud installs): the broker keeps the DNS firewall's "ProjectAllowList" equal to the approved egress domains. The list lives
    // in the foundation stack; its id arrives the way the VPC's does, as a foundation output the deploy passes on as this parameter. The broker may
    // update and read that one list and nothing else in Route 53 Resolver, and no other role here has these actions.
    let projectAllowListArn: string | undefined;
    if (props?.cloud === true && naming.env !== undefined) {
      const projectAllowListId = new CfnParameter(this, "ProjectAllowListId", { type: "String", allowedPattern: "^rslvr-fdl-[0-9a-zA-Z]{8,32}$", description: "The foundation's DNS firewall project allow list (rule priority 150), which the broker updates with the approved egress domains" }).valueAsString;
      // An AWS-generated id, in the broker's names (BrokerNames; its variables are held to Lambda's 4 KB).
      BrokerNames.of(broker).add("projectAllowList", projectAllowListId);
      projectAllowListArn = this.formatArn({ service: "route53resolver", resource: "firewall-domain-list", resourceName: projectAllowListId });
      // A broker grant like the rest: it lives in the broker's managed policy group for its service (route53resolver falls in "integrations",
      // see brokerPolicyGroup), not in a policy of its own, so the broker role's inline and managed policies stay within the M2 size guard.
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["route53resolver:UpdateFirewallDomains", "route53resolver:GetFirewallDomainList"],
        resources: [projectAllowListArn],
      }));
    }
    // Plan 4, Task 16 (cloud installs): the CloudWatch connector assumes a role a customer made in their own AWS account. The grant is one action on roles in
    // OTHER accounts (never a role of this one, so the broker cannot reach its own or any other role here this way), and only with an external id that names a
    // Rovara org; the connector sends the caller org's own, and the customer's trust policy requires it. AWS documents sts:ExternalId as a request-context key
    // present whenever the caller supplies an external id (docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html); it does not say
    // in so many words that an identity policy is checked against it, so the external id the connector sets itself stays the control and this condition is a second one.
    // The statement falls in the broker's orchestration managed policy (an sts action), see brokerPolicyGroup. The role's own ARN is the principal the customer
    // names in the trust policy, so the function gets it.
    if (props?.cloud === true && naming.env !== undefined) {
      broker.addToRolePolicy(new iam.PolicyStatement({
        sid: "AssumeCustomerCloudWatchRoles",
        actions: ["sts:AssumeRole"],
        resources: [`arn:${Aws.PARTITION}:iam::*:role/*`],
        conditions: {
          StringNotEquals: { "aws:ResourceAccount": Aws.ACCOUNT_ID },
          StringLike: { "sts:ExternalId": "rovara-org_*" },
        },
      }));
      // The ARN is not passed: the role has a fixed name, so the broker builds it from AGENTX_ENV in the environment's role path, and only where this flag is set (the same condition as the grant above), so its
      // environment stays under Lambda's 4 KB.
      broker.addEnvironment("AGENTX_CLOUD", "true");
      // The web app's company admin console (Settings: models, people, budgets, health, how we work) is shown only where the broker lists "admin" in
      // WEB_FEATURES (app-nav/nav.ts; owners and admins only). The other names (usage, chains, describe) are placeholder pages and stay off.
      BrokerSettings.of(broker).add("webFeatures", "admin");
    }
    // Spec 043: SWE-bench runs. The broker reads the optional eval stack's settings, the runner image
    // and the worker model per request, and starts the eval state machine by its fixed name; both
    // exist only once the eval stack is deployed, and until then a run is refused as not installed.
    if (naming.env === undefined) broker.addEnvironment("SWEBENCH_SETTINGS_PREFIX", naming.ec2.workerSettingsPrefix);
    // M1.4 Task 4.10 (PREFIXGAP): the broker derives the AI navigation route from the installation's worker settings. A named environment's broker builds the settings prefix from its
    // environment name (AGENTX_E2E_AGENT_SETTINGS_PREFIX in DERIVED_BROKER_VARIABLES), so no variable is passed here (ENV-ROOM); the read grant below covers it. The legacy template stays as it is.
    const swebenchParameterArns = [
      swebenchNames(naming).settingsParameterName,
      swebenchNames(naming).runnerImageParameterName,
      swebenchNames(naming).runnerFeaturesParameterName,
      ...Object.values(WORKER_SETTING_PARAMETERS).map((name) => `${naming.ec2.workerSettingsPrefix}${name}`),
    ].map((name) => `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${name}`);
    // The eval batch tick reads the SWE-bench settings and the worker settings the deployment reads for an eval run, but never the AI navigation model setting (Task 4.10A review M-2) or the missing-key fallback model (Task 4.10D): it boots no worker and runs no model of its own.
    const evalSettingArns = [
      swebenchNames(naming).settingsParameterName,
      swebenchNames(naming).runnerImageParameterName,
      swebenchNames(naming).runnerFeaturesParameterName,
      ...Object.entries(WORKER_SETTING_PARAMETERS).filter(([key]) => key !== "e2eAgentModel" && key !== "modelFallback").map(([, name]) => `${naming.ec2.workerSettingsPrefix}${name}`),
    ].map((name) => `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${name}`);
    const swebenchStateMachineArn = this.formatArn({ service: "states", resource: "stateMachine", resourceName: swebenchNames(naming).stateMachineName, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameters"], resources: swebenchParameterArns }));
    broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:StartExecution"], resources: [swebenchStateMachineArn] }));

    // Spec 061: a stored plan's cited code is read from GitHub in the background, with retries, so a slow or failing
    // GitHub never holds up the plan. The broker starts the job right after the plan commits (an async invoke), and
    // its recovery sweep starts any row that is due; the job needs nothing from the broker. 150 seconds: the code is
    // read inside 120, and the rest is for attaching the bundle and cleaning up. 1,024 MB: files are read in memory.
    // Developer tasks, and so their plans, exist only in named environments; the legacy templates gain nothing.
    if (naming.env !== undefined) {
      const planEvidence = packagedFunction(this, "PlanEvidence", "packages/broker/src/aws/plan-evidence-handler.ts", {
        STATE_TABLE_NAME: state.tableName,
        ARTIFACT_BUCKET_NAME: artifacts.bucketName,
        GITHUB_APP_CREDENTIAL_REF: githubAppCredentialRef.valueAsString,
        GITHUB_APP_ID: githubAppId.valueAsString,
        GITHUB_APP_PRIVATE_KEY_SECRET_ARN: githubAppPrivateKeySecretArn.valueAsString,
        // The install's single org (ruling R3) derives from the environment name.
        AGENTX_ENV: naming.env,
        // Plan 2, Task 15: on the hosted cloud the job reads a task's code only while the task's org still holds the GitHub installation.
        ...(props?.cloud === true ? { AGENTX_CLOUD: "true" } : {}),
      }, Duration.seconds(150), [], 1024);
      // The State table, one action at a time, each on the partitions it needs (the sort key cannot be narrowed here):
      // reads of the task record, its evidence pointer, the job rows and the project revision the task started from; the
      // pointer is written with PutItem (DEVTASK#, put once, never the task record's workflow); the job row is claimed and
      // rescheduled with UpdateItem and removed with DeleteItem. No Query: the sweep runs in the broker.
      planEvidence.addToRolePolicy(new iam.PolicyStatement({
        sid: "ReadTaskJobAndProject",
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*", "PLAN_EVIDENCE", "ORG#*#PROJECT#*"] } },
      }));
      // The hosted cloud only: the org's GitHub installation binding, read (never written) before each token the job mints.
      if (props?.cloud === true) {
        planEvidence.addToRolePolicy(new iam.PolicyStatement({
          sid: "ReadGithubInstallationBinding",
          actions: ["dynamodb:GetItem"],
          resources: [state.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["GITHUB_INSTALLATION#*"] } },
        }));
      }
      planEvidence.addToRolePolicy(new iam.PolicyStatement({
        sid: "PutEvidencePointer",
        actions: ["dynamodb:PutItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*"] } },
      }));
      planEvidence.addToRolePolicy(new iam.PolicyStatement({
        sid: "ClaimAndCloseJobRow",
        actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PLAN_EVIDENCE"] } },
      }));
      // The plan is read back from its own folder, and the bundle is written only beside it.
      planEvidence.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadPlanDocuments", actions: ["s3:GetObject"], resources: [artifacts.arnForObjects("private/*")] }));
      planEvidence.addToRolePolicy(new iam.PolicyStatement({ sid: "WriteEvidenceBundles", actions: ["s3:PutObject"], resources: [artifacts.arnForObjects("private/*/plan-documents/*.evidence.*.json")] }));
      // The GitHub App's key, to read files as the broker does.
      planEvidence.addToRolePolicy(new iam.PolicyStatement({ sid: "GitHubAppKey", actions: ["secretsmanager:GetSecretValue"], resources: [githubAppPrivateKeySecretArn.valueAsString] }));
      planEvidence.grantInvoke(broker);
      if (naming.env === undefined) broker.addEnvironment("PLAN_EVIDENCE_FUNCTION_NAME", planEvidence.functionName);
      else BrokerNames.of(broker).add("planEvidenceFunction", planEvidence.functionName);
    }

    const outboxPublisher = packagedFunction(
      this,
      "OutboxPublisher",
      "packages/broker/src/aws/outbox-publisher.ts",
      {
        STATE_TABLE_NAME: state.tableName,
        DISPATCH_QUEUE_URL: dispatchQueue.queueUrl,
      },
    );
    // The install's single org (ruling R3) derives from the environment name; the legacy deployment's is "default".
    if (naming.env !== undefined) outboxPublisher.addEnvironment("AGENTX_ENV", naming.env);
    state.grantStreamRead(outboxPublisher);
    state.grantReadWriteData(outboxPublisher);
    dispatchQueue.grantSendMessages(outboxPublisher);
    // The State table's stream has two readers: this outbox publisher and, in named environments,
    // the DeveloperTaskNotifier (developer-task-notifier.ts). That is the per-shard maximum AWS
    // recommends: later phases (such as 25e's Slack Confirm DMs) add filters to an existing
    // trigger, never a third reader.
    new lambda.EventSourceMapping(this, "OutboxStreamMapping", {
      target: outboxPublisher,
      eventSourceArn: state.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      retryAttempts: 3,
      bisectBatchOnError: true,
    });

    const dispatcher = packagedFunction(
      this,
      "Dispatcher",
      "packages/broker/src/aws/dispatcher.ts",
      {
        STATE_TABLE_NAME: state.tableName,
        AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID: projectSetupRuntimeCatalogId,
        MAX_DISPATCH_ATTEMPTS: String(MAX_DISPATCH_ATTEMPTS),
        ARTIFACT_BUCKET_NAME: artifacts.bucketName,
      },
      Duration.seconds(60),
    );
    if (naming.env !== undefined) dispatcher.addEnvironment("AGENTX_ENV", naming.env);
    // The dispatcher takes a batch only from this queue (the broker may invoke it directly, for a peek, and nothing else): it checks the record's source ARN against this (S2).
    dispatcher.addEnvironment("DISPATCH_QUEUE_ARN", dispatchQueue.queueArn);
    if (naming.env !== undefined) {
      // Live interaction A2 (peek, for Ask): the broker invokes the dispatcher to read a running task's working tree. It is told the function's name (the broker builds the ARN, DISPATCHER_FUNCTION_ARN) and may invoke
      // this one function and no other. The dispatcher signs only a peek invocation it has parsed, and wakes no compute for one.
      BrokerNames.of(broker).add("dispatcherFunction", dispatcher.functionName);
      dispatcher.grantInvoke(broker);
    }
    dispatchQueue.grantConsumeMessages(dispatcher);
    state.grantReadWriteData(dispatcher);
    // The dispatcher holds a CHECKS reference's kind to the admission it names; it reads only the immutable admission objects.
    dispatcher.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [artifacts.arnForObjects("workflow-e2e-admissions/*")] }));
    // EC2 workers (#76): the idle reaper and reconciler find sessions by state through this sparse index.
    state.addGlobalSecondaryIndex({
      indexName: WORKSPACE_SESSION_STATE_INDEX.name,
      partitionKey: { name: WORKSPACE_SESSION_STATE_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: WORKSPACE_SESSION_STATE_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Spec 041: GET /v1/dev/workspaces lists a project's workspaces through this sparse index.
    // Only workspace META items carry `workspaceProject`, so nothing else is indexed.
    state.addGlobalSecondaryIndex({
      indexName: WORKSPACE_PROJECT_INDEX.name,
      partitionKey: { name: WORKSPACE_PROJECT_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: WORKSPACE_PROJECT_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Sparse due-time index: only received, retryable, or leased GitHub deliveries carry these keys.
    state.addGlobalSecondaryIndex({
      indexName: "github-webhook-recovery",
      partitionKey: { name: "webhookRecoveryPk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "webhookRecoverySk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Gap 6: sparse due-time index over workflow dispatch rows, so the recovery sweep reads due rows first.
    state.addGlobalSecondaryIndex({
      indexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
      partitionKey: { name: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: WORKFLOW_DISPATCH_DUE_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // The dispatcher signs each invocation to an EC2 worker; workers verify with the public key
    // alone (#80). Only the dispatcher may sign: the key policy denies kms:Sign to every other
    // principal, whatever its IAM policy grants.
    const invokeSigningKey = new kms.Key(this, "InvokeSigningKey", {
      alias: naming.ec2.invokeSigningKeyAlias,
      description: `Signs AgentX ${naming.environmentTagValue} invocations to EC2 workers`,
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: Duration.days(7),
      // Tokens live 60 seconds and workers get the public key at boot, so nothing outlives the key.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    invokeSigningKey.grant(dispatcher, "kms:Sign");
    invokeSigningKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "SignOnlyAsDispatcher",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["kms:Sign"],
      resources: ["*"],
      conditions: { ArnNotEquals: { "aws:PrincipalArn": dispatcher.role!.roleArn } },
    }));
    new CfnOutput(this, "InvokeSigningKeyArn", { value: invokeSigningKey.keyArn });

    new lambda.EventSourceMapping(this, "DispatchQueueMapping", {
      target: dispatcher,
      eventSourceArn: dispatchQueue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
    });

    const memberWorkspaceLimit = new CfnParameter(this, "SlackMemberWorkspaceLimit", {
      type: "Number",
      default: 3,
      minValue: 1,
      description: "Maximum Slack thread workspaces one channel member may start",
    });
    const organizationWorkspaceLimit = new CfnParameter(this, "SlackOrganizationWorkspaceLimit", {
      type: "Number",
      default: 20,
      minValue: 1,
      description: "Maximum Slack thread workspaces for the whole Slack organization",
    });
    // Operators store the real values with put-secret-value; the generated placeholder rejects every request until then.
    const slackSecret = new secretsmanager.Secret(this, "SlackSecret", {
      // Under environment naming, a fixed name under agentx/<env>/ so the operator role's secrets
      // scope covers it. The legacy deployment keeps its generated name.
      ...(naming.env === undefined ? {} : { secretName: `agentx/${naming.env}/slack` }),
      description: "AgentX Slack app credentials as JSON: {\"signingSecret\":\"...\",\"botToken\":\"xoxb-...\"}",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ botToken: "unset" }),
        generateStringKey: "signingSecret",
        excludePunctuation: true,
      },
      // Retained: the Slack app credentials must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const slackThreads = new dynamodb.Table(this, "SlackThreads", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      // Retained: Slack thread state must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const slackDeadLetterQueue = new sqs.Queue(this, "SlackRequestDeadLetterQueue", {
      fifo: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const slackRequestQueue = new sqs.Queue(this, "SlackRequestQueue", {
      fifo: true,
      contentBasedDeduplication: false,
      deadLetterQueue: { queue: slackDeadLetterQueue, maxReceiveCount: SLACK_MAX_RECEIVE_COUNT },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.minutes(15),
      retentionPeriod: Duration.days(4),
    });
    const threadSessions = new s3.Bucket(this, "SlackThreadSessions", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      // Retained: Pi thread sessions must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const slackOrchestratorRole = new iam.Role(this, "SlackOrchestratorTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: "Hosted AgentX Slack orchestrator; the only principal allowed on /v1/service routes",
    });
    slackRequestQueue.grantConsumeMessages(slackOrchestratorRole);
    // Spec 061 slice 2: "Ask AgentX to reply to this comment" on the task page queues the comment for the Slack service (send only).
    slackRequestQueue.grantSendMessages(broker);
    // A named environment's broker is given the queue's name (BrokerNames), not its URL: its variables are held to Lambda's 4 KB.
    if (naming.env === undefined) broker.addEnvironment("SLACK_REQUEST_QUEUE_URL", slackRequestQueue.queueUrl);
    else BrokerNames.of(broker).add("slackRequestQueue", slackRequestQueue.queueName);
    slackThreads.grantReadWriteData(slackOrchestratorRole);
    threadSessions.grantReadWrite(slackOrchestratorRole);
    slackSecret.grantRead(slackOrchestratorRole);
    // A named environment's orchestrator calls models through the model proxy, which alone has Bedrock access (Task 14).
    if (naming.env === undefined) {
      slackOrchestratorRole.addToPolicy(new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:${this.partition}:bedrock:*::foundation-model/*`,
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      }));
    }
    // One record per Slack event, kept 30 days for diagnosis and evaluation cases (feature 013 FR-025).
    // The broker reads it for the admin export. The ingress Lambda reads one record's non-text fields
    // for the Details view (spec 014), granted below. Nothing else can read it.
    const turnRecords = new dynamodb.Table(this, "TurnRecords", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      // Retained: turn records are audit data that must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    turnRecords.addGlobalSecondaryIndex({
      indexName: "byTime",
      partitionKey: { name: "exportPk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "exportSk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // The service writes each record once with a condition and never reads the table back.
    slackOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [turnRecords.tableArn],
    }));
    // The admin export pages the time index newest first; the broker needs nothing else on this table.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [turnRecords.tableArn, `${turnRecords.tableArn}/index/byTime`],
    }));
    if (naming.env === undefined) broker.addEnvironment("TURN_RECORDS_TABLE_NAME", turnRecords.tableName);
    else BrokerNames.of(broker).add("turnRecordsTable", turnRecords.tableName);

    // No subscription by default: the deployer subscribes an email address or connects AWS Chatbot.
    const operatorAlerts = new sns.Topic(this, "OperatorAlerts", {
      topicName: naming.alertsTopicName,
      displayName: "AgentX operator alerts",
      enforceSSL: true,
    });
    // enforceSSL leaves only a Deny in the topic policy, which replaces SNS's default same-account
    // Allow, so the alarms need their own grant to publish.
    operatorAlerts.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
      actions: ["sns:Publish"],
      resources: [operatorAlerts.topicArn],
      conditions: {
        StringEquals: { "aws:SourceAccount": this.account },
        ArnLike: { "aws:SourceArn": `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:*` },
      },
    }));
    // FR-047, environment naming only. AWS Budgets publishes the budget's notifications to the
    // same topic, so the topic policy must allow it (enforceSSL left only a Deny).
    if (naming.env !== undefined) {
      const budgetsTopicPublish = operatorAlerts.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [operatorAlerts.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:${this.partition}:budgets::${this.account}:*` },
        },
      }));
      const monthlyUsd = new CfnParameter(this, "BudgetMonthlyUsd", {
        type: "String", default: "0", allowedPattern: "^(0|[1-9][0-9]{0,6})$",
        description: "The environment's monthly AWS budget in US dollars; 0 means no budget",
      });
      const scope = new CfnParameter(this, "BudgetScope", {
        type: "String", default: "tag", allowedValues: ["tag", "account"],
        description: "tag: costs tagged agentx:env for this environment (the tag must be activated in Billing); account: the whole account",
      });
      const hasBudget = new CfnCondition(this, "HasBudget", { expression: Fn.conditionNot(Fn.conditionEquals(monthlyUsd.valueAsString, "0")) });
      const byTag = new CfnCondition(this, "BudgetByTag", { expression: Fn.conditionEquals(scope.valueAsString, "tag") });
      const notify = (type: "ACTUAL" | "FORECASTED", threshold: number) => ({
        notification: { notificationType: type, comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "SNS", address: operatorAlerts.topicArn }],
      });
      const budget = new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: naming.alarmName("monthly"),
          budgetType: "COST",
          timeUnit: "MONTHLY",
          // CloudFormation passes the parameter's string; the Budgets resource accepts it as its number.
          budgetLimit: { amount: Token.asNumber(monthlyUsd.valueAsString), unit: "USD" },
          costFilters: Fn.conditionIf(byTag.logicalId, { TagKeyValue: [`user:agentx:env$${naming.env}`] }, Aws.NO_VALUE),
        },
        notificationsWithSubscribers: [notify("ACTUAL", 80), notify("FORECASTED", 100)],
        // C5 / FR-047: every resource the installer creates carries agentx:env. AWS::Budgets::Budget
        // takes tags through ResourceTags rather than the stack's Tags.of(app), so it is set here
        // explicitly; Tags.of(app) does not reach this resource.
        resourceTags: [{ key: "agentx:env", value: naming.env }],
      });
      budget.cfnOptions.condition = hasBudget;
      // AWS Budgets creates the notification's SNS subscriber as part of creating the budget, so the
      // topic policy above must already allow budgets.amazonaws.com to publish before that happens;
      // otherwise the subscription confirmation publish could race ahead of the policy statement.
      if (budgetsTopicPublish.policyDependable !== undefined) budget.node.addDependency(budgetsTopicPublish.policyDependable);
    }
    const notifyOperator = new cloudwatchActions.SnsAction(operatorAlerts);
    // The broker publishes these in embedded metric format with a dimensionless series as well as a
    // per-connector one; the alarms read the dimensionless series, so they cover every connector.
    const agentxSum = (metricName: string, period: Duration) =>
      new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName, statistic: "Sum", period });
    // A named environment's broker derives its metrics namespace from AGENTX_ENV (broker-environment.ts), so it is not given it.
    new cloudwatch.Alarm(this, "ConnectorBrokenAlarm", {
      alarmName: naming.alarmName("ConnectorBroken"),
      alarmDescription: "A connector's discovery failed or a vendor changed an approved tool's schema. Check the broker logs for connector metrics and connector.* events.",
      metric: new cloudwatch.MathExpression({
        expression: "FILL(discovery, 0) + FILL(drift, 0)",
        usingMetrics: {
          discovery: agentxSum("ConnectorDiscoveryFailed", Duration.minutes(5)),
          drift: agentxSum("ConnectorSchemaDrift", Duration.minutes(5)),
        },
        period: Duration.minutes(5),
        label: "Connector discovery failures and schema drift",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    new cloudwatch.Alarm(this, "ConnectorNotConnectedAlarm", {
      alarmName: naming.alarmName("ConnectorNotConnected"),
      alarmDescription: "A connector's vendor credential is missing, revoked or rejected. Check the broker logs for the connector, then reconnect it with agentx connectors.",
      metric: agentxSum("ConnectorNotConnected", Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    new cloudwatch.Alarm(this, "EmptyResponsesAlarm", {
      alarmName: naming.alarmName("EmptyResponses"),
      alarmDescription: "More than three orchestrator turns in an hour ended without text. Export recent turns with agentx admin turns export.",
      metric: agentxSum("TurnEmptyResponse", Duration.hours(1)),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    new cloudwatch.Alarm(this, "RecordingFailuresAlarm", {
      alarmName: naming.alarmName("RecordingFailures"),
      alarmDescription: "Turn records or turn metrics are being lost: a turn record write failed or the Slack service could not emit turn metrics. Check the Slack orchestrator logs for turn_record.write_failed and turn_metrics.emit_failed. A write that timed out may still have landed, so check the table before assuming the record is lost.",
      metric: new cloudwatch.MathExpression({
        expression: "FILL(write,0) + FILL(emit,0)",
        usingMetrics: {
          write: agentxSum("TurnRecordWriteFailed", Duration.minutes(5)),
          emit: agentxSum("TurnMetricsEmitFailed", Duration.minutes(5)),
        },
        period: Duration.minutes(5),
        label: "Turn record write and turn metric emit failures",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // A request that fails its final attempt without reaching the processor's own reporting lands here
    // with no turn record and no other signal.
    new cloudwatch.Alarm(this, "SlackDeadLettersAlarm", {
      alarmName: naming.alarmName("SlackDeadLetters"),
      alarmDescription: "A Slack request exhausted its receives and is in the Slack request dead-letter queue. Check the Slack orchestrator logs for its event ID.",
      metric: slackDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        statistic: "Maximum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // Issue #46, named environments only: a dispatch job that exhausts its receives lands here and
    // nothing else reports it. The legacy AgentXControlPlane template stays as it is.
    if (naming.env !== undefined) {
      new cloudwatch.Alarm(this, "DispatchDeadLettersAlarm", {
        alarmName: naming.alarmName("DispatchDeadLetters"),
        alarmDescription: "A worker dispatch job exhausted its receives and is in the dispatch dead-letter queue. Check the dispatcher logs for its operation ID, then redrive or purge the queue.",
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          statistic: "Maximum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notifyOperator);
    }

    // A named environment's broker is given the role's name (BrokerNames): the role is under /agentx/<env>/, so the broker builds the ARN.
    if (naming.env === undefined) broker.addEnvironment("SLACK_ORCHESTRATOR_ROLE_ARN", slackOrchestratorRole.roleArn);
    else BrokerNames.of(broker).add("slackOrchestratorRole", slackOrchestratorRole.roleName);
    // A named environment's broker is given the limits in its settings (BrokerSettings: Number parameters, so plain text), not as variables of their own: its variables are held to Lambda's 4 KB.
    if (naming.env === undefined) {
      broker.addEnvironment("SLACK_MEMBER_WORKSPACE_LIMIT", memberWorkspaceLimit.valueAsString);
      broker.addEnvironment("SLACK_ORGANIZATION_WORKSPACE_LIMIT", organizationWorkspaceLimit.valueAsString);
    } else {
      BrokerSettings.of(broker).add("memberWorkspaceLimit", memberWorkspaceLimit.valueAsString);
      BrokerSettings.of(broker).add("organizationWorkspaceLimit", organizationWorkspaceLimit.valueAsString);
    }

    const appPostedMessages = new CfnParameter(this, "SlackAppPostedMessages", {
      type: "String",
      default: "accept",
      allowedValues: ["accept", "ignore"],
      description: "accept: answer mentions a person posts through another app with their own Slack token; ignore: answer only typed mentions",
    });
    const threadTurnsPerMinute = new CfnParameter(this, "SlackThreadTurnsPerMinute", {
      // A CloudFormation Number parameter accepts decimals (e.g. "6.5") within its min/max, which the
      // Lambda's own whole-number check then refuses at cold start, taking all Slack ingress down
      // with no alarm. A String with this pattern refuses that value at deploy time instead.
      type: "String",
      default: "6",
      allowedPattern: "^([1-9]|[1-5][0-9]|60)$",
      constraintDescription: "must be a whole number from 1 to 60",
      description: "Most requests one Slack thread may start in a minute; further requests pause the thread with one notice",
    });
    const slackIngress = packagedFunction(
      this,
      "SlackIngress",
      "packages/broker/src/aws/slack-ingress.ts",
      {
        STATE_TABLE_NAME: state.tableName,
        SLACK_THREADS_TABLE_NAME: slackThreads.tableName,
        SLACK_REQUEST_QUEUE_URL: slackRequestQueue.queueUrl,
        SLACK_SECRET_ARN: slackSecret.secretArn,
        SLACK_APP_POSTED_MESSAGES: appPostedMessages.valueAsString,
        SLACK_THREAD_TURNS_PER_MINUTE: threadTurnsPerMinute.valueAsString,
      },
      Duration.seconds(10),
    );
    slackIngress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [state.tableArn],
      // A named environment's channel binding sits in its org's partition, and the Slack team's own row names that
      // org; the legacy template stays byte-identical.
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": naming.env === undefined ? ["SLACK_BINDING#*"] : ["ORG#*#SLACK_BINDING#*", "SLACK_TEAM#*"] } },
    }));
    slackThreads.grantReadWriteData(slackIngress);
    slackRequestQueue.grantSendMessages(slackIngress);
    // The stop command (#126): the broker cancels the thread's running task for the ingress, which
    // itself gets no write access to the state table and no callback key.
    slackIngress.addEnvironment("BROKER_FUNCTION_NAME", broker.functionName);
    broker.grantInvoke(slackIngress);
    slackSecret.grantRead(slackIngress);
    // The Details view (spec 014 FR-024): Slack's interactivity request runs on this Lambda and must
    // open the modal within 3 seconds, so it reads the one turn record the clicked button names, by
    // key. It may read only the attributes the view shows: never the request or response text, the
    // workspace or the worker operations. No Query or Scan, and no index.
    slackIngress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [turnRecords.tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": TURN_DETAILS_READ_ATTRIBUTES },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        // ForAllValues passes when dynamodb:Attributes is absent, and GetItem has no Select, so a read
        // without a ProjectionExpression (which returns every attribute) must be refused outright.
        Null: { "dynamodb:Attributes": "false" },
      },
    }));
    slackIngress.addEnvironment("TURN_RECORDS_TABLE_NAME", turnRecords.tableName);

    const api = new apigwv2.CfnApi(this, "HttpApi", {
      name: naming.apiName,
      protocolType: "HTTP",
    });
    const integration = new apigwv2.CfnIntegration(this, "BrokerIntegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: broker.functionArn,
      payloadFormatVersion: "2.0",
    });
    const authorizer = new apigwv2.CfnAuthorizer(this, "JwtAuthorizer", {
      apiId: api.ref,
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      name: "agentx-jwt",
      jwtConfiguration: {
        audience: [oidcAudience.valueAsString],
        issuer: oidcIssuer.valueAsString,
      },
    });
    new apigwv2.CfnRoute(this, "ProxyRoute", {
      apiId: api.ref,
      routeKey: "ANY /{proxy+}",
      target: `integrations/${integration.ref}`,
      authorizationType: "JWT",
      authorizerId: authorizer.ref,
    });
    new apigwv2.CfnRoute(this, "WorkerCallbackRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/internal/{proxy+}",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // The setup worker authenticates this one source read with its short-lived project-setup
    // capability, which the broker verifies. Keep the API Gateway exception limited to this GET;
    // the generic internal callback route remains POST-only.
    new apigwv2.CfnRoute(this, "ProjectSetupExecutionReadRoute", {
      apiId: api.ref,
      routeKey: "GET /v1/internal/project-setups/{setupExecutionId}/execution",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // The agent step's two GET callbacks. Like the setup read above, a GET is not covered by the POST-only internal route and would fall to the JWT route, where API
    // Gateway answers 401 before the broker is reached (staging 0.4.5: no agent or chain step with tools could run). No authorizer: the broker authenticates each
    // call itself, verifying the HMAC-signed `x-agentx-callback-capability` header (signature, expiry, the `agent-skills`, `agent-tools` or `context-tools` action, the operation's fence)
    // before it reads anything (handleAgentSkills, handleAgentTools). tests/contract/internal-routes-infrastructure.test.ts keeps every broker internal GET routed.
    // A named environment only: the legacy template has no agent steps and stays as it was.
    if (naming.env !== undefined) {
      new apigwv2.CfnRoute(this, "AgentToolsListRoute", {
        apiId: api.ref,
        routeKey: "GET /v1/internal/agent-tools",
        target: `integrations/${integration.ref}`,
        authorizationType: "NONE",
      });
      new apigwv2.CfnRoute(this, "AgentSkillsReadRoute", {
        apiId: api.ref,
        routeKey: "GET /v1/internal/agent-skills",
        target: `integrations/${integration.ref}`,
        authorizationType: "NONE",
      });
      // Meta repo lane E: the list of the project's MCP context tools, read by the worker of an Understand, Plan, Plan-check or Review step. Same reason and same authentication (the
      // `context-tools` capability, verified in handleContextTools); its POST /call is covered by the POST-only internal route.
      new apigwv2.CfnRoute(this, "ContextToolsListRoute", {
        apiId: api.ref,
        routeKey: "GET /v1/internal/context-tools",
        target: `integrations/${integration.ref}`,
        authorizationType: "NONE",
      });
      // DR7: a design-review reviewer's stored packet. Same reason and same authentication (the `design-review-packet` capability, verified in handleDesignReviewPacket).
      new apigwv2.CfnRoute(this, "DesignReviewPacketRoute", {
        apiId: api.ref,
        routeKey: "GET /v1/internal/design-review/packet",
        target: `integrations/${integration.ref}`,
        authorizationType: "NONE",
      });
    }
    // GitHub signs webhook bodies itself; the broker verifies its HMAC and linked repository scope.
    new apigwv2.CfnRoute(this, "GithubWebhookRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/github/webhooks",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // Plan 4 Task 19: the endpoint vendors post events to. No authorizer: each delivery proves itself with its signature or token over its own bytes, checked by the broker
    // before anything is written (triggers/ingress.ts). A named environment only: the legacy templates stay as they were. The route exists only where the stage throttles it
    // (`DeveloperSignIn`, built from `signInParameters`), so a public route is never left without its bucket.
    const eventHookRoute = naming.env === undefined || signInParameters === undefined ? undefined : new apigwv2.CfnRoute(this, "EventHookRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/hooks/{source}/{hookId}",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // Plan 2, Task 13: GitHub's install redirect and the confirm page's form post. No JWT: the broker checks the connect state against
    // GitHub, and the confirmation by cookie and Origin. A named environment only (the legacy deployment has no developer sign-in);
    // the stage throttles them like the other public routes (DeveloperSignIn applies `throttledRoutes`).
    const githubInstallRoutes = naming.env === undefined ? [] : [
      new apigwv2.CfnRoute(this, "GithubInstallCallbackRoute", {
        apiId: api.ref, routeKey: "GET /v1/github/install/callback", target: `integrations/${integration.ref}`, authorizationType: "NONE",
      }),
      new apigwv2.CfnRoute(this, "GithubInstallConfirmRoute", {
        apiId: api.ref, routeKey: "POST /v1/github/install/confirm", target: `integrations/${integration.ref}`, authorizationType: "NONE",
      }),
    ];
    // Confused-deputy guard: only this account's own EventBridge schedules may assume the recovery roles.
    // Scheduler sets aws:SourceArn to the schedule group's ARN, not the schedule's; these schedules use the default group.
    const schedulerPrincipal = new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: {
      StringEquals: {
        "aws:SourceAccount": this.account,
        "aws:SourceArn": `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule-group/default`,
      },
    } });
    const githubRecoveryRole = new iam.Role(this, "GithubWebhookRecoveryRole", {
      assumedBy: schedulerPrincipal,
    });
    broker.grantInvoke(githubRecoveryRole);
    new scheduler.CfnSchedule(this, "GithubWebhookRecoverySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
      target: {
        arn: broker.functionArn,
        roleArn: githubRecoveryRole.roleArn,
        input: JSON.stringify({ source: "agentx.github-webhook-recovery" }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
      },
    });
    // Plan 2, Task 14 Step 6: one reminder to a requester whose GitHub admin has not approved after 2 days. Deleting this schedule (and the
    // handler's branch) removes the feature and nothing else; the 7 day expiry stays either way. Hourly is the finest it needs. Rovara Cloud only
    // (follow-up): the broker's handler does nothing off the cloud, so no other install, the legacy deployment included, gets the schedule.
    if (props?.cloud === true && naming.env !== undefined) {
      new scheduler.CfnSchedule(this, "GithubInstallRequestReminderSchedule", {
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: "rate(1 hour)",
        state: "ENABLED",
        target: {
          arn: broker.functionArn,
          roleArn: githubRecoveryRole.roleArn,
          input: JSON.stringify({ kind: "github-install-request-reminders" }),
          retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
        },
      });
    }
    // Plan 2, Task 19: the firewall list follows the approved egress domains. A change syncs at once; this run is the retry for one that could not,
    // and the one-off backfill of requests for domains stored before approvals existed. It does nothing while the sync marker is clean.
    if (projectAllowListArn !== undefined) {
      new scheduler.CfnSchedule(this, "EgressDomainsSyncSchedule", {
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: "rate(5 minutes)",
        state: "ENABLED",
        target: {
          arn: broker.functionArn,
          roleArn: githubRecoveryRole.roleArn,
          input: JSON.stringify({ source: "agentx.egress-domains-sync" }),
          retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
        },
      });
    }
    new scheduler.CfnSchedule(this, "WorkflowMergeRecoverySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
      target: {
        arn: broker.functionArn,
        roleArn: githubRecoveryRole.roleArn,
        input: JSON.stringify({ source: "agentx.workflow-merge-recovery" }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
      },
    });
    // Plan 3, Task 30 (PF13): every 5 minutes the spend settlement jobs run: the sweep that settles the model keys' spend and finalizes the ended ones.
    // Named environments only: the model proxy they settle against exists only there, and the legacy template is unchanged. It needs no new grant: the
    // broker already reads and writes the State table and invokes the model access function.
    if (naming.env !== undefined) {
      new scheduler.CfnSchedule(this, "SpendSettlementSchedule", {
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: "rate(5 minutes)",
        state: "ENABLED",
        target: {
          arn: broker.functionArn,
          roleArn: githubRecoveryRole.roleArn,
          input: JSON.stringify({ source: "agentx.spend-settlement" }),
          retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
        },
      });
      // Plan 5, Task 7a: every 5 minutes the session sweep refreshes the open sessions from a saved cursor and the retention drain gives ended sessions' items
      // their expiry. Its own schedule, not a settlement job: the settlement run's seconds (`SETTLEMENT_BUDGETS_MS`) are all given to money and audit jobs.
      // Named environments only, on the same role as the schedules above; the broker already reads and writes the State table.
      new scheduler.CfnSchedule(this, "AgentSessionSweepSchedule", {
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: "rate(5 minutes)",
        state: "ENABLED",
        target: {
          arn: broker.functionArn,
          roleArn: githubRecoveryRole.roleArn,
          input: JSON.stringify({ source: "agentx.session-sweep" }),
          retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
        },
      });
    }
    // Plan 4 Task 9: every 5 minutes the chain sweep looks at the chain runs that are due (a step that ran out of time, a callback or a decision the run did not hear, an ending
    // left half done). Named environments only, as the chains' own routes are; it runs through the same role as the other recovery schedules and needs no new grant.
    if (naming.env !== undefined) {
      new scheduler.CfnSchedule(this, "ChainSweepSchedule", {
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: "rate(5 minutes)",
        state: "ENABLED",
        target: {
          arn: broker.functionArn,
          roleArn: githubRecoveryRole.roleArn,
          input: JSON.stringify({ source: "agentx.chain-sweep" }),
          retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
        },
      });
    }
    // Meta repo lane F (F2): every minute the intake poll reads the sources that are due (a team's own tracker has no webhook of ours). Each source has its own interval (2 minutes by default) and
    // its own cap of reads an hour, kept by the broker; this tick only wakes it. No retries: the next minute is the retry, and a pile of late ticks would only poll twice. Named environments only,
    // through the same role as the other recovery schedules, so it needs no new grant.
    if (naming.env !== undefined) {
      new scheduler.CfnSchedule(this, "IntakePollSchedule", {
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: "rate(1 minute)",
        state: "ENABLED",
        target: {
          arn: broker.functionArn,
          roleArn: githubRecoveryRole.roleArn,
          input: JSON.stringify({ source: "agentx.intake-poll" }),
          retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
        },
      });
    }
    // Team record (wire-team-record): the whole record, behind the switch `agentxTeamRecord=enabled` (off by default: this block does not run and nothing changes).
    const teamRecordResources = props?.teamRecord !== undefined && naming.env !== undefined ? attachTeamRecord(this, { env: naming.env, region: props.deploymentRegion ?? "us-east-1", context: props.teamRecord, broker, slackIngress, dispatcher, scheduleRole: githubRecoveryRole, alarms: { name: (suffix) => naming.alarmName(suffix), action: notifyOperator, metricsNamespace: naming.metricsNamespace }, ...(props.reservedConcurrency === false ? { reservedConcurrency: false } : {}) }) : undefined;
    // Saved environment images (SH22): the registry side (KMS, creation template, push/pull/manage roles). Nothing pushes until the broker's `sv` setting is on.
    if (naming.env !== undefined) BrokerNames.of(broker).add("savedEnvKey", attachSavedEnvImages(this, { env: naming.env, brokerRole: broker.role!, cloudFormationRoleName: naming.cloudFormationRoleName, ...(props?.savedEnv?.kmsKeyArn === undefined ? {} : { kmsKeyArn: props.savedEnv.kmsKeyArn }), ...(props?.savedEnv?.registryScan === true ? { registryScanning: "basic" as const } : {}) }).kmsKeyId);
    // Test services (TS19): the catalog's image repositories and their key. NOT behind `TestServicesEnabled` (switch `tx`): the repositories have fixed names and are retained, so a condition would break turning the switch on, off and on again.
    if (naming.env !== undefined) attachServiceCatalogImages(this, { env: naming.env, repositories: SERVICE_CATALOG_REPOSITORIES });
    // N9 (INTG2): a project's private package registries, behind `rovaraCodeArtifactDomains` (off by default: this does not run and nothing changes).
    if (props?.registryDomains !== undefined) attachProjectRegistries(this, { broker, domains: props.registryDomains });
    // Plan 4 Task 26: schedule triggers. Each trigger's schedule lives in a group of its own and invokes the broker through a role of its own. EventBridge Scheduler sets
    // aws:SourceArn to the schedule GROUP's ARN, not the schedule's, so that is what the role's trust names (a `schedule/...` pattern would never match, and a schedule of any
    // other group is refused). The role can invoke the broker function and write the dead-letter queue, nothing else. The queue is encrypted with SQS-managed keys, so no KMS
    // permission is needed on either side. The broker manages the group's schedules, passes that one role to the scheduler, and reads and deletes the dead letters. Named
    // environments only, like the chains' own routes. The role and the queue have fixed names and the group's name is derived from the environment, so the broker builds all three from AGENTX_ENV and passes nothing (Lambda's 4 KB).
    if (naming.env !== undefined) {
      const scheduleGroupName = chainScheduleGroupName(naming.env);
      new scheduler.CfnScheduleGroup(this, "ChainScheduleGroup", { name: scheduleGroupName });
      const chainScheduleDeadLetters = new sqs.Queue(this, "ChainScheduleDeadLetters", { queueName: chainScheduleQueueName(naming.env), encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14) });
      const chainScheduleInvokeRole = new iam.Role(this, "ChainScheduleInvokeRole", {
        roleName: chainScheduleRoleName(naming.env),
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: {
          StringEquals: {
            "aws:SourceAccount": this.account,
            "aws:SourceArn": `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule-group/${scheduleGroupName}`,
          },
        } }),
      });
      chainScheduleInvokeRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [broker.functionArn] }));
      chainScheduleInvokeRole.addToPolicy(new iam.PolicyStatement({ actions: ["sqs:SendMessage"], resources: [chainScheduleDeadLetters.queueArn] }));
      broker.addToRolePolicy(new iam.PolicyStatement({
        sid: "ManageChainSchedules",
        actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
        resources: [`arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule/${scheduleGroupName}/*`],
      }));
      broker.addToRolePolicy(new iam.PolicyStatement({
        sid: "PassChainScheduleRole", actions: ["iam:PassRole"], resources: [chainScheduleInvokeRole.roleArn], conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
      }));
      // The sweep reads, deletes and parks the dead letters (ChangeMessageVisibility hides one that keeps failing), and a fire that failed records itself here (SendMessage), because the
      // scheduler invokes the broker asynchronously and never sees its errors. All on this one queue.
      broker.addToRolePolicy(new iam.PolicyStatement({
        sid: "UseChainScheduleDeadLetters", actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:SendMessage"], resources: [chainScheduleDeadLetters.queueArn],
      }));
      // A letter that is parked, or that the sweep cannot clear, stays in the queue. The age metric is no use: SQS stops counting a message in it once it has been received three
      // times, and a poison letter is received up to six. A parked letter is not visible (its visibility is 12 hours), so the alarm counts visible plus in-flight messages and
      // fires when the queue has held any for three 5-minute periods (the sweep clears an ordinary letter within one).
      new cloudwatch.Alarm(this, "ChainScheduleDeadLettersAlarm", {
        alarmName: naming.alarmName("ChainScheduleDeadLetters"),
        alarmDescription: "A schedule trigger's fire failed and its record has stayed in the chain schedule dead-letter queue for 15 minutes or more: the sweep could not handle it, or it was parked after repeated tries. Check the queue and the broker logs (schedule.dead_letter_failed, schedule.dead_letter_parked) for the trigger's id.",
        metric: new cloudwatch.MathExpression({
          expression: "FILL(visible, 0) + FILL(notVisible, 0)",
          usingMetrics: {
            visible: chainScheduleDeadLetters.metricApproximateNumberOfMessagesVisible({ statistic: "Maximum", period: Duration.minutes(5) }),
            notVisible: chainScheduleDeadLetters.metricApproximateNumberOfMessagesNotVisible({ statistic: "Maximum", period: Duration.minutes(5) }),
          },
          period: Duration.minutes(5),
          label: "Messages in the chain schedule dead-letter queue",
        }),
        threshold: 0,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notifyOperator);
    }
    // Gap 6: re-run any workflow dispatch (an automatic review start) left behind after its result committed.
    const workflowDispatchRecoveryRole = new iam.Role(this, "WorkflowDispatchRecoveryRole", {
      assumedBy: schedulerPrincipal,
    });
    broker.grantInvoke(workflowDispatchRecoveryRole);
    new scheduler.CfnSchedule(this, "WorkflowDispatchRecoverySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
      target: {
        arn: broker.functionArn,
        roleArn: workflowDispatchRecoveryRole.roleArn,
        input: JSON.stringify({ source: "agentx.workflow-dispatch-recovery" }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
      },
    });
    const defaultStage = new apigwv2.CfnStage(this, "DefaultStage", {
      apiId: api.ref,
      stageName: "$default",
      autoDeploy: true,
    });
    broker.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/*`,
    });

    const slackIntegration = new apigwv2.CfnIntegration(this, "SlackIngressIntegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: slackIngress.functionArn,
      payloadFormatVersion: "2.0",
    });
    new apigwv2.CfnRoute(this, "SlackEventsRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/slack/events",
      target: `integrations/${slackIntegration.ref}`,
      authorizationType: "NONE",
    });
    // Slack's interactivity request URL (spec 014): signed button presses, handled by the same Lambda.
    new apigwv2.CfnRoute(this, "SlackInteractivityRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/slack/interactions",
      target: `integrations/${slackIntegration.ref}`,
      authorizationType: "NONE",
    });
    new apigwv2.CfnRoute(this, "SlackServiceRoute", {
      apiId: api.ref,
      routeKey: "ANY /v1/service/{proxy+}",
      target: `integrations/${integration.ref}`,
      authorizationType: "AWS_IAM",
    });
    slackIngress.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/v1/slack/events`,
    });
    slackIngress.addPermission("InteractivityInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/v1/slack/interactions`,
    });
    slackOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ["execute-api:Invoke"],
      resources: [`arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/v1/service/*`],
    }));

    // Spec 025 phase 25a: developer sign-in, named environments only (R3).
    let signInFunction: DeveloperSignIn["signInFunction"] | undefined;
    let developerSignInTable: DeveloperSignIn["table"] | undefined;
    // 0.5.7: an optional custom domain in front of the same API (hosted cloud installs only; both parameters empty = nothing is created, nothing changes).
    const customDomain = props?.cloud === true && naming.env !== undefined && signInParameters !== undefined ? new CustomDomain(this, "CustomDomain", { env: naming.env, api, stage: defaultStage }) : undefined;
    if (naming.env !== undefined && signInParameters !== undefined) {
      // A bootstrap-free (legacy-synthesizer) template is the released one: the release pipeline packages zip Lambda code only, and CloudFront hosting adds a BucketDeployment and its AWS CLI layer (a file asset), so a released template has the cell serve the web files.
      // Every other named environment (deployed with the CDK engine, bootstrapped) defaults to CloudFront, as Plan 7 Task 4 specifies.
      const configuredHosting: unknown = this.node.tryGetContext("agentxWebAssetHosting");
      if (configuredHosting !== undefined && configuredHosting !== "cloudfront" && configuredHosting !== "cell") throw new Error("agentxWebAssetHosting must be cloudfront or cell");
      const releasable = this.node.tryGetContext("agentxSynthesizer") === "legacy";
      if (releasable && configuredHosting === "cloudfront") throw new Error("agentxWebAssetHosting=cloudfront cannot be used with agentxSynthesizer=legacy: a bootstrap-free (released) template cannot carry the CloudFront upload's file asset; use cell");
      const web = new WebApp(this, "WebApp", { naming, api, ...(customDomain === undefined ? {} : { customDomain }), assetHosting: configuredHosting === "cell" || releasable ? "cell" : "cloudfront" });
      const developerSignIn = new DeveloperSignIn(this, "DeveloperSignIn", {
        naming, env: naming.env, api, stage: defaultStage, brokerIntegration: integration, broker, slackSecret, parameters: signInParameters, ...(customDomain === undefined ? {} : { customDomain }), turnRecords, state, throttledRoutes: [...githubInstallRoutes.map(route => ({ route, burst: 50, rate: 20 })), ...web.routes], ...(eventHookRoute === undefined ? {} : { hookRoute: eventHookRoute }),
        ...(props?.cloud === true ? { cloud: true } : {}),
      });
      signInFunction = developerSignIn.signInFunction;
      developerSignInTable = developerSignIn.table;
      // Plan 5, Task 8: change notices over an AppSync Events API. The broker and the outbox publisher publish to its one namespace; clients subscribe with a short-lived token
      // the authorizer checks (it may read the token key's public half and nothing more). The broker gets the DNS prefix of the API's hosts (not its id: that host does not exist) in its names and builds the endpoint from it
      // (its variables are held to 4 KB); the outbox publisher gets the endpoint whole.
      const realtime = new RealtimeEvents(this, "Realtime", {
        env: naming.env, state, tokenKey: developerSignIn.tokenKey, allowPublicKeyRead: (role) => developerSignIn.allowPublicKeyRead(role),
      });
      // RULING Q11: the realtime construct now exists; allow only its actual DNS hosts in the web CSP.
      web.handlerFunction.addEnvironment("REALTIME_HTTP_HOST", realtime.api.httpDns);
      web.handlerFunction.addEnvironment("REALTIME_WS_HOST", realtime.api.realtimeDns);
      realtime.grantPublish(broker);
      realtime.grantPublish(outboxPublisher);
      outboxPublisher.addEnvironment("REALTIME_HTTP_ENDPOINT", realtime.httpEndpoint);
      BrokerNames.of(broker).add("realtimeApi", realtime.dnsPrefix);
      if (naming.env === "agentxlivetest123" && taskPersonProofEnabled !== undefined) {
        new TaskPersonProof(this, "TaskPersonProof", {
          naming,
          enabled: taskPersonProofEnabled,
          slackTeamId: signInParameters.slackTeamId,
          slackSecret,
          developerSignInTable: developerSignIn.table,
          dispatcher,
        });
      }
      // The four flags are parameters with an allowed list (true, false), so the broker is given them in its settings (BrokerSettings), not as variables of their own.
      const brokerSettings = BrokerSettings.of(broker);
      brokerSettings.add("taskPeopleChanges", signInParameters.taskPeopleChangesEnabled.valueAsString);
      brokerSettings.add("taskPeoplePublicInvitations", signInParameters.taskPeoplePublicInvitationsEnabled.valueAsString);
      brokerSettings.add("taskPeoplePrivateInvitations", signInParameters.taskPeoplePrivateInvitationsEnabled.valueAsString);
      brokerSettings.add("workflowDependencies", signInParameters.workflowDependenciesEnabled.valueAsString);
      // Rovara Code v2, per environment: a packed setting, not a variable (ENV-ROOM). Off unless the operator sets the parameter.
      brokerSettings.add("rovaraCodeV2", signInParameters.rovaraCodeV2Enabled.valueAsString);
      // Mainline #408: the plan self-check and automatic fixing switches, packed settings (never Lambda variables of their own). On unless the operator sets the parameter to false.
      brokerSettings.add("planSelfCheck", signInParameters.planSelfCheckEnabled.valueAsString);
      brokerSettings.add("autofix", signInParameters.autofixEnabled.valueAsString);
      // Live steer kill switch, a packed setting (two bytes of key, one of value; never a variable of its own). Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("liveSteer", signInParameters.liveSteerEnabled.valueAsString);
      // Stop & redirect kill switch, a packed setting like live steer's. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("liveRedirect", signInParameters.liveRedirectEnabled.valueAsString);
      // Live interaction A3: the Ask switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("liveAsk", signInParameters.liveAskEnabled.valueAsString);
      // Live interaction F2 to F4: the Fix with agent switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("liveFix", signInParameters.liveFixEnabled.valueAsString);
      // Proof and evidence, and decision cards (wire-proof): two switches, packed settings. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("proofEvidence", signInParameters.proofEvidenceEnabled.valueAsString);
      brokerSettings.add("decisionCards", signInParameters.decisionCardsEnabled.valueAsString);
      // Test environment (wire-testenv): one switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("testEnvironment", signInParameters.testEnvironmentEnabled.valueAsString);
      // Setup agent (sh-setup-wire): one switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("setupAgent", signInParameters.setupAgentEnabled.valueAsString);
      // Test services (TS37): three switches, packed settings. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("testServices", signInParameters.testServicesEnabled.valueAsString);
      brokerSettings.add("testAccounts", signInParameters.testAccountsEnabled.valueAsString);
      brokerSettings.add("projectImages", signInParameters.projectImagesEnabled.valueAsString);
      // Lessons reach the agent: its own switch, apart from the Team record's. A packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("learnedLessons", signInParameters.learnedLessonsEnabled.valueAsString);
      // Second review by a different AI company (setup-test-health SH34): one switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("secondReview", signInParameters.secondReviewEnabled.valueAsString);
      // Company setup recipes as a proposal source (setup-test-health SH30): one switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("setupRecipes", signInParameters.setupRecipesEnabled.valueAsString);
      // Saved environments (SH25): one switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("savedEnv", signInParameters.savedEnvEnabled.valueAsString);
      // Script tokens (UX5b): one switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("scriptTokens", signInParameters.scriptTokensEnabled.valueAsString);
      // Standing instructions (lane I1): one switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("standingInstructions", signInParameters.standingInstructionsEnabled.valueAsString);
      // Design review stage (DR7): the operator switch, a packed setting. Off ("0") unless the operator sets the parameter; each project is then turned on in How we work.
      brokerSettings.add("designReview", signInParameters.designReviewEnabled.valueAsString);
      // Nightly health (SH28): a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("nightlyHealth", signInParameters.nightlyHealthEnabled.valueAsString);
      // The dispatcher honours the same switch when it builds a queued stage's lessons at delivery (WL-6): off, no queued, parked or retried stage gets lessons. A plain variable (its environment is small).
      dispatcher.addEnvironment(BROKER_SETTINGS.learnedLessons.variable, signInParameters.learnedLessonsEnabled.valueAsString);
      // Saved project images: the dispatcher hands a rebuild job's lease to the worker when it delivers (aws/dispatcher.ts `createSavedEnvBuildLease`), and only while the same switch is on. A plain variable (its environment is small).
      dispatcher.addEnvironment(BROKER_SETTINGS.savedEnv.variable, signInParameters.savedEnvEnabled.valueAsString);
      // The second review's track record is indexed from the table's stream by the outbox publisher, behind the same switch (a plain variable on that function; its environment is small).
      outboxPublisher.addEnvironment(BROKER_SETTINGS.secondReview.variable, signInParameters.secondReviewEnabled.valueAsString);
      // Four test results (setup and test health): its own switch, a packed setting. Off ("0") unless the operator sets the parameter to "1".
      brokerSettings.add("verifyResults", signInParameters.verifyResultsEnabled.valueAsString);
      // v1.2 learning loop: the install default of the company's master suggestions switch, a packed setting. Off unless the operator sets the parameter.
      brokerSettings.add("learningSuggestionsDefault", signInParameters.learningSuggestionsDefault.valueAsString);
      // Lane U5 (runtime UI flags): the operator's override, a packed setting. `none` unless the operator sets the parameter.
      brokerSettings.add("uiFlagsForceOff", signInParameters.uiFlagsForceOff.valueAsString);
      // Sign in with ChatGPT (#338): seals each developer's ChatGPT tokens in the State table. A
      // connection belongs to a signed-in developer, so it exists only where developer sign-in
      // does. Only the broker encrypts and decrypts with it, always under an encryption context
      // naming the developer and the field. Deleting it (with the stack) only leaves connections to redo.
      const chatGptConnectionKey = new kms.Key(this, "ChatGptConnectionKey", {
        description: "AgentX: seals developers' Sign in with ChatGPT tokens",
        enableKeyRotation: true,
        pendingWindow: Duration.days(7),
        removalPolicy: RemovalPolicy.DESTROY,
      });
      chatGptConnectionKey.grant(broker, "kms:Encrypt", "kms:Decrypt");
      // The key's id, in the broker's names: the broker builds the ARN from the region and the account (broker-environment.ts), to the same text.
      BrokerNames.of(broker).add("chatGptConnectionKey", chatGptConnectionKey.keyId);
      // Spec 025 phase 25c: sharing, named environments only (D14).
      const notifier = new DeveloperTaskNotifier(this, "DeveloperTaskNotifier", { naming, controlPlaneUrl: customDomain === undefined ? api.attrApiEndpoint : customDomain.origin(), state, artifactBucket: artifacts, slackSecret, taskPeopleChangesEnabled: signInParameters.taskPeopleChangesEnabled, decisionCardsEnabled: signInParameters.decisionCardsEnabled, notifyOperator });
      // Spec 025 A13: the admin health route reads the environment's alarms, by name, and
      // the depths of its dead-letter queues. Read-only, and on exactly these resources.
      const alarmPrefix = naming.alarmName("");
      // The broker derives the alarm prefix from AGENTX_ENV (environmentAlarmPrefix), so it is not given it.
      // Issue 206: the probe reads them by exact name (HEALTH_ALARM_SUFFIXES), since a prefix listing
      // is authorized against * while a call naming its alarms is authorized against each alarm's
      // ARN, which this grant covers. A CDK alarm missing from that list would go unreported, so the
      // app refuses to synthesize one. This holds when an environment's stacks deploy from one
      // revision, as a release does: a stack deployed alone from a newer revision could add an
      // alarm this broker does not list.
      this.node.addValidation({ validate: () => unlistedAlarms(this, alarmPrefix) });
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["cloudwatch:DescribeAlarms"],
        resources: [`arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:${alarmPrefix}*`],
      }));
      const deadLetterQueues = { dispatch: deadLetterQueue, "slack-requests": slackDeadLetterQueue, "developer-notices": notifier.deadLetters, "developer-notice-stream": notifier.streamFailures };
      // The queues' names, in the broker's names: the broker builds each URL from the region and the account and lists them for the health route
      // (broker-environment.ts). Four URLs in a variable of their own came to 650 bytes of the 4 KB.
      const brokerNames = BrokerNames.of(broker);
      brokerNames.add("dispatchDeadLetters", deadLetterQueue.queueName);
      brokerNames.add("slackRequestDeadLetters", slackDeadLetterQueue.queueName);
      brokerNames.add("developerNoticeDeadLetters", notifier.deadLetters.queueName);
      brokerNames.add("developerNoticeStreamFailures", notifier.streamFailures.queueName);
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["sqs:GetQueueAttributes"],
        resources: Object.values(deadLetterQueues).map((queue) => queue.queueArn),
      }));
      // C10: the ingress reads shared thread records by key; its channel binding statement is unchanged.
      slackIngress.addEnvironment("SHARED_TASKS", "enabled");
      slackIngress.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SHARED_TASK#*"] } },
      }));
      // Slack plan buttons read only the task owner, share binding, and saved workflow policy by key.
      slackIngress.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "slackUserId", "share", "workflow"] },
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          Null: { "dynamodb:Attributes": "false" },
        },
      }));
      // Task 19 (gap 10h): a Quick or Full button takes the choice while Slack waits, then starts the task in an
      // asynchronous invoke of this same Lambda. A policy of its own, so the function does not wait on it (no cycle).
      new iam.Policy(this, "SlackIngressSelfInvoke", {
        roles: [slackIngress.role!],
        statements: [new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [slackIngress.functionArn] })],
      });
      // Task 19: an asynchronous invoke Lambda could not run (throttled past its retries, too old, or a crash) lands here,
      // and the operator is told: a Slack press handed to the broker or this Lambda's own Quick or Full start, and also
      // any other asynchronous broker invoke (a scheduled retry sweep). The handlers answer every expected refusal
      // themselves, so anything here is a lost request.
      const handOffFailures = new sqs.Queue(this, "SlackHandOffFailureQueue", {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        retentionPeriod: Duration.days(14),
      });
      broker.configureAsyncInvoke({ onFailure: new lambdaDestinations.SqsDestination(handOffFailures) });
      slackIngress.configureAsyncInvoke({ onFailure: new lambdaDestinations.SqsDestination(handOffFailures) });
      new cloudwatch.Alarm(this, "SlackHandOffFailuresAlarm", {
        alarmName: naming.alarmName("SlackHandOffFailures"),
        alarmDescription: "An AgentX background request (a Slack button press or a scheduled retry) was lost: Lambda could not run it, and it is in the Slack hand-off failure queue. Check the queue, and the broker and Slack ingress logs for its task or request ID.",
        // Each lost request alarms on its own: the count sent in five minutes, not the queue's depth (which stays up until
        // the queue is purged and would hide a later loss).
        metric: handOffFailures.metricNumberOfMessagesSent({ statistic: "Sum", period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notifyOperator);
      // Spec 025 E14 (C14): the interactivity route hands Slack Confirm and Cancel presses to the broker.
      slackIngress.addEnvironment("ADMIN_CHANGES", "enabled");
      // Spec 025 E14, FR-052: the interactivity route logs a press with its change's trace ID; it may
      // read only that attribute and the keys, by key.
      slackIngress.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "traceId"] },
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          // ForAllValues passes when dynamodb:Attributes is absent, and GetItem has no Select, so a read
          // without a ProjectionExpression (which returns every attribute) must be refused outright.
          Null: { "dynamodb:Attributes": "false" },
        },
      }));
      // C14: TASK_BUSY counts the shared thread's waiting messages.
      BrokerNames.of(broker).add("slackThreadsTable", slackThreads.tableName);
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [slackThreads.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] } },
      }));
    }

    // The Audit Ledger's storage and vault key (Task 5) and the broker's side of its outbox (Task 6: queue URL, grants,
    // drain schedule, alarms), named environments only: the legacy template is unchanged. The appender's role is
    // created bare here because the vault key policy names it; Task 7 builds the appender function on it and gives
    // it its grants.
    if (naming.env !== undefined) {
      const auditAppenderRole = new iam.Role(this, "AuditAppenderRole", {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description: "The Rovara audit ledger appender: the only writer of the audit chain",
      });
      new AuditLedger(this, "AuditLedger", {
        naming,
        broker,
        stateTable: state,
        notifyOperator,
        appenderRole: auditAppenderRole,
        ...(props?.reservedConcurrency === false ? { reservedConcurrency: false } : {}),
        ...(signInFunction === undefined ? {} : { signInFunction }),
        ...(props?.deploymentRegion === undefined ? {} : { deploymentRegion: props.deploymentRegion }),
      });
    }

    const sessions = new SessionLifecycle(this, "Sessions", { naming, state, invokeSigningKey, notifyOperator });
    // A6: where the State table expires index items itself, the reconciler's legacy sweep is off.
    if (naming.env !== undefined) sessions.reconciler.addEnvironment("INDEX_EXPIRY", "ttl");
    // Test services (`tx`): the launch tells a worker's boot to pre-pull the catalog images only when this is "1" (the boot's AGENTX_TEST_SERVICES). Named environments only; the legacy template is unchanged.
    if (signInParameters !== undefined) sessions.steps.addEnvironment("TEST_SERVICES_ENABLED", signInParameters.testServicesEnabled.valueAsString);
    // Issue 195: the alarm for stuck cancels. Named environments only: the legacy template is
    // unchanged. A stuck cancel on a live worker is queued again with the signing key the backstop
    // below gives the reconciler; the legacy reconciler has none, and only logs and counts it.
    if (naming.env !== undefined) sessions.connectStuckCancelAlarm();
    // Issue 173: the backstop for idle Slack tasks nobody waits on. Named environments only: the
    // legacy template is unchanged.
    if (naming.env !== undefined) sessions.connectUnwaitedTaskBackstop(slackThreads, slackSecret, callbackSigningKey.valueAsString);
    // Own both attachments in this releasable stack. Secret changes must never mutate the
    // protected foundation template or require a separate foundation change set.
    // Named environments: the model proxy alone holds provider keys and Bedrock access for members
    // (R4). It runs in the foundation's private subnets, and the worker group may call it; the
    // orchestrator and broker are admitted when they are pointed at it. The legacy deployment is unchanged.
    let modelProxy: ModelProxy | undefined;
    if (naming.env === undefined) {
      grantProviderKeySecrets(this, [slackOrchestratorRole.roleName, sessions.instanceRoleName]);
    } else {
      const vpcId = new CfnParameter(this, "VpcId", { type: "String", description: "The foundation's VPC" }).valueAsString;
      // Ruling R55: the broker binds a cloud org's new project to the same EC2 workers `agentx project add` binds to
      // (launch template, and one private subnet per availability zone as availabilityZone=subnetId pairs).
      // In the broker's names (BrokerNames): an AWS-generated id, and its variables are held to Lambda's 4 KB.
      BrokerNames.of(broker).add("launchTemplate", sessions.launchTemplateId.valueAsString);
      broker.addEnvironment("EC2_WORKER_SUBNETS", new CfnParameter(this, "Ec2WorkerSubnets", { type: "String", description: "The foundation's EC2 worker subnets, as availabilityZone=subnetId pairs" }).valueAsString);
      modelProxy = new ModelProxy(this, "ModelProxy", {
        naming,
        vpcId,
        subnetIds: Fn.split(",", sessions.privateSubnetIds.valueAsString),
        clientSecurityGroupIds: [new CfnParameter(this, "Ec2WorkerSecurityGroupId", { type: "String", description: "The foundation's EC2 worker security group" }).valueAsString],
        // Ruling R52: the geography follows the install's region (an eu install serves eu.* profiles); an unsupported region fails the synth.
        models: bedrockClaudeModelIds(proxyGeographyForRegion(props?.deploymentRegion ?? "us-east-1")).map((id) => ({ id })),
        ...(props?.privateEgressCidrs === undefined ? {} : { privateEgressCidrs: [...props.privateEgressCidrs, ...(props.modelEndpointCidrs ?? [])] }),
        ...(props?.bundledImages === true ? { bundledImages: true } : {}),
      });
      grantProviderKeySecrets(this, [modelProxy.taskRole.roleName]);
      // Ruling R28: the broker is outside the VPC, so it mints member keys and reads spend through this
      // VPC-attached function, the only reader of the master key besides the proxy. The broker may invoke it, and nothing else.
      // Lessons in production: with the Team record on, this function also makes the one model call of a learning reflection (`learningCompletion`, with a key the broker minted and reserved), which can take a
      // minute and a half. Its only step is that call (100 s at most), so 120 s covers it, and the broker waits 130 s. Off, its timeout is what it was and the operation is refused (no environment switch).
      const modelAccessFunction = packagedFunction(this, "ModelAccessFunction", "packages/broker/src/model-proxy/handler.ts", props?.teamRecord === undefined ? {} : { LEARNING_COMPLETION_ENABLED: "1" }, props?.teamRecord === undefined ? undefined : Duration.seconds(120));
      // A fixed name, like the broker's: the Bedrock source probe's role is one of the three the default boundary's AssumeOrgRoles statement names.
      (modelAccessFunction.role!.node.defaultChild as iam.CfnRole).roleName = modelAccessProbeRoleName(naming.env);
      new ModelAccess(this, "ModelAccess", {
        naming,
        vpcId,
        subnetIds: Fn.split(",", sessions.privateSubnetIds.valueAsString),
        proxy: modelProxy,
        handler: modelAccessFunction,
        ...(props?.privateEgressCidrs === undefined ? {} : { privateEgressCidrs: props.privateEgressCidrs }),
        ...(props?.customModelEndpoints === true ? { customModelEndpoints: true, customModelEndpointEnvironment: props.customModelEndpointEnvironment ?? {} } : {}),
      });
      modelAccessFunction.grantInvoke(broker);
      // Lessons in production (lane 2, WB-4): behind the Team record switch, the reflection queue and the LessonsWorker that runs it (it calls the model through the same in-VPC function, so it may invoke it).
      if (props?.teamRecord !== undefined && teamRecordResources !== undefined && developerSignInTable !== undefined) {
        attachLessonsWorker(this, {
          env: naming.env, context: props.teamRecord, broker, resources: teamRecordResources, state, artifacts, signInTable: developerSignInTable, modelAccessFunction,
          githubAppPrivateKeySecretArn: githubAppPrivateKeySecretArn.valueAsString,
          githubAppCredentialRef: githubAppCredentialRef.valueAsString, githubAppId: githubAppId.valueAsString, alarms: { name: (suffix) => naming.alarmName(suffix), action: notifyOperator }, ...(signInParameters === undefined ? {} : { learnedLessons: signInParameters.learnedLessonsEnabled.valueAsString }), ...(props.reservedConcurrency === false ? { reservedConcurrency: false } : {}),
        });
      }
      BrokerNames.of(broker).add("modelAccessFunction", modelAccessFunction.functionName);
      // Ruling R29: the proxy's address, which the broker hands a task's worker together with its key.
      // The load balancer's name, in the broker's names: the host is <name>.<region>.elb.amazonaws.com and the port is MODEL_PROXY_INFERENCE_PORT, so the broker builds the URL.
      BrokerNames.of(broker).add("modelProxy", modelProxy.loadBalancerName);
      // The worker asks for its key with the operation's callback capability, which the broker verifies; like the
      // setup execution read above, the one GET is exempt from the JWT authorizer.
      new apigwv2.CfnRoute(this, "ModelAccessRoute", {
        apiId: api.ref,
        routeKey: "GET /v1/internal/model-access",
        target: `integrations/${integration.ref}`,
        authorizationType: "NONE",
      });
    }
    // Optional standing transport for the EC2 E2E qualification runner (CDK context
    // agentx:e2eQualificationTransport=enabled, off by default; `-c key=value` always delivers a
    // string, so only the exact string "enabled" turns it on, like agentxInstaller and agentxEval,
    // and boolean true or "true" stay off): it reads its challenge and writes its
    // proposal, ready and status files in the artifact bucket, so no run needs temporary grants.
    // The keys are scoped by the IAM policy variable ${aws:userid}, which for an EC2 instance role
    // session is <role unique ID>:<instance ID>: of the instances sharing the worker role, each can
    // reach only e2e-runtime/<its own ID>/, so a worker running other code cannot read or plant
    // another instance's files. The variable is plain text in the resource ARN (CDK treats only
    // its own ${Token[...]} markers as tokens; the test pins the synthesized text). Exact object keys
    // only: no List, Delete or wildcard object access. Attached from this stack, like the provider
    // secrets above, because the bucket lives here and the foundation template stays untouched.
    if (this.node.tryGetContext("agentx:e2eQualificationTransport") === "enabled") {
      const ownPrefix = "e2e-runtime/${aws:userid}";
      new iam.CfnPolicy(this, "E2eQualificationTransport", {
        policyName: "E2eQualificationTransport",
        roles: [sessions.instanceRoleName],
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            { Sid: "ReadQualificationChallenge", Effect: "Allow", Action: "s3:GetObject", Resource: artifacts.arnForObjects(`${ownPrefix}/challenge.json`) },
            {
              Sid: "WriteQualificationProposalReadyAndStatus", Effect: "Allow", Action: "s3:PutObject",
              Resource: [artifacts.arnForObjects(`${ownPrefix}/proposal.json`), artifacts.arnForObjects(`${ownPrefix}/ready.json`), artifacts.arnForObjects(`${ownPrefix}/status.json`)],
            },
          ],
        },
      });
      // M1.4 Task 4.9: the model canary's request and result, exact keys under the same prefix. A policy of its own, so the guarded add-only change set of the
      // qualification-transport deploy unit adds it beside the deployed grant without modifying that grant.
      new iam.CfnPolicy(this, "E2eQualificationTransportCanary", {
        policyName: "E2eQualificationTransportCanary",
        roles: [sessions.instanceRoleName],
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            { Sid: "ReadModelCanaryRequest", Effect: "Allow", Action: "s3:GetObject", Resource: artifacts.arnForObjects(`${ownPrefix}/canary-request.json`) },
            { Sid: "WriteModelCanaryResult", Effect: "Allow", Action: "s3:PutObject", Resource: artifacts.arnForObjects(`${ownPrefix}/canary-result.json`) },
          ],
        },
      });
      // M1.4 Task 4.10C, read-only model discovery for the runner's worker (what the model check lists: Bedrock models and profiles, availability, and the tokens-per-minute quotas).
      // No invoke grant is added: the driving test uses BedrockModelInvocation, which already covers the foundation models and this account's inference profiles (global. included).
      // `bedrock:GetFoundationModelAvailability` is `*` because the action has no resource type in the Service Authorization Reference. The broker needs no grant of its own for the check keys: its role already reads and writes the artifact bucket. Named like the transport policies so the
      // qualification-transport unit adds it (prefix E2eQualificationTransport); its policy name is E2eModelDiscovery.
      new iam.CfnPolicy(this, "E2eQualificationTransportDiscovery", {
        policyName: "E2eModelDiscovery",
        roles: [sessions.instanceRoleName],
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            { Sid: "ListBedrockModels", Effect: "Allow", Action: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"], Resource: "*" },
            { Sid: "ReadBedrockModelAvailability", Effect: "Allow", Action: "bedrock:GetFoundationModelAvailability", Resource: "*" },
            { Sid: "ReadBedrockInferenceProfiles", Effect: "Allow", Action: "bedrock:GetInferenceProfile", Resource: `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/*` },
            { Sid: "ListBedrockQuotas", Effect: "Allow", Action: "servicequotas:ListServiceQuotas", Resource: "*" },
            { Sid: "ReadBedrockQuota", Effect: "Allow", Action: "servicequotas:GetServiceQuota", Resource: `arn:${Aws.PARTITION}:servicequotas:${Aws.REGION}:${Aws.ACCOUNT_ID}:bedrock/*` },
          ],
        },
      });
    }
    // AUTOREQUALIFY (AR-2): the machine that renews the browser and API test machine by itself. CDK context agentx:autoRequalify=enabled, off by default
    // (only the exact string "enabled" turns it on); named environments only. Its resources all carry the logical-ID prefix RuntimeRequalify, so the
    // requalify-infra deploy unit adds them to a live stack with an Add-only change set. The foundation's values are the stack parameters SessionLifecycle declared.
    if (naming.env !== undefined && this.node.tryGetContext(REQUALIFY_CONTEXT_KEY) === "enabled") {
      const foundationValue = (name: string): string => (this.node.findChild(name) as CfnParameter).valueAsString;
      const hour = Number(this.node.tryGetContext("agentx:autoRequalifyHourUtc") ?? REQUALIFY_DEFAULT_HOUR_UTC);
      new RuntimeRequalify(this, "RuntimeRequalify", {
        naming, state, artifacts, invokeSigningKey, operatorTopic: operatorAlerts, notifyOperator,
        catalogIds: { setup: projectSetupRuntimeCatalogId, feature: e2eFeatureRuntimeCatalogId }, controlPlaneUrl: api.attrApiEndpoint,
        foundation: {
          privateSubnetIds: foundationValue("PrivateSubnetIds"), launchTemplateId: foundationValue("Ec2WorkerLaunchTemplateId"), workerRoleArn: foundationValue("Ec2WorkerInstanceRoleArn"),
          workspaceKmsKeyArn: foundationValue("WorkspaceKmsKeyArn"), logGroupName: naming.ec2.workerLogGroupName,
        },
        ...(Number.isInteger(hour) && hour >= 0 && hour <= 23 ? { checkHourUtc: hour } : {}),
        scheduleEnabled: this.node.tryGetContext("agentx:autoRequalifySchedule") === "enabled",
      });
    }
    sessions.steps.addEnvironment("CONTROL_PLANE_URL", api.attrApiEndpoint);
    sessions.connectDispatcher(dispatcher);
    sessions.connectBroker(broker);

    // Spec 052 FR-006, FR-011: the eval batch tick. Every 2 minutes it records run ends the broker
    // missed, reconciles the eval slot counter, fills free slots through the broker's own run path
    // (startSwebenchRun: launch.json, then the eval state machine) and writes ended batches'
    // results. It also ends runs whose execution died without ending them (Ruling 13). The schedule
    // stays on: with no batch active a tick is three small DynamoDB reads (and a slot repair when a
    // slot is held), and nothing has to switch it off. Overlapping ticks are safe: every change is a conditional write.
    // Its 90-second timeout, like the broker's 30, must stay well below EVAL_BATCH_STALE_CLAIM_MS (5 minutes,
    // eval-batch.ts): a stale claim is recovered only once the top-up that made it is dead.
    const evalBatchTick = packagedFunction(this, "EvalBatchTick", "packages/broker/src/aws/eval-batch-tick.ts", {
      STATE_TABLE_NAME: state.tableName,
      ARTIFACT_BUCKET_NAME: artifacts.bucketName,
      CALLBACK_SIGNING_KEY: callbackSigningKey.valueAsString,
      SWEBENCH_SETTINGS_PREFIX: naming.ec2.workerSettingsPrefix,
    }, Duration.seconds(90));
    state.grantReadWriteData(evalBatchTick);
    // A run's launch.json (evals/<runId>/) and a batch's results (evals/batches/<id>/); it reads nothing there.
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({ sid: "WriteEvalObjects", actions: ["s3:PutObject"], resources: [artifacts.arnForObjects("evals/*")] }));
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadEvalSettings", actions: ["ssm:GetParameters"], resources: evalSettingArns }));
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({ sid: "StartEvalRuns", actions: ["states:StartExecution"], resources: [swebenchStateMachineArn] }));
    // Ruling 16: a dead run's instance, ended before the run is charged; this environment's eval instances only.
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({
      sid: "TerminateDeadEvalInstances",
      actions: ["ec2:TerminateInstances"],
      resources: [`arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`],
      conditions: { StringEquals: { "aws:ResourceTag/DeploymentMode": SWEBENCH_DEPLOYMENT_MODE, "aws:ResourceTag/Environment": naming.environmentTagValue } },
    }));
    // Ruling 13: whether a stuck run's execution is still alive; the eval state machine's executions only.
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({
      sid: "DescribeEvalRuns",
      actions: ["states:DescribeExecution"],
      resources: [this.formatArn({ service: "states", resource: "execution", resourceName: `${swebenchNames(naming).stateMachineName}:*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));
    new scheduler.Schedule(this, "EvalBatchTickSchedule", {
      description: "Runs the AgentX eval batch tick",
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(2)),
      target: new schedulerTargets.LambdaInvoke(evalBatchTick, {}),
    });
    new cloudwatch.Alarm(this, "EvalBatchTickErrorsAlarm", {
      alarmName: naming.alarmName("EvalBatchTickErrors"),
      alarmDescription: "The eval batch tick failed in each of the last three 5-minute periods; batches may not start runs, record ends or write results. Check the tick's logs.",
      metric: evalBatchTick.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // Spec 052 Ruling 31 (review M-2): the eval state machine fails an execution only at its
    // SlotReleaseFailed state, a run it could not end with its slot released. The alarm lives here,
    // where the release deploys it, rather than in the eval stack, which is deployed by hand.
    new cloudwatch.Alarm(this, "EvalExecutionsFailedAlarm", {
      alarmName: naming.alarmName("EvalExecutionsFailed"),
      alarmDescription: "An eval run's execution failed (SlotReleaseFailed): the state machine could not end the run and release its eval slot. The batch tick repairs the slot within minutes; check the execution's cause and the run's record.",
      metric: new cloudwatch.Metric({
        namespace: "AWS/States",
        metricName: "ExecutionsFailed",
        dimensionsMap: { StateMachineArn: this.formatArn({ service: "states", resource: "stateMachine", resourceName: swebenchNames(naming).stateMachineName, arnFormat: ArnFormat.COLON_RESOURCE_NAME }) },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // Spec 052 Ruling 31 (review M-1): the Slack service's batch watcher logs each failure as an
    // eval_batch_watch.* error line, which its log group's filter counts (slack-orchestrator.ts).
    // The broker's watch list logs its own (a running batch whose channel is unbound or rebound, a
    // dropped or unreadable batch) the same way, counted here into the same metric (R-1).
    broker.logGroup.addMetricFilter("EvalBatchWatcherFailedMetric", {
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue("$.event", "=", "eval_batch_watch.*"),
        logs.FilterPattern.stringValue("$.level", "=", "error"),
      ),
      metricNamespace: naming.metricsNamespace,
      metricName: "EvalBatchWatcherFailed",
      metricValue: "1",
    });
    new cloudwatch.Alarm(this, "EvalBatchWatcherErrorsAlarm", {
      alarmName: naming.alarmName("EvalBatchWatcherErrors"),
      alarmDescription: "The Slack service's eval batch watcher failed: a batch's thread may miss its progress or summary, or a batch was dropped. Check the Slack orchestrator and broker logs for eval_batch_watch.* errors.",
      metric: agentxSum("EvalBatchWatcherFailed", Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // Plan 2, Task 14: a failed owners' notice after an approved GitHub request binds (the item stays for the hourly sweep, which retries it).
    // The broker logs it as a JSON line; this filter turns it into a metric an alarm can watch. Rovara Cloud only, like the sweep that logs it.
    if (props?.cloud === true && naming.env !== undefined) {
      broker.logGroup.addMetricFilter("GithubInstallRequestNoticeFailedMetric", {
        filterPattern: logs.FilterPattern.stringValue("$.event", "=", "github.install_request_notice_failed"),
        metricNamespace: naming.metricsNamespace,
        metricName: "GithubInstallRequestNoticeFailed",
        metricValue: "1",
      });
    }

    // Plan 4 Task 8 (R41), named environments only: an autonomous chain run's write must always have approvers. When the selector Plan 3's agent-tools call asks for them
    // throws, times out or answers what it must not, the write falls back to Plan 3's default approvers and the broker logs `write_approver_selector.failed`. This counts
    // those lines and alarms on any in 5 minutes, so a selector that has stopped working is seen, as the egress alarms are. The legacy template stays as it is.
    if (naming.env !== undefined) {
      broker.logGroup.addMetricFilter("ChainWriteApproverSelectorFailuresMetric", {
        filterPattern: logs.FilterPattern.stringValue("$.event", "=", "write_approver_selector.failed"),
        metricNamespace: naming.metricsNamespace,
        metricName: "ChainWriteApproverSelectorFailures",
        metricValue: "1",
      });
      new cloudwatch.Alarm(this, "ChainWriteApproverSelectorFailedAlarm", {
        alarmName: naming.alarmName("ChainWriteApproverSelectorFailed"),
        alarmDescription: "The selector that chooses who approves an autonomous chain run's write failed, so the write fell back to the default approvers (the run's owner and the project's maintainers). Check the broker logs for write_approver_selector.failed lines and the task they name.",
        metric: agentxSum("ChainWriteApproverSelectorFailures", Duration.minutes(5)),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notifyOperator);
    }

    new CfnOutput(this, "ApiEndpoint", { value: api.attrApiEndpoint });
    new CfnOutput(this, "StateTableName", { value: state.tableName });
    new CfnOutput(this, "ArtifactBucketName", { value: artifacts.bucketName });
    new CfnOutput(this, "DispatchDeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new CfnOutput(this, "SlackEventsUrl", { value: `${api.attrApiEndpoint}/v1/slack/events` });
    new CfnOutput(this, "GithubWebhookUrl", { value: `${api.attrApiEndpoint}/v1/github/webhooks` });
    new CfnOutput(this, "SlackInteractivityUrl", { value: `${api.attrApiEndpoint}/v1/slack/interactions` });
    new CfnOutput(this, "SlackSecretArn", { value: slackSecret.secretArn });
    new CfnOutput(this, "SlackRequestQueueUrl", { value: slackRequestQueue.queueUrl });
    new CfnOutput(this, "SlackRequestDeadLetterQueueUrl", { value: slackDeadLetterQueue.queueUrl });
    new CfnOutput(this, "SlackThreadsTableName", { value: slackThreads.tableName });
    new CfnOutput(this, "SlackThreadSessionBucketName", { value: threadSessions.bucketName });
    new CfnOutput(this, "SlackOrchestratorTaskRoleArn", { value: slackOrchestratorRole.roleArn });
    new CfnOutput(this, "TurnRecordsTableName", { value: turnRecords.tableName });
    new CfnOutput(this, "OperatorAlertsTopicArn", { value: operatorAlerts.topicArn });
    if (modelProxy !== undefined) {
      new CfnOutput(this, "ModelProxyUrl", { value: modelProxy.url });
      // The Slack orchestrator stack admits itself to the proxy load balancer with this group (Task 13).
      new CfnOutput(this, "ModelProxySecurityGroupId", { value: modelProxy.loadBalancerSecurityGroup.attrGroupId });
      new CfnOutput(this, "ModelProxyMasterKeySecretArn", { value: modelProxy.masterKeySecret.secretArn });
    }
  }
}

export function packagedFunction(
  scope: Construct,
  id: string,
  entry: string,
  environment: Record<string, string>,
  timeout = Duration.seconds(30),
  /** Files copied beside the bundled handler, as [absolute source, name in the bundle]. */
  extraFiles: ReadonlyArray<readonly [string, string]> = [],
  memorySize = 512,
  /** Directories copied beside the handler, as [absolute source, name in the bundle]. */
  extraDirectories: ReadonlyArray<readonly [string, string]> = [],
  tracing = lambda.Tracing.ACTIVE,
  /** The exported handler of the entry module (default `handler`); a second Lambda can use another export of the same bundle. */
  handler = "handler",
): lambdaNodejs.NodejsFunction {
  return new lambdaNodejs.NodejsFunction(scope, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: resolve(process.cwd(), entry),
    handler,
    timeout,
    memorySize,
    tracing,
    environment,
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    }),
    bundling: {
      externalModules: [],
      minify: true,
      sourceMap: true,
      target: "node22",
      ...(extraFiles.length === 0 && extraDirectories.length === 0 ? {} : {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => {
            const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
            return [...extraFiles.map(([source, name]) => `cp ${quote(source)} ${quote(`${outputDir}/${name}`)}`), ...extraDirectories.map(([source, name]) => `cp -R ${quote(source)} ${quote(`${outputDir}/${name}`)}`)];
          },
        },
      }),
    },
  });
}
