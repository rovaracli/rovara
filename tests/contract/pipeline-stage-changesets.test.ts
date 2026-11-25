import { describe, expect, it } from "vitest";
import { countRows, executeRecorded, previewChangeSets, tidyChangeSets, verifyRecorded } from "../../ops/pipeline/lib/changesets.ts";
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
    expect(state.calls.find((c) => c.startsWith("cdk "))).toBe("cdk RovaraCloudApp,RovaraCloudWeb rovara-pipeline-1a2b3c4d ctx=a params=CodeUrl=https://x.example.test");
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

  it("detects a change set swapped during the execute", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const records = await preview(state);
    state.onExecute = (stack) => { state.changeSets[`${stack}/${NAME}`]!.id = "swapped"; };
    await expect(executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} })).rejects.toThrow(/not the recorded change set/);
  });

  it("a retried action waits for a change set that already executed instead of executing it again", async () => {
    const state = newState({ plan: { RovaraCloudApp: [MODIFY_FUNCTION], RovaraCloudWeb: [MODIFY_FUNCTION] } });
    for (const part of ["app", "web"] as const) liveStack(state, stackFor("beta", part));
    const records = await preview(state);
    state.changeSets[`${records[0]!.stack}/${NAME}`]!.executionStatus = "EXECUTE_COMPLETE";
    await executeRecorded({ ports: makePorts(state), records, settleTimeoutSeconds: 60, log: () => {} });
    expect(state.calls.filter((c) => c.startsWith("cfn execute"))).toEqual([`cfn execute ${records[1]!.stack} ${NAME}`]);
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
