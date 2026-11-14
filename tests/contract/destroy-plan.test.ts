import { describe, expect, it } from "vitest";
import { confirmationPrompts, destroyPlanText, inventoryParameterName, mergeInventory, readInventory, retainedResources, vendorSteps, writeInventory, type RetainedResource } from "../../packages/cli/src/destroy/inventory.js";
import { DELETE_AFTER_WORKERS, DELETE_BEFORE_WORKERS, isOwnedAlias, isSecretId, isOwnedParameter, isOwnedRetained, isOwnedSecret, isOwnedStack, isOwnedWorker } from "../../packages/cli/src/destroy/names.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

describe("destroy: the order (docs/architecture-production.md, Tearing down an environment)", () => {
  it("deletes slack, runtime, control-plane, then the workers, then identity, foundation, access", () => {
    expect([...DELETE_BEFORE_WORKERS, "workers", ...DELETE_AFTER_WORKERS]).toEqual(["slack", "runtime", "control-plane", "workers", "identity", "foundation", "access"]);
  });
});

describe("destroy: name guards never reach another environment", () => {
  it("matches this environment's stacks, secrets, parameters and aliases exactly", () => {
    expect(isOwnedStack("prod", "rovara-cloud-prod-slack")).toBe(true);
    expect(isOwnedStack("prod", "rovara-cloud-prod-eu-slack")).toBe(false);
    expect(isOwnedStack("prod", "AgentXControlPlane")).toBe(false);
    expect(isOwnedSecret("prod", "rovara-cloud/prod/slack")).toBe(true);
    expect(isOwnedSecret("prod", "rovara-cloud/prod-eu/slack")).toBe(false);
    expect(isOwnedSecret("prod", "agentx/connectors/linear")).toBe(false);
    expect(isOwnedParameter("prod", "/rovara-cloud/prod/settings")).toBe(true);
    expect(isOwnedParameter("prod", "/rovara-cloud/prod-eu/settings")).toBe(false);
    expect(isOwnedAlias("prod", "alias/rovara-cloud/prod/workspaces")).toBe(true);
    expect(isOwnedAlias("prod", "alias/rovara-cloud/prod-eu/workspaces")).toBe(false);
    expect(isOwnedAlias("production", "alias/rovara-cloud/production-workspaces")).toBe(false);
  });

  it("matches nothing for a name that is not a valid environment name, so an empty or slashed name never widens a prefix", () => {
    expect(isOwnedStack("", "rovara-cloud--slack")).toBe(false);
    expect(isOwnedSecret("", "rovara-cloud//slack")).toBe(false);
    expect(isOwnedSecret("prod/", "rovara-cloud/prod//slack")).toBe(false);
    expect(isOwnedParameter("", "/rovara-cloud//settings")).toBe(false);
    expect(isOwnedAlias("", "alias/rovara-cloud//workspaces")).toBe(false);
    expect(isOwnedWorker("", { DeploymentMode: "ec2-ebs", Environment: "", "rovara-cloud:env": "" })).toBe(false);
    expect(isOwnedRetained("", { part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k" }, { "rovara-cloud:env": "" })).toBe(false);
  });

  it("matches a worker only with all three tags, so the legacy deployment's workers (Environment=production, no rovara-cloud:env) are never touched", () => {
    expect(isOwnedWorker("production", { DeploymentMode: "ec2-ebs", Environment: "production", "rovara-cloud:env": "production" })).toBe(true);
    expect(isOwnedWorker("production", { DeploymentMode: "ec2-ebs", Environment: "production" })).toBe(false);
    expect(isOwnedWorker("prod", { DeploymentMode: "ec2-ebs", Environment: "prod-eu", "rovara-cloud:env": "prod-eu" })).toBe(false);
  });

  it("matches a retained resource only with this environment's tag and, for generated names, its stack's prefix", () => {
    const bucket: RetainedResource = { part: "foundation", logicalId: "Artifacts", type: "AWS::S3::Bucket", physicalId: "rovara-cloud-prod-foundation-access-artifactbucket-1a2b" };
    // Env "prod-foundation"'s access bucket starts with env "prod"'s foundation prefix; only the tag tells them apart.
    expect(isOwnedRetained("prod", bucket, { "rovara-cloud:env": "prod-foundation" })).toBe(false);
    expect(isOwnedRetained("prod", { ...bucket, physicalId: "rovara-cloud-prod-foundation-artifacts-9z" }, { "rovara-cloud:env": "prod" })).toBe(true);
    expect(isOwnedRetained("prod", { ...bucket, physicalId: "rovara-cloud-prod-eu-foundation-artifacts-9z" }, { "rovara-cloud:env": "prod" })).toBe(false);
    expect(isOwnedRetained("prod", { part: "identity", logicalId: "UserPool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_AbC" }, undefined)).toBe(false);
    expect(isOwnedRetained("prod", { part: "control-plane", logicalId: "SlackSecret", type: "AWS::SecretsManager::Secret", physicalId: "arn:aws:secretsmanager:us-east-1:1:secret:rovara-cloud/prod-eu/slack-AbC" }, { "rovara-cloud:env": "prod" })).toBe(false);
  });
});

describe("destroy: name guards, prefix overlaps and the older production deployment", () => {
  it("never matches a name that only shares a prefix or differs in case", () => {
    expect(isOwnedStack("live", "rovara-cloud-live25b-slack")).toBe(false);
    expect(isOwnedSecret("prod", "agentx/production/slack")).toBe(false);
    expect(isOwnedParameter("prod", "/agentx/production/settings")).toBe(false);
    expect(isOwnedSecret("prod", "rovara-cloud/PROD/slack")).toBe(false);
    expect(isOwnedWorker("prod", { DeploymentMode: "ec2-ebs", "rovara-cloud:env": "prod" })).toBe(false);
  });

  it("never matches the older production deployment's agentx names, even for env production", () => {
    // The older (adopted) production deployment uses /agentx/production/* parameters and this KMS
    // alias (infra/lib/naming.ts). Named environments live under rovara-cloud, so the guards never
    // reach it; runDestroy's up-front refusal of that deployment (ruling F21) protects it besides.
    expect(isOwnedAlias("production", "alias/agentx/production/invoke-signing")).toBe(false);
    expect(isOwnedParameter("production", "/agentx/production/worker-image")).toBe(false);
    expect(isOwnedSecret("production", "agentx/production/slack")).toBe(false);
    expect(isOwnedAlias("production", "alias/rovara-cloud/production/invoke-signing")).toBe(true);
    expect(isOwnedParameter("production", "/rovara-cloud/production/worker-image")).toBe(true);
  });

  it("matches a tagged generated-name resource by its stack tag, so a bucket name CloudFormation shortened still matches", () => {
    const bucket: RetainedResource = { part: "control-plane", logicalId: "Artifacts", type: "AWS::S3::Bucket", physicalId: "rovara-cloud-a-long-envname-contr-artifactsbucket-1x2y3z" };
    expect(isOwnedRetained("a-long-envname", bucket, { "rovara-cloud:env": "a-long-envname", "aws:cloudformation:stack-name": "rovara-cloud-a-long-envname-control-plane" })).toBe(true);
    expect(isOwnedRetained("a-long-envname", bucket, { "rovara-cloud:env": "a-long-envname", "aws:cloudformation:stack-name": "rovara-cloud-a-long-envname-foundation" })).toBe(false);
    expect(isOwnedRetained("prod", { part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k" }, { "rovara-cloud:env": "prod", "aws:cloudformation:stack-name": "rovara-cloud-prod-eu-foundation" })).toBe(false);
    // Without the stack tag, the name prefix still decides: another part's shortened prefix never matches.
    expect(isOwnedRetained("a-long-envname", { ...bucket, part: "foundation" }, { "rovara-cloud:env": "a-long-envname" })).toBe(false);
  });

  it("matches a bucket whose name CloudFormation shortened when S3 returns no stack tag (Task 20 live check)", () => {
    // live15ea's Slack thread-session bucket: S3's tag set held only rovara-cloud:env, and CloudFormation cut
    // the stack name rovara-cloud-live15ea-control-plane to rovara-cloud-live15ea-con and the logical id
    // SlackThreadSessions6FD21617 to slackthreadsessions6fd21, to fit S3's 63 characters.
    const bucket: RetainedResource = { part: "control-plane", logicalId: "SlackThreadSessions6FD21617", type: "AWS::S3::Bucket", physicalId: "rovara-cloud-live15ea-con-slackthreadsessions6fd21-taqjchbygr25" };
    expect(bucket.physicalId).toHaveLength(63);
    expect(isOwnedRetained("live15ea", bucket, { "rovara-cloud:env": "live15ea" })).toBe(true);
    expect(isOwnedRetained("live15ea", bucket, { "rovara-cloud:env": "live15eab" })).toBe(false);
    expect(isOwnedRetained("live15ea", { ...bucket, part: "slack" }, { "rovara-cloud:env": "live15ea" })).toBe(false);
    expect(isOwnedRetained("live15ea", { ...bucket, physicalId: "rovara-cloud-live15eab-con-slackthreadsessions6fd21-x" }, { "rovara-cloud:env": "live15ea" })).toBe(false);
    expect(isOwnedRetained("live15ea", { ...bucket, physicalId: "rovara-cloud-live15ea--slackthreadsessions6fd21-x" }, { "rovara-cloud:env": "live15ea" })).toBe(false);
  });
});

describe("destroy: a generated bucket name, shortened (review I2)", () => {
  const ENV14 = "abcdefghijklmn";
  // rovara-cloud-abcdefghijklmn-control-plane cut to 25 characters reaches into rovara-cloud-<env>- itself.
  const long: RetainedResource = { part: "control-plane", logicalId: "SlackThreadSessions6FD21617", type: "AWS::S3::Bucket", physicalId: "rovara-cloud-abcdefghijkl-slackthreadsessions6fd21-taqjchbygr25" };
  const tagged = { "rovara-cloud:env": ENV14 };

  it("matches a 14-character environment's bucket whose stack name was cut inside rovara-cloud-<env>-", () => {
    expect(long.physicalId).toHaveLength(63);
    expect(isOwnedRetained(ENV14, long, tagged)).toBe(true);
  });

  it("matches the full stack name followed by a hyphen at any length, as before", () => {
    expect(isOwnedRetained("staging", { part: "access", logicalId: "ArtifactBucket", type: "AWS::S3::Bucket", physicalId: "rovara-cloud-staging-access-artifactbucket-1a" }, { "rovara-cloud:env": "staging" })).toBe(true);
  });

  it("refuses another part, another environment's tag, a shortened name that is not 63 characters, and another logical id", () => {
    // Cut inside rovara-cloud-<env>-, the name no longer holds the part, so the logical id binds it: another
    // part's bucket has another logical id. (Cut inside the part, as for live15ea, the part itself is
    // checked: see the live check test above.)
    expect(isOwnedRetained(ENV14, { ...long, part: "slack", logicalId: "SessionArchive1A2B3C4D" }, tagged)).toBe(false);
    expect(isOwnedRetained("live15ea", { part: "slack", logicalId: "SlackThreadSessions6FD21617", type: "AWS::S3::Bucket", physicalId: "rovara-cloud-live15ea-con-slackthreadsessions6fd21-taqjchbygr25" }, { "rovara-cloud:env": "live15ea" })).toBe(false);
    expect(isOwnedRetained(ENV14, long, { "rovara-cloud:env": "abcdefghijklm" })).toBe(false);
    expect(isOwnedRetained(ENV14, { ...long, physicalId: long.physicalId.slice(0, -1) }, tagged)).toBe(false);
    expect(isOwnedRetained(ENV14, { ...long, logicalId: "Artifacts" }, tagged)).toBe(false);
    // A sibling environment prod-c's unshortened bucket, even carrying prod's tag, is refused by the
    // 63-character rule: it is not the full stack name rovara-cloud-prod-control-plane followed by "-".
    const sibling: RetainedResource = { part: "control-plane", logicalId: "State", type: "AWS::S3::Bucket", physicalId: "rovara-cloud-prod-c-foundation-state-1x" };
    expect(isOwnedRetained("prod", sibling, { "rovara-cloud:env": "prod" })).toBe(false);
    // At 63 characters, prod-c's name passes prod's name check (rovara-cloud-prod-c is a start of
    // rovara-cloud-prod-control-plane): only the rovara-cloud:env tag blocks it (re-review R4).
    const shortenedSibling: RetainedResource = { part: "control-plane", logicalId: "SlackThreadSessions6FD21617", type: "AWS::S3::Bucket", physicalId: `rovara-cloud-prod-c-slackthreadsessions6fd21-${"a1".repeat(9)}` };
    expect(shortenedSibling.physicalId).toHaveLength(63);
    expect(isOwnedRetained("prod", shortenedSibling, { "rovara-cloud:env": "prod-c" })).toBe(false);
    expect(isOwnedRetained("prod", shortenedSibling, { "rovara-cloud:env": "prod" })).toBe(true);
  });

  it("never takes a bare rovara or rovara-cloud as the stack-name part of a shortened name (re-review R3)", () => {
    const bare: RetainedResource = { part: "control-plane", logicalId: "SlackThreadSessions6FD21617", type: "AWS::S3::Bucket", physicalId: `rovara-cloud-slackthreadsessions6fd21617-${"b2".repeat(11)}` };
    expect(bare.physicalId).toHaveLength(63);
    expect(isOwnedRetained("live15ea", bare, { "rovara-cloud:env": "live15ea" })).toBe(false);
    const bareRovara: RetainedResource = { ...bare, physicalId: `rovara-slackthreadsessions6fd21617-${"b2".repeat(14)}` };
    expect(bareRovara.physicalId).toHaveLength(63);
    expect(isOwnedRetained("live15ea", bareRovara, { "rovara-cloud:env": "live15ea" })).toBe(false);
  });

  it("keeps the full-prefix rule for tables and log groups, which S3's limit does not shorten", () => {
    for (const type of ["AWS::DynamoDB::Table", "AWS::Logs::LogGroup"]) {
      expect(isOwnedRetained(ENV14, { ...long, type }, tagged), type).toBe(false);
      expect(isOwnedRetained(ENV14, { ...long, type, physicalId: `rovara-cloud-${ENV14}-control-plane-state-1x` }, tagged), type).toBe(true);
    }
  });
});

describe("destroy: the inventory schema", () => {
  it("refuses a GitHub account that could change the printed URL, and duplicate connectors", async () => {
    const store = new MemoryParameterStore();
    const base = { schemaVersion: 1 as const, env: "staging", resources: [] };
    await expect(writeInventory(store, { ...base, github: { account: "acme/../evil", accountType: "organization", slug: "agentx-acme" } })).rejects.toThrow();
    await expect(writeInventory(store, { ...base, connectors: ["linear", "linear"] })).rejects.toThrow();
    await expect(writeInventory(store, { ...base, github: { account: "Acme-Co", accountType: "organization", slug: "agentx-acme" }, connectors: ["linear", "jira"] })).resolves.toBeUndefined();
  });
});

describe("destroy: the inventory of what the stacks retain", () => {
  const template = JSON.stringify({ Resources: {
    State: { Type: "AWS::DynamoDB::Table", DeletionPolicy: "RetainExceptOnCreate" },
    Pool: { Type: "AWS::Cognito::UserPool", DeletionPolicy: "Retain" },
    Fn: { Type: "AWS::Lambda::Function" },
  } });

  it("lists only resources whose DeletionPolicy retains them", () => {
    const found = retainedResources("control-plane", template, [
      { logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "rovara-cloud-staging-control-plane-State-1" },
      { logicalId: "Pool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_X" },
      { logicalId: "Fn", type: "AWS::Lambda::Function", physicalId: "fn" },
      { logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: undefined },
    ]);
    expect(found.map((entry) => entry.logicalId)).toEqual(["State", "Pool"]);
  });

  it("falls back to the retained resource types when the template cannot be parsed", () => {
    expect(retainedResources("foundation", "Resources: yaml", [{ logicalId: "FlowLogs", type: "AWS::Logs::LogGroup", physicalId: "g" }, { logicalId: "Fn", type: "AWS::Lambda::Function", physicalId: "f" }]).map((entry) => entry.logicalId)).toEqual(["FlowLogs"]);
  });

  it("round-trips through SSM, merges without duplicates, and keeps what an earlier run recorded", async () => {
    const store = new MemoryParameterStore();
    const first = mergeInventory(undefined, { env: "staging", resources: [{ part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k-1" }], launchTemplateId: "lt-0123456789abcdef0", slackAppId: "A0APP" });
    await writeInventory(store, first);
    expect(store.values.has(inventoryParameterName("staging"))).toBe(true);
    const stored = await readInventory(store, "staging");
    const second = mergeInventory(stored, { env: "staging", resources: [{ part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k-1" }, { part: "identity", logicalId: "Pool", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_X" }] });
    expect(second.resources).toHaveLength(2);
    expect(second.launchTemplateId).toBe("lt-0123456789abcdef0");
    expect(second.slackAppId).toBe("A0APP");
  });

  const generated: RetainedResource[] = [
    { part: "control-plane", logicalId: "State1C20CC9A", type: "AWS::DynamoDB::Table", physicalId: "rovara-cloud-staging-control-plane-State1C20CC9A-ABCDEFGHIJKLM" },
    { part: "control-plane", logicalId: "TurnRecords69ECFCD9", type: "AWS::DynamoDB::Table", physicalId: "rovara-cloud-staging-control-plane-TurnRecords69ECFCD9-ABCDEFGHIJKLM" },
    { part: "control-plane", logicalId: "Artifacts82DD59A1", type: "AWS::S3::Bucket", physicalId: "rovara-cloud-staging-control-plane-artifacts82dd59a1-abcdefghijklm" },
    { part: "control-plane", logicalId: "SlackSecretEA96F13F", type: "AWS::SecretsManager::Secret", physicalId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rovara-cloud/staging/slack-AbCdEf" },
    { part: "foundation", logicalId: "VpcFlowLogsE6FFDEF9", type: "AWS::Logs::LogGroup", physicalId: "rovara-cloud-staging-foundation-VpcFlowLogsE6FFDEF9-ABCDEFGHIJKLM" },
    { part: "identity", logicalId: "UserPool6BA7E5F2", type: "AWS::Cognito::UserPool", physicalId: "us-east-1_AbCdEfGhI" },
    // A name that only looks generated by another stack is stored as it is.
    { part: "slack", logicalId: "Logs6819BB44", type: "AWS::Logs::LogGroup", physicalId: "rovara-cloud-staging-foundation-Logs6819BB44-X" },
  ];

  it("stores the inventory compactly (schema 2): each stack part and type once, and the stack name derived from the environment", async () => {
    const store = new MemoryParameterStore();
    await writeInventory(store, mergeInventory(undefined, { env: "staging", resources: generated, slackAppId: "A0APP" }));
    const stored = JSON.parse(store.values.get(inventoryParameterName("staging")) ?? "") as Record<string, unknown>;
    expect(stored).toEqual({
      schemaVersion: 2, env: "staging", slackAppId: "A0APP",
      resources: {
        "control-plane": {
          "AWS::DynamoDB::Table": [["State1C20CC9A", "-ABCDEFGHIJKLM", "sl"], ["TurnRecords69ECFCD9", "-ABCDEFGHIJKLM", "sl"]],
          "AWS::S3::Bucket": [["Artifacts82DD59A1", "artifacts82dd59a1-abcdefghijklm", "s"]],
          "AWS::SecretsManager::Secret": [["SlackSecretEA96F13F", "arn:aws:secretsmanager:us-east-1:123456789012:secret:rovara-cloud/staging/slack-AbCdEf"]],
        },
        foundation: { "AWS::Logs::LogGroup": [["VpcFlowLogsE6FFDEF9", "-ABCDEFGHIJKLM", "sl"]] },
        identity: { "AWS::Cognito::UserPool": [["UserPool6BA7E5F2", "us-east-1_AbCdEfGhI"]] },
        slack: { "AWS::Logs::LogGroup": [["Logs6819BB44", "rovara-cloud-staging-foundation-Logs6819BB44-X"]] },
      },
    });
    const read = await readInventory(store, "staging");
    expect(read?.resources).toEqual(generated);
    expect(read?.slackAppId).toBe("A0APP");
  });

  it("refuses a schema 2 inventory with a stack part or an entry it does not know", async () => {
    const store = new MemoryParameterStore();
    await store.put(inventoryParameterName("staging"), JSON.stringify({ schemaVersion: 2, env: "staging", resources: { elsewhere: { "AWS::KMS::Key": [["Key", "k-1"]] } } }));
    await expect(readInventory(store, "staging")).rejects.toThrow(/is not a rovara destroy inventory/);
    await store.put(inventoryParameterName("staging"), JSON.stringify({ schemaVersion: 2, env: "staging", resources: { foundation: { "AWS::KMS::Key": [["Key", "k-1", "x"]] } } }));
    await expect(readInventory(store, "staging")).rejects.toThrow(/is not a rovara destroy inventory/);
  });

  it("still reads an inventory an earlier agentx wrote in schema 1, and rewrites it in schema 2", async () => {
    const store = new MemoryParameterStore();
    const old = { schemaVersion: 1, env: "staging", resources: generated, launchTemplateId: "lt-0123456789abcdef0", github: { account: "acme", accountType: "organization", slug: "agentx-acme" }, connectors: ["linear"] };
    await store.put(inventoryParameterName("staging"), JSON.stringify(old));
    const read = await readInventory(store, "staging");
    expect(read).toEqual(old);
    await writeInventory(store, mergeInventory(read, { env: "staging", resources: [] }));
    expect(JSON.parse(store.values.get(inventoryParameterName("staging")) ?? "")).toMatchObject({ schemaVersion: 2, launchTemplateId: "lt-0123456789abcdef0" });
    expect((await readInventory(store, "staging"))?.resources).toEqual(generated);
  });
});

describe("destroy: confirmation (question 1)", () => {
  it("asks for the environment's name, and also the account id for production or an environment AgentX has no record of", () => {
    expect(confirmationPrompts({ env: "staging", account: "123456789012", recorded: true }).map((prompt) => prompt.expected)).toEqual(["staging"]);
    expect(confirmationPrompts({ env: "production", account: "123456789012", recorded: true }).map((prompt) => prompt.expected)).toEqual(["production", "123456789012"]);
    expect(confirmationPrompts({ env: "staging", account: "123456789012", recorded: false }).map((prompt) => prompt.expected)).toEqual(["staging", "123456789012"]);
  });
});

describe("destroy: what is shown before, and printed after", () => {
  it("shows every stack in order, the workers with the workspace warning, what is kept, and the slow control-plane delete", () => {
    const lines = destroyPlanText({
      env: "staging", account: "123456789012", region: "us-east-1",
      stacks: [{ name: "rovara-cloud-staging-slack", status: "UPDATE_COMPLETE" }, { name: "rovara-cloud-staging-control-plane", status: "UPDATE_COMPLETE" }],
      instances: 1, volumes: 2, secrets: 5, parameters: 9, localFiles: ["/home/a/.agentx/environments/staging.yaml"], keepData: false,
      resources: [{ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" }, { part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k" }],
    });
    expect(lines[0]).toBe("This deletes AgentX environment staging in account 123456789012, region us-east-1:");
    expect(lines).toContain("  stacks, in this order: rovara-cloud-staging-slack (UPDATE_COMPLETE), rovara-cloud-staging-control-plane (UPDATE_COMPLETE)");
    expect(lines).toContain("  EC2 workers: 1 instance and 2 workspace volumes; deleting the volumes deletes every worker session's workspace");
    expect(lines).toContain("  what the stacks keep, deleted after them: 1 table and 1 KMS key (deleted after 7 days)");
    expect(lines).toContain("  Deleting rovara-cloud-staging-control-plane usually takes 20 to 40 minutes: its Lambda functions release their network interfaces slowly.");
    expect(lines.at(-1)).toBe("Nothing here can be undone.");
    const kept = destroyPlanText({ env: "staging", account: "123456789012", region: "us-east-1", stacks: [], instances: 0, volumes: 0, secrets: 5, parameters: 1, localFiles: [], keepData: true, resources: [{ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" }] });
    expect(kept).toContain("  --keep-data keeps: 1 table and 5 secrets");
  });

  it("lists a kept KMS key without the deletion note, and keeps the note where the key is deleted (live check L4)", () => {
    const resources: RetainedResource[] = [
      { part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" },
      { part: "foundation", logicalId: "Key", type: "AWS::KMS::Key", physicalId: "k" },
    ];
    const plan = { env: "staging", account: "123456789012", region: "us-east-1", stacks: [], instances: 0, volumes: 0, secrets: 5, parameters: 1, localFiles: [], resources };
    const kept = destroyPlanText({ ...plan, keepData: true });
    expect(kept).toContain("  --keep-data keeps: 1 table, 1 KMS key and 5 secrets");
    expect(kept.join("\n")).not.toContain("deleted after 7 days");
    const two = destroyPlanText({ ...plan, keepData: true, resources: [...resources, { part: "foundation", logicalId: "Key2", type: "AWS::KMS::Key", physicalId: "k2" }] });
    expect(two).toContain("  --keep-data keeps: 1 table, 2 KMS keys and 5 secrets");
    expect(destroyPlanText({ ...plan, keepData: false })).toContain("  what the stacks keep, deleted after them: 1 table and 1 KMS key (deleted after 7 days)");
  });

  it("counts the stacks' secrets once, with the secrets under rovara-cloud/<env>/, and joins lists as a, b and c", () => {
    const resources: RetainedResource[] = [
      { part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" },
      { part: "identity", logicalId: "Pool", type: "AWS::Cognito::UserPool", physicalId: "p" },
      { part: "control-plane", logicalId: "SlackSecret", type: "AWS::SecretsManager::Secret", physicalId: "rovara-cloud/staging/slack" },
    ];
    const plan = { env: "staging", account: "123456789012", region: "us-east-1", stacks: [], instances: 0, volumes: 0, secrets: 5, parameters: 1, localFiles: [], resources };
    const all = destroyPlanText({ ...plan, keepData: false });
    expect(all).toContain("  what the stacks keep, deleted after them: 1 table and 1 Cognito user pool");
    expect(all).toContain("  secrets: 5 secrets under rovara-cloud/staging/, deleted without recovery");
    expect(destroyPlanText({ ...plan, keepData: true })).toContain("  --keep-data keeps: 1 table, 1 Cognito user pool and 5 secrets");
  });

  it("prints the GitHub App and Slack app pages to delete them, and the connector credentials to revoke", () => {
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [], github: { account: "acme", accountType: "organization", slug: "agentx-acme" }, slackAppId: "A0APP", connectors: ["linear"] })).toEqual([
      "Delete the GitHub App agentx-acme: open https://github.com/organizations/acme/settings/apps/agentx-acme/advanced and choose Delete GitHub App.",
      "Delete the Slack app: open https://api.slack.com/apps/A0APP/general and choose Delete App at the bottom of the page.",
      "Revoke the Linear API key AgentX used: Linear, Settings, Security and access, API keys.",
    ]);
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [], github: { account: "alice", accountType: "user", slug: "agentx-alice" } })[0]).toBe("Delete the GitHub App agentx-alice: open https://github.com/settings/apps/agentx-alice/advanced and choose Delete GitHub App.");
    expect(vendorSteps({ schemaVersion: 1, env: "staging", resources: [] })).toEqual([
      "Delete the environment's GitHub App, if it had one: https://github.com/settings/apps (for an organization: its Settings, Developer settings, GitHub Apps), then Advanced, Delete GitHub App.",
      "Delete the environment's Slack app, if it had one: https://api.slack.com/apps, the app, then Delete App at the bottom of Basic Information.",
    ]);
  });
});

describe("destroy: matching a secret by name or ARN", () => {
  it("matches the name itself or its ARN with Secrets Manager's six-character suffix, never a longer name", () => {
    expect(isSecretId("rovara-cloud/staging/github", "rovara-cloud/staging/github")).toBe(true);
    expect(isSecretId("arn:aws:secretsmanager:us-east-1:1:secret:rovara-cloud/staging/github-AbC123", "rovara-cloud/staging/github")).toBe(true);
    expect(isSecretId("arn:aws:secretsmanager:us-east-1:1:secret:rovara-cloud/staging/github-app-AbC123", "rovara-cloud/staging/github")).toBe(false);
    expect(isSecretId("arn:aws:secretsmanager:us-east-1:1:secret:rovara-cloud/staging/github-app-AbC123", "rovara-cloud/staging/github-app")).toBe(true);
    expect(isSecretId("arn:aws:secretsmanager:us-east-1:1:secret:rovara-cloud/staging/a.b-AbC123", "rovara-cloud/staging/aXb")).toBe(false);
  });
});
