import { Link, useParams, useSearchParams } from "react-router";
import { AgentVersionsResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { DataTable } from "../../../design/DataTable.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { ReadState, useAdminRead } from "../projects/read.js";
const reader = { parse(value: unknown) { return { versions: AgentVersionsResponseReaderSchema.parse(value).versions.map(v=>({version:v.version,current:v.current,safety:v.safety,needsOwnerOk:v.needsOwnerOk})) }; } };
export function AgentVersionsScreen() {
 const { id="" } = useParams(), [params]=useSearchParams();
 const read = useAdminRead("agent-versions", id, `/v1/app/agents/${encodeURIComponent(id)}/versions`, reader);
 return <section><Link className="rv-admin-b1-link" to={`/app/admin/agents${params.size ? "?"+params.toString() : ""}`}>Back to agents</Link><PageHeader focusOnMount title="Agent versions" description="Read-only version evidence. A version listed here has not been adopted by this page." /><Link className="rv-admin-b1-link" to={`/app/agents/${encodeURIComponent(id)}`}>Open agent profile</Link><ReadState read={read} label="agent versions">{data=>data.versions.length === 0 ? <p>No versions were returned.</p> : <DataTable caption="Agent versions" rows={data.versions} rowKey={v=>String(v.version)} columns={[{key:"version",title:"Version",render:v=>v.version},{key:"current",title:"Current",render:v=>v.current === true ? "Current" : "Not marked current"},{key:"safety",title:"Comparison",render:v=>v.safety === "same_or_safer" ? "Same or safer" : v.safety === "less_safe" ? "Less safe" : v.safety === "current" ? "Current" : "Unknown"},{key:"approval",title:"Owner confirmation",render:v=>v.needsOwnerOk === true ? "Required" : v.needsOwnerOk === false ? "Not required by version evidence" : "Unknown"}]} />}</ReadState></section>;
}
