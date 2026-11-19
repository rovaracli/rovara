import type { ReactNode } from "react";
import { z } from "zod";
import { DataTable } from "../../../design/DataTable.js";
import { useAdminContext } from "../AdminLayout.js";
import { Link } from "react-router";
import { AGENT_AI_PATH, readAgentAi } from "../../../api/admin-agent-ai.js";
import { Endpoint } from "../agent-ai/AgentAiScreen.js";
import { CompanyKeyConnections } from "../learning-ai/LearningAiScreen.js";
import { modelSourcesSnapshot, sourceLabel } from "../models/source-order.js";
import { SourceOrderEditor } from "../models/SourceOrderEditor.js";
import { ReadSection, useAdminRead } from "../models/read.js";

export function CompanyAiConnections({ children }: { children?: ReactNode }) {
 const context = useAdminContext();
 const sources = useAdminRead("sources", "/v1/app/org/model-sources", modelSourcesSnapshot.extend({ orgId: z.literal(context.orgId).optional(), developerId: z.literal(context.developerId).optional() }));
 const endpoint = useAdminRead("agent-connection", AGENT_AI_PATH, { parse: readAgentAi });
 return <section id="ai-connections" aria-label="Company AI connections">
  <h2>Company AI connections</h2>
  <details><summary>Connect company AI</summary><CompanyKeyConnections />
   <ReadSection read={endpoint} label="Own endpoint connection">{settings => settings.listed.includes("custom_endpoint") && settings.keysRevision !== null ? <Endpoint key={settings.keysRevision} settings={settings} reload={() => { void endpoint.refetch(); }} /> : <p>Own endpoint connection is not available on this Rovara.</p>}</ReadSection>
   <p>Own Bedrock uses Claude for agents. <Link to="/app/admin/product-ai">Your app's tests: project AI connections</Link></p>
  </details>
  {children}
  <ReadSection read={sources} label="AI source order">{data => <>
   <h3>AI source order</h3>
   {data.order.length === 0 ? <p>No order is saved yet. The current source could not be checked.</p> : <ol>{data.order.map(source => <li key={source}>{sourceLabel(source)}</li>)}</ol>}
   <DataTable caption="Company AI sources" rows={data.sources} rowKey={s => s.source} columns={[
    { key: "source", title: "Source", render: s => sourceLabel(s.source) },
    { key: "connected", title: "Connected", render: s => s.connected === null ? "Can't tell right now" : s.connected ? "Yes" : "No" },
    { key: "available", title: "Can be used", render: s => s.available ? "Yes" : "Connect it first" },
    { key: "position", title: "In the order", render: s => { const at = data.order.indexOf(s.source); return at < 0 ? "Not in the order" : at === 0 ? "First choice" : `Fallback ${at}`; } },
   ]} />
   <p>Connected credentials do not verify model access. Sources known to be unusable are skipped before sending. A call already started is never retried on another source. Learning and answers use their own source rules.</p>
   {data.order.includes("bedrock_byo") && <p>NOT TESTED: Bedrock in your own AWS account hasn't been tested yet. Guided external setup only; model access is unverified.</p>}
   <SourceOrderEditor available={sources.isSuccess && !sources.isFetching && data.orgId === context.orgId && data.developerId === context.developerId && data.revision !== undefined && data.revision < Number.MAX_SAFE_INTEGER && data.sources.some(item => item.available)} />
  </>}</ReadSection>
 </section>;
}
