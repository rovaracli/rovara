// Devices (Plan 5 Task 17): the Macs a member registers. A device is a `META` item in its own partition (`deviceKey`) and a row in its owner's list
// (`memberDevicesKey`, the sort key is the device id). Both are written in one transaction with the request's own item (R18). Removing a device marks the
// record `revokedAt` (with an expiry a year on) and deletes the list row, in one transaction; Task 18 ends the sessions that run on it. Everything is read
// live: the list row only says where to look, and a device counts and shows only when its record is this org's, this member's, well formed and not revoked.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DEVICES_LIMIT_MESSAGE, DeviceRecordSchema, DeviceViewSchema, RegisterDeviceBodySchema, deviceKey, memberDevicesKey, type DeviceRecord, type DeviceView, type OrgRole } from "@agentx/cloud-contracts";
import { DEVICES_PER_MEMBER_MAX, DeviceIdSchema, INDEX_EXPIRY_ATTRIBUTE, agentRequestKey, agentXError, canonicalJson, newPrefixedId, type OrgId } from "@rovara-code/contracts";
import type { AuditDeps } from "../audit/outbox.js";
import { commit, errorName, failedIndexes, readRequest, type Item, type RequestMark, type TableInput, type TransactItem } from "../agents/table-writes.js";

export interface DeviceDependencies extends TableInput, AuditDeps {
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** Who asks. `orgRole` is the caller's live role in `orgId`. */
export interface DeviceCaller {
  developerId: string;
  orgId: OrgId;
  orgRole: OrgRole;
}

/** How many list rows are read in one page, and how many pages at most. A removed device's row stays (marked `revokedAt`) for a year, so a member can have many rows and few live devices. */
export const DEVICE_ROWS_READ_MAX = 50;
export const DEVICE_ROW_PAGES_MAX = 20;
/** How long a removed device's record is kept (the member lifecycle uses the same). */
export const REVOKED_DEVICE_KEEP_DAYS = 365;
const DAY_SECONDS = 86_400;
const REMOVE_TRIES = 3;
const TAKE_BACK_TRIES = 3;

const isAdmin = (role: OrgRole) => role === "owner" || role === "admin";
const secondsOf = (ms: number) => Math.floor(ms / 1000);
const isoOf = (ms: number) => new Date(ms).toISOString();
const log = (deps: DeviceDependencies, entry: Record<string, unknown>) => (deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

export function deviceViewOf(record: DeviceRecord): DeviceView {
  return { deviceId: record.deviceId, label: record.label, platform: record.platform, createdAt: record.createdAt, lastSeenAt: record.lastSeenAt };
}

/** The error text for a body that doesn't fit: the first field that is wrong, never the value. */
export function invalidBody(issue: { path: PropertyKey[]; code: string; message: string } | undefined): Error {
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.map(String).join(".");
  return agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

// ---- reading

/** The record under a device id, if it is this org's and well formed. A revoked record is returned (it has `revokedAt`). */
export async function readDevice(deps: DeviceDependencies, orgId: OrgId, deviceId: string): Promise<DeviceRecord | undefined> {
  const id = DeviceIdSchema.safeParse(deviceId);
  if (!id.success) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: deviceKey(orgId, id.data), ConsistentRead: true })) as { Item?: Item };
  return parseDevice(deps, response.Item, orgId, id.data);
}

function parseDevice(deps: DeviceDependencies, item: Item | undefined, orgId: OrgId, deviceId: string): DeviceRecord | undefined {
  if (item === undefined) return undefined;
  const { orgId: itemOrg, deviceId: itemId, developerId, label, platform, createdAt, lastSeenAt, revokedAt } = item;
  const parsed = DeviceRecordSchema.safeParse({ orgId: itemOrg, deviceId: itemId, developerId, label, platform, createdAt, lastSeenAt, ...(revokedAt === undefined ? {} : { revokedAt }) });
  if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.deviceId !== deviceId) {
    log(deps, { event: "devices.record_unreadable", orgId });
    return undefined;
  }
  return parsed.data;
}

/**
 * The member's live devices (this org's, theirs, well formed, not revoked), oldest first, read through every page of the member's list rows (up to `DEVICE_ROW_PAGES_MAX`).
 * A row marked `revokedAt` is skipped without reading its record; any other row is only a pointer, and the record decides. `complete` is false when the pages ran out first.
 */
