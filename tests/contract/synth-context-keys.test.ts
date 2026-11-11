// Review I1 (Opus): the build is made from the recorded settings, so a context key the infrastructure reads that the build cannot take would be silently dropped on the next upgrade
// (the DNS firewall allow-list was one). This scans every context read in infra/ and fails unless each key is taken from the settings, fixed by the install, or excluded with a reason.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYNTH_CONTEXT_KEYS, SYNTH_EXCLUDED_KEYS, SYNTH_FIXED_KEYS } from "@agentx/cloud-contracts";

const ROOT = join(import.meta.dirname, "..", "..");
const filesIn = (directory: string): string[] => readdirSync(join(ROOT, directory)).filter((name) => name.endsWith(".ts")).map((name) => join(directory, name));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** Every context key the infrastructure code reads: direct reads, the `*_CONTEXT_KEY(S)` constants it passes to reads, and the shared constants of the contracts it imports. */
export function contextKeysRead(): Map<string, string> {
  const found = new Map<string, string>();
  const note = (key: string, where: string) => { if (!found.has(key)) found.set(key, where); };
  for (const path of [...filesIn("infra/lib"), ...filesIn("infra/bin")]) {
    const text = read(path);
    for (const match of text.matchAll(/(?:tryGetContext|context)\(\s*"([^"]+)"/g)) note(match[1]!, path);
    for (const match of text.matchAll(/CONTEXT_KEYS?\b[^=\n]*=\s*"([^"]+)"/g)) note(match[1]!, path);
  }
  const mcp = read("infra/lib/private-mcp.ts");
  const block = /PRIVATE_MCP_CONTEXT_KEYS = \{([^}]*)\}/.exec(mcp)?.[1] ?? "";
  for (const match of block.matchAll(/:\s*"([^"]+)"/g)) note(match[1]!, "infra/lib/private-mcp.ts");
  const modelEndpoints = read("infra/lib/model-endpoints.ts");
  const endpointBlock = /MODEL_ENDPOINT_CONTEXT_KEYS = \{([^}]*)\}/.exec(modelEndpoints)?.[1] ?? "";
  for (const match of endpointBlock.matchAll(/:\s*"([^"]+)"/g)) note(match[1]!, "infra/lib/model-endpoints.ts");
  for (const path of ["packages/contracts/src/operator-access.ts", "packages/contracts/src/edition.ts"]) {
    for (const match of read(path).matchAll(/export const \w+_CONTEXT_KEY = "([^"]+)"/g)) note(match[1]!, path);
  }
  return found;
}

describe("every context key the infrastructure reads is accounted for in the build", () => {
  const taken = new Set<string>(SYNTH_CONTEXT_KEYS);
  const fixed = new Set<string>(SYNTH_FIXED_KEYS);
  const excluded = new Set(Object.keys(SYNTH_EXCLUDED_KEYS));

  it("finds the keys it should (so the scan itself is not empty)", () => {
    const keys = [...contextKeysRead().keys()];
    expect(keys).toEqual(expect.arrayContaining(["agentxEgressAllowDomains", "rovaraEnterpriseEgressCidrs", "agentxAuditTsa", "rovaraOperatorAccess", "rovaraPrivateMcpCidrs", "agentxEnv", "rovaraEdition", "agentx:autoRequalify", "agentxReservedConcurrency"]));
    expect(keys.length).toBeGreaterThan(30);
  });

  it("takes each from the recorded settings, fixes it from the install, or excludes it with a reason", () => {
    const unaccounted = [...contextKeysRead()].filter(([key]) => !taken.has(key) && !fixed.has(key) && !excluded.has(key)).map(([key, where]) => `${key} (read in ${where})`);
    expect(unaccounted, "add the key to SYNTH_CONTEXT_KEYS, or to SYNTH_EXCLUDED_KEYS with the reason it is not an install setting").toEqual([]);
  });

  it("puts no key in two places, gives every exclusion a reason, and lists no key the infrastructure does not read", () => {
    for (const key of taken) { expect(fixed.has(key), key).toBe(false); expect(excluded.has(key), key).toBe(false); }
    for (const key of fixed) expect(excluded.has(key), key).toBe(false);
    for (const [key, reason] of Object.entries(SYNTH_EXCLUDED_KEYS)) expect(reason.length, key).toBeGreaterThan(10);
    const read = new Set(contextKeysRead().keys());
    for (const key of [...taken, ...fixed, ...excluded]) expect(read.has(key), `${key} is listed but nothing in infra/ reads it`).toBe(true);
  });
});
