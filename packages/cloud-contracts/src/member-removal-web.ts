// Member removal (v1.1): the web contracts of the removal preview, start and status routes. Their own module, so the web bundle loads them with the lazy admin screens that
// use them, not at startup (packages/web/vite.config.ts, the initial JS budget).
import { z } from "zod";
import { OrgRoleSchema } from "./org.js";
import { forwardReader } from "@rovara-code/contracts";

const MemberRemovalPersonSchema = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().max(200) }).strict();
/** A bounded count: 1000 means "1000 or more". */
const RemovalCountSchema = z.number().int().min(0).max(1000);
const RemovalDutiesSchema = z.object({
  wasRole: OrgRoleSchema,
  /** The projects they hold a grant on. */
  projectGrants: RemovalCountSchema,
  /** The projects they are a maintainer of by grant: shown, never moved. */
  maintainerProjects: RemovalCountSchema,
  /** Invites they created that are still open (the first page of the invite list): shown, never revoked here. */
  invitesCreated: RemovalCountSchema,
  /** True when the invite list had more than the first page, so `invitesCreated` is "at least". */
  invitesCreatedAtLeast: z.boolean().optional(),
}).strict();

/** `GET /v1/app/org/members/{id}/removal-preview`: who is removed, who takes over, what moves to them, what ends and what is left for an admin. */
export const MemberRemovalPreviewSchema = z.object({
  member: MemberRemovalPersonSchema.extend({ role: OrgRoleSchema }).strict(),
  successor: MemberRemovalPersonSchema,
  moves: z.object({ agents: RemovalCountSchema, skills: RemovalCountSchema, chains: RemovalCountSchema, triggers: RemovalCountSchema, approvals: RemovalCountSchema, spendRequests: RemovalCountSchema }).strict(),
  ends: z.array(z.string().max(300)).max(20),
  duties: RemovalDutiesSchema,
  warnings: z.array(z.string().max(300)).max(10),
}).strict();
export const MemberRemovalPreviewReaderSchema = forwardReader(MemberRemovalPreviewSchema);

/** The body of `POST /v1/app/org/members/{id}/removal`: the request id is the receipt, `expectedRole` the role the screen showed, `successorId` who takes over (default: the person asking). */
export const MemberRemovalBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRole: OrgRoleSchema,
  successorId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type MemberRemovalBody = z.infer<typeof MemberRemovalBodySchema>;

/** `POST /v1/app/org/members/{id}/removal`. */
export const MemberRemovalStartedSchema = z.object({ removalId: z.string().uuid(), state: z.enum(["STARTED", "DONE", "CANCELLED_REJOINED"]), message: z.string().max(500) }).strict();
export const MemberRemovalStartedReaderSchema = forwardReader(MemberRemovalStartedSchema);

/** `GET /v1/app/org/removals/{removalId}`. */
export const MemberRemovalStatusSchema = z.object({
  removalId: z.string().uuid(), state: z.enum(["STARTED", "DONE", "CANCELLED_REJOINED"]), removedAt: z.string().datetime(),
  member: MemberRemovalPersonSchema.extend({ role: OrgRoleSchema }).strict(), successor: MemberRemovalPersonSchema.optional(), by: z.string().max(200),
  duties: RemovalDutiesSchema,
}).strict();
export const MemberRemovalStatusReaderSchema = forwardReader(MemberRemovalStatusSchema);
