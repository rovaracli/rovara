// Company-approved extra test-service images (switch `pj`), the DynamoDB adapter of `CompanyImageStore`. Rows live in the company's partition (`ORG#<id>`):
//   TESTIMAGE#<imageId>   the image (waiting or approved; a revoked or dismissed image has no row: the audit ledger is its history);
//   TESTIMAGE_COUNTS      the live and waiting counts: every write that adds one increments with a condition in the SAME transaction, so the caps cannot be raced past.
// Every write is ONE TransactWriteItems: the row (conditional on the revision the caller read), the counters and the audit item. A cancelled transaction answers false (the caller then says CHANGE_STALE). A write without an
// audit ledger is refused: approving an image is company authority, so there is no unaudited path.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, agentXError, companyImageExtraRegistriesOf, companyImageRegistryRule, orgPk, type AuditEventInput, type CompanyImageMirrorRef, type OrgId } from "@agentx/contracts";
import { auditCompanyImageChange, auditCompanyImageRegistriesChanged, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { COMPANY_IMAGES_MAX, COMPANY_IMAGES_MAX_WAITING, CompanyImageIdSchema, CompanyImageSchema, companyImagesOf, type CompanyImage } from "../test-env/company-images.js";
import { readCompanyImageMirrors, type MirrorStarter } from "../test-env/company-image-mirrors.js";
import type { CompanyImageAuditEntry, CompanyImageRegistriesAuditEntry, CompanyImageStore } from "./company-test-images.js";

type Row = Record<string, unknown>;
export interface CompanyImageTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The Audit Ledger's outbox. Without it every write is refused. */
  audit?: AuditRuntime | undefined;
}

const rowKey = (orgId: OrgId, imageId: string): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: `TESTIMAGE#${imageId}` });
const countsKey = (orgId: OrgId): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: "TESTIMAGE_COUNTS" });
const registriesKey = (orgId: OrgId): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: "TESTIMAGE_REGISTRIES" });
const LIST_PAGES_MAX = 3;

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Company images could not be read.");
const auditUnavailable = () => agentXError("AUDIT_UNAVAILABLE", "Company images need the audit ledger.");
const cancelled = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");

