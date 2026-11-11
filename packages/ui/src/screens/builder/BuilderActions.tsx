import { Suspense } from "react";
import { useSearchParams } from "react-router";
import type { ReadAgentProfile } from "../../api/agents.js";
import { useAgentPublishOn } from "../agents/publish-flags.js";
import { AskToPublish } from "../agents/publish-lazy.js";
import { PublishDialog } from "./PublishDialog.js";
import { TestRunDialog } from "./TestRunDialog.js";
export function BuilderActions({profile,revision,saved,onPublished,onInvalid}:{profile:ReadAgentProfile;revision:number;saved:boolean;onPublished:()=>Promise<void>;onInvalid:()=>Promise<void>}){const[params]=useSearchParams(),publishOn=useAgentPublishOn();return <div className="rv-actions"><TestRunDialog agent={profile.agent} disabled={!saved} initialOpen={params.get("panel")==="test"||params.get("test")==="1"}/><PublishDialog agent={profile.agent} revision={revision} disabled={!saved} onPublished={onPublished} onInvalid={onInvalid}/>{publishOn&&<Suspense fallback={null}><AskToPublish profile={profile}/></Suspense>}</div>;}
