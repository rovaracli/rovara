/**
 * What the broker is given in two variables, AGENTX_NAMES and AGENTX_SETTINGS, and what it builds itself (derived-names.ts). ENV-ROOM (owner decision 2026-10-24): a value the
 * broker can derive is not passed at all (derived-names.ts); a true input is passed once, compactly, here.
 *
 * The names the broker is given in one variable, AGENTX_NAMES (Plan 3 final review C1).
 *
 * Lambda holds all of a function's environment variables, keys and values together, to 4 KB, and the broker's passed it: every
 * resource CloudFormation names for it is `<stack>-<LogicalId>-<random>`, 60 to 90 characters, and a variable's name is as long again.
 * So the control plane gives the broker one JSON object of names under two-letter codes, and the broker (`hydrateBrokerEnvironment`)
 * puts each back under the variable the rest of its code already reads. A name that the code can turn into a URL or an ARN (from the
 * region, the account and the environment) is passed as the bare name or id, and its `kind` says what it is turned into.
 *
 * The infrastructure and the broker both take this table, so a name that is added to one cannot be missing from the other.
 */
export const BROKER_NAMES_VARIABLE = "AGENTX_NAMES";

/**
 * How AGENTX_NAMES and AGENTX_SETTINGS are written: `code=value` pairs joined by commas (`ts=agentx-staging-table,ar=agentx-staging-bucket`). Lambda counts a function's variables as
 * the JSON of the map, so every quote inside a variable's value costs two bytes (`\"`), and the inner JSON this replaced had four per entry: about 8 bytes an entry, 300 for the
 * broker. The values hold no quote, comma, equals sign, brace, slash or space (the control plane refuses a parameter or a literal that could, infra/lib/broker-names.ts), so
 * nothing is escaped. The earlier revision's JSON object is still read (it starts with `{`) for one release, so a rollout in either direction starts; remove that branch after.
 */
export type BrokerListEntries = { entries: Array<[string, unknown]> } | { error: string };

export function decodeBrokerList(raw: string): BrokerListEntries {
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "is not an object" };
      return { entries: Object.entries(parsed) };
    } catch {
      return { error: "is not JSON" };
    }
  }
  const entries: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  for (const pair of raw.split(",")) {
    const match = /^([a-z]{2})=([^=]*)$/.exec(pair);
    if (match === null) return { error: "is not a list of code=value pairs" };
    if (seen.has(match[1]!)) return { error: `names the code ${match[1]} twice` };
    seen.add(match[1]!);
    entries.push([match[1]!, match[2]!]);
  }
  return { entries };
}

export type BrokerNameKind =
  /** Used as it is. */
  | "name"
  /** A queue's name; the variable gets its URL. */
  | "queueUrl"
  /** A KMS key's id; the variable gets its ARN. */
  | "kmsKeyArn"
  /** A state machine's name; the variable gets its ARN. */
  | "stateMachineArn"
  /** A Lambda function's name; the variable gets its ARN (`arn:<partition>:lambda:<region>:<account>:function:<name>`). */
  | "lambdaFunctionArn"
  /** A role's name, in the environment's role path; the variable gets its ARN. */
  | "roleArn"
  /** A Cognito user pool's id; the variable gets the pool's issuer URL (`https://cognito-idp.<region>.amazonaws.com/<id>`). */
  | "cognitoIssuer"
  /** An HTTP API's id; the variable gets the control plane's sign-in issuer (`https://<id>.execute-api.<region>.amazonaws.com/v1/auth`). */
  | "apiIssuer"
  /** An AppSync Events API's DNS prefix (the first label of its `Dns.Http` host, which is not the API's id); the variable gets its HTTP endpoint (`https://<prefix>.appsync-api.<region>.amazonaws.com/event`). */
  | "eventApiEndpoint"
  /** An internal load balancer's name (the first label of its DNS name); the variable gets `http://<name>.<region>.elb.amazonaws.com:<inference port>`. */
  | "modelProxyUrl"
  /** A dead-letter queue's name, which the health route lists under `label`; the variable gets the JSON of every such queue, `{ label: URL }`. */
  | "deadLetterQueue";

export interface BrokerNameSpec {
  /** The key in AGENTX_NAMES: two letters, so the whole object stays small. */
  readonly code: string;
  /** The variable the broker's code reads the value as. */
  readonly variable: string;
  readonly kind: BrokerNameKind;
  /** For a dead-letter queue: how the health route names it. */
  readonly label?: string;
}

