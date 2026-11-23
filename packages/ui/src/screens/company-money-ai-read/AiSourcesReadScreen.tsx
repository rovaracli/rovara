import { useEffect } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { servedReadState } from '../../api/served-read.js';
import { useLocation } from 'react-router';
import { PageHeader } from '../../design/PageHeader.js';
import { DataTable } from '../../design/DataTable.js';
import { STEP_GROUPS, priceText, type AgentModelsRead } from '../../api/agent-models.js';
import { useAdminContext } from '../admin/admin-context.js';
import { ReadState, ReadSurface } from './ReadState.js';
import { FactChip, HeldLine, Row, RowList, Section, TitleCell, Unknown, modelName, readTime } from './Parts.js';
import { EmptyOrderLine, SourceOrderRows, sourceStatus } from './SourceOrderRows.js';
import { accessLost, freshFacts, sourcesReader, stepModelsReader, STEP_MODELS_PATH, useMoneyAiRead } from './read-model.js';
import { AiSpendStep } from '../setup/AiSpendStep.js';
import { ModelNames } from '../setup/model-scope.js';
import { SourceOrderEditor } from '../admin/models/SourceOrderEditor.js';
import { Button } from '../../design/Button.js';
import { Dialog } from '../../design/Dialog.js';
import { ApiError } from '../../api/errors.js';
import { ConnectAi, SpendingSection, agentAiReader } from './SpendingParts.js';
import { AGENT_AI_PATH } from '../../api/admin-agent-ai.js';
const stepLabel = (stage: string) => STEP_GROUPS.find(group => group.stage === stage)?.label ?? (stage === 'understand' ? 'Understand' : 'Security review');
/** The board's "Change a model": one dialog with the company model, each step's model and the learning model. Same handlers and refusals as the live page; the choices read as model names. */
function ChangeModel({ orgId, developerId, role, company }: { orgId: string; developerId: string; role: 'owner' | 'admin' | 'member'; company: string }) {
 return <Dialog title="Change a model" description="Choose a model for the company, for one step or for learning, then save it. A running task keeps its model until its next AI call." trigger={<Button>Change a model</Button>}>
  <ModelNames.Provider value={modelName}><AiSpendStep compact {...{ orgId, developerId, role, company }} /></ModelNames.Provider>
 </Dialog>;
}
/**
 * The models on offer to the company (GET /org/agent-models offered[], the list for the source in use). The title names Rovara's AI only when the served effective source (the same read as "Who pays",
 * same key) is Rovara's AI; otherwise, and while that read is pending or failed, it makes no per-source claim. Mounted only with the page's facts, so a refused composition leaves no agent-ai read behind.
 */
