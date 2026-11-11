// The appender function: an SQS batch handler on the FIFO intake queue (batches of ten, ReportBatchItemFailures).
// Messages are processed in order and processing stops at the first failure; that message and every later one in the
// batch are reported, which is AWS's guidance for FIFO partial batches. Stopping across groups too keeps the rule simple
// at the cost of redelivering a few other orgs' messages, which the event claims make harmless.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AuditEventInputSchema, type AuditEventInput } from "@agentx/cloud-contracts";
import { requiredEnvironment } from "../aws/lambda.js";
import { appendEvent, type AppenderDeps } from "./appender.js";
import { AuditKeyring } from "./keyring.js";
import { describeInvalidAuditEvent } from "./outbox.js";

export interface AuditSqsMessage {
  messageId: string;
  body: string;
  attributes?: Record<string, string | undefined>;
}

export interface AuditSqsEvent {
  Records: AuditSqsMessage[];
}

export interface AuditSqsBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

class InvalidAuditMessage extends Error {
  constructor(readonly entry: Record<string, unknown>) {
    super("audit appender: invalid message");
    this.name = "InvalidAuditMessage";
  }
}

/** The event in a message, or an InvalidAuditMessage whose log entry holds paths and codes, never a value. */
function parseMessage(message: AuditSqsMessage): AuditEventInput {
  let body: unknown;
  try {
    body = JSON.parse(message.body);
  } catch {
    throw new InvalidAuditMessage({ event: "audit.record_invalid", level: "error", issues: [{ path: [], code: "invalid_json" }] });
  }
  const parsed = AuditEventInputSchema.safeParse(body);
  if (!parsed.success) throw new InvalidAuditMessage(describeInvalidAuditEvent(body));
  // One appender at a time per org depends on the message group being the org: a message in another group is not trusted.
  if (message.attributes?.MessageGroupId !== parsed.data.orgId) {
    throw new InvalidAuditMessage({ ...describeInvalidAuditEvent(body), issues: [{ path: ["orgId"], code: "message_group_mismatch" }] });
  }
  return parsed.data;
}

export async function processAuditBatch(deps: AppenderDeps, event: AuditSqsEvent): Promise<AuditSqsBatchResponse> {
  for (const [index, message] of event.Records.entries()) {
    let parsed: AuditEventInput | undefined;
    try {
      parsed = parseMessage(message);
      const { result, seq } = await appendEvent(deps, parsed);
      // Ids, the action and the sequence number: nothing a person could ask to have erased.
      deps.log({ event: result === "appended" ? "audit.appended" : "audit.duplicate", eventId: parsed.eventId, orgId: parsed.orgId, action: parsed.action, ...(seq === undefined ? {} : { seq }) });
    } catch (error) {
      if (error instanceof InvalidAuditMessage) {
        deps.log(error.entry);
      } else {
        // The error's name only: its message can carry request text.
        deps.log({
          event: "audit.append_failed",
          level: "error",
          ...(parsed === undefined ? {} : { eventId: parsed.eventId, orgId: parsed.orgId, action: parsed.action }),
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      return { batchItemFailures: event.Records.slice(index).map((later) => ({ itemIdentifier: later.messageId })) };
    }
  }
  return { batchItemFailures: [] };
}

let production: AppenderDeps | undefined;

function productionDependencies(): AppenderDeps {
  if (production !== undefined) return production;
  const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const now = () => Date.now();
  production = {
    documentClient,
    ledgerTable: requiredEnvironment("AUDIT_LEDGER_TABLE_NAME"),
    keyring: new AuditKeyring({
      documentClient,
      keysTable: requiredEnvironment("AUDIT_KEYS_TABLE_NAME"),
      kms: new KMSClient(awsClientConfiguration),
      // The key's ARN, never the alias.
      keyId: requiredEnvironment("AUDIT_VAULT_KEY_ARN"),
      now,
    }),
    now,
    log: (entry) => { console.log(JSON.stringify({ component: "audit-appender", ...entry })); },
  };
  return production;
}

export async function handler(event: AuditSqsEvent): Promise<AuditSqsBatchResponse> {
  return processAuditBatch(productionDependencies(), event);
}
