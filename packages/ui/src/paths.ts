const segment = encodeURIComponent;
export const paths = {
 home: "/app", live: "/app/live", project: (name: string) => "/app/projects/" + segment(name), session: (id: string) => "/app/sessions/" + segment(id),
 directory: "/app/agents", agent: (id: string) => "/app/agents/" + segment(id), agentEdit: (id: string) => "/app/agents/" + segment(id) + "/edit", newAgent: "/app/agents/new",
 skills: "/app/skills", chains: "/app/chains", chain: (id: string) => "/app/chains/" + segment(id), onboard: "/app/onboard", welcome: "/app/welcome", signup: "/app/signup", signedOut: "/app/signed-out", usage: "/app/usage", account: "/app/account", trash: "/app/trash",
 admin: { home: "/app/admin", people: "/app/admin/people", github: "/app/admin/github", agents: "/app/admin/agents", sources: "/app/admin/sources", guardrails: "/app/admin/guardrails", audit: "/app/admin/audit", code: "/app/admin/code", connections: "/app/admin/connections", trackerPeople: "/app/admin/tracker-people" },
} as const;
