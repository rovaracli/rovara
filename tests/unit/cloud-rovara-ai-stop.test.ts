import { expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { DynamoCloudAuditStore } from "../../packages/cloud-server/src/dynamo-stores.js";
import { buildAuditRecord, checkedAuditScope, checkedCompany } from "../../packages/cloud-server/src/audit-log.js";
import { writeInstallRovaraAi } from "../../packages/cloud-server/src/rovara-ai-stop-operator.js";

const key = { pk: "INSTALL#ROVARA_AI", sk: "SETTING" };
const who = "arn:aws:iam::123456789012:user/operator";
const at = new Date("2026-11-21T23:00:00.000Z");
it.each([true, false])("operator toggle %s atomically writes the only setting and existing append-only audit + id marker", async enabled => {
  const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({});
  await writeInstallRovaraAi({ send }, { companies: "companies", audit: "state" }, { key, enabled, operatorArn: who }, () => at);
  expect(send).toHaveBeenCalledTimes(2);
  const command: unknown = send.mock.calls[1]![0];
  expect(command).toBeInstanceOf(TransactWriteCommand);
  const writes = (command as TransactWriteCommand).input.TransactItems!;
  expect(writes).toHaveLength(3);
  expect(writes[0]!.Put).toMatchObject({ TableName: "companies", Item: { ...key, enabled, version: 1, updatedBy: who, updatedAt: at.toISOString() }, ConditionExpression: "attribute_not_exists(pk)" });
  expect(writes[1]!.Put).toMatchObject({ TableName: "state", Item: { pk: "AUDIT#INSTALL#ROVARA_AI#2026-11", record: { companyId: key.pk, at: at.toISOString(), actor: { developerId: "operator", name: who, type: "operator" }, action: "install.rovara_ai.changed", detail: enabled ? "enabled" : "paused" } }, ConditionExpression: "attribute_not_exists(pk)" });
  expect(writes[2]!.Put?.Item?.pk).toMatch(/^AUDITID#INSTALL#ROVARA_AI#aud_/u);
});

it.each([{ pk: key.pk, sk: "AUDIT" }, { pk: "COMPANY#org_other", sk: key.sk }])("writer refuses every other key before touching storage (%j)", async other => {
  const send = vi.fn();
  await expect(writeInstallRovaraAi({ send }, { companies: "companies", audit: "state" }, { key: other, enabled: false, operatorArn: who }, () => at)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it.each([
  "operator",
  "arn:aws:iam::123:user/operator",
  "arn:aws:iam::123456789012:user/operator extra",
  "arn:aws:iam::123456789012:root",
])("writer refuses a malformed operator ARN before touching storage (%s)", async operatorArn => {
  const send = vi.fn().mockResolvedValue({});
  await expect(writeInstallRovaraAi({ send }, { companies: "companies", audit: "state" }, { key, enabled: false, operatorArn }, () => at)).rejects.toThrow("operator setting refused");
  expect(send).not.toHaveBeenCalled();
});

it.each(["INSTALL#OTHER", "INSTALL#ROVARA_AI#OTHER"])("audit refuses any other install scope (%s)", scope => {
  expect(() => checkedAuditScope(scope)).toThrow();
});

it("audit install scope cannot be supplied as a company or customer actor", () => {
  expect(() => checkedCompany(key.pk)).toThrow();
  expect(() => buildAuditRecord({ companyId: key.pk, actor: { developerId: "customer", name: "Customer" }, action: "install.rovara_ai.changed" }, at)).toThrow();
});

it("no toggle is written if the audited transaction fails; no unaudited fallback", async () => {
  const send = vi.fn().mockResolvedValueOnce({ Item: { ...key, enabled: true, version: 7 } }).mockRejectedValueOnce(new Error("audit unavailable"));
  await expect(writeInstallRovaraAi({ send }, { companies: "companies", audit: "state" }, { key, enabled: false, operatorArn: who }, () => at)).rejects.toThrow("audit unavailable");
  expect(send).toHaveBeenCalledTimes(2);
  expect((send.mock.calls[1]![0] as TransactWriteCommand).input.TransactItems![0]!.Put).toMatchObject({ ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": 7 } });
});

it("two operator toggles keep exactly one reserved item and two isolated install audit rows", async () => {
  const db = new FakeDynamoDb();
  await writeInstallRovaraAi(db, { companies: "companies", audit: "state" }, { key, enabled: false, operatorArn: who }, () => at);
  await writeInstallRovaraAi(db, { companies: "companies", audit: "state" }, { key, enabled: true, operatorArn: who }, () => new Date(at.getTime() + 1000));
  const audit = new DynamoCloudAuditStore(db, "state", () => at.getTime() + 2000);
  const rows = (await audit.read(key.pk, { max: 10 })).rows;
  expect(rows.map(row => row.detail)).toEqual(["enabled", "paused"]);
  expect(rows.every(row => row.actor.type === "operator" && row.actor.developerId === "operator")).toBe(true);
  expect((await audit.read("org_aaaaaaaaaaaaaaaaaaaa", { max: 10 })).rows).toEqual([]);
});
