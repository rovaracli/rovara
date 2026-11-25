import { describe, expect, it } from "vitest";
import { StageError } from "../../ops/pipeline/types.ts";
import { countRows, discardChangeSets, executeRecorded, previewChangeSets, tidyChangeSets, verifyRecorded } from "../../ops/pipeline/lib/changesets.ts";
import { startReleaseCheck, baseUrlFromOutputs } from "../../ops/pipeline/lib/releasecheck.ts";
import { canonicalSha256 } from "../../ops/pipeline/lib/hash.ts";
import { CDK_METADATA, EXEC8, MODIFY_FUNCTION, liveStack, makePorts, newState, row, stackFor } from "./pipeline-stage-fakes.ts";

const NAME = `rovara-pipeline-${EXEC8}`;
const stacks = [{ part: "app" as const, stack: stackFor("beta", "app"), stackId: "RovaraCloudApp" }, { part: "web" as const, stack: stackFor("beta", "web"), stackId: "RovaraCloudWeb" }];
const preview = (state: ReturnType<typeof newState>) => previewChangeSets({ ports: makePorts(state), dir: "/c", changeSetName: NAME, stacks, context: { a: "1" }, parameters: { CodeUrl: "https://x.example.test" }, log: () => {} });

describe("pipeline stage CLI: change sets by name", () => {
  it("canonical hashing ignores key order", () => {
    expect(canonicalSha256({ a: 1, b: { c: 2, d: [1, { y: 1, x: 2 }] } })).toBe(canonicalSha256({ b: { d: [1, { x: 2, y: 1 }], c: 2 }, a: 1 }));
    expect(canonicalSha256({ a: 1 })).not.toBe(canonicalSha256({ a: 2 }));
  });

  it("counts rows; a Conditional replacement counts as a replacement", () => {
    expect(countRows([row("Add", "A", "T"), MODIFY_FUNCTION, row("Remove", "B", "T"), row("Modify", "C", "T", "Conditional"), row("Modify", "D", "T", "True")])).toEqual({ add: 1, modify: 3, remove: 1, replace: 2 });
  });

  it("previews one change set per stack under the execution's name, recording names and counts only", async () => {
    const state = newState({ plan: { RovaraCloudApp: [CDK_METADATA], RovaraCloudWeb: [MODIFY_FUNCTION, row("Add", "NewTable", "AWS::DynamoDB::Table")] } });
    const records = await preview(state);
    expect(records.map((r) => [r.part, r.noChanges, r.changeSetName])).toEqual([["app", false, NAME], ["web", false, NAME]]);
    expect(records[1]!.counts).toEqual({ add: 1, modify: 1, remove: 0, replace: 0 });
    expect(records[1]!.templateSha256).not.toBeNull();
    expect(JSON.stringify(records)).not.toContain("Properties");
    expect(state.calls.find((c) => c.startsWith("cdk "))).toBe("cdk RovaraCloudApp,RovaraCloudWeb rovara-pipeline-1a2b3c4d ctx=a params=rovara-cloud-beta-app:CodeUrl=https://x.example.test,rovara-cloud-beta-web:CodeUrl=https://x.example.test");
  });

  it("records a stack cdk made no change set for as noChanges, and CloudFormation's own no-changes answer too", async () => {
    const state = newState({ plan: { RovaraCloudApp: null, RovaraCloudWeb: [MODIFY_FUNCTION] } });
    state.changeSets[`${stackFor("beta", "app")}/${NAME}`] = { id: "x", status: "FAILED", executionStatus: "UNAVAILABLE", statusReason: "The submitted information didn't contain changes. Submit different information to create a change set.", rows: [], template: "" };
    const records = await preview(state);
    expect(records[0]).toMatchObject({ part: "app", noChanges: true, changeSetId: null });
    expect(records[1]!.noChanges).toBe(false);
  });

  it("treats a change set that is ABSENT after a successful cdk call as a mismatch, never as no changes", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION] } }); // cdk "made" nothing for the web stack
    await expect(preview(state)).rejects.toMatchObject({ exitName: "CHANGE_SET_MISMATCH" });
    await expect(preview(state)).rejects.toThrow(/does not exist/);
  });

  it("refuses a change set that failed for another reason", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    const ports = makePorts(state);
    const original = ports.cdk.deployNoExecute.bind(ports.cdk);
    ports.cdk.deployNoExecute = async (a) => { await original(a); state.changeSets[`${stackFor("beta", "app")}/${NAME}`]!.status = "FAILED"; state.changeSets[`${stackFor("beta", "app")}/${NAME}`]!.statusReason = "Parameter validation"; };
    await expect(previewChangeSets({ ports, dir: "/c", changeSetName: NAME, stacks, context: {}, parameters: {}, log: () => {} })).rejects.toMatchObject({ exitName: "CHANGE_SET_MISMATCH" });
    expect(Object.keys(state.changeSets)).toEqual([]); // the failed preview left nothing behind
  });

  it("a cdk call that fails after making a change set (the incident: a dependency stack refused a parameter) deletes the change sets of its stacks, and the error stays", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    const ports = makePorts(state);
    const original = ports.cdk.deployNoExecute.bind(ports.cdk);
    ports.cdk.deployNoExecute = async (a) => { await original(a); throw new StageError("FAILED", "cdk deploy --no-execute failed (exit 1): Parameters: [ImageDigest] do not exist in the template"); };
    await expect(previewChangeSets({ ports, dir: "/c", changeSetName: NAME, stacks, context: {}, parameters: {}, log: () => {} })).rejects.toThrow(/do not exist in the template/);
    expect(Object.keys(state.changeSets)).toEqual([]);
    expect(state.calls.filter((c) => c.startsWith("cfn delete")).sort()).toEqual([`cfn delete ${stackFor("beta", "app")} ${NAME}`, `cfn delete ${stackFor("beta", "web")} ${NAME}`]);
  });

  it("discarding leaves an executed change set, other names and absent ones alone, and never throws", async () => {
    const state = newState();
    const s = stackFor("beta", "web");
    const cs = (name: string, executionStatus: string) => { state.changeSets[`${s}/${name}`] = { id: name, status: "CREATE_COMPLETE", executionStatus, statusReason: null, rows: [], template: "" }; };
    cs(NAME, "EXECUTE_COMPLETE"); cs("rovara-pipeline-other0000", "AVAILABLE");
    await discardChangeSets(makePorts(state), [s, stackFor("beta", "app")], NAME, () => {});
    expect(Object.keys(state.changeSets).sort()).toEqual([`${s}/${NAME}`, `${s}/rovara-pipeline-other0000`]);
    const ports = makePorts(state);
    ports.cfn.describeChangeSet = () => Promise.reject(new Error("throttled"));
    await expect(discardChangeSets(ports, [s], NAME, () => {})).resolves.toBeUndefined();
  });

  it("executes by name, in order, one stack at a time, and records the final status", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const records = await preview(state);
    const done = await executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} });
    expect(state.calls.filter((c) => c.startsWith("cfn execute"))).toEqual([`cfn execute ${stackFor("beta", "app")} ${NAME}`, `cfn execute ${stackFor("beta", "web")} ${NAME}`]);
    expect(done.map((r) => r.finalStatus)).toEqual(["UPDATE_COMPLETE", "UPDATE_COMPLETE"]);
    expect(done[0]!.executedAt).not.toBeNull();
  });

  it("does not execute anything for a stack with no changes", async () => {
    const state = newState({ plan: { RovaraCloudApp: null, RovaraCloudWeb: null } });
    const records = await preview(state);
    await executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} });
    expect(state.calls.some((c) => c.startsWith("cfn execute"))).toBe(false);
  });

  it("refuses a change set that was replaced after the preview (different id) or whose template changed", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const [app] = await preview(state);
    state.changeSets[`${app!.stack}/${NAME}`]!.id = "another-id";
    await expect(verifyRecorded(makePorts(state), app!)).rejects.toThrow(/different id/);
    const again = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    const [app2] = await preview(again);
    again.changeSets[`${app2!.stack}/${NAME}`]!.template = "edited";
    await expect(verifyRecorded(makePorts(again), app2!)).rejects.toThrow(/template is not the one previewed/);
    expect(again.calls.some((c) => c.startsWith("cfn execute"))).toBe(false);
  });

  it("refuses a missing, unavailable or obsolete change set, and an unsettled stack", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const [app] = await preview(state);
    state.changeSets[`${app!.stack}/${NAME}`]!.executionStatus = "OBSOLETE";
    await expect(verifyRecorded(makePorts(state), app!)).rejects.toThrow(/not available/);
    delete state.changeSets[`${app!.stack}/${NAME}`];
    await expect(verifyRecorded(makePorts(state), app!)).rejects.toThrow(/cannot be read/);
    const busy = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    liveStack(busy, stackFor("beta", "app"), { status: "UPDATE_IN_PROGRESS" });
    liveStack(busy, stackFor("beta", "web"));
    const recs = await preview(busy);
    await expect(executeRecorded({ ports: makePorts(busy), records: recs, settleTimeoutSeconds: 1, log: () => {} })).rejects.toMatchObject({ exitName: "REFUSED" });
    expect(busy.calls.some((c) => c.startsWith("cfn execute"))).toBe(false);
  });

  it("fails the run when a stack ends rolled back, and stops before the next stack", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] }, executeOutcome: { [stackFor("beta", "app")]: "UPDATE_ROLLBACK_COMPLETE" } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const records = await preview(state);
    await expect(executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} })).rejects.toMatchObject({ exitName: "DEPLOY_FAILED" });
    expect(state.calls.filter((c) => c.startsWith("cfn execute"))).toHaveLength(1);
  });

  it("detects another change set having run instead of the recorded one: the stack's last change set is checked after the execute, not the change set by name", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const records = await preview(state);
    state.onExecute = (stack) => { state.stacks[stack]!.changeSetId = "arn:aws:cloudformation:us-east-1:x:changeSet/someone-else/1"; };
    await expect(executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {}, })).rejects.toThrow(/not the recorded change set/);
  });

  it("a retried action (the stack already ran the recorded change set; CloudFormation deleted the change set) waits for the stack instead of executing again", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const records = await preview(state);
    await makePorts(state).cfn.executeChangeSet(records[0]!.stack, NAME); // an earlier invocation executed the app stack's change set, then stopped
    state.calls.length = 0;
    const done = await executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} });
    expect(state.calls.filter((c) => c.startsWith("cfn execute"))).toEqual([`cfn execute ${records[1]!.stack} ${NAME}`]);
    expect(done.map((r) => r.finalStatus)).toEqual(["UPDATE_COMPLETE", "UPDATE_COMPLETE"]);
  });

  it("a change set that is gone is never accepted without the stack proving it ran that very change set", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const records = await preview(state);
    delete state.changeSets[`${records[0]!.stack}/${NAME}`]; // deleted by someone, never executed: the stack still points at an earlier change set
    await expect(executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} })).rejects.toThrow(/cannot be read/);
    state.stacks[records[0]!.stack]!.changeSetId = "arn:aws:cloudformation:us-east-1:x:changeSet/another/1";
    await expect(executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} })).rejects.toThrow(/cannot be read/);
  });

  it("tidy also leaves another execution's change set that is still being created or is executing", async () => {
    const state = newState();
    const s = stackFor("beta", "web");
    const cs = (name: string, status: string, executionStatus: string) => { state.changeSets[`${s}/${name}`] = { id: name, status, executionStatus, statusReason: null, rows: [], template: "" }; };
    cs("rovara-pipeline-creating0", "CREATE_IN_PROGRESS", "UNAVAILABLE"); cs("rovara-pipeline-pending00", "CREATE_PENDING", "UNAVAILABLE"); cs("rovara-pipeline-running00", "CREATE_COMPLETE", "EXECUTE_IN_PROGRESS"); cs("rovara-pipeline-failed000", "FAILED", "UNAVAILABLE");
    await tidyChangeSets(makePorts(state), [s], NAME, () => {});
    expect(Object.keys(state.changeSets).sort()).toEqual([`${s}/rovara-pipeline-creating0`, `${s}/rovara-pipeline-pending00`, `${s}/rovara-pipeline-running00`]);
  });

  it("tidies this run's change sets and unusable older ones, and leaves an AVAILABLE one of a newer execution", async () => {
    const state = newState();
    const s = stackFor("beta", "web");
    const cs = (name: string, executionStatus: string) => { state.changeSets[`${s}/${name}`] = { id: name, status: "CREATE_COMPLETE", executionStatus, statusReason: null, rows: [], template: "" }; };
    cs(NAME, "EXECUTE_COMPLETE"); cs("rovara-pipeline-older000", "OBSOLETE"); cs("rovara-pipeline-newer000", "AVAILABLE"); cs("hand-made", "AVAILABLE");
    await tidyChangeSets(makePorts(state), [s], NAME, () => {});
    expect(Object.keys(state.changeSets).sort()).toEqual([`${s}/hand-made`, `${s}/rovara-pipeline-newer000`]);
  });
});

