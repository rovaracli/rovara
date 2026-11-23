import { sourceLabel, type SourceOrderId } from '../admin/models/source-order.js';
import { FactChip, HeldLine, Row, RowList, Unknown } from './Parts.js';
type SourceFact = { source: SourceOrderId; available: boolean; connected: boolean | null };
const chip = (connected: boolean | null) => connected === null ? <Unknown /> : connected ? <FactChip icon="tick">Connected</FactChip> : <FactChip dashed>Not connected</FactChip>;
/** The saved order as numbered rows: the source, whether it is connected (a fact, never "Working": that needs a call), and whether it is available. */
export function SourceOrderRows({ order, sources }: { order: readonly SourceOrderId[]; sources: readonly SourceFact[] }) {
 return <RowList ordered label="Sources in order">{order.map((id, index) => {
  const fact = sources.find(source => source.source === id);
  // A source that is not available is a known fact: one dashed chip, no second line that could contradict it.
  return <Row key={id} lead={<span className="g2-num" aria-hidden="true">{index + 1}</span>} title={sourceLabel(id)} chip={fact === undefined ? <Unknown /> : !fact.available ? <FactChip dashed>Not available</FactChip> : chip(fact.connected)}
   {...(fact?.available === true ? { meta: 'Available to this company' } : {})} />;
 })}</RowList>;
}

/** What the one model-sources read says about who serves the company's AI. Every field is a served fact; `null` means the read does not say. */
export type SourceStatus = { chip: string | null; summary: string; line: string | null; saved: boolean; rovaraDefault: boolean };
const sourcesWord = (count: number) => `${String(count)} company ${count === 1 ? 'source' : 'sources'}`;
/**
 * The status chip, the count line and the empty-order line, from model-sources `order` and `sources[]` only. An empty order is the default (no row is written to accept it):
 * with no company source connected and Rovara's AI listed, Rovara's AI is the source in use. A read that lists nothing to say it from keeps `chip: null` (the shared Unknown).
 */
export function sourceStatus(snapshot: { order: readonly SourceOrderId[]; sources: readonly SourceFact[] }): SourceStatus {
 const { order, sources } = snapshot, saved = order.length > 0;
 const company = sources.filter(item => item.source !== 'rovara');
 const connected = company.filter(item => item.connected === true).length;
 // connected: null is an unanswered flag, never "not connected": "none connected" is said only when EVERY company source was served connected === false.
 const unanswered = company.some(item => item.connected === null);
 const rovaraListed = sources.some(item => item.source === 'rovara' && item.available);
 const none = 'No company sources connected';
 if (saved) {
  const summary = `${String(order.length)} ${order.length === 1 ? 'source' : 'sources'} in order`;
  if (connected > 0) return { chip: `${sourcesWord(connected)} connected`, summary, line: null, saved, rovaraDefault: false };
  // The order's first source is a served fact; "none connected" is never said next to an order led by a company source.
  if (order[0] === 'rovara') return { chip: "Using Rovara's AI", summary, line: null, saved, rovaraDefault: false };
  return { chip: `${sourceLabel(order[0] ?? '')} first`, summary, line: null, saved, rovaraDefault: false };
 }
 if (connected > 0) return { chip: `${sourcesWord(connected)} connected`, summary: 'No order saved', line: `No order saved yet. ${sourcesWord(connected)} connected.`, saved, rovaraDefault: false };
 // No order and some company source not yet answered: the default cannot be named. The chip stays the shared Unknown (pending), the line says what is known.
 if (unanswered) return { chip: null, summary: 'No order saved', line: "No order saved yet. Rovara can't confirm which company sources are connected yet.", saved, rovaraDefault: false };
 if (rovaraListed) return { chip: "Using Rovara's AI", summary: none, line: `Rovara's AI (the default). ${none}.`, saved, rovaraDefault: true };
 return { chip: null, summary: 'No order served', line: null, saved, rovaraDefault: false };
}
/** An empty saved order, said as the fact it is. Only a read that served nothing to say it from keeps the shared Unknown. */
export function EmptyOrderLine({ status, unservedText }: { status: SourceStatus; unservedText: string }) {
 return status.line === null
  ? <div className="g2-held-row"><Unknown /><HeldLine role="status">{unservedText}</HeldLine></div>
  : <div className="g2-held-row"><FactChip icon={status.rovaraDefault ? 'tick' : 'dash'} dashed={!status.rovaraDefault}>{status.rovaraDefault ? 'Default' : 'Not saved'}</FactChip><HeldLine role="status">{status.line}</HeldLine></div>;
}
