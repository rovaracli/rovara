// Stdio fixes lane, review M10 and N4: the bundle bucket is swept. A bundle that no entry (of any status) references, and that has been seen unreferenced for the retention (30 days, the design's
// section 6) counted from the first time it was seen so, is removed by the controller's reconcile pass; nothing is removed when the controller cannot be sure what is referenced.
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

function world(options: { held: Held[]; referenced?: string[] | "throws" | "absent"; store?: Partial<BundleStore>; now?: { value: number }; sweep?: Record<string, unknown> }) {
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

describe("review M10, N4: the controller sweeps the bundle store, counting the retention from the day a bundle was first seen unreferenced", () => {
  const SWEEP = { bundleSweepEveryMs: 0 };
  /** One sweep per call, at `NOW + days`. */
  const sweepAt = async (w: ReturnType<typeof world>, days: number): Promise<void> => { w.clock.value = NOW + days * DAY; await w.controller.reconcile(); };

  it("marks an unreferenced bundle the first time it sees it, and removes it only after 30 days from then, however old the upload is", async () => {
    const w = world({ held: [{ hash: hash("1"), lastModified: NOW - 400 * DAY }], referenced: [], sweep: SWEEP });
    await sweepAt(w, 0);
    expect(w.calls.removed).toEqual([]); // uploaded 400 days ago, but unreferenced only from today
    await sweepAt(w, 15);
    await sweepAt(w, 29.9);
    expect(w.calls.removed).toEqual([]);
    await sweepAt(w, 30);
    expect(w.calls.removed).toEqual([hash("1")]);
  });
  it("counts again from the start when an entry references the bundle in between", async () => {
    const references = { value: false };
    const clock = { value: NOW };
    const { store, calls } = fakeStore([{ hash: hash("1"), lastModified: NOW - 400 * DAY }]);
    const controller = createMcpController({
      token: "t".repeat(48), registry: { approved: async () => undefined, referencedBundles: async () => new Set(references.value ? [hash("1")] : []) }, runner: new FakeRunner(), bundles: store, controllerUrl: "http://127.0.0.1:1",
      npmRegistry: "https://r.example/", toolsHashOf: toolsHashOfNames, sweepMs: 0, now: () => clock.value, bundleSweepEveryMs: 0,
    });
    const at = async (days: number): Promise<void> => { clock.value = NOW + days * DAY; await controller.reconcile(); };
    await at(0);
    await at(20);
    references.value = true; // an entry names it again (the same package was added)
    await at(25);
    references.value = false; // and it is removed again
    await at(26);
    await at(40); // 40 days from the first mark, 14 from the second
    expect(calls.removed).toEqual([]);
    await at(56);
    expect(calls.removed).toEqual([hash("1")]);
  });
  it("keeps the marks in the install's table: a restarted controller does not start the 30 days again", async () => {
    const marks = new Map<string, number>();
    const shared = { get: async (name: string) => marks.get(name), set: async (name: string, at: number) => { marks.set(name, at); }, clear: async (name: string) => { marks.delete(name); } };
    const first = world({ held: [{ hash: hash("1"), lastModified: NOW - 100 * DAY }], referenced: [], sweep: { ...SWEEP, bundleMarks: shared as never } });
    await sweepAt(first, 0);
    expect([...marks.keys()]).toEqual([hash("1")]);
    const restarted = world({ held: [{ hash: hash("1"), lastModified: NOW - 100 * DAY }], referenced: [], sweep: { ...SWEEP, bundleMarks: shared as never } });
    await sweepAt(restarted, 31);
    expect(restarted.calls.removed).toEqual([hash("1")]);
    expect([...marks.keys()]).toEqual([]);
  });
  it("removes nothing, and marks nothing it cannot be sure of, when a mark cannot be read or written", async () => {
    for (const broken of [{ get: async () => { throw new Error("denied"); } }, { set: async () => { throw new Error("denied"); } }]) {
      const base = { get: async () => NOW - 40 * DAY, set: async () => undefined, clear: async () => undefined };
      const w = world({ held: [{ hash: hash("1"), lastModified: NOW - 100 * DAY }], referenced: [], sweep: { ...SWEEP, bundleMarks: { ...base, ...(Object.keys(broken)[0] === "set" ? { get: async () => undefined } : {}), ...broken } as never } });
      await expect(w.controller.reconcile()).resolves.toBeUndefined();
      expect(w.calls.removed, Object.keys(broken)[0]).toEqual([]);
      expect(w.logs.some(([event]) => event === "mcp_controller.bundle_mark_failed")).toBe(true);
    }
  });
  it("never removes a bundle uploaded in the last day, even when it has been marked for 30 days", async () => {
    const marks = { get: async () => NOW - 40 * DAY, set: async () => undefined, clear: async () => undefined };
    const w = world({ held: [{ hash: hash("1"), lastModified: NOW - 3_600_000 }, { hash: hash("2"), lastModified: NOW - 2 * DAY }], referenced: [], sweep: { ...SWEEP, bundleMarks: marks } });
    await w.controller.reconcile();
    expect(w.calls.removed).toEqual([hash("2")]);
  });
  it("never removes a referenced bundle, whatever its mark says, and clears the mark", async () => {
    const cleared: string[] = [];
    const marks = { get: async () => NOW - 90 * DAY, set: async () => undefined, clear: async (name: string) => { cleared.push(name); } };
    const w = world({ held: [{ hash: hash("2"), lastModified: NOW - 90 * DAY }], referenced: [hash("2")], sweep: { ...SWEEP, bundleMarks: marks } });
    await w.controller.reconcile();
    expect(w.calls.removed).toEqual([]);
    expect(cleared).toEqual([hash("2")]);
  });
  it("removes nothing when it cannot tell what is referenced (the registry cannot be read, or has no such question), or cannot list or remove", async () => {
    const old = { get: async () => NOW - 90 * DAY, set: async () => undefined, clear: async () => undefined };
    const held = [{ hash: hash("1"), lastModified: NOW - 90 * DAY }];
    for (const [label, referenced] of [["unreadable registry", "throws"], ["no question", "absent"]] as const) {
      const w = world({ held, referenced, sweep: { ...SWEEP, bundleMarks: old } });
      await expect(w.controller.reconcile(), label).resolves.toBeUndefined();
      expect(w.calls.removed, label).toEqual([]);
    }
    const listing = world({ held, referenced: [], store: { list: async () => { throw new Error("denied"); } }, sweep: { ...SWEEP, bundleMarks: old } });
    await expect(listing.controller.reconcile()).resolves.toBeUndefined();
    expect(listing.calls.removed).toEqual([]);
    const none = world({ held, referenced: [], store: { remove: undefined }, sweep: { ...SWEEP, bundleMarks: old } });
    await none.controller.reconcile();
    expect(none.calls.removed).toEqual([]);
    const unlisted = world({ held, referenced: [], store: { list: undefined }, sweep: { ...SWEEP, bundleMarks: old } });
    await unlisted.controller.reconcile();
    expect(unlisted.calls.removed).toEqual([]);
    expect(unlisted.calls.list).toBe(0);
  });
  it("removes at most 50 in a pass, the longest unreferenced first, and the rest in the next pass", async () => {
    const since = new Map<string, number>();
    const held = Array.from({ length: 60 }, (_, index) => { const name = index.toString(16).padStart(64, "0"); since.set(name, NOW - (100 + index) * DAY); return { hash: name, lastModified: NOW - 300 * DAY }; });
    const marks = { get: async (name: string) => since.get(name), set: async () => undefined, clear: async (name: string) => { since.delete(name); } };
    const w = world({ held, referenced: [], sweep: { ...SWEEP, bundleMarks: marks } });
    await w.controller.reconcile();
    expect(w.calls.removed).toHaveLength(50);
    expect(w.calls.removed[0]).toBe(held[59]!.hash);
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
    const marks = { get: async () => NOW - 40 * DAY, set: async () => undefined, clear: async () => undefined };
    const held = [{ hash: hash("1"), lastModified: NOW - 90 * DAY }, { hash: hash("2"), lastModified: NOW - 91 * DAY }, { hash: hash("3"), lastModified: NOW - 92 * DAY }];
    const removed: string[] = [];
    const w = world({ held, referenced: [], store: { remove: async (name) => { removed.push(name); if (name === hash("2")) throw new Error("denied"); } }, sweep: { ...SWEEP, bundleMarks: marks } });
    await expect(w.controller.reconcile()).resolves.toBeUndefined();
    expect(removed.sort()).toEqual([hash("1"), hash("2"), hash("3")]);
    expect(w.logs.some(([event]) => event === "mcp_controller.bundle_remove_failed")).toBe(true);
  });
  it("never removes the bundle a running server task was started from, even when no entry names it and its mark is old (a positive control removes the other)", async () => {
    const real = directoryBundleStore(join(tmpdir(), `bundle-sweep-run-${process.pid}`));
    const removed: string[] = [];
    const store: BundleStore = {
      ...real, list: async () => [{ hash: BUNDLE, lastModified: NOW - 90 * DAY }, { hash: OTHER, lastModified: NOW - 90 * DAY }],
      remove: async (name) => { removed.push(name); },
    };
    const marks = { get: async () => NOW - 90 * DAY, set: async () => undefined, clear: async () => undefined };
    const w = await controllerWorld({ bundles: store, controller: { registry: { approved: async () => approvedOf(), referencedBundles: async () => new Set<string>() }, now: () => NOW, bundleSweepEveryMs: 0, bundleMarks: marks } });
    await store.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    expect((await mcp(w.brokerUrl, "mcpsim000001", undefined, BROKER)).status).toBe(200);
    await w.controller.reconcile();
    expect(removed).toEqual([OTHER]);
  });
  it("logs counts and a short hash prefix only", async () => {
    const marks = { get: async () => NOW - 40 * DAY, set: async () => undefined, clear: async () => undefined };
    const w = world({ held: [{ hash: hash("a"), lastModified: NOW - 90 * DAY }], referenced: [], sweep: { ...SWEEP, bundleMarks: marks } });
    await w.controller.reconcile();
    const text = JSON.stringify(w.logs);
    expect(text).toContain("mcp_controller.bundles_swept");
    expect(text).not.toContain(hash("a"));
  });
  it("logs a failed removal with a short prefix of the hash only", async () => {
    const marks = { get: async () => NOW - 40 * DAY, set: async () => undefined, clear: async () => undefined };
    const w = world({ held: [{ hash: hash("b"), lastModified: NOW - 90 * DAY }], referenced: [], store: { remove: async () => { throw new Error("denied"); } }, sweep: { ...SWEEP, bundleMarks: marks } });
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
