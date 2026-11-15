import { FLAT_CEILING_MICROS_PER_MTOK } from "./price-constants.js";
import { cautiousPrice, type Price, type PriceKind } from "./price.js";
import { priceKey, type ModelFloor, type PriceEntry, type SourceSnapshot } from "./price-snapshot.js";
type Row = PriceEntry | ModelFloor;
const isFloor = (row: Row): row is ModelFloor => "reason" in row;
const groupKey = (e: Row, kind: PriceKind | "all" | undefined = e.kind) => JSON.stringify([e.provider, kind]);
const maxPrice = (a: Price, b: Price): Price => ({ inputMicrosPerMTok: Math.max(a.inputMicrosPerMTok, b.inputMicrosPerMTok), outputMicrosPerMTok: Math.max(a.outputMicrosPerMTok, b.outputMicrosPerMTok), ...((a.operatorReview || b.operatorReview) ? { operatorReview: true } : {}) });
/** Materialize effective floor amounts once, including provider maxima; never scan peers per model. */
function effectiveRows(source: SourceSnapshot | undefined, checkTime: () => void): Map<string, Row> {
  const rows: Row[] = [...(source?.entries ?? []), ...(source?.floors ?? [])];
  const maxima = new Map<string, Price>();
  for (const row of rows) {
    checkTime();
    for (const kind of (row.kind === undefined ? ["chat", "embedding", "all"] as const : [row.kind, "all"] as const)) {
      const key = groupKey(row, kind); maxima.set(key, maxPrice(maxima.get(key) ?? row, row));
    }
  }
  return new Map<string, Row>(rows.map((row): [string, Row] => {
    checkTime();
    if (!isFloor(row)) return [priceKey(row), row];
    const maximum = maxima.get(groupKey(row, row.kind ?? "all"))!;
    return [priceKey(row), { ...row, ...cautiousPrice(maxPrice(row, maximum)) }];
  }));
}
/** Group once, sort once per provider/kind: O(n log n), bounded by the source item limit. */
export function sanitySnapshot(candidate: SourceSnapshot, previous: SourceSnapshot | undefined, deadline: number, held: () => void): SourceSnapshot {
  const checkTime = () => { if (performance.now() >= deadline) throw new Error("refresh failed"); };
  const old = effectiveRows(previous, checkTime); const effective = effectiveRows(candidate, checkTime);
  const pending = new Map(previous?.confirmations?.map((e) => [priceKey(e), e]));
  const groups = new Map<string, { input: number[]; output: number[] }>();
  // Last good peers cannot be poisoned by a batch of cheap new models. Bootstrap uses the fetched peers.
  const priorGroups = new Set(previous?.entries.map((e) => groupKey(e)));
  const peers = new Map(candidate.entries.filter((e) => !priorGroups.has(groupKey(e))).map((e) => [priceKey(e), e]));
  for (const e of previous?.entries ?? []) peers.set(priceKey(e), e);
  for (const e of peers.values()) {
    checkTime(); const key = groupKey(e); const group = groups.get(key) ?? { input: [], output: [] };
    group.input.push(e.inputMicrosPerMTok); group.output.push(e.outputMicrosPerMTok); groups.set(key, group);
  }
  const median = (values: number[]) => { values.sort((a, b) => a - b); const mid = Math.floor(values.length / 2); return values.length % 2 ? values[mid]! : values[mid - 1]! / 2 + values[mid]! / 2; };
  const medians = new Map([...groups].map(([key, g]) => [key, { input: median(g.input), output: median(g.output) }]));
  const entries: PriceEntry[] = []; const floors: ModelFloor[] = []; const confirmations: Row[] = [];
  // Convert an effective amount to a raw floor whose integer ×1.5 is at least that amount.
  // Division before addition stays safe at MAX_SAFE_INTEGER; at most one micro of upward rounding.
  const retain = (e: Row, amount: Price) => {
    const unscale = (n: number) => Math.ceil(n / 3) + Math.floor(n / 3);
    floors.push({ provider: e.provider, model: e.model, ...(e.kind === undefined ? {} : { kind: e.kind }), reason: "sanity hold", inputMicrosPerMTok: unscale(amount.inputMicrosPerMTok), outputMicrosPerMTok: unscale(amount.outputMicrosPerMTok), ...(amount.operatorReview ? { operatorReview: true } : {}) });
  };
  for (const e of [...candidate.entries, ...(candidate.floors ?? [])]) {
    checkTime(); const key = priceKey(e); const prior = old.get(key); const next = effective.get(key)!; const confirmed = pending.get(key); const peers = medians.get(groupKey(e));
    const floorTransition = isFloor(e) || (prior !== undefined && isFloor(prior));
    const divisor = floorTransition ? 1 : 2;
    const suspect = prior === undefined
      ? !isFloor(e) && peers !== undefined && (e.inputMicrosPerMTok < peers.input / 10 || e.outputMicrosPerMTok < peers.output / 10)
      : next.inputMicrosPerMTok < prior.inputMicrosPerMTok / divisor || next.outputMicrosPerMTok < prior.outputMicrosPerMTok / divisor || (!!prior.operatorReview && !next.operatorReview);
    const matches = confirmed !== undefined && confirmed.kind === next.kind && confirmed.inputMicrosPerMTok === next.inputMicrosPerMTok && confirmed.outputMicrosPerMTok === next.outputMicrosPerMTok && !!confirmed.operatorReview === !!next.operatorReview;
    if (suspect && !matches) {
      confirmations.push(next); held();
      if (prior !== undefined) {
        const amount = maxPrice(prior, next);
        if (floorTransition) retain(e, amount);
        else entries.push({ ...e, ...amount });
      } else floors.push({ ...e, reason: "sanity hold", inputMicrosPerMTok: Math.max(e.inputMicrosPerMTok, Math.ceil(peers!.input)), outputMicrosPerMTok: Math.max(e.outputMicrosPerMTok, Math.ceil(peers!.output)) });
    } else if (isFloor(e)) floors.push(e);
    else entries.push(e);
  }
  // Omission or loss of readable rates is not evidence of a lower price.
  const fallbackKeys = new Set(candidate.fallbacks?.map(priceKey));
  const flat = { inputMicrosPerMTok: FLAT_CEILING_MICROS_PER_MTOK, outputMicrosPerMTok: FLAT_CEILING_MICROS_PER_MTOK };
  for (const [key, prior] of old) if (!effective.has(key)) { checkTime(); retain(prior, fallbackKeys.has(key) ? maxPrice(prior, flat) : prior); }
  const retained = new Set(floors.map(priceKey));
  const fallbacks = candidate.fallbacks?.filter((e) => !retained.has(priceKey(e)));
  return { fetchedAt: candidate.fetchedAt, entries, count: entries.length, ...(fallbacks?.length ? { fallbacks } : {}), ...(floors.length ? { floors } : {}), ...(confirmations.length ? { confirmations } : {}) };
}
