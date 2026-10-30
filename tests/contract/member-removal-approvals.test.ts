// Member removal (v1.1), task 4: the approvals that list the leaver. Only who may decide moves; the people who asked stay as they are; a successor removed in the middle is
// never written; after a rejoin the old listing is only dropped.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approverIndexKey, orgMemberKey } from "@agentx/contracts";
import { createPendingChange, getAnyApproval, registerApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { HOUR, OWNER, PAT, SAM, ANA, removalWorld } from "../support/member-removal-world.js";

const subject = { kind: "agent_publish", agentId: "agt_00000000000000000001", draftRevision: 1, digest: "d".repeat(64), expectedCurrentVersion: 1 };

type World = Awaited<ReturnType<typeof removalWorld>>;
async function pending(w: World, ids: string[], requestedBy: string) {
  registerApprovalSubjectHandler("agent_publish", async () => undefined);
  return createPendingChange({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, {
    orgId: w.orgId, requestId: randomUUID(), requestedBy, subject, changes: ["Publishes a new version"], approvers: { kind: "ids", ids },
  } as never);
}
const idsOf = async (w: World, approvalId: string) => ((await getAnyApproval(w.deps as never, w.orgId, approvalId as never))!.approvers as { ids: string[] }).ids;

describe("approvals that list the leaver", () => {
  it("swap the leaver for the chosen successor, and the leaver's own request keeps its requester", async () => {
    const w = await removalWorld();
    await w.join(ANA, "Ana", "admin");
    await w.join(SAM, "Sam", "member");
    const listed = await pending(w, [SAM, ANA], PAT);
    const own = await pending(w, [ANA], SAM);
    await w.remove(SAM, { successorId: OWNER });
    expect((await idsOf(w, listed.approvalId)).sort()).toEqual([ANA, OWNER].sort());
    expect(w.db.get(approverIndexKey(w.orgId, SAM, listed.approvalId))).toBeUndefined();
    expect(w.db.get(approverIndexKey(w.orgId, OWNER, listed.approvalId))).toBeDefined();
    // The leaver's own pending request is not closed and still names them as the one who asked.
    const kept = (await getAnyApproval(w.deps as never, w.orgId, own.approvalId as never))!;
    expect(kept).toMatchObject({ status: "PENDING", requestedBy: SAM });
    expect(await idsOf(w, own.approvalId)).toEqual([ANA]);
  });

  it("do not give the successor a vote on a request they asked for: the requester is still the requester", async () => {
    const w = await removalWorld();
    await w.join(SAM, "Sam", "member");
    const mine = await pending(w, [SAM], OWNER);
    await w.remove(SAM, { successorId: OWNER });
    const record = (await getAnyApproval(w.deps as never, w.orgId, mine.approvalId as never))!;
    expect(record).toMatchObject({ requestedBy: OWNER });
    expect(await idsOf(w, mine.approvalId)).toEqual([OWNER]);
  });

  it("after a rejoin the leaver's old listing is gone, nothing is handed over, and a listing made since stays", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(ANA, "Ana", "admin");
    await w.join(SAM, "Sam", "member");
    const old = await pending(w, [SAM, ANA], PAT);
    await w.remove(SAM, { successorId: OWNER });
    w.tick(HOUR);
    await w.join(SAM, "Sam", "member");
    w.tick(1000);
    const fresh = await pending(w, [SAM, ANA], PAT);
    w.tick(HOUR);
    await w.sweep();
    expect(await idsOf(w, old.approvalId)).toEqual([ANA]);
    expect(w.db.get(approverIndexKey(w.orgId, SAM, old.approvalId))).toBeUndefined();
    expect(w.db.get(approverIndexKey(w.orgId, OWNER, old.approvalId))).toBeUndefined();
    expect((await idsOf(w, fresh.approvalId)).sort()).toEqual([ANA, SAM].sort());
  });

  it("never write a successor who was removed in the middle: the move is refused and the next run reads the successor again", async () => {
    const w = await removalWorld({ movers: "sweep" });
    await w.join(ANA, "Ana", "owner");
    await w.join(SAM, "Sam", "member");
    const listed = await pending(w, [SAM], PAT);
    await w.remove(SAM, { successorId: ANA });
    const realSend = w.db.send;
    let armed = true;
    w.db.send = async (command) => {
      if (armed && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("moveRevision")) {
        armed = false;
        w.db.send = realSend;
        // Ana is removed (to the owner) after the mover chose her and before its transaction commits.
        await w.remove(ANA, { successorId: OWNER });
        w.db.send = async (next) => realSend(next);
      }
      return realSend(command);
    };
    w.tick(HOUR);
    expect(await w.sweep()).toMatchObject({ failed: 1 });
    expect(await idsOf(w, listed.approvalId)).toEqual([SAM]);
    expect(w.db.get(orgMemberKey(w.orgId, ANA))).toBeUndefined();
    w.tick(HOUR);
    expect(await w.sweep()).toMatchObject({ failed: 0 });
    // Ana left for the owner, so Sam's approvals end with the owner, who is a member, and nobody removed is named.
    expect(await idsOf(w, listed.approvalId)).toEqual([OWNER]);
  });
});
