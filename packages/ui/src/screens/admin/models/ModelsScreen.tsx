import { NavLink, useLocation } from "react-router";
import { z } from "zod";
// Keep the source contract warning verbatim without importing its Node-only barrel.
const BEDROCK_NOT_TESTED_NOTE = "NOT TESTED: Bedrock in your own AWS account hasn't been tested yet.";
import { PageHeader } from "../../../design/PageHeader.js";
import { DataTable } from "../../../design/DataTable.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { modelProvider, modelSourcesSnapshot } from "./source-order.js";
import { ModelSourceGuidance } from "./ModelSourceGuidance.js";
import { SourceOrderEditor } from "./SourceOrderEditor.js";
import { ReadSection, useAdminRead } from "./read.js";
const providers = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", bedrock: "Amazon Bedrock", endpoint: "Gateway endpoint" };
const servingSchema = z.object({ models: z.array(z.object({ provider: modelProvider, modelId: z.string().max(256), sources: z.array(z.string().max(100)).max(12) })).max(1000) });
function ServingCatalog() {
 const read = useAdminRead("serving-models", "/v1/app/models", servingSchema);
 return <><h2>Models returned for this company</h2><ReadSection read={read} label="Permitted model routes">{data => data.models.length === 0 ? <p>No models returned. Provider setup or company rules may block new work. Ask an admin to verify access.</p> : <><DataTable caption="Model routes, unverified provider access" rows={data.models} rowKey={m => `${m.provider}:${m.modelId}`} columns={[
 { key: "model", title: "Model", render: m => <VisibleText text={m.modelId} /> }, { key: "provider", title: "Provider", render: m => <VisibleText text={m.provider === "bedrock" ? "Amazon Bedrock" : m.provider} /> },
 { key: "sources", title: "Model source", render: m => m.sources.map(source => source === "rovara" ? "Rovara" : source === "personal-chatgpt" ? "Personal ChatGPT" : "Company source").join(", ") },
 { key: "access", title: "Verification", render: () => "Returned by picker · access unverified" },
 ]} /><p>Fresh provider checks, capabilities and price versions are unavailable in this list. These entries do not prove verified per-model access.</p></>}</ReadSection></>;
}
export function ModelsScreen() {
 const context = useAdminContext();
 const location = useLocation(), tab = location.pathname.endsWith("/available") ? "available" : location.pathname.endsWith("/steps") ? "steps" : "sources";
 const read = useAdminRead("sources", "/v1/app/org/model-sources", modelSourcesSnapshot.extend({orgId:z.literal(context.orgId).optional(),developerId:z.literal(context.developerId).optional(),revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),available:z.array(z.enum(["anthropic","openai","openrouter","bedrock","endpoint"])).max(5).optional()}));
 return <section><PageHeader focusOnMount title={tab === "sources" ? "AI models" : tab === "available" ? "Available models" : "Code step models"} description="Company source configuration does not verify access to a model." />
 <nav aria-label="AI models"><NavLink to="/app/admin/models/sources">Model sources</NavLink>{" · "}<NavLink to="/app/admin/models/available">Available models</NavLink>{" · "}<NavLink to="/app/admin/models/steps">Code step models</NavLink></nav>
 <ReadSection read={read} label="Model sources">{data => <>
 {tab === "sources" && <>
 <p>To add, check or remove an AI provider, use <NavLink to="/app/admin/connections?open=ai-provider">Connections</NavLink>. Here you choose the order they are tried in.</p>
 <h2>Company providers</h2>
 {data.sources.length === 0 ? <p>No company providers are added. Work runs on Rovara's own models.</p> : <DataTable caption="Company sources" rows={data.sources} rowKey={s => s.sourceId} columns={[
 { key: "label", title: "Source", render: s => <VisibleText text={s.label} /> }, { key: "provider", title: "Provider", render: s => providers[s.kind] },
 { key: "credential", title: "Credential", render: s => s.kind === "bedrock" ? "External setup · Unverified" : s.hasCredential ? "Configured" : "Not configured" },
 { key: "models", title: "Models", render: s => `${s.models.length} configured · verified usable count unavailable` },
 { key: "access", title: "Model access", render: () => "Unverified" },
 ]} />}
 {data.sources.length > 0 && <><h2>Source evidence and setup guidance</h2><div key={`${context.orgId}:${context.developerId}:${context.role}`}>{data.sources.map(source => <ModelSourceGuidance key={source.sourceId} source={source} providerName={providers[source.kind]} />)}</div></>}
 <h2>Source order</h2><ol>{data.order.map(id => <li key={id}><VisibleText text={id === "rovara" ? "Rovara" : id === "personal-chatgpt" ? "Personal ChatGPT" : data.sources.find(s => s.sourceId === id)?.label ?? "Unknown source"} /></li>)}</ol><p>Rovara and Personal ChatGPT remain separate sources. Installation configuration does not establish company access.</p>
 <SourceOrderEditor available={read.isSuccess&&!read.isFetching&&data.orgId===context.orgId&&data.developerId===context.developerId&&data.revision!==undefined&&data.revision<Number.MAX_SAFE_INTEGER&&data.order.length>1} />
 </>}
 {tab === "available" && <><h2>Configured model catalog</h2><p>Unverified: the current directory has no fresh per-model check, capability evidence or pricing version. Configured entries are not selectable verified models.</p>
 {data.sources.flatMap(s => s.models).length === 0 ? <p>No company model entries were returned. Model access remains unknown.</p> : <DataTable caption="Configured models, unverified access" rows={data.sources.flatMap(s => s.models.map((m, i) => ({ id: `${s.sourceId}:${i}`, label: s.label, model: m.catalog.modelId, provider: m.catalog.provider })))} rowKey={m => m.id} columns={[
 { key: "model", title: "Model", render: m => <VisibleText text={m.model} /> }, { key: "source", title: "Source", render: m => <VisibleText text={m.label} /> }, { key: "provider", title: "Provider", render: m => <VisibleText text={m.provider === "bedrock" ? "Amazon Bedrock" : m.provider} /> }, { key: "state", title: "Access", render: () => "Unverified" },
 ]} />}
 <p>Cost unavailable. Stronger-model suggestions require approved rankings, verified access and prices for the same workload. Ask an admin to arrange supported setup, then verify access before selecting a model.</p></>}
 {tab === "steps" && <><h2>Rovara Code choices</h2><p><NavLink to="/app/admin/how-we-work">Set company defaults and locks in How we work</NavLink></p><p>Effective step choices, policy scope, selection reasons and approved fallbacks cannot be verified in this view yet.</p><DataTable caption="Code step model coverage" rows={["Plan", "Plan check", "Code", "Review"]} rowKey={s => s} columns={[{ key: "step", title: "Step", render: s => s }, { key: "model", title: "Effective model", render: () => "Effective model unavailable" }, { key: "cost", title: "Estimate", render: () => "Cost unavailable" }]} /><p>Quality within budget is the company policy. No provider is enabled here; running task models stay pinned. Verify model access before starting new paid work.</p></>}
 {data.sources.some(s => s.kind === "bedrock") && <p>{BEDROCK_NOT_TESTED_NOTE} Guided external setup only; model access is unverified.</p>}
 </>}</ReadSection>{tab === "available" && <ServingCatalog />}</section>;
}
