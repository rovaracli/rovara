// Customer test AWS account, lane TA2: what is stored about a connection, and the port the rest of the lane reads and writes it through. The DynamoDB adapter is `dynamo-store.ts`; the tests use an in-memory one with the same
// rules (tests/support/fake-test-access-store.ts).
//
// Rules every adapter must keep (each is a condition on the write, so a lost race is a refusal and never an overwrite):
//   - a connection changes only from the version the caller read (`commitConnection`);
//   - a connect token is consumed by ONE conditional write that also records the stack and moves the connection (`consumeToken`): the token must exist, be unused, be unexpired, and be the one made for this connection; the stack
//     must not be recorded already; the connection must still be the version read. The three writes are one transaction, so a token is never spent without the connection moving, and a connection never moves without the token being spent;
//   - every key is under the organization the caller proves (a connection is `ORG#<org>`), except the token and the stack, which are found by hash and are checked against the organization they name before anything is trusted;
//   - the audit event of a change is written in the same transaction as the change.
import type { AuditEventInput } from "@agentx/cloud-contracts";

export const CONNECTION_STATUSES = ["awaiting", "polling", "reported", "confirmed", "connected", "needs_attention", "suspended", "disconnected", "failed"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** The checks of the connection test, in the order they run. */
export const CONNECTION_CHECK_IDS = ["assumes", "external_id_required", "limits_attached", "services_reachable", "creates_and_deletes_own", "cannot_touch_others", "not_production"] as const;
export type ConnectionCheckId = (typeof CONNECTION_CHECK_IDS)[number];

/** A check's outcome. `code` is a fixed word, never text from AWS. `warn` is a service the account's own policy blocks (it stays on the emulator, labelled): it does not fail the connection. */
export interface ConnectionCheck {
  id: ConnectionCheckId;
  status: "pass" | "fail" | "warn" | "skipped";
  code?: string;
  /** For `services_reachable`: the services that answered `scp_blocked` or `no_access`, by name. */
  services?: string[];
}

export interface ConnectionTestResult {
  at: string;
  passed: boolean;
  checks: ConnectionCheck[];
  /** An ARN or URL of something the test created and could not delete: handed to the cleanup sweeper (TA6), never assumed gone. */
  leftover?: string;
}

export interface ConnectionRecord {
  orgId: string;
  connectionId: string;
  projectId: string;
  /** The Region the link was made for; the only Region the connection may use. */
  region: string;
  status: ConnectionStatus;
  /** Starts at 1; every change adds one. A write names the version it read. */
  version: number;
  /** The external id, made when the link was made (`connectionExternalId`) and stored: every assume-role sends exactly this. */
  externalId: string;
  createdBy: string;
  createdAt: string;
  tokenExpiresAt: string;
  stackId?: string;
  accountId?: string;
  roleArn?: string;
  cleanupRoleArn?: string;
  templateVersion?: string;
  reportedAt?: string;
  reportedVia?: "callback" | "account_id";
  /** The account id an admin typed when no callback came, while the poll runs. */
  pollAccountId?: string;
  pollUntil?: string;
  pollSubmittedBy?: string;
  lastPolledAt?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  alias?: string;
  /** An admin said the account is not production although its alias says so (a `prod` alias needs the tick). */
  notProductionAck?: boolean;
  lastTest?: ConnectionTestResult;
  endedAt?: string;
  endCause?: string;
}

/** What the store keeps for a token: the hash, never the token. */
export interface ConnectTokenItem {
  tokenHash: string;
  orgId: string;
  projectId: string;
  connectionId: string;
  region: string;
  expiresAtMs: number;
  usedAtMs?: number;
}

/** A stack a Create was accepted for, found by its id. */
export interface StackItem {
  stackId: string;
  orgId: string;
  connectionId: string;
  accountId: string;
  /** The hash of the connect token this Create spent. An Update or Delete acts only when it carries a token with this hash: a StackId is not a secret, the token is. */
  tokenHash: string;
  recordedAtMs: number;
}

export type ConsumeResult = "ok" | "token_refused" | "stack_taken" | "connection_changed";

export interface TestAccessStore {
  /** The connection, its token and the audit event, in one transaction. False when either id is already taken. */
  createConnection(record: ConnectionRecord, token: ConnectTokenItem, audit: AuditEventInput): Promise<boolean>;
  getConnection(orgId: string, connectionId: string): Promise<ConnectionRecord | undefined>;
  /** The organization's connections, at most `limit`. */
  listConnections(orgId: string, limit: number): Promise<ConnectionRecord[]>;
  /**
   * Replaces the connection when its stored version is `expectedVersion`. A connection that reaches `polling` is added to the poll list, and one that leaves it is removed, in the same transaction. A connection that
   * reaches `disconnected` also loses its stack record. False when the version moved.
   */
  commitConnection(next: ConnectionRecord, expectedVersion: number, audit: AuditEventInput | undefined): Promise<boolean>;
  getToken(tokenHash: string): Promise<ConnectTokenItem | undefined>;
  /** The one-use consumption described in the header. `next` is the connection after the Create. */
  consumeToken(input: { tokenHash: string; nowMs: number; stack: StackItem; next: ConnectionRecord; expectedVersion: number; audit: AuditEventInput }): Promise<ConsumeResult>;
  /** Marks a token used without a stack, so it can never be used again (a token whose connection can no longer take it). */
  retireToken(tokenHash: string, nowMs: number): Promise<void>;
  getStack(stackId: string): Promise<StackItem | undefined>;
  /** The connections whose poll is open, at most `limit`. */
  listPolling(limit: number): Promise<Array<{ orgId: string; connectionId: string }>>;
}

/** A connection can run tests (open a session) only in this state. */
export const connectionUsable = (record: Pick<ConnectionRecord, "status">): boolean => record.status === "connected";
