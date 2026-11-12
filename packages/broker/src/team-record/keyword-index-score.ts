// The keyword index's ranking (lane K2, DECISIONS 145): BM25 over the best passage of every row, with the statistics (N, document frequency, average length) taken over ALL passages of ALL parts (sealed segments, the live
// tail, the late rows and the facts), so the ranking is exactly the one `bm25PassageScores` gives over the same rows read in full. Pure code.
import { bm25Term, keywordNeedles } from "./search-fusion.js";
import { passageUnits, type SegmentReader } from "./keyword-index-segment.js";

/** What the search cuts and the answer need to know of a ranked row without reading it. */
export interface DocMeta {
  /** A row's time, or a fact's creation time. */
  ms: number;
  kind: string;
  source: string;
  restricted: boolean;
  isFact: boolean;
}

/** A set of rows with passages, in the one form the ranking needs. `now` is the clock of the read (epoch seconds): it decides whose raw text has expired. */
export interface ScoringPart {
  stats(now: number): { units: number; length: number };
  /** Calls `visit(unit, doc, unitLength, count)` for every passage that counts now and holds `word`. */
  eachMatch(word: string, now: number, visit: (unit: number, doc: number, length: number, count: number) => void): void;
  meta(doc: number): DocMeta;
}

export class SegmentPart implements ScoringPart {
  constructor(readonly segment: SegmentReader) {}
  private expiredDocs(now: number): Uint8Array | undefined {
    const { segment } = this;
    if (segment.expiring.length === 0) return undefined;
    const expired = new Uint8Array(segment.docs);
    let any = false;
    for (const doc of segment.expiring) if ((segment.textExpiresAt[doc] as number) !== 0 && (segment.textExpiresAt[doc] as number) <= now) { expired[doc] = 1; any = true; }
    return any ? expired : undefined;
  }
  stats(now: number): { units: number; length: number } {
    const { segment } = this;
    let units = segment.fullUnits;
    let length = segment.fullLength;
    const expired = this.expiredDocs(now);
    if (expired === undefined) return { units, length };
    for (const doc of segment.expiring) {
      if (expired[doc] !== 1) continue;
      for (let at = 0; at < (segment.fullCount[doc] as number); at += 1) { units -= 1; length -= segment.unitLength[(segment.fullStart[doc] as number) + at] as number; }
      for (let at = 0; at < (segment.structCount[doc] as number); at += 1) { units += 1; length += segment.unitLength[(segment.structStart[doc] as number) + at] as number; }
    }
    return { units, length };
  }
  eachMatch(word: string, now: number, visit: (unit: number, doc: number, length: number, count: number) => void): void {
    const list = this.segment.postings(word);
    if (list === undefined) return;
    const { segment } = this;
    const expired = this.expiredDocs(now);
    for (let at = 0; at < list.units.length; at += 1) {
      const unit = list.units[at] as number;
      const doc = segment.unitDoc[unit] as number;
      // a passage of the full set counts while the row's text stands; one of the structured-only set counts once it has expired
      if ((segment.unitIsStruct[unit] === 1) !== (expired !== undefined && expired[doc] === 1)) continue;
      visit(unit, doc, segment.unitLength[unit] as number, list.counts[at] as number);
    }
  }
  meta(doc: number): DocMeta {
    const { segment } = this;
    return { ms: segment.occurredAtMs[doc] as number, kind: segment.kindOf(doc), source: segment.sourceOf(doc), restricted: segment.restricted[doc] === 1, isFact: false };
  }
}

export interface LiveDoc { meta: DocMeta; tokens: readonly string[] }

/** Rows and facts read live (the tail, the late rows, the notes): the same passages as a segment holds, made from their tokens now. */
export class LivePart implements ScoringPart {
  private readonly units: Array<{ doc: number; length: number; counts: Map<string, number> }> = [];
  constructor(private readonly docs: readonly LiveDoc[]) {
    docs.forEach((doc, index) => { for (const unit of passageUnits(doc.tokens)) this.units.push({ doc: index, length: unit.length, counts: unit.counts }); });
  }
  stats(): { units: number; length: number } { return { units: this.units.length, length: this.units.reduce((sum, unit) => sum + unit.length, 0) }; }
  eachMatch(word: string, _now: number, visit: (unit: number, doc: number, length: number, count: number) => void): void {
    this.units.forEach((unit, index) => { const count = unit.counts.get(word); if (count !== undefined) visit(index, unit.doc, unit.length, count); });
  }
  meta(doc: number): DocMeta { return (this.docs[doc] as LiveDoc).meta; }
}

export interface RankedDoc { part: number; doc: number; score: number }

/**
 * BM25 of the best passage of every row that holds at least one query word, over the statistics of all parts together. Rows with no query word score 0 and are not listed. The sum for a passage runs over the query words in
 * order, as `bm25PassageScores` does, so the same rows give the same numbers.
 */
export function rankParts(query: string, parts: readonly ScoringPart[], now: number): RankedDoc[] {
  const needles = keywordNeedles(query);
  if (needles.length === 0) return [];
  let passages = 0;
  let total = 0;
  for (const part of parts) { const stats = part.stats(now); passages += stats.units; total += stats.length; }
  if (passages === 0) return [];
  const average = total / passages || 1;
  const idf = needles.map((word) => {
    let containing = 0;
    for (const part of parts) part.eachMatch(word, now, () => { containing += 1; });
    return Math.log(1 + (passages - containing + 0.5) / (containing + 0.5));
  });
  const ranked: RankedDoc[] = [];
  parts.forEach((part, partIndex) => {
    const byUnit = new Map<number, { doc: number; score: number }>();
    needles.forEach((word, at) => {
      part.eachMatch(word, now, (unit, doc, length, count) => {
        const entry = byUnit.get(unit);
        const add = bm25Term(idf[at] as number, count, length, average);
        if (entry === undefined) byUnit.set(unit, { doc, score: add }); else entry.score += add;
      });
    });
    const best = new Map<number, number>();
    for (const { doc, score } of byUnit.values()) if (score > (best.get(doc) ?? 0)) best.set(doc, score);
    for (const [doc, score] of best) if (score > 0) ranked.push({ part: partIndex, doc, score });
  });
  return ranked;
}
