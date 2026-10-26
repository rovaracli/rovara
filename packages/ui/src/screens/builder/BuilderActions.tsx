import { useSearchParams } from "react-router";
import type { ReadAgentProfile } from "../../api/agents.js";
import { PublishDialog } from "./PublishDialog.js";
import { TestRunDialog } from "./TestRunDialog.js";
export function BuilderActions({profile,revision,saved,onPublished,onInvalid}:{profile:ReadAgentProfile;revision:number;saved:boolean;onPublished:()=>Promise<void>;onInvalid:()=>Promise<void>}){const[params]=useSearchParams();return <div className="rv-actions"><TestRunDialog agent={profile.agent} disabled={!saved} initialOpen={params.get("panel")==="test"||params.get("test")==="1"}/><PublishDialog agent={profile.agent} revision={revision} disabled={!saved} onPublished={onPublished} onInvalid={onInvalid}/></div>;}