function ModelsOffered({ models }: { models: UseQueryResult<AgentModelsRead> }) {
 const agentAi = useMoneyAiRead('agent-ai', AGENT_AI_PATH, agentAiReader), served = freshFacts(agentAi);
 const title = served !== undefined && (served.source ?? served.effectiveSource) === 'rovara' ? "Models offered through Rovara's AI" : 'Models you can use';
 return <Section title={title} label="Models">
  <ReadState read={models} label="Models" scope="section">{data => <RowList><Row title={data.offered.map(modelName).join(', ')} /></RowList>}</ReadState>
 </Section>;
}
/** The board's "AI": the sources in the order Rovara tries them, the models on offer, and the model each step uses now. */
export function AiSourcesReadScreen() {
 const { orgId, developerId, role, company } = useAdminContext(), client = useQueryClient();
 const sources = useMoneyAiRead('sources', '/v1/app/org/model-sources', sourcesReader(orgId, developerId));
 const models = useMoneyAiRead('models', STEP_MODELS_PATH, stepModelsReader);
 // A refused read removes every AI fact; when both reads failed one block says so once.
 const refused = accessLost(sources) || accessLost(models);
 useEffect(() => {
  if (!refused) return;
  const scope = ['company-money-ai-read', orgId, developerId, role];
  const predicate = (query: { queryKey: readonly unknown[] }) => query.queryKey[4] === 'sources' || query.queryKey[4] === 'models';
  // The composition is refused as a whole: cancel late siblings and erase both private projections.
  void client.cancelQueries({ queryKey: scope, predicate }, { revert: false });
  for (const query of client.getQueryCache().findAll({ queryKey: scope, predicate })) query.setState({ data: undefined });
 }, [client, orgId, developerId, role, refused, sources.data, models.data]);
 // A legacy address (/admin/agent-ai, /admin/models ...) arrives here with the section it moved to in the hash: focus it once the page has loaded.
 const { hash } = useLocation(), pageLoaded = freshFacts(sources) !== undefined && (freshFacts(models) !== undefined || models.isError);
 useEffect(() => {
  if (!hash || !pageLoaded) return;
  const target = document.getElementById(decodeURIComponent(hash.slice(1)));
  if (target === null) return;
  target.tabIndex = -1; target.focus(); target.scrollIntoView?.({ block: 'start' });
 }, [hash, pageLoaded]);
 // The step-models route is wired per deployment (Code: the model-choice switch); where it is not served, the company and learning model stay changeable (their own routes), never hidden.
 const modelsNotServed = models.error instanceof ApiError && models.error.status === 501 && models.error.code === 'NOT_ON_CODE_YET';
 // Served and not allowed to change = no button. Anything not yet answered (a first read, or the re-read after a save) keeps it mounted: unmounting an open dialog would lose its saved line.
 const stepModelsAllow = freshFacts(models) === undefined || freshFacts(models)?.canChange === true;
 const blocked = refused || (sources.isError && models.isError && freshFacts(sources) === undefined && freshFacts(models) === undefined);
 const crumbs = [{ label: 'Company', href: '/app/admin' }, { label: 'Connections', href: '/app/admin/connections' }];
 const plain = <PageHeader title="AI and spending" breadcrumbs={crumbs} focusOnMount />;
 if (blocked) return <>{plain}<ReadState<unknown> read={{
  ...(accessLost(models) && !accessLost(sources) ? models : sources),
  // The error block represents both reads, including the successful sibling whose data was purged.
  refetch: async options => {
   const [result] = await Promise.all([sources.refetch(options), models.refetch(options)]);
   return result;
  },
 }} label="AI">{() => null}</ReadState></>;
 const loaded = freshFacts(sources), status = loaded === undefined ? undefined : sourceStatus(loaded);
 return <>
  {loaded === undefined || status === undefined ? plain : <PageHeader title="AI and spending" breadcrumbs={crumbs} meta={<span className="g2-inline"><span>Status</span>{status.chip === null ? <Unknown /> : <FactChip icon="tick">{status.chip}</FactChip>}<span>{`${status.summary}${servedReadState(sources).staleSince === undefined && servedReadState(models).staleSince === undefined ? ` · Read from Rovara ${readTime(sources.dataUpdatedAt)}` : ''}`}</span></span>} focusOnMount />}
  <ReadSurface reads={[sources, models]}>
  <p className="g2-lede">Who pays for the AI and the company&apos;s monthly limit, the providers you connect, the order Rovara tries them in, and the model each step uses are all managed here.</p>
  <SpendingSection {...{ orgId, developerId, role, company }} />
  <Section id="ai-connections" title="Sources, in the order Rovara tries them" label="Source inventory" actions={<><ConnectAi />{loaded === undefined || sources.isError ? undefined : <SourceOrderEditor label="Change order" available={!sources.isFetching && loaded.revision !== undefined && loaded.revision < Number.MAX_SAFE_INTEGER && loaded.sources.some(item => item.available)} />}</>}>
   <ReadState read={sources} label="AI sources" scope="section">{data => data.order.length === 0 ? <EmptyOrderLine status={sourceStatus(data)} unservedText="No source order was served." /> : <SourceOrderRows order={data.order} sources={data.sources} />}</ReadState>
  </Section>
  <ModelsOffered models={models} />
  {(freshFacts(models) !== undefined || !models.isError || modelsNotServed) && <Section id="ai-models" title="The model each step uses now" label="Effective step models" actions={!sources.isError && (modelsNotServed || (!models.isError && stepModelsAllow)) ? <ChangeModel {...{ orgId, developerId, role, company }} /> : undefined}>
   <ReadState read={models} label="Step models" scope="section">{data => <>
    {data.steps.length > 0 && <DataTable caption="Effective step models" rows={data.steps} rowKey={step => step.stage} columns={[
     { key: 'step', title: 'Step', render: step => <TitleCell title={stepLabel(step.stage)} summary={`${step.refused ? 'Unavailable for this step' : step.effective === null ? 'Model not read' : modelName(step.effective.model)} · ${step.setting === null ? 'Company default' : 'Set for this step'}`} /> },
     { key: 'model', title: 'Model in effect', render: step => step.refused ? 'Unavailable for this step' : step.effective === null ? <Unknown /> : <>{modelName(step.effective.model)}{priceText(step.effective.priceUsdPerMillion) !== undefined && <small>{priceText(step.effective.priceUsdPerMillion)}</small>}</> },
     { key: 'chosen', title: 'Chosen in', render: step => step.setting === null ? 'Company default' : 'Set for this step' },
    ]} />}
    {data.steps.length === 0 && <div className="g2-held-row"><Unknown /><HeldLine role="status">No step models were served.</HeldLine></div>}
    <p className="g2-note">A running task keeps its model until its next AI call.</p>
   </>}</ReadState>
  </Section>}
  </ReadSurface>
 </>;
}
