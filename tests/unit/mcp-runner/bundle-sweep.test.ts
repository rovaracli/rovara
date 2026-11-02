// Stdio fixes lane, review M10: the bundle bucket is swept. A bundle that no entry (of any status) references, and that is older than the retention (30 days, the design's section 6), is removed
// by the controller's reconcile pass; nothing is removed when the controller cannot be sure what is referenced.
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpController, type ControllerRegistry } from "../../../packages/gateway/src/mcp-controller.js";
import { directoryBundleStore, objectBundleStore, type BundleObjectApi, type BundleStore } from "../../../packages/gateway/src/mcp-runner/bundle-store.js";
import { FakeRunner, toolsHashOfNames } from "../../support/mcp-controller-fixtures.js";
import { BUNDLE, BYTES, OTHER, approvedOf, mcp, useControllerWorld, world as controllerWorld, BROKER } from "../../support/mcp-controller-world.js";

useControllerWorld();

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const hash = (character: string): string => character.repeat(64);

interface Held { hash: string; lastModified: number }
function fakeStore(held: Held[], over: Partial<BundleStore> = {}) {
  const calls = { list: 0, removed: [] as string[] };
  const store: BundleStore = {
    put: async () => "stored", open: async () => undefined, has: async () => false,
    list: async () => { calls.list += 1; return held.map((item) => ({ ...item })); },
    remove: async (name) => { calls.removed.push(name); },
    ...over,
  };
  return { store, calls };
}

function world(options: { held: Held[]; referenced?: string[] | "throws" | "absent"; store?: Partial<BundleStore>; now?: { value: number }; sweep?: Record<string, number> }) {
  const clock = options.now ?? { value: NOW };
  const { store, calls } = fakeStore(options.held, options.store);
  const registry: ControllerRegistry = {
    approved: async () => undefined,
    ...(options.referenced === "absent" ? {} : { referencedBundles: async () => { if (options.referenced === "throws") throw new Error("table down"); return new Set(options.referenced ?? []); } }),
  };
  const logs: Array<[string, Record<string, string | number>]> = [];
  const controller = createMcpController({
    token: "t".repeat(48), registry, runner: new FakeRunner(), bundles: store, controllerUrl: "http://127.0.0.1:1", npmRegistry: "https://r.example/", toolsHashOf: toolsHashOfNames,
    sweepMs: 0, now: () => clock.value, log: (event, fields) => { logs.push([event, fields]); }, ...options.sweep,
  });
  return { controller, calls, logs, clock };
}

describe("review M10: the controller sweeps the bundle store", () => {
  it("removes a bundle that is older than 30 days and that no entry references, and nothing else", async () => {
    const w = world({
      held: [
        { hash: hash("1"), lastModified: NOW - 31 * DAY }, // old, unreferenced: removed
        { hash: hash("2"), lastModified: NOW - 90 * DAY }, // old, referenced (an approved, paused, disabled or waiting entry): kept
        { hash: hash("3"), lastModified: NOW - 29 * DAY }, // unreferenced but younger than 30 days: kept
        { hash: hash("4"), lastModified: NOW - 30 * DAY }, // exactly 30 days: kept (strictly older only)
        { hash: hash("5"), lastModified: NOW - 30 * DAY - 1 }, // just over: removed
      ],
      referenced: [hash("2")],
    });
    await w.controller.reconcile();
    expect(w.calls.removed.sort()).toEqual([hash("1"), hash("5")]);
  });
  it("removes nothing when it cannot tell what is referenced (the registry cannot be read, or has no such question), or cannot list or remove", async () => {
    const held = [{ hash: hash("1"), lastModified: NOW - 90 * DAY }];
    for (const [label, referenced] of [["unreadable registry", "throws"], ["no question", "absent"]] as const) {
      const w = world({ held, referenced });
      await expect(w.controller.reconcile(), label).resolves.toBeUndefined();
      expect(w.calls.removed, label).toEqual([]);
    }
    const listing = world({ held, referenced: [], store: { list: async () => { throw new Error("denied"); } } });
    await expect(listing.controller.reconcile()).resolves.toBeUndefined();
    expect(listing.calls.removed).toEqual([]);
    const none = world({ held, referenced: [], store: { remove: undefined } });
    await none.controller.reconcile();
    expect(none.calls.removed).toEqual([]);
    const unlisted = world({ held, referenced: [], store: { list: undefined } });
    await unlisted.controller.reconcile();
    expect(unlisted.calls.removed).toEqual([]);
    expect(unlisted.calls.list).toBe(0);
  });
  it("removes at most 50 in a pass, the oldest first, and the rest in the next pass", async () => {
    const held = Array.from({ length: 60 }, (_, index) => ({ hash: index.toString(16).padStart(64, "0"), lastModified: NOW - (100 + index) * DAY }));
    const w = world({ held, referenced: [], sweep: { bundleSweepEveryMs: 0 } });
    await w.controller.reconcile();
    expect(w.calls.removed).toHaveLength(50);
    expect(w.calls.removed[0]).toBe(held[59]!.hash); // the oldest
    expect(w.calls.removed).not.toContain(held[0]!.hash);
  });
  it("sweeps at the first pass and then at most once an interval (6 hours by default), not on every pass", async () => {
    const clock = { value: NOW };
    const w = world({ held: [], referenced: [], now: clock });
    await w.controller.reconcile();
    expect(w.calls.list).toBe(1);
    await w.controller.reconcile();
    clock.value += 6 * 3_600_000 - 1;
    await w.controller.reconcile();
    expect(w.calls.list).toBe(1);
    clock.value += 1;
    await w.controller.reconcile();
    expect(w.calls.list).toBe(2);
    await w.controller.reconcile();
    expect(w.calls.list).toBe(2);
  });
  it("goes on to the next bundle when one cannot be removed, and never throws out of the pass", async () => {
    const held = [{ hash: hash("1"), lastModified: NOW - 40 * DAY }, { hash: hash("2"), lastModified: NOW - 41 * DAY }, { hash: hash("3"), lastModified: NOW - 42 * DAY }];
    const removed: string[] = [];
    const w = world({ held, referenced: [], store: { remove: async (name) => { removed.push(name); if (name === hash("2")) throw new Error("denied"); } } });
    await expect(w.controller.reconcile()).resolves.toBeUndefined();
    expect(removed.sort()).toEqual([hash("1"), hash("2"), hash("3")]);
    expect(w.logs.some(([event]) => event === "mcp_controller.bundle_remove_failed")).toBe(true);
  });
  it("never removes the bundle a running server task was started from, even when no entry names it and it is old (a positive control removes the other)", async () => {
    const real = directoryBundleStore(join(tmpdir(), `bundle-sweep-run-${process.pid}`));
    const removed: string[] = [];
    const store: BundleStore = {
      ...real, list: async () => [{ hash: BUNDLE, lastModified: NOW - 90 * DAY }, { hash: OTHER, lastModified: NOW - 90 * DAY }],
      remove: async (name) => { removed.push(name); },
    };
    const w = await controllerWorld({ bundles: store, controller: { registry: { approved: async () => approvedOf(), referencedBundles: async () => new Set<string>() }, now: () => NOW, bundleSweepEveryMs: 0 } });
    await store.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    expect((await mcp(w.brokerUrl, "mcpsim000001", undefined, BROKER)).status).toBe(200);
    await w.controller.reconcile();
    expect(removed).toEqual([OTHER]);
  });
  it("logs counts and a short hash prefix only", async () => {
    const w = world({ held: [{ hash: hash("a"), lastModified: NOW - 40 * DAY }], referenced: [] });
    await w.controller.reconcile();
    const text = JSON.stringify(w.logs);
    expect(text).toContain("mcp_controller.bundles_swept");
    expect(text).not.toContain(hash("a"));
  });
  it("logs a failed removal with a short prefix of the hash only", async () => {
    const w = world({ held: [{ hash: hash("b"), lastModified: NOW - 40 * DAY }], referenced: [], store: { remove: async () => { throw new Error("denied"); } } });
    await w.controller.reconcile();
    expect(JSON.stringify(w.logs)).toContain("mcp_controller.bundle_remove_failed");
    expect(JSON.stringify(w.logs)).not.toContain(hash("b"));
    expect(JSON.stringify(w.logs)).toContain(hash("b").slice(0, 12));
  });
});