export const BROKER_NAMES = {
  // ENV-ROOM: the State table and the artifact bucket, the EC2 workers' launch template and the project allow list were variables of their own; their names were already the
  // longest values in the broker's environment, and a variable's key doubles the cost.
  stateTable: { code: "ts", variable: "STATE_TABLE_NAME", kind: "name" },
  artifactBucket: { code: "ar", variable: "ARTIFACT_BUCKET_NAME", kind: "name" },
  launchTemplate: { code: "lt", variable: "EC2_WORKER_LAUNCH_TEMPLATE_ID", kind: "name" },
  projectAllowList: { code: "pl", variable: "AGENT_PROJECT_ALLOW_LIST_ID", kind: "name" },
  modelProxy: { code: "mp", variable: "MODEL_PROXY_URL", kind: "modelProxyUrl" },
  auditLedgerTable: { code: "al", variable: "AUDIT_LEDGER_TABLE_NAME", kind: "name" },
  auditSealsTable: { code: "as", variable: "AUDIT_SEALS_TABLE_NAME", kind: "name" },
  auditKeysTable: { code: "ak", variable: "AUDIT_KEYS_TABLE_NAME", kind: "name" },
  auditExportsBucket: { code: "ab", variable: "AUDIT_EXPORTS_BUCKET_NAME", kind: "name" },
  auditExportFunction: { code: "af", variable: "AUDIT_EXPORT_FUNCTION_NAME", kind: "name" },
  // The audit intake queue has a fixed name (auditIntakeQueueName), so the broker derives its URL: see DERIVED_BROKER_VARIABLES.
  auditVaultKey: { code: "av", variable: "AUDIT_VAULT_KEY_ARN", kind: "kmsKeyArn" },
  signInTable: { code: "st", variable: "DEVELOPER_SIGNIN_TABLE_NAME", kind: "name" },
  identityFunction: { code: "if", variable: "DEVELOPER_IDENTITY_FUNCTION_NAME", kind: "name" },
  slackThreadsTable: { code: "sl", variable: "SLACK_THREADS_TABLE_NAME", kind: "name" },
  turnRecordsTable: { code: "tr", variable: "TURN_RECORDS_TABLE_NAME", kind: "name" },
  planEvidenceFunction: { code: "pe", variable: "PLAN_EVIDENCE_FUNCTION_NAME", kind: "name" },
  // Live interaction A2 (peek): the dispatcher the broker invokes to read a running task's working tree for an Ask. The broker holds lambda:InvokeFunction on this one function and nothing else (control-plane.ts).
  dispatcherFunction: { code: "dp", variable: "DISPATCHER_FUNCTION_ARN", kind: "lambdaFunctionArn" },
  modelAccessFunction: { code: "ma", variable: "MODEL_ACCESS_FUNCTION_NAME", kind: "name" },
  slackRequestQueue: { code: "sq", variable: "SLACK_REQUEST_QUEUE_URL", kind: "queueUrl" },
  slackOrchestratorRole: { code: "so", variable: "SLACK_ORCHESTRATOR_ROLE_ARN", kind: "roleArn" },
  chatGptConnectionKey: { code: "ck", variable: "CHATGPT_CONNECTION_KEY_ARN", kind: "kmsKeyArn" },
  provisionerStateMachine: { code: "pv", variable: "PROVISIONER_ARN", kind: "stateMachineArn" },
  deleterStateMachine: { code: "dl", variable: "DELETER_ARN", kind: "stateMachineArn" },
  cloudUserPool: { code: "ci", variable: "DEVELOPER_CLOUD_ISSUER", kind: "cognitoIssuer" },
  signInApi: { code: "ti", variable: "DEVELOPER_TOKEN_ISSUER", kind: "apiIssuer" },
  realtimeApi: { code: "rt", variable: "REALTIME_HTTP_ENDPOINT", kind: "eventApiEndpoint" },
  dispatchDeadLetters: { code: "dq", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "dispatch" },
  slackRequestDeadLetters: { code: "sr", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "slack-requests" },
  developerNoticeDeadLetters: { code: "dn", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "developer-notices" },
  developerNoticeStreamFailures: { code: "ds", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "developer-notice-stream" },
  // Team record (wire-team-record; present only when the install is synthesised with `agentxTeamRecord=enabled`): the role the broker assumes, with a per-workspace session policy, for every vector call.
  teamRecordVectorsRole: { code: "vr", variable: "TEAM_RECORD_VECTORS_ROLE_ARN", kind: "roleArn" },
  // Team record, Enterprise: the customer's KMS key (its id; the broker builds the ARN in this account and region), named in each workspace's vector session policy.
  // (The Team record's dead-letter queue, listed on the health route as `team-record`, has a fixed name and is derived by the broker, not passed: `teamRecordOpsDeadLetterName`, ENV-ROOM. Code `tq` is retired.)
  teamRecordKmsKey: { code: "tk", variable: "TEAM_RECORD_KMS_KEY_ARN", kind: "kmsKeyArn" },
  // Saved project images (SV wiring): the key the repositories' creation template encrypts with (the stack's own, or the Enterprise customer's). The broker compares what ECR reports of a repository with it. Passed as the key's id.
  savedEnvKey: { code: "sk", variable: "SAVED_ENV_KMS_KEY_ARN", kind: "kmsKeyArn" },
} as const satisfies Record<string, BrokerNameSpec>;

