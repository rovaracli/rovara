// The anchor's test bench (Tasks 8 and 9): FakeDynamoDb for both tables, FakeLockedS3 for the bucket, and the helpers that
// append records the way the appender does and read the seals table back. Shared by audit-anchor.test.ts and
// audit-lock-check.test.ts.
import { createHash } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { genesisHash, recordHash, type AuditRecordV1 } from "@rovara/audit-verifier";
import { runAuditEpoch, type AnchorDeps, type AnchorRunResult } from "../../packages/broker/src/audit/anchor.js";
import { bucketPolicyHash, type AuditLockProfileName, type LockMode } from "../../packages/broker/src/audit/lock-check.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { FakeLockedS3 } from "./fake-locked-s3.js";

export const LEDGER = "ledger";
export const SEALS = "seals";
export const BUCKET = "audit-ledger-bucket";
export const SLOT_MS = 15 * 60 * 1000;
export const START = Date.parse("2026-10-20T12:00:05.000Z");
/** The time of the run in slot `n` after the first (12:00:05, 12:15:05, ...). */
export const at = (n: number) => START + n * SLOT_MS;
export const orgOf = (name: string) => `org_${name.repeat(20)}`.slice(0, 24);
export const A = orgOf("a");
export const B = orgOf("b");
export const C = orgOf("c");
export const pad12 = (seq: number) => String(seq).padStart(12, "0");
export const E0 = "e20261020T1200Z";
export const E1 = "e20261020T1215Z";
export const E2 = "e20261020T1230Z";

export type Command = { constructor: { name: string }; input: Record<string, unknown> };
export type Log = Record<string, unknown>;

/** What a DynamoDB command touched. `sk` is recorded for commands that carry a key or an item (not for a Query). */
export interface Operation { action: string; table: string; pk: string; sk?: string }

export const ENV_NAME = "acme";
export const PARTITION = "aws";
export const ACCOUNT = "123456789012";
export const REGION = "us-east-1";
export const BUCKET_ARN = `arn:${PARTITION}:s3:::agentx-${ENV_NAME}-audit-ledger-${ACCOUNT}-${REGION}`;

/** A bucket policy as GetBucketPolicy returns it: concrete ARNs, `"Principal": "*"`, one JSON line. Not the real policy: the lock check only hashes it. */
export function bucketPolicyText(variant = "base"): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "DenyDeletes", Effect: "Deny", Principal: "*", Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"], Resource: `${BUCKET_ARN}/*` },
      { Sid: "RequireConditionalWrites", Effect: "Deny", Principal: "*", Action: "s3:PutObject", Resource: `${BUCKET_ARN}/*`, Condition: { Null: { "s3:if-none-match": "true" } } },
      ...(variant === "base" ? [] : [{ Sid: variant, Effect: "Allow", Principal: "*", Action: "s3:*", Resource: `${BUCKET_ARN}/*` }]),
    ],
  });
}

export interface HarnessOptions {
  /** The bucket's default retention. Default: compliance for 1,096 days. */
  retention?: { mode: LockMode; days: number };
  /** The environment name the anchor is deployed as. Default: `acme` (a production-kind name). */
  envName?: string;
  /** The `AuditLockProfile` the stack was deployed with. Default: `trial` for a governance bucket, else `production`. */
  profile?: AuditLockProfileName;
  /** The mode and days the deploy gave the function. Default: the bucket's. */
  deployed?: { mode: LockMode; days: number };
  sweepKeysPerRun?: number;
}

export function harness(options: HarnessOptions = {}) {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  const retention = options.retention ?? { mode: "COMPLIANCE" as const, days: 1096 };
  const envName = options.envName ?? ENV_NAME;
  const policy = bucketPolicyText();
  const s3 = new FakeLockedS3({ now: () => clock.now, retention, policy });
  const logs: Log[] = [];
  const operations: Operation[] = [];
  const transactions: Array<{ items: number; operations: Operation[] }> = [];
  /** Runs before a DynamoDB command is sent; throw to make it fail before it touches anything. */
  const hooks: { before?: ((command: Command) => void | Promise<void>) | undefined } = {};
  const keyOf = (entry: Record<string, unknown>): string => String(((entry.Key ?? entry.Item) as { pk: string }).pk);
  const sortOf = (entry: Record<string, unknown>): { sk?: string } => {
    const sk = ((entry.Key ?? entry.Item) as { sk?: unknown } | undefined)?.sk;
    return sk === undefined ? {} : { sk: String(sk) };
  };
  const documentClient = {
    send: async (command: Command) => {
      await hooks.before?.(command);
      const name = command.constructor.name;
      const input = command.input;
      if (name === "TransactWriteCommand") {
        const flattened: Operation[] = [];
        for (const entry of input.TransactItems as Array<Record<string, Record<string, unknown>>>) {
          const [kind, action] = Object.entries(entry)[0] as [string, Record<string, unknown>];
          flattened.push({ action: `${kind}Item`, table: String(action.TableName), pk: keyOf(action), ...sortOf(action) });
        }
        transactions.push({ items: flattened.length, operations: flattened });
        operations.push(...flattened);
      } else if (name === "QueryCommand") {
        operations.push({ action: "Query", table: String(input.TableName), pk: String((input.ExpressionAttributeValues as Record<string, unknown>)[":pk"]) });
      } else {
        operations.push({ action: name.replace("Command", "Item"), table: String(input.TableName), pk: keyOf(input), ...sortOf(input) });
      }
      return db.send(command);
    },
  } as unknown as DynamoDBDocumentClient;
  const deps: AnchorDeps = {
    documentClient,
    ledgerTable: LEDGER,
    sealsTable: SEALS,
    s3: s3.client,
    bucket: BUCKET,
    log: (entry) => logs.push(entry),
    sleep: async () => undefined,
    lock: {
      envName,
      profile: options.profile ?? (retention.mode === "GOVERNANCE" ? "trial" : "production"),
      deployed: options.deployed ?? retention,
      bucketPolicySha256: bucketPolicyHash(policy, { envName, partition: PARTITION, accountId: ACCOUNT, region: REGION }),
      partition: PARTITION,
      accountId: ACCOUNT,
      region: REGION,
    },
    ...(options.sweepKeysPerRun === undefined ? {} : { sweepKeysPerRun: options.sweepKeysPerRun }),
  };
  return { db, s3, clock, logs, operations, transactions, hooks, deps };
}
export type Harness = ReturnType<typeof harness>;

