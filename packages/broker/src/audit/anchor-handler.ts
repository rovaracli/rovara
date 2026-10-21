// The anchor function: the schedule (EventBridge Scheduler, every 15 minutes) invokes it with { source: "agentx.audit-epoch" }
// and `runAuditEpoch` does the rest. Reserved concurrency is 1, so two runs never overlap; the conditional writes in the
// anchor make an overlap harmless anyway. An event with another source is ignored, so a stray invoke cannot seal early.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { requiredEnvironment } from "../aws/lambda.js";
import { AUDIT_EPOCH_SOURCE, auditS3ClientConfig, runAuditEpoch, type AnchorDeps, type AnchorRunResult } from "./anchor.js";
import { lockSettingsFromEnvironment } from "./lock-check.js";
import { loadTsaDeps, type TsaDeps } from "./tsa-client.js";

export interface AuditEpochEvent {
  source?: unknown;
}

export async function handleAuditEpochEvent(deps: AnchorDeps, event: AuditEpochEvent, now: number = Date.now()): Promise<AnchorRunResult | { status: "ignored" }> {
  if (event.source !== AUDIT_EPOCH_SOURCE) return { status: "ignored" };
  return runAuditEpoch(deps, now);
}

let production: AnchorDeps | undefined;
let timestamps: TsaDeps | undefined;

/**
 * Task 10. Read once per cold start: the kind of timestamp authority (public, custom or off), and for custom the roots from the
 * one SSM parameter the stack names. That parameter is the only thing this function ever reads from SSM. A failure to read it is
 * logged and leaves the epochs waiting for a timestamp (loadTsaDeps); it is not cached, so the next run tries again.
 */
async function timestampDependencies(base: AnchorDeps): Promise<TsaDeps> {
  if (timestamps !== undefined) return timestamps;
  const region = process.env.AWS_REGION;
  const ssm = new SSMClient(region === undefined ? {} : { region });
  const failures: Array<Record<string, unknown>> = [];
  const loaded = await loadTsaDeps(process.env, {
    readParameter: async (name) => {
      const out = await ssm.send(new GetParameterCommand({ Name: name }));
      const value = out.Parameter?.Value;
      if (typeof value !== "string") throw new Error("the roots parameter has no value");
      return value;
    },
    fetch,
    log: (entry) => { failures.push(entry); base.log(entry); },
  });
  if (failures.length === 0) timestamps = loaded;
  return loaded;
}

function productionDependencies(): AnchorDeps {
  if (production !== undefined) return production;
  const region = process.env.AWS_REGION;
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(region === undefined ? {} : { region }), { marshallOptions: { removeUndefinedValues: true } });
  production = {
    documentClient,
    ledgerTable: requiredEnvironment("AUDIT_LEDGER_TABLE_NAME"),
    sealsTable: requiredEnvironment("AUDIT_SEALS_TABLE_NAME"),
    s3: new S3Client(auditS3ClientConfig(region)),
    bucket: requiredEnvironment("AUDIT_LEDGER_BUCKET_NAME"),
    // The deployed profile, mode, days and policy hash, and the identity the bucket policy is normalized with. The floor itself is in code.
    lock: lockSettingsFromEnvironment(process.env),
    log: (entry) => { console.log(JSON.stringify({ component: "audit-anchor", ...entry })); },
  };
  return production;
}

export async function handler(event: AuditEpochEvent): Promise<AnchorRunResult | { status: "ignored" }> {
  const base = productionDependencies();
  if (event.source !== AUDIT_EPOCH_SOURCE) return { status: "ignored" };
  return handleAuditEpochEvent({ ...base, tsa: await timestampDependencies(base) }, event);
}
