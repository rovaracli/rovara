// Learning v2 wiring (LS-3): the approver directory the lessons library asks. Who may approve a project's lessons is the live company/project roster the second-person approvals already read
// (`org/second-person-evidence.ts readApproverRoster`): owners, admins and the project's maintainers whose identity and grant are live. An unreadable or incomplete roster is an answer of
// `complete: false`, which the library reads as "nobody may decide" (fail closed). A person's identity set for the ACL checks is their linked source accounts (a GitHub account, today).
import { OrgIdSchema, type OrgId } from "@agentx/contracts";
import { readApproverRoster, type SecondPersonEvidenceDependencies } from "../org/second-person-evidence.js";
import type { ApproverDirectory } from "./ports.js";
import type { IdentitySet } from "./types.js";

export interface DirectoryInput {
  evidence: SecondPersonEvidenceDependencies;
  /** The source accounts a person has linked (ids by source), or undefined when none can be found. May throw: the identity is then empty. */
  linkedAccounts(orgId: OrgId, developerId: string): Promise<readonly string[]>;
}

const NOBODY = { complete: false, membershipVersion: 0, ownerIds: [] as string[], eligibleIds: [] as string[], lastEligibleLossAtMs: null };

export function createApproverDirectory(input: DirectoryInput): ApproverDirectory {
  return {
    async eligibility(workspaceId, project) {
      const org = OrgIdSchema.safeParse(workspaceId);
      if (!org.success) return NOBODY;
      try { return await readApproverRoster(input.evidence, { orgId: org.data, project }); } catch { return NOBODY; }
    },
    async identity(workspaceId, developerId): Promise<IdentitySet> {
      const org = OrgIdSchema.safeParse(workspaceId);
      // No identity is a person who matches no restricted place (fail closed).
      if (!org.success) return { principals: [], groups: [] };
      try { return { principals: [...await input.linkedAccounts(org.data, developerId)], groups: [] }; } catch { return { principals: [], groups: [] }; }
    },
  };
}