export type BrokerNameKey = keyof typeof BROKER_NAMES;

/**
 * The broker's settings, in one variable, AGENTX_SETTINGS: a JSON object of values under two-letter codes, as AGENTX_NAMES is. A setting here is a CloudFormation parameter
 * whose value is constrained to plain text already (an enum, a number, a Slack team id), so the control plane can join the pairs from the parameters without escaping anything
 * (infra/lib/broker-names.ts), and the broker checks each value is plain (`BROKER_SETTING_VALUE`) before it puts it back under the variable its code reads. A variable's
 * key is the longest part of a short value (`AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED` is 46 bytes, `"tv":` is 5), which is why these are folded.
 *
 * A value that is free text (an issuer URL, an email address) does not belong here: it could carry a quote. It stays a variable of its own, or it is derived.
 */
export const BROKER_SETTINGS_VARIABLE = "AGENTX_SETTINGS";

/** What a setting's value may be: letters, digits and `. _ : -`, at most 64 characters, or empty. */
export const BROKER_SETTING_VALUE = /^[A-Za-z0-9._:-]{0,64}$/;

export interface BrokerSettingSpec {
  /** The key in AGENTX_SETTINGS: two letters. */
  readonly code: string;
  /** The variable the broker's code reads the value as. */
  readonly variable: string;
}

