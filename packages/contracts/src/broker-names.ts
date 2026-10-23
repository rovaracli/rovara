/**
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

export type BrokerNameKind =
  /** Used as it is. */
  | "name"
  /** A queue's name; the variable gets its URL. */
  | "queueUrl"
  /** A KMS key's id; the variable gets its ARN. */
  | "kmsKeyArn"
  /** A state machine's name; the variable gets its ARN. */
  | "stateMachineArn"
  /** A role's name, in the environment's role path; the variable gets its ARN. */
  | "roleArn"
  /** A Cognito user pool's id; the variable gets the pool's issuer URL (`https://cognito-idp.<region>.amazonaws.com/<id>`). */
  | "cognitoIssuer"
  /** An HTTP API's id; the variable gets the control plane's sign-in issuer (`https://<id>.execute-api.<region>.amazonaws.com/v1/auth`). */
  | "apiIssuer"
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
  auditLedgerTable: { code: "al", variable: "AUDIT_LEDGER_TABLE_NAME", kind: "name" },
  auditSealsTable: { code: "as", variable: "AUDIT_SEALS_TABLE_NAME", kind: "name" },
  auditKeysTable: { code: "ak", variable: "AUDIT_KEYS_TABLE_NAME", kind: "name" },
  auditExportsBucket: { code: "ab", variable: "AUDIT_EXPORTS_BUCKET_NAME", kind: "name" },
  auditExportFunction: { code: "af", variable: "AUDIT_EXPORT_FUNCTION_NAME", kind: "name" },
  auditIntakeQueue: { code: "aq", variable: "AUDIT_INTAKE_QUEUE_URL", kind: "queueUrl" },
  auditVaultKey: { code: "av", variable: "AUDIT_VAULT_KEY_ARN", kind: "kmsKeyArn" },
  signInTable: { code: "st", variable: "DEVELOPER_SIGNIN_TABLE_NAME", kind: "name" },
  identityFunction: { code: "if", variable: "DEVELOPER_IDENTITY_FUNCTION_NAME", kind: "name" },
  slackThreadsTable: { code: "sl", variable: "SLACK_THREADS_TABLE_NAME", kind: "name" },
  turnRecordsTable: { code: "tr", variable: "TURN_RECORDS_TABLE_NAME", kind: "name" },
  planEvidenceFunction: { code: "pe", variable: "PLAN_EVIDENCE_FUNCTION_NAME", kind: "name" },
  modelAccessFunction: { code: "ma", variable: "MODEL_ACCESS_FUNCTION_NAME", kind: "name" },
  slackRequestQueue: { code: "sq", variable: "SLACK_REQUEST_QUEUE_URL", kind: "queueUrl" },
  slackOrchestratorRole: { code: "so", variable: "SLACK_ORCHESTRATOR_ROLE_ARN", kind: "roleArn" },
  chatGptConnectionKey: { code: "ck", variable: "CHATGPT_CONNECTION_KEY_ARN", kind: "kmsKeyArn" },
  provisionerStateMachine: { code: "pv", variable: "PROVISIONER_ARN", kind: "stateMachineArn" },
  deleterStateMachine: { code: "dl", variable: "DELETER_ARN", kind: "stateMachineArn" },
  cloudUserPool: { code: "ci", variable: "DEVELOPER_CLOUD_ISSUER", kind: "cognitoIssuer" },
  signInApi: { code: "ti", variable: "DEVELOPER_TOKEN_ISSUER", kind: "apiIssuer" },
  dispatchDeadLetters: { code: "dq", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "dispatch" },
  slackRequestDeadLetters: { code: "sr", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "slack-requests" },
  developerNoticeDeadLetters: { code: "dn", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "developer-notices" },
  developerNoticeStreamFailures: { code: "ds", variable: "HEALTH_DEAD_LETTER_QUEUES", kind: "deadLetterQueue", label: "developer-notice-stream" },
} as const satisfies Record<string, BrokerNameSpec>;

export type BrokerNameKey = keyof typeof BROKER_NAMES;