describe("pipeline stage CLI: the execute is verified by the stack (the beta adoption incident: CloudFormation deletes a stack's change sets once one executes)", () => {
  const gatewayStack = stackFor("beta", "gateway");
  const gatewayPlan = { RovaraModelGateway: [] as ReturnType<typeof row>[] }; // +0 ~0 -0: only a new output, so CloudFormation still creates a CREATE_COMPLETE change set
  const previewGateway = (state: ReturnType<typeof newState>) => previewChangeSets({ ports: makePorts(state), dir: "/c", changeSetName: NAME, stacks: [{ part: "gateway", stack: gatewayStack, stackId: "RovaraModelGateway" }], context: {}, parameters: { ImageDigest: "sha256:x" }, log: () => {} });
  const world = (over: Partial<ReturnType<typeof newState>> = {}) => { const state = newState({ plan: gatewayPlan, ...over }); liveStack(state, gatewayStack); return state; };
  const run = (state: ReturnType<typeof newState>, records: Awaited<ReturnType<typeof previewGateway>>) => executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} });

  it("the fake behaves like CloudFormation: an execute deletes every change set of that stack (the executed one too), leaves other stacks' alone, and the stack remembers the id", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const records = await preview(state);
    state.changeSets[`${records[0]!.stack}/rovara-pipeline-other0000`] = { id: "other", status: "CREATE_COMPLETE", executionStatus: "AVAILABLE", statusReason: null, rows: [], template: "" };
    await makePorts(state).cfn.executeChangeSet(records[0]!.stack, NAME);
    expect(Object.keys(state.changeSets)).toEqual([`${records[1]!.stack}/${NAME}`]);
    expect(await makePorts(state).cfn.describeChangeSet(records[0]!.stack, NAME)).toBeNull();
    expect(state.stacks[records[0]!.stack]!.changeSetId).toBe(records[0]!.changeSetId);
  });

  it("the fake refuses to execute a change set that is not there or not executable", async () => {
    const state = world();
    await expect(makePorts(state).cfn.executeChangeSet(gatewayStack, NAME)).rejects.toThrow(/ChangeSetNotFound/);
    const [record] = await previewGateway(state);
    state.changeSets[`${gatewayStack}/${NAME}`]!.executionStatus = "OBSOLETE";
    await expect(makePorts(state).cfn.executeChangeSet(gatewayStack, NAME)).rejects.toThrow(/InvalidChangeSetStatus/);
    expect(record!.changeSetId).not.toBeNull();
  });

  it("INCIDENT SHAPE: an empty-looking change set executes, the change set is gone afterwards, and the run passes because the STACK says it ran the recorded change set", async () => {
    const state = world();
    const [record] = await previewGateway(state);
    expect(record).toMatchObject({ noChanges: false, status: "CREATE_COMPLETE", counts: { add: 0, modify: 0, remove: 0, replace: 0 } });
    const [done] = await run(state, [record!]);
    expect(done).toMatchObject({ finalStatus: "UPDATE_COMPLETE" });
    expect(done!.executedAt).not.toBeNull();
    expect(Object.keys(state.changeSets)).toEqual([]);
    expect(state.stacks[gatewayStack]!.changeSetId).toBe(record!.changeSetId);
  });

  it("refuses when the stack's last change set is not the recorded one (another change set ran)", async () => {
    const state = world();
    const [record] = await previewGateway(state);
    state.onExecute = () => { state.stacks[gatewayStack]!.changeSetId = "arn:aws:cloudformation:us-east-1:x:changeSet/someone-else/1"; };
    await expect(run(state, [record!])).rejects.toMatchObject({ exitName: "CHANGE_SET_MISMATCH" });
  });

  it("refuses a stack that has no change set at all after the execute", async () => {
    const state = world();
    const [record] = await previewGateway(state);
    state.onExecute = () => { state.stacks[gatewayStack]!.changeSetId = null; };
    await expect(run(state, [record!])).rejects.toThrow(/last change set is none/);
  });

  it.each(["UPDATE_ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_FAILED", "UPDATE_FAILED", "ROLLBACK_COMPLETE", "CREATE_FAILED", "DELETE_COMPLETE", "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_IN_PROGRESS"])("refuses a stack that ends as %s", async (status) => {
    const state = world({ executeOutcome: { [gatewayStack]: status } });
    const [record] = await previewGateway(state);
    await expect(run(state, [record!])).rejects.toMatchObject({ exitName: "DEPLOY_FAILED" });
  });

  it("refuses a stack that was not updated since the execute started, but allows a small clock difference", async () => {
    const stale = world();
    const [record] = await previewGateway(stale);
    stale.onExecute = () => { stale.stacks[gatewayStack]!.lastUpdatedTime = new Date(stale.now - 10 * 60_000).toISOString(); };
    await expect(run(stale, [record!])).rejects.toThrow(/not updated since the execute started/);
    const skewed = world();
    const [again] = await previewGateway(skewed);
    skewed.onExecute = () => { skewed.stacks[gatewayStack]!.lastUpdatedTime = new Date(skewed.now - 60_000).toISOString(); };
    await expect(run(skewed, [again!])).resolves.toHaveLength(1);
    const never = world();
    const [third] = await previewGateway(never);
    never.onExecute = () => { never.stacks[gatewayStack]!.lastUpdatedTime = null; };
    await expect(run(never, [third!])).rejects.toThrow(/never updated/);
  });

  it("waits while describe-stacks still shows the stack as it was (eventual consistency right after the execute), and gives up when it never changes", async () => {
    const lagging = world({ executeLag: { [gatewayStack]: 3 } });
    const [record] = await previewGateway(lagging);
    const before = lagging.now;
    await expect(run(lagging, [record!])).resolves.toHaveLength(1);
    expect(lagging.now).toBeGreaterThan(before); // it slept between reads
    const forever = world({ executeLag: { [gatewayStack]: 100_000 } });
    const [stuck] = await previewGateway(forever);
    await expect(run(forever, [stuck!])).rejects.toMatchObject({ exitName: "CHANGE_SET_MISMATCH" });
  });

  it("a stack still IN_PROGRESS beyond the wait is a failed deploy (the port's wait gives up)", async () => {
    const state = world();
    const [record] = await previewGateway(state);
    const ports = makePorts(state);
    ports.cfn.waitSettled = () => Promise.reject(new StageError("DEPLOY_FAILED", "rovara-cloud-beta-gateway is still UPDATE_IN_PROGRESS after 1 s"));
    await expect(executeRecorded({ ports, records: [record!], settleTimeoutSeconds: 1, log: () => {} })).rejects.toMatchObject({ exitName: "DEPLOY_FAILED" });
  });

  it("the by-name check still guards the moment BEFORE the execute (different id, changed template)", async () => {
    const state = world();
    const [record] = await previewGateway(state);
    state.changeSets[`${gatewayStack}/${NAME}`]!.id = "swapped-before-execute";
    await expect(run(state, [record!])).rejects.toThrow(/different id/);
    expect(state.calls.some((c) => c.startsWith("cfn execute"))).toBe(false);
  });
});

