// What the agent sessions give the rest of the broker at start-up (Plan 5): the handlers that make a session follow a task's end and pause as they happen.
export { registerAgentSessionTaskHandlers, sessionTaskEndHandler, sessionTaskPauseHandler, unregisterAgentSessionTaskHandlers, type SessionTaskHandlerOptions } from "./task-handlers.js";