async function readLiveDevices(deps: DeviceDependencies, orgId: OrgId, developerId: string): Promise<{ devices: DeviceRecord[]; complete: boolean }> {
  const devices: DeviceRecord[] = [];
  let start: Record<string, unknown> | undefined;
  let complete = false;
  for (let pageNumber = 0; pageNumber < DEVICE_ROW_PAGES_MAX; pageNumber += 1) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": memberDevicesKey(orgId, developerId, "dvc_00000000000000000000").pk },
      Limit: DEVICE_ROWS_READ_MAX, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    const ids: string[] = [];
    for (const row of page.Items ?? []) {
      const id = DeviceIdSchema.safeParse(row["sk"]);
      if (!id.success || row["orgId"] !== orgId || row["developerId"] !== developerId) log(deps, { event: "devices.row_unreadable", orgId });
      else if (row["revokedAt"] === undefined) ids.push(id.data);
    }
    const records = await Promise.all(ids.map((id) => readDevice(deps, orgId, id)));
    for (const record of records) if (record !== undefined && record.developerId === developerId && record.revokedAt === undefined) devices.push(record);
    start = page.LastEvaluatedKey;
    if (start === undefined) { complete = true; break; }
  }
  devices.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.deviceId.localeCompare(b.deviceId));
  return { devices, complete };
}

/** `GET /v1/app/devices`: the caller's own live devices. */
export async function listOwnDevices(deps: DeviceDependencies, caller: DeviceCaller): Promise<DeviceView[]> {
  const { devices, complete } = await readLiveDevices(deps, caller.orgId, caller.developerId);
  if (!complete) log(deps, { event: "devices.list_truncated", orgId: caller.orgId });
  return devices.map(deviceViewOf);
}

// ---- registering

/** What a request that already ran answered, if it is the same request; a different request with that id is refused. */
async function earlierAnswer(deps: DeviceDependencies, mark: RequestMark): Promise<DeviceView | undefined> {
  const earlier = await readRequest(deps, mark.orgId, mark.developerId, mark.requestId);
  if (earlier === undefined) return undefined;
  if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  const view = DeviceViewSchema.safeParse(earlier.result);
  if (!view.success) throw notFound();
  return view.data;
}

/**
 * A repeat of a registration answers its device only while that device is still the caller's and live: after it was removed the repeat is `NOT_FOUND`, so a client never
 * takes a removed Mac for a live one. A repeat that finds the member over the limit (an earlier take-back failed) finishes the take-back and is refused.
 */
async function answerRepeat(deps: DeviceDependencies, caller: DeviceCaller, mark: RequestMark, view: DeviceView): Promise<DeviceView> {
  const record = await readDevice(deps, caller.orgId, view.deviceId);
  if (record === undefined || record.developerId !== caller.developerId || record.revokedAt !== undefined) throw notFound();
  const live = await readLiveDevices(deps, caller.orgId, caller.developerId);
  if (!live.complete || live.devices.length > DEVICES_PER_MEMBER_MAX) {
    await takeBack(deps, record, mark);
    throw agentXError("CONFIG_INVALID", DEVICES_LIMIT_MESSAGE);
  }
  return view;
}

/**
 * `POST /v1/app/devices`: registers the caller's own Mac. The member keeps at most `DEVICES_PER_MEMBER_MAX` live devices, counted from what is stored; because
 * two requests can pass the count together, the list is read again after the write and a request that finds more than the limit takes its own device back and is refused.
 */
