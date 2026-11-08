// Learning v2 production wiring (lessons-in-production lane 1): the company's own limit on what learning may spend (`LearningSpend`, `lessons/ports.ts`).
//
//   - Public: learning has a cap of its own, $20 a month per company (owner decision, DECISIONS #22). The month's figure is ONE counter item under the company
//     (`LEARNING_SPEND#MONTH#<YYYY-MM>`, UTC). `admit` adds the call's estimate to `committedUsd` (spent + held) in a conditional update that holds only while the
//     counter stays within the cap, so concurrent admits can never take the month past it: a lost race is a refusal.
//   - Enterprise: learning has no cap of its own (Q8). Nothing is held; the company's existing budgets (the org, project and member budgets, and the model proxy's own budget for the
//     key) are checked where the model key is made (`learning-model.ts`), and the counter only records what was spent.
//   - `charge` settles what `admit` held (the actual cost replaces the estimate; 0 when the call failed) and books the cost under the `learning` line of the company's spend: the counter, the
//     company's ORG spend counter (so the existing budgets see it) and a ledger line, in one transaction.
//   - Fail closed: an admit that cannot be recorded or read is a refusal. A charge that cannot be written is thrown to the caller (the reflector logs it; learning never blocks a task).
//
// The estimate of an admit is held in this process until its `charge` (FIFO per company): admit and charge of one call run in one invocation of the same worker.
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, ledgerKey, orgScoped, spendCounterKey, type OrgId } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { isTransactionConflict, type TransactItem } from "../../agents/table-writes.js";
import type { Edition } from "../../lessons/policy.js";
import type { LearningSpend } from "../../lessons/ports.js";
import { cleanUsd } from "../../spend/top-ups.js";

/** Owner decision (DECISIONS #22): a Public company's learning may spend at most this much in a UTC month. */
export const PUBLIC_LEARNING_MONTHLY_CAP_USD = 20;
/** The agent name the learning line carries on the ledger. */
export const LEARNING_AGENT_ID = "learning";
const CHARGE_CONFLICT_RETRIES = 3;

export interface CompanyLearningSpendDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table. */
  tableName: string;
  edition: Edition;
  now: () => number;
  /** Replaces the Public cap (tests, and a later setting). */
  monthlyCapUsd?: number;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** The UTC month a time falls in, `YYYY-MM`. */
export const learningMonthOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 7);

/** The month's counter: `LEARNING_SPEND#MONTH#<YYYY-MM>` under the company. */
export const learningSpendKey = (orgId: OrgId, month: string): { pk: string; sk: string } => ({ pk: orgScoped(orgId, `LEARNING_SPEND#MONTH#${month}`), sk: "COUNTER" });

const isConditionFailure = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

export function companyLearningSpend(deps: CompanyLearningSpendDependencies): LearningSpend {
  const cap = deps.edition === "enterprise" ? undefined : deps.monthlyCapUsd ?? PUBLIC_LEARNING_MONTHLY_CAP_USD;
  const held = new Map<string, Array<{ month: string; estimateUsd: number }>>();
  const log = (event: string, fields: Record<string, string | number> = {}): void => deps.log?.(event, fields);

  return {
    async admit(workspaceId, estimateUsd) {
      const org = OrgIdSchema.safeParse(workspaceId);
      if (!org.success || !Number.isFinite(estimateUsd) || estimateUsd < 0) return false;
      // Enterprise: no cap of its own, nothing to hold.
      if (cap === undefined) return true;
      const estimate = cleanUsd(estimateUsd);
      // A call that cannot fit the month's whole cap fits nowhere.
      if (estimate > cap) return false;
      const month = learningMonthOf(deps.now());
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: learningSpendKey(org.data, month),
          UpdateExpression: "SET #type = if_not_exists(#type, :type), #org = :org, #month = :month ADD #committed :estimate",
          // A millionth of slack keeps float dust from refusing a call that fits exactly. DynamoDB conditions cannot add, so the room left is worked out here.
          ConditionExpression: "attribute_not_exists(#committed) OR #committed <= :room",
          ExpressionAttributeNames: { "#type": "entityType", "#org": "orgId", "#month": "month", "#committed": "committedUsd" },
          ExpressionAttributeValues: { ":type": "LEARNING_SPEND", ":org": org.data, ":month": month, ":estimate": estimate, ":room": cleanUsd(cap - estimate + 0.000001) },
        }));
      } catch (error) {
        if (!isConditionFailure(error)) log("learning.spend_admit_failed", { orgId: org.data });
        return false;
      }
      const list = held.get(org.data) ?? [];
      list.push({ month, estimateUsd: estimate });
      held.set(org.data, list);
      return true;
    },

    async charge(workspaceId, project, usd, purpose) {
      const org = OrgIdSchema.parse(workspaceId);
      const cost = Number.isFinite(usd) && usd > 0 ? cleanUsd(usd) : 0;
      const reservation = cap === undefined ? undefined : held.get(org)?.shift();
      const at = deps.now();
      const month = reservation?.month ?? learningMonthOf(at);
      const estimate = reservation?.estimateUsd ?? 0;
      const delta = cleanUsd(cost - estimate);
      // The counter: what was spent, and held + spent moves by the difference between the actual cost and the estimate that was held.
      const counter: TransactItem = {
        Update: {
          TableName: deps.tableName, Key: learningSpendKey(org, month),
          UpdateExpression: "SET #type = if_not_exists(#type, :type), #org = :org, #month = :month ADD #spent :cost, #committed :delta",
          ExpressionAttributeNames: { "#type": "entityType", "#org": "orgId", "#month": "month", "#spent": "spentUsd", "#committed": "committedUsd" },
          ExpressionAttributeValues: { ":type": "LEARNING_SPEND", ":org": org, ":month": month, ":cost": cost, ":delta": delta },
        },
      };
      const items: TransactItem[] = [counter];
      if (cost > 0) {
        // The company's existing budgets see learning spend through the ORG counter; the ledger line says what it was.
        items.push({
          Update: {
            TableName: deps.tableName, Key: spendCounterKey(org, month, "ORG"),
            UpdateExpression: "SET #type = if_not_exists(#type, :type) ADD #spent :cost, #committed :cost",
            ExpressionAttributeNames: { "#type": "entityType", "#spent": "spentUsd", "#committed": "committedUsd" },
            ExpressionAttributeValues: { ":type": "SPEND_COUNTER", ":cost": cost },
          },
        }, {
          Put: {
            TableName: deps.tableName,
            Item: {
              ...ledgerKey(org, month, new Date(at).toISOString(), `learning-${randomUUID()}`, 1), entityType: "LEDGER", orgId: org, month, at: new Date(at).toISOString(),
              usd: cost, agentId: LEARNING_AGENT_ID, origin: LEARNING_AGENT_ID, payerKind: "project", payerId: project, project, purpose: purpose.slice(0, 64),
            },
          },
        });
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
          return;
        } catch (error) {
          if (!isTransactionConflict(error) || attempt >= CHARGE_CONFLICT_RETRIES) {
            // Put the hold back: the settle did not happen, and the caller may try again.
            if (reservation !== undefined) held.set(org, [reservation, ...(held.get(org) ?? [])]);
            throw error;
          }
        }
      }
    },
  };
}
