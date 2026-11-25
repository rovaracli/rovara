// L3: the `protected` gate (ops/pipeline/gates/protected.gate.ts) against fake change-set records and the real ops/pipeline/protected.json. No AWS.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gate as protectedGate } from "../../ops/pipeline/gates/protected.gate.ts";
import { checkProtected, isReplacement, parseProtected } from "../../ops/pipeline/lib/protected.ts";
import { countRows } from "../../ops/pipeline/lib/changesets.ts";
import type { ChangeRow, ChangeSetRecord, GateInput, Manifest } from "../../ops/pipeline/types.ts";
import { CDK_METADATA, EXEC8, EXEC_ID, config, makePorts, newState, row, sha } from "./pipeline-stage-fakes.ts";

const LIST_FILE = new URL("../../ops/pipeline/protected.json", import.meta.url);
const RAW = readFileSync(LIST_FILE, "utf8");
const LIST_PATH = new URL("../../ops/pipeline/protected.json", import.meta.url).pathname;

const manifest = (over: { mode?: Manifest["mode"]; live?: string | null } = {}): Manifest => ({
  schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-24T12:00:00.000Z", mode: over.mode ?? "release",
  cloud: { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: over.live === undefined ? sha("3") : over.live, production: null } },
  code: { sha: null, release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null },
  gateway: { digest: null, source: null, imageTag: null, repository: null }, stages: {},
});
const cs = (part: ChangeSetRecord["part"], rows: ChangeRow[]): ChangeSetRecord => ({
  part, stack: `rovara-cloud-beta-${part}`, changeSetName: `rovara-pipeline-${EXEC8}`, changeSetId: "id", noChanges: rows.length === 0, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE",
  templateSha256: "h", rows, counts: countRows(rows), previewedAt: "x", executedAt: null, finalStatus: null,
});
const run = (records: ChangeSetRecord[], over: { mode?: Manifest["mode"]; live?: string | null; exec?: (cmd: string, args: readonly string[]) => { code: number; stdout: string; stderr: string } } = {}) => {
  const state = newState();
  state.files[LIST_PATH] = RAW;
  if (over.exec !== undefined) state.exec = over.exec;
  const input: GateInput = { env: "beta", phase: "change-sets", region: "us-east-1", config, manifest: manifest(over), changeSets: records, dirs: { pipeline: "/p", cloud: "/c", out: "/out", work: "/w" }, ports: makePorts(state), log: () => {} };
  return protectedGate.run(input).then((outcome) => ({ outcome, state }));
};
const sameInfra = () => ({ code: 0, stdout: "", stderr: "" });
const infraChanged = () => ({ code: 1, stdout: "", stderr: "" });

const TABLE = (id: string, action: string, replacement: ChangeRow["replacement"]) => row(action, id, "AWS::DynamoDB::GlobalTable", replacement);
const IMAGE_ROWS: ChangeRow[] = [
  row("Modify", "ServeTaskF1990141", "AWS::ECS::TaskDefinition", "True"),
  row("Modify", "PriceFetchTask7EDA4B48", "AWS::ECS::TaskDefinition", "True"),
  row("Modify", "ServiceD69D759B", "AWS::ECS::Service", "False"),
  row("Modify", "PriceFetchScheduleAD6AA82A", "AWS::Events::Rule", "False"),
  row("Modify", "PriceFetchTaskEventsRoleDefaultPolicyE756D0DB", "AWS::IAM::Policy", "False"),
];

describe("protected list: parsing", () => {
  it("reads the real file and refuses a broken one", () => {
    const list = parseProtected(RAW);
    expect(Object.keys(list.parts).sort()).toEqual(["app", "gateway", "gatewayImages", "web"]);
    expect(list.parts.web!.State1C20CC9A).toBe("AWS::DynamoDB::GlobalTable");
    expect(() => parseProtected("{")).toThrow(/not JSON/);
    expect(() => parseProtected(JSON.stringify({ schema: 2 }))).toThrow(/schema/);
    const noGateway = JSON.parse(RAW) as { parts: Record<string, unknown> };
    noGateway.parts.gateway = {};
    expect(() => parseProtected(JSON.stringify(noGateway))).toThrow(/parts.gateway/);
    const badType = JSON.parse(RAW) as { parts: { web: Record<string, string> } };
    badType.parts.web.State1C20CC9A = "table";
    expect(() => parseProtected(JSON.stringify(badType))).toThrow(/resource type/);
  });

  it("treats Replacement True and Conditional as a replacement (scratch proof 1), and False or unknown as not", () => {
    expect(isReplacement(row("Modify", "X", "AWS::S3::Bucket", "True"))).toBe(true);
    expect(isReplacement(row("Modify", "X", "AWS::S3::Bucket", "Conditional"))).toBe(true);
    expect(isReplacement(row("Modify", "X", "AWS::S3::Bucket", "False"))).toBe(false);
    expect(isReplacement(row("Modify", "X", "AWS::S3::Bucket", null))).toBe(false);
  });
});

