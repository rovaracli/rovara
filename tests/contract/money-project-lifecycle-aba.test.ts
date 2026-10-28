// M33: real archive then restore inside an existing AI-settings write; no new lifecycle policy.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { projectAiKey, projectMetaKey } from "@agentx/contracts";
import { applyArchiveRequest } from "../../packages/broker/src/org/project-archive.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { BEN, DEB, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
for (const who of [BEN, DEB]) for (const legacy of [false, true]) it(`archive then restore during ${who.name}'s settings commit with ${legacy ? "absent" : "existing active"} META`, async () => {
  const capture = capturingAuditDeps(), t = await setup({ extra: { audit: capture.audit } }); capture.attach(t.db);
  const key = projectAiKey(TEST_ORG, "payments"), meta = projectMetaKey(TEST_ORG, "payments");
  t.db.set({ ...key, entityType: "PROJECT_AI", projectPays: false, memberAcceptRunLimitUpToUsd: 1, revision: 1 });
  if (legacy) t.db.delete(meta); else t.db.set({ ...meta, entityType: "PROJECT_META", name: "payments", status: "active", createdAt: "2026-10-01T00:00:00Z", createdBy: DEB.developerId });
  const deps = { documentClient: t.db, tableName: "state", now: () => new Date(), egress: { documentClient: t.db, tableName: "state", cloud: true, now: () => new Date(), sync: async () => ({ ok: true as const }) } };
  const send = t.db.send.bind(t.db); let raced = false;
  t.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Put?: { Item?: { pk?: string; sk?: string } } }> }).TransactItems;
    if (!raced && items?.some(item => item.Put?.Item?.pk === key.pk && item.Put.Item.sk === key.sk)) {
      raced = true;
      await applyArchiveRequest(deps, TEST_ORG, "payments", "archive", randomUUID(), { developerId: DEB.developerId });
      expect(t.db.get(meta)?.status).toBe("archived");
      await applyArchiveRequest(deps, TEST_ORG, "payments", "restore", randomUUID(), { developerId: DEB.developerId });
      expect(t.db.get(meta)?.status).toBe("active");
    }
    return send(command);
  };
  const change = () => t.api(who, "PUT", "/v1/app/projects/payments/ai", { memberAcceptRunLimitUpToUsd: 2 });
  expect((await change()).status).toBe(legacy ? 409 : 200); expect(raced).toBe(true);
  if (legacy) {
    expect(t.db.get(key)?.revision).toBe(1); expect(capture.recorded()).toHaveLength(0); expect(capture.pending()).toHaveLength(0);
    expect((await change()).status).toBe(200);
  }
  expect(t.db.get(meta)?.status).toBe("active"); expect(t.db.get(key)).toMatchObject({ revision: 2, memberAcceptRunLimitUpToUsd: 2 });
  expect(capture.recordedBy("budget.changed")).toHaveLength(1); expect(capture.pending()).toHaveLength(0);
});
