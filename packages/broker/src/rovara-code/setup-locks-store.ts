// The company's locks on setup (SH29), stored (sh-su-musts). `org/setup-recipes.ts` decides WHO may change a lock and WHEN a change needs a second admin; it asks a store to read the row and to commit a change.
// This is that store's DynamoDB half for the locks only (the recipes' half belongs to the `sp` switch and is not built here):
//   - one row per company (`setupLocksKey`); a commit is a conditional put on the revision the caller read (none yet: the row must not exist), in ONE transaction with the audit event and with the approval's
//     evidence conditions (a second admin added, or either person changed, since the read refuses the write);
//   - a row that does not read as locks is an error, never "no locks" (a damaged lock must not become a missing one: the run is refused until it is put right);
//   - the audit event is built from the entry the decider made: who, when, the digests and whether it loosened; nothing else is stored.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { SETUP_AGENT_LIMITS_DEFAULT, agentXError, canonicalJson, setupLocksKey, type OrgId } from "@rovara-code/contracts";
import { auditSetupLocksChange, auditOccurrence } from "../audit/events.js";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { CompanySetupLocksSchema, type CompanySetupLocks, type SetupRecipeStore, type StoredLocks } from "../org/setup-recipes.js";

type Client = { send(command: unknown): Promise<unknown> };
export interface SetupLocksStoreDeps { documentClient: Client; tableName: string; now: () => number; audit?: AuditRuntime }

const ACTIONS = { locks_changed: "setup.locks_changed", locks_change_proposed: "setup.locks_change_proposed", locks_change_approved: "setup.locks_change_approved" } as const;
const DIGEST = /^[a-f0-9]{64}$/u;

/** What a row that does not read as locks says (M3): the page shows it as "company locks unreadable, runs held". */
export const SETUP_LOCKS_UNREADABLE = "The company's setup locks could not be read, so setup runs are held until they are put right.";

function storedFrom(orgId: OrgId, item: Record<string, unknown>): StoredLocks {
  const locks = CompanySetupLocksSchema.safeParse(item["locks"]);
  const pending = item["pending"] === undefined ? undefined : item["pending"] as { locks?: unknown; digest?: unknown; proposedBy?: unknown; proposedAt?: unknown };
  const pendingLocks = pending === undefined ? undefined : CompanySetupLocksSchema.safeParse(pending.locks);
  if (item["orgId"] !== orgId || !Number.isSafeInteger(item["revision"]) || !locks.success || typeof item["updatedBy"] !== "string" || typeof item["updatedAt"] !== "string"
    || (pending !== undefined && (!pendingLocks?.success || typeof pending.digest !== "string" || !DIGEST.test(pending.digest) || typeof pending.proposedBy !== "string" || typeof pending.proposedAt !== "string"))) {
    throw agentXError("CONFIG_INVALID", SETUP_LOCKS_UNREADABLE);
  }
  return {
    orgId, revision: item["revision"] as number, locks: locks.data, updatedBy: item["updatedBy"], updatedAt: item["updatedAt"],
    ...(pending === undefined ? {} : { pending: { locks: pendingLocks!.data!, digest: pending.digest as string, proposedBy: pending.proposedBy as string, proposedAt: pending.proposedAt as string } }),
  };
}

/** The company's locks as stored, for another lane's enforcement (recipe offers read `devcontainerImages` here). Undefined when none were ever set. A row that does not read throws (never "no locks"). */
export async function getCompanySetupLocks(deps: Pick<SetupLocksStoreDeps, "documentClient" | "tableName">, orgId: OrgId): Promise<CompanySetupLocks | undefined> {
  return (await dynamoSetupLocksStore({ ...deps, now: Date.now }).getLocks(orgId))?.locks;
}

const STRICT_LIMITS = { commands: SETUP_AGENT_LIMITS_DEFAULT.commands, sameStepTries: SETUP_AGENT_LIMITS_DEFAULT.sameStepTries, wallClockMinutes: SETUP_AGENT_LIMITS_DEFAULT.wallClockMin, spendUsd: SETUP_AGENT_LIMITS_DEFAULT.budgetCents / 100, hostAsks: SETUP_AGENT_LIMITS_DEFAULT.hostAsks } as const;

/**
 * L12: whether a run that is going must stop because the company turned setup runs off. Only a readable "off" or a row that is POSITIVELY damaged says yes. A read that fails for another reason (a throttle, a timeout) is
 * tried once more, and if it still fails the answer is no: the run goes on to its next poll and asks again, so a blip never stops a run.
 */