describe("protected gate: web and app (preflight)", () => {
  it("passes ordinary modifications, including a Lambda replacement and the CDK metadata line", async () => {
    const { outcome } = await run([cs("web", [row("Modify", "Server7E7D21FA", "AWS::Lambda::Function", "False"), row("Modify", "ToCustomDomainA994B860", "AWS::CloudFront::Function", "True"), CDK_METADATA]), cs("app", [])]);
    expect(outcome.result).toBe("pass");
    expect(outcome.data).toMatchObject({ parts: ["web", "app"], imageOnly: false });
  });

  it("fails a Remove or Replacement True of a listed resource", async () => {
    const { outcome } = await run([cs("web", [TABLE("State1C20CC9A", "Remove", null), TABLE("CompaniesAF68172A", "Modify", "True"), row("Modify", "ServerServiceRole3DA1B1D6", "AWS::IAM::Role", "True")]), cs("app", [row("Modify", "CodeClientSecretE7B5CF94", "AWS::SecretsManager::Secret", "True")])]);
    expect(outcome.result).toBe("fail");
    const text = (outcome.failures ?? []).join("\n");
    expect(text).toMatch(/web\/State1C20CC9A .* would be removed/);
    expect(text).toMatch(/web\/CompaniesAF68172A .* would be replaced \(Replacement=True\)/);
    expect(text).toMatch(/web\/ServerServiceRole3DA1B1D6 .* would be replaced/);
    expect(text).toMatch(/app\/CodeClientSecretE7B5CF94 .* would be replaced/);
  });

  it("fails Replacement Conditional: a same-name key change previews Conditional, then fails half way at execution (scratch proof 1)", async () => {
    const { outcome } = await run([cs("web", [TABLE("State1C20CC9A", "Modify", "Conditional")])]);
    expect(outcome.result).toBe("fail");
    expect(outcome.failures?.[0]).toMatch(/Replacement=Conditional/);
  });

  it("fails a Dynamic change on a protected resource (CloudFormation cannot say it is not replaced)", async () => {
    const { outcome } = await run([cs("web", [row("Dynamic", "Distribution830FAC52", "AWS::CloudFront::Distribution", null)])]);
    expect(outcome.failures?.[0]).toMatch(/Dynamic change/);
  });

  it("an Add or an in-place Modify of a protected resource is fine (first creation, an ordinary update)", async () => {
    const { outcome } = await run([cs("web", [{ ...TABLE("State1C20CC9A", "Modify", "False"), changedProperties: ["Tags"] }, row("Add", "Assets9A31D427", "AWS::S3::Bucket", null)])]);
    expect(outcome.result).toBe("pass");
  });

  it("the stateful-type backstop protects a table nobody listed, so a renamed construct (Remove + Add) fails", async () => {
    const { outcome } = await run([cs("web", [TABLE("StateRenamedABCDEF12", "Add", null), TABLE("State1C20CC9A", "Remove", null), TABLE("BrandNewTable00000000", "Remove", null), row("Remove", "AnotherKey11111111", "AWS::KMS::Key", null)])]);
    const text = (outcome.failures ?? []).join("\n");
    expect(text).toMatch(/State1C20CC9A/);
    expect(text).toMatch(/BrandNewTable00000000 .*stateful type/);
    expect(text).toMatch(/AnotherKey11111111 .*stateful type/);
    expect(text).not.toMatch(/StateRenamedABCDEF12/);
  });

  it("fails a record whose type disagrees with the list, and fails when there is nothing to check or the list is missing", async () => {
    const { outcome } = await run([cs("web", [row("Remove", "State1C20CC9A", "AWS::Lambda::Function", null)])]);
    expect((outcome.failures ?? []).join("\n")).toMatch(/the list and the template disagree/);
    expect((await run([])).outcome.failures?.[0]).toMatch(/no change set was given/);
    const state = newState();
    const input: GateInput = { env: "beta", phase: "change-sets", region: "us-east-1", config, manifest: manifest(), changeSets: [cs("web", [])], dirs: { pipeline: "/p", cloud: "/c", out: "/o", work: "/w" }, ports: makePorts(state), log: () => {} };
    expect((await protectedGate.run(input)).failures?.[0]).toMatch(/cannot read the protected list/);
  });
});

