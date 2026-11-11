import { z } from "zod";
import { AgentIdSchema } from "./agent.js";
import { SessionIdSchema } from "./agent-sessions.js";
import { OrgRoleSchema } from "./org.js";
import { forwardReader } from "./forward-reader.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
const CountSchema = z.number().int().min(0);
export const AppTrialSchema = z.object({ state: z.enum(["locked", "unlocked", "github_used"]) }).strict();
export const NavAgentSchema = z.object({ agentId: AgentIdSchema, name: z.string().min(1) }).strict();
export const NavSessionSchema = z.object({ sessionId: SessionIdSchema, title: z.string().min(1) }).strict();
export const AppNavSchema = z.object({
 me: z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/u), name: z.string().min(1), orgRole: OrgRoleSchema, nameChosen: z.boolean().optional() }).strict(),
 org: z.object({ name: z.string().min(1), trial: AppTrialSchema.optional() }).strict(),
 homeCount: CountSchema,
 projects: z.array(z.object({ name: z.string().regex(AGENTX_NAME_PATTERN), agents: z.array(NavAgentSchema.extend({ running: CountSchema, needsYou: CountSchema })) }).strict()).max(50),
 shared: z.object({ agents: z.array(NavAgentSchema).max(20), sessions: z.array(NavSessionSchema).max(10) }).strict(),
 features: z.object({ localAgents: z.boolean(), usage: z.boolean(), admin: z.boolean(), chains: z.boolean(), notices: z.boolean(), describe: z.boolean(), /** UX5b: present (true) only where the install's script tokens switch `pt` is on. */ scriptTokens: z.literal(true).optional(), /** OWNER DECISION 18: present (true) only where the decision cards switch `dk` is on: the task page's plan panel and feedback view are there only then. */ decisionCards: z.literal(true).optional(), /** G-04: present (true) only where the standing instructions switch `si` is on: Settings > Company rules is there only then. */ companyRules: z.literal(true).optional() }).strict(),
 /** QA6-10: the release this deployment runs ("0.5.8"), from the deploy. Absent where the deploy does not say. */
 release: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u).optional(),
}).strict();
export type AppNav = z.infer<typeof AppNavSchema>;
export const AppNavReaderSchema = forwardReader(AppNavSchema);
export type ReadAppNav = z.output<typeof AppNavReaderSchema>;

// RULING Q18: existing POST /v1/app/org/leave response; this reader adds no server behavior.
export const LeaveOrganizationResponseSchema = z.object({ left: z.literal(true), orgClosed: z.boolean(), message: z.string() }).strict();
export const LeaveOrganizationResponseReaderSchema = forwardReader(LeaveOrganizationResponseSchema);
