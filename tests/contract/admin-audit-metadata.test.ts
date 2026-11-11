import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { AUDIT_LIMITS_COPY as authoritative } from "@agentx/cloud-contracts";
import { AUDIT_LIMITS_COPY, GOVERNANCE_SENTENCE } from "../../packages/ui/src/screens/admin/audit/metadata.js";
it("keeps browser audit limits identical to the verifier contract", () => { expect(AUDIT_LIMITS_COPY).toBe(authoritative); });
it("keeps the browser governance caveat identical to the CLI", () => {
 const source=readFileSync("packages/cli/src/developer/audit.ts","utf8"), literal=source.match(/const GOVERNANCE_SENTENCE = ("[^\n]+?");/);expect(literal).not.toBeNull();expect(GOVERNANCE_SENTENCE).toBe(JSON.parse(literal![1]!));
});