export const iso = (ms: number) => new Date(ms).toISOString();

/** Appends `count` records to an org's chain the way the appender does: record, head, org list, and the dirty marker. */
export function appendRecords(h: Harness, orgId: string, count: number): void {
  const head = h.db.get(`AUDIT#${orgId}`, "HEAD");
  let seq = head === undefined ? 0 : (head.seq as number);
  let prevHash = head === undefined ? genesisHash(orgId) : (head.hash as string);
  const firstNew = seq + 1;
  for (let index = 0; index < count; index += 1) {
    seq += 1;
    const unhashed = {
      v: 1 as const, orgId, seq,
      eventId: `aev_${createHash("sha256").update(`${orgId}:${String(seq)}`).digest("hex").slice(0, 40)}`,
      action: "pull_request.opened", actor: { kind: "member", id: "dev_1" }, target: { kind: "pull_request", id: "pr_1" },
      occurredAt: iso(h.clock.now - 1000), recordedAt: iso(h.clock.now), related: [], facts: { n: seq }, details: [], prevHash,
    };
    const hash = recordHash(unhashed);
    h.db.set({ pk: `AUDIT#${orgId}`, sk: `SEQ#${pad12(seq)}`, ...unhashed, hash, sealedDetails: [{ subject: "org", iv: "x", ciphertext: "y" }] });
    prevHash = hash;
  }
  h.db.set({ pk: `AUDIT#${orgId}`, sk: "HEAD", seq, hash: prevHash, updatedAt: iso(h.clock.now) });
  if (head === undefined) h.db.set({ pk: "AUDIT_ORGS", sk: orgId, createdAt: iso(h.clock.now) });
  const marker = h.db.get("AUDIT_DIRTY", orgId);
  h.db.set({ pk: "AUDIT_DIRTY", sk: orgId, since: marker === undefined ? firstNew : marker.since, lastSeq: seq });
}

export const run = (h: Harness, ms: number): Promise<AnchorRunResult> => runAuditEpoch(h.deps, ms);
export const eventsOf = (h: Harness, name: string) => h.logs.filter((entry) => entry.event === name);

export const stateOf = (h: Harness, orgId: string) => h.db.get(`SEALED#${orgId}`, "STATE");
export const metaOf = (h: Harness, epochId: string) => h.db.get(`EPOCH#${epochId}`, "META");
export const intentOf = (h: Harness, epochId: string, orgId: string) => h.db.get(`EPOCH#${epochId}`, `ORG#${orgId}`);
export const epochHead = (h: Harness) => h.db.get("EPOCH_HEAD", "HEAD");
export const markerOf = (h: Harness, orgId: string) => h.db.get("AUDIT_DIRTY", orgId);
export const storedRecords = (h: Harness, orgId: string): AuditRecordV1[] =>
  h.db.find((entry) => entry.pk === `AUDIT#${orgId}` && String(entry.sk).startsWith("SEQ#"))
    .sort((left, right) => String(left.sk).localeCompare(String(right.sk)))
    .map((entry) => {
      const { pk: _pk, sk: _sk, sealedDetails: _sealed, ...record } = entry;
      void _pk; void _sk; void _sealed;
      return record as unknown as AuditRecordV1;
    });

export const crash = () => Object.assign(new Error("the process died"), { name: "ProcessDied" });

/** Every (version of every) object in the bucket, as key -> versionId -> text, to prove nothing was rewritten. */
export function snapshot(h: Harness): Record<string, string[]> {
  return Object.fromEntries([...h.s3.entries.keys()].sort().map((key) => [key, h.s3.versionsOf(key).map((version) => `${version.versionId}:${version.body.toString("utf8")}`)]));
}


