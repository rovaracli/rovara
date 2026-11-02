// The setup run's limits and the company's setup locks (sh-su-musts routes, switch `su` on the server: with it off every path is "not found" and the screens say nothing). A project maintainer reads and sets the project's
// limits; a company admin reads the locks, sets them, approves a loosening a DIFFERENT admin proposed, and repairs a locks row that does not read. The server decides who may and what a number means; this file sends and
// reads fixed shapes (zod here, not in the browser contract entry: nothing else in the app reads them). Every write is sent once from the browser session.
import { useMemo } from "react";
import { z } from "zod";
import { ProjectOverviewProjectSchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export const SETUP_LOCKS_PATH = "/v1/app/org/setup-agent/locks";
const NEVER = { retry: "never" } as const;
export const SETUP_LIMIT_NAMES = ["commands", "sameStepTries", "wallClockMin", "budgetCents", "hostAsks"] as const;
export type SetupLimitName = (typeof SETUP_LIMIT_NAMES)[number];

const count = z.number().int().min(0).max(1_000_000);
const FullLimits = z.object({ commands: count, sameStepTries: count, wallClockMin: count, budgetCents: count, hostAsks: count });
const LimitSetting = FullLimits.partial();
export type LimitSetting = z.infer<typeof LimitSetting>;
export type FullLimits = z.infer<typeof FullLimits>;

export const ProjectLimitsReader = z.object({ revision: count, limits: LimitSetting, companyLock: LimitSetting, effective: FullLimits, defaults: FullLimits, maxima: FullLimits });
export type ProjectLimits = z.infer<typeof ProjectLimitsReader>;

const LockState = z.object({ limits: LimitSetting, setupAgentOff: z.boolean(), devcontainerImages: z.array(z.string().max(300)).max(50).nullable(), noSoleOwnerException: z.boolean() });
const Readable = LockState.extend({
  revision: count.nullable(), defaults: FullLimits, maxima: FullLimits,
  pending: LockState.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/u), proposedAt: z.string().max(40), byYou: z.boolean() }).optional(),
});
const Unreadable = z.object({ unreadable: z.literal(true), revision: count.nullable(), message: z.string().max(1_000) });
export const CompanyLocksReader = z.union([Unreadable, Readable]);
export type CompanyLocks = z.infer<typeof CompanyLocksReader>;
export type ReadableLocks = z.infer<typeof Readable>;
export const isUnreadable = (locks: CompanyLocks): locks is z.infer<typeof Unreadable> => "unreadable" in locks;
const Written = z.object({ status: z.string().max(40) }).passthrough();

const projectBase = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/setup-agent/limits";

export function createSetupLimitsApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  project: (project: string) => api.get(projectBase(project), ProjectLimitsReader),
  /** Sets the project's own limits (any subset; none removes them) against the revision the person saw. A fresh browser session is the only caller the server accepts. */
  setProject: (project: string, input: { requestId: string; expectedRevision: number; limits: LimitSetting }) => api.sendAnswer("PUT", projectBase(project), input, ProjectLimitsReader, NEVER),
  locks: () => api.get(SETUP_LOCKS_PATH, CompanyLocksReader),
  /** Only what is given changes. A stricter change applies at once (200); a loosening waits for a different admin (202, `needs_second_admin`). */
  setLocks: (input: { requestId: string; expectedRevision: number | null; limits?: LimitSetting; setupAgentOff?: boolean }) => api.sendAnswer("PUT", SETUP_LOCKS_PATH, input, Written, NEVER),
  /** A DIFFERENT admin approves exactly the revision and digest they saw; the server asks for a sign-in within the last 10 minutes (`REAUTH_REQUIRED`). */
  approve: (input: { requestId: string; expectedRevision: number; expectedDigest: string }) => api.sendAnswer("POST", SETUP_LOCKS_PATH + "/approve", input, Written, NEVER),
  repair: (input: { requestId: string; expectedRevision: number | null }) => api.sendAnswer("POST", SETUP_LOCKS_PATH + "/repair", input, Written, NEVER),
 };
}
export function useSetupLimitsApi() { const host = useAppHost();return useMemo(() => createSetupLimitsApi(host), [host]); }
export const setupLimitsKey = (project: string) => ["setup-limits", project] as const;
export const setupLocksKey = ["setup-limits", "company-locks"] as const;