describe("review M10: the stores can list and remove", () => {
  let work: string;
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "bundle-sweep-")); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  it("the directory store lists its bundles with their age and removes one by hash, and only by hash", async () => {
    const store = directoryBundleStore(work);
    await writeFile(join(work, `${hash("1")}.tar`), "x");
    await writeFile(join(work, `${hash("2")}.tar`), "y");
    await writeFile(join(work, "notes.txt"), "z");
    await utimes(join(work, `${hash("1")}.tar`), new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
    const listed = await store.list!();
    expect(listed.map((item) => item.hash).sort()).toEqual([hash("1"), hash("2")]);
    expect(listed.find((item) => item.hash === hash("1"))!.lastModified).toBe(NOW - 40 * DAY);
    await store.remove!(hash("1"));
    expect(await store.has(hash("1"))).toBe(false);
    expect(await store.has(hash("2"))).toBe(true);
    await expect(store.remove!("../x")).rejects.toThrow();
    await expect(store.remove!("notes")).rejects.toThrow();
    await store.remove!(hash("1")); // already gone: not an error
  });
  it("the object store lists keys under bundles/ that are a sha256 and removes only such a key", async () => {
    const removed: string[] = [];
    const api: BundleObjectApi = {
      put: async () => undefined, get: async () => undefined, head: async () => false,
      list: async (prefix) => {
        expect(prefix).toBe("bundles/");
        return [{ key: `bundles/${hash("1")}`, lastModified: 5 }, { key: "bundles/readme", lastModified: 6 }, { key: `bundles/${hash("2")}/extra`, lastModified: 7 }, { key: `other/${hash("3")}`, lastModified: 8 }, { key: `bundles/${hash("A")}`, lastModified: 9 }];
      },
      remove: async (key) => { removed.push(key); },
    };
    const store = objectBundleStore(api, { stagingDirectory: join(work, "staging") });
    expect(await store.list!()).toEqual([{ hash: hash("1"), lastModified: 5 }]);
    await store.remove!(hash("1"));
    expect(removed).toEqual([`bundles/${hash("1")}`]);
    await expect(store.remove!("x")).rejects.toThrow();
    await expect(store.remove!(`${hash("1")}/../x`)).rejects.toThrow();
    expect(removed).toHaveLength(1);
    // an object api that cannot list or remove gives a store that cannot either
    const plain = objectBundleStore({ put: async () => undefined, get: async () => undefined, head: async () => false }, { stagingDirectory: join(work, "s2") });
    expect(plain.list).toBeUndefined();
    expect(plain.remove).toBeUndefined();
  });
});
