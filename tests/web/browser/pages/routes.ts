// The addresses the browser specs visit. The one place to change when a path moves.
export const ROUTES = {
  home: "/app",
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
 * Screens whose routes Rovara Code does not serve yet (contract v0, packages/contracts/src/code-contract-v0.ts: Live and the agent directory).
 * Each must show a "not available yet" state, never an endless spinner. When Code starts serving one, move it out of this list; the spec then
 * stops expecting the state for it.
 */
export const UNSERVED_SCREENS = [
  { name: "Live", path: "/app/live" },
  { name: "Agent directory", path: "/app/agents" },
] as const;
