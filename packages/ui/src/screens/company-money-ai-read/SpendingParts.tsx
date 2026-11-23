import { Button } from '../../design/Button.js';
import { Dialog } from '../../design/Dialog.js';
import { AGENT_AI_PATH, readAgentAi } from '../../api/admin-agent-ai.js';
import { ORG_SETTINGS_PATH, readCompanySettings } from '../../api/admin-company.js';
import { AiSpendStep } from '../setup/AiSpendStep.js';
import { CompanyAiConnect } from '../admin/ai-spending/CompanyAiConnections.js';
import { sourceLabel } from '../admin/models/source-order.js';
import { ReadState } from './ReadState.js';
import { Facts, Section, Unknown, dollarsShort } from './Parts.js';
import { useMoneyAiRead } from './read-model.js';
type Who = { orgId: string; developerId: string; role: 'owner' | 'admin' | 'member'; company: string };
export const agentAiReader = { parse: readAgentAi };
const settingsReader = { parse: readCompanySettings };
/**
 * The board's "Change spending" (WIRING-1 restore): who pays for the AI and the company's monthly limit, saved with the setup step's one Save (the same component, the same handlers, the same
 * refusals; the page's action host fences the two writes on the latest reads like every other G2 action).
 */
function ChangeSpending(who: Who) {
 return <Dialog title="Change spending" description="Choose who pays for the AI and the most the company spends on it in a month, then save. A running task keeps its source until its next AI call." trigger={<Button>Change spending</Button>}>
  <AiSpendStep spending {...who} />
 </Dialog>;
}
/** "Connect company AI": the Anthropic key, the company's own endpoint and Bedrock, with the setup card's own components (write-only keys). */
export function ConnectAi() {
 return <Dialog title="Connect company AI" description="Connect your company's own AI provider. Keys are write-only: Rovara uses them but never shows them." trigger={<Button>Connect company AI</Button>}>
  <div className="g2-connect"><CompanyAiConnect /></div>
 </Dialog>;
}
/** Who pays and the monthly limit, read from the same two routes the dialog saves to. */
export function SpendingSection(who: Who) {
 const source = useMoneyAiRead('agent-ai', AGENT_AI_PATH, agentAiReader), settings = useMoneyAiRead('settings', ORG_SETTINGS_PATH, settingsReader);
 return <Section id="ai-spending" title="Who pays and the monthly limit" label="Spending" actions={<ChangeSpending {...who} />}>
  <ReadState read={source} label="Who pays" scope="section">{data => {
   const serving = data.source ?? data.effectiveSource;
   return <ReadState read={settings} label="Monthly limit" scope="section">{company => <Facts rows={[
    ['Who pays', serving === null ? <Unknown /> : <>{sourceLabel(serving)}{data.source === null && data.sourceIsDefault ? ' (the default)' : ''}</>],
    ['Monthly limit', typeof company.monthlyCapUsd === 'number' ? dollarsShort(Math.round(company.monthlyCapUsd * 100)) : 'Not saved yet'],
   ]} />}</ReadState>;
  }}</ReadState>
 </Section>;
}
