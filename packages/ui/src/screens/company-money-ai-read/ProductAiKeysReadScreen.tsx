import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { Button } from '../../design/Button.js';
import { PageHeader } from '../../design/PageHeader.js';
import { TextField } from '../../design/TextField.js';
import { VisibleText } from '../../design/VisibleText.js';
import { PROJECT_NAME } from '../../api/admin-product-ai.js';
import { servedReadState } from '../../api/served-read.js';
import { useProductAiSend } from '../admin/product-ai/ProductAiScreen.js';
import { ProductAiKeyEditor } from './ProductAiKeyEditor.js';
import { ReadState, ReadSurface } from './ReadState.js';
import { FactChip, HeldLine, Note, Row, RowList, Section, Unknown, dollarsShort, readTime } from './Parts.js';
import { PROJECTS_PATH, accessLost, freshFacts, productAiPath, productReader, reportReader, useMoneyAiRead, useMoneyAiReads } from './read-model.js';
type Product = ReturnType<ReturnType<typeof productReader>['parse']>;
const word = (connected: boolean | null) => connected === null ? 'not read' : connected ? 'connected' : 'not connected';
const hasKey = (data: Product): boolean | null => data.key.connected === true || data.vertex.connected === true ? true : data.key.connected === false && data.vertex.connected === false ? false : null;
const REMOVED = { key: "Key removed. Tests can't call Gemini until a key is connected again.", vertex: "Vertex AI removed. Tests can't call Vertex AI until it is connected again." } as const;

/** The live page's Project field (WIRING-1 restore): open the editor for any project by its name, not only the ones the report lists. Same name rule; no read until a valid name is opened. */
function OpenProject({ onOpen }: { onOpen: (project: string) => void }) {
 const [typed, setTyped] = useState(''), name = typed.trim(), valid = PROJECT_NAME.test(name);
 return <Section title="Open a project by name" label="Open a project">
  <form className="g2-open-project" onSubmit={event => { event.preventDefault(); if (valid) { onOpen(name); } }}>
   <TextField label="Project" value={typed} onChange={event => { setTyped(event.target.value); }} hint="The project's name, as on the Projects page." {...(typed !== '' && !valid ? { error: 'Lowercase letters, digits and hyphens, starting with a letter.' } : {})} />
   <Button type="submit" disabled={!valid}>Open</Button>
  </form>
 </Section>;
}
/** One project's row: its key status, and its own Replace / Remove (or Add a key). Remove sends the same change the live page's Remove sends. */
function KeyRow({ name, read, onEdit }: { name: string; read: UseQueryResult<Product>; onEdit: (project: string) => void }) {
 const item = freshFacts(read), state = item === undefined ? undefined : hasKey(item);
 const { busy, notice, send } = useProductAiSend(name, item?.revision ?? 0, () => { void read.refetch(); });
 const path = productAiPath(name), both = item?.key.connected === true && item.vertex.connected === true;
 const remove = (what: 'key' | 'vertex') => () => { void send('DELETE', `${path}/${what}`, {}, REMOVED[what]); };
 const actions = item === undefined || state === null ? undefined : state === false
  ? <Button disabled={busy} aria-label={`Add a key to ${name}`} onClick={() => { onEdit(name); }}>Add a key</Button>
  : <>
   <Button disabled={busy} aria-label={`Replace the key on ${name}`} onClick={() => { onEdit(name); }}>Replace</Button>
   {item.key.connected === true && <Button variant="danger" disabled={busy} aria-label={`Remove key from ${name}`} onClick={remove('key')}>{both ? 'Remove key' : 'Remove'}</Button>}
   {item.vertex.connected === true && <Button variant="danger" disabled={busy} aria-label={`Remove Vertex AI from ${name}`} onClick={remove('vertex')}>{both ? 'Remove Vertex AI' : 'Remove'}</Button>}
  </>;
 return <Row title={name}
  chip={item === undefined ? (read.isError ? <Unknown /> : undefined) : state === true ? <FactChip icon="tick">Key connected</FactChip> : state === false ? <FactChip dashed>No key</FactChip> : <Unknown />}
  meta={item === undefined ? accessLost(read) ? <ReadState read={read} label={`${name} product key`} scope="section">{() => null}</ReadState> : <span>{read.isError ? 'This project’s key status could not be read.' : 'Reading…'}</span> : <>
   <span className="g2-val">{`AI Studio key ${word(item.key.connected)} · Vertex AI ${word(item.vertex.connected)}`}</span>
   {item.key.refusedAt !== undefined && <span>Key refusal recorded {readTime(item.key.refusedAt)}.</span>}
   {item.vertex.refusedAt !== undefined && <span>Vertex refusal recorded {readTime(item.vertex.refusedAt)}.</span>}
   <span>{`Eval budget: ${String(item.evalBudget.calls)} calls and ${dollarsShort(Math.round(item.evalBudget.costMicros / 10_000))} per stage.`}</span>
   <span>Test results are not shown here.</span>
   {notice !== undefined && <span className="g2-row-notice" role={notice.ok ? 'status' : 'alert'}><VisibleText text={notice.text} /></span>}
  </>} {...(actions === undefined ? {} : { end: actions })} />;
}

