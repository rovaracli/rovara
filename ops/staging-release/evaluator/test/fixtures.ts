/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- the tests build and break plain CloudFormation JSON at a path, which a typed document would not allow */
// Test fixtures: complete, routine (AUTO) evaluator inputs for the Code and the Cloud pipeline, built from the REAL policy files.
// Fixtures use fake ids only (account 111111111111). Every attack test clones one and breaks one thing.
import { readFileSync } from "node:fs";
import { manifestHash } from "../src/evaluate.ts";
import { sha256Hex } from "../src/util.ts";

export type Obj = Record<string, any>;

export const ACCT = "111111111111";
export const hex = (c: string, n = 40): string => c.repeat(n).slice(0, n);
export const SHA = hex("b");
export const PREV = hex("a");
export const TREE = hex("c");
export const TREE12 = TREE.slice(0, 12);
export const NOW = "2026-11-23T12:00:00Z";
export const REPO_HOST = `${ACCT}.dkr.ecr.us-west-2.amazonaws.com`;
export const KNOWN = "{{changeSet:KNOWN_AFTER_APPLY}}";
export const SHA512 = `sha512-${"A".repeat(86)}==`;
const dig = (c: string): string => `sha256:${hex(c, 64)}`;
export const OLD = { worker: dig("1"), slack: dig("2"), gateway: dig("3") };
export const NEW = { worker: dig("4"), slack: dig("5"), gateway: dig("6") };
export const uri = (repo: string, digest: string): string => `${REPO_HOST}/${repo}@${digest}`;

const policyDir = new URL("../../policy/", import.meta.url);
export const POLICY_TEXT = {
  "auto-approve-policy.json": readFileSync(new URL("auto-approve-policy.json", policyDir), "utf8"),
  "manual-paths.txt": readFileSync(new URL("manual-paths.txt", policyDir), "utf8"),
  "rollback-floor.txt": readFileSync(new URL("rollback-floor.txt", policyDir), "utf8"),
};

export function manifestFor(files: Record<string, string>): { path: string; sha256: string }[] {
  return [
    ...Object.entries(files).map(([path, text]) => ({ path: `./policy/${path}`, sha256: sha256Hex(text) })),
    { path: "./evaluator/src/evaluate.ts", sha256: sha256Hex("evaluator code") },
    { path: "./order.txt", sha256: sha256Hex("control-plane runtime slack foundation identity") },
  ];
}

export function repin(input: Obj): void {
  input.policyManifest = manifestFor(input.policyFiles);
  input.policyPin = manifestHash(input.policyManifest);
}

// ---------- row and detail builders (the shapes CloudFormation emits, from golden-cases.json) ----------

export function detail(attribute: string, name: string | null, path: string | null, source: string, evaluation: string, extra: Obj = {}): Obj {
  const target: Obj = { Attribute: attribute, RequiresRecreation: "Never", AttributeChangeType: "Modify" };
  if (name !== null) target.Name = name;
  if (path !== null) target.Path = path;
  for (const k of ["BeforeValue", "AfterValue", "RequiresRecreation", "AttributeChangeType"]) if (k in extra) target[k] = extra[k];
  const d: Obj = { Target: target, Evaluation: evaluation, ChangeSource: source };
  if (extra.CausingEntity !== undefined) d.CausingEntity = extra.CausingEntity;
  return d;
}

export const META_KEYS = ["aws:cdk:path", "aws:asset:path", "aws:asset:is-bundled", "aws:asset:property"];
export const metaDetails = (keys: string[] = META_KEYS): Obj[] => keys.map((k) => detail("Metadata", null, `/Metadata/${k}`, "DirectModification", "Static", { AttributeChangeType: "Remove" }));

export function row(logicalId: string, type: string, action: string, replacement: string | null, scope: string[], details: Obj[], extra: Obj = {}): Obj {
  const rc: Obj = { Action: action, LogicalResourceId: logicalId, ResourceType: type, Scope: scope, Details: details, ...extra };
  if (replacement !== null) rc.Replacement = replacement;
  return { Type: "Resource", ResourceChange: rc };
}

