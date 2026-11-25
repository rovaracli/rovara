// Opus review (L3): what the protected gate did NOT see: a Modify (Replacement False) of a listed resource that rewrites its data in place.
// CLOSED by the follow-up: the change set's property details (names only) are judged against protected.json's dataRewrites; a row of those types with no details fails closed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkProtected, parseProtected } from "../../ops/pipeline/lib/protected.ts";
import { countRows } from "../../ops/pipeline/lib/changesets.ts";
import { gate as protectedGate } from "../../ops/pipeline/gates/protected.gate.ts";
import type { ChangeRow, ChangeSetRecord, Manifest } from "../../ops/pipeline/types.ts";
import { EXEC8, EXEC_ID, config, makePorts, newState, row, sha } from "./pipeline-stage-fakes.ts";

const list = parseProtected(readFileSync(new URL("../../ops/pipeline/protected.json", import.meta.url), "utf8"));
const cs = (part: ChangeSetRecord["part"], rows: ChangeRow[]): ChangeSetRecord => ({
  part, stack: `s-${part}`, changeSetName: "n", changeSetId: "id", noChanges: rows.length === 0, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE",
  templateSha256: "h", rows, counts: countRows(rows), previewedAt: "x", executedAt: null, finalStatus: null,
});

const withProps = (id: string, type: string, changedProperties?: string[]): ChangeRow => ({ ...row("Modify", id, type, "False"), ...(changedProperties === undefined ? {} : { changedProperties }) });

describe("protected gate: in-place data rewrites", () => {
  it("refuses a Replacement=False Modify of the listed client secret or provider key that changes GenerateSecretString (the hand-put value would be regenerated)", () => {
    const result = checkProtected(list, [cs("app", [withProps("CodeClientSecretE7B5CF94", "AWS::SecretsManager::Secret", ["Properties:GenerateSecretString"])]), cs("gateway", [withProps("ProviderKeyanthropic", "AWS::SecretsManager::Secret", ["Properties:SecretString", "Tags"])])], { imageOnly: false });
    expect(result.failures).toHaveLength(2);
    expect(result.failures.join("\n")).toMatch(/CodeClientSecretE7B5CF94 .* changes GenerateSecretString in place/);
    expect(result.failures.join("\n")).toMatch(/ProviderKeyanthropic .* changes SecretString in place/);
  });

  it("refuses a listed table's Replicas change and a listed key's KeySpec or KeyUsage change", () => {
    const result = checkProtected(list, [cs("gateway", [withProps("LedgerB7379752", "AWS::DynamoDB::GlobalTable", ["Properties:Replicas"]), withProps("ProductKeysKey3D2EA306", "AWS::KMS::Key", ["Properties:KeyUsage"]), withProps("ProviderKeysKey3EF4ADE0", "AWS::KMS::Key", ["Properties:KeySpec"])])], { imageOnly: false });
    expect(result.failures).toHaveLength(3);
  });

  it("lets harmless in-place edits through (tags, a description, a policy, other properties) ", () => {
    const result = checkProtected(list, [cs("gateway", [withProps("LedgerB7379752", "AWS::DynamoDB::GlobalTable", ["Tags", "Properties:TimeToLiveSpecification"]), withProps("ProviderKeysKey3EF4ADE0", "AWS::KMS::Key", ["Properties:KeyPolicy", "Properties:Description"]), withProps("ProviderKeyanthropic", "AWS::SecretsManager::Secret", ["Properties:Description"])])], { imageOnly: false });
    expect(result).toMatchObject({ failures: [] });
  });

  it("a listed or stateful row of those types with NO property details fails closed; an empty Details list counts as present and passes", () => {
    const missing = checkProtected(list, [cs("gateway", [withProps("LedgerB7379752", "AWS::DynamoDB::GlobalTable"), withProps("ProviderKeyanthropic", "AWS::SecretsManager::Secret")])], { imageOnly: false });
    expect(missing.failures).toHaveLength(2);
    expect(missing.failures[0]).toMatch(/LedgerB7379752 .* no property details.*failing closed/);
    // Details: [] reaches the record as an empty list: CloudFormation looked and found no property change.
    expect(checkProtected(list, [cs("gateway", [withProps("LedgerB7379752", "AWS::DynamoDB::GlobalTable", []), withProps("ProviderKeyanthropic", "AWS::SecretsManager::Secret", [])])], { imageOnly: false }).failures).toEqual([]);
    // A type outside dataRewrites is not asked for details.
    expect(checkProtected(list, [cs("gateway", [withProps("Vpc8378EB38", "AWS::EC2::VPC")])], { imageOnly: false }).failures).toEqual([]);
  });

  it("adding an index (AttributeDefinitions, GlobalSecondaryIndexes) is an in-place change with no data loss: it passes", () => {
    const result = checkProtected(list, [cs("gateway", [withProps("LedgerB7379752", "AWS::DynamoDB::GlobalTable", ["Properties:AttributeDefinitions", "Properties:GlobalSecondaryIndexes"])])], { imageOnly: false });
    expect(result.failures).toEqual([]);
  });

  it("the gate fails the step on a row with no details", async () => {
    const state = newState();
    state.files[new URL("../../ops/pipeline/protected.json", import.meta.url).pathname] = readFileSync(new URL("../../ops/pipeline/protected.json", import.meta.url), "utf8");
    const manifest = { schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "x", mode: "release", cloud: { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: null, production: null } }, code: { sha: null, release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null }, gateway: { digest: null, source: null, imageTag: null, repository: null }, stages: {} } as Manifest;
    const outcome = await protectedGate.run({ env: "beta", phase: "change-sets", region: "us-east-1", config, manifest, changeSets: [cs("gateway", [withProps("LedgerB7379752", "AWS::DynamoDB::GlobalTable")])], dirs: { pipeline: "/p", cloud: "/c", out: "/o", work: "/w" }, ports: makePorts(state), log: () => {} });
    expect(outcome.result).toBe("fail");
    expect(outcome.failures?.[0]).toMatch(/no property details/);
  });

  it("the image-only rule still only adds refusals", () => {
    const result = checkProtected(list, [cs("gateway", [row("Modify", "LedgerB7379752", "AWS::DynamoDB::GlobalTable", "False")])], { imageOnly: true });
    expect(result.failures.join("\n")).toMatch(/not one of the image rows/);
  });
});
