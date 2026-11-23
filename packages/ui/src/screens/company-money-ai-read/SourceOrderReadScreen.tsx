import { servedReadState } from '../../api/served-read.js';
import { PageHeader } from '../../design/PageHeader.js';
import { useAdminContext } from '../admin/admin-context.js';
import { ReadState } from './ReadState.js';
import { Card, HeldLine, Note, Section, Unknown, readTime } from './Parts.js';
import { SourceOrderRows } from './SourceOrderRows.js';
import { freshFacts, sourcesReader, useMoneyAiRead } from './read-model.js';
/** The board's "Order of AI sources": the saved version, numbered sources and the owners-only line. Read-only; there is no proposed order. */
export function SourceOrderReadScreen() {
 const { orgId, developerId } = useAdminContext();
 const read = useMoneyAiRead('sources', '/v1/app/org/model-sources', sourcesReader(orgId, developerId));
 const loaded = freshFacts(read);
 const crumbs = [{ label: 'Company', href: '/app/admin' }, { label: 'Connections', href: '/app/admin/connections' }, { label: 'AI', href: '/app/admin/ai-spending' }];
 return <>
  <PageHeader title="Order of AI sources" breadcrumbs={crumbs} {...(loaded === undefined ? {} : { description: `${loaded.order.length === 0 ? 'Source order' : `Saved order${loaded.revision === undefined ? '' : ` · version ${String(loaded.revision)}`}`}${servedReadState(read).staleSince === undefined ? ` · Read from Rovara ${readTime(read.dataUpdatedAt)}` : ''}` })} focusOnMount />
  <ReadState read={read} label="Source order">{data => <>
   <Note title="What the order does">For each AI call, Rovara uses the first source in this list that offers the model the step needs. It does not fall through to the next source when a call fails: a failed call pauses the task and says why. Connected means a source is connected, not that its calls have been tested.</Note>
   <Card title={data.order.length === 0 ? 'Saved order' : data.revision === undefined ? 'Saved now' : `Saved now, version ${String(data.revision)}`} label="AI source order">
    {data.order.length === 0 ? <div className="g2-held-row"><Unknown /><HeldLine role="status">No saved order yet.</HeldLine></div> : <SourceOrderRows order={data.order} sources={data.sources} />}
    <p className="g2-note">Only your company&apos;s owners and admins can change the order.</p>
   </Card>
   <Section title="What this order means now">
    <div className="g2-card g2-held-row"><Unknown /><HeldLine role="status">Which projects and running tasks use this order is not read here.</HeldLine></div>
   </Section>
  </>}</ReadState>
 </>;
}