export async function registerDevice(deps: DeviceDependencies, caller: DeviceCaller, body: unknown): Promise<DeviceView> {
  const parsed = RegisterDeviceBodySchema.safeParse(body);
  if (!parsed.success) throw invalidBody(parsed.error.issues[0]);
  const input = parsed.data;
  const { orgId, developerId } = caller;
  const mark: RequestMark = { orgId, developerId, requestId: input.requestId, fingerprint: sha256({ route: "device_register", label: input.label, platform: input.platform }) };
  const replay = await earlierAnswer(deps, mark);
  if (replay !== undefined) return answerRepeat(deps, caller, mark, replay);

  const before = await readLiveDevices(deps, orgId, developerId);
  if (!before.complete || before.devices.length >= DEVICES_PER_MEMBER_MAX) throw agentXError("CONFIG_INVALID", DEVICES_LIMIT_MESSAGE);

  const at = isoOf(deps.now());
  const deviceId = newPrefixedId("dvc");
  const record: DeviceRecord = { orgId, deviceId, developerId, label: input.label, platform: "mac", createdAt: at, lastSeenAt: at };
  const view = deviceViewOf(record);
  const items: TransactItem[] = [
    { Put: { TableName: deps.tableName, Item: { ...deviceKey(orgId, deviceId), entityType: "DEVICE", ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { ...memberDevicesKey(orgId, developerId, deviceId), entityType: "MEMBER_DEVICE", orgId, developerId, deviceId, createdAt: at }, ConditionExpression: "attribute_not_exists(pk)" } },
  ];
  try {
    await commit(deps, items, () => undefined, mark, view);
  } catch (error) {
    // Lost to the same request running at the same time: its answer is this one's.
    if (error instanceof Error && (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT") {
      const won = await earlierAnswer(deps, mark);
      if (won !== undefined) return answerRepeat(deps, caller, mark, won);
    }
    throw error;
  }

  const after = await readLiveDevices(deps, orgId, developerId);
  if (!after.complete || after.devices.length > DEVICES_PER_MEMBER_MAX) {
    await takeBack(deps, record, mark);
    throw agentXError("CONFIG_INVALID", DEVICES_LIMIT_MESSAGE);
  }
  return view;
}

/**
 * Deletes a device registered a moment ago and its request item, as if it never was, trying `TAKE_BACK_TRIES` times. If it can't, the registration fails closed with a
 * retryable error (the repeat of the same request finishes the take-back, see `answerRepeat`), so the member is never told they have an eleventh device.
 */
async function takeBack(deps: DeviceDependencies, record: DeviceRecord, mark: RequestMark): Promise<void> {
  for (let attempt = 0; attempt < TAKE_BACK_TRIES; attempt += 1) {
    try {
      await deps.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: deps.tableName, Key: deviceKey(record.orgId, record.deviceId) } },
          { Delete: { TableName: deps.tableName, Key: memberDevicesKey(record.orgId, record.developerId, record.deviceId) } },
          { Delete: { TableName: deps.tableName, Key: agentRequestKey(mark.orgId, mark.developerId, mark.requestId) } },
        ],
      }));
      return;
    } catch (error) {
      log(deps, { event: "devices.take_back_failed", orgId: record.orgId, error: errorName(error) ?? "unknown" });
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "Couldn't finish registering that device. Try again.");
}

// ---- removing

/**
 * `DELETE /v1/app/devices/{id}`: removes the caller's own device, or anyone's in the org when the caller is an owner or admin. A device that is missing, in
 * another org or another member's (for a caller who is not an admin) is `NOT_FOUND`. Removing a removed device answers the same and keeps its first time.
 * Returns the record as it was removed, for Task 18 to end the sessions that run on it.
 */
export async function revokeDevice(deps: DeviceDependencies, caller: DeviceCaller, deviceId: string): Promise<DeviceRecord> {
  const id = DeviceIdSchema.safeParse(deviceId);
  if (!id.success) throw notFound();
  for (let attempt = 0; attempt < REMOVE_TRIES; attempt += 1) {
    const record = await readDevice(deps, caller.orgId, id.data);
    if (record === undefined || (record.developerId !== caller.developerId && !isAdmin(caller.orgRole))) throw notFound();
    if (record.revokedAt !== undefined) return record;
    const nowMs = deps.now();
    const at = isoOf(nowMs);
    const expires = secondsOf(nowMs) + REVOKED_DEVICE_KEEP_DAYS * DAY_SECONDS;
    try {
      await deps.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName, Key: deviceKey(caller.orgId, id.data), UpdateExpression: "SET revokedAt = :at, #expires = :expires",
              ConditionExpression: "attribute_exists(pk) AND orgId = :org AND developerId = :developer AND attribute_not_exists(revokedAt)",
              ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },
              ExpressionAttributeValues: { ":at": at, ":expires": expires, ":org": caller.orgId, ":developer": record.developerId },
            },
          },
          // The member's list row stays, marked, so the member lifecycle (org close) still finds this device; it goes with the record.
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                ...memberDevicesKey(caller.orgId, record.developerId, id.data), entityType: "MEMBER_DEVICE", orgId: caller.orgId, developerId: record.developerId, deviceId: id.data,
                createdAt: record.createdAt, revokedAt: at, [INDEX_EXPIRY_ATTRIBUTE]: expires,
              },
            },
          },
        ],
      }));
      return { ...record, revokedAt: at };
    } catch (error) {
      // The record moved to another member (a merge) or was removed by someone else first: read it again and decide.
      if (failedIndexes(error) === undefined) throw error;
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "That device changed while it was removed. Try again.");
}

const notFound = () => agentXError("NOT_FOUND", "device not found");
