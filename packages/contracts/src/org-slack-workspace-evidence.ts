import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
/** One bounded observation of stored association pairs, never installation, permissions or live delivery verification. */
export const SLACK_WORKSPACE_EVIDENCE_LIMIT = 50;
export const OrgSlackWorkspaceEvidenceResponseSchema = z.object({
 orgId: OrgIdSchema, checkedAt: z.string().datetime(), kind: z.literal("stored_workspace_associations"),
 associationCount: z.number().int().min(0).max(SLACK_WORKSPACE_EVIDENCE_LIMIT), unavailableCount: z.number().int().min(0).max(SLACK_WORKSPACE_EVIDENCE_LIMIT),
 coverage: z.enum(["complete", "partial"]), verification: z.literal("unverified"),
}).strict().superRefine((value, context) => {
 if (value.associationCount + value.unavailableCount > SLACK_WORKSPACE_EVIDENCE_LIMIT || (value.unavailableCount > 0 && value.coverage !== "partial")) context.addIssue({code:"custom",message:"Stored workspace evidence coverage is invalid."});
});
export type OrgSlackWorkspaceEvidenceResponse = z.infer<typeof OrgSlackWorkspaceEvidenceResponseSchema>;
export const OrgSlackWorkspaceEvidenceResponseReaderSchema = OrgSlackWorkspaceEvidenceResponseSchema.strip();
