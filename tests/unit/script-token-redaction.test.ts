// UX5b (review I5): a bare script token (`rvst_…`, no "Bearer" before it) is redacted wherever Rovara redacts credentials: the shared redactor, a chain hand-off, and the saved
// environment's secret scan. The token is built at run time, so nothing token-shaped is in this file.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { redactText } from "../../packages/contracts/src/redaction.js";
import { redactSecrets } from "../../packages/broker/src/chains/handoff.js";
import { scanTreeForSecrets } from "../../packages/worker/src/saved-env/secret-scan.js";
import { mintScriptToken } from "../../packages/broker/src/script-tokens/token-format.js";

const token = () => mintScriptToken(`org_${"a".repeat(20)}` as never, `stk_${"b".repeat(20)}`, (size) => randomBytes(size)).token;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("a bare script token is redacted", () => {
  it("by the shared redactor, alone, in prose and in an env line", () => {
    const value = token();
    for (const text of [value, `my token is ${value} ok`, `ROVARA_TOKEN=${value}`, `"${value}"`]) {
      const out = redactText(text);
      expect(out, text).not.toContain(value.slice(-43));
      expect(out).toContain("[REDACTED]");
    }
    // Prose that only names the prefix is kept.
    expect(redactText("tokens start with rvst_ and are shown once")).toBe("tokens start with rvst_ and are shown once");
  });

  it("in a chain hand-off", () => {
    const value = token();
    expect(redactSecrets(`deploy with ${value}`)).toBe("deploy with [redacted]");
  });

  it("by the saved environment's secret scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "scan-"));
    roots.push(root);
    await writeFile(join(root, "ci.sh"), `export ROVARA_TOKEN=${token()}\n`);
    expect(await scanTreeForSecrets(root)).toMatchObject({ ok: false, reason: "found", findings: [{ kind: "token", path: "ci.sh" }] });
  });
});
