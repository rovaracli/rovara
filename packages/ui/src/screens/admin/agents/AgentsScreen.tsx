import { Link, useSearchParams } from "react-router";
import { SettingsNote } from "../SettingsNote.js";
import { z } from "zod";
import { AgentDirectoryResponseReaderSchema, AutonomySchema } from "@agentx/cloud-contracts/web";
import { DataTable } from "../../../design/DataTable.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ReadState, useAdminRead } from "../projects/read.js";
const agentReader = { parse(value: unknown) { return { agents: AgentDirectoryResponseReaderSchema.parse(value).agents.map(a => ({ agentId:a.agentId,name:a.name,builtin:a.builtin,status:a.status,disabled:a.disabled,currentVersion:a.currentVersion,pinnedVersion:a.pinnedVersion,latestVersion:a.latestVersion,accountable:a.accountable,monthlyBudgetUsd:a.monthlyBudgetUsd,maxPerRunUsd:a.maxPerRunUsd,updateAvailable:a.updateAvailable })) }; } };
const amount = z.number().finite().nonnegative();
// Browser-only read projection: do not import the server guardrail schema (models-node).
const guardrailReader = z.object({ revision:z.number().int().nonnegative(),guardrails:z.object({maxAutonomy:AutonomySchema,forbiddenModels:z.array(z.string()),requireCrossCompanyReview:z.boolean(),maxAgentMonthlyUsd:amount,maxPerRunCeilingUsd:amount,maxStepBudgetUsd:amount.optional(),disabledBuiltins:z.array(z.string()),extraTriggerLabels:z.array(z.string()),extraCommandWords:z.array(z.string()),reportLinkDomains:z.array(z.string())}) });
export const displayLimit = (value: number | undefined) => value === undefined ? "Not returned" : value === 0 ? "$0" : `$${value}`;
function Guardrails() {
 const read = useAdminRead("agent-guardrails", "company", "/v1/app/org/agent-guardrails", guardrailReader);
 return <section><h2>Company agent guardrails</h2><ReadState read={read} label="company guardrails">{({guardrails:g,revision})=><><p>Guardrail revision: {revision}</p><p>Maximum autonomy: {g.maxAutonomy}</p><p>Maximum monthly agent budget: {displayLimit(g.maxAgentMonthlyUsd)}</p><p>Maximum per-run ceiling: {displayLimit(g.maxPerRunCeilingUsd)}</p><p>Maximum step budget: {g.maxStepBudgetUsd === undefined ? "No company step ceiling set" : displayLimit(g.maxStepBudgetUsd)}</p><p>Cross-company review required: {g.requireCrossCompanyReview ? "Yes" : "No"}</p><dl>{[["Forbidden models",g.forbiddenModels],["Disabled built-in agents",g.disabledBuiltins],["Extra trigger labels",g.extraTriggerLabels],["Extra command words",g.extraCommandWords],["Report link domains",g.reportLinkDomains]].map(([label,values])=><div key={String(label)}><dt>{label}</dt><dd>{Array.isArray(values) && values.length ? values.join(", ") : "None configured"}</dd></div>)}</dl><p>Local-agent device policy is not included in this view.</p></>}</ReadState></section>;
}
export function AgentsScreen() {
 const [params,setParams] = useSearchParams(), term = params.get("q") ?? "";
 const read = useAdminRead("agents", "list", "/v1/app/agents?scope=all", agentReader);
 return <section><PageHeader focusOnMount title="Agents" description="Inspect versions and company guardrails. Existing sessions keep their pinned recipes." /><SettingsNote area="agents" /><p>Visible agents only; this is not a complete company adoption inventory.</p><ReadState read={read} label="agents">{data=>{
 const matches = data.agents.filter(a=>a.name.toLocaleLowerCase("en-US").includes(term.trim().toLocaleLowerCase("en-US")));
 return <><div className="rv-field rv-admin-search"><label htmlFor="admin-agent-search">Find in this agent list</label><input id="admin-agent-search" type="search" maxLength={200} value={term} onChange={e=>setParams(e.target.value?{q:e.target.value}:{},{replace:true})} /></div><p>Per-agent autonomy and permitted-project lists are not returned by this directory. Inspect the existing profile for recipe details.</p>
 {data.agents.length === 0 ? <p>No visible agents were returned. <Link to="/app/agents">Open agent directory</Link></p> : matches.length === 0 ? <p>No matching agents in this list.</p> : <DataTable caption="Visible agents" rows={matches} rowKey={a=>a.agentId} columns={[
 {key:"name",title:"Agent",render:a=><Link to={`/app/agents/${encodeURIComponent(a.agentId)}`}><VisibleText text={a.name} /></Link>},
 {key:"status",title:"Status",render:a=>a.disabled ? "Disabled" : a.status === "archived" ? "Archived" : "Active"},
 {key:"version",title:"Applied version",render:a=>a.builtin ? a.pinnedVersion ?? "Unknown" : a.currentVersion ?? "Unpublished"}, {key:"latest",title:"Latest version",render:a=>a.latestVersion || "No published versions"},
 {key:"accountable",title:"Accountable person",render:a=>a.accountable ? "Assigned (see profile)" : "Not returned"}, {key:"budget",title:"Monthly / per-run limits",render:a=>`${displayLimit(a.monthlyBudgetUsd)} / ${displayLimit(a.maxPerRunUsd)}`},
 {key:"update",title:"Update availability",render:a=>a.builtin && a.pinnedVersion !== undefined ? a.latestVersion > a.pinnedVersion ? "Newer version available" : "At latest version" : a.updateAvailable ? `Base update ${a.updateAvailable.from} to ${a.updateAvailable.to}` : "Not returned"},
 {key:"versions",title:"Inspect",render:a=><Link to={`/app/admin/agents/${encodeURIComponent(a.agentId)}/versions${term ? "?q="+encodeURIComponent(term) : ""}`}>Versions for <VisibleText text={a.name} /></Link>},
 ]} />}</>;
 }}</ReadState><Guardrails /></section>;
}
