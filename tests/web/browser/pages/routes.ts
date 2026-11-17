// The addresses the browser specs visit. The one place to change when a path moves.
export const ROUTES = {
  home: "/app",
  /** Work, the split inbox (the route is still /app/live). */
  work: "/app/live",
  signedOut: "/app/signed-out",
  /** DEC 253z onboarding: no company yet, creating one, and the invite link's join page. */
  noCompany: "/app/no-company", createCompany: "/app/create-company", join: "/app/join", firstDay: "/app/onboard",
  /** Your account: name, appearance, confirmation email and passkeys. */
  account: "/app/account",
  /** The admin area (Hybrid 1, DEC 223): five groups in a sidebar. */
  admin: {
    home: "/app/admin", people: "/app/admin/people", invites: "/app/admin/invites", signInClients: "/app/admin/sign-in-clients", signInFactors: "/app/admin/sign-in-factors",
    spending: "/app/admin/money/budgets", settings: "/app/admin/settings", howWeWork: "/app/admin/how-we-work", projects: "/app/admin/projects", audit: "/app/admin/audit",
  },
  project: (name: string) => `/app/projects/${name}`,
  /** A project in the admin area: its details, Archive and Restore (guided onboarding PR 17). */
  adminProject: (name: string) => `/app/admin/projects/${name}`,
  session: (id: string) => `/app/sessions/${id}`,
  /** A well-formed session address that no one ever started. */
  unknownSession: "/app/sessions/ses_00000000000000000000",
} as const;

/** The project the pretend Code lists first for the person who signs in by default (Priya). */
export const PROJECT = "web";
export const PERSON = "Priya";

/**
 * Screens whose routes Rovara Code does not serve yet (contract v0, packages/contracts/src/code-contract-v0.ts: the agent directory). Work is served now
 * (the task list, plan, proof index and events), so it is not here; its own "not connected yet" state is covered in work.spec.ts.
 * Each must show a "not available yet" state, never an endless spinner. When Code starts serving one, move it out of this list; the spec then
 * stops expecting the state for it.
 */
export const UNSERVED_SCREENS = [
  { name: "Agent directory", path: "/app/agents" },
] as const;
