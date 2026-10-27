// "How we work" (S1): a task that runs a project's process layer is a Rovara Code task: the layer extends Rovara Code and only adds the project's rules. The places that treat
// "Rovara Code" and "another agent's run" differently (the hand-off to a Mac, the paused-task gate, the budget floor of a retry or a take-over) ask here, so a project with a
// process layer keeps what Rovara Code has.
import { ROVARA_CODE_AGENT_ID } from "@agentx/contracts";

/** The part of an agent reference these questions read; the task record's `agent` and a session's agent both fit (a session's has no `process` mark). */
export interface AgentMark {
  agentId: string;
  /** False for a custom agent (which can be named "rovara-code" and is not Rovara Code); absent where the reference does not say (a session's agent). */
  builtin?: boolean | undefined;
  /** Set when the agent is a project's process layer (`TaskAgentRef.process`). */
  process?: true | undefined;
}

/** Whether the agent is Rovara Code, or the project's process layer on top of it. */
export const isRovaraCodeAgent = (agent: AgentMark): boolean => (agent.agentId === ROVARA_CODE_AGENT_ID && agent.builtin !== false) || agent.process === true;

/** Whether the task is a Rovara Code task: one with no agent on the record (as before agents), Rovara Code itself, or a process layer. Any other agent's run is an agent-step run. */
export const isRovaraCodeTask = (task: { agent?: AgentMark | undefined }): boolean => task.agent === undefined || isRovaraCodeAgent(task.agent);
