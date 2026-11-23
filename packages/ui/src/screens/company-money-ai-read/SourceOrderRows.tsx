import { sourceLabel, type SourceOrderId } from '../admin/models/source-order.js';
import { FactChip, Row, RowList, Unknown } from './Parts.js';
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
