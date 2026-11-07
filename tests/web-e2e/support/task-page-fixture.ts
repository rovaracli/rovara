import { createTaskWeb,type TaskDocumentView } from "../../../packages/broker/src/aws/task-web.js";
import { createTaskWebApi } from "../../../packages/broker/src/aws/task-web-api.js";
import { PlanDocumentSchema } from "@agentx/contracts";
const plan=PlanDocumentSchema.parse({schemaVersion:1,title:"Retry failed payments",why:[{text:"Customers should not have to retry a failed payment themselves.",author:"Priya"}],claims:[{id:"1",text:"Retry payment timeouts."},{id:"2",text:"Never charge a customer twice."}],notChanging:["Refunds stay the same."],risks:["A slow gateway may delay a retry."],decisions:[{id:"d1",claimId:"1",question:"How many times should a payment be retried?",options:[{id:"three",label:"Three times",consequence:"Most timeouts clear by the third try."},{id:"five",label:"Five times",consequence:"Customers wait longer."}],recommended:"three"}]});
import { FIXTURE_ORG,FIXTURE_DEVELOPER,FIXTURE_SESSION } from "../../web/support/fixtures.js";
export const TASK_PAGE_FIXTURE_ID="11111111-1111-4111-8111-111111111111";
export function taskPageFixture(origin:string){
 let approved=false,learning=false,remembered=false;
 const COMMENT_ID="22222222-2222-4222-8222-222222222222";
 const comment=()=>({id:COMMENT_ID,document:"plan" as const,version:1,target:{kind:"claim" as const,id:"1"},author:{kind:"person" as const,name:"Sam",owner:false,you:false},text:"Say three tries, not five.",createdAt:"2026-10-11T10:00:00.000Z",edited:false,deleted:false,sent:false,rev:1,...(learning?{learning:{remembered,...(remembered?{correctionId:"c1"}:{})}}:{})});
 const caller={orgId:FIXTURE_ORG,orgRole:"member" as const,developerId:FIXTURE_DEVELOPER,sessionId:FIXTURE_SESSION,amr:"cloud" as const,name:"Priya"};
 const authenticateSession=async(id:string)=>id===FIXTURE_SESSION?caller:undefined;
 const api=createTaskWebApi({origin,authenticateSession,taskState:async()=>({revision:approved?2:1,waiting:!approved,stage:approved?"Coding":"Coding plan",documents:[{anchor:"coding-plan",version:1}],commentSeq:0,canRead:true,canComment:true,canSuggest:false,canDecide:true,canAsk:false,canManagePeople:false,canTakeOwnership:false,...(learning?{canRemember:true as const}:{})}),listComments:async()=>({comments:learning?[comment()]:[],suggestions:[],...(learning?{canRemember:true as const}:{})}),taskPagePath:async()=>"/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa"});
 const web=createTaskWeb({authenticateSession,api,getTaskFreshness:async()=>({revision:approved?2:1,stage:approved?"Coding":"Coding plan"}),getTaskDocumentView:async()=>{
 const view:TaskDocumentView={taskId:TASK_PAGE_FIXTURE_ID,sessionId:"ses_aaaaaaaaaaaaaaaaaaaa",title:"Retry failed payments",status:approved?"Coding":"Waiting for your approval",nextStep:approved?"The approved plan is ready for coding.":"Review the coding plan.",path:"QUICK",stage:approved?"Coding":"Coding plan",revision:approved?2:1,role:"owner",access:{role:"owner",canComment:true,canSuggest:false,canDecide:true,canAsk:false},documents:[{kind:"coding plan",version:1,approved,current:true,format:"structured",plan}],waiting:{kind:"coding plan",version:1,artifactDigest:"f".repeat(64)},commentSeq:0,...(learning?{pageComments:[comment()],pageSuggestions:[]}:{}),checks:[],findings:[],pullRequests:[],history:[]};if(approved)delete view.waiting;return view;
 }});
 return {web,reset(){approved=false;learning=false;remembered=false;},learn(){learning=true;}};
}
