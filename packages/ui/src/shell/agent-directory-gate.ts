// The sidebar's "Agent directory" link opens /app/agents, which reads `/v1/app/agents` (Cloud's agent-directory-routes.ts, answered from Rovara Code's directory route).
// Owner decision (2026-11-17): only a company owner or administrator may read it, so the link is shown to them only (`Sidebar` checks `nav.me.orgRole`); a member who types the address gets the
// route's fixed refusal. `Sidebar` still takes `agentDirectoryOffered` so a test can hide the link, as the route's own answers would if Code stopped serving it.
export const AGENT_DIRECTORY_OFFERED = true;
