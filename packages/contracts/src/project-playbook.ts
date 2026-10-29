// "How we work" (H2): a project's playbook document. It says which process the project runs: the built-in Rovara Code, or the project's own process layer (a project-owned custom
// agent that extends Rovara Code and is marked `purpose: "process"`). A project with no document runs the built-in. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { prefixedIdPattern } from "./agent.js";
import { forwardReader } from "./forward-reader.js";

/** A process layer is a custom agent, so a built-in agent's id is not one. */
const ProcessAgentIdSchema = z.string().regex(prefixedIdPattern("agt"));

export const DefaultProcessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin") }).strict(),
  z.object({ kind: z.literal("project_process"), agentId: ProcessAgentIdSchema }).strict(),
]);
export type DefaultProcess = z.infer<typeof DefaultProcessSchema>;

export const ProjectPlaybookSchema = z
  .object({
    revision: z.number().int().min(0),
    defaultProcess: DefaultProcessSchema,
  })
  .strict();
export type ProjectPlaybook = z.infer<typeof ProjectPlaybookSchema>;

/** What a project with no playbook document has. */
export const DEFAULT_PROJECT_PLAYBOOK: ProjectPlaybook = { revision: 0, defaultProcess: { kind: "builtin" } };

/** `PUT /v1/app/projects/{p}/playbook`: the revision the caller read and the default process to set. */
export const ProjectPlaybookBodySchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    defaultProcess: DefaultProcessSchema,
  })
  .strict();
export type ProjectPlaybookBody = z.infer<typeof ProjectPlaybookBodySchema>;

/** `GET` and an applied `PUT` of a project's playbook. */
export const ProjectPlaybookResponseSchema = z.object({ playbook: ProjectPlaybookSchema }).strict();
export type ProjectPlaybookResponse = z.infer<typeof ProjectPlaybookResponseSchema>;

/** How a client reads that answer: the gateway's `requestId` beside the fields is kept, not refused (as `CodeSettingsResponseReaderSchema`). */
export const ProjectPlaybookResponseReaderSchema = forwardReader(ProjectPlaybookResponseSchema);
export type ProjectPlaybookResponseRead = z.output<typeof ProjectPlaybookResponseReaderSchema>;

/** What PLAYBOOK_STALE (409) says: the playbook changed since the caller read it. */
export const PLAYBOOK_STALE_MESSAGE = "Someone changed how this project works. Reload and try again.";

/** What PROCESS_UNAVAILABLE (400) says, whatever the reason: the process can't be set, or can't run, in this project. The process is never named. */
export const PROCESS_UNAVAILABLE_MESSAGE = "This project's process isn't available. Check that it is published and not archived.";

/** What PROCESS_UNAVAILABLE (400) says when work is started: the person starting it is not necessarily a maintainer, so it says who can fix it and where. */
export const PROCESS_START_REFUSED_MESSAGE = "This project's way of working can't be used right now. A maintainer can fix it in How we work.";
