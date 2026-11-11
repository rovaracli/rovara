// The export function: the broker invokes it asynchronously with { source: "agentx.audit-export", orgId, exportId } and
// `runAuditExport` builds, verifies and stores the export. It has a role of its own (infra/lib/audit-ledger.ts, AuditExportPolicy).
// A failure that a retry may cure (a throttled read, a failed commit) is thrown, so the platform retries the invoke and the
// build starts again from the beginning; an event with another source is ignored.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AUDIT_SDK_REQUEST_TIMEOUT_MS, defaultAnchors } from "@agentx/cloud-contracts";
import { OrgIdSchema } from "@rovara-code/contracts";
import { requiredEnvironment } from "../aws/lambda.js";
import { AUDIT_EXPORT_PURGE_SOURCE, purgeAuditExports } from "./erase.js";
import { AUDIT_EXPORT_SOURCE, runAuditExport, type AuditExportDeps, type AuditExportOutcome } from "./export.js";
import { AuditKeyring } from "./keyring.js";

/** What an invoke may carry: anything, until its source and ids are checked. */
export interface AuditExportInvokeEvent {
  source?: unknown;
  orgId?: unknown;
  exportId?: unknown;
}

export async function handleAuditExportEvent(deps: AuditExportDeps, event: AuditExportInvokeEvent): Promise<{ outcome: AuditExportOutcome } | { purged: number } | { status: "ignored" }> {
  // Task 15: the broker asks (synchronously) for an org's export files to be deleted when it erases a person. This function's role is
  // the one that may list and delete in the exports bucket. The org id is parsed by purgeAuditExports; anything else is ignored.
  if (event.source === AUDIT_EXPORT_PURGE_SOURCE) {
    if (typeof event.orgId !== "string" || !OrgIdSchema.safeParse(event.orgId).success) return { status: "ignored" };
    return { purged: await purgeAuditExports(deps, event.orgId) };
  }
  if (event.source !== AUDIT_EXPORT_SOURCE || typeof event.orgId !== "string" || typeof event.exportId !== "string") return { status: "ignored" };
  try {
    return { outcome: await runAuditExport(deps, { orgId: event.orgId, exportId: event.exportId }) };
  } catch (error) {
    deps.log({ event: "audit.export_failed", level: "error", orgId: event.orgId, exportId: event.exportId, error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

let production: AuditExportDeps | undefined;

function productionDependencies(): AuditExportDeps {
  if (production !== undefined) return production;
  const region = process.env.AWS_REGION;
  const configuration = region === undefined ? {} : { region };
  const log = (entry: Record<string, unknown>): void => { console.log(JSON.stringify({ component: "audit-export", ...entry })); };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(configuration), { marshallOptions: { removeUndefinedValues: true } });
  const tableName = requiredEnvironment("STATE_TABLE_NAME");
  // The pending audit item and its delivery use clients that give up quickly, as every audit write does.
  const quick = { ...configuration, maxAttempts: 2, requestHandler: { requestTimeout: AUDIT_SDK_REQUEST_TIMEOUT_MS, connectionTimeout: AUDIT_SDK_REQUEST_TIMEOUT_MS } };
  production = {
    documentClient,
    ledgerTable: requiredEnvironment("AUDIT_LEDGER_TABLE_NAME"),
    sealsTable: requiredEnvironment("AUDIT_SEALS_TABLE_NAME"),
    keyring: new AuditKeyring({ documentClient, keysTable: requiredEnvironment("AUDIT_KEYS_TABLE_NAME"), kms: new KMSClient(configuration), keyId: requiredEnvironment("AUDIT_VAULT_KEY_ARN"), now: Date.now }),
    s3: new S3Client(configuration),
    ledgerBucket: requiredEnvironment("AUDIT_LEDGER_BUCKET_NAME"),
    exportsBucket: requiredEnvironment("AUDIT_EXPORTS_BUCKET_NAME"),
    tableName,
    audit: {
      sqs: new SQSClient(quick),
      queueUrl: requiredEnvironment("AUDIT_INTAKE_QUEUE_URL"),
      documentClient: DynamoDBDocumentClient.from(new DynamoDBClient(quick), { marshallOptions: { removeUndefinedValues: true } }),
      tableName,
      now: Date.now,
      log,
    },
    // The public authorities' pinned roots. A customer's own authority has none here, so its tokens are listed as unverified in the
    // export's summary and the auditor passes --trust.
    anchors: defaultAnchors(),
    now: Date.now,
    log,
  };
  return production;
}

export async function handler(event: AuditExportInvokeEvent): Promise<{ outcome: AuditExportOutcome } | { purged: number } | { status: "ignored" }> {
  return handleAuditExportEvent(productionDependencies(), event);
}
