import { useEffect, useState, useSyncExternalStore } from "react";
import { AGENT_STEP_KINDS, CODING_STEP_KINDS, type RecipeOverlaySchema, type StepSpecSchema } from "@agentx/cloud-contracts/web";
import { ApiError } from "../../api/errors.js";
export type Overlay = ReturnType<typeof RecipeOverlaySchema.parse>;
export type Step = ReturnType<typeof StepSpecSchema.parse>;
type Snapshot = { overlay: Overlay; revision: number; status: "saved" | "unsaved" | "saving" | "error" | "conflict"; error?: string | undefined };
export class DraftState {
 private value: Snapshot; private listeners = new Set<()=>void>(); private timer?: ReturnType<typeof setTimeout>;private inFlight=false;private dirty=false;private ready=false;private stopped=false;
 constructor(overlay: Overlay,revision: number,private save: (overlay: Overlay,revision: number)=>Promise<{revision:number}>) { this.value={overlay,revision,status:"saved"}; }
 snapshot=()=>this.value;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private emit(patch: Partial<Snapshot>) {this.value={...this.value,...patch};for(const listener of this.listeners)listener();}
 edit(overlay: Overlay) {if(this.stopped)return;this.dirty=true;this.ready=false;this.emit({overlay,status:this.value.status==="conflict"?"conflict":"unsaved"});if(this.timer)clearTimeout(this.timer);if(this.value.status==="conflict")return;this.timer=setTimeout(()=>{this.ready=true;void this.flush();},800);}
 private async flush() {if(this.stopped||this.inFlight||!this.dirty||!this.ready||this.value.status==="conflict")return;this.inFlight=true;this.dirty=false;this.ready=false;const overlay=this.value.overlay;this.emit({status:"saving",error:undefined});
  try {const result=await this.save(overlay,this.value.revision);if(this.stopped)return;this.emit({revision:result.revision,status:this.dirty?"unsaved":"saved"});}
  catch(error) {if(this.stopped)return;this.dirty=true;this.ready=false;this.emit({status:error instanceof ApiError&&error.code==="AGENT_REVISION_CONFLICT"?"conflict":"error",error:error instanceof ApiError?error.message:"Couldn't save this draft. Your edits are still here."});}
  finally {this.inFlight=false;if(this.ready)void this.flush();}
 }
 retry=()=>{if(this.value.status!=="conflict"){this.ready=true;void this.flush();}};
 dispose(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.listeners.clear();}
}
export function useDraftState(initial: Overlay,revision: number,save:(overlay:Overlay,revision:number)=>Promise<{revision:number}>) {const [state]=useState(()=>new DraftState(initial,revision,save));useEffect(()=>()=>state.dispose(),[state]);return{...useSyncExternalStore(state.subscribe,state.snapshot,state.snapshot),edit:(overlay:Overlay)=>state.edit(overlay),retry:state.retry};}
export function allowedStepKinds(sequence: readonly Step[]) {return sequence.some(step=>(CODING_STEP_KINDS as readonly string[]).includes(step.kind))?[...CODING_STEP_KINDS]:[...AGENT_STEP_KINDS];}
export function moveStep(sequence: readonly Step[],active:string,over:string): Step[] {const from=sequence.findIndex(step=>step.id===active),to=sequence.findIndex(step=>step.id===over);if(from<0||to<0)return[...sequence];const next=[...sequence], [step]=next.splice(from,1);next.splice(to,0,step!);return next;}
export function removeStep(sequence: readonly Step[],id:string): Step[] {if(sequence.length<=1)throw new Error("An agent needs at least one step");return sequence.filter(step=>step.id!==id);}