/** The stored attributes that are not part of the record (keys, entity type) are dropped; a row that does not parse is no row, so it is never approved. */
function imageOf(raw: Row | undefined, orgId: OrgId): CompanyImage | undefined {
  if (raw === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = raw;
  void _pk; void _sk; void _type;
  return companyImagesOf([rest], orgId)[0];
}

/** The audit event of one entry: the actor is the person, the target the company, the facts the id, the digest and the authority; the image's name is in `details`. */
export function companyImageAuditEvent(entry: CompanyImageAuditEntry): AuditEventInput {
  return auditCompanyImageChange({
    orgId: entry.orgId, actor: { kind: "member", id: entry.actor }, occurredAt: entry.at, occurrence: auditOccurrence(entry.imageId, entry.cycle, String(entry.revision), entry.action), action: entry.action,
    imageId: entry.imageId, digest: entry.digest, authority: entry.authority, details: [{ subject: "org", fields: { image: entry.image } }],
  });
}

/** The audit event of a change to the company's extra registries: the count and the authority are facts; the one host that changed is in `details`. */
export function companyImageRegistriesAuditEvent(entry: CompanyImageRegistriesAuditEntry): AuditEventInput {
  return auditCompanyImageRegistriesChanged({
    orgId: entry.orgId, actor: { kind: "member", id: entry.actor }, occurredAt: entry.at, occurrence: auditOccurrence("registries", String(entry.revision)), registryCount: entry.count, authority: "fresh_sign_in",
    details: [{ subject: "org", fields: { registry: entry.host, change: entry.change } }],
  });
}

export function dynamoCompanyImageStore(table: CompanyImageTable): CompanyImageStore {
  const get = async (key: { pk: string; sk: string }): Promise<Row | undefined> => ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Row }).Item;

  async function transact(items: TransactItem[], event: AuditEventInput): Promise<boolean> {
    if (table.audit === undefined) throw auditUnavailable();
    const audit = auditPending({ audit: table.audit }, event);
    if (audit.length === 0) throw auditUnavailable();
    try { await table.documentClient.send(new TransactWriteCommand({ TransactItems: [...items, ...audit] })); } catch (error) {
      if (cancelled(error)) return false;
      throw error;
    }
    await flushAuditEvents({ audit: table.audit }, [event]);
    return true;
  }

  /**
   * The counters change in the SAME transaction as the row. Adding is capped (a condition on the counter). Taking away (a revoke, a dismissal, an approval of a waiting image) CLAMPS AT ZERO: a missing or low counter
   * row (a manual repair, a restore) must never block a safety action, so the new value is `max(0, old + delta)`, written as an absolute value under a condition on exactly the value that was read (a lost race is
   * a cancelled transaction, which the caller answers as CHANGE_STALE, and the caller can then try again).
   */
  async function countsUpdate(orgId: OrgId, live: number, waiting: number): Promise<TransactItem> {
    const names: Record<string, string> = { "#live": "live", "#waiting": "waiting" };
    if (live < 0 || waiting < 0) {
      const current = await get(countsKey(orgId));
      const read = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
      const curLive = read(current?.["live"]);
      const curWaiting = read(current?.["waiting"]);
      const values: Record<string, unknown> = { ":nl": Math.max(0, curLive + live), ":nw": Math.max(0, curWaiting + waiting), ":type": "TESTIMAGE_COUNTS" };
      const conditions: string[] = [];
      if (current === undefined) conditions.push("attribute_not_exists(pk)");
      else for (const [name, field] of [["#live", "live"], ["#waiting", "waiting"]] as const) {
        if (current[field] === undefined) conditions.push(`attribute_not_exists(${name})`);
        else { conditions.push(`${name} = :c${field}`); values[`:c${field}`] = current[field]; }
      }
      return { Update: {
        TableName: table.tableName, Key: countsKey(orgId), UpdateExpression: "SET #live = :nl, #waiting = :nw, entityType = :type",
        ExpressionAttributeNames: names, ExpressionAttributeValues: values, ConditionExpression: conditions.join(" AND "),
      } };
    }
    const values: Record<string, unknown> = { ":zero": 0, ":dl": live, ":dw": waiting, ":type": "TESTIMAGE_COUNTS" };
    const conditions: string[] = [];
    if (live > 0) { conditions.push("(attribute_not_exists(#live) OR #live < :maxLive)"); values[":maxLive"] = COMPANY_IMAGES_MAX; }
    if (waiting > 0) { conditions.push("(attribute_not_exists(#waiting) OR #waiting < :maxWaiting)"); values[":maxWaiting"] = COMPANY_IMAGES_MAX_WAITING; }
    return { Update: {
      TableName: table.tableName, Key: countsKey(orgId), UpdateExpression: "SET #live = if_not_exists(#live, :zero) + :dl, #waiting = if_not_exists(#waiting, :zero) + :dw, entityType = :type",
      ExpressionAttributeNames: names, ExpressionAttributeValues: values, ...(conditions.length === 0 ? {} : { ConditionExpression: conditions.join(" AND ") }),
    } };
  }

  const fence = (expected: number) => ({ ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expected } });

  return {
    async get(orgId, imageId) {
      if (!OrgIdSchema.safeParse(orgId).success || !CompanyImageIdSchema.safeParse(imageId).success) return undefined;
      return imageOf(await get(rowKey(orgId, imageId)), orgId);
    },

    async list(orgId) {
      if (!OrgIdSchema.safeParse(orgId).success) return [];
      const out: CompanyImage[] = [];
      let start: Row | undefined;
      for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
        const result = await table.documentClient.send(new QueryCommand({
          TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "TESTIMAGE#" },
          ConsistentRead: true, Limit: 100, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })) as { Items?: Row[]; LastEvaluatedKey?: Row };
        for (const raw of result.Items ?? []) {
          const image = imageOf(raw, orgId);
          if (image !== undefined) out.push(image);
        }
        start = result.LastEvaluatedKey;
        if (start === undefined) return out.sort((a, b) => (a.imageId < b.imageId ? -1 : 1));
      }
      // The live partition is bounded by the caps; never a partial list passed off as everything (a missing approval would only refuse, but a missing card would hide a waiting image).
      throw unavailable();
    },

    async commit(next, expectedRevision, entry) {
      if (!OrgIdSchema.safeParse(next.orgId).success || next.orgId !== entry.orgId || !CompanyImageSchema.safeParse(next).success) return false;
      let waiting = next.status === "proposed" ? 1 : 0;
      let live = 1;
      if (expectedRevision !== null) {
        const previous = imageOf(await get(rowKey(next.orgId, next.imageId)), next.orgId);
        if (previous === undefined || previous.revision !== expectedRevision) return false;
        live = 0;
        waiting = (next.status === "proposed" ? 1 : 0) - (previous.status === "proposed" ? 1 : 0);
      }
      const items: TransactItem[] = [{ Put: { TableName: table.tableName, Item: { ...rowKey(next.orgId, next.imageId), entityType: "COMPANY_TEST_IMAGE", ...next }, ...(expectedRevision === null ? { ConditionExpression: "attribute_not_exists(pk)" } : fence(expectedRevision)) } }];
      if (live !== 0 || waiting !== 0) items.push(await countsUpdate(next.orgId, live, waiting));
      return transact(items, companyImageAuditEvent(entry));
    },

    async registries(orgId) {
      if (!OrgIdSchema.safeParse(orgId).success) return { revision: 0, hosts: [] };
      const row = await get(registriesKey(orgId));
      const revision = typeof row?.["revision"] === "number" && Number.isSafeInteger(row["revision"]) && row["revision"] >= 1 ? row["revision"] : 0;
      // A stored list that is damaged can only shrink: every host is checked again on the way out.
      return { revision, hosts: revision === 0 ? [] : companyImageExtraRegistriesOf(row?.["hosts"]) };
    },

    async commitRegistries(orgId, hosts, expectedRevision, entry) {
      if (!OrgIdSchema.safeParse(orgId).success || orgId !== entry.orgId || entry.revision !== expectedRevision + 1 || entry.count !== hosts.length || companyImageExtraRegistriesOf(hosts).length !== hosts.length) return false;
      const put = { Put: { TableName: table.tableName, Item: { ...registriesKey(orgId), entityType: "COMPANY_TEST_IMAGE_REGISTRIES", revision: entry.revision, hosts, updatedAt: entry.at, updatedBy: entry.actor },
        ...(expectedRevision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expectedRevision } }) } };
      return transact([put], companyImageRegistriesAuditEvent(entry));
    },

    async remove(current, entry) {
      if (!OrgIdSchema.safeParse(current.orgId).success || current.orgId !== entry.orgId) return false;
      const items: TransactItem[] = [
        { Delete: { TableName: table.tableName, Key: rowKey(current.orgId, current.imageId), ...fence(current.revision) } },
        await countsUpdate(current.orgId, -1, current.status === "proposed" ? -1 : 0),
      ];
      return transact(items, companyImageAuditEvent(entry));
    },
  };
}

