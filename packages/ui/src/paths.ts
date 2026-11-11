const segment = encodeURIComponent;
export const paths = {
 home: "/app", live: "/app/live", work: "/app/work", projects: "/app/projects", project: (name: string) => "/app/projects/" + segment(name), session: (id: string) => "/app/sessions/" + segment(id),
 directory: "/app/agents", agent: (id: string) => "/app/agents/" + segment(id), agentEdit: (id: string) => "/app/agents/" + segment(id) + "/edit", newAgent: "/app/agents/new", agentRequests: "/app/agents/requests",
 skills: "/app/skills", onboard: "/app/onboard", welcome: "/app/welcome", signup: "/app/signup", signedOut: "/app/signed-out", usage: "/app/usage", account: "/app/account", trash: "/app/trash",
 admin: { home: "/app/admin", people: "/app/admin/people", agents: "/app/admin/agents", audit: "/app/admin/audit", connections: "/app/admin/connections", trackerPeople: "/app/admin/tracker-people", secondReview: "/app/admin/second-review" },
} as const;
