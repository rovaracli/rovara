// The Jira organization admin key form (DV-1): what `POST /v1/app/org/jira-org-admin` takes and answers. Browser-safe (no Node import). The key and the organization id go in; only a fixed word comes back, and no
// call returns either of them. Both or neither: "set" needs both, "clear" takes neither.
import { z } from "zod";

const ConnectionId = z.string().regex(/^con_[a-z0-9]{20}$/u);

export const JiraOrgAdminMutationBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), requestId: z.string().uuid(), connectionId: ConnectionId, orgAdminKey: z.string().regex(/^[\x21-\x7e]{1,8192}$/u), atlassianOrgId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u) }).strict(),
  z.object({ action: z.literal("clear"), requestId: z.string().uuid(), connectionId: ConnectionId }).strict(),
]);
export type JiraOrgAdminMutationBody = z.infer<typeof JiraOrgAdminMutationBodySchema>;
export const JiraOrgAdminResultReaderSchema = z.object({ status: z.enum(["saved", "cleared"]) });
