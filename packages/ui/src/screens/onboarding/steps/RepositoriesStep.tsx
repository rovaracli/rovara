import { RepositoryPicker } from "./RepositoryPicker.js";
import { MetaRepositoryStart } from "./MetaRepositoryStart.js";
type Installation={installationId:number;accountLogin:string};
/** Choose repositories (guided onboarding PR 10): the picker is the main path; starting from a meta repo stays an advanced option, off it. */
export function RepositoriesStep({installations,onCreated}:{installations:Installation[];onCreated:(name:string)=>void}){
 return <><h2>Choose repositories</h2><p>Pick the repositories Rovara should work on. You'll review their setup before any work begins.</p><RepositoryPicker onCreated={onCreated}/><details className="rv-onboarding-advanced"><summary>Advanced: start from a meta repo</summary><MetaRepositoryStart installations={installations} onCreated={onCreated}/></details></>;
}
