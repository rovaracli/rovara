import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {createDeveloperTaskBroker,MAYA} from "../support/developer-task-broker.js";
const fallback={stage:"build",used:"anthropic/claude-sonnet-4",wanted:null,reasonCode:"DEFAULT_MODEL_UNAVAILABLE"};
it("projects only stored fallback history, empty for old tasks, and refuses corrupt history",async()=>{
 const h=await createDeveloperTaskBroker();const started=await h.dev(MAYA,"POST","/v1/dev/tasks",{requestId:randomUUID(),project:"payments",instructions:"Fix a bug",client:"test"});
 const task=started.body.task as {taskId:string;modelFallbacks?:unknown};expect(task.modelFallbacks).toEqual([]);
 const key={pk:`DEVTASK#${task.taskId}`,sk:"META"};const record=h.db.get(key)!;h.db.set({...record,modelFallbacks:[fallback]});
 const response=await h.dev(MAYA,"GET",`/v1/dev/tasks/${task.taskId}`);expect(response.status).toBe(200);expect((response.body.task as {modelFallbacks:unknown}).modelFallbacks).toEqual([fallback]);
 h.db.set({...record,modelFallbacks:[{...fallback,reasonCode:"PLANTED_PROVIDER_EXCEPTION"}]});
 const bad=await h.dev(MAYA,"GET",`/v1/dev/tasks/${task.taskId}`);expect(bad.status).toBe(503);expect(JSON.stringify(bad.body)).not.toContain("PLANTED_PROVIDER_EXCEPTION");
});
