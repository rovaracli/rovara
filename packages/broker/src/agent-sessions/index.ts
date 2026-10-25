// What the agent sessions give the rest of the broker at start-up (Plan 5): the handlers that make a session follow a task's end and pause as they happen.
export { registerAgentSessionTaskHandlers, sessionTaskEndHandler, sessionTaskPauseHandler, unregisterAgentSessionTaskHandlers, type SessionTaskHandlerOptions } from "./task-handlers.js";
// Plan 5 Task 21: the sessions' part in the member lifecycle (a mover registered at start) and in closing an org.
export { clearOrgSessions, closeOrgSessions, onSessionMemberRemoved, onSessionMembersMerged, registerSessionMemberMover, type SessionLifecycleDeps } from "./lifecycle.js";