/** The board's "Product AI keys": one row per project with a status chip and its own Replace / Remove (or Add a key); the key editor opens below. No key value is ever read or shown. */
export function ProductAiKeysReadScreen() {
 const [params] = useSearchParams();
 const given = params.get('project')?.trim() ?? '';
 // A link from the eval card opens the editor for the project it names, as the live page did.
 const [project, setProject] = useState(PROJECT_NAME.test(given) ? given : '');
 const list = useMoneyAiRead('product-projects', PROJECTS_PATH, reportReader);
 const projects = (freshFacts(list)?.projects ?? []).filter(name => PROJECT_NAME.test(name));
 const reads = useMoneyAiReads('product', projects.map(name => ({ path: productAiPath(name), reader: productReader(name) })));
 const crumbs = [{ label: 'Company', href: '/app/admin' }, { label: 'Connections', href: '/app/admin/connections' }];
 const data = reads.map(read => freshFacts(read));
 const withKey = data.filter(item => item !== undefined && hasKey(item) === true).length;
 const keyCountKnown = data.every(item => item !== undefined && hasKey(item) !== null);
 const stale = [list, ...reads].some(read => servedReadState<unknown>(read).staleSince !== undefined);
 return <>
  <PageHeader title="Product AI keys" breadcrumbs={crumbs} {...(freshFacts(list) === undefined ? {} : { description: [`${String(projects.length)} ${projects.length === 1 ? 'project' : 'projects'}`, ...(data.every(item => item !== undefined) ? [keyCountKnown ? `${String(withKey)} with a key` : 'Unknown'] : []), ...(stale ? [] : [`Read from Rovara ${readTime(list.dataUpdatedAt)}`])].join(' · ') })} focusOnMount />
  <ReadSurface reads={[list, ...reads]}>
  <ReadState read={list} label="Product keys">{() => <>
  <Note title="What this is, and what it isn’t">When your product itself calls an AI provider, its tests need a key to run. That key is kept here, per project, and is used only by that project’s tests and evals. It is separate from the AI that Rovara uses to do the work, which is under <Link to="/app/admin/ai-spending">AI</Link>, and it has its own budget.</Note>
  {projects.length === 0 ? <HeldLine role="status">No projects to show.</HeldLine> : <RowList big label="Projects">{projects.map((name, index) => <KeyRow key={name} name={name} read={reads[index]!} onEdit={setProject} />)}</RowList>}
  <OpenProject onOpen={setProject} />
  {project !== '' && <ProductAiKeyEditor key={project} project={project} onClose={() => { setProject(''); }} />}
  </>}</ReadState>
  </ReadSurface>
 </>;
}
