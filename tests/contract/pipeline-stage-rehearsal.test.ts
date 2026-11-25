import { describe, expect, it } from "vitest";
import { assertScratchName, guardPorts, main, plannedCalls, rehearse, scratchConfig, scratchPrefixFor, templateFor } from "../../ops/pipeline/rehearsal/stage-cli-rehearsal.ts";
import type { RehearsalAws } from "../../ops/pipeline/rehearsal/stage-cli-rehearsal.ts";
import { rowFor } from "../../ops/pipeline/switches.ts";
import { FAKE_ACCOUNT, OTHER_ACCOUNT, config, fakeSwitches, makePorts, newState } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

const PREFIX = scratchPrefixFor(new Date(Date.UTC(2026, 10, 25, 7, 8, 9)));
const cfg = scratchConfig(config, PREFIX);
const resources = (template: string): string[] => Object.keys((JSON.parse(template) as { Resources: object }).Resources);

/** The scratch-stack side of the world: create-change-set and delete-stack as CloudFormation answers them (the stage CLI's own ports are the shared fakes). */
function fakeAws(state: FakeState): { aws: RehearsalAws; created: string[]; deleted: string[] } {
  const executed: Record<string, string> = {};
  const byId: Record<string, string> = {};
  const created: string[] = [];
  const deleted: string[] = [];
  let counter = 0;
  state.onExecute = (stack) => { executed[stack] = byId[state.stacks[stack]!.changeSetId!]!; };
  return {
    created, deleted,
    aws: {
      createChangeSet: (a) => {
        created.push(`${a.type} ${a.stack} ${a.name}`);
        const exists = state.stacks[a.stack] !== undefined;
        if (a.type === "CREATE" && exists) return Promise.reject(new Error("AlreadyExistsException"));
        if (a.type === "UPDATE" && !exists) return Promise.reject(new Error("stack does not exist"));
        if (!exists) state.stacks[a.stack] = { status: "REVIEW_IN_PROGRESS", parameters: {}, outputs: {}, templateSha: "shell" };
        counter += 1;
        const id = `arn:aws:cloudformation:us-east-1:${FAKE_ACCOUNT}:changeSet/${a.name}/${String(counter).padStart(8, "0")}`;
        byId[id] = a.template;
        if (a.type === "UPDATE" && a.template === executed[a.stack]) {
          state.changeSets[`${a.stack}/${a.name}`] = { id, status: "FAILED", executionStatus: "UNAVAILABLE", statusReason: "The submitted information didn't contain changes. Submit different information to create a change set.", rows: [], template: a.template };
          return Promise.resolve();
        }
        const known = executed[a.stack] === undefined ? [] : resources(executed[a.stack]!);
        const rows = resources(a.template).filter((r) => !known.includes(r)).map((r) => ({ action: "Add", logicalId: r, physicalId: null, resourceType: "AWS::CloudFormation::WaitConditionHandle", replacement: null }));
        state.changeSets[`${a.stack}/${a.name}`] = { id, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE", statusReason: null, rows, template: a.template };
        return Promise.resolve();
      },
      deleteStack: (stack) => { deleted.push(stack); delete state.stacks[stack]; for (const key of Object.keys(state.changeSets)) if (key.startsWith(`${stack}/`)) delete state.changeSets[key]; return Promise.resolve(); },
    },
  };
}

const options = (state: FakeState, aws: RehearsalAws, lines: string[] = []) => ({
  ports: makePorts(state), aws, config: cfg, row: rowFor("beta", fakeSwitches), proofAccount: FAKE_ACCOUNT, region: "us-east-1", tag: "t", outDir: "/out", workDir: "/work",
  exec8s: ["aaaaaaaa", "bbbbbbbb", "cccccccc"] as const, out: (line: string) => { lines.push(line); },
});

describe("pipeline stage CLI rehearsal: the script itself (against the fakes; the real run is the controller's)", () => {
  it("runs every scenario through the real stage code, passes, and deletes its scratch stacks", async () => {
    const state = newState();
    const { aws, created, deleted } = fakeAws(state);
    const lines: string[] = [];
    const result = await rehearse(options(state, aws, lines));
    expect(lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(result).toMatchObject({ ok: true, leftovers: [] });
    expect(result.checks.map((c) => c.name).filter((n) => n.startsWith("failure path"))).toHaveLength(3);
    expect(Object.keys(state.stacks)).toEqual([]);
    expect(deleted.sort()).toEqual(["gateway", "web", "app"].map((p) => `${PREFIX}-beta-${p}`).sort());
    expect(created.every((c) => c.split(" ")[1]!.startsWith("rovara-scratch-proof-"))).toBe(true);
    expect(state.calls.filter((c) => c.startsWith("cfn ")).every((c) => c.split(" ")[2]!.startsWith("rovara-scratch-proof-"))).toBe(true);
    expect(lines.some((l) => l.includes("NOT FOUND (CloudFormation deleted it"))).toBe(true);
  });

  it("deletes the scratch stacks even when a step fails, and reports the failure", async () => {
    const state = newState();
    const { aws, deleted } = fakeAws(state);
    const ports = options(state, aws).ports;
    ports.cfn.executeChangeSet = () => Promise.reject(new Error("AccessDenied"));
    const result = await rehearse({ ...options(state, aws), ports });
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => !c.ok && c.name === "the rehearsal ran to the end")).toBe(true);
    expect(deleted).toHaveLength(3);
    expect(Object.keys(state.stacks)).toEqual([]);
  });

  it("proves the tidy by name only: another execution's change set survives the failure path", async () => {
    const state = newState();
    const { aws } = fakeAws(state);
    const lines: string[] = [];
    await rehearse(options(state, aws, lines));
    expect(lines.some((l) => l.startsWith("PASS failure path: another execution's change set"))).toBe(true);
  });

  it("refuses when STS reports an account other than the proof account, before anything is created", async () => {
    const state = newState({ account: OTHER_ACCOUNT });
    const { aws, created } = fakeAws(state);
    await expect(rehearse(options(state, aws))).rejects.toMatchObject({ exitName: "REFUSED" });
    expect(created).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it("refuses every stack name that is not a scratch one, in the ports and in the config", async () => {
    expect(() => assertScratchName("rovara-cloud-beta-web")).toThrow(/refusing to touch/);
    expect(() => assertScratchName("rovara-scratch-proof")).toThrow();
    expect(() => assertScratchName(`${PREFIX}-beta-web`)).not.toThrow();
    expect(() => scratchConfig(config, "rovara-cloud")).toThrow(/refusing/);
    const state = newState();
    const guarded = guardPorts(makePorts(state));
    expect(() => guarded.cfn.executeChangeSet("rovara-cloud-beta-web", "x")).toThrow(/refusing/);
    expect(() => guarded.cfn.deleteChangeSet("rovara-cloud-production-web", "x")).toThrow(/refusing/);
    expect(state.calls).toEqual([]);
  });

  it("the templates are tiny: WaitConditionHandles and one output, no IAM", () => {
    const t = JSON.parse(templateFor(2, ["A", "B"])) as { Resources: Record<string, { Type: string }>; Outputs: unknown };
    expect(Object.values(t.Resources).map((r) => r.Type)).toEqual(["AWS::CloudFormation::WaitConditionHandle", "AWS::CloudFormation::WaitConditionHandle"]);
    expect(JSON.stringify(t)).not.toMatch(/IAM|Role|Policy/u);
  });

  it("--dry-run prints the planned calls and makes no AWS call; missing or wrong settings are refused", async () => {
    const out: string[] = [];
    const env = { ROVARA_REHEARSAL_PROOF_ACCOUNT: FAKE_ACCOUNT, AWS_REGION: "us-east-1", ROVARA_PIPELINE_PROFILE: "some-profile" };
    expect(await main(["--dry-run"], env, (l) => out.push(l), () => new Date(Date.UTC(2026, 10, 25, 7, 8, 9)))).toBe(0);
    expect(out[0]).toContain("no AWS call is made");
    expect(out.join("\n")).toContain(`${PREFIX}-beta-gateway`);
    expect(out.join("\n")).not.toContain(FAKE_ACCOUNT);
    const none: string[] = [];
    expect(await main(["--dry-run"], { AWS_REGION: "us-east-1" }, (l) => none.push(l))).toBe(3);
    expect(none.join()).toContain("ROVARA_REHEARSAL_PROOF_ACCOUNT");
    expect(await main(["--dry-run"], { ...env, AWS_REGION: "eu-west-1" }, () => {})).toBe(3);
    expect(await main(["--dry-run"], { ...env, AWS_REGION: "" }, () => {})).toBe(3);
    expect(await main(["--run-now"], env, () => {})).toBe(2);
    expect(plannedCalls(cfg, PREFIX, "us-east-1").every((l) => !/\b[0-9]{12}\b/u.test(l))).toBe(true);
  });
});
