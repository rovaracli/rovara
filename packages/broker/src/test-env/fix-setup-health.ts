// Setup and test health SH17 + SH28: the Fix setup card port the project health (health.ts) calls, over the SH17 records. The health lane opens a card for a repair state (a night whose setup failed, or 3 tasks blocked by
// the same environment cause) and closes the project's cards when the setup works again.
//
// VERSIONED (the L4 requirement of the health review). The health logic reads the stored state and then calls the port, so a slow call could land after a newer one and undo it (open a card for a project that has
// since been repaired, or close the card of a newer repair). Every call carries the health `version` it was made from. Per project this module keeps the highest version it has seen (`FIXSETUPMARK#HEALTH`), writes
// it in the SAME transaction as the record change, and refuses a call older than that. The same version again is the same call repeated and changes nothing more. A record also keeps the highest version that
// touched it, so a late `resolve` never closes a card a newer repair opened.
//
// A blocked reason the auto-fix policy also names (for example `host_blocked`) joins the record of the auto-fix code (`host-blocked`), so a project has ONE card for one fault; a nightly cause has its own record.
// Gated by `vx` (verification/switch.ts): with it off the port does nothing, as it did before this was hooked up.
import { QueryCommand, TransactWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { projectPk, type OrgId } from "@agentx/contracts";
import { RESULT_RULES } from "../verification/result.js";
import { verifyResultsEnabled } from "../verification/switch.js";
import type { TransactItem } from "../audit/outbox.js";
import { FIX_SETUP_CAUSES, FIX_SETUP_MARKABLE_CAUSE, FixSetupRecordSchema, fixSetupKeyOf, fixSetupPut, planFixSetupJoin, readFixSetupRecord, type FixSetupRecord, type FixSetupStore } from "./fix-setup.js";
import type { FixSetupCardPort } from "./health.js";

const MARK_SK = "FIXSETUPMARK#HEALTH";
const markKey = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: MARK_SK });
const WRITE_ATTEMPTS = 4;
const CLOSE_BATCH = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The record a health cause belongs to: the auto-fix code that means the same environment fault, else the cause itself (a nightly word). */
export function recordCauseOfHealth(cause: string): string {
  return FIX_SETUP_CAUSES.find((code) => { const rule = RESULT_RULES[code]; return rule.kind === "environment" && rule.reason === cause; }) ?? cause;
}

async function readMark(store: FixSetupStore, orgId: OrgId, project: string): Promise<number> {
  const found = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: markKey(orgId, project), ConsistentRead: true })) as { Item?: { version?: unknown } };
  return typeof found.Item?.version === "number" && Number.isSafeInteger(found.Item.version) && found.Item.version >= 0 ? found.Item.version : 0;
}

/** Raises the project's mark to `version` while it is not already above it. */
const markPut = (store: FixSetupStore, orgId: OrgId, project: string, version: number): TransactItem => ({
  Put: {
    TableName: store.tableName, Item: { ...markKey(orgId, project), entityType: "FIX_SETUP_HEALTH_MARK", orgId, project, version },
    ConditionExpression: "attribute_not_exists(pk) OR #version <= :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": version },
  },
});

const cancelled = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");

export function healthFixSetupCards(store: FixSetupStore, env: NodeJS.ProcessEnv = process.env): FixSetupCardPort {
  return {
    async openOrJoin(input) {
      if (!verifyResultsEnabled(env)) return;
      const cause = recordCauseOfHealth(input.cause);
      const nowIso = new Date(store.now()).toISOString();
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const seen = await readMark(store, input.orgId, input.project);
        if (seen > input.version) return;
        const found = await readFixSetupRecord(store, input.orgId, input.project, cause);
        if (found === "unreadable") return;
        const planned = planFixSetupJoin(found, { cause, taskIds: input.taskIds.filter((id) => UUID.test(id)), tests: { tests: [], truncated: false }, unconfirmed: 0, nowIso, healthVersion: input.version });
        // The same call again (the mark is already this version and the record has it): nothing more to do.
        if (planned === undefined && seen === input.version) return;
        try {
          await store.documentClient.send(new TransactWriteCommand({ TransactItems: [markPut(store, input.orgId, input.project, input.version), ...(planned === undefined ? [] : [{ Put: fixSetupPut(store, input.orgId, input.project, found, planned.record) }])] }));
          return;
        } catch (error) {
          if (!cancelled(error)) throw error;
        }
      }
      throw new Error("the Fix setup record kept changing");
    },

    async resolve(input) {
      if (!verifyResultsEnabled(env)) return;
      const nowIso = new Date(store.now()).toISOString();
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const seen = await readMark(store, input.orgId, input.project);
        if (seen > input.version) return;
        const rows = (await store.documentClient.send(new QueryCommand({
          TableName: store.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": projectPk(input.orgId, input.project), ":prefix": "FIXSETUP#" }, ConsistentRead: true,
        }))) as { Items?: unknown[] };
        // The project's open cards, except the one about tests that fail on the original code (that is about the tests, not the setup), and any a newer repair opened.
        const open: FixSetupRecord[] = [];
        for (const row of rows.Items ?? []) {
          const record = FixSetupRecordSchema.safeParse(row);
          if (record.success && record.data.status === "open" && record.data.cause !== FIX_SETUP_MARKABLE_CAUSE && record.data.healthVersion <= input.version) open.push(record.data);
        }
        if (open.length === 0 && seen === input.version) return;
        const closes = open.slice(0, CLOSE_BATCH).map((record): TransactItem => ({
          Put: {
            TableName: store.tableName,
            Item: { entityType: "FIX_SETUP", orgId: input.orgId, project: input.project, ...fixSetupKeyOf(input.orgId, input.project, record.cause), ...record, status: "closed", version: record.version + 1, closedAt: nowIso, closedReason: "resolved", closedBy: "health" },
            ConditionExpression: "#version = :version AND #status = :open", ExpressionAttributeNames: { "#version": "version", "#status": "status" }, ExpressionAttributeValues: { ":version": record.version, ":open": "open" },
          },
        }));
        try {
          await store.documentClient.send(new TransactWriteCommand({ TransactItems: [markPut(store, input.orgId, input.project, input.version), ...closes] }));
          if (open.length <= CLOSE_BATCH) return;
          // More than one batch: the next pass closes the rest (the mark is this version now, so only the rest remain).
        } catch (error) {
          if (!cancelled(error)) throw error;
        }
      }
      throw new Error("the Fix setup records kept changing");
    },
  };
}