export const metaRow = (id: string, type: string): Obj => row(id, type, "Modify", "False", ["Metadata"], metaDetails());
export const cdkMetaRow = (): Obj => row("CDKMetadata", "AWS::CDK::Metadata", "Remove", null, [], []);

const META_BLOCK = (id: string): Obj => ({ "aws:cdk:path": `stack/${id}/Resource`, "aws:asset:path": "asset.x", "aws:asset:is-bundled": false, "aws:asset:property": "Code" });

export const lambdaRes = (id: string, key: string, withMeta: boolean): Obj => ({
  Type: "AWS::Lambda::Function",
  Properties: { Code: { S3Bucket: "cdk-assets-us-west-2", S3Key: key }, Handler: "index.handler", Environment: { Variables: { LOG: "info" } } },
  ...(withMeta ? { Metadata: META_BLOCK(id) } : {}),
});

export const codeKey = (c: string): string => `${hex(c, 64)}.zip`;

export function lambdaRow(id: string, from: string, to: string): Obj {
  return row(id, "AWS::Lambda::Function", "Modify", "False", ["Metadata", "Properties"], [
    ...metaDetails(),
    detail("Properties", "Code", "/Properties/Code/S3Key", "DirectModification", "Static", { BeforeValue: codeKey(from), AfterValue: codeKey(to) }),
  ]);
}

export const param = (key: string, value: string): Obj => ({ ParameterKey: key, ParameterValue: value });

export interface StackFixture {
  stackName: string;
  changeSet: Obj;
  liveTemplate: Obj;
  newTemplate: Obj;
  liveParameters: Obj[];
}

export function stackFixture(name: string, o: { live: Obj; next: Obj; changes: Obj[]; liveParams?: Obj[]; csParams?: Obj[]; templateParams?: Obj; liveConditions?: Obj; newConditions?: Obj }): StackFixture {
  const base = (resources: Obj, conditions: Obj | undefined): Obj => ({ Parameters: o.templateParams ?? {}, ...(conditions === undefined ? {} : { Conditions: conditions }), Resources: resources });
  const noChanges = o.changes.length === 0;
  return {
    stackName: name,
    changeSet: noChanges
      ? { Status: "FAILED", StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set.", Changes: [], Parameters: o.csParams ?? o.liveParams ?? [], Capabilities: [] }
      : { Status: "CREATE_COMPLETE", Changes: o.changes, Parameters: o.csParams ?? o.liveParams ?? [], Capabilities: ["CAPABILITY_IAM"] },
    liveTemplate: base(o.live, o.liveConditions),
    newTemplate: base(o.next, o.newConditions),
    liveParameters: o.liveParams ?? [],
  };
}

const CONDITIONS_LIVE = { CDKMetadataAvailable: { "Fn::Equals": [{ Ref: "AWS::Region" }, "us-west-2"] }, UseX: { "Fn::Equals": ["a", "a"] } };
const CONDITIONS_NEW = { UseX: { "Fn::Equals": ["a", "a"] } };

/** Resources every Code stack has: the CDKMetadata resource (live only) and one metadata-only role row. */
function commonMeta(live: Obj, next: Obj, changes: Obj[], tag: string): void {
  live.CDKMetadata = { Type: "AWS::CDK::Metadata", Properties: { Analytics: "v2:abc" }, Condition: "CDKMetadataAvailable" };
  const id = `Role${tag}`;
  live[id] = { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Statement: [] } }, Metadata: { "aws:cdk:path": `x/${id}` } };
  next[id] = { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Statement: [] } } };
  changes.push(metaRow(id, "AWS::IAM::Role"), cdkMetaRow());
}

// ---------- images, gates, CI, locks ----------

export const imageEntry = (repo: string, digest: string, source = "built"): Obj => ({ repo, digest, source, tags: [`tree-${TREE12}`, "other"], inEcr: true });

