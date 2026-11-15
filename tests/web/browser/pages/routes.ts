// The addresses the browser specs visit. The one place to change when a path moves.
export const ROUTES = {
  home: "/app",
  /** Work, the split inbox (the route is still /app/live). */
  work: "/app/live",
  signedOut: "/app/signed-out",
  project: (name: string) => `/app/projects/${name}`,
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
