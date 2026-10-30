// Member removal (v1.1), task 3: every place authority could outlive a removal, re-checked. A decision judged before the removal cannot commit after it, a removed person's
// sign-in is refused at once, and their GitHub link no longer counts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgMemberKey } from "@agentx/contracts";
import { createPendingChange, decideApproval, getAnyApproval, registerApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { linkGithubMember, memberForGithubUser } from "../../packages/broker/src/rovara-code/github-members.js";
import { HOUR, OWNER, SAM, T0, removalWorld } from "../support/member-removal-world.js";
import { ORG_A, OLA, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld } from "../support/rovara-code-merge-world.js";

describe("sign-in", () => {
  it("a removed person's cookie and CLI token are refused right after S0, before any mover has run", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(SAM, "Sam", "member");
    const cookie = w.session(SAM, T0 - HOUR);
    const token = w.session(SAM, T0 - HOUR);
    expect(await w.cookieWorks(cookie)).toBe(true);
    expect(await w.tokenWorks(SAM, token)).toBe(true);
    await w.remove(SAM);
    expect(w.lambda.calls).toEqual([]);
    expect(await w.cookieWorks(cookie)).toBe(false);
    expect(await w.tokenWorks(SAM, token)).toBe(false);
    // The role in the token is never trusted: an owner's claim from before the removal changes nothing.
    expect(await w.tokenWorks(SAM, token, "owner")).toBe(false);
    expect(await w.tokenWorks(OWNER, w.session(OWNER, T0), "owner")).toBe(true);
  });
});

describe("GitHub", () => {
  it("the removed person's GitHub account no longer counts as a member, and removal works with no link", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    await w.join("4".repeat(64), "Pat", "member");
    const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
    expect(await linkGithubMember(deps, w.orgId, SAM, "4711")).toBe("linked");
    expect(await memberForGithubUser(deps, w.orgId, "4711")).toBe(SAM);
    await w.remove(SAM);
    expect(await memberForGithubUser(deps, w.orgId, "4711")).toBeUndefined();
    await expect(w.remove("4".repeat(64))).resolves.toMatchObject({ state: expect.any(String) as string });
  });
});

describe("a decision across the removal (G6)", () => {
  async function pending() {
    const w = mergeWorld();
    registerApprovalSubjectHandler("agent_publish", async () => undefined);
    const record = await createPendingChange(w.deps, {
      orgId: ORG_A, requestId: randomUUID(), requestedBy: PRIYA,
      subject: { kind: "agent_publish", agentId: "agt_00000000000000000001", draftRevision: 1, digest: "d".repeat(64), expectedCurrentVersion: 1 },
      changes: ["Publishes a new version"], approvers: { kind: "ids", ids: [OLA] },
    } as never);
    const caller = { orgId: ORG_A, developerId: OLA, orgRole: "admin" as const };
    return { w, record, caller, body: { requestId: randomUUID(), decision: "APPROVE" } };
  }

  it("a click judged before the removal and committed after it is FORBIDDEN, and the approval stays pending", async () => {
    const { w, record, caller, body } = await pending();
    const realSend = w.db.send;
    w.db.send = async (command) => {
      // The decider is removed after the check read the world and before the claim commits.
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes(record.approvalId)) w.db.delete(orgMemberKey(ORG_A, OLA));
      return realSend(command);
    };
    await expect(decideApproval(w.deps, caller, record.approvalId, body)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getAnyApproval(w.deps, ORG_A, record.approvalId))!.status).toBe("PENDING");
  });

  it("a click committed before the removal stands", async () => {
    const { w, record, caller, body } = await pending();
    await decideApproval(w.deps, caller, record.approvalId, body);
    w.db.delete(orgMemberKey(ORG_A, OLA));
    expect((await getAnyApproval(w.deps, ORG_A, record.approvalId))!.status).not.toBe("PENDING");
  });
});