export const BROKER_SETTINGS = {
  memberWorkspaceLimit: { code: "ml", variable: "SLACK_MEMBER_WORKSPACE_LIMIT" },
  organizationWorkspaceLimit: { code: "ol", variable: "SLACK_ORGANIZATION_WORKSPACE_LIMIT" },
  taskPeopleChanges: { code: "tc", variable: "AGENTX_TASK_PEOPLE_CHANGES_ENABLED" },
  taskPeoplePublicInvitations: { code: "tu", variable: "AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED" },
  taskPeoplePrivateInvitations: { code: "tv", variable: "AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED" },
  workflowDependencies: { code: "wd", variable: "AGENTX_WORKFLOW_DEPENDENCIES_ENABLED" },
  slackTeamId: { code: "tm", variable: "SLACK_TEAM_ID" },
  signInSlack: { code: "ss", variable: "DEVELOPER_SIGNIN_SLACK" },
  signInSlackSince: { code: "sn", variable: "DEVELOPER_SIGNIN_SLACK_SINCE" },
  oidcSince: { code: "os", variable: "DEVELOPER_OIDC_SINCE" },
  mcpConfirmElicitation: { code: "mc", variable: "MCP_CONFIRM_ELICITATION" },
  // Rovara Code v2, on per environment (stack parameter RovaraCodeV2Enabled, off by default): the broker reads it as rovaraCodeV2Live.
  rovaraCodeV2: { code: "rv", variable: "AGENTX_ROVARA_CODE_V2_ENABLED" },
  // Mainline #408 kill switches (stack parameters PlanSelfCheckEnabled and AutofixEnabled, on by default): the broker reads them as PLAN_SELF_CHECK_ENABLED and AUTOFIX_ENABLED. Packed settings, not Lambda variables (ENV-ROOM).
  planSelfCheck: { code: "pc", variable: "PLAN_SELF_CHECK_ENABLED" },
  autofix: { code: "fx", variable: "AUTOFIX_ENABLED" },
  // Live steer kill switch (stack parameter LiveSteerEnabled, "0" by default): the broker reads it as LIVE_STEER_ENABLED, and live steer is on only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  liveSteer: { code: "ls", variable: "LIVE_STEER_ENABLED" },
  // Live interaction A3: Ask about this task (stack parameter LiveAskEnabled, "0" by default): the broker reads it as LIVE_ASK_ENABLED, and Ask is on only when it is exactly "1". Hard-gated (live-interaction.ts
  // LIVE_INTERACTION_DEPLOY_GATES): the person-erasure Asks step and the daily upkeep that deletes Asks past their 30 days must exist. Packed setting, not a Lambda variable (ENV-ROOM).
  liveAsk: { code: "ak", variable: "LIVE_ASK_ENABLED" },
  // v1.2 learning loop: the install-wide default of the company's master "suggestions" switch (stack parameter LearningSuggestionsDefault, off by default): learning/suggestions-switch.ts reads it.
  learningSuggestionsDefault: { code: "lg", variable: "LEARNING_SUGGESTIONS_DEFAULT" },
  // Stop & redirect kill switch (live-interaction design, switch `rd`; stack parameter LiveRedirectEnabled, "0" by default): the broker reads it as LIVE_REDIRECT_ENABLED, and the redirect route exists only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  liveRedirect: { code: "rd", variable: "LIVE_REDIRECT_ENABLED" },
  // Live interaction F2 to F4: Fix with agent (diagnosis; switch `fd`, stack parameter LiveFixEnabled, "0" by default): the broker reads it as LIVE_FIX_ENABLED, and the diagnosis routes exist only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  liveFix: { code: "fd", variable: "LIVE_FIX_ENABLED" },
  // DG-3: the most Rovara pays for Fix with agent's light diagnoses across all companies of the install in a UTC day, in cents (stack parameter LiveFixRovaraPaidDailyCents, 10000 by default; 0 pauses them). A number, so it is plain text. Packed setting, not a Lambda variable (ENV-ROOM).
  liveFixRovaraPaidCents: { code: "fg", variable: "LIVE_FIX_ROVARA_PAID_DAILY_CENTS" },
  // Team record (wire-team-record). Present ONLY when the install is synthesised with `agentxTeamRecord=enabled`; absent otherwise, and the broker reads absence as OFF. The broker treats the record as
  // on only when TEAM_RECORD_ENABLED is exactly "1". The embedding model id and the lake flag are install parameters of the storage (infra/lib/team-record-edition.ts).
  teamRecord: { code: "tn", variable: "TEAM_RECORD_ENABLED" },
  // Passed only when it is not the default (amazon.titan-embed-text-v2:0): the broker reads an unset model as the default (team-record/runtime.ts), so the usual install passes nothing (ENV-ROOM).
  teamRecordEmbeddingModel: { code: "te", variable: "TEAM_RECORD_EMBEDDING_MODEL_ID" },
  teamRecordLake: { code: "tl", variable: "TEAM_RECORD_LAKE_ENABLED" },
  // Proof and evidence (wire-proof): the evidence of a task's checks is gathered, kept and shown (the PR's evidence lines and link, the task page's Evidence tab, the download route). Stack parameter ProofEvidenceEnabled, "0" by default: the broker reads it as PROOF_EVIDENCE_ENABLED, and it is on only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  proofEvidence: { code: "pe", variable: "PROOF_EVIDENCE_ENABLED" },
  // Decision cards (wire-proof): the card routes (`/v1/app/decisions*`) and the Slack card press. Stack parameter DecisionCardsEnabled, "0" by default: the broker reads it as DECISION_CARDS_ENABLED, and the routes exist only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  decisionCards: { code: "dk", variable: "DECISION_CARDS_ENABLED" },
  // Test environment (wire-testenv): the project's approved test setup (the setup routes, the task's checks, the nightly run, the evidence's environment line). Stack parameter TestEnvironmentEnabled, "0" by default: the broker reads it as TEST_ENVIRONMENT_ENABLED, and it is on only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  testEnvironment: { code: "ev", variable: "TEST_ENVIRONMENT_ENABLED" },
  // Lessons reach the agent (follow-up S3 of the wire-lessons review): approved lessons are loaded into an agent's prompt only when this install switch is exactly "1". Stack parameter LearnedLessonsEnabled, "0" by default, SEPARATE from the Team record flag (`tn`): turning the record on to collect and show things does not, by itself, send a lesson to an agent. The broker reads it as LEARNED_LESSONS_ENABLED. Packed setting, not a Lambda variable (ENV-ROOM).
  learnedLessons: { code: "ll", variable: "LEARNED_LESSONS_ENABLED" },
  // Four test results (setup and test health SH20): the result words on a task and its pull request, the Fix setup card and the Testing section. Stack parameter VerifyResultsEnabled, "0" by default: the broker reads it as VERIFY_RESULTS_ENABLED, and it is on only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  verifyResults: { code: "vx", variable: "VERIFY_RESULTS_ENABLED" },
  // Project registries (N9, INTG2): a project's private package registries reach the worker's setup. Present ONLY when the install is synthesised with `rovaraCodeArtifactDomains` (infra/lib/registry-access.ts), which also grants the broker the one named CodeArtifact domain; absent otherwise, and the broker reads absence as OFF. On only when exactly "1" (project-registries/switch.ts). Packed setting, not a Lambda variable (ENV-ROOM).
  projectRegistries: { code: "pr", variable: "PROJECT_REGISTRIES_ENABLED" },
  // Second review by a different AI company (setup-test-health SH34): an added second opinion on a task's code from a model of another company, in shadow (never blocks) and then on. Stack parameter SecondReviewEnabled, "0" by default: the broker reads it as SECOND_REVIEW_ENABLED, and it is on only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  secondReview: { code: "cr", variable: "SECOND_REVIEW_ENABLED" },
  // Company setup recipes as a proposal source (setup-test-health SH30): approved company recipes are offered to a project's setup run and cited `recipe:` on what they add (still proved and confirmed). Stack parameter SetupRecipesEnabled, "0" by default: the broker reads it as SETUP_RECIPES_ENABLED, and it is on only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  setupRecipes: { code: "sp", variable: "SETUP_RECIPES_ENABLED" },
  // Nightly health (setup-test-health SH28, switch `nh`): the nightly run decides the project's health ("Setup needs repair" with a Fix setup card, a start banner, an optional proposed fix task). Stack parameter NightlyHealthEnabled, "0" by default: the broker reads it as NIGHTLY_HEALTH_ENABLED, and it is on only when it is exactly "1". Packed setting, not a Lambda variable (ENV-ROOM).
  nightlyHealth: { code: "nh", variable: "NIGHTLY_HEALTH_ENABLED" },
  // Setup agent (sh-setup-wire, SH14; design setup-test-health switch `su`): "Set up this project" can start a live setup run that runs commands in a setup sandbox, and the host-ask cards and the run's routes exist. Stack parameter SetupAgentEnabled, "0" by default: the broker reads it as SETUP_AGENT_ENABLED, and the setup agent is on only when it is exactly "1". Hard-gated at deploy by the five Linux checks of deferred check SH-1 (the per-run network and the DNS watch helper). Packed setting, not a Lambda variable (ENV-ROOM).
  setupAgent: { code: "su", variable: "SETUP_AGENT_ENABLED" },
  // Saved environments (setup-test-health SH25, switch `sv`): a project's proven setup is built into an image, kept in the registry and used by tasks. Stack parameter SavedEnvEnabled, "0" by default: the broker reads it as SAVED_ENV_ENABLED and it is on only when exactly "1". With it off nothing is built, pushed, pulled or sent to a worker. Packed setting, not a Lambda variable (ENV-ROOM).
  savedEnv: { code: "sv", variable: "SAVED_ENV_ENABLED" },
  // Test services (test-services.md TS37, switches `tx`, `ta` and `pj`): each is a stack parameter, "0" by default, that reaches the broker as the variable named here, and is on only when it is exactly "1". Nothing reads them yet; while they are off nothing new is reachable and every refusal stays as it is. `tx`: dependencies get a backing (real software, Rovara local AWS, fakes) on a sealed per-run network. Hard-gated at deploy by the Linux checks TS-L1 to TS-L6 (scripts/linux-check-test-services.sh). Packed settings, not Lambda variables (ENV-ROOM).
  testServices: { code: "tx", variable: "TEST_SERVICES_ENABLED" },
  // `ta`: a project may use the customer's own test accounts (a second admin approves each). Needs `tx`.
  testAccounts: { code: "ta", variable: "TEST_ACCOUNTS_ENABLED" },
  // `pj`: a project may bring its own images (reviewed compose services, a model image). Needs `tx`.
  projectImages: { code: "pj", variable: "PROJECT_IMAGES_ENABLED" },
} as const satisfies Record<string, BrokerSettingSpec>;

export type BrokerSettingKey = keyof typeof BROKER_SETTINGS;
