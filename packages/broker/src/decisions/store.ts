// What the card routes remember. Two things only: that a person opened a card's evidence (bound to the digest of what they saw, so the server can refuse a medium-risk approve that skipped it),
// and the decision itself (one row per request id, which is also the history behind "approvals later reversed"). The interface is small so a test (or another table) can stand in.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, type DecisionKind, DecisionRisk, DecisionTabId } from "@agentx/contracts";

export interface DecisionWho { orgId: string; developerId: string }
export interface EvidenceOpenedKey extends DecisionWho { cardId: string; tab?: DecisionTabId | undefined }
export interface DecisionRecord extends DecisionWho {
  cardId: string;
  kind: DecisionKind;
  risk: DecisionRisk;
  outcome: "approved" | "rejected";
  reason?: string | undefined;
  tab?: DecisionTabId | undefined;
  requestId: string;
  createdAt: string;
  openedAt?: string | undefined;
  decidedAt: string;
}

export interface DecisionStore {
  /** Records that the person opened the evidence of what the digest names. Again with the same key replaces the earlier record. */
  recordEvidenceOpened(key: EvidenceOpenedKey, digest: string, at: string): Promise<void>;
  /** When the person opened exactly this digest, or undefined (never opened, opened another version, or expired). */
  evidenceOpenedAt(key: EvidenceOpenedKey, digest: string): Promise<string | undefined>;
  /** Records a decision once per request id; a repeat is a no-op. */
  recordDecision(record: DecisionRecord): Promise<void>;
}

/** An opened-evidence record counts for this long. */
export const DECISION_EVIDENCE_OPEN_TTL_MS = 3 * 86_400_000;
const DECISION_RECORD_TTL_DAYS = 400;

export function inMemoryDecisionStore(now: () => number = Date.now): DecisionStore & { decisions: DecisionRecord[] } {
  const opened = new Map<string, { digest: string; at: string }>();
  const decisions: DecisionRecord[] = [];
  const keyOf = (key: EvidenceOpenedKey) => `${key.orgId}|${key.developerId}|${key.cardId}|${key.tab ?? "-"}`;
  return {
    decisions,
    async recordEvidenceOpened(key, digest, at) { opened.set(keyOf(key), { digest, at }); },
    async evidenceOpenedAt(key, digest) {
      const found = opened.get(keyOf(key));
      return found !== undefined && found.digest === digest && now() - Date.parse(found.at) < DECISION_EVIDENCE_OPEN_TTL_MS ? found.at : undefined;
    },
    async recordDecision(record) { if (!decisions.some((existing) => existing.requestId === record.requestId && existing.developerId === record.developerId)) decisions.push(record); },
  };
}

export interface DynamoDecisionStoreDependencies {
  documentClient: { send(command: GetCommand | PutCommand): Promise<unknown> };
  tableName: string;
  now: () => number;
}

const partition = (who: DecisionWho) => `DECISION#${who.orgId}#${who.developerId}`;

/** The DynamoDB form. Rows expire by the table's TTL attribute (`INDEX_EXPIRY_ATTRIBUTE`, epoch seconds). */
export function dynamoDecisionStore(deps: DynamoDecisionStoreDependencies): DecisionStore {
  return {
    async recordEvidenceOpened(key, digest, at) {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: { pk: partition(key), sk: `OPENED#${key.cardId}#${key.tab ?? "-"}`, entityType: "DECISION_EVIDENCE_OPENED", orgId: key.orgId, developerId: key.developerId, cardId: key.cardId, digest, openedAt: at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + Math.floor(DECISION_EVIDENCE_OPEN_TTL_MS / 1000) },
      }));
    },
    async evidenceOpenedAt(key, digest) {
      const read = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: partition(key), sk: `OPENED#${key.cardId}#${key.tab ?? "-"}` }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      const item = read.Item;
      if (item === undefined || item["digest"] !== digest || typeof item["openedAt"] !== "string") return undefined;
      return deps.now() - Date.parse(item["openedAt"]) < DECISION_EVIDENCE_OPEN_TTL_MS ? item["openedAt"] : undefined;
    },
    async recordDecision(record) {
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName,
          Item: {
            pk: partition(record), sk: `DECIDED#${record.requestId}`, entityType: "DECISION_RECORD", orgId: record.orgId, developerId: record.developerId, cardId: record.cardId, kind: record.kind, risk: record.risk, outcome: record.outcome,
            ...(record.reason === undefined ? {} : { reason: record.reason }), ...(record.tab === undefined ? {} : { tab: record.tab }), requestId: record.requestId, createdAt: record.createdAt,
            ...(record.openedAt === undefined ? {} : { openedAt: record.openedAt }), decidedAt: record.decidedAt, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + DECISION_RECORD_TTL_DAYS * 86_400,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
    },
  };
}
