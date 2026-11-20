// Stamp source (R6b, Sol N2b): a later stamp is never lower than one already persisted, whatever the interleaving of tabs sharing one storage.
import { expect, it } from "vitest";
import { createStampSource, type StampStorage } from "../../packages/ui/src/screens/session/merge-stamp.js";

/** One shared localStorage with a hook that runs just BEFORE the next write: the tab has already read and computed, then pauses, and another tab acts before its (now stale) write lands. */
function shared() {
 const data = new Map<string, string>();
 let beforeRead: (() => void) | undefined;
 const storage: StampStorage = { get length() { return data.size; }, key: index => [...data.keys()][index] ?? null, getItem: key => data.get(key) ?? null, setItem: (key, value) => { const hook = beforeRead; beforeRead = undefined; hook?.(); data.set(key, value); }, removeItem: key => { data.delete(key); } };
 return { storage, data, pauseNextRead(hook: () => void) { beforeRead = hook; } };
}
const FIXED = () => 1_700_000_000_000;

it("Sol's interleaving: tab A reads and computes, pauses before writing, tab B issues three stamps, A's stale write lands: A's stamp is still above all of B's, and a tab loaded afterwards is above both", () => {
 const s = shared();
 const a = createStampSource(() => s.storage, FIXED, () => 0.1), b = createStampSource(() => s.storage, FIXED, () => 0.7);
 const fromB: number[] = [];
 s.pauseNextRead(() => { for (let i = 0; i < 3; i += 1) fromB.push(b()); });
 const fromA = a();
 expect(fromB).toHaveLength(3);
 expect(fromB[0]! < fromB[1]! && fromB[1]! < fromB[2]!).toBe(true);
 expect(fromA).toBeGreaterThan(Math.max(...fromB));
 const c = createStampSource(() => s.storage, FIXED, () => 0.4);
 expect(c()).toBeGreaterThan(fromA);
});

it("any interleaving of three tabs: every stamp is above every stamp persisted before it finished, strictly increasing per tab and no two equal", () => {
 for (let seed = 1; seed <= 200; seed += 1) {
  const s = shared();
  let state = seed;
  const rnd = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  // Distinct slots per tab (a slot collision is the documented tie, which fails closed and is not what this property is about).
  const tabs = [0, 1, 2].map(index => { const fixed = [0.11 + index / 7, (index + 0.5) / 3]; let k = 0; return createStampSource(() => s.storage, FIXED, () => k < 2 ? fixed[k++]! : rnd()); });
  const issued: Array<{ tab: number; value: number; seen?: boolean }> = [];
  for (let step = 0; step < 12; step += 1) {
   const tab = Math.floor(rnd() * 3), other = (tab + 1 + Math.floor(rnd() * 2)) % 3;
   if (rnd() < 0.6) s.pauseNextRead(() => { const value = tabs[other]!(); issued.push({ tab: other, value }); });
   const value = tabs[tab]!();
   // Stamps persisted before this one finished (the nested ones) are all below it.
   const nested = issued.filter(item => item.tab !== tab && !item.seen);
   issued.push({ tab, value });
   for (const item of nested) item.seen = true;
   for (const item of nested) expect(value).toBeGreaterThan(item.value);
  }
  const values = issued.map(item => item.value);
  expect(new Set(values).size).toBe(values.length);
  for (let tab = 0; tab < 3; tab += 1) { const own = issued.filter(item => item.tab === tab).map(item => item.value); expect([...own].sort((x, y) => x - y)).toEqual(own); }
 }
});

it("stale keys of closed tabs are pruned and unreadable values are ignored; blocked storage falls back to memory and still increases", () => {
 const s = shared();
 s.data.set("rovara.merge.stamp.v2:old", String(1_000 * 1024));
 s.data.set("rovara.merge.stamp.v2:junk", "not a number");
 const a = createStampSource(() => s.storage, FIXED, () => 0.3);
 expect(a()).toBeGreaterThan(FIXED() * 1024 - 1);
 expect(s.data.has("rovara.merge.stamp.v2:old")).toBe(false);
 const blocked = createStampSource(() => { throw new Error("blocked"); }, FIXED, () => 0.3);
 const first = blocked(), second = blocked();
 expect(second).toBeGreaterThan(first);
});
