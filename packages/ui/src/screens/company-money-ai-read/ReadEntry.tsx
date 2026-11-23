import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { AppHostProvider, useAppHost } from '../../host.js';
import { OutcomeNotConfirmed } from '../../design/OutcomeNotConfirmed.js';
import { PageHeader } from '../../design/PageHeader.js';
import { AiSpendStep, AI_SPEND_STEP_WORDS } from '../setup/AiSpendStep.js';
import { useAdminContext, type AdminContext } from '../admin/admin-context.js';
import { UnfencedHostContext } from '../admin/ai-spending/UnfencedHost.js';
import { moneyAiActionHost } from './action-host.js';
import { ModelNames } from '../setup/model-scope.js';
import { FactChip, HeldLine, modelName } from './Parts.js';
import './company-money-ai-read.css';
export function ReadEntry({ children }: { children: ReactNode }) {
 const scope = useAdminContext(), location = useLocation();
 return <section className="rv-company-money-ai-read">
  {scope.checking ? <HeldLine role="status">Checking your company access…</HeldLine>
   : scope.role === 'member' && location.pathname === '/app/admin/ai-spending' ? <><PageHeader focusOnMount title="AI and spending" breadcrumbs={[{ label: 'Company' }, { label: 'AI' }]} meta={<span className="g2-inline"><span>Access</span><FactChip>Read only</FactChip></span>} /><p className="g2-lede">{AI_SPEND_STEP_WORDS.intro}</p><ModelNames.Provider value={modelName}><AiSpendStep {...scope} /></ModelNames.Provider></>
   : scope.role !== 'owner' && scope.role !== 'admin' ? <HeldLine role="alert">Only company owners and admins can read this.</HeldLine>
   : <ActionEntry key={`${scope.orgId}:${scope.developerId}:${scope.role}`} scope={scope}>{children}</ActionEntry>}
 </section>;
}
function ActionEntry({ scope, children }: { scope: AdminContext; children: ReactNode }) {
 const host = useAppHost(), client = useQueryClient(), live = useRef(false);
 const [, refresh] = useState(0);
 useEffect(() => {
  live.current = true;
  const update = () => refresh(value => value + 1);
  window.addEventListener('storage', update);
  return () => { live.current = false; window.removeEventListener('storage', update); };
 }, []);
 const { orgId, developerId, role, checking, company } = scope;
 // The factory captures callbacks; only async transport calls invoke them, never render.
 // eslint-disable-next-line react-hooks/refs
 const actions = useMemo(() => moneyAiActionHost(host, client, { orgId, developerId, role, checking, company }, () => live.current, () => { if (live.current) refresh(value => value + 1); }), [host, client, orgId, developerId, role, checking, company]);
 return <AppHostProvider host={actions.host}>
  <div>
  {actions.pending().length > 0 && <OutcomeNotConfirmed title="Action outcome not confirmed" happened="A change may still be in progress or its answer was lost." safe="The same action stays locked. Checking sends no change." next="Check the current state before making another change." check={{ label: 'Check action outcome', onCheck: () => { void actions.check(); } }} refCode="G2-ACTION-UNCONFIRMED" />}
  <UnfencedHostContext.Provider value={host}>{children}</UnfencedHostContext.Provider>
  </div>
 </AppHostProvider>;
}
