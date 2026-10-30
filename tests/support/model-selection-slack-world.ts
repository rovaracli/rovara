// Native signed-in maintainer and verified catalog fixtures for C53 Slack model writes.
import {STAGE_IDS,projectMemberKey} from "../../packages/contracts/src/index.js";
import {bedrockClaudeModelIds} from "../../packages/model-runtime/src/catalog.js";
import {developerIdForSlackUser} from "../../packages/broker/src/aws/admin-actions.js";
import {createDeveloperTaskBroker,seedMembership} from "./developer-task-broker.js";
import {capturingAuditDeps} from "./audit-capture.js";
import {TEST_ORG} from "./orgs.js";
export const SELECTION_MODELS=bedrockClaudeModelIds("us").slice(0,2).map(modelId=>({provider:"amazon-bedrock",modelId}));
export async function modelSelectionSlackWorld(userId="U0123456789"){
 const cap=capturingAuditDeps();
 const h=await createDeveloperTaskBroker({register:false,audit:cap,brokerExtra:{agents:{}}});
 const developerId=developerIdForSlackUser(userId);
 h.db.set({pk:`DEVELOPER#${developerId}`,sk:"META",developerId,provider:"slack",displayName:"Model editor",firstSignInAt:"x",lastSignInAt:"x",revoked:false});
 seedMembership(h.db,developerId);
 h.db.set({...projectMemberKey(TEST_ORG,developerId,"payments"),entityType:"MEMBERSHIP",role:"developer",ownerKey:developerId,projectName:"payments",projectRole:"maintainer",grantId:"model-editor"});
 h.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:Object.fromEntries(STAGE_IDS.map(stage=>[stage,{locked:true,thinkingLevel:null,model:SELECTION_MODELS[stage==="plan_check"||stage==="code_review"||stage==="security_review"?1:0]}]))});
 return {...h,cap,developerId};
}
