// Convergence S0, D12 (decision 74): a core write keeps an expiry only on a kind Cloud already expires; everything else is kept as Cloud keeps it today.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { change } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { CLOUD_TTL_KINDS, cloudRetentionStore, retentionFor, withCloudRetention } from "../../packages/broker/src/cloud/app/retention.js";

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return path.endsWith(join("cloud", "app")) ? [] : await sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("Cloud's retention for core writes", () => {
  it("lists every kind Cloud's own broker writes with an expiry (a new one must be reviewed here, not stripped silently)", async () => {
    const found = new Set<string>();
    for (const file of await sources(join(import.meta.dirname, "../../packages/broker/src"))) {
      for (const line of (await readFile(file, "utf8")).split("\n")) {
        if (!/INDEX_EXPIRY_ATTRIBUTE|indexExpiresAt/.test(line)) continue;
        for (const match of line.matchAll(/entityType: "([A-Z_]+)"/g)) found.add(match[1]!);
      }
    }
    expect(found.size).toBeGreaterThan(20);
    expect([...found].filter((kind) => !CLOUD_TTL_KINDS.has(kind)).sort()).toEqual([]);
  });

  it("strips the expiry of the kinds Cloud keeps (approvals, decisions, proof markers, evidence, the cost ledger) and of unknown kinds", () => {
    for (const kind of ["APPROVAL_PROOF_USED", "APPROVAL_DECISION", "COST_ENTRY_ONCE", "SESSION_SUMMARY", "EVIDENCE_BLOB", undefined, "SOMETHING_NEW"]) {
      expect(retentionFor(kind), String(kind)).toBe("strip");
      expect(withCloudRetention({ pk: "p", sk: "s", ...(kind === undefined ? {} : { entityType: kind }), indexExpiresAt: 5, other: 1 })).toEqual({ pk: "p", sk: "s", ...(kind === undefined ? {} : { entityType: kind }), other: 1 });
    }
    for (const kind of ["WORKFLOW_DISPATCH", "PR_HEAD", "WORK_EVENT", "NOTIFY_PENDING"]) expect(retentionFor(kind)).toBe("keep");
  });

  it("applies to puts, transactions and updates (an update that sets an expiry keeps it only when it also names a kept kind)", async () => {
    const inner = new MemoryDocumentStore();
    const store = cloudRetentionStore(inner);
    await store.transact([
      { kind: "put", item: { pk: "a", sk: "1", entityType: "APPROVAL_PROOF_SPENT", indexExpiresAt: 9 } },
      { kind: "put", item: { pk: "a", sk: "2", entityType: "PR_HEAD", indexExpiresAt: 9 } },
      { kind: "update", key: { pk: "a", sk: "3" }, ops: [change.set("indexExpiresAt", 9), change.set("x", 1)] },
    ]);
    await store.update({ key: { pk: "a", sk: "4" }, ops: [change.set("entityType", "WORK_EVENT"), change.set("indexExpiresAt", 9)] });
    expect(await inner.get({ pk: "a", sk: "1" })).not.toHaveProperty("indexExpiresAt");
    expect(await inner.get({ pk: "a", sk: "2" })).toHaveProperty("indexExpiresAt", 9);
    expect(await inner.get({ pk: "a", sk: "3" })).toEqual({ pk: "a", sk: "3", x: 1 });
    expect(await inner.get({ pk: "a", sk: "4" })).toHaveProperty("indexExpiresAt", 9);
  });

  // The suggestion allowance's kind and expiry are on separate source lines, so the scan above cannot see it.
  it.each(["CODE_SUGGESTION", "CODE_SUGGESTION_RATE"])("keeps the existing 24-hour expiry for %s through every write path", async (entityType) => {
    const inner = new MemoryDocumentStore();
    const store = cloudRetentionStore(inner);
    const expiry = 1_800_000_000 + 86_400;
    const item = { pk: "ORG#retention-test", sk: "put", entityType, indexExpiresAt: expiry };
    expect(retentionFor(entityType)).toBe("keep");
    await store.put({ item });
    await store.transact([{ kind: "put", item: { ...item, sk: "transaction" } }]);
    await store.update({ key: { pk: item.pk, sk: "update" }, ops: [change.set("entityType", entityType), change.set("indexExpiresAt", expiry)] });
    await store.transact([{ kind: "update", key: { pk: item.pk, sk: "transaction-update" }, ops: [change.set("entityType", entityType), change.set("indexExpiresAt", expiry)] }]);
    for (const sk of ["put", "transaction", "update", "transaction-update"]) {
      expect(await inner.get({ pk: item.pk, sk })).toEqual({ ...item, sk });
    }
  });
});
