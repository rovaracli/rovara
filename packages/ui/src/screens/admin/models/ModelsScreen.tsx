import { NavLink, useLocation } from "react-router";
import { z } from "zod";
// Keep the source contract warning verbatim without importing its Node-only barrel.
const BEDROCK_NOT_TESTED_NOTE = "NOT TESTED: Bedrock in your own AWS account hasn't been tested yet.";
import { PageHeader } from "../../../design/PageHeader.js";
import { DataTable } from "../../../design/DataTable.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { modelProvider, modelSourcesSnapshot, sourceLabel } from "./source-order.js";
import { SourceOrderEditor } from "./SourceOrderEditor.js";
import { ReadSection, useAdminRead } from "./read.js";
const servingSchema = z.object({ models: z.array(z.object({ provider: modelProvider, modelId: z.string().max(256), sources: z.array(z.string().max(100)).max(12) })).max(1000) });
function ServingCatalog() {
 const read = useAdminRead("serving-models", "/v1/app/models", servingSchema);
 return <><h2>Models returned for this company</h2><ReadSection read={read} label="Permitted model routes">{data => data.models.length === 0 ? <p>No models returned. Provider setup or company rules may block new work. Ask an admin to verify access.</p> : <><DataTable caption="Model routes, unverified provider access" rows={data.models} rowKey={m => `${m.provider}:${m.modelId}`} columns={[
 { key: "model", title: "Model", render: m => <VisibleText text={m.modelId} /> }, { key: "provider", title: "Provider", render: m => <VisibleText text={m.provider === "bedrock" ? "Amazon Bedrock" : m.provider} /> },
 { key: "sources", title: "Sources", render: m => m.sources.map(source => source === "rovara" ? "Rovara" : source === "personal-chatgpt" ? "Personal ChatGPT" : "Company source").join(", ") },
 { key: "access", title: "Verification", render: () => "Returned by picker · access unverified" },
 ]} /><p>Fresh provider checks, capabilities and price versions are unavailable in this list. These entries do not prove verified per-model access.</p></>}</ReadSection></>;
}
export function ModelsScreen() {
 const context = useAdminContext();
 const location = useLocation(), tab = location.pathname.endsWith("/available") ? "available" : location.pathname.endsWith("/steps") ? "steps" : "sources";
 const read = useAdminRead("sources", "/v1/app/org/model-sources", modelSourcesSnapshot.extend({orgId:z.literal(context.orgId).optional(),developerId:z.literal(context.developerId).optional(),revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()}));
 return <section><PageHeader focusOnMount title={tab === "sources" ? "AI models" : tab === "available" ? "Available models" : "Code step models"} description="Where the company's agents get their AI, and in what order." />
 <nav aria-label="AI models"><NavLink to="/app/admin/models/sources">Sources</NavLink>{" · "}<NavLink to="/app/admin/models/available">Available models</NavLink>{" · "}<NavLink to="/app/admin/models/steps">Code step models</NavLink></nav>
 {tab === "sources" && <ReadSection read={read} label="Model sources">{data => <>
 <h2>Company AI sources</h2>
 <DataTable caption="Company AI sources" rows={data.sources} rowKey={s => s.source} columns={[
 { key: "source", title: "Source", render: s => sourceLabel(s.source) },
 { key: "connected", title: "Connected", render: s => s.connected === null ? "Can't tell right now" : s.connected ? "Yes" : "No" },
 { key: "available", title: "Can be used", render: s => s.available ? "Yes" : "Connect it first" },
 { key: "position", title: "In the order", render: s => { const at = data.order.indexOf(s.source); return at < 0 ? "Not in the order" : at === 0 ? "First choice" : `Fallback ${at}`; } },
 ]} />
 <h2>Source order</h2>
 {data.order.length === 0 ? <p>No order is saved yet. The company's agents use this Rovara's default until an owner or admin saves one.</p> : <ol>{data.order.map(id => <li key={id}><VisibleText text={sourceLabel(id)} /></li>)}</ol>}
 <p>Each call goes to the first source in the order that can take it. A source that isn't connected, or doesn't offer the model, is skipped before anything is sent. A source that is unavailable mid-call is not retried on another one.</p>
 <SourceOrderEditor available={read.isSuccess&&!read.isFetching&&data.orgId===context.orgId&&data.developerId===context.developerId&&data.revision!==undefined&&data.revision<Number.MAX_SAFE_INTEGER&&data.sources.some(s=>s.available)} />
 {data.order.includes("bedrock_byo") && <p>{BEDROCK_NOT_TESTED_NOTE} Guided external setup only; model access is unverified.</p>}
 </>}</ReadSection>}
 {tab === "available" && <><p>Cost unavailable. The models each step may use are the ones the company's AI sources offer now.</p><ServingCatalog /></>}
 {tab === "steps" && <><h2>Rovara Code choices</h2><p><NavLink to="/app/admin/how-we-work">Set company defaults and locks in How we work</NavLink></p><p>Effective step choices, policy scope, selection reasons and approved fallbacks cannot be verified in this view yet.</p><DataTable caption="Code step model coverage" rows={["Plan", "Plan check", "Code", "Review"]} rowKey={s => s} columns={[{ key: "step", title: "Step", render: s => s }, { key: "model", title: "Effective model", render: () => "Effective model unavailable" }, { key: "cost", title: "Estimate", render: () => "Cost unavailable" }]} /><p>Quality within budget is the company policy. No provider is enabled here; running task models stay pinned. Verify model access before starting new paid work.</p></>}
 </section>;
}
