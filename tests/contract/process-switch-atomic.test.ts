// "How we work" follow-up F2: the switch to the built-in is one decision. The check (nothing lost, or a second person confirmed) and the write are tied to the version of the layer that
// was compared, so a layer that publishes a new version in between makes the write fail as stale. Both the immediate and the confirmed write.
import { describe, expect, it } from "vitest";
import { getAnyApproval, getApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { OLA, ORG_A } from "../support/agent-session-world.js";
import { bumpLayerVersion, changedEvents, failure, intercepting, isPlaybookWrite, layerWith, playbook, playbookDeps, rawPlaybook, toBuiltin, world } from "../support/process-switch-world.js";

describe("the switch to the built-in is one decision (the layer's version is part of the write)", () => {
  it("a layer that published a new version between the check and the write makes the immediate write stale", async () => {
    const w = world();
    const layer = await layerWith(w);
    const before = rawPlaybook(w);
    const events = changedEvents(w).length;
    let bumped = 0;
    const racing = intercepting(w.db, (command) => { if (bumped === 0 && isPlaybookWrite(command)) { bumped += 1; bumpLayerVersion(w, layer); } });
    expect(await failure(toBuiltin(w, playbookDeps(w, racing)))).toMatchObject({ code: "PLAYBOOK_STALE", status: 409 });
    expect(bumped).toBe(1);
    expect(rawPlaybook(w)).toEqual(before);
    expect(changedEvents(w)).toHaveLength(events);
  });

  it("the same for the confirmed write", async () => {
    const w = world();
    const layer = await layerWith(w, true);
    const reply = await toBuiltin(w);
    const approvalId = w.approvalIdOf((reply.body as { confirmUrl: string }).confirmUrl);
    const record = { ...(await getAnyApproval(w.deps, ORG_A, approvalId))!, decidedBy: OLA };
    const before = rawPlaybook(w);
    let bumped = 0;
    const racing = intercepting(w.db, (command) => { if (bumped === 0 && isPlaybookWrite(command)) { bumped += 1; bumpLayerVersion(w, layer); } });
    const deps = { ...w.deps, documentClient: racing };
    expect(await failure(getApprovalSubjectHandler("playbook_default_process")!(deps, record))).toMatchObject({ code: "PLAYBOOK_STALE", status: 409 });
    expect(bumped).toBe(1);
    expect(rawPlaybook(w)).toEqual(before);
  });

  it("without a race both still write", async () => {
    const w = world();
    await layerWith(w);
    const expected = (await playbook(w)).revision;
    expect((await toBuiltin(w)).statusCode).toBe(200);
    expect(await playbook(w)).toEqual({ revision: expected + 1, defaultProcess: { kind: "builtin" } });
  });
});

