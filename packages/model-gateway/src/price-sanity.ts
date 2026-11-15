import { priceKey, type PriceEntry, type SourceSnapshot } from "./price-snapshot.js";
/** Group once, sort once per provider/kind: O(n log n), bounded by the source item limit. */
export function sanitySnapshot(candidate: SourceSnapshot, previous: SourceSnapshot | undefined, deadline: number, held: () => void): SourceSnapshot {
  const checkTime = () => { if (performance.now() >= deadline) throw new Error("refresh failed"); };
  const old = new Map(previous?.entries.map((e) => [priceKey(e), e]));
  const pending = new Map(previous?.confirmations?.map((e) => [priceKey(e), e]));
  const groups = new Map<string, { input: number[]; output: number[] }>();
  const groupKey = (e: PriceEntry) => JSON.stringify([e.provider, e.kind]);
  // Last good peers cannot be poisoned by a batch of cheap new models. Bootstrap uses the fetched peers.
  const priorGroups = new Set(previous?.entries.map(groupKey));
  const peers = new Map(candidate.entries.filter((e) => !priorGroups.has(groupKey(e))).map((e) => [priceKey(e), e]));
  for (const e of previous?.entries ?? []) peers.set(priceKey(e), e);
  for (const e of peers.values()) {
    checkTime(); const key = groupKey(e); const group = groups.get(key) ?? { input: [], output: [] };
    group.input.push(e.inputMicrosPerMTok); group.output.push(e.outputMicrosPerMTok); groups.set(key, group);
  }
  const median = (values: number[]) => { values.sort((a, b) => a - b); const mid = Math.floor(values.length / 2); return values.length % 2 ? values[mid]! : values[mid - 1]! / 2 + values[mid]! / 2; };
  const medians = new Map([...groups].map(([key, g]) => [key, { input: median(g.input), output: median(g.output) }]));
  const entries: PriceEntry[] = []; const floors = [...(candidate.floors ?? [])]; const confirmations: PriceEntry[] = [];
  for (const e of candidate.entries) {
    checkTime(); const key = priceKey(e); const prior = old.get(key); const confirmed = pending.get(key); const peers = medians.get(groupKey(e))!;
    const suspect = prior === undefined
      ? e.inputMicrosPerMTok < peers.input / 10 || e.outputMicrosPerMTok < peers.output / 10
      : e.inputMicrosPerMTok < prior.inputMicrosPerMTok / 2 || e.outputMicrosPerMTok < prior.outputMicrosPerMTok / 2;
    if (suspect && !(confirmed?.kind === e.kind && confirmed.inputMicrosPerMTok === e.inputMicrosPerMTok && confirmed.outputMicrosPerMTok === e.outputMicrosPerMTok)) {
      confirmations.push(e); held();
      if (prior !== undefined) entries.push({ ...prior, inputMicrosPerMTok: Math.max(prior.inputMicrosPerMTok, e.inputMicrosPerMTok), outputMicrosPerMTok: Math.max(prior.outputMicrosPerMTok, e.outputMicrosPerMTok) });
      else floors.push({ ...e, reason: "sanity hold", inputMicrosPerMTok: Math.max(e.inputMicrosPerMTok, Math.ceil(peers.input)), outputMicrosPerMTok: Math.max(e.outputMicrosPerMTok, Math.ceil(peers.output)) });
    } else entries.push(e);
  }
  return { ...candidate, entries, count: entries.length, ...(floors.length ? { floors } : {}), ...(confirmations.length ? { confirmations } : {}) };
}
