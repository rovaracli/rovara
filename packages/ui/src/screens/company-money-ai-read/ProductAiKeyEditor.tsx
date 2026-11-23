import { useState } from 'react';
import { productAiPath, readProductAi, usdToMicros, type ProductAiRead } from '../../api/admin-product-ai.js';
import { Button } from '../../design/Button.js';
import { Select } from '../../design/Select.js';
import { SecretField } from '../../design/SecretField.js';
import { TextField } from '../../design/TextField.js';
import { VisibleText } from '../../design/VisibleText.js';
import { Money } from '../../design/Money.js';
import { EvalApprovalSection, Vertex, useProductAiSend, when } from '../admin/product-ai/ProductAiScreen.js';
import { useAdminRead } from '../admin/models/read.js';
import { ReadState } from './ReadState.js';
/**
 * The board's "Add a product AI key to <project>" card, for Add a key and Replace: the provider, the write-only key (or the Vertex AI setup) and the project's eval budget.
 * Every change goes through the same send as the live page (useProductAiSend): same paths, bodies, revision and refusal words. A typed key is sent once and never shown again.
 */
export function ProductAiKeyEditor({ project, onClose }: { project: string; onClose: () => void }) {
 const read = useAdminRead(`product-ai-${project}`, productAiPath(project), { parse: readProductAi }, { stable: true });
 return <ReadState read={read} label={`${project} key settings`} scope="section">{settings => <EditorBody settings={settings} reload={() => { void read.refetch(); }} onClose={onClose} />}</ReadState>;
}
function EditorBody({ settings, reload, onClose }: { settings: ProductAiRead; reload: () => void; onClose: () => void }) {
 const { busy, notice, send } = useProductAiSend(settings.project, settings.revision, reload);
 const path = productAiPath(settings.project), connected = settings.key.connected || settings.vertex.connected;
 const [provider, setProvider] = useState<'gemini' | 'vertex'>(settings.vertex.connected && !settings.key.connected ? 'vertex' : 'gemini');
 const [calls, setCalls] = useState(String(settings.evalBudget.calls)), [usd, setUsd] = useState(String(settings.evalBudget.costMicros / 1_000_000));
 const budgetMicros = usdToMicros(usd), callsOk = /^\d{1,6}$/u.test(calls) && Number(calls) >= 1;
 const title = connected ? `Replace the product AI key on ${settings.project}` : `Add a product AI key to ${settings.project}`;
 return <section className="g2-card g2-editor" aria-label={title}>
  <h2>{title}</h2>
  {notice !== undefined && <p className="g2-row-notice" role={notice.ok ? 'status' : 'alert'}><VisibleText text={notice.text} /></p>}
  <div className="g2-editor-fields">
   <Select label="AI provider" value={provider} onValueChange={value => { setProvider(value === 'vertex' ? 'vertex' : 'gemini'); }} options={[{ value: 'gemini', label: 'Google AI Studio (API key)' }, { value: 'vertex', label: 'Vertex AI (your Google Cloud project)' }]} />
   {provider === 'gemini' && <SecretField label={settings.key.connected ? 'Replace the key' : 'Paste the AI Studio key'} submitLabel={settings.key.connected ? 'Replace key' : 'Connect key'}
    onSubmit={value => send('PUT', `${path}/key`, { key: value.trim() }, settings.key.connected ? 'Key replaced.' : 'Key connected.')} />}
  </div>
  {provider === 'gemini'
   ? <p className="g2-note">{settings.key.connected ? `A key is connected${settings.key.updatedAt === undefined ? '' : `, last changed ${when(settings.key.updatedAt)}`}. It is never shown here.${settings.key.refusedAt === undefined ? '' : ` Google refused it at ${when(settings.key.refusedAt)}: replace it.`}`
    : `No key is connected. The project's tests can't call Gemini until one is.${settings.removedUntil === undefined ? '' : ` The last key was removed; it can be recovered until ${when(settings.removedUntil)}.`}`} After saving, the key is never shown again.</p>
   : <Vertex settings={settings} busy={busy} send={send} path={path} removable={false} refusal={notice?.ok === false ? notice.reason : undefined} />}
  <section className="g2-editor-budget" aria-label="Eval budget">
   <h3>Eval budget</h3>
   <p className="g2-note">Each eval stage may hold at most <strong>{settings.evalBudget.calls}</strong> calls and <strong><Money usd={settings.evalBudget.costMicros / 1_000_000} /></strong>.</p>
   <div className="g2-editor-fields">
    <TextField label="Calls per stage" inputMode="numeric" value={calls} onChange={event => { setCalls(event.target.value); }} {...(callsOk ? {} : { error: 'A whole number, 1 or more.' })} />
    <TextField label="Spend per stage (USD)" inputMode="decimal" value={usd} onChange={event => { setUsd(event.target.value); }} {...(budgetMicros !== undefined && budgetMicros > 0 ? {} : { error: 'An amount in dollars, above 0.' })} />
    <Button busy={busy} disabled={!callsOk || budgetMicros === undefined || budgetMicros === 0} onClick={() => { void send('PUT', `${path}/eval-budget`, { calls: Number(calls), costMicros: budgetMicros }, 'Eval budget saved.'); }}>Save eval budget</Button>
   </div>
  </section>
  <EvalApprovalSection settings={settings} busy={busy} send={send} />
  <div className="g2-editor-close"><Button onClick={onClose}>Close</Button></div>
 </section>;
}