export function ciRun(extra: Obj = {}, jobs: string[] = ["local"]): Obj {
  const head = hex("d");
  return {
    id: 4242,
    path: ".github/workflows/ci.yml",
    head_sha: head,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "rovaracli/rovara" },
    head_repository: { full_name: "rovaracli/rovara" },
    head_commit: { tree_id: TREE },
    jobs: jobs.map((name) => ({ name, status: "completed", conclusion: "success", head_sha: head })),
    checkRuns: jobs.map((name) => ({ name, conclusion: "success", app: { slug: "github-actions" } })),
    ...extra,
  };
}

const gate = (name: string, extra: Obj = {}): Obj => ({ name, sha: SHA, writtenAt: "2026-11-23T11:50:00Z", result: "pass", ...extra });

// ---------- the Code release (control-plane Lambdas + signing-key secret, runtime image, slack image) ----------

export function codeInput(): Obj {
  const stacks: StackFixture[] = [];
  {
    const live: Obj = {};
    const next: Obj = {};
    const changes: Obj[] = [];
    for (const [id, a, b] of [["BrokerE1355FD6", "1", "2"], ["DispatcherD4A12972", "3", "4"]] as const) {
      live[id] = lambdaRes(id, codeKey(a), true);
      next[id] = lambdaRes(id, codeKey(b), false);
      changes.push(lambdaRow(id, a, b));
    }
    live.CallbackSigningKeySecret28D4CB19 = { Type: "AWS::SecretsManager::Secret", Properties: { Name: "agentx/staging/callback-key", SecretString: { Ref: "CallbackSigningKey" } }, DeletionPolicy: "RetainExceptOnCreate", UpdateReplacePolicy: "Retain", Metadata: { "aws:cdk:path": "cp/Secret" } };
    next.CallbackSigningKeySecret28D4CB19 = { Type: "AWS::SecretsManager::Secret", Properties: { Name: "agentx/staging/callback-key", SecretString: { Ref: "CallbackSigningKey" } }, DeletionPolicy: "RetainExceptOnCreate", UpdateReplacePolicy: "Retain" };
    changes.push(row("CallbackSigningKeySecret28D4CB19", "AWS::SecretsManager::Secret", "Modify", "False", ["Metadata", "Properties"], [
      detail("Properties", "SecretString", "/Properties/SecretString", "ParameterReference", "Static", { CausingEntity: "CallbackSigningKey", BeforeValue: "****", AfterValue: "****" }),
      ...metaDetails(["aws:cdk:path"]),
      detail("Properties", "SecretString", "/Properties/SecretString", "DirectModification", "Dynamic", { BeforeValue: "****", AfterValue: "****" }),
    ]));
    commonMeta(live, next, changes, "CP");
    stacks.push(stackFixture("agentx-staging-control-plane", {
      live, next, changes,
      liveParams: [param("CallbackSigningKey", "****"), param("StageName", "staging")],
      csParams: [param("CallbackSigningKey", "****"), param("StageName", "staging")],
      templateParams: { CallbackSigningKey: { Type: "String", NoEcho: true }, StageName: { Type: "String" } },
      liveConditions: CONDITIONS_LIVE, newConditions: CONDITIONS_NEW,
    }));
  }
  {
    const live: Obj = { WorkerImageParameter7CA9ADBB: { Type: "AWS::SSM::Parameter", Properties: { Type: "String", Value: { Ref: "WorkerImageUri" } }, Metadata: { "aws:cdk:path": "rt/p" } } };
    const next: Obj = { WorkerImageParameter7CA9ADBB: { Type: "AWS::SSM::Parameter", Properties: { Type: "String", Value: { Ref: "WorkerImageUri" } } } };
    const changes: Obj[] = [row("WorkerImageParameter7CA9ADBB", "AWS::SSM::Parameter", "Modify", "False", ["Metadata", "Properties"], [
      detail("Properties", "Value", "/Properties/Value", "DirectModification", "Dynamic", { BeforeValue: uri("agentx-staging/worker", OLD.worker), AfterValue: uri("agentx-staging/worker", NEW.worker) }),
      ...metaDetails(["aws:cdk:path"]),
      detail("Properties", "Value", "/Properties/Value", "ParameterReference", "Static", { CausingEntity: "WorkerImageUri", BeforeValue: uri("agentx-staging/worker", OLD.worker), AfterValue: uri("agentx-staging/worker", NEW.worker) }),
    ])];
    commonMeta(live, next, changes, "RT");
    stacks.push(stackFixture("agentx-staging-runtime", {
      live, next, changes,
      liveParams: [param("WorkerImageUri", uri("agentx-staging/worker", OLD.worker)), param("Other", "x")],
      csParams: [param("WorkerImageUri", uri("agentx-staging/worker", NEW.worker)), param("Other", "x")],
      templateParams: { WorkerImageUri: { Type: "String" }, Other: { Type: "String" } },
      liveConditions: CONDITIONS_LIVE, newConditions: CONDITIONS_NEW,
    }));
  }
  {
    const taskDef = (withMeta: boolean): Obj => ({
      Type: "AWS::ECS::TaskDefinition",
      Properties: { Family: "slack-orchestrator", ContainerDefinitions: [{ Name: "orch", Image: { Ref: "OrchestratorImageUri" }, Environment: [{ Name: "A", Value: "1" }] }], TaskRoleArn: { "Fn::GetAtt": ["Role", "Arn"] } },
      ...(withMeta ? { Metadata: { "aws:cdk:path": "slack/td" } } : {}),
    });
    const service = (withMeta: boolean): Obj => ({ Type: "AWS::ECS::Service", Properties: { TaskDefinition: { Ref: "TaskDefinition" }, DesiredCount: 1 }, ...(withMeta ? { Metadata: { "aws:cdk:path": "slack/svc" } } : {}) });
    const live: Obj = { TaskDefinition: taskDef(true), Service: service(true) };
    const next: Obj = { TaskDefinition: taskDef(false), Service: service(false) };
    const changes: Obj[] = [
      row("TaskDefinition", "AWS::ECS::TaskDefinition", "Modify", "True", ["Metadata", "Properties"], [
        ...metaDetails(["aws:cdk:path"]),
        detail("Properties", "ContainerDefinitions", "/Properties/ContainerDefinitions/0/Image", "DirectModification", "Dynamic", { RequiresRecreation: "Always", BeforeValue: uri("agentx-staging/slack", OLD.slack), AfterValue: uri("agentx-staging/slack", NEW.slack) }),
        detail("Properties", "ContainerDefinitions", "/Properties/ContainerDefinitions/0/Image", "ParameterReference", "Static", { RequiresRecreation: "Always", CausingEntity: "OrchestratorImageUri", BeforeValue: uri("agentx-staging/slack", OLD.slack), AfterValue: uri("agentx-staging/slack", NEW.slack) }),
      ], { PolicyAction: "ReplaceAndDelete" }),
      row("Service", "AWS::ECS::Service", "Modify", "False", ["Metadata", "Properties"], [
        detail("Properties", "TaskDefinition", "/Properties/TaskDefinition", "ResourceReference", "Static", { CausingEntity: "TaskDefinition", AfterValue: KNOWN }),
        ...metaDetails(["aws:cdk:path"]),
        detail("Properties", "TaskDefinition", "/Properties/TaskDefinition", "DirectModification", "Dynamic", { AfterValue: KNOWN }),
      ]),
    ];
    commonMeta(live, next, changes, "SL");
    stacks.push(stackFixture("agentx-staging-slack", {
      live, next, changes,
      liveParams: [param("OrchestratorImageUri", uri("agentx-staging/slack", OLD.slack)), param("ExecutorImageUri", "none")],
      csParams: [param("OrchestratorImageUri", uri("agentx-staging/slack", NEW.slack)), param("ExecutorImageUri", "none")],
      templateParams: { OrchestratorImageUri: { Type: "String" }, ExecutorImageUri: { Type: "String" } },
      liveConditions: CONDITIONS_LIVE, newConditions: CONDITIONS_NEW,
    }));
  }
  for (const name of ["agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-access"]) {
    const live: Obj = {};
    const next: Obj = {};
    const changes: Obj[] = [];
    commonMeta(live, next, changes, name.slice(15, 18).toUpperCase());
    stacks.push(stackFixture(name, { live, next, changes, liveConditions: CONDITIONS_LIVE, newConditions: CONDITIONS_NEW }));
  }
  const input: Obj = {
    pipeline: "code",
    sha: SHA,
    previousInstalledSha: PREV,
    tree: TREE,
    now: NOW,
    environment: { accountId: ACCT, region: "us-west-2" },
    checkMode: "auto-eligible",
    holdParameters: [],
    unauditedAutoRuns: 0,
    trigger: { kind: "push", variables: {} },
    ancestry: { installedIsAncestorOfSha: true },
    policyFiles: { ...POLICY_TEXT },
    changedPaths: ["packages/cloud-server/src/a.ts", "tests/unit/a.test.ts", "docs/safe-action.md"],
    releaseNotes: [],
    stacks,
    images: [imageEntry("agentx-staging/worker", NEW.worker), imageEntry("agentx-staging/slack", NEW.slack, "reused")],
    gates: [
      gate("25-gate"), gate("15-gate"), gate("45-gate"),
      gate("46-gate", { result: "skipped", skippedReason: "DEC 254zzz397" }),
      gate("gate-gateway-deployed"), gate("gate-gateway-runprice"),
      gate("50-dry-run", { failures: ["ready-guard"] }),
    ],
    ci: { apiError: null, runs: [ciRun({}, ["local", "ci-mode (full)"])] },
    answers: { lastGood: JSON.stringify({ company: "x", images: { worker: uri("agentx-staging/worker", OLD.worker), slack: uri("agentx-staging/slack", OLD.slack) } }), current: JSON.stringify({ company: "x", images: { worker: uri("agentx-staging/worker", NEW.worker), slack: uri("agentx-staging/slack", NEW.slack) } }) },
    overrides: { lastGood: JSON.stringify({ images: { worker: uri("agentx-staging/worker", OLD.worker) }, flags: {} }), current: JSON.stringify({ images: { worker: uri("agentx-staging/worker", NEW.worker) }, flags: {} }) },
  };
  repin(input);
  return input;
}

