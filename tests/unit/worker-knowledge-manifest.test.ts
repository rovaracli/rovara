import { describe, expect, it } from "vitest";
import { MAX_LOADED_KNOWLEDGE_ITEMS } from "@agentx/contracts";
import { buildLoadedKnowledgeManifest, loadedKnowledgePayload } from "../../packages/worker/src/knowledge/manifest.js";
import type { KnowledgeRecord, ResolvedKnowledge } from "../../packages/worker/src/knowledge/resolve.js";

const resolved = (records: KnowledgeRecord[]): ResolvedKnowledge => ({
  items: [], autoCatalog: [], autoItems: new Map(), manualItems: new Map(), pendingMatches: [], records, notices: [], diagnostics: [], skills: [], skippedSkills: [],
  budget: { alwaysOnBytes: 1, alwaysOnLimitBytes: 2, additionsBytes: 0, additionsLimitBytes: 2, skipped: 0 },
});
const record = (index: number, status: KnowledgeRecord["status"]): KnowledgeRecord => ({
  layer: "repo", repo: "r", path: `f${index}.md`, scopeDir: "", format: "agents_md", bytes: 1, status, ...(status === "skipped" ? { reason: "not_matched" as const } : {}),
});

describe("buildLoadedKnowledgeManifest", () => {
  it("keeps loaded items first and counts what it leaves out when the record is full", () => {
    const records = [
      ...Array.from({ length: MAX_LOADED_KNOWLEDGE_ITEMS - 10 }, (_unused, index) => record(index, "skipped")),
      ...Array.from({ length: 20 }, (_unused, index) => record(1000 + index, "loaded")),
      ...Array.from({ length: 30 }, (_unused, index) => record(2000 + index, "available")),
    ];
    const manifest = buildLoadedKnowledgeManifest({ stage: "plan", resolved: resolved(records), repositories: [{ name: "r", readAt: "working" }] });
    expect(manifest.items).toHaveLength(MAX_LOADED_KNOWLEDGE_ITEMS);
    expect(manifest.items.slice(0, 20).every((item) => item.status === "loaded")).toBe(true);
    expect(manifest.omitted).toEqual({ skipped: 10, available: 30 });
  });

  it("removes hidden characters from names and paths, and carries the record under one event field", () => {
    const manifest = buildLoadedKnowledgeManifest({
      stage: "build", resolved: resolved([{ ...record(1, "loaded"), path: "a‮b.md", name: "n​m" }]), repositories: [],
    });
    expect(manifest.items[0]).toMatchObject({ path: "ab.md", name: "nm" });
    expect(Object.keys(loadedKnowledgePayload(manifest))).toEqual(["loadedKnowledge"]);
  });
});