describe("pipeline stage CLI: other real CloudFormation behaviour the stage CLI must handle", () => {
  const web = stackFor("beta", "web");
  const webPlan = { RovaraCloudWeb: [row("Add", "Fn", "AWS::Lambda::Function")] };
  const previewWeb = (state: ReturnType<typeof newState>, ports = makePorts(state)) => previewChangeSets({ ports, dir: "/c", changeSetName: NAME, stacks: [{ part: "web", stack: web, stackId: "RovaraCloudWeb" }], context: {}, parameters: {}, log: () => {} });

  it("the first deploy of a stack: cdk leaves a REVIEW_IN_PROGRESS shell holding the change set, it is executed, and the stack ends CREATE_COMPLETE (a created stack has no LastUpdatedTime)", async () => {
    const state = newState({ plan: webPlan });
    const [record] = await previewWeb(state);
    expect(state.stacks[web]!.status).toBe("REVIEW_IN_PROGRESS");
    const [done] = await executeRecorded({ ports: makePorts(state), records: [record!], settleTimeoutSeconds: 60, log: () => {} });
    expect(done).toMatchObject({ finalStatus: "CREATE_COMPLETE" });
    expect(state.stacks[web]!.changeSetId).toBe(record!.changeSetId);
  });

  it("a stack the change set CREATED needs no update time (CloudFormation may or may not report one for a created stack); an UPDATED stack does", async () => {
    const state = newState({ plan: webPlan });
    const [record] = await previewWeb(state);
    state.onExecute = () => { state.stacks[web]!.lastUpdatedTime = new Date(state.now - 86_400_000).toISOString(); };
    await expect(executeRecorded({ ports: makePorts(state), records: [record!], settleTimeoutSeconds: 60, log: () => {} })).resolves.toHaveLength(1);
  });

  it("a REVIEW_IN_PROGRESS stack whose change set is gone, and any other unsettled stack, are still refused", async () => {
    const state = newState({ plan: webPlan });
    const [record] = await previewWeb(state);
    delete state.changeSets[`${web}/${NAME}`];
    await expect(executeRecorded({ ports: makePorts(state), records: [record!], settleTimeoutSeconds: 60, log: () => {} })).rejects.toThrow(/cannot be read/);
    for (const status of ["ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS", "CREATE_FAILED", "DELETE_FAILED"]) {
      const other = newState({ plan: webPlan });
      const [rec] = await previewWeb(other);
      other.stacks[web]!.status = status;
      await expect(executeRecorded({ ports: makePorts(other), records: [rec!], settleTimeoutSeconds: 1, log: () => {} })).rejects.toMatchObject({ exitName: "REFUSED" });
      expect(other.calls.some((c) => c.startsWith("cfn execute"))).toBe(false);
    }
  });

  it("a change set that is not there yet, or still CREATE_IN_PROGRESS, right after cdk made it is read again; one that never appears is still a mismatch", async () => {
    const lateState = newState({ plan: webPlan });
    const late = makePorts(lateState);
    const describe = late.cfn.describeChangeSet.bind(late.cfn);
    let reads = 0;
    late.cfn.describeChangeSet = async (stack, name) => { reads += 1; const found = await describe(stack, name); return reads <= 2 ? null : reads === 3 ? { ...found!, status: "CREATE_IN_PROGRESS", executionStatus: "UNAVAILABLE" } : found; };
    const [record] = await previewWeb(lateState, late);
    expect(record).toMatchObject({ noChanges: false, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE" });
    expect(reads).toBe(4);
    const never = newState({ plan: webPlan });
    const ports = makePorts(never);
    ports.cfn.describeChangeSet = () => Promise.resolve(null);
    await expect(previewWeb(never, ports)).rejects.toThrow(/does not exist/);
  });

  it("a change set that FAILED with \"didn't contain changes\" is no change (what cdk --no-execute leaves; cdk only deletes the empty change set when it executes), and it is never executed or verified", async () => {
    const state = newState({ plan: { RovaraCloudWeb: null } });
    liveStack(state, web);
    const [record] = await previewWeb(state);
    expect(record).toMatchObject({ noChanges: true, changeSetId: null });
    const [done] = await executeRecorded({ ports: makePorts(state), records: [record!], settleTimeoutSeconds: 60, log: () => {} });
    expect(done).toBe(record);
    expect(state.calls.some((c) => c.startsWith("cfn execute"))).toBe(false);
  });
});

describe("pipeline stage CLI: release check", () => {
  it("strips /app from the web stack's address and reports none before the first deploy", () => {
    expect(baseUrlFromOutputs({ CloudUrl: "https://cloud.example.test/app" })).toBe("https://cloud.example.test");
    expect(baseUrlFromOutputs({})).toBeNull();
    expect(baseUrlFromOutputs({ CloudUrl: "None" })).toBeNull();
    expect(baseUrlFromOutputs(undefined)).toBeNull();
  });

  it("asks both paths and records any 5xx or failed connection, but not a 401", async () => {
    const state = newState();
    const seen: string[] = [];
    let n = 0;
    state.http = (url) => { seen.push(url); n += 1; if (url.endsWith("/v1/web/me")) return 401; return n === 3 ? 503 : n === 5 ? 0 : 200; };
    const check = startReleaseCheck(makePorts(state), "https://cloud.example.test", ["/app", "/v1/web/me"], 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await check.stop();
    expect(seen.slice(0, 2)).toEqual(["https://cloud.example.test/app", "https://cloud.example.test/v1/web/me"]);
    expect(result.probes).toBeGreaterThan(2);
    expect(result.failures.some((f) => f.includes("/app 503"))).toBe(true);
    expect(result.failures.some((f) => f.includes("/app 000"))).toBe(true);
    expect(result.failures.some((f) => f.includes("401"))).toBe(false);
  });
});