// ---------- the Cloud release (gateway image change + web) ----------

export const GW = {
  serve: "ServeTaskF1990141",
  fetch: "PriceFetchTask7EDA4B48",
  service: "ServiceD69D759B",
  schedule: "PriceFetchScheduleAD6AA82A",
  policy: "PriceFetchTaskEventsRoleDefaultPolicyE756D0DB",
};

export function policyDocument(): Obj {
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "ecs:TagResource", Resource: "*" },
      { Effect: "Allow", Action: "ecs:RunTask", Resource: { Ref: GW.fetch }, Condition: { ArnEquals: { "ecs:cluster": { "Fn::GetAtt": ["Cluster", "Arn"] } } } },
      { Effect: "Allow", Action: "iam:PassRole", Resource: [{ "Fn::GetAtt": ["PriceFetchTaskRole", "Arn"] }, { "Fn::GetAtt": ["PriceFetchExecutionRole", "Arn"] }] },
    ],
  };
}

export function cloudInput(): Obj {
  const stacks: StackFixture[] = [];
  {
    const taskDef = (family: string): Obj => ({
      Type: "AWS::ECS::TaskDefinition",
      Properties: { Family: family, ContainerDefinitions: [{ Name: family, Image: { "Fn::Join": ["", [{ Ref: "AWS::AccountId" }, ".dkr.ecr.us-west-2.amazonaws.com/rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc@", { Ref: "ImageDigest" }]] }, Environment: [{ Name: "MODE", Value: "serve" }] }], TaskRoleArn: { "Fn::GetAtt": ["Role", "Arn"] }, ExecutionRoleArn: { "Fn::GetAtt": ["ExecRole", "Arn"] } },
    });
    const live: Obj = {
      [GW.serve]: taskDef("serve"),
      [GW.fetch]: taskDef("price-fetch"),
      [GW.service]: { Type: "AWS::ECS::Service", Properties: { TaskDefinition: { Ref: GW.serve }, DesiredCount: 2 } },
      [GW.schedule]: { Type: "AWS::Events::Rule", Properties: { ScheduleExpression: "rate(1 day)", Targets: [{ Arn: { "Fn::GetAtt": ["Cluster", "Arn"] }, EcsParameters: { TaskDefinitionArn: { Ref: GW.fetch }, TaskCount: 1 } }] } },
      [GW.policy]: { Type: "AWS::IAM::Policy", Properties: { PolicyName: "PriceFetchTaskEventsRoleDefaultPolicy", PolicyDocument: policyDocument(), Roles: [{ Ref: "PriceFetchTaskEventsRole" }] } },
    };
    const next = JSON.parse(JSON.stringify(live)) as Obj;
    const changes: Obj[] = [
      row(GW.serve, "AWS::ECS::TaskDefinition", "Modify", "True", ["Properties"], [
        detail("Properties", "ContainerDefinitions", "/Properties/ContainerDefinitions", "DirectModification", "Static", { RequiresRecreation: "Always", BeforeValue: "(Truncated-Signature):aaaa", AfterValue: "(Truncated-Signature):bbbb" }),
      ], { PolicyAction: "ReplaceAndDelete" }),
      row(GW.fetch, "AWS::ECS::TaskDefinition", "Modify", "True", ["Properties"], [
        detail("Properties", "ContainerDefinitions", "/Properties/ContainerDefinitions/0/Image", "ParameterReference", "Static", { RequiresRecreation: "Always", CausingEntity: "ImageDigest", BeforeValue: uri("rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc", OLD.gateway), AfterValue: uri("rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc", NEW.gateway) }),
        detail("Properties", "ContainerDefinitions", "/Properties/ContainerDefinitions/0/Image", "DirectModification", "Dynamic", { RequiresRecreation: "Always", BeforeValue: uri("rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc", OLD.gateway), AfterValue: uri("rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc", NEW.gateway) }),
      ], { PolicyAction: "ReplaceAndDelete" }),
      row(GW.service, "AWS::ECS::Service", "Modify", "False", ["Properties"], [
        detail("Properties", "TaskDefinition", "/Properties/TaskDefinition", "DirectModification", "Dynamic", { AfterValue: KNOWN }),
        detail("Properties", "TaskDefinition", "/Properties/TaskDefinition", "ResourceReference", "Static", { CausingEntity: GW.serve, AfterValue: KNOWN }),
      ]),
      row(GW.schedule, "AWS::Events::Rule", "Modify", "False", ["Properties"], [
        detail("Properties", "Targets", "/Properties/Targets/0/EcsParameters/TaskDefinitionArn", "DirectModification", "Dynamic", { AfterValue: KNOWN }),
        detail("Properties", "Targets", "/Properties/Targets/0/EcsParameters/TaskDefinitionArn", "ResourceReference", "Static", { CausingEntity: GW.fetch, AfterValue: KNOWN }),
      ]),
      row(GW.policy, "AWS::IAM::Policy", "Modify", "False", ["Properties"], [
        detail("Properties", "PolicyDocument", "/Properties/PolicyDocument/Statement/1/Resource", "DirectModification", "Static", { AfterValue: KNOWN }),
      ]),
    ];
    stacks.push(stackFixture("rovara-cloud-staging-gateway", {
      live, next, changes,
      liveParams: [param("ImageDigest", OLD.gateway), param("CertificateArn", "arn:aws:acm:us-west-2:111111111111:certificate/x")],
      csParams: [param("ImageDigest", NEW.gateway), param("CertificateArn", "arn:aws:acm:us-west-2:111111111111:certificate/x")],
      templateParams: { ImageDigest: { Type: "String" }, CertificateArn: { Type: "String" } },
    }));
  }
  {
    const live: Obj = {
      Server7E7D21FA: lambdaRes("Server7E7D21FA", codeKey("1"), false),
      AppFilesCustomResource512MiBE2CB5759: { Type: "Custom::CDKBucketDeployment", Properties: { ServiceToken: "arn", SourceBucketNames: ["assets"], SourceObjectKeys: [codeKey("7")], SourceMarkers: [{}], DestinationBucketName: "web" } },
    };
    const next = JSON.parse(JSON.stringify(live)) as Obj;
    next.Server7E7D21FA.Properties.Code.S3Key = codeKey("2");
    next.AppFilesCustomResource512MiBE2CB5759.Properties.SourceObjectKeys = [codeKey("8")];
    const changes: Obj[] = [
      row("Server7E7D21FA", "AWS::Lambda::Function", "Modify", "False", ["Properties"], [detail("Properties", "Code", "/Properties/Code/S3Key", "DirectModification", "Static", { BeforeValue: codeKey("1"), AfterValue: codeKey("2") })]),
      row("AppFilesCustomResource512MiBE2CB5759", "Custom::CDKBucketDeployment", "Modify", "Conditional", ["Properties"], [detail("Properties", "SourceObjectKeys", "/Properties/SourceObjectKeys/0", "DirectModification", "Static", { BeforeValue: codeKey("7"), AfterValue: codeKey("8") })]),
    ];
    stacks.push(stackFixture("rovara-cloud-staging-web", { live, next, changes }));
  }
  for (const name of ["rovara-cloud-staging-gateway-images", "rovara-cloud-staging-app"]) {
    const res: Obj = { Repo: { Type: "AWS::ECR::Repository", Properties: {} } };
    stacks.push(stackFixture(name, { live: res, next: JSON.parse(JSON.stringify(res)) as Obj, changes: [] }));
  }
  const input: Obj = {
    pipeline: "cloud",
    sha: SHA,
    previousInstalledSha: PREV,
    tree: TREE,
    now: NOW,
    environment: { accountId: ACCT, region: "us-west-2" },
    checkMode: "auto-eligible",
    holdParameters: [],
    unauditedAutoRuns: 0,
    trigger: { kind: "push", variables: {} },
    ancestry: { installedIsAncestorOfSha: true },
    policyFiles: { ...POLICY_TEXT },
    changedPaths: ["packages/model-gateway/src/a.ts", "packages/web/src/b.tsx", "tests/unit/a.test.ts"],
    releaseNotes: [],
    stacks,
    images: [imageEntry("rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc", NEW.gateway)],
    gates: [gate("16-gate"), gate("16b-gate"), gate("16c-gate"), gate("gate-gateway-runprice")],
    ci: { apiError: null, runs: [ciRun()] },
    answers: { lastGood: JSON.stringify({ images: { gateway: OLD.gateway }, x: 1 }), current: JSON.stringify({ images: { gateway: NEW.gateway }, x: 1 }) },
    overrides: { lastGood: JSON.stringify({ images: { gateway: OLD.gateway } }), current: JSON.stringify({ images: { gateway: NEW.gateway } }) },
  };
  repin(input);
  return input;
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const stackIn = (input: Obj, name: string): Obj => {
  const found = (input.stacks as Obj[]).find((s) => s.stackName === name);
  if (found === undefined) throw new Error(`no stack ${name}`);
  return found;
};

export const changesOf = (input: Obj, stack: string): Obj[] => stackIn(input, stack).changeSet.Changes as Obj[];

export const rowIn = (input: Obj, stack: string, id: string): Obj => {
  const found = changesOf(input, stack).find((c) => c.ResourceChange.LogicalResourceId === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found.ResourceChange as Obj;
};

export const CP = "agentx-staging-control-plane";
export const RT = "agentx-staging-runtime";
export const SL = "agentx-staging-slack";
export const GWS = "rovara-cloud-staging-gateway";
export const WEB = "rovara-cloud-staging-web";