export async function companySetupOff(deps: Pick<SetupLocksStoreDeps, "documentClient" | "tableName">, orgId: OrgId): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return (await getCompanySetupLocks(deps, orgId))?.setupAgentOff === true;
    } catch (error) {
      if (error instanceof Error && error.message.includes(SETUP_LOCKS_UNREADABLE)) return true;
    }
  }
  return false;
}

/**
 * M3: what a locks row that does not read is repaired to, and it NEVER loosens anything. The row's `locks` is read field by field: every lock that reads is kept as it was; a lock that is there but cannot be
 * read gets its strictest value (the setup-run limit at its default, a dev container list that allows nothing, `setupAgentOff`, the other two locks at their strict values); `noSoleOwnerException` is always set (a damaged
 * row cannot show that the exception was left on, and turning it on only makes loosening need a second admin); a key the schema does not know, and a waiting change, are dropped (stricter). `defaulted` names what was not
 * read, for the audit. A `locks` value that is not an object at all leaves every enforced lock at its strictest.
 */
export function repairedLocksOf(item: Record<string, unknown>): { locks: CompanySetupLocks; defaulted: string[] } {
  const raw = item["locks"];
  const row: Record<string, unknown> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const whole = row === raw;
  const defaulted: string[] = [];
  const out: Record<string, unknown> = {};
  const single = (name: string, strictest: unknown, valid: (value: unknown) => boolean): void => {
    const value = row[name];
    if (whole && value === undefined) return;
    if (whole && valid(value)) { out[name] = value; return; }
    out[name] = strictest;
    defaulted.push(name);
  };
  single("setupAgentOff", true, (value) => value === true);
  single("hostsOnlyFromCompanyList", true, (value) => value === true);
  single("nightlyHealthOn", true, (value) => value === true);
  single("hostApprover", "admin", (value) => value === "admin");
  // The images: a list that reads is kept; one that does not allows nothing.
  single("devcontainerImages", [], (value) => CompanySetupLocksSchema.safeParse({ devcontainerImages: value }).success);
  // The limits, one by one: a limit that reads is kept, one that does not goes to its default, and a `limits` that is not an object sets every limit to its default.
  const limits: Record<string, unknown> = {};
  const rawLimits = row["limits"];
  const limitsRead = typeof rawLimits === "object" && rawLimits !== null && !Array.isArray(rawLimits);
  if (!whole || rawLimits !== undefined) {
    for (const key of Object.keys(STRICT_LIMITS) as Array<keyof typeof STRICT_LIMITS>) {
      const value = limitsRead ? (rawLimits as Record<string, unknown>)[key] : undefined;
      if (limitsRead && value === undefined) continue;
      if (limitsRead && CompanySetupLocksSchema.safeParse({ limits: { [key]: value } }).success) limits[key] = value;
      else { limits[key] = STRICT_LIMITS[key]; defaulted.push(`limits.${key}`); }
    }
    for (const key of limitsRead ? Object.keys(rawLimits) : []) if (!(key in STRICT_LIMITS)) defaulted.push(`limits.${key}`);
  }
  if (Object.keys(limits).length > 0) out["limits"] = limits;
  if (out["noSoleOwnerException"] !== true) { out["noSoleOwnerException"] = true; if (row["noSoleOwnerException"] !== true) defaulted.push("noSoleOwnerException"); }
  for (const key of Object.keys(row)) if (!["setupAgentOff", "hostsOnlyFromCompanyList", "nightlyHealthOn", "hostApprover", "devcontainerImages", "limits", "noSoleOwnerException"].includes(key)) defaulted.push(key);
  return { locks: CompanySetupLocksSchema.parse(out), defaulted };
}

/**
 * M3: the locks row as it is stored, read without judging it: its revision when that is a whole number, whether the row reads as locks, and what a repair would write (`repairedLocksOf`). A row that does not read must
 * not break the setup page: the page says "company locks unreadable, runs held", every start stays refused, and an admin repairs it against exactly the revision stored.
 */
