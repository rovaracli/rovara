// Read-only data boundary. A continuation is untrusted page selection, never save/start authority.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { AgentXNameSchema } from "./names.js";
import { GitBranchNameSchema } from "./git-branch.js";
export const WorkingBranchNameSchema = GitBranchNameSchema.refine(value => value !== "HEAD" && !value.startsWith("refs/"));
export const WorkingBranchCursorSchema = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
const lifecycle = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), config = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ProjectWorkingBranchPageBodySchema = z.object({ expectedOrgId: OrgIdSchema, expectedRevision: lifecycle, expectedProjectRevision: config, repository: AgentXNameSchema, cursor: WorkingBranchCursorSchema.optional() }).strict();
const facts = { branches: z.array(WorkingBranchNameSchema).max(100), page: z.number().int().min(1).max(1000), mayHaveMore: z.boolean(), omittedUnsupported: z.boolean() };
function pageProblems(value: {branches: string[]; mayHaveMore: boolean; omittedUnsupported: boolean}, context: z.RefinementCtx) {
  const count = value.branches.length;
  if (new Set(value.branches).size !== count || (count === 100 && (!value.mayHaveMore || value.omittedUnsupported)) || (value.mayHaveMore && !value.omittedUnsupported && count !== 100) || (!value.mayHaveMore && value.omittedUnsupported && count >= 99)) context.addIssue({ code: "custom", message: "Inconsistent branch page." });
}
export const WorkingBranchPageFactsSchema = z.object(facts).strict().superRefine(pageProblems);
export const ProjectWorkingBranchPageSchema = z.object({ orgId: OrgIdSchema, project: AgentXNameSchema, repository: AgentXNameSchema, repositoryFullName: z.string().max(140).regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/), expectedRevision: lifecycle, expectedProjectRevision: config, checkedAt: z.string().datetime(), ...facts, limitReached: z.boolean(), nextCursor: WorkingBranchCursorSchema.optional() }).strict().superRefine((value, context) => {
  pageProblems(value, context);
  const more = value.mayHaveMore && value.page < 1000;
  if (value.limitReached !== (value.mayHaveMore && value.page === 1000) || more !== (value.nextCursor !== undefined)) context.addIssue({ code: "custom", message: "Inconsistent branch continuation." });
});
export type ProjectWorkingBranchPage = z.infer<typeof ProjectWorkingBranchPageSchema>;
export type ProjectWorkingBranchPageBody = z.infer<typeof ProjectWorkingBranchPageBodySchema>;

// Transport envelope fields are discarded before browser caching; page checks remain strict.
export const ProjectWorkingBranchPageReaderSchema = ProjectWorkingBranchPageSchema.strip();

// A checked exact ref is point-in-time information, never save or task-start authority.
export const ProjectWorkingBranchPreviewBodySchema = z.object({ expectedOrgId: OrgIdSchema, expectedRevision: lifecycle, expectedProjectRevision: config, repository: AgentXNameSchema, branch: WorkingBranchNameSchema }).strict();
export const ProjectWorkingBranchPreviewSchema = z.object({ orgId: OrgIdSchema, project: AgentXNameSchema, repository: AgentXNameSchema, repositoryFullName: z.string().max(140).regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/), branch: WorkingBranchNameSchema, commit: z.string().regex(/^[a-f0-9]{40}$/), expectedRevision: lifecycle, expectedProjectRevision: config, checkedAt: z.string().datetime() }).strict();
export const ProjectWorkingBranchPreviewReaderSchema = ProjectWorkingBranchPreviewSchema.strip();
export type ProjectWorkingBranchPreview = z.infer<typeof ProjectWorkingBranchPreviewSchema>;
export type ProjectWorkingBranchPreviewBody = z.infer<typeof ProjectWorkingBranchPreviewBodySchema>;
