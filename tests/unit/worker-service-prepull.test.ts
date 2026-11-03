// Test services TS19: the worker's pre-pull of catalog images. It pulls by digest only, inside a budget, and a failure never stops the worker.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { catalogPrepullList } from "@agentx/contracts";
import { EMPTY_PREPULL_LIST, PREPULL_LIST_URL, loadPrepullList, prepullCatalogImages, prepullReferences } from "../../packages/worker/src/service-prepull.js";
import { pinnedCatalog, sha } from "../support/catalog-pinning.js";

const list = catalogPrepullList(pinnedCatalog());
const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";

describe("the shipped list", () => {
  it("is where the worker image puts it, next to dist, and is valid (empty until the catalog is pinned)", async () => {
    expect(PREPULL_LIST_URL.pathname.endsWith("/packages/worker/service-catalog/prepull.json")).toBe(true);
    expect(await loadPrepullList()).toEqual({ schemaVersion: 1, catalogRevision: 1, images: [] });
  });
  it("is the empty list when the file is not there, and an error when it is there and wrong or too large", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prepull-test-"));
    try {
      expect(await loadPrepullList(pathToFileURL(join(dir, "missing.json")))).toEqual(EMPTY_PREPULL_LIST);
      await writeFile(join(dir, "tag.json"), JSON.stringify({ ...list, images: [{ ...list.images[0], digest: "latest" }] }));
      await expect(loadPrepullList(pathToFileURL(join(dir, "tag.json")))).rejects.toThrow();
      await writeFile(join(dir, "big.json"), " ".repeat(70_000));
      await expect(loadPrepullList(pathToFileURL(join(dir, "big.json")))).rejects.toThrow("too large");
      await writeFile(join(dir, "good.json"), JSON.stringify(list));
      expect(await loadPrepullList(pathToFileURL(join(dir, "good.json")))).toEqual(list);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the references", () => {
  it("are registry/rovara-catalog/<env>/<repository>@sha256:<digest> and have no tag", () => {
    const references = prepullReferences(list, { registry: REGISTRY, env: "staging" });
    expect(references.map((reference) => reference.id)).toEqual(list.images.map((image) => image.id));
    for (const { reference } of references) expect(reference).toMatch(new RegExp(`^${REGISTRY.replaceAll(".", "\\.")}/rovara-catalog/staging/svc/[a-z0-9._-]+@sha256:[a-f0-9]{64}$`, "u"));
  });
  it("refuse a registry or environment that is not a plain name", () => {
    expect(() => prepullReferences(list, { registry: "https://r.example.com", env: "staging" })).toThrow();
    expect(() => prepullReferences(list, { registry: REGISTRY, env: "../x" })).toThrow();
  });
});

describe("pulling ahead", () => {
  it("pulls each image once, in order, by its digest reference", async () => {
    const pulled: string[] = [];
    const result = await prepullCatalogImages({ list, registry: REGISTRY, env: "staging", ports: { pull: async (reference) => { pulled.push(reference); } } });
    expect(result.pulled).toEqual(list.images.map((image) => image.id));
    expect(pulled).toHaveLength(list.images.length);
    expect(pulled.every((reference) => /@sha256:[a-f0-9]{64}$/u.test(reference))).toBe(true);
    expect(result.failed).toEqual([]);
  });
  it("skips what the host already holds", async () => {
    const pulled: string[] = [];
    const result = await prepullCatalogImages({ list, registry: REGISTRY, env: "staging", ports: { pull: async (reference) => { pulled.push(reference); }, present: async (reference) => reference.includes("svc/postgres@") } });
    expect(result.alreadyPresent).toEqual(["postgres@16"]);
    expect(pulled.some((reference) => reference.includes("svc/postgres@"))).toBe(false);
  });
  it("reports a failed pull and carries on with the rest", async () => {
    const result = await prepullCatalogImages({ list, registry: REGISTRY, env: "staging", ports: { pull: async (reference) => { if (reference.includes("svc/mysql@")) throw new Error("manifest unknown"); } } });
    expect(result.failed).toEqual([{ id: "mysql@8", reason: "manifest unknown" }]);
    expect(result.pulled).toHaveLength(list.images.length - 1);
  });
  it("stops starting new pulls when the time budget is spent, and says which images it did not try", async () => {
    let clock = 0;
    const result = await prepullCatalogImages({
      list, registry: REGISTRY, env: "staging", budgetMs: 1_000,
      ports: { now: () => clock, pull: async () => { clock += 400; } },
    });
    expect(result.pulled).toHaveLength(3);
    expect(result.skipped).toEqual(list.images.slice(3).map((image) => image.id));
  });
  it("cuts off ONE hung pull when the budget ends: the call returns, the signal is aborted, and nothing after it is tried", async () => {
    const seen: Array<{ reference: string; signal: AbortSignal }> = [];
    const started = Date.now();
    const result = await prepullCatalogImages({
      list, registry: REGISTRY, env: "staging", budgetMs: 80,
      // The first image pulls; the second never settles (a hung `docker pull`).
      ports: { pull: (reference, signal) => { seen.push({ reference, signal }); return seen.length === 1 ? Promise.resolve() : new Promise<void>(() => undefined); } },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.pulled).toEqual([list.images[0]!.id]);
    expect(result.failed).toEqual([{ id: list.images[1]!.id, reason: "the pull did not finish inside the time budget" }]);
    expect(result.skipped).toEqual(list.images.slice(2).map((image) => image.id));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.signal.aborted).toBe(false);
    expect(seen[1]!.signal.aborted).toBe(true);
  });
  it("reports the budget, not the port's own abort error, and a pull that rejects after it was cut off is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const result = await prepullCatalogImages({
        list, registry: REGISTRY, env: "staging", budgetMs: 50,
        ports: { pull: (_reference, signal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted by the port")))) },
      });
      expect(result.failed).toEqual([{ id: list.images[0]!.id, reason: "the pull did not finish inside the time budget" }]);
      expect(result.skipped).toEqual(list.images.slice(1).map((image) => image.id));
      await new Promise((done) => setTimeout(done, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
  it("bounds the check for a present image by the same budget", async () => {
    const result = await prepullCatalogImages({
      list, registry: REGISTRY, env: "staging", budgetMs: 50,
      ports: { present: () => new Promise<boolean>(() => undefined), pull: async () => { throw new Error("should not be called"); } },
    });
    expect(result.failed).toEqual([{ id: list.images[0]!.id, reason: "the pull did not finish inside the time budget" }]);
    expect(result.pulled).toEqual([]);
  });
  it("does not time a pull that finishes in time: no failure, and every timer it started is cleared", async () => {
    const BUDGET = 61_234;
    // Pass-through spies: the real timers run, and the calls and the handles they returned are read afterwards.
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    let started: unknown[];
    let cleared: unknown[];
    try {
      const result = await prepullCatalogImages({ list, registry: REGISTRY, env: "staging", budgetMs: BUDGET, ports: { pull: async () => undefined } });
      expect(result.failed).toEqual([]);
      expect(result.pulled).toHaveLength(list.images.length);
      started = setSpy.mock.results.filter((_, index) => {
        const ms = setSpy.mock.calls[index]?.[1];
        return typeof ms === "number" && ms > BUDGET - 5_000 && ms <= BUDGET;
      }).map((call) => call.value as unknown);
      cleared = clearSpy.mock.calls.map((call) => call[0] as unknown);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
    expect(started.length).toBeGreaterThanOrEqual(list.images.length);
    for (const handle of started) expect(cleared).toContain(handle);
  });
  it("never throws: a registry or list that does not parse pulls nothing", async () => {
    const pulls: string[] = [];
    const bad = await prepullCatalogImages({ list, registry: "https://nope", env: "staging", ports: { pull: async (reference) => { pulls.push(reference); } } });
    expect(bad.failed).toHaveLength(1);
    const worse = await prepullCatalogImages({ list: { ...list, images: [{ ...list.images[0]!, digest: sha("x").slice(1) }] }, registry: REGISTRY, env: "staging", ports: { pull: async (reference) => { pulls.push(reference); } } });
    expect(worse.failed).toHaveLength(1);
    expect(pulls).toEqual([]);
  });
  it("pulls nothing from the empty list", async () => {
    const result = await prepullCatalogImages({ list: EMPTY_PREPULL_LIST, registry: REGISTRY, env: "staging", ports: { pull: async () => { throw new Error("should not be called"); } } });
    expect(result).toEqual({ pulled: [], alreadyPresent: [], failed: [], skipped: [] });
  });
});
