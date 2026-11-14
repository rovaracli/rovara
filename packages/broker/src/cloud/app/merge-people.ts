// Convergence S0 WIRING: the merge core's `MergePeople` seam, answered from Cloud's member directory (lane A6's rules, the ones Cloud's own merge tracking reads today).
//
// Whose approval on GitHub counts toward a merge is Cloud's rule (rovara-code/approval.ts): the account must be linked to a member of the company, and a member who is
// not a writer (the Auditor) counts for nothing. The core reads the same facts through `MergePeople`. This is that seam over Cloud's own readers, so the core's tracking
// and Cloud's agree on who approved (the parity suite's CODE_MILESTONE#approved difference was this: the core's local people counted any write-access reviewer).
import type { MergePeople } from "@rovara-code/broker/core/merge";
import { githubUserOfMember, type GithubMemberDependencies } from "../../rovara-code/github-members.js";
import { taskOwnerKey } from "../../developer/task-records.js";
import { linkedAmong, nonWritersAmong } from "../../rovara-code/approval.js";

export function createCloudMergePeople(deps: GithubMemberDependencies): MergePeople {
  const accountOf = (orgId: string, personId: string) => githubUserOfMember(deps, orgId, personId);
  return {
    async requestersOf(orgId, task) {
      // The people who asked for the task: its creator, whoever started it, and whoever owns it now (rovara-code/approval.ts requesterIds, on the core's task shape).
      // A core task's `ownerId` is the task's owner KEY (a hash of its creator and its id, vendor core/task-flow/start.ts), not a person: it has no GitHub account, so keeping it would make every
      // requester list "unlinked" and no approval would ever count. The person behind it is the creator, already in the list. A task taken over carries the new owner's developer id, which stays.
      const ownerKey = task.creatorId === undefined || task.creatorId === "" ? undefined : taskOwnerKey(task.creatorId, task.taskId);
      const owner = task.ownerId === ownerKey ? undefined : task.ownerId;
      const people = [...new Set([task.creatorId, task.startedBy?.developerId, owner].filter((id): id is string => typeof id === "string" && id !== ""))];
      const accounts: string[] = [];
      for (const personId of people) {
        const account = await accountOf(orgId, personId);
        if (account === undefined) return "unlinked";
        accounts.push(account);
      }
      return accounts.length === 0 ? "unlinked" : [...new Set(accounts)];
    },
    linkedAmong: (orgId, hostUserIds) => linkedAmong(deps, orgId, hostUserIds),
    nonWritersAmong: (orgId, hostUserIds) => nonWritersAmong(deps, orgId, hostUserIds),
    hostAccountOf: (orgId, personId) => accountOf(orgId, personId),
    // A member links one GitHub account in Cloud (the link is one to one, rovara-code/github-members.ts).
    async hostAccountsOf(orgId, personId) {
      const account = await accountOf(orgId, personId);
      return account === undefined ? [] : [account];
    },
  };
}
