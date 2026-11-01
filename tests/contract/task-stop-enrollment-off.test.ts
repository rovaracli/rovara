import { expect, it } from "vitest";
import { projectAiKey } from "@agentx/contracts";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
it("unenrolled project registration preserves absent AI settings and emits no M47 seed audit", async () => {
 const audit = capturingAuditDeps(), h = await createDeveloperTaskBroker({ audit });
 expect(h.db.get(projectAiKey(TEST_ORG, "payments"))).toBeUndefined();
 expect(audit.recordedBy("spending.policy_seeded")).toEqual([]);
});
