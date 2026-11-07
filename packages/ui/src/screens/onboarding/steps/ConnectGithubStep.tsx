import { GithubConnectPanel } from "./GithubConnectPanel.js";
// RULING Q54: preserve linked-identity requirements. UX1: the step detects a missing GitHub link and offers "Link your GitHub account" in place. UX3: the
// whole flow now lives in GithubConnectPanel, which the Connections page uses too.
export function ConnectGithubStep({requested,refresh}:{requested:boolean;refresh:()=>void}){
 return <GithubConnectPanel requested={requested} refresh={refresh} returnTo="/app/onboard" title="Connect GitHub"/>;
}