export async function inspectCompanyLocks(deps: Pick<SetupLocksStoreDeps, "documentClient" | "tableName">, orgId: OrgId): Promise<{ present: boolean; readable: boolean; revision: number | null; digest: string; repaired?: { locks: CompanySetupLocks; defaulted: string[] } }> {
  const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: setupLocksKey(orgId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined) return { present: false, readable: true, revision: null, digest: "" };
  let readable = true;
  try { storedFrom(orgId, item); } catch { readable = false; }
  return { present: true, readable, revision: Number.isSafeInteger(item["revision"]) ? item["revision"] as number : null, digest: createHash("sha256").update(canonicalJson(item["locks"] ?? null), "utf8").digest("hex"), ...(readable ? {} : { repaired: repairedLocksOf(item) }) };
}

/**
 * M3: replaces a locks row that does not read with its repaired locks (`repairedLocksOf`: nothing readable is dropped, nothing unreadable is left open). Conditional on the revision the admin saw stored
 * (`expectedRevision`: null when the stored revision is not a number), audited like every lock write (never `loosened`; `defaulted` names what could not be read). The caller has checked the admin and the fresh sign-in.
 */
export async function writeRepairedLocks(deps: SetupLocksStoreDeps, input: { orgId: OrgId; actor: string; expectedRevision: number | null; previousDigest: string; locks: CompanySetupLocks; defaulted: readonly string[] }): Promise<boolean> {
  const revision = (input.expectedRevision ?? 0) + 1;
  const at = new Date(deps.now()).toISOString();
  const nextDigest = createHash("sha256").update(canonicalJson(input.locks), "utf8").digest("hex");
  const event = auditSetupLocksChange({ orgId: input.orgId, actor: { kind: "member", id: input.actor }, occurredAt: at, occurrence: auditOccurrence("locks", String(revision), "repair"), action: "setup.locks_changed", revision, previousDigest: input.previousDigest || "0".repeat(64), nextDigest, loosened: false, defaulted: input.defaulted.join(",").slice(0, 120) || "none" });
  const auditItems = auditPending(deps, event);
  if (auditItems.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Changing company locks needs the audit ledger.");
  const row: StoredLocks = { orgId: input.orgId, revision, locks: input.locks, updatedBy: input.actor, updatedAt: at };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: { ...setupLocksKey(input.orgId), entityType: "SETUP_LOCKS", ...row },
        ...(input.expectedRevision === null ? { ConditionExpression: "attribute_exists(pk)" } : { ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": input.expectedRevision } }) } },
      ...auditItems,
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return false;
    throw error;
  }
  await flushAuditEvents(deps, [event]);
  return true;
}

export function dynamoSetupLocksStore(deps: SetupLocksStoreDeps): Pick<SetupRecipeStore, "getLocks" | "commitLocks"> {
  return {
    async getLocks(orgId) {
      const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: setupLocksKey(orgId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
      return item === undefined ? undefined : storedFrom(orgId, item);
    },
    async commitLocks(next, expectedRevision, entry, conditions: readonly TransactItem[]) {
      const action = ACTIONS[entry.action as keyof typeof ACTIONS];
      if (action === undefined || entry.previousDigest === undefined || entry.nextDigest === undefined || entry.revision === undefined) throw agentXError("CONFIG_INVALID", "A locks change needs its audit facts.");
      const event = auditSetupLocksChange({
        orgId: entry.orgId, actor: { kind: "member", id: entry.actor }, occurredAt: entry.at, occurrence: auditOccurrence("locks", String(entry.revision)), action,
        revision: entry.revision, previousDigest: entry.previousDigest, nextDigest: entry.nextDigest, loosened: entry.loosened === true, approvalMode: entry.approvalMode, membershipVersion: entry.membershipVersion,
      });
      // Every write of a company lock is recorded (coordinator, 2026-11-02): exactly ONE audit item rides in the transaction. No ledger, or an event that does not validate (so no item), writes nothing.
      const auditItems = auditPending(deps, event);
      if (auditItems.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Changing company locks needs the audit ledger.");
      const put: TransactItem = { Put: {
        TableName: deps.tableName, Item: { ...setupLocksKey(next.orgId), entityType: "SETUP_LOCKS", ...next },
        ...(expectedRevision === null
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": expectedRevision } }),
      } };
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [put, ...conditions, ...auditItems] }));
      } catch (error) {
        // The row moved, or an evidence condition failed: the caller answers "that changed, refresh".
        if (error instanceof Error && error.name === "TransactionCanceledException") return false;
        throw error;
      }
      await flushAuditEvents(deps, [event]);
      return true;
    },
  };
}