/** The company's live rows, read by the broker itself when it plans a run (no caller's authority: it only reads what the planning needs). Never throws: an unreadable list is no approvals, so every image is refused. */
export async function readCompanyImages(table: Pick<CompanyImageTable, "documentClient" | "tableName">, orgId: OrgId): Promise<CompanyImage[]> {
  try {
    const store = dynamoCompanyImageStore(table);
    const [rows, registries] = await Promise.all([store.list(orgId), store.registries(orgId)]);
    // An image whose registry the company has since taken off its list is not served by a new plan.
    return rows.filter((row) => companyImageRegistryRule(row.registry, registries.hosts) !== undefined);
  } catch { return []; }
}

/**
 * What a plan needs of the company's images: the live approved rows (whose registry is still on the company's list) and the finished copies of them in the install's registry. A copy that is not finished starts the copier
 * (`readCompanyImageMirrors`). Never throws: an unreadable list is no approvals, so every image is refused.
 */
export async function readCompanyImagePlanInputs(
  table: Pick<CompanyImageTable, "documentClient" | "tableName">, orgId: OrgId, options: { env?: NodeJS.ProcessEnv; start?: MirrorStarter | undefined } = {},
): Promise<{ companyImages: CompanyImage[]; companyMirrors: Map<string, CompanyImageMirrorRef> }> {
  try {
    const store = dynamoCompanyImageStore(table);
    const [rows, registries] = await Promise.all([store.list(orgId), store.registries(orgId)]);
    const companyImages = rows.filter((row) => companyImageRegistryRule(row.registry, registries.hosts) !== undefined);
    const companyMirrors = await readCompanyImageMirrors(table, orgId, companyImages, { ...(options.env === undefined ? {} : { env: options.env }), ...("start" in options ? { start: options.start } : {}), extraRegistries: registries.hosts });
    return { companyImages, companyMirrors };
  } catch {
    return { companyImages: [], companyMirrors: new Map() };
  }
}
