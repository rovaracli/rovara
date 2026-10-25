import { AgentAccessLevelSchema, AgentIdSchema, atLeast } from "@agentx/contracts/web";
import type { ReadAgent } from "../../api/agents.js";
export function agentAllows(agent: ReadAgent, wanted: "view" | "use" | "edit" | "manage") { const access = AgentAccessLevelSchema.safeParse(agent.access);return AgentIdSchema.safeParse(agent.agentId).success && access.success && atLeast(access.data, wanted); }
