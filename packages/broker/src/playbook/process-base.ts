// "How we work" (final review C1): a project's process layer tunes Rovara Code, so it always builds on the built-in Rovara Code, at the version the company adopted. Any other base
// (another custom agent, a built-in that is not Rovara Code, or none) would let one person drop the plan check or put project-wide rules in front of the reviewers with no second person.
// The base is checked wherever it can be set or used: create, saving the draft, publishing (immediate and confirmed), updating the base, rolling back, and reading the layer as the
// project's process. Ordinary agents may build on what they like.
import { ROVARA_CODE_AGENT_ID, agentXError, type AgentId } from "@rovara-code/contracts";

export const PROCESS_BASE_MESSAGE = "How we work must build on Rovara Code.";

/** Refuses (CONFIG_INVALID, 400) a base other than Rovara Code when the agent is a process layer. `base` is an agent id or a pinned base; absent or `null` is no base. */
export function requireRovaraCodeBaseForProcess(agent: { purpose?: string | undefined }, base: AgentId | { agentId: AgentId } | null | undefined): void {
  if (agent.purpose !== "process") return;
  const agentId = typeof base === "string" ? base : base?.agentId;
  if (agentId !== ROVARA_CODE_AGENT_ID) throw agentXError("CONFIG_INVALID", PROCESS_BASE_MESSAGE);
}