describe("protected gate: the gateway change set", () => {
  it("fails the C9 additions: ProductKeys table and keys, Meter table, the certificate listener, the ALB, the Vertex role", async () => {
    const { outcome } = await run([cs("gateway", [
      TABLE("ProductKeys518BAD1E", "Modify", "True"), TABLE("MeterFF56B2C9", "Remove", null), row("Modify", "ProductKeysKey3D2EA306", "AWS::KMS::Key", "True"), row("Modify", "ProductKeysMacKey82416FCB", "AWS::KMS::Key", "Conditional"),
      row("Modify", "LoadBalancerHttps0C5C99D2", "AWS::ElasticLoadBalancingV2::Listener", "True"), row("Modify", "LoadBalancerBE9EEC3A", "AWS::ElasticLoadBalancingV2::LoadBalancer", "True"), row("Modify", "VertexFederationRoleF5D9F2D9", "AWS::IAM::Role", "True"),
    ])], { exec: infraChanged });
    expect(outcome.result).toBe("fail");
    expect(outcome.failures).toHaveLength(7);
  });

  it("an image-only change (infra unchanged from the deployed Cloud) may touch only the five image rows and the CDK metadata line", async () => {
    const ok = await run([cs("gateway", [...IMAGE_ROWS, CDK_METADATA])], { exec: sameInfra });
    expect(ok.outcome.result).toBe("pass");
    expect(ok.outcome.data).toMatchObject({ imageOnly: true });
    const diff = ok.state.calls.find((c) => c.startsWith("exec git -C /p diff --quiet"))!;
    expect(diff).toContain(`${sha("3")} ${sha("4")} -- infra packages/contracts ops/pipeline/switches.json package-lock.json`);
    const extra = await run([cs("gateway", [...IMAGE_ROWS, row("Add", "NewAlarm11111111", "AWS::CloudWatch::Alarm", null), row("Modify", "ServeLogs9729A15B", "AWS::Logs::LogGroup", "False")])], { exec: sameInfra });
    expect(extra.outcome.result).toBe("fail");
    expect(extra.outcome.failures).toHaveLength(2);
    expect(extra.outcome.failures?.[0]).toMatch(/image-only change/);
  });

  it("an image row must be a Modify of the right type: an added task definition is not an image row", async () => {
    const { outcome } = await run([cs("gateway", [row("Add", "ServeTaskF1990141", "AWS::ECS::TaskDefinition", null), row("Modify", "ServiceD69D759B", "AWS::ECS::TaskDefinition", "False")])], { exec: sameInfra });
    expect(outcome.failures).toHaveLength(2);
  });

  it("when infra changed since the deployed Cloud, or the deployed sha or the diff is unknown, only the general rules apply (and the note says so)", async () => {
    const changed = await run([cs("gateway", [...IMAGE_ROWS, row("Add", "NewAlarm11111111", "AWS::CloudWatch::Alarm", null)])], { exec: infraChanged });
    expect(changed.outcome.result).toBe("pass");
    expect(changed.outcome.notes?.join(" ")).toMatch(/infra changed between/);
    const unknown = await run([cs("gateway", [row("Add", "NewAlarm11111111", "AWS::CloudWatch::Alarm", null)])], { live: null });
    expect(unknown.outcome.result).toBe("pass");
    expect(unknown.outcome.notes?.join(" ")).toMatch(/deployed Cloud sha is unknown/);
    const broken = await run([cs("gateway", [row("Add", "NewAlarm11111111", "AWS::CloudWatch::Alarm", null)])], { exec: () => ({ code: 128, stdout: "", stderr: "bad object" }) });
    expect(broken.outcome.notes?.join(" ")).toMatch(/git exit 128/);
    // the protected rules still apply when image-only cannot be shown
    expect((await run([cs("gateway", [TABLE("LedgerB7379752", "Modify", "True")])], { live: null })).outcome.result).toBe("fail");
  });

  it("the same candidate as the deployed one is image-only without asking git; an adoption run is left to the integrity gate", async () => {
    const same = await run([cs("gateway", [row("Add", "NewAlarm11111111", "AWS::CloudWatch::Alarm", null)])], { live: sha("4") });
    expect(same.outcome.result).toBe("fail");
    expect(same.state.calls.some((c) => c.includes("diff --quiet"))).toBe(false);
    const adoption = await run([cs("gateway", [CDK_METADATA])], { mode: "adoption", exec: sameInfra });
    expect(adoption.outcome).toMatchObject({ result: "pass", data: { imageOnly: false } });
  });

  it("checkProtected on its own: rows of a part the list does not know are judged by type only", () => {
    const list = parseProtected(RAW);
    const record = { ...cs("web", [row("Remove", "State1C20CC9A", "AWS::DynamoDB::GlobalTable", null)]), part: "elsewhere" as "web" };
    expect(checkProtected(list, [record], { imageOnly: false }).failures[0]).toMatch(/stateful type/);
  });
});
