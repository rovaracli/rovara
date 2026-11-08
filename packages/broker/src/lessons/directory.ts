// Learning v2 wiring (LS-3): the approver directory the lessons library asks. Who may approve a project's lessons is the live company/project roster the second-person approvals already read
// (`org/second-person-evidence.ts readApproverRoster`): owners, admins and the project's maintainers whose identity and grant are live. An unreadable or incomplete roster is an answer of
// `complete: false`, which the library reads as "nobody may decide" (fail closed). A person's identity set for the ACL checks is their linked source accounts (a GitHub account, today).
import { OrgIdSchema, type OrgId } from "@agentx/contracts";
import { readApproverRoster, readApproverRosterFenced, type SecondPersonEvidenceDependencies } from "../org/second-person-evidence.js";
import type { ApproverDirectory } from "./ports.js";
import type { IdentitySet } from "./types.js";

export interface DirectoryInput {
  evidence: SecondPersonEvidenceDependencies;
  /** The source accounts a person has linked (ids by source), or undefined when none can be found. May throw: the identity is then empty. */
  linkedAccounts(orgId: OrgId, developerId: string): Promise<readonly string[]>;
  /** The member a (possibly merged-away) developer id stands for (follows `mergedInto`). May throw: the author rules then refuse. */
  resolveMember?(orgId: OrgId, developerId: string): Promise<string>;
}

const NOBODY = { complete: false, membershipVersion: 0, ownerIds: [] as string[], eligibleIds: [] as string[], lastEligibleLossAtMs: null };

export function createApproverDirectory(input: DirectoryInput): ApproverDirectory {
  const resolveMember = input.resolveMember?.bind(input);
  return {
    ...(resolveMember === undefined ? {} : {
      async resolveMember(workspaceId, developerId) {
        const org = OrgIdSchema.safeParse(workspaceId);
        if (!org.success) throw new Error("not a company id");
        return resolveMember(org.data, developerId);
      },
    }),
    async eligibility(workspaceId, project, who) {
      const org = OrgIdSchema.safeParse(workspaceId);
      if (!org.success) return NOBODY;
      try {
        if (who === undefined) return await readApproverRoster(input.evidence, { orgId: org.data, project });
        // For a named approver the answer carries the commit conditions that pin it (the membership generation, the approver's live checks, the project). A failed fenced read is NEVER answered with an unfenced roster.
        const { conditions, ...roster } = await readApproverRosterFenced(input.evidence, { orgId: org.data, project, approverId: who.approverId });
        return { ...roster, fence: conditions };
      } catch { return NOBODY; }
    },
    async identity(workspaceId, developerId): Promise<IdentitySet> {
      const org = OrgIdSchema.safeParse(workspaceId);
      // No identity is a person who matches no restricted place (fail closed).
      if (!org.success) return { principals: [], groups: [] };
      try { return { principals: [...await input.linkedAccounts(org.data, developerId)], groups: [], developerId }; } catch { return { principals: [], groups: [], developerId }; }
    },
  };
}
